# Zustand Performance — Re-render Model, Mistakes, and Fixes

Target: zustand v5.x. Sources: official docs/README, maintainers (dai-shi, dbritto-dev)
in pmndrs/zustand discussions, TkDodo's "Working with Zustand". URLs at the bottom.

## 1. The re-render model (understand this and everything else follows)

- `create()` wraps React's `useSyncExternalStore`. On **every** `set()`, every
  subscribed component's **selector runs**, and React compares the selector's output
  to the previous output with **`Object.is`** (v5 default — there is no built-in
  equality option on the main entry anymore).
- Output `Object.is`-equal → no re-render (but the selector still ran). Output
  differs → re-render.
- Consequence 1: **what must be stable is the selector's OUTPUT, not the selector
  function.** Inline selectors are fine and recommended; `useCallback` around cheap
  selectors is overhead, not optimization.
- Consequence 2: a selector returning a **fresh object/array/function each call** is
  never `Object.is`-equal → in v4 this wasted renders; **in v5 it throws
  `The result of getSnapshot should be cached to avoid an infinite loop` /
  `Maximum update depth exceeded`** (on SSR: `getServerSnapshot` variant). This is
  the #1 v4→v5 migration crash.
- Consequence 3 (scaling): zustand has no per-key subscription index. With N
  subscribed components, N selectors run per `set()` even if zero re-render. Keep
  selectors cheap; at ~10k live subscribers, split stores per domain.
- Parents still render children: zustand only skips *store-driven* renders. A child
  re-rendered by its parent needs `React.memo` like any other component.

## 2. Mistake catalogue → fix for each

### 2.1 Selecting the whole store
```tsx
// ❌ subscribes to EVERYTHING — re-renders on any change; and with React Compiler
// bare destructuring has at least one reported reactivity bug
const { bears } = useBearStore()

// ✅ atomic selector — the default idiom
const bears = useBearStore((s) => s.bears)
```

### 2.2 Fresh object/array from a selector
```tsx
// ❌ new object identity every call → v5 infinite loop
const { nuts, honey } = useBearStore((s) => ({ nuts: s.nuts, honey: s.honey }))

// ✅ preferred: two atomic selectors (no import, no shallow cost)
const nuts = useBearStore((s) => s.nuts)
const honey = useBearStore((s) => s.honey)

// ✅ when you genuinely need one combined pick: useShallow
import { useShallow } from 'zustand/react/shallow'
const { nuts, honey } = useBearStore(useShallow((s) => ({ nuts: s.nuts, honey: s.honey })))
```
Maintainer verdict (dai-shi): render-wise the two ✅ forms are equivalent; atomic wins
on bundle size (`shallow` "is a big function") and simplicity. Default to atomic.

### 2.3 Inline computed collections
```tsx
// ❌ Object.keys / .map / .filter / spread mint a new ref every call → v5 loop
const names = useMeals((s) => Object.keys(s.meals))

// ✅ wrap derived COLLECTIONS in useShallow
const names = useMeals(useShallow((s) => Object.keys(s.meals)))

// ✅ derived PRIMITIVES are always safe — compared by value
const count = useCart((s) => s.items.length)
const total = useCart((s) => s.items.reduce((a, i) => a + i.price * i.qty, 0)) // number → safe
```

### 2.4 Fresh functions from selectors — useShallow does NOT save you
```tsx
// ❌ new closure each call; loops even inside useShallow (shallow is 1-level, and
// two different closures are never equal)
const go = useWizard(useShallow((s) => () => { cleanup(); s.next() }))

// ✅ select the stable action, wrap OUTSIDE the selector
const next = useWizard((s) => s.next)
const go = () => { cleanup(); next() }

// ❌ same trap: defaulting inside a selector
const action = useStore((s) => s.action ?? (() => {}))
```

### 2.5 useShallow's limits (it is not a cure-all)
- Compares **one level deep** only. Nested fresh refs still loop:
  `useShallow((s) => [s.a, s.list.map(f)])` → the inner `.map` result is nested → loop.
