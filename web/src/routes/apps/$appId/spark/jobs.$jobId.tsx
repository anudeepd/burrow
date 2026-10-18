import { createFileRoute } from "@tanstack/react-router";
import { JobDetailPage } from "~/features/spark/pages/JobDetailPage";
import { sparkSearch } from "~/features/spark/data/search";

/** `/apps/$appId/spark/jobs/$jobId?stage=&sort=&dir=&cols=` — `stage` is set by clicking a node in the job DAG. */
export const Route = createFileRoute("/apps/$appId/spark/jobs/$jobId")({
  validateSearch: (s: Record<string, unknown>) => sparkSearch(s),
  component: JobDetailPage,
});
