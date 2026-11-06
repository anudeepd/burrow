/**
 * Application overview tab (`/apps/$appId`).
 */
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { q } from "~/api/queries";
import { selectAppAttempts } from "~/api/schemas";
import { isAppFinal } from "~/features/app/model";
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

  // The /apps/$appId layout renders this route only after the same app query has a payload.
  return (
    <OverviewTab
      app={app.data!}
      attempts={attemptList}
      attemptsLoading={attempts.isPending}
      attemptTrackingUrl={currentAttempt.data?.trackingUrl}
    />
  );
}
