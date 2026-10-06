# Zustand + TypeScript (v5.x)

## Rule 1: `create<T>()(...)` — curried, with the extra `()`

```ts
interface BearState {
  bears: number
  increase: (by: number) => void
}

const useBearStore = create<BearState>()((set) => ({
  bears: 0,
  increase: (by) => set((state) => ({ bears: state.bears + by })),
}))
```

Why annotate at all: the state generic `T` is **invariant** (returned by the creator
AND consumed by `get: () => T`), and TS can't infer invariant generics — plain
`create((set) => ...)` infers `unknown`. Why the currying: TS generic inference is
all-or-nothing (microsoft/TypeScript#10571) — the extra `()` lets you pin `T` while
the middleware-mutator generics stay inferred. Same rule for `createStore<T>()()`
and `createWithEqualityFn<T>()()`.

## Rule 2: `combine` (and `redux`) — do NOT curry

Middleware that *creates* the state makes inference possible:

```ts
const useBearStore = create(          // no <T>() — inference works
  combine({ bears: 0 }, (set) => ({
    increase: (by: number) => set((state) => ({ bears: state.bears + by })),
  })),
)
```
`combine`'s "benign lie": inside the creator, `set`/`get` are typed as if the state
were only the first argument. Watch out: `set(x, true)` (replace) compiles but would
delete your actions; `Object.keys(get())` has more keys than the type says. The
bound store's public type is correct. It trades a little soundness for not writing
a state interface — fine for most stores.

## ExtractState — recover a store's state type

```ts
import { create, type ExtractState } from 'zustand'
type BearState = ExtractState<typeof useBearStore>  // works for hooks & vanilla stores
```

## Middleware typing — two rules + mutator reference

1. Apply middleware **immediately inside `create`** (contextual inference does the
   rest — no explicit mutators needed):
   ```ts
   const useBearStore = create<BearState>()(
     devtools(persist((set) => ({ ... }), { name: 'bearStore' })),
   )
   ```
2. Keep `devtools` **outermost** — it mutates `setState`'s type (adds the action-name
   param), which gets lost if another set-mutating middleware (immer) wraps it.

Mutator tuples (needed only for typed slices under middleware, reusable wrappers,
or standalone `StateCreator`-typed creators):

| middleware | mutator tuple |
|---|---|
| `devtools` | `['zustand/devtools', never]` |
| `persist` | `['zustand/persist', YourPersistedState]` (= return type of `partialize`; no partialize → `Partial<State>`; if it won't unify, use `unknown` — issue #980) |
| `immer` | `['zustand/immer', never]` |
| `subscribeWithSelector` | `['zustand/subscribeWithSelector', never]` |
| `redux` | `['zustand/redux', YourAction]` |
| `combine` | no mutator |

`StateCreator<T, Mis, Mos, U = T>`: `T` full state; `Mis` = mutators applied by
middleware *wrapping* this creator, **outermost first** (shapes the `set` you
receive); `Mos` = mutators this creator applies; `U` = what it returns (slices).

## Typed slices pattern

```ts
import { create, type StateCreator } from 'zustand'

interface BearSlice { bears: number; addBear: () => void; eatFish: () => void }
interface FishSlice { fishes: number; addFish: () => void }
interface SharedSlice { addBoth: () => void; getBoth: () => number }

// First generic = FULL state (enables typed cross-slice set/get); 4th = this slice
const createBearSlice: StateCreator<BearSlice & FishSlice, [], [], BearSlice> = (set) => ({
  bears: 0,
  addBear: () => set((state) => ({ bears: state.bears + 1 })),
  eatFish: () => set((state) => ({ fishes: state.fishes - 1 })), // cross-slice write
})

const createFishSlice: StateCreator<BearSlice & FishSlice, [], [], FishSlice> = (set) => ({
  fishes: 0,
  addFish: () => set((state) => ({ fishes: state.fishes + 1 })),
})

const createSharedSlice: StateCreator<BearSlice & FishSlice, [], [], SharedSlice> = (set, get) => ({
  addBoth: () => { get().addBear(); get().addFish() },  // reuse other slices' actions
  getBoth: () => get().bears + get().fishes,
})

const useBoundStore = create<BearSlice & FishSlice & SharedSlice>()((...a) => ({
  ...createBearSlice(...a),
  ...createFishSlice(...a),
  ...createSharedSlice(...a),
}))
```

Under middleware, put the wrapping middleware's mutators (outermost first) in slot 2:

```ts
const createBearSlice: StateCreator<
  JungleStore,
  [['zustand/devtools', never], ['zustand/persist', JungleStore]],
  [],
  BearSlice
> = (set) => ({
  bears: 0,
  addBear: () => set((s) => ({ bears: s.bears + 1 }), undefined, 'jungle:bear/addBear'),
})
```

## Vanilla stores + bounded useStore hooks

```ts
const bearStore = createStore<BearState>()((set) => ({ ... }))

function useBearStore(): BearState
function useBearStore<T>(selector: (state: BearState) => T): T
function useBearStore<T>(selector?: (state: BearState) => T) {
  return useStore(bearStore, selector!)
}
```
DRY factory: `createBoundedUseStore` — cast `(store) => (selector) => useStore(store, selector)`
to `{ (): ExtractState<S>; <T>(selector: (s: ExtractState<S>) => T): T }`.

## Custom middleware (typed) — two skeletons

Non-store-mutating (logger): public type generic over `Mps`/`Mcs` mutator lists +
simple impl type + one `as unknown as Logger` cast at the export boundary.

Store-mutating (adds `store.foo`): additionally `declare module 'zustand' {
interface StoreMutators<S, A> { foo: Write<Cast<S, object>, { foo: A }> } }`, apply
with `Mutate<StoreApi<T>, [['foo', A]]>`, and prepend your mutator to `Mos`. Full
code in the official Advanced TypeScript guide ("Middlewares and their mutators"
and issue #710 for background). Runtime shape of ALL middleware is just:

```ts
const myMiddleware = (f, opts) => (set, get, store) => f(wrappedSet, get, store)
```

## Misc

- Async actions type naturally — type the fetched data, not the action.
- Empty Map/Set literals need hints: `new Set([] as string[])`.
- Prefer interfaces `State` + `Actions` and `create<State & Actions>()` for stores
  with a reset (lets you reuse `initialState: State`).
- v5 setState overloads are strict about `replace` (see core-api.md).
