import { createFileRoute } from "@tanstack/react-router";
import { StreamingPage } from "~/features/spark/pages/StreamingPage";
import { sparkSearch } from "~/features/spark/data/search";

/**
 * `/apps/$appId/spark/streaming?status=&size=&sort=&dir=&cols=&attempt=` — `status` filters the batch table
 * (COMPLETED|PROCESSING|QUEUED), `size` is how many of the newest batches are loaded and charted (default 200).
 */
export const Route = createFileRoute("/apps/$appId/spark/streaming")({
  validateSearch: (s: Record<string, unknown>) => sparkSearch(s),
  component: StreamingPage,
});
