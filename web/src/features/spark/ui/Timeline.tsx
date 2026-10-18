/**
 * Application timeline (Gantt) — executors, jobs and stages over wall-clock time.
 *
 * What Spark REST can and cannot support:
 *  - jobs: `submissionTime` → `completionTime` (`/jobs`); no other job timestamps exist.
 *  - stages: `submissionTime` → `completionTime` per attempt (`/stages`), with `firstTaskLaunchedTime` as the start
 *    fallback. Spark does not report a first-launch→end bar, so the bar is submission→completion and the tooltip says so.
 *  - skipped stages: every timestamp is null, so the bar is a dashed zero-width marker placed at the submission time of the
 *    earliest job that referenced the stage (derived, labelled in the tooltip).
 *  - executors: `addTime` → `removeTime` (`/executors`, `/allexecutors`); `removeTime` is absent while an executor lives.
 *  - there is NO per-task timeline (only `launchTime` + `duration` per task in `/taskList`), no executor CPU/GC series.
 *
 * Rendering: one SVG per row with a FIXED viewBox (`0 0 VIEW_W ROW_H`, stretched to the pane) so a zoom is a re-mapping of
 * the time scale, not a re-layout; rows are windowed with `@tanstack/react-virtual`. The visual chart is decorative —
 * the accessible representation is the screen-reader table at the bottom (a Gantt is not readable otherwise).
 *
 * Parity: every bar rect carries the derived duration datum and sits inside the row's `Entity`; the screen-reader table
 * repeats start/end/duration through `Datum` so the REST values are always in the DOM.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { scaleLinear } from "d3-scale";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type StatusDomain, type Tone, statusSpec } from "~/design/status";
import { cn } from "~/lib/cn";
import { fmtClock, fmtDuration, fmtEpoch } from "~/lib/format";
import type { TzMode } from "~/lib/format";
import { useParity } from "~/state/parity";
import { Datum, Entity, datumAttrs } from "~/ui/datum";
import { StatusPill } from "~/ui/status";
import { jobDurationMs, parseSparkTime, stageDurationMs } from "../data/format";
import type { SparkExecutor, SparkJob, SparkStage } from "../data/schemas";
import { OptionalTooltip, Tooltip } from "~/ui/tooltip";

/** Fixed row height: windowing and the drag/zoom maths both need it. */
const ROW_H = 22;
const AXIS_H = 26;
const LABEL_W = 256;
/** Phone gutter: the label column keeps the chart a usable pane on a 390px viewport. */
const LABEL_W_NARROW = 132;
/** Below this the chart gets the full label gutter; above it the narrow one is used. */
const LABEL_W_QUERY = "(min-width: 768px)";
/** Fixed SVG viewBox width — zoom re-maps the time scale, it never re-lays out the SVG. */
const VIEW_W = 1000;
/** Drag shorter than this is a click, not a range selection. */
const DRAG_MIN_PX = 4;

/** Spark includes HTML links in some job descriptions; show their readable text without rendering or exposing the markup. */
function plainDescription(value: string | null | undefined): string | undefined {
  const text = value?.replace(/<\/?[a-z][^>]*>/gi, "").trim();
  return text || undefined;
}

