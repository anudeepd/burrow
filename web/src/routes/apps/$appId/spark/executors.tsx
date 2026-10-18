import { createFileRoute } from "@tanstack/react-router";
import { ExecutorsPage } from "~/features/spark/pages/ExecutorsPage";
import { sparkSearch } from "~/features/spark/data/search";

/** `/apps/$appId/spark/executors?all=&q=&sort=&dir=&cols=&attempt=` — `all=1` reads `allexecutors` (adds dead executors). */
export const Route = createFileRoute("/apps/$appId/spark/executors")({
  validateSearch: (s: Record<string, unknown>) => sparkSearch(s),
  component: ExecutorsPage,
});
