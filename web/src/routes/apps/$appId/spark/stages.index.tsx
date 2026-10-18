import { createFileRoute } from "@tanstack/react-router";
import { StagesPage } from "~/features/spark/pages/StagesPage";
import { sparkSearch } from "~/features/spark/data/search";

/** `/apps/$appId/spark/stages?status=&q=&sort=&dir=&cols=&agg=` — `agg=1` folds stage attempts into one row per stage. */
export const Route = createFileRoute("/apps/$appId/spark/stages/")({
  validateSearch: (s: Record<string, unknown>) => sparkSearch(s),
  component: StagesPage,
});
