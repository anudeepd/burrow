import { createFileRoute } from "@tanstack/react-router";
import { NodeDetail } from "~/features/nodes/NodeDetail";

export const Route = createFileRoute("/nodes/$nodeId")({
  component: NodeDetail,
});
