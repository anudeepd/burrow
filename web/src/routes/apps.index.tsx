import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AppsPage } from "~/features/apps/apps-page";
import { appsSearchSchema, withPatch, type AppsSearch } from "~/features/apps/search";

/**
 * `/apps` — the applications list (index child of the `apps.tsx` layout). All view state (category tab, filters, sort,
 * hidden columns) lives in the search params, validated by one zod schema (src/features/apps/search.ts), so every view
 * is linkable and the back button works.
 */
export const Route = createFileRoute("/apps/")({
  validateSearch: (search: Record<string, unknown>): AppsSearch => appsSearchSchema.parse(search),
  component: AppsRoute,
  staticData: { title: "Applications" },
});

function AppsRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const patch = (p: Partial<AppsSearch>) => {
    void navigate({ to: "/apps", search: (prev: AppsSearch) => withPatch(prev, p), replace: true });
  };
  return (
    <AppsPage
      search={search}
      patch={patch}
      onOpenApp={(appId) => {
        void navigate({ to: "/apps/$appId", params: { appId } });
      }}
    />
  );
}
