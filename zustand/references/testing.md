# Testing Zustand Stores (v5.x)

Recommended stack (official): React Testing Library (+ user-event), jsdom, MSW for
network. React Native: RNTL.

## Decide first: do you even need the mock?

- **Context/factory stores** (the Next.js pattern): NO reset machinery needed — build
  a fresh store per test and inject it via the provider. Skip to §3.
- **Global module stores**: state leaks between tests. Use the official auto-reset
  mock (§1) so every store resets after each test.
- **Store logic itself**: test as a plain object, no React at all (§4).

## 1. The official auto-reset mock — `__mocks__/zustand.ts`

Wraps `create`/`createStore`; every store registers a reset to `getInitialState()`
(with `replace: true`), run in `afterEach` inside `act`.

```ts
// __mocks__/zustand.ts  (Vitest version)
import { act } from '@testing-library/react'
import type * as ZustandExportedTypes from 'zustand'
export * from 'zustand'

const { create: actualCreate, createStore: actualCreateStore } =
  await vi.importActual<typeof ZustandExportedTypes>('zustand')
// Jest: jest.requireActual<typeof ZustandExportedTypes>('zustand')

export const storeResetFns = new Set<() => void>()

const createUncurried = <T>(stateCreator: ZustandExportedTypes.StateCreator<T>) => {
  const store = actualCreate(stateCreator)
  const initialState = store.getInitialState()
  storeResetFns.add(() => { store.setState(initialState, true) })
  return store
}

// supports both curried create<T>()(...) and uncurried create(...)
export const create = (<T>(stateCreator: ZustandExportedTypes.StateCreator<T>) => {
  return typeof stateCreator === 'function' ? createUncurried(stateCreator) : createUncurried
}) as typeof ZustandExportedTypes.create

const createStoreUncurried = <T>(stateCreator: ZustandExportedTypes.StateCreator<T>) => {
  const store = actualCreateStore(stateCreator)
  const initialState = store.getInitialState()
  storeResetFns.add(() => { store.setState(initialState, true) })
  return store
}

export const createStore = (<T>(stateCreator: ZustandExportedTypes.StateCreator<T>) => {
  return typeof stateCreator === 'function' ? createStoreUncurried(stateCreator) : createStoreUncurried
}) as typeof ZustandExportedTypes.createStore

afterEach(() => {
  act(() => { storeResetFns.forEach((resetFn) => resetFn()) })
})
```

Wiring:
- **Vitest** does not auto-mock — `setup-vitest.ts` must call `vi.mock('zustand')`;
  config: `test: { globals: true, environment: 'jsdom', setupFiles: ['./setup-vitest.ts'] }`.
  If you changed Vitest `root` to `./src`, the mock MUST live at `./src/__mocks__/` —
  wrong placement silently does nothing.
  Without `globals: true`, import `afterEach`/`vi` inside the mock file.
- **Jest** auto-discovers `__mocks__/zustand.ts`; config `testEnvironment: 'jsdom'`,
  `setupFilesAfterEnv: ['./setup-jest.ts']`.

## 2. Testing components on global stores

Assert through the DOM AND directly via the store API:

```tsx
test('increments on click', async () => {
  const user = userEvent.setup()
  render(<Counter />)
  expect(useCounterStore.getState().count).toBe(1)
  await user.click(await screen.findByRole('button', { name: /one up/i }))
  expect(useCounterStore.getState().count).toBe(2)
})
```
Need non-default initial state? `useCounterStore.setState({ count: 42 })` at test
start (the mock resets it afterward). Wrap in `act` if it triggers renders.

## 3. Context/factory stores — inject a fresh instance per test

```tsx
const renderWithStore = (store = createCounterStore()) => ({
  store,
  ...render(<CounterWithContext />, {
    wrapper: ({ children }) => (
      <CounterStoreContext.Provider value={store}>{children}</CounterStoreContext.Provider>
    ),
  }),
})

test('increments', async () => {
  const user = userEvent.setup()
  const { store } = renderWithStore()
  await user.click(await screen.findByRole('button', { name: /one up/i }))
  expect(store.getState().count).toBe(2)
})
```
Isolation for free; also lets you pre-seed state via the factory argument.

## 4. Unit-test store logic without React

A store is just `{ getState, setState, subscribe }`. Export the `StateCreator`
separately (the same creator feeds `create`, `createStore`, providers, and tests):

```ts
import { createStore } from 'zustand/vanilla'
import { counterStoreCreator } from './counter-store-creator'

test('inc', () => {
  const store = createStore(counterStoreCreator) // fresh per test — nothing to reset
  store.getState().inc()
  expect(store.getState().count).toBe(1)
})
```
Async actions: await them, then assert `getState()`; mock network with MSW.

## 5. Persisted stores in tests

jsdom provides localStorage, but persisted state ALSO leaks between tests. Either
`partialize`/`skipHydration` in test setup, call `useStore.persist.clearStorage()`
in `afterEach`, or prefer testing the unpersisted creator directly (§4).
