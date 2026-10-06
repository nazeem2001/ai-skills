# Zustand Middleware (v5.x) — persist, devtools, immer, and composition

## Canonical composition order

```ts
const useBoundStore = create<State>()(
  devtools(
    subscribeWithSelector(
      persist(
        immer((set) => ({ /* ... */ })),
        { name: 'my-store' },
      ),
    ),
    { name: 'MyStore' },
  ),
)
```
Outermost → innermost: **devtools → subscribeWithSelector → persist → immer**
(drop layers you don't need, keep the relative order).
- `devtools` OUTERMOST (official rule): it mutates `setState`'s type to add the
  action-name param; wrapping it with another set-mutating middleware (immer) loses
  that. It also then observes every write, including persist rehydration.
- `immer` INNERMOST: it changes `set`'s contract (mutate a draft); everything above
  should see normal immutable updates.
- Runtime truth (dai-shi): "there's nothing for middleware... it's only about types
  and docs" — other orders may run, but this is the one the types and docs support.
- Apply middleware **only on the combined store**, never inside individual slices
  ("Applying them inside individual slices can lead to unexpected issues").

## persist

```ts
import { persist, createJSONStorage } from 'zustand/middleware'

export const useBearStore = create<BearStore>()(
  persist(
    (set, get) => ({ bears: 0, addABear: () => set({ bears: get().bears + 1 }) }),
    {
      name: 'bear-storage',                             // REQUIRED unique key
      storage: createJSONStorage(() => sessionStorage), // default: localStorage
      partialize: (state) => ({ bears: state.bears }),  // persist ONLY data, never actions
      version: 1,
      migrate: (persisted, version) => {
        if (version === 0) { /* reshape old persisted state */ }
        return persisted
      },
    },
  ),
)
```

All options: `name` (required key) · `storage` (via `createJSONStorage(() => engine)`,
lazily evaluated so SSR module eval doesn't crash) · `partialize` (pick persisted
fields) · `version` + `migrate` (stored version mismatch without successful migrate =
stored value IGNORED) · `merge` (default is SHALLOW `{...current, ...persisted}`) ·
`onRehydrateStorage` (lifecycle listener) · `skipHydration` (no auto-hydrate; call
`store.persist.rehydrate()` yourself — the SSR tool).

Traps, each with the fix:
- **Nested partial persistence + default shallow merge erases nested defaults.**
  Storage has `{foo: {bar: 5}}`, code default is `{foo: {bar: 0, baz: 1}}` →
  after rehydrate `foo.baz` is gone. Supply a deep `merge`.
- **Persisting functions/actions.** JSON drops or corrupts them; stale persisted
  snapshots overwriting action fields has bitten production apps. Always
  `partialize` to plain data.
- **No `version`/`migrate` when the shape changes** → old localStorage crashes new
  code in production.
- **`createJSONStorage` does NO validation** — the parsed value is cast straight to
  your state type. For production robustness implement `PersistStorage` with schema
  validation (e.g. Zod).
- **v5 change:** persist no longer writes initial state to storage at creation.
- **Async storages** (AsyncStorage, IndexedDB) hydrate in a microtask AFTER first
  render — gate auth-like UI on hydration (see below).
- Two persisted stores must not share a `name`.

Persist runtime API:

```ts
useBearStore.persist.hasHydrated()      // non-reactive boolean
await useBearStore.persist.rehydrate()  // manual (re)hydration
useBearStore.persist.clearStorage()     // remove stored entry
useBearStore.persist.setOptions({ name: 'new-key' })
const unsub = useBearStore.persist.onFinishHydration((state) => { ... })
```

Hydration gate (the official `useHydration` hook):

```ts
const useHydration = () => {
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => {
    const unsubHydrate = useBoundStore.persist.onHydrate(() => setHydrated(false))
    const unsubFinish = useBoundStore.persist.onFinishHydration(() => setHydrated(true))
    setHydrated(useBoundStore.persist.hasHydrated())
    return () => { unsubHydrate(); unsubFinish() }
  }, [])
  return hydrated
}
```

Custom engines: any `{ getItem, setItem, removeItem }` works (sync or async) —
IndexedDB via idb-keyval, URL hash/query storage for shareable state. For
Map/Set/Date, either `createJSONStorage` reviver/replacer options or a
`PersistStorage` with superjson. Cross-tab sync: listen to the `storage` DOM event
and call `persist.rehydrate()` when your key changes.

## devtools

Requires `@redux-devtools/extension` installed (and for option types:
`import type {} from '@redux-devtools/extension'`).

```ts
devtools(creator, {
  name: 'MyApp',        // DevTools connection name
  store: 'cartStore',   // group several stores under one connection
  enabled: process.env.NODE_ENV === 'development', // default: dev-only
  anonymousActionType: 'cart', // label for unnamed sets
})
```

**Name your actions** — third argument to `set`, with the 2nd left `undefined`:

```ts
addBear: () => set((s) => ({ bears: s.bears + 1 }), undefined, 'jungle/addBear'),
// payload form: set(next, undefined, { type: 'bear/addFishes', count })
```
Without names every mutation logs as "anonymous", which makes the timeline useless
in a real app. `actionsDenylist: ['internal/.*']` hides noisy actions.
Dynamic/context stores: call `useStore.devtools.cleanup()` when disposing.
Wart: a state key literally named `actions` holding functions has a field report of
being stripped under devtools (#3398) — rename if you hit undefined actions.

## immer

Requires `immer` installed. Import from `zustand/middleware/immer`.

```ts
export const useTodoStore = create<State & Actions>()(
  immer((set) => ({
    todos: {},
    toggleTodo: (id: string) =>
      set((state) => { state.todos[id].done = !state.todos[id].done }),
  })),
)
```
- Use when state is genuinely nested; flat stores don't need it.
- Gotcha: class instances need `[immerable] = true`, else Immer mutates in place,
  next === prev, and subscribers are silently NOT notified.
- Batch related changes into ONE `set` recipe — every `set` is one notification round.
- One-off alternative without the middleware: `set(produce((state) => {...}))`.

## subscribeWithSelector

Adds the granular subscribe overload (external/non-render subscriptions):

```ts
const unsub = useDogStore.subscribe(
  (state) => state.paw,
  (paw, prevPaw) => { ... },
  { equalityFn: shallow, fireImmediately: true },
)
```
Use for side effects (auto-save, analytics, websocket sync) and transient updates.

## combine / redux

- `combine(initialState, (set, get) => actions)` — merges both; **types are inferred,
  do NOT curry** `create<T>()()` with it. Its typing "lies" benignly: `set(x, true)`
  compiles but would delete actions; `Object.keys(get())` has extra keys.
- `redux(reducer, initialState)` — adds `dispatch` to state and store; useful for
  Redux migrations; also inference-friendly (no curry).

## Custom middleware

Runtime shape: `(f, opts) => (set, get, store) => f(wrappedSet, get, store)` — wrap
`set`, patch `store.setState` (patch BOTH — the bare API bypasses wrapped `set`),
add store fields. Typed skeletons (logger / store-mutating with `StoreMutators`
augmentation): see typescript.md.
