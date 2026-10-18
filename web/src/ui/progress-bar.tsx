import { cn } from "~/lib/cn";
import { useInView } from "~/lib/in-view";
import type { Tone } from "~/design/status";
import type { DatumAttrs } from "./datum";
import { Tooltip } from "./tooltip";

export interface Segment {
  /** 0..100 share of the bar */
  percent: number;
  tone: Tone;
  label: string;
}

/** Preserve segment proportions while keeping stacked bars within their 100% track. */
export function normalizeSegments(segments: readonly Segment[]): Segment[] {
  const safe = segments.map((segment) => ({
    ...segment,
    percent: Number.isFinite(segment.percent) ? Math.max(0, segment.percent) : 0,
  }));
  const total = safe.reduce((sum, segment) => sum + segment.percent, 0);
  if (total <= 100) return safe;
  if (Number.isFinite(total)) {
    const scale = 100 / total;
    return safe.map((segment) => ({ ...segment, percent: segment.percent * scale }));
  }
  const largest = Math.max(...safe.map((segment) => segment.percent));
  const scaled = safe.map((segment) => segment.percent / largest);
  const scaledTotal = scaled.reduce((sum, percent) => sum + percent, 0);
  return safe.map((segment, index) => ({ ...segment, percent: ((scaled[index] ?? 0) / scaledTotal) * 100 }));
}
export interface ProgressMarker {
  /** 0..100 */
  percent: number;
  className: string;
}

/**
 * The thread. Determinate progress as a 4px line; `live` adds the needle shimmer (only while visible, off under reduced
 * motion/parity, replaced by a dashed texture so liveness is never motion-only). Segmented variant: stacked shares
 * (e.g. Spark tasks done / active / failed / pending).
 */
export function ProgressBar({
  percent,
  tone = "live",
  live = false,
  segments,
  markers,
  valueText,
  label,
  className,
  datum,
}: {
  /** 0..100 */
  percent: number;
  tone?: Tone;
  live?: boolean;
  segments?: Segment[];
  markers?: ProgressMarker[];
  valueText?: string;
  label: string;
  className?: string;
  /** parity attrs for the element that encodes the value (rule 2 of the parity contract) */
  datum?: DatumAttrs;
}) {
  const [ref, visible] = useInView<HTMLDivElement>();
  const p = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  if (segments) {
    const normalized = normalizeSegments(segments);
    return (
      <div
        ref={ref}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(normalized.reduce((a, b) => a + b.percent, 0))}
        aria-valuetext={valueText ?? normalized.map((s) => `${s.label} ${s.percent.toFixed(0)}%`).join(", ")}
        className={cn("burrow-thread flex gap-px", className)}
        data-live={live}
        data-visible={visible}
        data-segments="true"
        {...datum}
      >
        {normalized.map((s) => (
          <Tooltip key={s.label} label={`${s.label}: ${s.percent.toFixed(1)}%`}>
            <span
              className={cn("block h-full first:rounded-l-full last:rounded-r-full", `burrow-tone-${s.tone}`, "bg-(--tone)")}
              style={{ width: `${Math.max(0, s.percent)}%` }}
            />
          </Tooltip>
        ))}
      </div>
    );
  }
  return (
    <div
      ref={ref}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(p)}
      aria-valuetext={valueText}
      className={cn("burrow-thread", `burrow-tone-${tone}`, className)}
      data-live={live}
      data-visible={visible}
      data-markers={markers?.length ? "true" : undefined}
      {...datum}
    >
      <div className="burrow-thread-fill" style={{ width: `${p}%` }} />
      {markers?.map((marker, index) => (
        <span
          key={index}
          aria-hidden="true"
          className={cn("burrow-progress-marker", marker.className)}
          style={{
            left: `clamp(1px, ${Math.max(0, Math.min(100, Number.isFinite(marker.percent) ? marker.percent : 0))}%, calc(100% - 1px))`,
          }}
        />
      ))}
    </div>
  );
}
