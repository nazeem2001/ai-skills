// dashboard-store.tsx — state + components for a live metrics dashboard.
// PROBLEM: every widget re-renders on every store change (even unrelated ones),
// and the FPS meter re-renders the whole tree 60 times per second.
import { create } from "zustand";

type Metric = { id: string; label: string; value: number; history: number[] };

type DashboardState = {
  metrics: Record<string, Metric>;
  selectedMetricIds: string[];
  sidebarOpen: boolean;
  theme: "light" | "dark";
  fps: number;
  lastUpdated: number | null;
  setSidebarOpen: (open: boolean) => void;
  setTheme: (t: "light" | "dark") => void;
  selectMetric: (id: string) => void;
  updateMetric: (id: string, value: number) => void;
  setFps: (fps: number) => void;
};

export const useDashboardStore = create<DashboardState>((set) => ({
  metrics: {},
  selectedMetricIds: [],
  sidebarOpen: true,
  theme: "light",
  fps: 0,
  lastUpdated: null,
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setTheme: (theme) => set({ theme }),
  selectMetric: (id) =>
    set((s) => ({ selectedMetricIds: [...s.selectedMetricIds, id] })),
  updateMetric: (id, value) =>
    set((s) => ({
      metrics: {
        ...s.metrics,
        [id]: {
          ...s.metrics[id],
          value,
          history: [...(s.metrics[id]?.history ?? []), value],
        },
      },
      lastUpdated: Date.now(),
    })),
  setFps: (fps) => set({ fps }),
}));

export function ThemeToggle() {
  const store = useDashboardStore();
  return (
    <button onClick={() => store.setTheme(store.theme === "light" ? "dark" : "light")}>
      {store.theme}
    </button>
  );
}

export function MetricCard({ id }: { id: string }) {
  const { metrics, selectedMetricIds, selectMetric } = useDashboardStore();
  const metric = metrics[id];
  const isSelected = selectedMetricIds.includes(id);
  return (
    <div onClick={() => selectMetric(id)} data-selected={isSelected}>
      {metric?.label}: {metric?.value}
    </div>
  );
}

export function SelectedSummary() {
  // re-renders on EVERY store change and logs a warning in v5
  const selected = useDashboardStore((s) =>
    s.selectedMetricIds.map((id) => s.metrics[id])
  );
  return <div>{selected.map((m) => m?.label).join(", ")}</div>;
}

export function FpsMeter() {
  // fps updates ~60x/sec and re-renders this AND everything above it
  const fps = useDashboardStore((s) => s.fps);
  return <span>{Math.round(fps)} fps</span>;
}
