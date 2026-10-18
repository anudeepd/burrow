/**
 * `/tools/logs` — the daemon's own log files, paged by byte range. `file`, `offset`, `len`, `tail` and the in-window
 * search `q` live in the URL, so "look at bytes 128–256 KiB of resourcemanager.log" is a link.
 */
import { createFileRoute } from "@tanstack/react-router";
import { LogsView } from "~/features/tools/LogsView";
import { logsSearchSchema } from "~/features/tools/search";

export const Route = createFileRoute("/tools/logs")({
  validateSearch: logsSearchSchema,
  component: LogsView,
});
