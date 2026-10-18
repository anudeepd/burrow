import { Outlet, createFileRoute } from "@tanstack/react-router";

/** `/apps/$appId/spark/sql` layout: the execution list is `sql/index.tsx`, a query's plan is `sql/$executionId.tsx`. */
export const Route = createFileRoute("/apps/$appId/spark/sql")({
  component: () => <Outlet />,
});
