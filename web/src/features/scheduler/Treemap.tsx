/**
 * Queue treemap — custom SVG (the legacy page uses a canvas in `div#cs`). Tiles are sized by the chosen basis
 * (`used` = used memory, `capacity` = guaranteed share) and dyed by pressure (used ÷ guaranteed share).
 *
 * Parity: each tile is an `Entity` (the queue path) whose rect carries the datum of the value it encodes
 * (rule 2 of docs/contracts/parity-dom.md). Keyboard: tiles are focusable links; the legend is a real list.
 */
import { type ReactNode, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Datum, Entity, datumAttrs } from "~/ui/datum";
import { cn } from "~/lib/cn";
import { useElementWidth } from "~/lib/size";
import { TabContent } from "~/ui/tabs";
import { Tooltip } from "~/ui/tooltip";
import { pressureTone } from "./format";
import { fmtInt, fmtMB } from "~/lib/format";

export interface TreemapItem {
  /** queue path (parity entity key) */
  key: string;
  /** shortest unique queue label shown inside the tile; the full path stays in title/aria and the tail list */
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
    .map((i) => ({ ...i, area: i.value * area }))
    // Extremely small positive values can underflow to zero after scaling; they cannot form a valid treemap tile.
    .filter((i) => i.area > 0);

  const out: TreemapTile[] = [];
  const worst = (row: { area: number }[], side: number): number => {
    const s = row.reduce((a, b) => a + b.area, 0);
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
    // A squarified row runs along the shorter side of the remaining rectangle. On a wide canvas that is a vertical
    // column (tiles stacked down `y`); on a tall canvas it is a horizontal row. Using the longer side here collapses
    // the map into full-width bands and turns small queues into unreadable slivers.
    if (cw >= ch) {
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

/** A map tile must fit its complete short label and value; anything smaller is listed beneath the map instead. */
const READABLE_TILE_H = 54;
const READABLE_TILE_W = 108;
/** Horizontal text inset (14px each side) and the monospace advances the renderer uses to fit text. */
const LABEL_INSET = 28;
const LABEL_ADVANCE = 7.2;
/** The compact one-line name + value band is set a step smaller, so it fits a little more. */
const COMPACT_ADVANCE = 6.2;

/**
 * A tile is readable only when its short label fits whole. Truncating a label can leave two queues with the same
 * visible prefix, which is exactly the ambiguity the smaller-queues list exists to avoid.
 */
export function isReadableTile(tile: { w: number; h: number; key?: string; label?: string }): boolean {
  const label = tile.label ?? tile.key;
  return (
    tile.h >= READABLE_TILE_H &&
    tile.w >= READABLE_TILE_W &&
    (label == null || label.length <= Math.floor((tile.w - LABEL_INSET) / LABEL_ADVANCE))
  );
}

export interface TreemapPartition {
  /** queues that keep a labeled area tile */
  shown: TreemapItem[];
  /** queues too small for a labeled tile, listed beneath the map */
  tail: TreemapItem[];
}

/**
 * Keep the map area-honest and readable. A queue whose tile cannot fit its complete short label and value is removed
 * from the map and listed separately; removing it makes the remaining tiles larger, so the layout is recomputed until
 * every shown tile is readable. The tail is never aggregated or area-inflated — it is a fixed-row list, not a fake tile.
 */
export function splitReadable(items: TreemapItem[], width: number, height: number): TreemapPartition {
  let shown = items.filter((item) => item.value > 0).sort((a, b) => b.value - a.value);
  const tail: TreemapItem[] = [];
  while (shown.length > 1) {
    const unreadable = squarify(shown, 0, 0, width, height).filter((tile) => !isReadableTile(tile));
    if (unreadable.length === 0) break;
    const smallest = unreadable.sort((a, b) => a.value - b.value)[0]!;
    tail.push(shown.find((item) => item.key === smallest.key)!);
    shown = shown.filter((item) => item.key !== smallest.key);
  }
  tail.sort((a, b) => b.value - a.value);
  return { shown, tail };
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
  contentIdentity = basis,
  children,
}: {
  items: TreemapItem[];
  /** what the tile area means — shown in the legend so the picture is never ambiguous */
  basis: "used" | "capacity";
  height?: number;
  label: string;
  className?: string;
  animateGeometry?: boolean;
  contentIdentity?: string;
  children?: ReactNode;
}) {
  const navigate = useNavigate();
  const [boxRef, width] = useElementWidth<HTMLDivElement>(VIEW_W);
  const mapHeight = height ?? Math.max(MIN_VIEW_H, Math.min(MAX_VIEW_H, Math.round(width * 0.32)));
  const { shown: mapItems, tail } = useMemo(() => splitReadable(items, width, mapHeight), [items, width, mapHeight]);
  const tiles = useMemo(() => squarify(mapItems, 0, 0, width, mapHeight), [mapItems, width, mapHeight]);
  const shown = tiles.length;
  const total = items.reduce((sum, item) => sum + (item.value > 0 ? item.value : 0), 0);
  const tailTotal = tail.reduce((sum, item) => sum + item.value, 0);
  const zeroUse = items.filter((item) => item.value <= 0).length;
  const go = (key: string) => void navigate({ to: "/scheduler/$queue", params: { queue: key } });
  const tailNote = tail.length > 0 ? ` ${tail.length} smaller ${tail.length === 1 ? "queue is" : "queues are"} listed under the map.` : "";

  return (
    <figure ref={boxRef} className={cn("m-0 flex flex-col gap-2", className)}>
      <TabContent value={contentIdentity} className="relative flex flex-col gap-2">
        <svg
          role="img"
          aria-label={`${label}. Tiles are sized by ${basis === "used" ? "used memory" : "guaranteed share"} and colored by usage versus share. ${shown} of ${items.length} leaf queues with a nonzero value shown.${tailNote}`}
          viewBox={`0 0 ${width} ${mapHeight}`}
          /* the pane's own height: the width follows the container, and the viewBox matches it so nothing scales */
          style={{ height: mapHeight }}
          className="burrow-treemap block w-full overflow-hidden rounded-lg border border-seam bg-well"
          data-basis-transition={animateGeometry}
          preserveAspectRatio="none"
        >
          {tiles.map((t) => {
            const tone = pressureTone(t.usedPct);
            const name = t.label ?? t.key;
            const large = t.w >= 190 && t.h >= 128;
            const medium = t.w >= 148 && t.h >= 82;
            /* keep small slivers to one line; give larger tiles a name, value, and pressure cue */
            const named = medium || (t.w > 100 && t.h > 15);
            const compact = named && t.h < 54 && t.h >= 22 && t.w >= 160;
            const amount = fmtMB(t.value);
            // Tall tiles anchor their value to the bottom so columns of similar area share one baseline; short rows
            // keep the value under the name. Without this, a tall-but-narrow column leaves a large empty middle.
            const amountY = t.h >= 128 ? t.y + t.h - 42 : medium ? t.y + 53 : t.y + 41;
            const metaY = amountY + (large ? 17 : 15);
            const compactLine = `${name} · ${amount}`;
            const labelChars = Math.floor((t.w - LABEL_INSET) / LABEL_ADVANCE);
            const compactChars = Math.floor((t.w - LABEL_INSET) / COMPACT_ADVANCE);
            const tooltip = (
              <>
                <span className="block font-mono wrap-anywhere">{t.key}</span>
                <span className="mt-0.5 block tnum">{amount}</span>
                {t.sub && <span className="mt-0.5 block text-ink-3">{t.sub}</span>}
              </>
            );
            return (
              <Tooltip key={t.key} label={tooltip}>
                <Entity
                  as="g"
                  id={t.key}
                  role="link"
                  tabIndex={0}
                  aria-label={`${t.key}: ${amount} ${basis === "used" ? "used" : "guaranteed"}; ${t.sub ?? ""}`}
                  className={cn(`burrow-tone-${tone}`, "group/tile cursor-pointer outline-offset-2")}
                  onClick={() => go(t.key)}
                  onKeyDown={(e: React.KeyboardEvent) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      go(t.key);
                    }
                  }}
                >
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
                      "ease-out group-hover/tile:fill-opacity-40",
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
                      {name.length > labelChars ? `${name.slice(0, Math.max(3, labelChars - 1))}…` : name}
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
                      {t.usedPct == null ? "share not reported" : `${t.usedPct.toFixed(0)}% of share`}
                    </text>
                  )}
                </Entity>
              </Tooltip>
            );
          })}
        </svg>
        {children}
        {tail.length > 0 && (
          <div className="flex min-w-0 flex-col gap-1.5" data-burrow-treemap-tail>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-small">
              <span className="font-medium text-ink-2">Smaller queues</span>
              <span className="tnum text-ink-3">
                {tail.length} {tail.length === 1 ? "queue" : "queues"} · {fmtMB(tailTotal)}
              </span>
            </div>
            <ul className="burrow-scroll grid max-h-48 grid-cols-[repeat(auto-fit,minmax(18rem,1fr))] gap-1 overflow-y-auto">
              {tail.map((t) => {
                const tone = pressureTone(t.usedPct);
                const amount = fmtMB(t.value);
                return (
                  <Entity key={t.key} as="li" id={t.key} className="min-w-0">
                    <button
                      type="button"
                      onClick={() => go(t.key)}
                      aria-label={`${t.key}: ${amount} ${basis === "used" ? "used" : "guaranteed"}${
                        t.usedPct == null ? "" : `, ${t.usedPct.toFixed(0)}% of guaranteed share`
                      }. Open queue.`}
                      className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-md border border-seam-soft bg-fabric px-2 text-left text-small transition-colors duration-(--dur-fast) ease-out hover:bg-fabric-3 sm:min-h-9"
                    >
                      <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-xs bg-(--tone)", `burrow-tone-${tone}`)} />
                      <span className="min-w-0 flex-1 truncate font-mono text-ink-2">{t.key}</span>
                      <span className="shrink-0 tnum text-ink-3">
                        <Datum field={t.field} raw={t.raw} fmt="mb" />
                      </span>
                      {t.usedPct != null && (
                        <span className="w-9 shrink-0 text-right text-micro tnum text-ink-3">{t.usedPct.toFixed(0)}%</span>
                      )}
                    </button>
                  </Entity>
                );
              })}
            </ul>
          </div>
        )}
      </TabContent>
      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 text-small text-ink-3">
        <span>
          <strong className="font-medium text-ink-2">{fmtMB(total)}</strong>
          {basis === "used" ? " used" : " guaranteed"}
        </span>
        <span>
          {shown} of {items.length} leaf {items.length === 1 ? "queue" : "queues"}{" "}
          {tail.length > 0 ? "shown by area" : basis === "used" ? "using memory" : "with a guaranteed share"}
        </span>
        {basis === "used" && zeroUse > 0 && <span>Zero-use queues have no area</span>}
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
