/**
 * Application layout: identity header + tab shell + `<Outlet/>`.
 *
 * The tab strip uses router links because the tabs are *routes*: TanStack renders real anchors for shareability and
 * middle-click while keeping ordinary clicks inside the SPA. Base UI's `Tabs` is for in-page panels. The Spark tab is
 * contributed by the FE-Spark slice through `~/features/app/tabs` and stays disabled (with a reason) when absent.
 */
import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, createFileRoute, useRouterState, useSearch } from "@tanstack/react-router";
import { q } from "~/api/queries";
import { selectAppAttempts } from "~/api/schemas";
import { cn } from "~/lib/cn";
import { Entity } from "~/ui/datum";
import { CenteredPageState, ErrorState, Skeleton, StaleErrorBanner } from "~/ui/feedback";
import { HorizontalScrollCues, useHorizontalScrollCues } from "~/ui/horizontal-scroll-cues";
import { AppHeader } from "~/features/app/components/AppHeader";
import { isAppFinal } from "~/features/app/model";
import { activeTab, appTabs } from "~/features/app/tabs";
import { useNow } from "~/features/app/use-now";
import { HelpTip } from "~/ui/tooltip";

export const Route = createFileRoute("/apps/$appId")({ component: AppLayout });

function AppLayout() {
  const { appId } = Route.useParams();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isSparkRoute = pathname.startsWith(`/apps/${appId}/spark/`);
  const routeSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const logsViewerActive =
    pathname.replace(/\/$/, "") === `/apps/${appId}/logs` && typeof routeSearch.container === "string" && routeSearch.container.length > 0;
  const app = useQuery(q.app(appId));
  const attempts = useQuery(q.appAttempts(appId));
  const now = useNow(!!app.data && !isAppFinal(app.data.state));
  const current = activeTab(pathname, appId);
  const tabs = appTabs(appId);
  const attemptsListActive = pathname.replace(/\/$/, "") === `/apps/${appId}/attempts`;

  if (app.isPending) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-9 w-full max-w-xl" />
      </div>
    );
  }

  if (!app.data) {
    // Finished applications eventually leave the ResourceManager's in-memory index, but their Spark event log can
    // remain available from the History Server. Keep Spark routes reachable in that case; SparkShell resolves the
    // history source and renders its own application header and navigation.
    if (isSparkRoute) return <Outlet />;

    return (
      <CenteredPageState>
        <ErrorState
          title={`Could not load ${appId}`}
          message={app.error instanceof Error ? app.error.message : "The ResourceManager did not return the application."}
          hint="The application may have expired out of the RM's memory; finished applications stay queryable only while the RM retains them."
          onRetry={() => void app.refetch()}
        />
      </CenteredPageState>
    );
  }

  // Page scrollports extend through the shell gutter and the centered max-width slack, so wheel gestures beside content still scroll.
  return (
    <Entity
      id={appId}
      className={cn(
        "burrow-scroll burrow-page-scroll burrow-app-scroll flex min-h-0 flex-1 flex-col pb-6",
        logsViewerActive ? "burrow-app-scroll--logs overflow-y-auto" : "overflow-y-auto [&>*]:shrink-0",
      )}
    >
      {app.error && (
        <StaleErrorBanner
          title="Application refresh failed; showing the last loaded details"
          error={app.error}
          onRetry={() => void app.refetch()}
        />
      )}
      {!attemptsListActive &&
        attempts.error &&
        (attempts.data !== undefined ? (
          <StaleErrorBanner
            title="Attempt history refresh failed; showing the last loaded attempts"
            error={attempts.error}
            onRetry={() => void attempts.refetch()}
          />
        ) : (
          <ErrorState
            compact
            title="Application attempt history unavailable"
            message={attempts.error instanceof Error ? attempts.error.message : String(attempts.error)}
            hint="Application details remain available; retry to load attempt history."
            onRetry={() => void attempts.refetch()}
          />
        ))}
      <div className="shrink-0 pb-3">
        <AppHeader app={app.data} attempts={selectAppAttempts(attempts.data ?? {})} now={now} insideSpark={isSparkRoute} />
      </div>

      <ApplicationSectionNav tabs={tabs} current={current} />

      <div className={cn("flex flex-col pt-3", logsViewerActive && "shrink-0 burrow-app-log-layout")}>
        <Outlet />
      </div>
    </Entity>
  );
}

function ApplicationSectionNav({ tabs, current }: { tabs: ReturnType<typeof appTabs>; current: string }) {
  const listRef = useRef<HTMLUListElement>(null);
  const cues = useHorizontalScrollCues(listRef, true, tabs);
  return (
    <nav aria-label="Application sections" className="relative shrink-0 border-b border-seam">
      {/* Keep the underline inside the strip so it cannot add a vertical scroll range. */}
      <ul ref={listRef} onScroll={cues.onScroll} className="burrow-scroll burrow-scroll-hidden flex items-center gap-0.5 overflow-x-auto">
        {tabs.map((tab) => {
          const isCurrent = tab.value === current;
          const cls = cn(
            "relative inline-flex h-10 shrink-0 items-center gap-1.5 rounded-t-sm whitespace-nowrap px-4 text-body font-medium",
            isCurrent ? "bg-fabric-2 text-ink" : "text-ink-3 hover:bg-fabric-2 hover:text-ink-2",
            !tab.available && "cursor-not-allowed opacity-55",
          );
          const indicator = isCurrent && <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-live" />;
          return (
            <li key={tab.value}>
              {tab.available ? (
                <Link to={tab.href} className={cls} aria-current={isCurrent ? "page" : undefined} data-yt={tab.value}>
                  {tab.label}
                  {indicator}
                </Link>
              ) : (
                <span className={cls} aria-disabled="true" aria-current={isCurrent ? "page" : undefined} data-yt={tab.value}>
                  {tab.label}
                  <span className="rounded-full border border-dashed border-seam-strong px-1 text-micro text-ink-4">not in build</span>
                  {tab.hint && <HelpTip label={`${tab.label} tab is unavailable`}>{tab.hint}</HelpTip>}
                  {indicator}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <HorizontalScrollCues left={cues.left} right={cues.right} />
    </nav>
  );
}
