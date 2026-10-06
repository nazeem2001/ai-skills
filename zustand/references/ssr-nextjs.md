# Zustand + SSR / Next.js App Router (v5.x)

## The two failure modes you are designing against

1. **Cross-user state leaks.** A module-level (`export const useStore = create(...)`)
   store is a singleton per server process. On a Next.js/SSR server it lives across
   requests: one user's writes during SSR leak into another user's render. This has
   produced real production incidents (auth data leaking between users, phantom error
   toasts — pmndrs/zustand discussion #2200). Maintainer rule: **never use a global
   store on the server; React Server Components must never read or write a store.**
2. **Hydration mismatches.** Server renders defaults; client (with `persist`)
   synchronously hydrates from localStorage and renders different values →
   "Hydration failed because the initial UI does not match…". Not a zustand bug —
   it's rendering different data on server vs client.

## The canonical App Router architecture: store factory + Context provider

```ts
// src/stores/counter-store.ts — a FACTORY, not a global store
import { createStore } from 'zustand/vanilla'

export type CounterState = { count: number }
export type CounterActions = { incrementCount: () => void; decrementCount: () => void }
export type CounterStore = CounterState & CounterActions

export const defaultInitState: CounterState = { count: 0 }

export const createCounterStore = (initState: CounterState = defaultInitState) =>
  createStore<CounterStore>()((set) => ({
    ...initState,
    incrementCount: () => set((s) => ({ count: s.count + 1 })),
    decrementCount: () => set((s) => ({ count: s.count - 1 })),
  }))
```

```tsx
// src/providers/counter-store-provider.tsx
'use client'
import { type ReactNode, createContext, useContext, useState } from 'react'
import { useStore } from 'zustand'
import { type CounterStore, createCounterStore } from '@/stores/counter-store'

export type CounterStoreApi = ReturnType<typeof createCounterStore>
const CounterStoreContext = createContext<CounterStoreApi | undefined>(undefined)

export const CounterStoreProvider = ({ children }: { children: ReactNode }) => {
  const [store] = useState(() => createCounterStore()) // one store per provider mount
  return <CounterStoreContext.Provider value={store}>{children}</CounterStoreContext.Provider>
}

export const useCounterStore = <T,>(selector: (store: CounterStore) => T): T => {
  const ctx = useContext(CounterStoreContext)
  if (!ctx) throw new Error('useCounterStore must be used within CounterStoreProvider')
  return useStore(ctx, selector)
}
```

- Mount the provider in `app/layout.tsx` for app-wide state, or at a page/route
  component for per-route state (docs: avoid per-route unless needed).
- `useState(() => createStore())` (lazy initializer) guarantees exactly one store per
  provider instance across re-renders.
- Context holds the **store instance** (static — no context-driven re-renders);
  `useStore(store, selector)` keeps subscriptions granular. "Don't use context for
  state management. Use it for dependency injection only" (TkDodo).
- Consumers are `'use client'` components using atomic selectors /
  `useShallow` exactly as with global stores.

**Initialize from server data** — RSC fetches, provider seeds the factory:

```tsx
// app/page.tsx (Server Component)
const count = await fetchInitialCount(userId)
return <CounterStoreProvider initialState={{ count }}>…</CounterStoreProvider>
// provider: const [store] = useState(() => createCounterStore(initialState))
```
This is true initialization (no first-render-with-defaults, no useEffect sync loop).

When is a global module store still OK? Browser-only SPAs (Vite/CRA, Electron
renderer) — anywhere the module is evaluated per-user. In any SSR framework, default
to the factory pattern.

## persist + SSR: the hydration playbook

The server can never read localStorage, so pick by state type:
- **Affects the first-paint HTML** (theme, locale, sort order) → store it in a
  **cookie**, read it in the server component, pass as initial state. localStorage
  fundamentally cannot server-render correctly.
- **Request-dependent state** → per-request store from server props (above).
- **Browser-only convenience state** (cart draft, wizard progress) → persist +
  gate/defer, below.

Fix A — `skipHydration` + rehydrate after mount (community-canonical, most control):

```ts
const useCartStore = create<CartStore>()(
  persist((set) => ({ ... }), { name: 'cart', skipHydration: true }),
)
```
```tsx
'use client'
export function Hydrations() {
  useEffect(() => { useCartStore.persist.rehydrate() }, [])
  return null
}
// mount <Hydrations /> once in the root layout body
```
Server and first client render both see defaults → no mismatch; persisted values
arrive in an effect. Combine with a hydration gate for UI that must wait:

Fix B — `_hasHydrated` flag (or the `useHydration` hook — see middleware.md):

```ts
persist(
  (set) => ({ _hasHydrated: false, setHasHydrated: (v) => set({ _hasHydrated: v }), ... }),
  {
    name: 'cart',
    onRehydrateStorage: (state) => () => state.setHasHydrated(true),
    partialize: (s) => ({ items: s.items }), // don't persist the flag
  },
)
// const hydrated = useCartStore((s) => s._hasHydrated)
// if (!hydrated) return <Skeleton />
```

Fix C — deferred-read wrapper (official docs; simplest, per-value):

```ts
const useHydratedStore = <T, F>(store: (cb: (state: T) => unknown) => unknown, callback: (state: T) => F) => {
  const result = store(callback) as F
  const [data, setData] = useState<F>()
  useEffect(() => { setData(result) }, [result])
  return data // undefined until mounted — render a fallback
}
```
Tradeoff: extra render + flash of fallback. Fine for a badge; annoying at scale.

Notes:
- The persist-in-context combination works: apply `persist` inside the factory's
  `createStore` call with `skipHydration: true`, rehydrate in the provider's effect.
- Async storages hydrate after mount even without SSR → the "logged-out flicker";
  same gates apply.
- v5 error text on SSR selector instability:
  `The result of getServerSnapshot should be cached` — same unstable-selector bug as
  getSnapshot, same fixes (atomic selectors / useShallow).

## Rules recap (App Router)

1. No module-level stores in any code that runs on the server.
2. RSCs never touch stores — they fetch data and pass props.
3. Store factory (`createStore` vanilla) + Context provider + bound `useStore` hook.
4. Server-visible persisted prefs → cookies; browser-only → persist + skipHydration.
5. Per-route reset = mount the provider at the route level.
