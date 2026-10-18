import { createFileRoute } from "@tanstack/react-router";
import { SchedulerPage } from "~/features/scheduler/SchedulerPage";
import { type SchedulerSearch, schedulerSearchSchema } from "~/features/scheduler/search";

/**
 * `/scheduler` — the queue-freeness view.
 *
 * File naming note: this is `scheduler.index.tsx`, not `scheduler.tsx`. With a sibling `scheduler.$queue.tsx`, a
 * `scheduler.tsx` would be treated by the file-router as a LAYOUT route for its children — and a layout that renders the
 * page instead of an `<Outlet/>` swallows the child route. The index + flat sibling form keeps both routes independent
 * and directly under `__root__` (the app shell).
 */
export const Route = createFileRoute("/scheduler/")({
  validateSearch: schedulerSearchSchema,
  head: () => ({ meta: [{ title: "Scheduler · Burrow" }] }),
  component: SchedulerRoute,
});

function SchedulerRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const patch = (p: Partial<SchedulerSearch>, options?: { resetScroll?: boolean }) => {
    void navigate({ search: { ...search, ...p }, replace: true, resetScroll: options?.resetScroll ?? false });
  };
  return <SchedulerPage search={search} patch={patch} />;
}
