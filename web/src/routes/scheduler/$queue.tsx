import { createFileRoute } from "@tanstack/react-router";
import { QueuePage } from "~/features/scheduler/QueuePage";
import { type QueueSearch, queueSearchSchema } from "~/features/scheduler/search";

/** `/scheduler/$queue` — one queue in full. */
export const Route = createFileRoute("/scheduler/$queue")({
  validateSearch: queueSearchSchema,
  head: ({ params }) => ({ meta: [{ title: `${params.queue} · Scheduler · Burrow` }] }),
  component: QueueRoute,
});

function QueueRoute() {
  const { queue } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const patch = (p: Partial<QueueSearch>) => {
    void navigate({ search: { ...search, ...p }, replace: true, resetScroll: false });
  };
  return <QueuePage queue={queue} search={search} patch={patch} />;
}
