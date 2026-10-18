/**
 * `/` — the Overview. URL state is the utilisation-history window (everything else on the page is live cluster state,
 * not user state). `validateSearch` is total: an unknown/garbage `window` falls back to `all` so a hand-edited URL can
 * never blank the page.
 */
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { useMounted } from "~/lib/use-mounted";
import type { HistoryWindow } from "~/features/overview/overview-page";
import { HISTORY_WINDOWS } from "~/features/overview/derive";

const OverviewPage = lazy(() => import("~/features/overview/overview-page").then((module) => ({ default: module.OverviewPage })));

const WINDOW_KEYS = HISTORY_WINDOWS.map((w) => w.key) as readonly HistoryWindow[];

export interface OverviewSearch {
  window: HistoryWindow;
}

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): OverviewSearch => ({
    window: WINDOW_KEYS.includes(search.window as HistoryWindow) ? (search.window as HistoryWindow) : "all",
  }),
  component: OverviewRoute,
});

function OverviewRoute() {
  const mounted = useMounted();
  const { window: historyWindow } = Route.useSearch();
  const navigate = Route.useNavigate();
  // The prerendered shell leaves the route outlet empty; retain its Suspense boundary until hydration finishes.
  if (!mounted) return <Suspense fallback={null} />;
  return (
    <Suspense fallback={null}>
      <OverviewPage
        window={historyWindow}
        onHistoryWindow={(next) => {
          void navigate({ search: (prev) => ({ ...prev, window: next }), replace: true });
        }}
      />
    </Suspense>
  );
}
