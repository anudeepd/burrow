/**
 * `/apps/$appId/logs` — container logs (stdout/stderr) for a running or finished container, with live follow.
 *
 * The container is named in the URL (`?container=…`), so the app's attempt/container tables can link straight here;
 * without one the route shows a picker over the application's containers. `file`, `follow`, `tail`, `filter`, `q`,
 * `wrap` and `ts` are all search params, so a log view is a shareable link.
 */
import { createFileRoute } from "@tanstack/react-router";
import { LogsView } from "~/features/logs/LogsView";
import { logsSearchSchema, parseSearch } from "~/features/logs/search";

export const Route = createFileRoute("/apps/$appId/logs")({
  validateSearch: (search: Record<string, unknown>) => parseSearch(logsSearchSchema, search),
  component: LogsView,
});
