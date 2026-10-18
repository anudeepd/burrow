import { scaleLinear } from "d3-scale";
import { area, curveMonotoneX, line } from "d3-shape";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "~/lib/cn";
import { Tooltip } from "~/ui/tooltip";

export interface Point {
  t: number;
  v: number;
}

function useGeometry(points: Point[], w: number, h: number, pad: number, domain?: [number, number]) {
  return useMemo(() => {
    if (points.length < 2) return null;
    const t0 = points[0]?.t ?? 0;
    const t1 = points[points.length - 1]?.t ?? 1;
    const vs = points.map((p) => p.v);
    const rawLo = domain ? domain[0] : Math.min(...vs);
    const rawHi = domain ? domain[1] : Math.max(...vs);
    // A constant series (most often a zero-valued counter) should read as a flat, centered trend. If the
    // domain has no height, d3 maps it to the lower edge, which makes an otherwise centered sparkline look broken.
    const flatPad = Math.max(Math.abs(rawLo) * 0.05, 1);
    const lo = rawHi === rawLo ? rawLo - flatPad : rawLo;
    const hi = rawHi === rawLo ? rawHi + flatPad : rawHi;
    const x = scaleLinear()
      .domain([t0, t1 === t0 ? t0 + 1 : t1])
      .range([pad, w - pad]);
    const y = scaleLinear()
      .domain([lo, hi === lo ? lo + 1 : hi])
      .range([h - pad, pad]);
    const ln = line<Point>()
      .x((p) => x(p.t))
      .y((p) => y(p.v))
      .curve(curveMonotoneX);
    const ar = area<Point>()
      .x((p) => x(p.t))
      .y0(h - pad)
      .y1((p) => y(p.v))
      .curve(curveMonotoneX);
    return { x, y, linePath: ln(points) ?? "", areaPath: ar(points) ?? "", last: points[points.length - 1] as Point };
  }, [points, w, h, pad, domain]);
}

/** Tiny inline trend: stroke only, end-point dot. `aria-label` carries the meaning; the path is decorative. */
export function Sparkline({
  points,
  width = 96,
  height = 24,
  tone = "var(--live)",
  domain,
  label,
  className,
}: {
  points: Point[];
  width?: number;
  height?: number;
  tone?: string;
  domain?: [number, number];
  label: string;
  className?: string;
}) {
  const g = useGeometry(points, width, height, 2, domain);
  return (
    <svg
      role="img"
      aria-label={label}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("overflow-visible", className)}
    >
      {g ? (
        <>
          <path
            d={g.linePath}
            fill="none"
            stroke={tone}
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
          <circle cx={g.x(g.last.t)} cy={g.y(g.last.v)} r="2" fill={tone} />
        </>
      ) : (
        <line x1="2" x2={width - 2} y1={height / 2} y2={height / 2} stroke="var(--seam-strong)" strokeDasharray="2 3" />
      )}
    </svg>
  );
}

