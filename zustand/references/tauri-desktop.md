# Zustand in Tauri (v2) Desktop/Mobile Apps — and What Lives in Rust Instead

Verified 2026-07 against v2.tauri.app docs, docs.rs, plugin sources, and production
apps (Readest, Jan, opcode, Hopp). Applies to Tauri 2.x + @tauri-apps/api v2.

## The two-layer model — decide ownership before writing any store

A Tauri app is one **Rust core process** (windows, tray, FS, network, managed state —
alive for the whole app) plus **one webview per window**, each with its **own isolated
JS context**. A zustand store is per-window: two windows running the same bundle get
two independent stores. All sharing crosses IPC.

| State | Owner | Mechanism |
|---|---|---|
| Ephemeral UI (modals, tabs, drafts, hover) | webview | plain zustand |
| Data computed by Rust, displayed by UI (file lists, device info) | Rust computes, JS caches | `invoke` + zustand or TanStack Query |
| Long-lived business/native state (DB, watchers, jobs, secrets) | Rust | `manage` + `Mutex<T>`/actor, pushed via events |
| Cross-window shared state | Rust as source of truth (or synced stores) | events / `@tauri-store/zustand` |
| Persistent settings | disk via Rust | `tauri-plugin-store` (SQLite for real data) |

Rules of thumb: anything that must survive a window closing, be seen by two windows,
touch the OS, or stay secret belongs in **Rust**; anything that only styles the current
render belongs in **zustand**. Keep ONE direction of authority per datum — mirroring
the same truth in both layers is the classic Tauri state bug. (Where *business logic*
lives is genuinely contested: FS/DB/process-heavy apps go Rust-first with the frontend
as a renderer; UI-heavy apps stay ~90% TypeScript and drop to Rust only for OS access.
Both work — pick by the app's center of gravity, then stay consistent.)

## The consensus frontend stack: TanStack Query over `invoke`, zustand for UI only

Treat the IPC bridge like a network: **Rust commands are your API endpoints, and
TanStack Query wraps them** — caching, loading, error, retry, and invalidation for
free. Zustand holds only global UI state; never mirror query data into it, and don't
hand-roll loading flags in a store.

```ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'

const { data } = useQuery({
  queryKey: ['file', path],
  queryFn: () => invoke<string>('read_file', { path }),
  // local-only data (settings, device info) can't go stale behind your back:
  // staleTime: Infinity — and mutations invalidate explicitly
})

const { mutate: saveFile } = useMutation({
  mutationFn: (content: string) => invoke('write_file', { path, content }),
  onSuccess: () => queryClient.invalidateQueries({ queryKey: ['file', path] }),
})
```
Bonus: mock `invoke` in tests and the whole frontend is testable without a Rust build.
Nuance: for pure local *settings* reads (no I/O failure modes), a persisted zustand
store (Recipe 2) is equally legitimate — Query's machinery buys little there.

## Rust side in 30 seconds (what your commands look like)

```rust
use std::sync::Mutex;
use tauri::{Builder, Manager, State, Emitter};

#[derive(Default, Clone, serde::Serialize)]
struct SettingsInner { theme: String }
type Settings = Mutex<SettingsInner>;  // type alias — State<'_, SettingsInner> vs
                                       // State<'_, Mutex<..>> mismatch is a RUNTIME panic

#[tauri::command]
fn set_theme(app: tauri::AppHandle, state: State<'_, Settings>, theme: String)
    -> Result<(), String> {
  let snapshot = {
    let mut s = state.lock().unwrap();
    s.theme = theme;
    s.clone()
  }; // guard dropped BEFORE any await/emit
  app.emit("settings-changed", &snapshot).map_err(|e| e.to_string())
}

Builder::default()
  .setup(|app| { app.manage(Settings::default()); Ok(()) })
  .invoke_handler(tauri::generate_handler![set_theme])
```

- `manage()` is keyed by type and already shares — don't wrap in your own `Arc`.
- **`std::sync::Mutex` is the official default, even in async commands** (Tokio's own
  guidance). `tokio::sync::Mutex` only when a guard must live across `.await` (e.g. a
  DB connection). Never hold a std guard across `.await` — scope it and clone out.
- Async commands that take `State<'_, T>` **must return `Result`** (documented macro
  limitation).
- Outside commands (setup, tray, events, spawned tasks): clone the `AppHandle` into
  the closure and call `handle.state::<T>()` at point of use.
- Scaling up: state with heavy invariants or owned IO → **actor pattern** (a tokio
  task owns the state, `app.manage(HandleWithSender)`, commands send messages — no
  locks, ordered mutations). Data you'd be sad to lose → SQLite (`tauri-plugin-sql`
  when the frontend owns queries; managed `sqlx` pool when Rust does). Persist on
  exit via `.build(ctx)?.run(|app, event| ...)` handling `RunEvent::ExitRequested`.

## IPC surface (exact v2 import paths)

