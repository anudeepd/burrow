import { createFileRoute } from "@tanstack/react-router";
import { JobsPage } from "~/features/spark/pages/JobsPage";
import { sparkSearch } from "~/features/spark/data/search";

/** `/apps/$appId/spark/jobs?status=&q=&sort=&dir=&cols=&attempt=` */
export const Route = createFileRoute("/apps/$appId/spark/jobs/")({
  head: ({ params }) => ({ meta: [{ title: `Jobs · ${params.appId} · Burrow` }] }),
  validateSearch: (s: Record<string, unknown>) => sparkSearch(s),
  component: JobsPage,
});
