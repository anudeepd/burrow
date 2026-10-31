/**
 * The Spark page frame: application header, source banner, attempt selector, live/static indicator and the page tabs.
 * Rendered once by `routes/apps/$appId/spark/route.tsx`; every Spark page is its `<Outlet/>`.
 *
 * "Spark-source banner on every spark page" is satisfied structurally: there is no Spark route that bypasses this frame.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useRouter, useSearch } from "@tanstack/react-router";
import { Activity, DatabaseZap, History, Pause, TriangleAlert } from "lucide-react";
import { type MouseEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "~/api/client";
import type { RefetchKind } from "~/api/refetch";
import { cn } from "~/lib/cn";
import { fmtEpoch } from "~/lib/format";
import { useParity } from "~/state/parity";
import { usePref } from "~/state/prefs";
import { Button } from "~/ui/button";
import { TAB_LINK_CLASS, TAB_STRIP_CLASS } from "~/ui/tabs";
import { Datum, Entity } from "~/ui/datum";
import { ErrorState, Skeleton } from "~/ui/feedback";
import { HorizontalScrollCues, useHorizontalScrollCues } from "~/ui/horizontal-scroll-cues";
import { Select } from "~/ui/select";
import { parseSparkTime } from "../data/format";
import { sp } from "../data/queries";
import type { SparkApplication, SparkAttempt, SparkSource } from "../data/schemas";
import { classifySparkError } from "./errors";
import { SparkProvider } from "./context";
import { OptionalTooltip } from "~/ui/tooltip";

export interface SparkPageDef {
  key: string;
  label: string;
  to:
    | "/apps/$appId/spark/jobs"
    | "/apps/$appId/spark/stages"
    | "/apps/$appId/spark/executors"
    | "/apps/$appId/spark/storage"
    | "/apps/$appId/spark/environment"
    | "/apps/$appId/spark/sql"
    | "/apps/$appId/spark/streaming"
    | "/apps/$appId/spark/timeline";
}

export const SPARK_PAGES: readonly SparkPageDef[] = [
  { key: "jobs", label: "Jobs", to: "/apps/$appId/spark/jobs" },
  { key: "stages", label: "Stages", to: "/apps/$appId/spark/stages" },
  { key: "executors", label: "Executors", to: "/apps/$appId/spark/executors" },
  { key: "storage", label: "Storage", to: "/apps/$appId/spark/storage" },
  { key: "environment", label: "Environment", to: "/apps/$appId/spark/environment" },
  { key: "sql", label: "SQL", to: "/apps/$appId/spark/sql" },
  { key: "streaming", label: "Streaming", to: "/apps/$appId/spark/streaming" },
  { key: "timeline", label: "Timeline", to: "/apps/$appId/spark/timeline" },
] as const;

/** Attempt selector value: Spark's `attemptId` when present, else the attempt's index. */
export function attemptValue(a: SparkAttempt, index: number): string {
  return a.attemptId ?? String(index);
}

export function SparkShell({ appId, children }: { appId: string; children: ReactNode }) {
  const location = useLocation();
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const attempt = typeof rawSearch.attempt === "string" ? rawSearch.attempt : rawSearch.attempt != null ? String(rawSearch.attempt) : null;
  const sourceQ = useQuery(sp.source(appId, attempt));
  const previewKind: RefetchKind = "live";
  const appQ = useQuery(sp.application(appId, sourceQ.data?.mode === "history" ? "static" : previewKind));

  const source: SparkSource | null = sourceQ.data ?? null;
  const application: SparkApplication | null = appQ.data ?? null;

  const sourceMissingBackend = sourceQ.error instanceof ApiError && sourceQ.error.status === 404;
  const kind: RefetchKind =
    source?.mode === "live-proxy"
      ? "live"
      : source && (source.mode === "history" || source.mode === "none")
        ? "static"
        : sourceMissingBackend
          ? "static"
          : "live";

  const attempts = application?.attempts ?? [];

  const value = useMemo(
    () => ({
      appId,
      kind,
      sparkAppId: source?.sparkAppId ?? appId,
      attempt,
      source,
      application,
      resolving: sourceQ.isPending || appQ.isPending,
    }),
    [appId, kind, source, attempt, application, sourceQ.isPending, appQ.isPending],
  );

  return (
    <SparkProvider value={value}>
      <div className="flex flex-col">
        <SparkHeader
          appId={appId}
          application={application}
          source={source}
          sourceError={sourceQ.error}
          onRetrySource={() => void sourceQ.refetch()}
          applicationError={appQ.error}
          onRetryApplication={() => void appQ.refetch()}
          attempts={attempts}
          attempt={attempt}
          kind={kind}
          loading={sourceQ.isPending && appQ.isPending}
        />
        <SparkNav appId={appId} attempt={attempt} kind={kind} />
        <div key={location.pathname} className="burrow-enter flex flex-col gap-4 py-4">
          {children}
        </div>
      </div>
    </SparkProvider>
  );
}