/** Label gutter width: the full 256px from 768px up, the narrow 132px below so the chart keeps a usable pane. */
function useLabelWidth(): number {
  const [w, setW] = useState(LABEL_W);
  useEffect(() => {
    const mq = window.matchMedia(LABEL_W_QUERY);
    const apply = () => setW(mq.matches ? LABEL_W : LABEL_W_NARROW);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return w;
}

export type TimelineGroup = "executors" | "jobs" | "stages";
export interface TimelineHeader {
  kind: "header";
  key: string;
  group: TimelineGroup;
  label: string;
}

export interface TimelineBar {
  kind: "bar";
  key: string;
  group: TimelineGroup;
  /** `data-ye`: job id, `stageId/attemptId`, executor id. */
  entity: string;
  /** Visible label (carries the entity id as a `Datum`). */
  label: React.ReactNode;
  /** Plain-text name for the tooltip and the screen-reader table. */
  name: string;
  sub?: string;
  tone: Tone;
  status?: { domain?: StatusDomain; state?: string; raw: unknown; label: string; field: string };
  startRaw?: string | null;
  endRaw?: string | null;
  start: number | null;
  end: number | null;
  startField: string;
  endField: string;
  durationField: string;
  durationMs: number | null;
  /** The bar runs to the "now" line (Spark has not reported an end yet). */
  open?: boolean;
  /** Skipped stage: no timestamps in REST — a dashed zero-width marker. */
  ghost?: boolean;
  /** Honest caveat shown in the tooltip (missing timestamp, derived anchor, …). */
  note?: string;
}

export type TimelineRow = TimelineHeader | TimelineBar;

/** Nulls last, then earliest first. */
const byStart = <T extends { start: number | null }>(a: T, b: T): number =>
  (a.start ?? Number.POSITIVE_INFINITY) - (b.start ?? Number.POSITIVE_INFINITY);

/**
 * Executors + jobs + stages as Gantt rows. `now` is the clock used for bars that have no end yet (live applications);
 * pass `null` for a finished application so nothing is drawn to the present.
 */
export function buildTimelineRows({
  jobs,
  stages,
  executors,
  now,
}: {
  jobs: readonly SparkJob[];
  stages: readonly SparkStage[];
  executors: readonly SparkExecutor[];
  now: number | null;
}): TimelineRow[] {
  // Skipped stages have every timestamp null; anchor their marker on the earliest job that referenced the stage.
  const jobAnchor = new Map<number, number>();
  for (const j of jobs) {
    const t = parseSparkTime(j.submissionTime);
    if (t == null) continue;
    for (const id of j.stageIds) {
      const prev = jobAnchor.get(id);
      if (prev == null || t < prev) jobAnchor.set(id, t);
    }
  }

  const executorRows: TimelineBar[] = executors.map((e): TimelineBar => {
    const start = parseSparkTime(e.addTime);
    const removed = parseSparkTime(e.removeTime);
    // Only an explicit `isActive: true` without a `removeTime` is "still running"; anything else must not be drawn to now.
    const open = removed == null && e.isActive === true;
    const end = removed ?? (open ? now : null);
    return {
      kind: "bar",
      key: `executor:${e.id}`,
      group: "executors",
      entity: e.id,
      label: <Datum field="spark.executor.id" raw={e.id} className="truncate" />,
      name: e.id,
      sub: e.hostPort ?? undefined,
      tone: e.isActive === false ? "idle" : e.isActive === true ? "live" : "wait",
      status: {
        domain: "spark.executor",
        state: e.isActive == null ? "UNKNOWN" : e.isActive ? "ACTIVE" : "INACTIVE",
        raw: e.isActive,
        label: e.isActive === false ? "dead" : e.isActive === true ? "active" : "not reported",
        field: "spark.executor.isActive",
      },
      startRaw: e.addTime,
      endRaw: e.removeTime,
      start,
      end,
      startField: "spark.executor.addTime",
      endField: "spark.executor.removeTime",
      durationField: "spark.executor.derived.lifetimeMs",
      durationMs: start != null && end != null ? Math.max(0, end - start) : null,
      open,
      note:
        start == null
          ? "Spark reported no addTime for this executor."
          : removed == null && !open
            ? "Spark reported no removeTime for this executor, so it has no end on the axis."
            : undefined,
    };
  });

  const jobRows: TimelineBar[] = jobs.map((j): TimelineBar => {
    const start = parseSparkTime(j.submissionTime);
    const completed = parseSparkTime(j.completionTime);
    const open = completed == null && j.status === "RUNNING";
    const end = completed ?? (open ? now : null);
    return {
      kind: "bar",
      key: `job:${j.jobId}`,
      group: "jobs",
      entity: String(j.jobId),
      label: (
        <span className="truncate">
          Job <Datum field="spark.job.jobId" raw={j.jobId} fmt="id" />
        </span>
      ),
      name: `Job ${j.jobId}`,
      sub: plainDescription(j.description) ?? j.name ?? undefined,
      tone: statusSpec("spark.job", j.status).tone,
      status: { domain: "spark.job", raw: j.status, label: j.status ?? "unknown", field: "spark.job.status" },
      startRaw: j.submissionTime,
      endRaw: j.completionTime,
      start,
      end,
      startField: "spark.job.submissionTime",
      endField: "spark.job.completionTime",
      durationField: "spark.job.derived.durationMs",
      durationMs: jobDurationMs(j, now ?? Date.now()),
      open,
      note:
        start == null
          ? "Spark reported no submissionTime for this job."
          : completed == null && !open
            ? "Spark reported no completionTime for this job."
            : undefined,
    };
  });

  const stageRows: TimelineBar[] = stages.map((s): TimelineBar => {
    const submission = parseSparkTime(s.submissionTime);
    const launched = parseSparkTime(s.firstTaskLaunchedTime);
    const completed = parseSparkTime(s.completionTime);
    const skipped = s.status === "SKIPPED";
    const open = !skipped && completed == null && s.status === "ACTIVE";
    const start = skipped ? (jobAnchor.get(s.stageId) ?? null) : (submission ?? launched);
    const end = skipped ? start : (completed ?? (open ? now : null));
    return {
      kind: "bar",
      key: `stage:${s.stageId}/${s.attemptId ?? 0}`,
      group: "stages",
      entity: `${s.stageId}/${s.attemptId ?? 0}`,
      label: (
        <span className="truncate">
          Stage <Datum field="spark.stage.stageId" raw={s.stageId} fmt="id" />
          {s.attemptId != null && s.attemptId > 0 && (
            <>
              {" "}
              · attempt <Datum field="spark.stage.attemptId" raw={s.attemptId} fmt="id" />
            </>
          )}
        </span>
      ),
      name: `Stage ${s.stageId}${s.attemptId != null && s.attemptId > 0 ? ` attempt ${s.attemptId}` : ""}`,
      sub: s.name ?? s.description ?? undefined,
      tone: statusSpec("spark.stage", s.status).tone,
      status: { domain: "spark.stage", raw: s.status, label: s.status ?? "unknown", field: "spark.stage.status" },
      startRaw: s.submissionTime,
      endRaw: s.completionTime,
      start,
      end,
      startField: "spark.stage.submissionTime",
      endField: "spark.stage.completionTime",
      durationField: "spark.stage.derived.durationMs",
      durationMs: skipped ? null : stageDurationMs(s, now ?? Date.now()),
      open,
      ghost: skipped,
      note: skipped
        ? start != null
          ? "Skipped: Spark reports no timestamps for a skipped stage, so this marker sits at the submission time of the job that referenced it (derived)."
          : "Skipped: Spark reports no timestamps for a skipped stage and no job referenced it, so it has no place on the axis."
        : submission == null && launched != null
          ? "Spark reported no submissionTime; the bar starts at firstTaskLaunchedTime."
          : completed == null && !open
            ? "Spark reported no completionTime for this stage."
            : undefined,
    };
  });

  const sortedExecutors = executorRows.sort(byStart);
  const sortedJobs = jobRows.sort(byStart);
  const sortedStages = stageRows.sort(byStart);

  return [
    { kind: "header", key: "header:executors", group: "executors", label: `Executors (${sortedExecutors.length})` },
    ...sortedExecutors,
    { kind: "header", key: "header:jobs", group: "jobs", label: `Jobs (${sortedJobs.length})` },
    ...sortedJobs,
    { kind: "header", key: "header:stages", group: "stages", label: `Stages (${sortedStages.length})` },
    ...sortedStages,
  ];
}

export interface TimelineChartProps {
  rows: readonly TimelineRow[];
  /** Optional compatibility metadata; the current view is derived from `window`. */
  bounds?: readonly [number, number];
  /** Optional compatibility metadata; the current view is derived from `window`. */
  zoom?: number;
  /** Visible window (from the URL, or the full data extent when the URL has none). */
  window: readonly [number, number];
  tz: TzMode;
  /** "Now" line; pass null for a finished application. */
  now?: number | null;
  height?: number;
  /** Zoom by `factor` (>1 in) keeping `anchorMs` under the pointer/centre. */
  onZoom: (factor: number, anchorMs: number) => void;
  /** Pan by a fraction of the visible span (negative = earlier). */
  onPan: (fraction: number) => void;
  /** Drag-selected range. */
  onSelectRange: (from: number, to: number) => void;
  onFit: () => void;
  label: string;
}

export function TimelineChart({
  rows,
  window,
  tz,
  now = null,
  height = 420,
  onZoom,
  onPan,
  onSelectRange,
  onFit,
  label,
}: TimelineChartProps) {
  const parity = useParity();
  const labelW = useLabelWidth();
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const figureRef = useRef<HTMLDivElement>(null);
  const axisRef = useRef<HTMLDivElement>(null);
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);

  const [w0, w1] = window;
  const x = useMemo(
    () =>
      scaleLinear()
        .domain([w0, w1 === w0 ? w0 + 1 : w1])
        .range([0, VIEW_W]),
    [w0, w1],
  );
  // The phone pane is ~200px wide: six labels would overlap, so the narrow gutter drops to three.
  const ticks = useMemo(() => x.ticks(labelW === LABEL_W_NARROW ? 3 : 6), [x, labelW]);

  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
    enabled: !parity,
    scrollMargin: AXIS_H,
  });

  const items: { index: number; start: number | null }[] = parity
    ? rows.map((_, i) => ({ index: i, start: null }))
    : virt.getVirtualItems().map((v) => ({ index: v.index, start: v.start }));

  const legend = useMemo(() => {
    const m = new Map<string, { tone: Tone; label: string; count: number }>();
    for (const r of rows) {
      if (r.kind !== "bar") continue;
      const key = `${r.group}:${r.status?.label ?? r.tone}`;
      const hit = m.get(key);
      if (hit) hit.count += 1;
      else m.set(key, { tone: r.tone, label: `${r.status?.label ?? r.tone} ${r.group}`, count: 1 });
    }
    return [...m.values()];
  }, [rows]);

  /** Pane geometry of the chart cell (everything right of the label gutter), measured at use time. */
  const chartGeom = useCallback(() => {
    const el = listRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const w = r.width - labelW;
    return w > 0 ? { left: r.left + labelW, w } : null;
  }, [labelW]);

  const pctOf = (t: number): number => Math.max(0, Math.min(100, (x(t) / VIEW_W) * 100));
  const centre = (): number => (w0 + w1) / 2;
  const nowVisible = now != null && now >= w0 && now <= w1;

  // Ctrl/⌘ anywhere in the chart, or a plain wheel over the axis strip, zooms at the pointer; Shift + wheel pans.
  // A plain wheel over the rows keeps scrolling the row list (the default action).
  const wheelRef = useRef({ onZoom, onPan, x, window, chartGeom });
  useEffect(() => {
    wheelRef.current = { onZoom, onPan, x, window, chartGeom };
  });
  useEffect(() => {
    const el = figureRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const h = wheelRef.current;
      const g = h.chartGeom();
      const overAxis = axisRef.current?.contains(e.target as Node) ?? false;
      if (e.ctrlKey || e.metaKey || overAxis) {
        e.preventDefault();
        const [a, b] = h.window;
        const anchor = g && e.clientX >= g.left ? h.x.invert(Math.max(0, Math.min(1, (e.clientX - g.left) / g.w)) * VIEW_W) : (a + b) / 2;
        h.onZoom(e.deltaY < 0 ? 1.25 : 0.8, anchor);
        return;
      }
      if (e.shiftKey) {
        e.preventDefault();
        h.onPan(e.deltaY > 0 ? 0.1 : -0.1);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = chartGeom();
    if (!g) return;
    const px = e.clientX - g.left;
    if (px < 0 || px > g.w) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ a: px, b: px });
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const g = chartGeom();
    if (!g) return;
    setDrag({ a: drag.a, b: Math.max(0, Math.min(g.w, e.clientX - g.left)) });
  };
  const endDrag = () => {
    const g = chartGeom();
    const d = drag;
    setDrag(null);
    if (!g || !d || Math.abs(d.b - d.a) < DRAG_MIN_PX) return;
    const t = (px: number) => x.invert((px / g.w) * VIEW_W);
    const t0 = t(Math.min(d.a, d.b));
    const t1 = t(Math.max(d.a, d.b));
    onSelectRange(t0, t1);
  };

  const active = activeIdx != null ? rows[activeIdx] : undefined;
  const activeBar = active?.kind === "bar" ? active : undefined;
  const firstVisible = items[0]?.index ?? 0;
  const lastVisible = items[items.length - 1]?.index ?? 0;

  const describe = (r: TimelineBar): string =>
    [
      `${r.group.replace(/s$/, "")} ${r.name}`,
      r.status ? r.status.label : null,
      r.start != null ? `from ${fmtEpoch(r.start, tz)}` : "no start",
      r.end != null ? `to ${fmtEpoch(r.end, tz)}` : "no end",
      r.durationMs != null ? `duration ${fmtDuration(r.durationMs)}` : null,
    ]
      .filter(Boolean)
      .join(", ");

  return (
    <div className="flex min-w-0 shrink-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-seam p-3">
        <ul
          className="flex min-w-0 basis-full flex-wrap items-center gap-x-3 gap-y-1 text-micro text-ink-3 md:flex-1 md:basis-auto"
          aria-label="Timeline legend"
        >
          {legend.map((l) => (
            <li key={l.label} className="flex items-center gap-1.5">
              <span aria-hidden="true" className={cn("size-2 rounded-sm bg-(--tone)", `burrow-tone-${l.tone}`)} />
              <span className="capitalize">{l.label}</span>
              <span className="tnum text-ink-4">{l.count}</span>
            </li>
          ))}
        </ul>
        <div className="ml-auto flex items-center gap-1.5">
          <Tooltip label="Zoom out around the center of the timeline">
            <button
              type="button"
              onClick={() => onZoom(0.5, centre())}
              aria-label="Zoom out"
              className="burrow-touch-target h-(--ctl-h) w-7 rounded-md border border-seam-strong bg-fabric-2 text-body text-ink-2 hover:bg-fabric-3"
            >
              −
            </button>
          </Tooltip>
          <Tooltip label="Zoom in around the center of the timeline">
            <button
              type="button"
              onClick={() => onZoom(2, centre())}
              aria-label="Zoom in"
              className="burrow-touch-target h-(--ctl-h) w-7 rounded-md border border-seam-strong bg-fabric-2 text-body text-ink-2 hover:bg-fabric-3"
            >
              +
            </button>
          </Tooltip>
          <Tooltip label="Fit all jobs, stages and executors into the timeline window">
            <button
              type="button"
              onClick={onFit}
              className="burrow-touch-target min-h-11 min-w-11 rounded-md border border-seam-strong bg-fabric-2 px-2 text-small text-ink-2 hover:bg-fabric-3 sm:min-h-0 sm:min-w-0"
            >
              Fit
            </button>
          </Tooltip>
        </div>
      </div>

      <div
        ref={figureRef}
        aria-hidden="true"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={() => setDrag(null)}
        className="flex min-w-0 shrink-0 flex-col overflow-hidden bg-fabric select-none"
      >
        <div ref={scrollRef} aria-hidden="true" className="burrow-scroll relative min-h-0 shrink-0 overflow-auto" style={{ height }}>
          {/* sticky time axis — inside the scroller so its ticks share the rows' exact width */}
          <div className="sticky top-0 z-rail flex border-b border-seam-soft bg-fabric" style={{ height: AXIS_H }}>
            <div className="flex shrink-0 items-center border-r border-seam-soft px-2 text-micro text-ink-3" style={{ width: labelW }}>
              Time ({tz === "utc" ? "UTC" : "local"})
            </div>
            <div ref={axisRef} className="relative min-w-0 flex-1">
              {ticks.map((t) => (
                <span
                  key={t}
                  className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 text-micro whitespace-nowrap text-ink-4 tnum"
                  style={{ left: `${pctOf(t)}%` }}
                >
                  {fmtClock(t, tz)}
                </span>
              ))}
              {nowVisible && (
                <span aria-hidden="true" className="absolute top-0 bottom-0 w-px bg-(--live)" style={{ left: `${pctOf(now ?? w0)}%` }} />
              )}
            </div>
          </div>

          <div ref={listRef} className="relative" style={{ height: parity ? undefined : virt.getTotalSize() }}>
            {drag && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute top-0 bottom-0 z-sticky bg-(--live) opacity-15"
                style={{ left: `calc(${labelW}px + ${Math.min(drag.a, drag.b)}px)`, width: Math.abs(drag.b - drag.a) }}
              />
            )}
            {items.map(({ index, start }) => {
              const row = rows[index];
              if (!row) return null;
              const isActive = index === activeIdx;
              const placeAbove = index > (firstVisible + lastVisible) / 2;
              const barPct = row.kind === "bar" ? pctOf(row.start ?? w0) : 0;
              return (
                <div
                  key={row.key}
                  className={cn("flex", start != null && "absolute right-0 left-0")}
                  style={start != null ? { top: start, height: ROW_H } : { height: ROW_H }}
                >
                  {row.kind === "header" ? (
                    <div className="flex min-w-0 flex-1 items-center gap-2 border-b border-seam-soft bg-fabric-2 px-2 text-micro font-medium tracking-wide text-ink-2 uppercase">
                      {row.label}
                    </div>
                  ) : (
                    <Entity
                      id={row.entity}
                      className={cn(
                        "flex min-w-0 flex-1 items-stretch transition-colors duration-(--dur-fast) ease-(--ease-out)",
                        isActive && "bg-fabric-3",
                      )}
                      onMouseEnter={() => setActiveIdx(index)}
                      onMouseLeave={() => setActiveIdx((cur) => (cur === index ? null : cur))}
                    >
                      <OptionalTooltip label={[row.name, row.sub].filter(Boolean).join(" — ")}>
                        <div
                          className="sticky left-0 z-sticky flex shrink-0 items-center gap-1.5 overflow-hidden border-r border-seam-soft bg-fabric px-2 text-small text-ink"
                          style={{ width: labelW }}
                        >
                          <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-sm bg-(--tone)", `burrow-tone-${row.tone}`)} />
                          <span className="shrink-0 whitespace-nowrap">{row.label}</span>
                          {row.sub && <span className="min-w-0 flex-1 truncate text-micro text-ink-4">{row.sub}</span>}
                        </div>
                      </OptionalTooltip>
                      {/* the bars paint with `var(--tone)`: the row's tone has to be in scope inside this cell, or the
                          SVG falls back to the initial fill (black) in both themes */}
                      <div className={cn("relative min-w-0 flex-1", `burrow-tone-${row.tone}`)}>
                        <svg
                          viewBox={`0 0 ${VIEW_W} ${ROW_H}`}
                          preserveAspectRatio="none"
                          className="block h-full w-full"
                          aria-hidden="true"
                        >
                          {ticks.map((t) => (
                            <line
                              key={t}
                              x1={x(t)}
                              x2={x(t)}
                              y1={0}
                              y2={ROW_H}
                              stroke="var(--seam-soft)"
                              strokeWidth={1}
                              vectorEffect="non-scaling-stroke"
                            />
                          ))}
                          {nowVisible && (
                            <line
                              x1={x(now ?? w0)}
                              x2={x(now ?? w0)}
                              y1={0}
                              y2={ROW_H}
                              stroke="var(--live)"
                              strokeWidth={1}
                              strokeDasharray="3 3"
                              vectorEffect="non-scaling-stroke"
                            />
                          )}
                          <Bar row={row} x={x} />
                        </svg>
                        {isActive && (
                          <div
                            className={cn(
                              // a plain conditional render: Base UI never sets data-starting-style here, so this is the
                              // mount-entrance primitive rather than the overlay one (`.burrow-pop` did nothing at all)
                              "burrow-enter-pop pointer-events-none absolute z-tooltip w-max max-w-[min(26rem,60vw)] rounded-md border border-seam-strong bg-fabric-2 px-2 py-1.5 text-caption text-ink shadow-(--shadow-overlay)",
                              placeAbove ? "bottom-full mb-0.5 origin-bottom" : "top-full mt-0.5 origin-top",
                            )}
                            style={barPct > 55 ? { right: 4 } : { left: `${Math.max(2, barPct)}%` }}
                          >
                            <TimelineRowTooltip row={row} tz={tz} />
                          </div>
                        )}
                      </div>
                    </Entity>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <p className="border-t border-seam px-3 py-2.5 text-micro text-ink-4">
        Scroll the time axis to zoom. Drag across the chart to select a time range.
      </p>

      {/* The Gantt is not readable by a screen reader; this table is the accessible representation. */}
      <table className="sr-only">
        <caption>{label} — visible rows as a table</caption>
        <thead>
          <tr>
            <th scope="col">Group</th>
            <th scope="col">Row</th>
            <th scope="col">Status</th>
            <th scope="col">Start</th>
            <th scope="col">End</th>
            <th scope="col">Duration</th>
            <th scope="col">Note</th>
          </tr>
        </thead>
        <tbody>
          {items.map(({ index }) => {
            const row = rows[index];
            if (row?.kind !== "bar") return null;
            return (
              <Entity as="tr" key={row.key} id={row.entity}>
                <td>{row.group}</td>
                <td>{row.name}</td>
                <td>
                  {row.status ? (
                    <Datum field={row.status.field} raw={row.status.raw}>
                      {row.status.label}
                    </Datum>
                  ) : (
                    "—"
                  )}
                </td>
                <Datum as="td" field={row.startField} raw={row.startRaw} fmt="epoch">
                  {fmtEpoch(row.start, tz)}
                </Datum>
                <Datum as="td" field={row.endField} raw={row.endRaw} fmt="epoch">
                  {fmtEpoch(row.end, tz)}
                </Datum>
                <Datum as="td" field={row.durationField} raw={row.durationMs} fmt="dur">
                  {fmtDuration(row.durationMs)}
                </Datum>
                <td>{row.note ?? ""}</td>
              </Entity>
            );
          })}
        </tbody>
      </table>

      <p role="status" className="sr-only">
        {activeBar ? describe(activeBar) : ""}
      </p>
    </div>
  );
}

/** One bar. `x` is the shared time scale (viewBox units). */
function Bar({ row, x }: { row: TimelineBar; x: (t: number) => number }) {
  const startX = row.start != null ? x(row.start) : null;
  if (startX == null) return null;
  const endX = row.end != null ? x(row.end) : startX;
  const rawLeft = Math.min(startX, endX);
  const rawRight = Math.max(startX, endX);
  // Outside the window: nothing to draw (never a sliver pinned to the edge).
  if (rawRight < 0 || rawLeft > VIEW_W) return null;
  const left = Math.max(0, rawLeft);
  const width = Math.max(1.5, Math.min(VIEW_W, rawRight) - left);
  const top = 5;
  const h = ROW_H - 12;

  if (row.ghost) {
    return (
      <g>
        <line
          x1={startX}
          x2={startX}
          y1={3}
          y2={ROW_H - 3}
          stroke="var(--tone)"
          strokeWidth={1.5}
          strokeDasharray="2 2"
          vectorEffect="non-scaling-stroke"
          {...datumAttrs(row.durationField, row.durationMs, "dur")}
        />
        <rect
          x={startX - 2}
          y={top + h / 2 - 2}
          width={4}
          height={4}
          transform={`rotate(45 ${startX} ${top + h / 2})`}
          fill="var(--tone)"
        />
      </g>
    );
  }

  // No end reported: a zero-width tick at the start, never an invented length.
  if (row.end == null) {
    return (
      <line
        x1={startX}
        x2={startX}
        y1={3}
        y2={ROW_H - 3}
        stroke="var(--tone)"
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
        {...datumAttrs(row.durationField, row.durationMs, "dur")}
      />
    );
  }

  return (
    <g>
      <rect
        x={left}
        y={top}
        width={width}
        height={h}
        rx={2}
        fill="var(--tone)"
        fillOpacity={0.7}
        stroke="var(--tone)"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
        {...datumAttrs(row.durationField, row.durationMs, "dur")}
      />
      {row.open && (
        <line
          x1={left + width}
          x2={left + width + 6}
          y1={top + h / 2}
          y2={top + h / 2}
          stroke="var(--tone)"
          strokeWidth={1.5}
          strokeDasharray="2 2"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </g>
  );
}

/** Tooltip body: every value goes through `Datum`, so the entity/field pairing stays complete on hover. */
function TimelineRowTooltip({ row, tz }: { row: TimelineBar; tz: TzMode }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1.5 font-medium">
        {row.label}
        {row.status &&
          (row.status.domain ? (
            <StatusPill
              domain={row.status.domain}
              state={row.status.state ?? row.status.label}
              field={row.status.field}
              raw={row.status.state ? row.status.raw : undefined}
              size="sm"
              {...(row.status.state ? { children: row.status.label } : {})}
            />
          ) : (
            <span className={cn("burrow-pill inline-flex h-5 items-center rounded-full px-1.5 text-caption", `burrow-tone-${row.tone}`)}>
              <Datum field={row.status.field} raw={row.status.raw}>
                {row.status.label}
              </Datum>
            </span>
          ))}
      </span>
      {row.sub && <span className="max-w-80 truncate text-micro text-ink-3">{row.sub}</span>}
      <span className="mt-0.5 grid grid-cols-[auto_1fr] gap-x-2 text-micro text-ink-3">
        <span className="text-ink-4">start</span>
        <Datum field={row.startField} raw={row.startRaw} fmt="epoch" className="text-ink-2">
          {fmtEpoch(row.start, tz)}
        </Datum>
        <span className="text-ink-4">end</span>
        <Datum field={row.endField} raw={row.endRaw} fmt="epoch" className="text-ink-2">
          {fmtEpoch(row.end, tz)}
        </Datum>
        <span className="text-ink-4">duration</span>
        <Datum field={row.durationField} raw={row.durationMs} fmt="dur" className="text-ink-2">
          {fmtDuration(row.durationMs)}
        </Datum>
      </span>
      {row.note && <span className="mt-0.5 max-w-80 text-micro text-ink-4">{row.note}</span>}
    </span>
  );
}
