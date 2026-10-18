/**
 * Stage aggregates that Spark returns outside `taskMetricsDistributions`.
 *
 * With `details=true&withSummaries=true&quantiles=…` Spark's StageData also carries a top-level
 * `executorMetricsDistributions` whose `peakMemoryMetrics` is a map of quantile arrays (JVM heap, on-/off-heap execution,
 * GC counters, process RSS, …), aligned to `executorMetricsDistributions.quantiles`. Spark's stage page draws these as
 * "Peak JVM Heap" / "Peak On-heap Execution" rows; the field path below is the upstream JSON path (parity contract).
 *
 * The value is loosely typed upstream, so it is read through a precise local shape instead of guessing keys.
 */
import type { DistMetric } from "./TaskDistributions";
import { seriesOf } from "../data/format";
import type { SparkStage } from "../data/schemas";

interface StageExecutorMetricsDistributions {
  quantiles?: number[] | null;
  peakMemoryMetrics?: Record<string, number[] | null> | null;
}

/** The four peak-memory series the Spark stage page shows; upstream keys are exact. */
const PEAK_MEMORY_SERIES: readonly (readonly [string, string])[] = [
  ["JVMHeapMemory", "Peak JVM Heap"],
  ["JVMOffHeapMemory", "Peak JVM Off-heap"],
  ["OnHeapExecutionMemory", "Peak On-heap Execution"],
  ["OffHeapExecutionMemory", "Peak Off-heap Execution"],
];

/** Peak-memory quantile series from a stage attempt's `executorMetricsDistributions` (empty when Spark reported none). */
export function stagePeakMemoryDistributions(stage: SparkStage | null | undefined): DistMetric[] {
  const dist = (stage as { executorMetricsDistributions?: StageExecutorMetricsDistributions | null } | null | undefined)
    ?.executorMetricsDistributions;
  const peak = dist?.peakMemoryMetrics ?? null;
  if (!peak) return [];
  const quantiles = dist?.quantiles ?? null;
  const out: DistMetric[] = [];
  for (const [key, label] of PEAK_MEMORY_SERIES) {
    const series = seriesOf(quantiles, peak[key]);
    if (!series) continue;
    out.push({
      key: `peakMemory.${key}`,
      label,
      unit: "bytes",
      field: `executorMetricsDistributions.peakMemoryMetrics.${key}`,
      series,
      hint: `Executor ${key} peak, quantiles reported by Spark's executor metrics polling`,
    });
  }
  return out;
}
