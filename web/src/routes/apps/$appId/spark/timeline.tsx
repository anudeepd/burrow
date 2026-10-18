import { createFileRoute } from "@tanstack/react-router";
import { TimelinePage } from "~/features/spark/pages/TimelinePage";
import { sparkSearch } from "~/features/spark/data/search";

/**
 * `/apps/$appId/spark/timeline?from=&to=&zoom=&attempt=` — `from`/`to` are the visible time window in epoch ms and
 * `zoom` the level that produced it; absent means "fit the whole application".
 */
export const Route = createFileRoute("/apps/$appId/spark/timeline")({
  validateSearch: (s: Record<string, unknown>) => sparkSearch(s),
  component: TimelinePage,
});
