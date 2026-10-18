import { createFileRoute } from "@tanstack/react-router";
import { NodeLabelsPage } from "~/features/nodes/NodeLabelsPage";
import { nodeLabelsSearchSchema } from "~/features/nodes/search";

export const Route = createFileRoute("/node-labels")({
  validateSearch: (search) => nodeLabelsSearchSchema.parse(search),
  component: NodeLabelsPage,
});
