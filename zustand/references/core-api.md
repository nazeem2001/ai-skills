# Zustand Core API (v5.x)

Verbatim-official semantics from zustand.docs.pmnd.rs and the pmndrs/zustand README.

## Import paths cheat sheet (v5 — no default exports anywhere)

| Export | Import path |
|---|---|
| `create`, `useStore`, `createStore` (re-export), `StateCreator`, `StoreApi`, `UseBoundStore`, `Mutate`, `StoreMutatorIdentifier`, `ExtractState` | `zustand` |
| `createStore` (vanilla) | `zustand/vanilla` |
| `shallow` (compare fn) | `zustand/shallow` |
| `useShallow` (hook) | `zustand/react/shallow` (canonical; also re-exported from `zustand/shallow`) |
| `createWithEqualityFn`, `useStoreWithEqualityFn` | `zustand/traditional` (requires installing `use-sync-external-store`) |
| `persist`, `createJSONStorage`, `devtools`, `combine`, `redux`, `subscribeWithSelector`, `StateStorage`, `PersistStorage` | `zustand/middleware` |
| `immer` middleware | `zustand/middleware/immer` (requires installing `immer`) |

## create / createStore / useStore

```ts
import { create } from 'zustand'

const useBear = create((set, get, store) => ({
  bears: 0,
  increasePopulation: () => set((state) => ({ bears: state.bears + 1 })),
  removeAllBears: () => set({ bears: 0 }),
}))
```
- `create` returns a **hook** with the store API attached: `useBear.getState()`,
  `.setState()`, `.getInitialState()`, `.subscribe()`.
- No provider needed. Components re-render only when their selected slice changes:
  `const bears = useBear((s) => s.bears)`.
- `createStore` (from `zustand/vanilla`) is the same minus the hook — returns
  `StoreApi<T>`. Bridge to React with `useStore(store, selector)`. Use for store
  factories (SSR/per-request), DI via Context, and non-React code.
- Never call `get()` synchronously while building the initial state — it returns
  `undefined` at that moment (compiles in TS, throws at runtime).

## setState semantics — the part everyone gets wrong

**`set` shallow-merges at the FIRST level only.** You can skip `...state` at the top
level, but nested objects must be spread manually:

```ts
set((state) => ({ count: state.count + 1 }))         // top level: merge is automatic
set((state) => ({ nested: { ...state.nested, count: state.nested.count + 1 } })) // nested: manual
```

**Replace flag** — second arg `true` REPLACES the whole state (actions included —
"be careful not to wipe out parts you rely on"):

```ts
set(newCompleteState, true)
```
v5 typing is strict: with `replace: true` you must pass a complete `T`;
`setState({}, true)` is a type error. Dynamic flag workaround:
`useStore.setState(...([partial, flag] as Parameters<typeof useStore.setState>))`.

**Immutability**: zustand detects changes by reference. Mutating existing objects
(`state.user.name = x`, `state.map.set(k, v)`, `array.push`) does NOT notify
subscribers. Always produce new references (`{...}`, `[...]`, `new Map(old).set(...)`,
`toSpliced/toSorted/toReversed`) or use the immer middleware.

**Maps and Sets**: always clone before mutating —
`set((s) => ({ foo: new Map(s.foo).set(k, v) }))`. TS pitfall: type-hint empty
collections (`new Set([] as string[])`) or TS infers `never`.

**Updater functions**: `set((state) => next)` for updates based on previous state.

**Under devtools**, `set` gains a third arg (action name):
`set(partial, undefined, 'domain/actionName')` — keep the 2nd arg `undefined`
unless you deliberately mean replace.

## Store API utilities

```ts
useBear.getState()        // fresh non-reactive read (also inside actions via `get`)
useBear.setState({...})   // update from anywhere (module code, websockets, tests)
useBear.getInitialState() // snapshot of created state — basis for reset patterns
const unsub = useBear.subscribe((state, prevState) => {...}) // sync, every change
```
- Caveat (README): middleware that modifies `set`/`get` is NOT applied to the
  bare `getState`/`setState` API calls.
- Do not read/write module-level stores in React Server Components — state leaks
  across requests (see ssr-nextjs.md).

## Selectors and equality (summary — full treatment in performance.md)

- Default comparison of selector output: `Object.is`. Atomic selectors
  (`(s) => s.field`) are the default idiom.
- `useShallow(selector)` memoizes output by shallow (1-level) comparison — for
  multi-field picks and derived collections.
- `shallow(a, b)`: compares top-level entries with `Object.is`; compares Set/Map by
  top-level contents; requires same prototype. Nested objects compare by reference.
- Custom equality: `createWithEqualityFn`/`useStoreWithEqualityFn` from
  `zustand/traditional` (per-call equality fn like v4).
- Derived state belongs in selectors, not stored:
  `const total = useBear((s) => s.bears * s.foodPerBear)`.

## Async actions

Just call `set` when ready — zustand doesn't care about async:

```ts
fetchBears: async () => {
  const res = await fetch('/api/bears')
  set({ bears: (await res.json()).count })
},
```

## Resetting state

```ts
// per-store reset using the third `store` arg
const useSomeStore = create<State & Actions>()((set, get, store) => ({
  ...initialState,
  reset: () => set(store.getInitialState()),   // add `true` to drop non-initial keys
}))
```
Reset-all-stores: wrap `create` to register
`store.setState(store.getInitialState(), true)` callbacks in a Set, call them all
(this is exactly what the official test mock does — see testing.md).

## Vanilla / outside-React usage

```ts
import { createStore } from 'zustand/vanilla'
const store = createStore((set) => ({ ... }))
const { getState, setState, subscribe, getInitialState } = store
```
Transient (no-render) subscription in a component — see performance.md §5.

## Reading state in event handlers / callbacks without subscribing

`useStore.getState()` in a callback reads fresh state with zero subscription — the
component never re-renders for it. Ideal for "read on click" values.
