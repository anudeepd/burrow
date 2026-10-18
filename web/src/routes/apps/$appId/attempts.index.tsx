/**
 * Attempts tab (`/apps/$appId/attempts`) — the legacy `table#attempts` with URL-synced sort/columns.
 *
 * The list lives on the index route so that the route above it can be a pure layout (see `attempts.tsx`):
 * `/attempts` shows this list, `/attempts/$attemptId` shows the attempt detail page.
 */
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { q } from "~/api/queries";
import { selectAppAttempts } from "~/api/schemas";
import { ErrorState, Skeleton, StaleErrorBanner } from "~/ui/feedback";
import { ATTEMPT_DEFAULT_VISIBILITY, AttemptsTab } from "~/features/app/components/AttemptsTab";
import { sortingFromParam, sortingToParam, visibilityFromParam, visibilityToParam } from "~/features/app/search";
import { useNow } from "~/features/app/use-now";

export const Route = createFileRoute("/apps/$appId/attempts/")({ component: AttemptsRoute });

/** The layout route owns the search schema; this list reads the same typed state through its API. */
const parent = getRouteApi("/apps/$appId/attempts");

function AttemptsRoute() {
  const { appId } = Route.useParams();
  const search = parent.useSearch();
  const navigate = parent.useNavigate();
  const app = useQuery(q.app(appId));
  const attempts = useQuery(q.appAttempts(appId));
  const rows = selectAppAttempts(attempts.data ?? {});
  const live = rows.some((a) => a.finishedTime === 0);
  const now = useNow(live);

  if (attempts.isPending) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2" aria-busy="true">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (attempts.isError && !attempts.data) {
    return (
      <ErrorState
        title="Could not load the application attempts"
        message={attempts.error instanceof Error ? attempts.error.message : "The RM did not return an attempts payload."}
        hint="`GET /ws/v1/cluster/apps/{id}/appattempts` — the application may have expired from the RM."
        onRetry={() => void attempts.refetch()}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {app.error &&
        (app.data ? (
          <StaleErrorBanner
            title="Application summary refresh failed; attempts remain available"
            error={app.error}
            onRetry={() => void app.refetch()}
          />
        ) : (
          <ErrorState
            compact
            title="Application summary could not be read; attempts remain available"
            message={app.error instanceof Error ? app.error.message : String(app.error)}
            onRetry={() => void app.refetch()}
          />
        ))}
      {attempts.error && (
        <StaleErrorBanner
          title="Attempt refresh failed; showing the last loaded attempts"
          error={attempts.error}
          onRetry={() => void attempts.refetch()}
        />
      )}
      <AttemptsTab
        appId={appId}
        attempts={rows}
        now={now}
        sorting={sortingFromParam(search.sort)}
        onSortingChange={(s) =>
          void navigate({
            to: "/apps/$appId/attempts",
            params: { appId },
            search: (prev) => ({ ...prev, sort: sortingToParam(s) }),
            replace: true,
          })
        }
        columnVisibility={visibilityFromParam(search.cols, ATTEMPT_DEFAULT_VISIBILITY)}
        onColumnVisibilityChange={(v) =>
          void navigate({
            to: "/apps/$appId/attempts",
            params: { appId },
            search: (prev) => ({ ...prev, cols: visibilityToParam(v, ATTEMPT_DEFAULT_VISIBILITY) }),
            replace: true,
          })
        }
        toolbar={
          <span className="text-small text-ink-3">
            {rows.length} attempt{rows.length === 1 ? "" : "s"}
            {app.data && <span className="text-ink-4"> · final status {app.data.finalStatus}</span>}
          </span>
        }
      />
    </div>
  );
}