function SparkHeader({
  appId,
  application,
  source,
  sourceError,
  onRetrySource,
  applicationError,
  onRetryApplication,
  attempts,
  attempt,
  kind,
  loading,
}: {
  appId: string;
  application: SparkApplication | null;
  source: SparkSource | null;
  sourceError: unknown;
  onRetrySource: () => void;
  applicationError: unknown;
  onRetryApplication: () => void;
  attempts: SparkAttempt[];
  attempt: string | null;
  kind: RefetchKind;
  loading: boolean;
}) {
  const router = useRouter();
  const location = useLocation();
  const tz = usePref("tz");
  const first = attempts[0];
  const sourceAttempt = source?.attempt ?? null;
  const hasAttempt = (value: string | null) => value != null && attempts.some((a, i) => attemptValue(a, i) === value);
  const selectedAttempt = hasAttempt(attempt) ? attempt : hasAttempt(sourceAttempt) ? sourceAttempt : first ? attemptValue(first, 0) : null;
  const selected = attempts.find((a, i) => attemptValue(a, i) === selectedAttempt) ?? first;

  const setAttempt = (v: string | null) => {
    const url = new URL(location.href, "http://x");
    if (v) url.searchParams.set("attempt", v);
    else url.searchParams.delete("attempt");
    router.history.push(`${url.pathname}${url.search}`);
  };

  return (
    <header className="flex flex-col gap-3 border-b border-seam pt-3 pb-4">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-lead font-semibold text-ink">
              {application ? (
                <Datum field="spark.app.name" raw={application.name} />
              ) : (
                <span className="text-ink-3">{loading ? "Loading Spark application…" : "Spark application"}</span>
              )}
            </h1>
            <OptionalTooltip label={"Spark tracking UI, served natively by Burrow"}>
              <span className="burrow-pill inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-caption leading-none whitespace-nowrap">
                <DatabaseZap className="size-3" aria-hidden="true" />
                Spark
              </span>
            </OptionalTooltip>
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-small text-ink-3">
            {/* the route's YARN application id is the same string Spark reports as its own app id, so it is rendered
                once: by the parity datum below when the application has loaded, alone while it has not */}
            {!application && <span className="font-mono text-micro">{appId}</span>}
            {application && (
              <Entity id={appId} as="span" className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                <span className="whitespace-nowrap">
                  <Datum field="spark.app.id" raw={application.id} className="font-mono text-micro" />
                </span>
                {selected?.appSparkVersion && (
                  <span className="whitespace-nowrap">
                    Spark <Datum field="spark.app.attempts.appSparkVersion" raw={selected.appSparkVersion} />
                  </span>
                )}
                {selected?.sparkUser && (
                  <span className="whitespace-nowrap">
                    user <Datum field="spark.app.attempts.sparkUser" raw={selected.sparkUser} />
                  </span>
                )}
                <span className="whitespace-nowrap">
                  <Datum field="spark.app.attempts.startTime" raw={selected?.startTime} fmt="text">
                    {fmtEpoch(parseSparkTime(selected?.startTime), tz)}
                  </Datum>
                </span>
              </Entity>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RunModeChip kind={kind} />
          {attempts.length > 1 && (
            <Select
              label="Application attempt"
              value={selectedAttempt ?? ""}
              onValueChange={setAttempt}
              options={attempts.map((a, i) => ({
                value: attemptValue(a, i),
                label: `Attempt ${attemptValue(a, i)} · ${fmtEpoch(parseSparkTime(a.startTime), tz)}`,
              }))}
            />
          )}
        </div>
      </div>
      <SourceBanner source={source} error={sourceError} onRetry={onRetrySource} />
      {Boolean(applicationError) && (
        <ErrorState
          compact
          title={
            application ? "Spark application refresh failed; showing the last loaded details" : "Could not load Spark application details"
          }
          message={applicationError instanceof Error ? applicationError.message : String(applicationError)}
          onRetry={onRetryApplication}
        />
      )}
    </header>
  );
}

function RunModeChip({ kind }: { kind: RefetchKind }) {
  const parity = useParity();
  const paused = usePref("livePaused");
  const interval = usePref("liveIntervalMs");
  if (parity)
    return (
      <span className="burrow-pill burrow-tone-idle inline-flex h-5 shrink-0 items-center rounded-full px-2 text-caption leading-none whitespace-nowrap">
        Parity snapshot
      </span>
    );
  if (kind !== "live") {
    return (
      <OptionalTooltip label={"History-server data is immutable; Burrow fetches it once"}>
        <span className="burrow-pill burrow-tone-idle inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-caption leading-none whitespace-nowrap">
          <History className="size-3" aria-hidden="true" />
          History
        </span>
      </OptionalTooltip>
    );
  }
  return (
    <OptionalTooltip label={paused ? "Live updates are paused in preferences" : `Polling every ${interval / 1000}s`}>
      <span
        className={cn(
          "burrow-pill inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-caption leading-none whitespace-nowrap",
          paused ? "burrow-tone-warn" : "burrow-tone-live",
        )}
      >
        {paused ? <Pause className="size-3" aria-hidden="true" /> : <Activity className="size-3" aria-hidden="true" />}
        {paused ? "Live paused" : "Live"}
      </span>
    </OptionalTooltip>
  );
}

function SourceBanner({ source, error, onRetry }: { source: SparkSource | null; error: unknown; onRetry: () => void }) {
  if (error) {
    const f = classifySparkError(error, "the Spark REST source");
    const missing = f.kind === "backend-missing";
    return (
      <div
        role="status"
        data-burrow-source="unavailable"
        className="flex flex-wrap items-center gap-2 rounded-md border border-seam bg-fabric-2 px-3 py-2 text-small text-ink-2"
      >
        <TriangleAlert className="size-3.5 shrink-0 text-(--tone) burrow-tone-warn" aria-hidden="true" />
        <OptionalTooltip label={missing ? f.message : undefined}>
          <span className="font-medium">{missing ? "No Spark routes in this backend build" : "Spark source check failed"}</span>
        </OptionalTooltip>
        <Button variant="quiet" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  }
  if (!source) {
    return (
      <div role="status" aria-label="Resolving the Spark REST source">
        <Skeleton className="h-6 w-64 rounded-md" />
      </div>
    );
  }
  const tone = !source.available || source.mode === "none" ? "warn" : "ok";
  const label = source.mode === "live-proxy" ? "Live driver web proxy" : source.mode === "history" ? "Spark History Server" : "No source";
  return (
    <div
      role="status"
      data-burrow-source={source.mode}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-seam bg-fabric-2 px-3 py-2 text-small text-ink-2"
    >
      <span
        className={cn(
          "burrow-pill inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-caption leading-none whitespace-nowrap",
          tone === "warn" ? "burrow-tone-warn" : "burrow-tone-ok",
        )}
      >
        {tone === "warn" ? <TriangleAlert className="size-3" aria-hidden="true" /> : <History className="size-3" aria-hidden="true" />}
        {label}
      </span>
      {source.baseUrl && (
        <OptionalTooltip label={"Resolved Spark REST base"}>
          <span className="min-w-0 max-w-full break-all font-mono text-micro text-ink-3">{source.baseUrl}</span>
        </OptionalTooltip>
      )}
    </div>
  );
}

function SparkNav({ appId, attempt, kind }: { appId: string; attempt: string | null; kind: RefetchKind }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const location = useLocation();
  const navRef = useRef<HTMLElement>(null);
  const cues = useHorizontalScrollCues(navRef, true, SPARK_PAGES);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const navigationToken = useRef(0);

  useEffect(() => {
    navigationToken.current += 1;
    setPendingKey(null);
  }, [location.pathname, location.search]);

  useEffect(() => {
    // TanStack restores scroll positions after route commit. Reveal the active tab on the next frame so its restoration
    // cannot put the strip back at the previous page's horizontal offset.
    const frame = window.requestAnimationFrame(() => {
      const nav = navRef.current;
      const activeTab = nav?.querySelector<HTMLElement>('[aria-current="page"]');
      if (!nav || !activeTab) return;

      const navBounds = nav.getBoundingClientRect();
      const tabBounds = activeTab.getBoundingClientRect();
      const tabLeft = tabBounds.left - navBounds.left + nav.scrollLeft;
      const tabRight = tabBounds.right - navBounds.left + nav.scrollLeft;
      const visibleLeft = nav.scrollLeft;
      const visibleRight = visibleLeft + nav.clientWidth;
      if (tabLeft < visibleLeft) nav.scrollLeft = Math.max(0, tabLeft);
      else if (tabRight > visibleRight) nav.scrollLeft = tabRight - nav.clientWidth;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [location.pathname]);

  useEffect(
    () => () => {
      navigationToken.current += 1;
    },
    [],
  );

  const handleClick = (page: SparkPageDef, event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const targetPath = page.to.replace("$appId", encodeURIComponent(appId));
    const token = ++navigationToken.current;
    if (location.pathname === targetPath) {
      setPendingKey(null);
      return;
    }

    const missing = sparkPagePrefetches(page.key, appId, kind, attempt, queryClient).filter(
      ({ queryKey }) => queryClient.getQueryData(queryKey) === undefined,
    );
    if (missing.length === 0) {
      setPendingKey(null);
      return;
    }

    event.preventDefault();
    setPendingKey(page.key);
    void Promise.allSettled(missing.map(({ prefetch }) => prefetch())).finally(() => {
      if (navigationToken.current !== token) return;
      setPendingKey(null);
      void router.navigate({ to: page.to, params: { appId }, search: { attempt: attempt ?? undefined } });
    });
  };

  return (
    <div className="relative min-w-0">
      <nav ref={navRef} aria-label="Spark pages" onScroll={cues.onScroll} className={TAB_STRIP_CLASS}>
        {SPARK_PAGES.map((p) => {
          const targetPath = p.to.replace("$appId", encodeURIComponent(appId));
          const isCurrent = location.pathname === targetPath || location.pathname.startsWith(`${targetPath}/`);
          return (
            <Link
              key={p.key}
              to={p.to}
              params={{ appId }}
              search={{ attempt: attempt ?? undefined }}
              activeOptions={{ exact: false }}
              aria-busy={pendingKey === p.key || undefined}
              onClick={(event) => handleClick(p, event)}
              className={TAB_LINK_CLASS}
              activeProps={{ "aria-current": "page" as const }}
            >
              {p.label}
              {isCurrent && <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-live" />}
              {pendingKey === p.key && <span className="ml-1.5 size-1.5 shrink-0 rounded-full bg-live/70" aria-hidden="true" />}
            </Link>
          );
        })}
      </nav>
      <HorizontalScrollCues left={cues.left} right={cues.right} />
    </div>
  );
}

function sparkPagePrefetches(
  page: SparkPageDef["key"],
  appId: string,
  kind: RefetchKind,
  attempt: string | null,
  queryClient: ReturnType<typeof useQueryClient>,
) {
  const requests: Array<{ queryKey: readonly unknown[]; prefetch: () => Promise<unknown> }> = [];
  const add = (options: { queryKey: readonly unknown[] }, prefetch: () => Promise<unknown>) => {
    requests.push({ queryKey: options.queryKey, prefetch });
  };

  switch (page) {
    case "jobs": {
      const options = sp.jobs(appId, { kind, attempt });
      add(options, () => queryClient.prefetchQuery(options));
      break;
    }
    case "stages": {
      const options = sp.stages(appId, { kind, attempt });
      add(options, () => queryClient.prefetchQuery(options));
      break;
    }
    case "executors": {
      const options = sp.executors(appId, kind, attempt);
      add(options, () => queryClient.prefetchQuery(options));
      break;
    }
    case "storage":
      {
        const options = sp.rdds(appId, kind, attempt);
        add(options, () => queryClient.prefetchQuery(options));
      }
      break;
    case "environment":
      {
        const options = sp.environment(appId, attempt);
        add(options, () => queryClient.prefetchQuery(options));
      }
      break;
    case "sql":
      {
        const options = sp.sql(appId, { kind, attempt });
        add(options, () => queryClient.prefetchQuery(options));
      }
      break;
    case "streaming":
      {
        const options = { ...sp.streamingStatistics(appId, kind, attempt), retry: false };
        add(options, () => queryClient.prefetchQuery(options));
      }
      break;
    case "timeline": {
      const jobs = sp.jobs(appId, { kind, attempt });
      const stages = sp.stages(appId, { kind, attempt });
      const executors = sp.executors(appId, kind, attempt);
      const allExecutors = sp.allExecutors(appId, "static", attempt);
      add(jobs, () => queryClient.prefetchQuery(jobs));
      add(stages, () => queryClient.prefetchQuery(stages));
      add(executors, () => queryClient.prefetchQuery(executors));
      add(allExecutors, () => queryClient.prefetchQuery(allExecutors));
      break;
    }
  }
  return requests;
}
