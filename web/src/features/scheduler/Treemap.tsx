/**
 * Queue treemap — custom SVG (the legacy page uses a canvas in `div#cs`). Tiles are sized by the chosen basis
 * (`used` = used memory, `capacity` = guaranteed share) and dyed by pressure (used ÷ guaranteed share).
 *
 * Parity: each tile is an `Entity` (the queue path) whose rect carries the datum of the value it encodes
 * (rule 2 of docs/contracts/parity-dom.md). Keyboard: tiles are focusable links; the legend is a real list.
 */
import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Datum, Entity, datumAttrs } from "~/ui/datum";
import { cn } from "~/lib/cn";
import { useElementWidth } from "~/lib/size";
import { pressureTone } from "./format";
import { fmtInt, fmtMB } from "~/lib/format";

export interface TreemapItem {
  /** queue path (parity entity key) */
  key: string;
  /** short queue name retained for existing treemap consumers */
  label?: string;
  /** tile area driver, in MB */
  value: number;
  /** datum field id + raw for the value that drives the area */
  field: string;
  raw: unknown;
  /** used ÷ guaranteed-share percentage, for the dye and the readout */
  usedPct: number | null;
  /** second line inside big tiles, e.g. "used 2 GiB of 8 GiB" */
  sub?: string;
}

