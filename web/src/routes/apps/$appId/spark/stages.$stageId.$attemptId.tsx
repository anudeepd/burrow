import { createFileRoute } from "@tanstack/react-router";
import { StageDetailPage } from "~/features/spark/pages/StageDetailPage";
import { sparkSearch } from "~/features/spark/data/search";

/**
 * `/apps/$appId/spark/stages/$stageId/$attemptId?sort=&dir=&cols=&q=&taskStatus=&size=&page=&level=&attempt=` —
 * `size` (25|50|100) switches the task table to Spark's server-side paging, `level=more` adds the additional task metrics.
 */
export const Route = createFileRoute("/apps/$appId/spark/stages/$stageId/$attemptId")({
  validateSearch: (s: Record<string, unknown>) => sparkSearch(s),
  component: StageDetailPage,
});
