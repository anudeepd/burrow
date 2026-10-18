/**
 * Spark layout route (`/apps/$appId/spark/*`). Owns the application-level Spark frame: source banner, attempt selector,
 * page tabs. Every Spark page is its `<Outlet/>`, so no page can miss the banner.
 */
import { Outlet, createFileRoute } from "@tanstack/react-router";
import { SparkShell } from "~/features/spark/ui/SparkShell";

export const Route = createFileRoute("/apps/$appId/spark")({
  component: SparkLayout,
});

function SparkLayout() {
  const { appId } = Route.useParams();
  return (
    <SparkShell appId={appId}>
      <Outlet />
    </SparkShell>
  );
}
