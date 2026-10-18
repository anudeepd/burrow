import type { ReactNode } from "react";
import type { Tone } from "~/design/status";
import { cn } from "~/lib/cn";
import { type Fmt, fmtBytes, fmtId, fmtInt, fmtMB, fmtPct } from "~/lib/format";
import { datumAttrs, Datum } from "./datum";
import { type Point, Sparkline } from "./charts";
import { Ticker } from "./ticker";

/** Default formatter for a `Fmt` tag, used when the caller does not pass a composite body. */
const FORMATTERS: Record<Fmt, (n: number) => string> = {
  bytes: (n) => fmtBytes(n),
  mb: (n) => fmtMB(n),
  ms: fmtInt,
  dur: fmtInt,
  epoch: fmtInt,
  pct: (n) => fmtPct(n),
  int: fmtInt,
  id: (n) => fmtId(n),
  text: String,
};

const SIZES = { sm: "text-h3", md: "text-h2", lg: "text-metric" } as const;

export interface MetricProps {
  /** visible caption, e.g. "Apps running" */
  label: string;
  /** parity field id, e.g. `cluster.metrics.appsRunning` */
  field: string;
  /** raw upstream value → `data-yv` (never formatted, never tweened) */
  raw: unknown;
  fmt?: Fmt;
  /** click-through; renders a plain `<a>` (no typed router Link — the caller decides the href) */
  href?: string;
  tone?: Tone;
  /** optional trend; rendered right-aligned */
  spark?: Point[];
  /** overrides the default ticker/format body (e.g. a composite "1.2 GiB / 4 GiB" string) */
  children?: ReactNode;
  size?: keyof typeof SIZES;
  /** `row` is used by the Overview's compact counter groups; `card` remains the default for standalone metrics. */
  layout?: "card" | "row";
  className?: string;
  /** extra context under the value (unit, secondary figure) */
  footnote?: ReactNode;
  footnoteClassName?: string;
}

/**
 * One headline number: caption, live value, optional trend. The value element carries the parity attributes exactly
 * once (via Ticker or Datum) so `data-yf`/`data-yv` stay unambiguous — never wrap a Ticker in another Datum.
 */
export function Metric({
  label,
  field,
  raw,
  fmt,
  href,
  tone = "live",
  spark,
  children,
  size = "md",
  layout = "card",
  className,
  footnote,
  footnoteClassName,
}: MetricProps) {
  const Tag = href ? "a" : "article";
  const body =
    children != null ? (
      <span {...datumAttrs(field, raw, fmt)}>{children}</span>
    ) : typeof raw === "number" ? (
      <Ticker value={raw} field={field} fmt={fmt} format={FORMATTERS[fmt ?? "int"]} />
    ) : (
      <Datum field={field} raw={raw} fmt={fmt} />
    );
  return (
    <Tag
      {...(href ? { href } : {})}
      className={cn(
        `burrow-tone-${tone}`,
        spark && "burrow-metric-spark-container",
        layout === "row"
          ? "burrow-metric-row group relative grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 border-b border-seam-soft py-2 transition-colors duration-(--dur-fast) hover:bg-fabric-2/50"
          : "group relative flex min-w-0 flex-col gap-1 rounded-lg border border-seam bg-fabric p-3 transition-colors duration-(--dur-fast)",
        href && "hover:border-seam-strong hover:bg-fabric-2 focus-visible:outline-2",
        className,
      )}
      data-overview-metric-row={layout === "row" ? "true" : undefined}
    >
      {layout === "row" ? (
        <>
          <span className="min-w-0 break-words text-small font-medium text-ink-2">{label}</span>
          <div className="flex min-w-0 items-center justify-end gap-2">
            <div
              className="min-w-0 break-words text-right text-body font-semibold text-ink"
              style={{ color: "color-mix(in oklch, var(--ink) 88%, var(--tone))" }}
            >
              {body}
            </div>
            {spark && spark.length > 1 && (
              <div className="burrow-metric-spark shrink-0">
                <Sparkline points={spark} label={`${label} trend`} tone="var(--tone)" width={72} height={22} />
              </div>
            )}
            {href && (
              <span aria-hidden="true" className="shrink-0 text-ink-4 transition-colors duration-(--dur-fast) group-hover:text-live">
                ↗
              </span>
            )}
          </div>
          {footnote && <div className={cn("col-span-2 whitespace-normal text-caption text-ink-3", footnoteClassName)}>{footnote}</div>}
        </>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-micro uppercase tracking-[0.06em] text-ink-3">{label}</span>
            {href && (
              <span
                aria-hidden="true"
                className="text-ink-4 transition-colors duration-(--dur-fast) ease-(--ease-out) group-hover:text-live"
              >
                ↗
              </span>
            )}
          </div>
          <div className="burrow-metric-value-row flex items-end justify-between gap-3">
            <div
              className={cn("min-w-0 font-semibold text-ink", children != null ? "break-words" : "truncate", SIZES[size])}
              style={{ color: "color-mix(in oklch, var(--ink) 88%, var(--tone))" }}
            >
              {body}
            </div>
            {spark && spark.length > 1 && (
              <div className="burrow-metric-spark shrink-0">
                <Sparkline points={spark} label={`${label} trend`} tone="var(--tone)" width={72} height={22} />
              </div>
            )}
          </div>
          {footnote && <div className={cn("truncate text-micro text-ink-4", footnoteClassName)}>{footnote}</div>}
        </>
      )}
    </Tag>
  );
}
