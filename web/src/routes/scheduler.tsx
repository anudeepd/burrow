import { Outlet, createFileRoute } from "@tanstack/react-router";

/**
 * Layout for the scheduler section — nothing but an `<Outlet />`, exactly like `apps.tsx`/`nodes.tsx`: a route with
 * children must render them, otherwise `/scheduler/$queue` would never mount. The page itself lives in
 * `scheduler.index.tsx`, the queue drill-down in `scheduler/$queue.tsx`.
 */
export const Route = createFileRoute("/scheduler")({ component: () => <Outlet /> });
