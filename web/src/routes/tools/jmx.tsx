import { createFileRoute } from "@tanstack/react-router";
import { JmxView } from "~/features/tools/JmxView";
import { jmxSearchSchema } from "~/features/tools/search";

/** `/tools/jmx` — the MBean browser (`?qry=` pattern, `?host=` for a NodeManager, `?bean=`/`?attr=` selection). */
export const Route = createFileRoute("/tools/jmx")({
  validateSearch: jmxSearchSchema,
  head: () => ({ meta: [{ title: "JMX · Burrow" }] }),
  component: JmxView,
});
