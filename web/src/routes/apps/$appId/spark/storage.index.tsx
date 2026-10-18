import { createFileRoute } from "@tanstack/react-router";
import { sparkSearch } from "~/features/spark/data/search";
import { StoragePage } from "~/features/spark/pages/StoragePage";

/**
 * `/apps/$appId/spark/storage?q=&rdd=&sort=&dir=&cols=&attempt=` — `rdd=<id>` expands that RDD's partitions and executor
 * distribution inline.
 */
export const Route = createFileRoute("/apps/$appId/spark/storage/")({
  validateSearch: (s: Record<string, unknown>) => sparkSearch(s),
  component: StoragePage,
});
