import { createFileRoute } from "@tanstack/react-router";
import { sparkSearch } from "~/features/spark/data/search";
import { EnvironmentPage } from "~/features/spark/pages/EnvironmentPage";

/** `/apps/$appId/spark/environment?q=&attempt=` — `q` filters the Spark Properties pane. */
export const Route = createFileRoute("/apps/$appId/spark/environment")({
  validateSearch: (s: Record<string, unknown>) => sparkSearch(s),
  component: EnvironmentPage,
});
