import { Outlet, createFileRoute } from "@tanstack/react-router";

/**
 * `/apps/$appId/spark/stages` layout. The list lives in `stages/index.tsx` and the attempt detail in
 * `stages/$stageId/$attemptId.tsx`, so the detail page renders *instead of* the table (the table keeps its data + scroll
 * when you come back) — the same layout/index split as `routes/nodes.tsx`.
 */
export const Route = createFileRoute("/apps/$appId/spark/stages")({
  component: () => <Outlet />,
});
