import { Outlet, createFileRoute } from "@tanstack/react-router";

/** `/apps/$appId/spark/storage` layout: the RDD list is `storage/index.tsx`, one RDD is `storage/$rddId.tsx`. */
export const Route = createFileRoute("/apps/$appId/spark/storage")({
  head: ({ params }) => ({ meta: [{ title: `Storage · ${params.appId} · Burrow` }] }),
  component: () => <Outlet />,
});
