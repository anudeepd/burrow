/**
 * Task distribution charts ("Summary Metrics" in Spark's own UI) built from a stage's `taskSummary`/`taskMetricsDistributions`
 * quantile payload.
 *
 * Spark's stage page shows, per metric: a row of quantile columns (25 / 50 / 75 / Max) and a small horizontal bar chart.
 * We keep the same metric set and units, and add an accessible description per chart (`aria-label` carries the values);
 * `data-yv` carries the raw quantile minimum so the parity harness can compare against the REST payload.
 */
import { cn } from "~/lib/cn";
import { Datum } from "~/ui/datum";
import { DetailTableScroller } from "~/ui/detail-table-scroller";
import { fmtBytes, fmtDuration, fmtInt } from "~/lib/format";
import { type MetricUnit, type QuantileSeries, seriesOf } from "../data/format";
import type { SparkStage, SparkTaskSummary } from "../data/schemas";
import { OptionalTooltip } from "~/ui/tooltip";

export interface DistMetric {
  key: string;
  label: string;
  unit: MetricUnit;
  /** parity field id (relative to the stage entity) — points at the REST quantile array. */
  field: string;
  series: QuantileSeries | null;
  /** short explanation used as the row tooltip */
  hint?: string;
}

type DistSource = SparkTaskSummary | NonNullable<SparkStage["taskMetricsDistributions"]>;

interface MetricDef {
  key: string;
  label: string;
  unit: MetricUnit;
  field: string;
  pick: (s: DistSource) => number[] | null | undefined;
  hint?: string;
}

const DEFS: readonly MetricDef[] = [
  {
    key: "duration",
    label: "Duration",
    unit: "ms",
    field: "taskMetricsDistributions.duration",
    pick: (s) => s.duration,
    hint: "Task duration quantiles",
  },
  { key: "gcTime", label: "GC Time", unit: "ms", field: "taskMetricsDistributions.jvmGcTime", pick: (s) => s.jvmGcTime },
  {
    key: "executorRunTime",
    label: "Executor Run Time",
    unit: "ms",
    field: "taskMetricsDistributions.executorRunTime",
    pick: (s) => s.executorRunTime,
  },
  {
    key: "deserializeTime",
    label: "Executor Deserialize Time",
    unit: "ms",
    field: "taskMetricsDistributions.executorDeserializeTime",
    pick: (s) => s.executorDeserializeTime,
  },
  {
    key: "schedulerDelay",
    label: "Scheduler Delay",
    unit: "ms",
    field: "taskMetricsDistributions.schedulerDelay",
    pick: (s) => s.schedulerDelay,
  },
  {
    key: "gettingResultTime",
    label: "Getting Result Time",
    unit: "ms",
    field: "taskMetricsDistributions.gettingResultTime",
    pick: (s) => s.gettingResultTime,
  },
  {
    key: "resultSerializationTime",
    label: "Result Serialization Time",
    unit: "ms",
    field: "taskMetricsDistributions.resultSerializationTime",
    pick: (s) => s.resultSerializationTime,
  },
  { key: "resultSize", label: "Result Size", unit: "bytes", field: "taskMetricsDistributions.resultSize", pick: (s) => s.resultSize },
  {
    key: "peakExecutionMemory",
    label: "Peak Execution Memory",
    unit: "bytes",
    field: "taskMetricsDistributions.peakExecutionMemory",
    pick: (s) => s.peakExecutionMemory,
  },
  {
    key: "memorySpill",
    label: "Shuffle Spill (Memory)",
    unit: "bytes",
    field: "taskMetricsDistributions.memoryBytesSpilled",
    pick: (s) => s.memoryBytesSpilled,
  },
  {
    key: "diskSpill",
    label: "Shuffle Spill (Disk)",
    unit: "bytes",
    field: "taskMetricsDistributions.diskBytesSpilled",
    pick: (s) => s.diskBytesSpilled,
  },
  {
    key: "inputBytes",
    label: "Input Size",
    unit: "bytes",
    field: "taskMetricsDistributions.inputMetrics.bytesRead",
    pick: (s) => s.inputMetrics?.bytesRead,
  },
  {
    key: "inputRecords",
    label: "Input Records",
    unit: "count",
    field: "taskMetricsDistributions.inputMetrics.recordsRead",
    pick: (s) => s.inputMetrics?.recordsRead,
  },
  {
    key: "outputBytes",
    label: "Output Size",
    unit: "bytes",
    field: "taskMetricsDistributions.outputMetrics.bytesWritten",
    pick: (s) => s.outputMetrics?.bytesWritten,
  },
  {
    key: "outputRecords",
    label: "Output Records",
    unit: "count",
    field: "taskMetricsDistributions.outputMetrics.recordsWritten",
    pick: (s) => s.outputMetrics?.recordsWritten,
  },
  {
    key: "shuffleReadBytes",
    label: "Shuffle Read Size",
    unit: "bytes",
    field: "taskMetricsDistributions.shuffleReadMetrics.readBytes",
    pick: (s) => s.shuffleReadMetrics?.readBytes,
  },
  {
    key: "shuffleReadRecords",
    label: "Shuffle Read Records",
    unit: "count",
    field: "taskMetricsDistributions.shuffleReadMetrics.readRecords",
    pick: (s) => s.shuffleReadMetrics?.readRecords,
  },
  {
    key: "shuffleReadFetchWait",
    label: "Shuffle Read Fetch Wait",
    unit: "ms",
    field: "taskMetricsDistributions.shuffleReadMetrics.fetchWaitTime",
    pick: (s) => s.shuffleReadMetrics?.fetchWaitTime,
  },
  {
    key: "shuffleWriteBytes",
    label: "Shuffle Write Size",
    unit: "bytes",
    field: "taskMetricsDistributions.shuffleWriteMetrics.writeBytes",
    pick: (s) => s.shuffleWriteMetrics?.writeBytes,
  },
  {
    key: "shuffleWriteRecords",
    label: "Shuffle Write Records",
    unit: "count",
    field: "taskMetricsDistributions.shuffleWriteMetrics.writeRecords",
    pick: (s) => s.shuffleWriteMetrics?.writeRecords,
  },
  {
    key: "shuffleWriteTime",
    label: "Shuffle Write Time",
    unit: "ms",
    field: "taskMetricsDistributions.shuffleWriteMetrics.writeTime",
    pick: (s) => s.shuffleWriteMetrics?.writeTime,
  },
  { key: "failedTasks", label: "Failed Tasks", unit: "count", field: "taskMetricsDistributions.failedTasks", pick: (s) => s.failedTasks },
  { key: "killedTasks", label: "Killed Tasks", unit: "count", field: "taskMetricsDistributions.killedTasks", pick: (s) => s.killedTasks },
];

