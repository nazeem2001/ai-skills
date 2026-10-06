---
name: zustand
description: >-
  Expert Zustand (v5) state management for React — writing stores, selectors,
  middleware (persist/devtools/immer), TypeScript typing, Next.js/SSR
  architecture, testing, and eliminating unnecessary re-renders. Use this skill
  whenever the user creates or edits a Zustand store, mentions zustand,
  create()/createStore/useStore/useShallow/persist, asks about React global/client
  state management or state libraries, hits "Maximum update depth exceeded" /
  "getSnapshot should be cached" errors, complains about React re-renders tied to
  a store, migrates from Redux/Context to Zustand or from Zustand v4 to v5, or
  wires state into Next.js App Router — even if they don't say "zustand"
  explicitly but the code imports it. Also covers state management in Tauri
  desktop/mobile apps (Rust tauri::State vs webview stores, invoke/events,
  multi-window sync, tauri-plugin-store persistence) — use it for any Tauri +
  React state question, and for "where should this state live" decisions in
  Tauri apps generally.
---

# Zustand (v5) — State Management Done Right

Distilled from the official docs (zustand.docs.pmnd.rs, v5.0.x), the maintainers
(dai-shi, dbritto-dev) in pmndrs/zustand discussions, TkDodo's essays, and
production post-mortems. Targets **zustand v5** (React 18+). If the project is on
v4, most guidance holds but read the v5 notes before suggesting an upgrade.

## Before writing any store: three questions

1. **Does this state belong in zustand at all?** Server data → TanStack Query.
   URL-shareable (filters/tabs/pagination) → search params. Form state →
   react-hook-form. Purely local → useState. Zustand is for the (usually small)
   residue of genuinely global client state. NEVER copy server/query data into a
   store via useEffect/onSuccess — two sources of truth that will diverge. Instead,
   keep client inputs (e.g. filters) in zustand and feed them into the query key.
   → `references/architecture.md`
2. **Does this code ever run on a server?** (Next.js, Remix, any SSR.) Then NO
   module-level `create()` stores — they're process singletons and leak state
   across users' requests. Use the vanilla-store factory + Context provider
   pattern, and React Server Components must never touch a store.
   → `references/ssr-nextjs.md`
   **Is this a Tauri (or similar Rust-shell) app?** State splits across two
   layers: Rust owns native/shared/secret state (`tauri::State`), zustand owns
   per-window UI state, and each window is an isolated JS context.
   → `references/tauri-desktop.md`
3. **One store or several?** Independent domains → separate small stores. State
   that must update atomically together → one store (slices pattern). Never a god
   store mixing auth + cart + notifications + fetch logic.

When FIXING existing code (perf bug, crash, refactor of a working module): apply
the minimal change that satisfies the rules below, and preserve the module's
exported API (names, signatures) unless the user asked for a redesign — reshaping
a store's public surface is a breaking change, not a performance fix.

## The golden rules (violating these is what makes zustand apps slow or crash)

1. **Never select the whole store.** `const { x } = useStore()` subscribes to every
   change (and bare destructuring breaks under React Compiler). Always pass a
   selector.
2. **Selector outputs must be stable references.** v5 compares output with
   `Object.is`; a selector returning a fresh object/array/closure each call doesn't
   just re-render — it throws `The result of getSnapshot should be cached to avoid
   an infinite loop` / `Maximum update depth exceeded`. This is the #1 zustand v5
   bug.
3. **Atomic selectors are the default idiom.** One field per hook call:
   `const bears = useStore((s) => s.bears)`. For genuine multi-field picks or
   derived collections, wrap in `useShallow` (import from `'zustand/react/shallow'`).
   Derived primitives (`s.items.length`) are always safe. useShallow is 1-level
   only — nested `.map()` results and selector-built functions still loop.
