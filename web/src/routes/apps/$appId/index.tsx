/**
 * Application overview tab (`/apps/$appId`).
 */
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { q } from "~/api/queries";
import { selectAppAttempts } from "~/api/schemas";
import { isAppFinal } from "~/features/app/model";
import { ErrorState, Skeleton } from "~/ui/feedback";
import { OverviewTab } from "~/features/app/components/OverviewTab";

export const Route = createFileRoute("/apps/$appId/")({ component: AppOverview });

function AppOverview() {
  const { appId } = Route.useParams();
  const app = useQuery(q.app(appId));
  const attempts = useQuery(q.appAttempts(appId));
  const attemptList = selectAppAttempts(attempts.data ?? {});
  const current = attemptList.reduce<(typeof attemptList)[number] | undefined>((a, b) => (a == null || b.id > a.id ? b : a), undefined);
  // The RM withholds `trackingUrl` of an ACCEPTED app; the legacy page still labels it from the current attempt's URL.
  const needsAttemptTracking = !!app.data && !app.data.trackingUrl && !isAppFinal(app.data.state) && current != null;
  const currentAttempt = useQuery({ ...q.appAttemptDetail(appId, current?.appAttemptId ?? ""), enabled: needsAttemptTracking });

  if (app.isPending) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (!app.data) {
    return (
      <ErrorState
        title="Application overview unavailable"
        message={app.error instanceof Error ? app.error.message : "The RM returned no application payload."}
        onRetry={() => void app.refetch()}
      />
    );
  }

  return <OverviewTab app={app.data} attempts={attemptList} attemptTrackingUrl={currentAttempt.data?.trackingUrl} />;
}