```ts
import { invoke, Channel } from '@tauri-apps/api/core'      // NOT /tauri (that's v1)
import { listen, emit, emitTo } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
```

| Mechanism | Use for | Notes |
|---|---|---|
| `invoke('cmd', args)` | request/response, typed returns | Rust snake_case args become camelCase in JS; `Result::Err` rejects the promise |
| events (`emit`/`listen`) | low-frequency broadcast, cross-window pings | JSON-only, unordered, no capability checks — never emit secrets; ALWAYS keep the `unlisten` fn and call it in effect cleanup |
| `Channel` | high-frequency ordered streams (progress, process output) | Rust: `tauri::ipc::Channel<T>` param; JS: `new Channel()`, `onmessage` |

Payload traps (benchmarked, production-verified):
- The command channel is **JSON-shaped**. Returning `Vec<u8>` from a command arrives
  in JS as a JSON *number array* (6.3MB raw → 22.5MB on the wire); base64-decoding
  images in JS blocked a main thread 891ms per 2s. Raw bytes → `tauri::ipc::Response`,
  streams → `Channel`, media at scale → a custom URI-scheme protocol (~0ms block).
- Don't ship datasets over IPC at all: 120k file records (~70MB JSON) froze a window
  for 47s. Keep the data in Rust behind a handle/`scan_id`, send a ~2KB summary +
  small progress events, page details in on demand.
- Events are slow for big payloads (~200ms for 3MB). Emit-then-fetch is the cheap
  fix: the event says "changed", the frontend `invoke`s for the data.

The React `listen` cleanup recipe (leaked listeners accumulate on every remount/HMR):

```ts
useEffect(() => {
  const p = listen('sync-progress', handler)
  return () => { p.then((unlisten) => unlisten()) }  // await the promise in cleanup
}, [])
```

Small gotchas with multiple attestations: only ONE `invoke_handler(generate_handler![...])`
call — a second silently overwrites the first; `app.emit` needs `use tauri::Emitter;`
in scope (v2); guard any `invoke('setup')` that spawns threads — it re-runs on every
webview reload.

## Recipe 1 — UI-only zustand store

For per-window ephemeral UI state, use zustand exactly as on the web (all the other
references apply unchanged). No bridge needed.

## Recipe 2 — zustand persist → tauri-plugin-store (settings that survive reloads)

Don't trust webview localStorage in Tauri (see caveats below). Back `persist` with the
official store plugin. Setup: `npm run tauri add store`, add `"store:default"` to
capabilities.

```ts
import { create } from 'zustand'
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware'
import { LazyStore } from '@tauri-apps/plugin-store'

const tauriStore = new LazyStore('settings.json') // sync-constructible, loads on first use

// Define the storage BEFORE create() — after it, persist init fails with
// "the given storage is currently unavailable".
const tauriStorage: StateStorage = {
  getItem: async (name) => (await tauriStore.get<string>(name)) ?? null,
  setItem: async (name, value) => { await tauriStore.set(name, value) }, // autoSave debounces 100ms
  removeItem: async (name) => { await tauriStore.delete(name) },
}

export const useSettings = create<Settings>()(
  persist((set) => ({ theme: 'dark', setTheme: (theme) => set({ theme }) }), {
    name: 'settings',
    storage: createJSONStorage(() => tauriStorage),
  }),
)
```
This storage is **async** → first render shows defaults until rehydration; gate with
`useSettings.persist.hasHydrated()` / `onFinishHydration` if flicker matters
(middleware.md). Two more gotchas: the plugin only guarantees a flush on *graceful*
exit — with `autoSave: false`, call `store.save()` after writes or a crash loses them;
and `store.get<T>()` generics are unchecked casts — validate with Zod if the data
matters. Bonus: plugin-store `set` broadcasts `store://change` to ALL windows
(verified in plugin source) — `store.onKeyChange('theme', cb)` in another window fires,
which makes it a zero-Rust cross-window settings sync.

## Recipe 3 — Rust as source of truth, zustand as cache (the recommended default)

Maintainer-recommended shape for shared/native state: commands mutate Rust state,
events fan out, every window's zustand mirror ingests.

```ts
type SyncState = { isRunning: boolean }
export const useSyncStore = create<SyncState>(() => ({ isRunning: false })) // no actions!

// call once per window at startup; keep the unlisten for teardown
export async function attachBackendBridge() {
  useSyncStore.setState(await invoke<SyncState>('get_sync_state')) // hydrate: events only cover the future
  return listen<SyncState>('sync-state', (e) => useSyncStore.setState(e.payload))
}

// "actions" are invokes — never setState directly for Rust-owned fields;
// the emitted event round-trips the change to every window including this one
export const startSync = () => invoke('start_sync')
```
Writes serialize through the Rust mutex (no races), all windows converge, and business
data stays out of the webview attack surface. For high-frequency streams swap the event
for a `Channel` whose `onmessage` calls `setState`. If UI edits also emit back to Rust
(two-way), guard against echo loops: an `isProcessing` flag + deep-equal check before
re-emitting. Push-vs-pull is a real choice: continuous event-pushed mirrors suit
dashboards; for state the UI only needs at known moments (auth on navigation), skip the
bridge and just `invoke` at those moments — cheaper and simpler.

