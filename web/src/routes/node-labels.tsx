import { createFileRoute } from "@tanstack/react-router";
import { NodeLabelsPage } from "~/features/nodes/NodeLabelsPage";
import { nodeLabelsSearchSchema } from "~/features/nodes/search";

export const Route = createFileRoute("/node-labels")({
  head: () => ({ meta: [{ title: "Node labels · Burrow" }] }),
  validateSearch: (search) => nodeLabelsSearchSchema.parse(search),
  component: NodeLabelsPage,
});
