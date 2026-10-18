/**
 * Timeline — the application over wall-clock time: executors, jobs and stages as Gantt rows.
 *
 * Data: `/jobs`, `/stages`, `/executors` and `/allexecutors` (merged by executor id; the live `/executors` entry wins
 * because it carries the current `isActive`). The visible window lives in the URL (`?from`, `?to`, `?zoom`); zoom, pan and
 * drag-select all write it back, so a zoomed view is linkable.
 */
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useMemo } from "react";
import { fmtEpoch, fmtInt } from "~/lib/format";
import { usePref } from "~/state/prefs";
import { Button } from "~/ui/button";
import { ErrorState } from "~/ui/feedback";
import { compact, intParam } from "../data/search";
import { sp } from "../data/queries";
import type { SparkExecutor } from "../data/schemas";
import { PageHeader } from "../ui/PageHeader";
import { SparkEmpty, SparkFailureState, SparkLoading } from "../ui/StateViews";
import { buildTimelineRows, TimelineChart } from "../ui/Timeline";
import { useSpark } from "../ui/context";
import { useNow } from "../ui/use-now";

const route = getRouteApi("/apps/$appId/spark/timeline");

/** Smallest window the zoom controls will produce (ms). */
const MIN_SPAN_MS = 500;

export function TimelinePage() {
  const { appId } = route.useParams();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const { kind, attempt } = useSpark();
  const tz = usePref("tz");
  const now = useNow();
  /** A finished application has no "now": nothing is drawn to the present and no now line is shown. */
  const liveNow = kind === "live" ? now : null;

  const jobsQ = useQuery(sp.jobs(appId, { kind, attempt }));
  const stagesQ = useQuery(sp.stages(appId, { kind, attempt }));
  const executorsQ = useQuery(sp.executors(appId, kind, attempt));
  const allExecutorsQ = useQuery(sp.allExecutors(appId, kind, attempt));

  const executors = useMemo(() => {
    const m = new Map<string, SparkExecutor>();
    for (const e of allExecutorsQ.data ?? []) m.set(e.id, e);
    for (const e of executorsQ.data ?? []) m.set(e.id, e);
    return [...m.values()];
  }, [executorsQ.data, allExecutorsQ.data]);

  const rows = useMemo(
    () => buildTimelineRows({ jobs: jobsQ.data ?? [], stages: stagesQ.data ?? [], executors, now: liveNow }),
    [jobsQ.data, stagesQ.data, executors, liveNow],
  );

  const barCount = useMemo(() => rows.reduce((n, r) => n + (r.kind === "bar" ? 1 : 0), 0), [rows]);

  /** Full extent of everything on the axis, including the now line for a live application. */
  const bounds = useMemo<[number, number]>(() => {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const r of rows) {
      if (r.kind !== "bar") continue;
      for (const t of [r.start, r.end]) {
        if (t == null) continue;
        if (t < lo) lo = t;
        if (t > hi) hi = t;
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
    if (liveNow != null) hi = Math.max(hi, liveNow);
    return hi > lo ? [lo, hi] : [lo - MIN_SPAN_MS, lo + MIN_SPAN_MS];
  }, [rows, liveNow]);

  const [boundsFrom, boundsTo] = bounds;
  const viewWindow = useMemo<[number, number]>(() => {
    const from = intParam(search.from);
    const to = intParam(search.to);
    if (from != null && to != null && to > from) return [from, to];
    const z = Number(search.zoom);
    if (Number.isFinite(z) && z > 1.01) {
      const centre = (boundsFrom + boundsTo) / 2;
      const half = (boundsTo - boundsFrom) / (2 * z);
      return [centre - half, centre + half];
    }
    return [boundsFrom, boundsTo];
  }, [search.from, search.to, search.zoom, boundsFrom, boundsTo]);

  const patch = (p: Record<string, unknown>) => void navigate({ search: (prev) => compact({ ...prev, ...p }) });

  /** Clamp a requested window to the data and write it to the URL (a fit clears `from`/`to`/`zoom`). */
  const applyWindow = (from: number, to: number) => {
    const span = Math.max(MIN_SPAN_MS, boundsTo - boundsFrom);
    const nspan = Math.max(MIN_SPAN_MS, Math.min(span * 2, to - from));
    const clampedFrom = Math.max(boundsFrom - span * 0.25, Math.min(boundsTo + span * 0.25 - nspan, from));
    const zoom = span / nspan;
    if (zoom <= 1.01) {
      patch({ from: undefined, to: undefined, zoom: undefined });
      return;
    }
    patch({ from: String(Math.round(clampedFrom)), to: String(Math.round(clampedFrom + nspan)), zoom: zoom.toFixed(2) });
  };

  const timelineQueries = [
    { name: "jobs", subject: "the job list", query: jobsQ },
    { name: "stages", subject: "the stage list", query: stagesQ },
    { name: "executors", subject: "the executor list", query: executorsQ },
    { name: "all executors", subject: "all executors", query: allExecutorsQ },
  ];
  const failedQueries = timelineQueries.filter(({ query }) => query.error);
  const errored = failedQueries.length;
  const failedWithoutData = failedQueries.some(({ query }) => query.data === undefined);

  if (jobsQ.isPending || stagesQ.isPending || executorsQ.isPending || allExecutorsQ.isPending) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        <PageHeader title="Timeline" hideTitle />
        <SparkLoading rows={10} cols={5} />
      </div>
    );
  }

  if (barCount === 0 && failedWithoutData) {
    const retry = () => void Promise.all(failedQueries.map(({ query }) => query.refetch()));
    if (failedQueries.length === 1) {
      const failure = failedQueries[0]!;
      return <SparkFailureState error={failure.query.error} subject={failure.subject} onRetry={retry} />;
    }
    return (
      <ErrorState
        title={`${failedQueries.length} Spark timeline sources could not be loaded`}
        message={failedQueries
          .map(({ name, query }) => `${name}: ${query.error instanceof Error ? query.error.message : String(query.error)}`)
          .join(" · ")}
        hint="No timeline data was returned. Retry all failed sources; available data appears as each source recovers."
        onRetry={retry}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {errored > 0 && (barCount > 0 || !failedWithoutData) && (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed border-seam-strong bg-well px-2.5 py-1.5 text-small text-ink-3"
          role="status"
        >
          <span>
            {errored} of four timeline sources failed. Showing available data; errors:{" "}
            {failedQueries
              .map(({ name, query }) => `${name}: ${query.error instanceof Error ? query.error.message : String(query.error)}`)
              .join("; ")}
            .
          </span>
          <Button variant="quiet" size="sm" onClick={() => void Promise.all(failedQueries.map(({ query }) => query.refetch()))}>
            Retry failed sources
          </Button>
        </div>
      )}

      <section aria-label="Timeline" className="min-w-0 overflow-hidden rounded-lg border border-seam bg-fabric">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-seam px-3 py-2.5">
          <h2 className="sr-only">Timeline</h2>
          <span className="text-small text-ink-3 tnum">{fmtInt(barCount)} rows</span>
          <span className="text-small text-ink-4">
            {barCount > 0 ? `${fmtEpoch(boundsFrom, tz)} – ${fmtEpoch(boundsTo, tz)}` : "No time range"}
          </span>
        </div>
        {barCount === 0 ? (
          <SparkEmpty title="Nothing to plot yet" />
        ) : (
          <TimelineChart
            rows={rows}
            window={viewWindow}
            tz={tz}
            now={liveNow}
            onZoom={(factor, anchor) => {
              const span = viewWindow[1] - viewWindow[0];
              const rel = span > 0 ? (anchor - viewWindow[0]) / span : 0.5;
              const nspan = span / factor;
              applyWindow(anchor - rel * nspan, anchor - rel * nspan + nspan);
            }}
            onPan={(fraction) => {
              const span = viewWindow[1] - viewWindow[0];
              applyWindow(viewWindow[0] + fraction * span, viewWindow[1] + fraction * span);
            }}
            onSelectRange={(from, to) => applyWindow(from, to)}
            onFit={() => patch({ from: undefined, to: undefined, zoom: undefined })}
            label={`Timeline of ${appId}`}
          />
        )}
      </section>
    </div>
  );
}
