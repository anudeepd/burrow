import { createFileRoute } from "@tanstack/react-router";
import { NodesPage } from "~/features/nodes/NodesPage";
import { nodesSearchSchema } from "~/features/nodes/search";

export const Route = createFileRoute("/nodes/")({
  validateSearch: (search) => nodesSearchSchema.parse(search),
  component: NodesPage,
});
