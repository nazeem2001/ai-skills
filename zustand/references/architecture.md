# Zustand Architecture — What Goes Where, Store Shape, and When NOT to Use It

## The state taxonomy (decide BEFORE reaching for zustand)

| State kind | Right tool | Why not zustand |
|---|---|---|
| Server cache (API data anything else can change) | TanStack Query / SWR / RTK Query | You'd reinvent dedupe, invalidation, retries, background refetch — badly |
| Form state | react-hook-form (useState for tiny forms) | Field subscriptions, validation, submit lifecycle already solved |
| URL-shareable state (filters, tabs, pagination) | router search params / nuqs | Survives refresh/share/back-button |
| Truly local state | useState / useReducer | If it doesn't need sharing, don't share it |
| DI / compound-component wiring | React Context | Context is for injection, not changing values |
| Global CLIENT state that remains | **zustand** | This residue is usually small — that's the point |

The 2026 default stack the community converged on: TanStack Query + nuqs/router +
useState + a small zustand store for what's left.

**The #1 architectural mistake: copying server data into the store.**
`useEffect(() => { if (data) setUsers(data) }, [data])` or `onSuccess: setUsers`
creates two sources of truth that WILL diverge. Maintainer (dai-shi): "don't do it —
recommended." The sanctioned composition — zustand holds the client-owned INPUT,
which drives the query key:

```ts
export const useFilteredTodos = () => {
  const filters = useAppliedFilters() // zustand custom hook
  return useQuery({ queryKey: ['todos', filters], queryFn: () => getTodos(filters) })
}
```
(Forgetting zustand-held filters in the queryKey = stale cached results.)

## One store vs many — the decision rule

Maintainer rule (dai-shi/dbritto-dev, discussion #2496):
- **Totally independent domains → separate stores.** Bonus: unrelated `set`s never
  even run each other's selectors; free code-splitting; simpler types.
- **Data that must update atomically together → one store** (use slices to keep it
  modular).
- **Context-injected (SSR/per-instance) → prefer one store per context** (one
  provider).
- Single shared time-travel timeline in devtools → needs one store.

TkDodo's simpler default: multiple small stores, combined in custom hooks when
needed (`useUsersStore((s) => s.users[useCredentialsStore((s) => s.currentUser)])` —
composition happens in hooks, not by merging stores). Both positions are
maintainer-endorsed; pick per coupling, stay consistent.

Avoid the god store: auth + cart + products + notifications + fetch logic in one
`create()` recreates the Redux mega-store problem with none of its tooling.

## Store shape

```ts
// ⬇️ raw hook NOT exported — nobody can subscribe to the whole store
const useCartStore = create<CartStore>()((set, get) => ({
  // 1. flat-ish, normalized data
  itemsById: {} as Record<string, CartItem>,
  itemIds: [] as string[],
  // 2. actions colocated, modeled as EVENTS (business logic lives here)
  actions: {
    addItem: (product: Product) => set((s) => /* ... */),
    removeItem: (id: string) => set((s) => /* ... */),
    checkoutStarted: () => { /* multi-step logic, get() reads, ONE set() commit */ },
  },
}))

// ⬇️ the public API of the store is custom hooks
export const useCartItemIds = () => useCartStore((s) => s.itemIds)
export const useCartItem = (id: string) => useCartStore((s) => s.itemsById[id])
export const useCartCount = () => useCartStore((s) => s.itemIds.length)
export const useCartActions = () => useCartStore((s) => s.actions)
```

Why each choice:
- **Custom-hooks-only export** — over-subscription becomes impossible; selectors
  aren't repeated; React Compiler-safe (bare destructuring of the raw hook is not).
- **Actions as events, not setters** (`checkoutStarted`, not `setCheckoutStep(2)`) —
  logic stays in the store, components stay dumb, and the store is unit-testable
  without React.
- **`actions` namespace** — referentially stable forever, so one hook + destructuring
  is fine. (If you persist: `partialize` MUST exclude it. Alternative both
  maintainers endorse: module-level functions calling `useCartStore.setState(...)` —
  "no store actions" pattern. Callable outside React, code-splits well, but
  hard-binds to a module-global store, so it does NOT fit the SSR/factory
  architecture. Pick one convention per codebase. Don't name module-level non-hooks
  `useX`.)
- **Flat + normalized** — `Object.is`/shallow work at one level; rows select
  `itemsById[id]` in O(1).
- **Effects don't orchestrate state.** Store actions belong in event handlers, not
  useEffect bodies/dep arrays. useEffect-reacting-to-store-to-update-store chains
  are the classic LLM-generated antipattern — model the transition as ONE action.

## Slices pattern (when one store earns it)

```ts
// each slice: StateCreator<FullStore, MutatorsOfWrappingMiddleware, [], Slice>
const createCartSlice: StateCreator<Store, [['zustand/devtools', never]], [], CartSlice> =
  (set, get) => ({
    items: [],
    addItem: (item) => set((s) => ({ items: [...s.items, item] }), undefined, 'cart/addItem'),
  })

export const useBoundStore = create<CartSlice & UserSlice>()(
  devtools(persist(
    (...a) => ({ ...createCartSlice(...a), ...createUserSlice(...a) }),
    { name: 'app', partialize: (s) => ({ items: s.items }) },
  )),
)
```
Cross-slice access: `get().otherSliceAction()` — the full-store first generic makes
it typed. Middleware wraps ONLY the combined store. Full typing in typescript.md.

## Scaling and integration notes

- Store reachable outside React (`getState`/`setState`/`subscribe`) is zustand's
  edge over Context/Redux hooks: bind websocket/event-source listeners to
  `store.setState` in plain modules; React just consumes.
- High-frequency sources (sensors, sockets at 10-50Hz): accumulate in a ref/buffer,
  throttle store commits (2-4/sec), keep 60fps consumers on transient
  subscriptions (performance.md §5).
- 3D/canvas editors: commit to the store on gesture END; during the gesture mutate
  an imperative registry (or non-reactive store fields read via `getState()`).
  Reactive undo-tracked state is for commits, not per-frame updates.
- Per-instance reusable components (design systems): factory + Context
  (ssr-nextjs.md pattern) so instances don't share state.
- Reset: every store with logout/cleanup needs a `reset()` using
  `store.getInitialState()`.

## vs alternatives (one-line verdicts, community consensus)

- **Redux Toolkit**: choose for 5-10+ engineer teams needing enforced structure,
  audit trails, single time-travel timeline, or RTK Query. Don't migrate healthy
  RTK apps.
- **Jotai**: choose when state is a graph of derived values (form builders,
  canvases, spreadsheets) — derived atoms recompute only on dependency change,
  zustand selectors run on every set.
- **Context**: DI and compound components only.
- **Valtio**: you prefer mutable proxies / implicit tracking; zustand's explicit
  selectors are a feature at scale.
