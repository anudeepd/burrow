import { Outlet, createFileRoute } from "@tanstack/react-router";

/**
 * `/nodes` layout. The list lives in `nodes/index.tsx` and the detail in `nodes/$nodeId.tsx` so the detail page is not
 * nested inside the table (the table keeps its data + scroll when you come back).
 */
export const Route = createFileRoute("/nodes")({
  component: () => <Outlet />,
});