export interface TreemapTile extends TreemapItem {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Squarified treemap (Bruls/Huizing/van Wijk). Pure; returns tile geometry in the given viewport. */
export function squarify(items: TreemapItem[], x: number, y: number, w: number, h: number): TreemapTile[] {
  const total = items.reduce((a, b) => a + (b.value > 0 ? b.value : 0), 0);
  if (!(total > 0) || !(w > 0) || !(h > 0)) return [];
  const area = (w * h) / total;
  const sorted = [...items]
    .filter((i) => i.value > 0)
    .sort((a, b) => b.value - a.value)
    .map((i) => ({ ...i, area: i.value * area }));

  const out: TreemapTile[] = [];
  const worst = (row: { area: number }[], side: number): number => {
    const s = row.reduce((a, b) => a + b.area, 0);
    if (!(s > 0)) return Number.POSITIVE_INFINITY;
    let max = 0;
    let min = Number.POSITIVE_INFINITY;
    for (const r of row) {
      if (r.area > max) max = r.area;
      if (r.area < min) min = r.area;
    }
    const side2 = side * side;
    return Math.max((side2 * max) / (s * s), (s * s) / (side2 * min));
  };

  let cx = x;
  let cy = y;
  let cw = w;
  let ch = h;
  let i = 0;
  while (i < sorted.length) {
    const side = Math.min(cw, ch);
    const row: { area: number }[] = [sorted[i] as { area: number }];
    i++;
    while (i < sorted.length) {
      const candidate = [...row, sorted[i] as { area: number }];
      if (worst(candidate, side) > worst(row, side)) break;
      row.push(sorted[i] as { area: number });
      i++;
    }
    const rowArea = row.reduce((a, b) => a + b.area, 0);
    if (cw <= ch) {
      const stripW = rowArea / ch;
      let oy = cy;
      for (const it of row) {
        const tileH = it.area / stripW;
        out.push({ ...(it as TreemapItem & { area: number }), x: cx, y: oy, w: stripW, h: tileH });
        oy += tileH;
      }
      cx += stripW;
      cw -= stripW;
    } else {
      const stripH = rowArea / cw;
      let ox = cx;
      for (const it of row) {
        const tileW = it.area / stripH;
        out.push({ ...(it as TreemapItem & { area: number }), x: ox, y: cy, w: tileW, h: stripH });
        ox += tileW;
      }
      cy += stripH;
      ch -= stripH;
    }
  }
  return out;
}

const VIEW_W = 900;
const MIN_VIEW_H = 168;
const MAX_VIEW_H = 320;

export function QueueTreemap({
  items,
  basis,
  height,
  label,
  className,
  animateGeometry = false,
}: {
  items: TreemapItem[];
  /** what the tile area means — shown in the legend so the picture is never ambiguous */
  basis: "used" | "capacity";
  height?: number;
  label: string;
  className?: string;
  animateGeometry?: boolean;
}) {
  const navigate = useNavigate();
  const [boxRef, width] = useElementWidth<HTMLDivElement>(VIEW_W);
  const mapHeight = height ?? Math.max(MIN_VIEW_H, Math.min(MAX_VIEW_H, Math.round(width * 0.32)));
  const tiles = useMemo(() => squarify(items, 0, 0, width, mapHeight), [items, width, mapHeight]);
  const shown = tiles.length;
  const total = items.reduce((sum, item) => sum + (item.value > 0 ? item.value : 0), 0);

  return (
    <figure ref={boxRef} className={cn("m-0 flex flex-col gap-2", className)}>
      <svg
        role="img"
        aria-label={`${label}. Tiles are sized by ${basis === "used" ? "used memory" : "guaranteed share"} and colored by usage versus share. ${shown} of ${items.length} leaf queues with a nonzero value shown.`}
        viewBox={`0 0 ${width} ${mapHeight}`}
        /* the pane's own height: the width follows the container, and the viewBox matches it so nothing scales */
        style={{ height: mapHeight }}
        className="burrow-treemap block w-full overflow-hidden rounded-lg border border-seam bg-well"
        data-basis-transition={animateGeometry}
        preserveAspectRatio="none"
      >
        {tiles.map((t) => {
          const tone = pressureTone(t.usedPct);
          const large = t.w >= 220 && t.h >= 128;
          const medium = t.w >= 148 && t.h >= 82;
          /* keep small slivers to one line; give larger tiles a name, value, and pressure cue */
          const named = medium || (t.w > 100 && t.h > 15);
          const compact = named && t.h < 54 && t.h >= 22 && t.w >= 160;
          const amount = fmtMB(t.value);
          const amountY = large ? t.y + t.h - 42 : medium ? t.y + 53 : t.y + 41;
          const metaY = amountY + (large ? 17 : 15);
          const compactLine = `${t.key} · ${amount}`;
          const compactChars = Math.floor((t.w - 28) / 6.2);
          const go = () => void navigate({ to: "/scheduler/$queue", params: { queue: t.key } });
          return (
            <Entity
              key={t.key}
              as="g"
              id={t.key}
              role="link"
              tabIndex={0}
              aria-label={`${t.key}: ${amount} ${basis === "used" ? "used" : "guaranteed"}; ${t.sub ?? ""}`}
              className={cn(`burrow-tone-${tone}`, "group/tile cursor-pointer outline-offset-2")}
              onClick={go}
              onKeyDown={(e: React.KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  go();
                }
              }}
            >
              <title>
                {t.key}
                {"\n"}
                {amount}
                {"\n"}
                {t.sub ?? ""}
              </title>
              <rect
                x={t.x + 1}
                y={t.y + 1}
                width={Math.max(0, t.w - 2)}
                height={Math.max(0, t.h - 2)}
                rx={10}
                ry={10}
                fill="var(--tone)"
                fillOpacity={0.14}
                stroke="var(--tone)"
                strokeOpacity={0.65}
                // Live data updates stay immediate; animate geometry only when the user explicitly changes the area basis.
                className={cn(
                  animateGeometry
                    ? "transition-[x,y,width,height,fill-opacity,stroke-opacity] duration-(--dur-tween)"
                    : "transition-[fill-opacity,stroke-opacity] duration-(--dur-fast)",
                  "ease-(--ease-out) group-hover/tile:fill-opacity-40",
                )}
                {...datumAttrs(t.field, t.raw, "mb")}
              />
              {named && !compact && (
                <text
                  x={t.x + 14}
                  y={t.y + (large ? 28 : 22)}
                  fontSize={large ? 13 : 11}
                  className="pointer-events-none fill-ink-2 font-mono font-medium"
                >
                  {t.key.length > Math.floor((t.w - 28) / 7.2)
                    ? `${t.key.slice(0, Math.max(3, Math.floor((t.w - 28) / 7.2) - 1))}…`
                    : t.key}
                </text>
              )}
              {compact && (
                <text
                  x={t.x + 14}
                  y={t.y + Math.round(t.h / 2) + 4}
                  fontSize={11}
                  className="pointer-events-none fill-ink-2 font-mono font-medium"
                >
                  {compactLine.length > compactChars ? `${compactLine.slice(0, Math.max(3, compactChars - 1))}…` : compactLine}
                </text>
              )}
              {named && t.h >= 54 && t.w >= 108 && (
                <text
                  x={t.x + 14}
                  y={amountY}
                  fontSize={large ? 27 : medium ? 18 : 15}
                  className="pointer-events-none fill-ink font-medium tnum"
                >
                  {amount}
                </text>
              )}
              {medium && (
                <text x={t.x + 14} y={metaY} fontSize={11} className="pointer-events-none fill-ink-3 tnum">
                  {basis === "used" ? "used memory" : "guaranteed share"}
                  {t.usedPct == null ? "" : ` · ${t.usedPct.toFixed(0)}% of share`}
                </text>
              )}
            </Entity>
          );
        })}
      </svg>
      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 text-small text-ink-3">
        <span>
          <strong className="font-medium text-ink-2">{fmtMB(total)}</strong>
          {basis === "used" ? " used" : " guaranteed"}
        </span>
        <span>
          {shown} of {items.length} leaf {items.length === 1 ? "queue" : "queues"}{" "}
          {basis === "used" ? "using memory" : "with a guaranteed share"}
        </span>
        {basis === "used" && shown < items.length && <span>Zero-use queues have no area</span>}
        <span className="flex items-center gap-1.5">
          Usage vs share:
          {(["ok", "live", "wait", "warn", "fail"] as const).map((tone) => (
            <span key={tone} className="inline-flex items-center gap-1">
              <span aria-hidden="true" className={cn("inline-block size-2 rounded-xs bg-(--tone)", `burrow-tone-${tone}`)} />
              {tone === "ok"
                ? "<50%"
                : tone === "live"
                  ? "50–85%"
                  : tone === "wait"
                    ? "85–100%"
                    : tone === "warn"
                      ? "over share"
                      : "over max"}
            </span>
          ))}
        </span>
      </figcaption>
    </figure>
  );
}

/** Accessible textual twin of the treemap (screen readers + parity coverage of every tile value). */
export function TreemapList({ items }: { items: TreemapItem[] }) {
  const shown = items.filter((i) => i.value > 0);
  return (
    <ul className="sr-only">
      {shown.map((i) => (
        <li key={i.key}>
          <Entity as="span" id={i.key}>
            {i.key}: <Datum field={i.field} raw={i.raw} fmt="mb" />
            {i.usedPct != null ? ` (${fmtInt(i.usedPct)}% of share)` : ""}
          </Entity>
        </li>
      ))}
    </ul>
  );
}
