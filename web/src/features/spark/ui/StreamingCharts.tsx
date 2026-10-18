/**
 * Streaming charts: batch metrics over batch time, plus the per-receiver event-rate trend.
 *
 * Spark's REST API has no time-series endpoint — `/streaming/batches` returns one object per batch and these charts plot a
 * single key of that object against `batchTime` (falling back to `batchId`, which is epoch-ms for DStreams) oldest →
 * newest, so a live application's newest batch extends the line as the query refetches.
 *
 * A chart line is a *visualisation* of many REST values; the authoritative per-batch numbers are stamped with
 * `spark.streaming.batches.*` in the batches table on the page (rule 2 of docs/contracts/parity-dom.md applies to
 * single-value presentations — bars, gauges, badges). Charts carry an `aria-label` with the shape of the series.
 */
import { useMemo } from "react";
import { fmtInt, fmtDuration } from "~/lib/format";
import { AreaChart, type Point, Sparkline } from "~/ui/charts";
import { cn } from "~/lib/cn";
import { parseSparkTime } from "../data/format";
import type { SparkStreamingBatch, SparkStreamingReceiver } from "../data/schemas";
import { InlineNote } from "./StateViews";

/** The batch keys these charts plot. All four are per-batch REST keys. */
export type BatchSeriesKey = "processingTime" | "schedulingDelay" | "totalDelay" | "inputSize";

interface SeriesSpec {
  key: BatchSeriesKey;
  label: string;
  /** Unit suffix for the axis ticks (values stay raw: ms / bytes). */
  unit: string;
  /** Series identity colour (token reference — never a status claim). */
  tone: string;
  format: (v: number) => string;
  hint: string;
}

const SERIES: readonly SeriesSpec[] = [
  {
    key: "processingTime",
    label: "Processing time",
    unit: "ms",
    tone: "var(--dye-1)",
    format: fmtDuration,
    hint: "processingTime per batch — time spent processing the batch's data.",
  },
  {
    key: "schedulingDelay",
    label: "Scheduling delay",
    unit: "ms",
    tone: "var(--dye-3)",
    format: fmtDuration,
    hint: "schedulingDelay per batch — batch creation to the start of processing.",
  },
  {
    key: "totalDelay",
    label: "Total delay",
    unit: "ms",
    tone: "var(--dye-5)",
    format: fmtDuration,
    hint: "totalDelay per batch — scheduling delay plus processing time, as Spark reports it.",
  },
  {
    key: "inputSize",
    label: "Input records",
    unit: " records",
    tone: "var(--dye-2)",
    format: fmtInt,
    hint: "inputSize per batch — records received during the batch interval.",
  },
];

/** Batch position on the time axis: `batchTime` when Spark reported it, else `batchId` (epoch-ms for DStreams). */
export function batchTimeOf(b: SparkStreamingBatch): number | null {
  const t = parseSparkTime(b.batchTime);
  if (t != null) return t;
  return Number.isFinite(b.batchId) ? b.batchId : null;
}

/** Ascending series of `key` over batch time. Batches that omit the key (queued/processing) are skipped, not zero-filled. */
export function batchSeries(batches: readonly SparkStreamingBatch[], key: BatchSeriesKey): Point[] {
  const points: Point[] = [];
  for (const b of batches) {
    const t = batchTimeOf(b);
    const v = b[key];
    if (t == null || v == null || !Number.isFinite(v)) continue;
    points.push({ t, v });
  }
  points.sort((a, b) => a.t - b.t);
  return points;
}

/** Even ceiling so the mid axis tick stays a whole number (AreaChart prints raw tick values); 2 keeps an all-zero series readable. */
const niceMax = (max: number): number => (max <= 0 ? 2 : Math.ceil(max / 2) * 2);

/**
 * The four batch series, one area chart each. Renders the honest "no values yet" note per series when Spark omitted the
 * key for every batch it returned (queued/processing batches have no schedulingDelay/processingTime/totalDelay).
 */
export function BatchMetricCharts({ batches, className }: { batches: readonly SparkStreamingBatch[]; className?: string }) {
  const charts = useMemo(
    () =>
      SERIES.map((spec) => {
        const points = batchSeries(batches, spec.key);
        const peak = points.reduce((m, p) => (p.v > m ? p.v : m), 0);
        const last = points[points.length - 1];
        return { spec, points, peak, last };
      }),
    [batches],
  );

  return (
    <div className={cn("grid grid-cols-1 gap-3 md:grid-cols-2", className)}>
      {charts.map(({ spec, points, peak, last }) => (
        <figure key={spec.key} className="m-0 flex min-w-0 flex-col gap-1 rounded-lg border border-seam bg-fabric p-2">
          <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-small text-ink-3">
            <span className="flex items-center gap-1.5">
              <span aria-hidden="true" className="size-2 shrink-0 rounded-sm" style={{ background: spec.tone }} />
              <span className="font-medium text-ink-2">{spec.label}</span>
            </span>
            <span className="tnum whitespace-nowrap text-micro">
              {last ? `${spec.format(last.v)} latest` : "no value"} · {spec.format(peak)} peak
            </span>
          </figcaption>
          {points.length >= 2 ? (
            <AreaChart
              points={points}
              height={84}
              tone={spec.tone}
              domain={[0, niceMax(peak)]}
              unit={spec.unit}
              label={`${spec.label} per batch, oldest to newest, ${points.length} batches, peak ${spec.format(peak)}`}
            />
          ) : (
            <InlineNote>
              {points.length === 0
                ? "Spark reported no value for this key — queued and processing batches omit it."
                : "Only one batch reported a value; a trend needs at least two."}
            </InlineNote>
          )}
          <p className="text-micro text-ink-4">{spec.hint}</p>
        </figure>
      ))}
    </div>
  );
}

/** One receiver's `eventRates` as an inline trend. Empty when the receiver reported no samples. */
export function ReceiverTrend({ receiver, className }: { receiver: SparkStreamingReceiver; className?: string }) {
  const points = useMemo<Point[]>(() => {
    const out: Point[] = [];
    for (const pair of receiver.eventRates) {
      const [t, v] = pair;
      if (t == null || v == null || !Number.isFinite(t) || !Number.isFinite(v)) continue;
      out.push({ t, v });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }, [receiver.eventRates]);

  const name = receiver.streamName ?? `stream ${receiver.streamId ?? "?"}`;
  return (
    <Sparkline
      points={points}
      width={104}
      height={22}
      tone="var(--live)"
      label={`Event rate of ${name} over ${points.length} samples`}
      className={className}
    />
  );
}
