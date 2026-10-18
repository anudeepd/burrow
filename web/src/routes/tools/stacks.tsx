import { createFileRoute } from "@tanstack/react-router";
import { stacksSearchSchema } from "~/features/tools/search";
import { StacksView } from "~/features/tools/StacksView";

/** `/tools/stacks` — the daemon thread dump (`?q=`, `?state=`, `?thread=`). */
export const Route = createFileRoute("/tools/stacks")({
  validateSearch: stacksSearchSchema,
  head: () => ({ meta: [{ title: "Server stacks · Burrow" }] }),
  component: StacksView,
});
