import { createFileRoute, redirect } from "@tanstack/react-router";

/** `/apps/$appId/spark` lands on the Jobs page (Spark's own default tab). */
export const Route = createFileRoute("/apps/$appId/spark/")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/apps/$appId/spark/jobs", params });
  },
});
