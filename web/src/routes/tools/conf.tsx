/**
 * `/tools/conf` — the daemon's effective configuration (RM, or a NodeManager with `?host=`). Everything the user can
 * change (search, filters, sort, visible columns, the expanded property, the node) is in the URL, so a key can be linked
 * to a colleague.
 */
import { createFileRoute } from "@tanstack/react-router";
import { ConfView } from "~/features/tools/ConfView";
import { confSearchSchema } from "~/features/tools/search";

export const Route = createFileRoute("/tools/conf")({
  validateSearch: confSearchSchema,
  component: ConfView,
});
