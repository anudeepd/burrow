/**
 * Container detail route (`/apps/$appId/containers/$containerId`) — the legacy `/cluster/container/{id}` page.
 *
 * The container id encodes its attempt, so the attempt id (needed by the RM's REST path) is recovered from it exactly
 * the way the RM does; `?attempt=` overrides that when the caller knows better.
 */
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ApiError } from "~/api/client";
import { q } from "~/api/queries";
import { selectContainer } from "~/api/schemas";
import { ErrorState, Skeleton, StaleErrorBanner } from "~/ui/feedback";
import { ContainerDetail } from "~/features/app/components/ContainerDetail";
import { attemptIdFromContainerId } from "~/features/app/model";
import { containerSearchSchema, parseSearch } from "~/features/app/search";
import { useNow } from "~/features/app/use-now";

export const Route = createFileRoute("/apps/$appId/containers/$containerId")({
  validateSearch: (search: Record<string, unknown>) => parseSearch(containerSearchSchema, search),
  component: ContainerRoute,
});

function ContainerRoute() {
  const { appId, containerId } = Route.useParams();
  const search = Route.useSearch();
  const attemptId = search.attempt ?? attemptIdFromContainerId(containerId);
  const container = useQuery({ ...q.appContainer(appId, attemptId ?? "", containerId), enabled: attemptId != null });
  const now = useNow(container.data?.container.finishedTime === 0);

  if (!attemptId) {
    return (
      <ErrorState
        title="Unrecognised container id"
        message={`"${containerId}" does not match the RM's container_<clusterTs>_<appNum>_<attempt>_<container> grammar.`}
        hint="Pass the attempt explicitly with ?attempt=appattempt_… if you have it."
      />
    );
  }

  if (container.isPending) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!container.data) {
    const err = container.error;
    const gone = err instanceof ApiError && err.status === 404;
    return (
      <div className="flex min-w-0 flex-col gap-3">
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-small text-ink-4">
          <span>Application</span>
          <Link to="/apps/$appId" params={{ appId }} className="break-all font-mono text-live underline-offset-2 hover:underline">
            {appId}
          </Link>
          <span aria-hidden="true">·</span>
          <span>attempt</span>
          <Link
            to="/apps/$appId/attempts/$attemptId"
            params={{ appId, attemptId }}
            className="break-all font-mono text-live underline-offset-2 hover:underline"
          >
            {attemptId}
          </Link>
        </p>
        <ErrorState
          title={gone ? "Container details are no longer available" : "Could not load the container"}
          message={
            gone
              ? "The ResourceManager removes container records when an attempt finishes."
              : "The ResourceManager did not return this container."
          }
          detail={!gone && err instanceof Error ? err.message : undefined}
          hint={
            gone ? "Open the attempt to review its remaining details and aggregated logs." : "Check the connection and retry the request."
          }
          onRetry={gone ? undefined : () => void container.refetch()}
          className="w-full max-w-none rounded-lg border border-seam bg-fabric"
        />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {container.error && (
        <StaleErrorBanner
          title="Container refresh failed; showing the last loaded details"
          error={container.error}
          onRetry={() => void container.refetch()}
        />
      )}
      <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-small text-ink-4">
        Application{" "}
        <Link to="/apps/$appId" params={{ appId }} className="break-all font-mono text-live underline-offset-2 hover:underline">
          {appId}
        </Link>{" "}
        · attempt{" "}
        <Link
          to="/apps/$appId/attempts/$attemptId"
          params={{ appId, attemptId }}
          className="break-all font-mono text-live underline-offset-2 hover:underline"
        >
          {attemptId}
        </Link>
      </p>
      <ContainerDetail appId={appId} container={selectContainer(container.data)} attemptId={attemptId} now={now} />
    </div>
  );
}