/** Build the metric list for a stage attempt's quantile payload (metrics with no values are dropped). */
export function distributionsOf(source: DistSource | null | undefined): DistMetric[] {
  if (!source) return [];
  const q = source.quantiles ?? null;
  const out: DistMetric[] = [];
  for (const d of DEFS) {
    const series = seriesOf(q, d.pick(source));
    if (!series) continue;
    out.push({ key: d.key, label: d.label, unit: d.unit, field: d.field, hint: d.hint, series });
  }
  return out;
}

function fmt(v: number | null | undefined, unit: MetricUnit): string {
  if (v == null) return "—";
  return unit === "bytes" ? fmtBytes(v) : unit === "ms" ? fmtDuration(v) : fmtInt(v);
}

/** One horizontal bar chart: a bar per quantile, widths proportional to the largest quantile in the row. */
function QuantileBars({ series, unit, label }: { series: QuantileSeries; unit: MetricUnit; label: string }) {
  const max = series.values.reduce((a, v) => (v > a ? v : a), 0);
  const w = 132;
  const h = 16;
  const gap = 2;
  const bw = (w - gap * (series.values.length - 1)) / Math.max(1, series.values.length);
  return (
    <svg
      role="img"
      aria-label={`${label}: ${series.quantiles.map((q, i) => `${(q * 100).toFixed(0)}th percentile ${fmt(series.values[i], unit)}`).join(", ")}`}
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="overflow-visible"
    >
      <line x1={0} x2={w} y1={h - 0.5} y2={h - 0.5} stroke="var(--seam)" />
      {series.values.map((v, i) => {
        const bh = max > 0 ? Math.max(1, (v / max) * (h - 3)) : 1;
        const tone = i === series.values.length - 1 ? "var(--live)" : "color-mix(in oklch, var(--live) 62%, var(--ink-4))";
        return <rect key={series.quantiles[i] ?? i} x={i * (bw + gap)} y={h - 1 - bh} width={bw} height={bh} rx={1} fill={tone} />;
      })}
    </svg>
  );
}

/**
 * The "Summary Metrics" block: quantile columns + bar chart per metric. `fieldPrefix` becomes the `data-yf` prefix so the
 * harness reads exactly the REST quantile arrays that produced the picture.
 */
export function DistributionTable({
  metrics,
  title = "Summary Metrics",
  fieldPrefix = "spark.stage.",
}: {
  metrics: DistMetric[];
  title?: string;
  fieldPrefix?: string;
}) {
  if (metrics.length === 0) return null;
  const quantiles = metrics[0]?.series?.quantiles ?? [];
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h3 className="text-body font-semibold text-ink">{title}</h3>
      <DetailTableScroller ariaLabel={`${title} quantiles`} className="rounded-lg border border-seam bg-fabric">
        <table className="w-full min-w-[560px] text-small">
          <thead>
            <tr className="border-b border-seam text-ink-3">
              <th scope="col" className="px-2.5 py-1.5 text-left font-medium">
                Metric
              </th>
              {quantiles.map((q) => (
                <th key={q} scope="col" className="px-2.5 py-1.5 text-right font-medium tnum">
                  {`${+(q * 100).toFixed(1)}%`}
                </th>
              ))}
              <th scope="col" className="px-2.5 py-1.5 text-left font-medium">
                Distribution
              </th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((m) => (
              <OptionalTooltip key={m.key} label={m.hint}>
                <tr key={m.key} className="border-b border-seam-soft last:border-0">
                  <th scope="row" className="px-2.5 py-1.5 text-left font-normal text-ink-2">
                    {m.label}
                  </th>
                  {quantiles.map((q, i) => (
                    <td key={q} className={cn("px-2.5 py-1.5 text-right tnum", i === quantiles.length - 1 && "font-medium text-ink")}>
                      {fmt(m.series?.values[i], m.unit)}
                    </td>
                  ))}
                  {/* Rule 2: the bar chart *is* the value, so it carries the field id and the raw quantile array. */}
                  <td className="px-2.5 py-1.5">
                    <Datum field={`${fieldPrefix}${m.field}`} raw={m.series?.values} fmt="text" as="div" className="inline-block">
                      {m.series && <QuantileBars series={m.series} unit={m.unit} label={m.label} />}
                    </Datum>
                  </td>
                </tr>
              </OptionalTooltip>
            ))}
          </tbody>
        </table>
      </DetailTableScroller>
    </section>
  );
}