- It does **not memoize computation** — the selector body still runs on every `set`.
  For expensive computation use `proxy-memoize` (dai-shi's pick) or `reselect`.
- For "changed" as a domain decision (deep equality, compare-by-id), use
  `createWithEqualityFn`/`useStoreWithEqualityFn` from `zustand/traditional`
  (requires installing `use-sync-external-store` yourself in v5).
- Import from `'zustand/react/shallow'` (canonical), not `'zustand/shallow'`
  (that's the plain compare function).

### 2.6 Derive-then-memoize when selectors get hairy
```tsx
// ✅ select the stable input, derive with useMemo in the component
const todos = useStore((s) => s.todos)
const meta = useMemo(() => todos.map((t) => ({ id: t.id, done: t.done })), [todos])
```

## 3. Actions: stable by construction

Actions defined in `create()` never change identity — selecting them is free.
TkDodo's pattern, endorsed as the "single atomic piece" idea:

```tsx
const useBearStore = create((set) => ({
  bears: 0,
  fish: 0,
  actions: {
    increasePopulation: (by) => set((s) => ({ bears: s.bears + by })),
    eatFish: () => set((s) => ({ fish: s.fish - 1 })),
  },
}))

export const useBears = () => useBearStore((s) => s.bears)
export const useBearActions = () => useBearStore((s) => s.actions)
// destructuring actions is fine — the object reference never changes:
const { increasePopulation } = useBearActions()
```
Known wart: with `devtools`, a state key literally named `actions` holding functions
has a field report of being stripped on rehydration paths (#3398) — if you hit
undefined actions under devtools, rename the key.

## 4. Custom hooks as the only export

Don't export the raw store hook. Export per-field hooks so "subscribe to everything"
is impossible and selectors aren't repeated at call sites:

```tsx
const useBearStore = create(...) // ⬅️ NOT exported
export const useBears = () => useBearStore((s) => s.bears)
```
The docs' `createSelectors` auto-generator (`useStore.use.bears()`) **breaks under
React Compiler** ("Should have a queue... calling Hooks conditionally"); dai-shi no
longer recommends it. Write hooks by hand.

## 5. Transient updates — 60fps data must not render React

For cursors, canvas, 3D, gauges, live tickers: subscribe outside React and write to
a ref or the DOM directly. This is a first-class zustand feature.

```tsx
const useScratchStore = create(() => ({ scratches: 0 }))

function ScratchMeter() {
  const ref = useRef(useScratchStore.getState().scratches)
  useEffect(
    () => useScratchStore.subscribe((s) => (ref.current = s.scratches)),
    [], // subscribe returns unsubscribe → perfect useEffect cleanup
  )
  // read ref.current inside rAF/imperative code — zero React renders
}
```

With `subscribeWithSelector` middleware, external subscriptions get selector +
equality + previous value + `fireImmediately`:

```tsx
const sub = useDogStore.subscribe((s) => s.paw, (paw, prevPaw) => {...}, {
  equalityFn: shallow, fireImmediately: true,
})
```
react-three-fiber doctrine: never bind fast state through a hook selector; read
`store.getState()` inside `useFrame`. Reserve transient updates for genuinely
frame-rate data — bypassing React's declarative model everywhere invites UI drift.

## 6. Large lists

1. Container selects **IDs only**: `useStore(useShallow((s) => s.items.map((i) => i.id)))`
2. Each row selects **its own item** by id — prefer normalized `Record<id, item>`
   state so the row selector is O(1): `useStore((s) => s.itemsById[id])`
3. `React.memo` the row so container renders don't cascade.
4. Ceiling: every row's selector still runs on every `set` of that store. Thousands
   of live subscribers → split stores per domain/region.

## 7. Store structure for performance

- **Flat-ish state.** Deep nesting forces deep spreads on write (broad invalidation)
  or deep equality on read. Normalize entities.
- **Multiple stores vs one:** dai-shi's rule — totally isolated domains → separate
  stores (unrelated `set`s then never even run each other's selectors); related
  state that one action must update together → one store (slices). TkDodo: several
  small stores, combined in custom hooks when needed.
- **Events, not setters:** put logic in the store action (`addToCart`), not in
  components calling three setters (three `set`s = up to three notification rounds —
  or batch into one `set`).
- **Don't put server cache in zustand** — that's TanStack Query's job (dedup,
  revalidation, GC). Zustand holds client state.

## 8. React Compiler / React 19 notes

- Core answer (dai-shi): zustand works under the compiler — selector-driven
  subscription is orthogonal to JSX memoization; the compiler absorbs child-cascade
  renders (auto-`memo`).
- BUT: store hooks must be named `useXxx` (compiler recognizes hooks by convention);
  `createSelectors`-style `useStore.use.x()` breaks; keep writing explicit selectors.

## 9. v5 quick migration trap-list

1. `useStore(selector, shallow)` two-arg form removed → `useShallow` or
   `zustand/traditional`.
2. Unstable selector outputs = crash, not just wasted render (getSnapshot loop).
3. Main entry dropped the `use-sync-external-store` shim → React 18+ required;
   `zustand/traditional` needs that package installed explicitly.
4. v4 code that loops in v5: object/array multi-picks without useShallow,
   `?? (() => {})` fallbacks in selectors, selector-returned closures.

## Sources

- https://tkdodo.eu/blog/working-with-zustand · https://tkdodo.eu/blog/zustand-and-react-context
- https://zustand.docs.pmnd.rs/reference/migrations/migrating-to-v5
- https://zustand.docs.pmnd.rs/reference/hooks/use-shallow · /learn/guides/prevent-rerenders-with-use-shallow
- pmndrs/zustand discussions: #971 (selector stability), #1936 (getSnapshot loop, canonical),
  #1937 (equalityFn removal RFC), #2496 (multi-store rule), #2562 (React Compiler),
  #2790/#2855 (v5 loops), #2830 (selector scaling), #2974 (atomic vs useShallow),
  #3103 (proxy-memoize vs useShallow), #3303 (useShallow resubscription), #3398 (devtools/actions)
- https://blog.axlight.com/posts/thoughts-on-state-management-libraries-in-the-react-compiler-era/
- https://r3f.docs.pmnd.rs/advanced/pitfalls