4. **Only export custom hooks, never the raw store hook.** `export const useBears =
   () => useBearStore((s) => s.bears)` — over-subscription becomes impossible.
   (Don't use the `createSelectors` auto-generator — it breaks under React Compiler.)
5. **Actions are stable — group and expose them as one piece.** An `actions`
   namespace object (or module-level functions calling `store.setState`) never
   changes identity, so `const { addBear } = useBearActions()` is fine. Model
   actions as events (`checkoutStarted`), not setters — business logic lives in the
   store.
6. **`set` merges one level deep.** Top level needs no spread; nested objects must
   be spread manually (or use the immer middleware). Mutation without new
   references (incl. `Map`/`Set` methods) never notifies subscribers —
   `new Map(old).set(...)`.
7. **TypeScript: `create<T>()(...)` — curried.** Exception: `combine`/`redux` infer
   state, don't curry them. → `references/typescript.md`
8. **Middleware order: `devtools(subscribeWithSelector(persist(immer(...))))`**,
   applied only on the combined store (never inside slices). Name devtools actions
   via `set(partial, undefined, 'domain/action')`. persist: `partialize` to plain
   data (never actions), add `version`+`migrate` before shipping shape changes.
   → `references/middleware.md`
9. **persist + SSR = hydration plan required**: `skipHydration: true` +
   `persist.rehydrate()` in an effect, and/or a `hasHydrated` gate. State that must
   be correct in first-paint HTML goes in a cookie, not localStorage.
10. **60fps data doesn't go through React.** Cursors/canvas/tickers: subscribe
    outside render into a ref (`useEffect(() => store.subscribe(...), [])`) or
    read `store.getState()` in the frame loop. Throttle high-frequency sources
    into batched commits. → `references/performance.md`

## Reference files — read before working in that area

| Task at hand | Read |
|---|---|
| API semantics: create/setState/replace/subscribe, Maps/Sets, resets, vanilla stores, import paths | `references/core-api.md` |
| Re-renders, selectors, useShallow limits, equality fns, derived state, transient updates, large lists, React Compiler, v5 traps | `references/performance.md` |
| Typing stores, middleware mutator tuples, typed slices, custom middleware, ExtractState | `references/typescript.md` |
| persist (all options/traps), devtools, immer, subscribeWithSelector, combine/redux, composition order | `references/middleware.md` |
| Next.js App Router, SSR, per-request stores, Context providers, hydration fixes, server-props init | `references/ssr-nextjs.md` |
| Vitest/Jest setup, auto-reset mock, per-test store injection, React-free store tests | `references/testing.md` |
| What belongs in zustand, store shape, slices vs multi-store, TanStack Query boundary, vs Redux/Jotai/Context | `references/architecture.md` |
| Tauri apps: Rust tauri::State vs webview stores, invoke/events/channels, multi-window sync, plugin-store persistence, Rust-frontend alternatives | `references/tauri-desktop.md` |

Minimum reads by task: **new store** → architecture + core-api (+ typescript if TS,
+ ssr-nextjs if any SSR framework). **Perf/re-render complaint or update-depth
crash** → performance. **persist anything** → middleware (+ ssr-nextjs if SSR).
**Writing tests** → testing. **v4→v5 migration** → performance §9 + core-api.
**Anything in a Tauri app** → tauri-desktop first (it changes the ownership answer).

## Canonical store template (SPA, TypeScript)

```ts
import { create } from 'zustand'
import { devtools, persist } from 'zustand/middleware'

interface CartItem { id: string; name: string; price: number; qty: number }

interface CartState {
  itemsById: Record<string, CartItem>
  itemIds: string[]
  actions: {
    addItem: (item: Omit<CartItem, 'qty'>) => void
    removeItem: (id: string) => void
    setQty: (id: string, qty: number) => void
    clearCart: () => void
  }
}

const useCartStore = create<CartState>()(
  devtools(
    persist(
      (set, get, store) => ({
        itemsById: {},
        itemIds: [],
        actions: {
          addItem: (item) =>
            set((s) => {
              const existing = s.itemsById[item.id]
              return {
                itemsById: {
                  ...s.itemsById,
                  [item.id]: existing
                    ? { ...existing, qty: existing.qty + 1 }
                    : { ...item, qty: 1 },
                },
                itemIds: existing ? s.itemIds : [...s.itemIds, item.id],
              }
            }, undefined, 'cart/addItem'),
          removeItem: (id) =>
            set((s) => {
              const { [id]: _, ...rest } = s.itemsById
              return { itemsById: rest, itemIds: s.itemIds.filter((i) => i !== id) }
            }, undefined, 'cart/removeItem'),
          setQty: (id, qty) =>
            set((s) => ({
              itemsById: { ...s.itemsById, [id]: { ...s.itemsById[id], qty } },
            }), undefined, 'cart/setQty'),
          clearCart: () =>
            set({ itemsById: {}, itemIds: [] }, undefined, 'cart/clearCart'),
        },
      }),
      {
        name: 'cart-storage',
        partialize: (s) => ({ itemsById: s.itemsById, itemIds: s.itemIds }), // never actions
        version: 1,
      },
    ),
    { name: 'CartStore' },
  ),
)

// Public API — custom hooks only; raw hook stays private
export const useCartItemIds = () => useCartStore((s) => s.itemIds)
export const useCartItem = (id: string) => useCartStore((s) => s.itemsById[id])
export const useCartCount = () => useCartStore((s) => s.itemIds.length) // derived primitive: safe
export const useCartTotal = () =>
  useCartStore((s) => s.itemIds.reduce((sum, id) => sum + s.itemsById[id].price * s.itemsById[id].qty, 0))
export const useCartActions = () => useCartStore((s) => s.actions)
```

For Next.js/SSR the same store becomes a `createStore` factory inside a Context
provider — full template in `references/ssr-nextjs.md`.

## Instant bug-pattern recognition

| Symptom | Cause | Fix |
|---|---|---|
| `getSnapshot should be cached` / `Maximum update depth exceeded` | Selector returns fresh object/array/function | Atomic selectors, or `useShallow`; hoist fallbacks (`?? FALLBACK`) |
| Everything re-renders on any store change | Selector-less hook calls / whole-store destructuring | Selectors + custom-hook exports |
| Re-renders 60×/sec | Frame-rate data bound through hooks | Transient updates: `subscribe` + ref, `getState()` in loop |
| Component doesn't update after "changing" state | In-place mutation (incl. Map/Set), or immer with non-immerable class | New references / `new Map(old)` / `[immerable] = true` |
| Hydration mismatch in Next.js | persist reads localStorage on client, server rendered defaults | `skipHydration` + rehydrate in effect + `hasHydrated` gate; cookies for first-paint state |
| Other users' state appears (SSR) | Module-level store on the server | Per-request factory + Context; RSCs never touch stores |
| Nested state resets after reload with persist | `partialize` nested + default shallow `merge` | Provide a deep `merge` |
| Actions undefined after rehydrate | Persisted functions / stale snapshot clobbers actions | `partialize` to data only |
| Devtools shows "anonymous" everywhere | Unnamed `set` calls | `set(partial, undefined, 'domain/action')` |
| `use-sync-external-store` build error | `zustand/traditional` needs it explicitly in v5 | `npm i use-sync-external-store` |
| Whole list re-renders on one item edit | Rows subscribe to the array | Container selects IDs (`useShallow`), rows select own item, `memo` rows |
| (Tauri) second window doesn't see store changes | Each window is an isolated JS context | Rust source-of-truth + events, or `@tauri-store/zustand` — tauri-desktop.md |
| (Tauri) settings vanish after update/dev-port change | localStorage is origin-bound in Tauri | persist → tauri-plugin-store adapter — tauri-desktop.md |
