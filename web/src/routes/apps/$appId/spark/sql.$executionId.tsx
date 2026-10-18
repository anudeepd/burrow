import { createFileRoute } from "@tanstack/react-router";
import { sparkSearch } from "~/features/spark/data/search";
import { SqlDetailPage } from "~/features/spark/pages/SqlDetailPage";

/** `/apps/$appId/spark/sql/$executionId?q=` — `q` searches the raw plan tree. */
export const Route = createFileRoute("/apps/$appId/spark/sql/$executionId")({
  validateSearch: (s: Record<string, unknown>) => sparkSearch(s),
  component: SqlDetailPage,
});
