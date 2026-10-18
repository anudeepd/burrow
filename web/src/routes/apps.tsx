import { Outlet, createFileRoute } from "@tanstack/react-router";

/**
 * `/apps` LAYOUT route. The list itself is `apps.index.tsx` (path `/apps`), and the application detail + Spark trees
 * (`apps/$appId/**`) nest under this Outlet. A route that has children must render its children, otherwise everything
 * below `/apps/<id>` renders nothing.
 */
export const Route = createFileRoute("/apps")({ component: () => <Outlet /> });