/** Area chart with baseline grid; optional sample readout uses the shared styled tooltip. */
export function AreaChart({
  points,
  width = 320,
  height = 96,
  tone = "var(--live)",
  domain = [0, 100],
  unit = "%",
  label,
  className,
  sampleTooltip,
  sampleAriaLabel = "Chart samples",
  timeLabel,
  fillHeight = false,
  /** horizontal room reserved for the right-aligned y-axis labels */
  gutter = 28,
}: {
  points: Point[];
  width?: number;
  height?: number;
  tone?: string;
  domain?: [number, number];
  unit?: string;
  label: string;
  className?: string;
  /** Enables pointer and keyboard sample inspection. Kept optional for charts that already have a separate readout. */
  sampleTooltip?: (point: Point) => string;
  sampleAriaLabel?: string;
  /** Optional endpoint labels for time-series charts. */
  timeLabel?: (timestamp: number) => string;
  /** Expand to the available height when the parent is a flex-sized chart panel. */
  fillHeight?: boolean;
  gutter?: number;
}) {
  const id = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null);
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);
  const [canFillHeight, setCanFillHeight] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const chartWidth = measuredWidth ?? width;
  const plotW = Math.max(1, chartWidth - gutter);
  const showTimeAxis = Boolean(timeLabel && points.length > 1);
  const defaultViewHeight = height + (showTimeAxis ? 12 : 0);
  const viewHeight =
    fillHeight && canFillHeight && measuredHeight != null ? Math.max(defaultViewHeight, measuredHeight) : defaultViewHeight;
  const plotHeight = viewHeight - (showTimeAxis ? 12 : 0);
  const g = useGeometry(points, plotW, plotHeight, 4, domain);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || typeof ResizeObserver === "undefined") return;
    const panel = svg.parentElement;
    const syncPanelHeight = () => {
      const shouldFill = Boolean(fillHeight && panel && getComputedStyle(panel).display === "flex");
      setCanFillHeight((current) => (current === shouldFill ? current : shouldFill));
      if (shouldFill && panel) {
        const nextHeight = Math.round(panel.getBoundingClientRect().height);
        if (nextHeight > 0) setMeasuredHeight((current) => (current === nextHeight ? current : nextHeight));
      } else {
        setMeasuredHeight((current) => (current == null ? current : null));
      }
    };
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === svg) {
          const nextWidth = Math.round(entry.contentRect.width);
          if (nextWidth > 0) setMeasuredWidth((current) => (current === nextWidth ? current : nextWidth));
        }
      }
      syncPanelHeight();
    });
    observer.observe(svg);
    if (fillHeight && panel) observer.observe(panel);
    return () => observer.disconnect();
  }, [fillHeight]);
  const activePoint = useMemo(() => {
    if (activeIndex == null) return null;
    const beforeIndex = Math.floor(activeIndex);
    const afterIndex = Math.min(points.length - 1, Math.ceil(activeIndex));
    const before = points[beforeIndex];
    const after = points[afterIndex];
    if (!before || !after) return null;
    if (beforeIndex === afterIndex) return before;
    const ratio = activeIndex - beforeIndex;
    return {
      t: before.t + (after.t - before.t) * ratio,
      v: before.v + (after.v - before.v) * ratio,
    };
  }, [activeIndex, points]);
  const activeTooltip = activePoint && sampleTooltip ? sampleTooltip(activePoint) : null;
  const pointIndexAt = (x: number) => {
    if (!g || points.length < 2) return null;
    const firstX = g.x(points[0]?.t ?? 0);
    const lastX = g.x(points[points.length - 1]?.t ?? 0);
    const clampedX = Math.max(Math.min(firstX, lastX), Math.min(Math.max(firstX, lastX), x));
    const t = g.x.invert(clampedX);
    let lo = 0;
    let hi = points.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if ((points[mid]?.t ?? 0) < t) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return 0;
    const before = points[lo - 1];
    const after = points[lo];
    if (!before || !after) return null;
    const span = after.t - before.t;
    if (span <= 0) return lo;
    const ratio = Math.max(0, Math.min(1, (t - before.t) / span));
    return lo - 1 + ratio;
  };
  const onSamplePointerMove = (e: PointerEvent<SVGRectElement>) => {
    if (!g) return;
    const rect = e.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const x = ((e.clientX - rect.left) / rect.width) * chartWidth;
    setActiveIndex(pointIndexAt(x));
  };
  const onSampleKeyDown = (e: KeyboardEvent<SVGRectElement>) => {
    if (!sampleTooltip || points.length < 2) return;
    const current = Math.round(activeIndex ?? points.length - 1);
    let next: number | null = null;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = Math.max(0, current - 1);
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") next = Math.min(points.length - 1, current + 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = points.length - 1;
    if (next != null) {
      e.preventDefault();
      setActiveIndex(next);
    }
  };
  const ticks = [domain[0], (domain[0] + domain[1]) / 2, domain[1]];
  // Centre labels on their gridline but keep the glyphs inside the viewBox (the top/bottom
  // ticks sit at the plot edge, so unclamped text is clipped by the svg viewport).
  const labelY = (y: number) => Math.min(Math.max(y, 8), plotHeight - 8);
  return (
    <svg
      role={sampleTooltip ? "group" : "img"}
      aria-label={label}
      ref={svgRef}
      viewBox={`0 0 ${chartWidth} ${viewHeight}`}
      className={cn(fillHeight && canFillHeight ? "block h-full w-full" : "block h-auto w-full", className)}
      data-testid={sampleTooltip ? "area-chart-with-samples" : undefined}
    >
      <defs>
        <linearGradient id={`${id}-fill`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={tone} stopOpacity="0.28" />
          <stop offset="1" stopColor={tone} stopOpacity="0" />
        </linearGradient>
      </defs>
      {ticks.map((tk) => {
        const y = g ? g.y(tk) : plotHeight - 4 - ((tk - domain[0]) / (domain[1] - domain[0])) * (plotHeight - 8);
        return (
          <g key={tk}>
            <line x1="0" x2={plotW} y1={y} y2={y} stroke="var(--seam-soft)" strokeDasharray="2 4" />
            <text
              x={chartWidth - 2}
              y={labelY(y)}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize="11"
              fill="var(--ink-4)"
              className="tnum"
            >
              {tk}
              {unit}
            </text>
          </g>
        );
      })}
      {g && (
        <>
          <path d={g.areaPath} fill={`url(#${id}-fill)`} />
          <path
            d={g.linePath}
            fill="none"
            stroke={tone}
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </>
      )}
      {showTimeAxis && g && timeLabel && (
        <g className="tnum" fontSize="10" fill="var(--ink-4)">
          <text x={g.x(points[0]?.t ?? 0)} y={plotHeight + 6} textAnchor="start" dominantBaseline="middle">
            {timeLabel(points[0]?.t ?? 0)}
          </text>
          <text x={g.x(points[points.length - 1]?.t ?? 0)} y={plotHeight + 6} textAnchor="end" dominantBaseline="middle">
            {timeLabel(points[points.length - 1]?.t ?? 0)}
          </text>
        </g>
      )}
      {sampleTooltip && g && points.length > 1 && (
        <>
          <rect
            x="0"
            y="0"
            width={plotW}
            height={plotHeight}
            fill="transparent"
            role="slider"
            aria-label={sampleAriaLabel}
            aria-valuemin={0}
            aria-valuemax={points.length - 1}
            aria-valuenow={activeIndex ?? points.length - 1}
            aria-valuetext={activePoint ? `${activeTooltip}` : `${sampleTooltip(points[points.length - 1] as Point)}`}
            tabIndex={0}
            onPointerMove={onSamplePointerMove}
            onPointerLeave={() => setActiveIndex(null)}
            onFocus={() => setActiveIndex(points.length - 1)}
            onBlur={() => setActiveIndex(null)}
            onKeyDown={onSampleKeyDown}
            className="cursor-crosshair outline-none focus-visible:stroke-(--focus) focus-visible:stroke-1"
          />
          {activePoint && activeTooltip && (
            <Tooltip open label={activeTooltip}>
              <circle
                cx={g.x(activePoint.t)}
                cy={g.y(activePoint.v)}
                r="4"
                fill={tone}
                stroke="var(--fabric)"
                strokeWidth="1.5"
                pointerEvents="none"
              />
            </Tooltip>
          )}
        </>
      )}
    </svg>
  );
}
