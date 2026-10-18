/**
 * Attempts section layout (`/apps/$appId/attempts/*`).
 *
 * This route is a *layout*: the list is `attempts.index.tsx` and the detail page is `attempts/$attemptId.tsx`.
 * Without an `<Outlet/>` here the child route could never mount — the list would render for every attempt URL.
 * The URL-synced search schema stays here so both children share it.
 */
import { Outlet, createFileRoute } from "@tanstack/react-router";
import { attemptsSearchSchema, parseSearch } from "~/features/app/search";

export const Route = createFileRoute("/apps/$appId/attempts")({
  validateSearch: (search: Record<string, unknown>) => parseSearch(attemptsSearchSchema, search),
  component: () => <Outlet />,
});