## Recipe 4 — `@tauri-store/zustand` (persistence + multi-window sync in one dep)

Community plugin (ferreira-tb/tauri-store; npm `@tauri-store/zustand` + crate
`tauri-plugin-zustand`): saves stores to disk, syncs them across windows, exposes them
to Rust (`app.zustand().get::<T>("store", "key")`, `.watch(...)`). Every change is
serialized to Rust — set `syncStrategy: 'debounce'` for chatty stores; nothing persists
until `await handler.start()`. Verdict: well-built and active but single-maintainer,
low adoption, explicitly unofficial — fine for settings-grade state; prefer Recipe 3
when correctness matters, Recipe 2 for persistence alone.

## Multi-window: pick a pattern deliberately

1. **Single window** → plain zustand + Rust state for native things. Done.
2. **Settings-grade shared state, zero custom Rust** → plugin-store + `onKeyChange`
   mirrors (Recipe 2's bonus).
3. **zustand ergonomics + persistence + sync** → `@tauri-store/zustand` (Recipe 4).
4. **Correctness-critical shared state** (auth, documents, billing) → Rust owns it
   (Recipe 3); events carry snapshots or just invalidation + re-fetch.
5. **Transient UI mood where a dropped update is OK** (theme, presence) → peer event
   bus between stores with the echo-loop guard + a `get-store-request/response`
   hydration handshake for late windows (the Hopp pattern).

Facts that shape all of these: a closed window loses ALL its JS state — every window
must hydrate on startup, never assume it was "already synced". `emitTo` still reaches
global `listen()` in every window — scope with `getCurrentWebviewWindow().listen()`.
New window labels must be listed in `capabilities/*.json` or events/invoke silently
fail. Hot per-frame state (drags, keystrokes) never crosses IPC per tick — sync
committed results only. Window geometry → `tauri-plugin-window-state`, not your store.

## Persistence caveats (why "just use persist" breaks in Tauri)

- Webview localStorage works but is **origin-bound**, and Tauri's origins churn:
  dev (`http://localhost:<port>`) vs prod (`tauri://localhost` on Linux/macOS,
  `http://tauri.localhost` on Windows) are different origins with separate storage;
  changing the dev port or flipping `useHttpsScheme` orphans data. Linux WebKitGTK has
  an open multi-window localStorage-loss bug (tauri#10981).
- Rule: localStorage/default-persist only for losable UI preferences. Real settings →
  `tauri-plugin-store` (origin-independent JSON file in the app data dir, JS+Rust
  access). Real data → SQLite.

## Not using React? (the "if not zustand" answer)

- **Svelte** → runes/stores (+ `@tauri-store/svelte` for persistence/sync);
  **Vue** → Pinia (+ `@tauri-store/pinia`); **Solid** → signals/`createStore`.
- **Rust wasm frontends** (Trunk-based; Tauri officially documents Leptos, SSG-only):
  no zustand needed — **Leptos**: signals + `provide_context`, `reactive_stores`'
  `#[derive(Store)]` gives field-level lenses (statically-typed "selectors");
  **Dioxus**: `use_signal` + `GlobalSignal` statics (the closest Rust analog to a
  zustand store); **Yew**: `use_reducer`/context, or **yewdux** for a real global
  store with `use_selector` and free localStorage persistence.
- **Slint/egui** render natively — their state model is global singletons / plain
  `&mut self`; pairing them with Tauri mostly doesn't make sense (Tauri's value is
  the webview shell).
- Rust-centric architecture generalizes Recipe 3 beyond zustand: Rust is the single
  source of truth; any frontend is a thin view hydrated by one query + kept fresh by
  events/channels.

## Decision matrix

| Signal | Rust (`manage`/actor/DB) | Webview (zustand) |
|---|---|---|
| Multiple windows need one truth | ✅ | ❌ per-webview stores drift |
| Filesystem/DB/native resource backing | ✅ | ❌ |
| Must survive webview reload/close | ✅ | ❌ wiped with the JS context |
| Secrets (tokens, license) | ✅ (and never `emit` them — events skip capability checks) | ❌ XSS-readable |
| Background jobs/watchers | ✅ tokio task → event/channel | ❌ dies with the page |
| Ephemeral UI, form drafts, optimistic UI | ❌ IPC round-trips are silly | ✅ |
| Animation/render-rate state | ❌ IPC latency kills it | ✅ (transient updates, performance.md) |

Default recipe for React+Tauri: **per-window zustand for UI state; Rust-owned state
with a thin zustand mirror (Recipe 3) for everything shared/native; TanStack Query
over `invoke` for request/response server-ish data; plugin-store for settings.**
