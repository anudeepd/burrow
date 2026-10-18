import { createFileRoute } from "@tanstack/react-router";
import { sparkSearch } from "~/features/spark/data/search";
import { SqlPage } from "~/features/spark/pages/SqlPage";

/** `/apps/$appId/spark/sql?status=&q=&sort=&dir=&cols=&page=&size=&attempt=` */
export const Route = createFileRoute("/apps/$appId/spark/sql/")({
  validateSearch: (s: Record<string, unknown>) => sparkSearch(s),
  component: SqlPage,
});
