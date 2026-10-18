import { Outlet, createFileRoute } from "@tanstack/react-router";

/**
 * `/apps/$appId/spark/jobs` layout. The list lives in `jobs/index.tsx` and a job's detail in `jobs/$jobId.tsx`, so the
 * detail page renders *instead of* the table while keeping the same route prefix (same layout/index split as `stages`).
 */
export const Route = createFileRoute("/apps/$appId/spark/jobs")({
  component: () => <Outlet />,
});
