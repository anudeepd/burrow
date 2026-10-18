/**
 * Overview adapters over the shared `Metric` primitive (`~/ui/metric`, DESIGN.md §"How to build a page").
 *
 * They add only what the Overview needs on top of it — a stable `data-testid`, and a click-through that stays
 * client-side (`CrossLink`) instead of the primitive's plain `<a>` — and carry no markup of their own, so there is one
 * metric look in the product.
 */
import type { ReactNode } from "react";
import type { Fmt } from "~/lib/format";
import type { Point } from "~/ui/charts";
import { Metric } from "~/ui/metric";
import type { Tone } from "~/design/status";
import { cn } from "~/lib/cn";
import { Tooltip } from "~/ui/tooltip";
import { CrossLink } from "./ui";

export interface MetricCardProps {
  label: string;
  /** `data-yf` */
  field: string;
  /** `data-yv` */
  raw: unknown;
  fmt?: Fmt;
  /** overrides the primitive's default body — must not re-stamp `field` (the primitive already does) */
  children?: ReactNode;
  href?: string;
  hrefHint?: string;
  /** Styled hover/focus copy for the card's click-through. */
  tooltip?: ReactNode;
  tone?: Tone;
  spark?: Point[];
  footnote?: ReactNode;
  footnoteClassName?: string;
  size?: "sm" | "md" | "lg";
  layout?: "card" | "row";
  testId?: string;
  className?: string;
}

export function MetricCard({ href, hrefHint, tooltip, testId, className, layout = "card", ...metric }: MetricCardProps) {
  const linkHint = hrefHint ?? `Open ${metric.label}`;
  const tooltipLabel = tooltip ?? (metric.spark ? `${linkHint}. Trend shows values across the selected history window.` : linkHint);
  return (
    <div className={cn("relative min-w-0", className)} data-testid={testId}>
      <Metric {...metric} layout={layout} className="h-full" />
      {href && (
        <Tooltip label={tooltipLabel}>
          <CrossLink
            href={href}
            aria-label={hrefHint ?? `${metric.label}: open the filtered view`}
            className="absolute inset-0 rounded-sm focus-visible:outline-2"
            data-testid={testId ? `${testId}-link` : undefined}
          >
            <span className="sr-only">{hrefHint ?? `Open ${metric.label}`}</span>
          </CrossLink>
        </Tooltip>
      )}
    </div>
  );
}

/**
 * A metric whose value is a composite legacy string (`<memory:9 GB, vCores:12>`) built from several upstream primitives.
 * The composite is the single `data-yv`; the primitives are nested Datums with their own ids (contract rule 4).
 */
export function CompositeMetric({
  label,
  derivedField,
  derivedValue,
  parts,
  href,
  hrefHint,
  tooltip,
  tone,
  footnote,
  footnoteClassName,
  layout,
  testId,
}: {
  label: string;
  derivedField: string;
  derivedValue: string;
  parts: ReactNode;
  href?: string;
  hrefHint?: string;
  tooltip?: ReactNode;
  tone?: Tone;
  footnote?: ReactNode;
  footnoteClassName?: string;
  layout?: "card" | "row";
  testId?: string;
}) {
  return (
    <MetricCard
      label={label}
      field={derivedField}
      raw={derivedValue}
      fmt="text"
      size="md"
      href={href}
      hrefHint={hrefHint}
      tooltip={tooltip}
      tone={tone}
      footnote={footnote}
      footnoteClassName={footnoteClassName}
      layout={layout}
      testId={testId}
    >
      <span className="mono text-body">{parts}</span>
    </MetricCard>
  );
}
