/**
 * Attempt detail route (`/apps/$appId/attempts/$attemptId`) — the legacy `/cluster/appattempt/{id}` page.
 */
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import { ApiError } from "~/api/client";
import { q } from "~/api/queries";
import { selectAppAttempts, selectContainers } from "~/api/schemas";
import { ErrorState, Skeleton } from "~/ui/feedback";
import { AttemptDetail } from "~/features/app/components/AttemptDetail";
import { isAppFinal } from "~/features/app/model";
import { useNow } from "~/features/app/use-now";

export const Route = createFileRoute("/apps/$appId/attempts/$attemptId")({ component: AttemptRoute });

function AttemptRoute() {
  const { appId, attemptId } = Route.useParams();
  const app = useQuery(q.app(appId));
  const attempts = useQuery(q.appAttempts(appId));
  const containers = useQuery(q.appContainers(appId, attemptId));
  const detail = useQuery(q.appAttemptDetail(appId, attemptId));
  const attemptsList = selectAppAttempts(attempts.data ?? {});
  const now = useNow(attemptsList.some((a) => a.appAttemptId === attemptId && a.finishedTime === 0));

  if (app.isPending || attempts.isPending) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!app.data) {
    return (
      <ErrorState
        title="Could not load the parent application"
        message={app.error instanceof Error ? app.error.message : "The RM returned no application payload."}
        onRetry={() => void app.refetch()}
      />
    );
  }

  if (attempts.isError && !attempts.data) {
    return (
      <ErrorState
        title="Could not load application attempts"
        message={attempts.error instanceof Error ? attempts.error.message : String(attempts.error)}
        hint="The attempt list is needed to confirm this id belongs to the application."
        onRetry={() => void attempts.refetch()}
      />
    );
  }

  const attempt = attemptsList.find((a) => a.appAttemptId === attemptId);
  if (!attempt) {
    return (
      <ErrorState
        title={`Attempt ${attemptId} is not known to the ResourceManager`}
        message={
          <span>
            The RM's attempt list for this application does not contain this attempt id.{" "}
            <Link to="/apps/$appId/attempts" params={{ appId }} className="text-live underline-offset-2 hover:underline">
              Back to all attempts
            </Link>
          </span>
        }
        hint="Attempts of an application that has expired out of the RM are gone; JobHistory keeps them."
      />
    );
  }

  const containerRows = selectContainers(containers.data ?? {});
  // `{}` is the documented empty response after the RM drops an attempt's containers. Only a terminal 404 or a
  // successfully parsed empty list means retention; malformed responses remain visible as errors below.
  const terminalMissing = containers.error instanceof ApiError && containers.error.status === 404 && isAppFinal(attempt.appAttemptState);
  const emptyTerminalList =
    !containers.error && containers.data !== undefined && containerRows.length === 0 && isAppFinal(attempt.appAttemptState);
  const containersUnavailable = terminalMissing || emptyTerminalList;

  return (
    <div className="flex min-h-0 flex-col gap-3">
      {attempts.error && (
        <ErrorState
          compact
          title="Attempt list refresh failed; showing the last loaded attempt"
          message={attempts.error instanceof Error ? attempts.error.message : String(attempts.error)}
          onRetry={() => void attempts.refetch()}
        />
      )}
      {containers.error && !containersUnavailable && (
        <ErrorState
          compact
          title="Could not refresh this attempt's container list"
          message={containers.error instanceof Error ? containers.error.message : String(containers.error)}
          onRetry={() => void containers.refetch()}
        />
      )}
      {detail.error && (
        <ErrorState
          compact
          title="Could not load the detailed attempt record"
          message={detail.error instanceof Error ? detail.error.message : String(detail.error)}
          onRetry={() => void detail.refetch()}
        />
      )}
      <AttemptDetail
        app={app.data}
        attempt={attempt}
        containers={containerRows}
        containersUnavailable={containersUnavailable}
        containersError={!!containers.error && !containersUnavailable && containerRows.length === 0}
        detail={detail.data}
        now={now}
      />
    </div>
  );
}
