/**
 * SVG node renderers.
 *
 * One component per node *kind*, all driven by a `NodeVisual` (see `render/scene.ts`) so there is no logic in the
 * markup. Nodes are `role="treeitem"` with an aria-label and a roving tabindex; the container owns `role="tree"`.
 * Everything is a plain SVG element — no foreignObject, no filters, no per-node gradient — because those are what
 * make 300-node DAGs drop frames.
 */
import { memo } from "react";
import { NodeStatusGlyph } from "./glyph";
import { nodePad, nodeRowGeometry, textColumnStart } from "../render/scene";
import type { NodeVisual } from "../render/scene";
import type { LabelPlacement } from "../render/labels";
import { ellipsize } from "../render/labels";

const RADIUS = 12;
const SPINE_W = 3;

export interface NodeProps {
  visual: NodeVisual;
  /** label placements for this node's id (already collision-resolved) */
  labels: LabelPlacement[];
  /** roving tabindex: exactly one node is tabbable, the focused one (or the first) */
  tabbable: boolean;
  onActivate: (visual: NodeVisual) => void;
  onHover: (id: string | null) => void;
  onFocus: (id: string) => void;
  /** draw visual children only when the node intersects the viewport */
  visible?: boolean;
  /** suppress all text (canvas-degraded mode) */
  textOnly?: boolean;
}

function ProgressRow({
  visual,
  barX,
  barY,
  barW,
  barH,
  draw,
}: {
  visual: NodeVisual;
  barX: number;
  barY: number;
  barW: number;
  barH: number;
  draw: boolean;
}) {
  const total = visual.segments.reduce((a, s) => a + s.percent, 0);
  const hasProgress = visual.taskSummary !== null || visual.segments.length > 0;
  /** undefined leaves the stylesheet's `--dur-slow` in charge (no plan entry: nothing moved) */
  const tweenDuration = visual.tweenMs > 0 ? `${visual.tweenMs}ms` : undefined;
  const scale = draw && total > 0 ? barW / total : 0;
  let x = barX;
  const valueText = visual.segments.map((s) => `${s.label} ${s.percent.toFixed(0)}%`).join(", ");
  return (
    // biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: an SVG <g> is not interactive; role="progressbar" is what makes the bar readable by AT.
    <g
      className="burrow-dag-progress"
      role="progressbar"
      aria-label={`${visual.node.label} task progress`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(visual.percent)}
      aria-valuetext={valueText || undefined}
    >
      {draw && hasProgress ? (
        <rect className="burrow-dag-progress-track" x={barX} y={barY} width={barW} height={barH} rx={barH / 2} />
      ) : null}
      {draw
        ? visual.segments.map((s) => {
            const w = Math.max(0, s.percent * scale);
            // A 1-unit-wide rect positioned and sized purely by transform: a progress tick is then transform-only
            // (DESIGN §7.5) instead of a width change that forces SVG layout work on every segment of every node.
            const seg = (
              <rect
                key={s.label}
                className="burrow-dag-progress-seg"
                data-tone={s.tone}
                data-extent={w.toFixed(2)}
                x={0}
                y={barY}
                width={1}
                height={barH}
                // the diff plan decides how long this tick takes (a jump to 60 % reads as a catch-up, a 2 % tick as a nudge):
                // the property is still `transform`, only its duration is per-tick
                style={{ transform: `translateX(${x.toFixed(2)}px) scaleX(${w.toFixed(3)})`, transitionDuration: tweenDuration }}
              >
                <title>{s.label}</title>
              </rect>
            );
            x += w;
            return seg;
          })
        : null}
      {draw && visual.segments.length === 0 && visual.percent > 0 ? (
        <rect
          className="burrow-dag-progress-seg"
          data-tone={visual.tone}
          x={0}
          y={barY}
          width={1}
          height={barH}
          style={{
            transform: `translateX(${barX}px) scaleX(${((visual.percent / 100) * barW).toFixed(3)})`,
            transitionDuration: tweenDuration,
          }}
        />
      ) : null}
    </g>
  );
}

function badgeSummary(visual: NodeVisual): string | null {
  const values = visual.badges
    .filter((badge) => badge.key !== "dur" && badge.key !== "metrics")
    .map((badge) => {
      if (badge.key === "sw" || badge.key === "sr") {
        const name = badge.title?.toLowerCase() ?? "shuffle";
        return `${name} · ${badge.text.replace(/^[↑↓]\s*/, "")}`;
      }
      return badge.text;
    });
  return values.length > 0 ? values.join(" · ") : null;
}

function taskSummary(visual: NodeVisual): string | null {
  return visual.taskSummary?.replace(" tasks", " complete") ?? null;
}

function partitionSummary(visual: NodeVisual): string | null {
  if (visual.node.kind !== "rdd" || !visual.taskSummary) return null;
  const total = /\/\s*([\d,]+)\s+tasks\b/.exec(visual.taskSummary)?.[1];
  return total ? `${total} partitions` : null;
}

function Hatch({ visual }: { visual: NodeVisual }) {
  const { width, height } = visual.rect;
  const step = 7;
  const lines: string[] = [];
  for (let x = -height; x < width; x += step) lines.push(`M ${x} ${height} L ${x + height} 0`);
  return <path className="burrow-dag-node-hatch" d={lines.join(" ")} />;
}

/** Shallow structural comparison of a segment list (one per task state). */
function sameSegments(a: NodeVisual["segments"], b: NodeVisual["segments"]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.percent !== y.percent || x.tone !== y.tone || x.label !== y.label) return false;
  }
  return true;
}

/** Badge lists are tiny (0-5), so a field compare is cheaper than any hashing. */
function sameBadges(a: NodeVisual["badges"], b: NodeVisual["badges"]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.key !== y.key || x.text !== y.text || x.tone !== y.tone) return false;
  }
  return true;
}

function sameLabels(a: readonly LabelPlacement[], b: readonly LabelPlacement[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.id !== y.id || x.text !== y.text || x.x !== y.x || x.y !== y.y) return false;
  }
  return true;
}

/**
 * Custom comparator: a progress tick rebuilds every visual, but only the nodes that actually changed should re-render.
 * With a live stream that is typically the one or two running stages, not all 300 nodes — the difference between
 * ~2 ms and ~20 ms of React work per tick.
 */
function sameNodeProps(prev: NodeProps, next: NodeProps): boolean {
  if (prev.tabbable !== next.tabbable || (prev.visible ?? true) !== (next.visible ?? true)) return false;
  if (!sameLabels(prev.labels, next.labels)) return false;
  const a = prev.visual;
  const b = next.visual;
  if (a === b) return true;
  if (
    a.tone !== b.tone ||
    a.status !== b.status ||
    a.running !== b.running ||
    a.skipped !== b.skipped ||
    a.selected !== b.selected ||
    a.hovered !== b.hovered ||
    a.dimmed !== b.dimmed ||
    a.flash !== b.flash ||
    a.percent !== b.percent ||
    a.taskSummary !== b.taskSummary ||
    a.subText !== b.subText ||
    a.ariaLabel !== b.ariaLabel ||
    a.rect.x !== b.rect.x ||
    a.rect.y !== b.rect.y ||
    a.rect.width !== b.rect.width ||
    a.rect.height !== b.rect.height
  ) {
    return false;
  }
  return sameSegments(a.segments, b.segments) && sameBadges(a.badges, b.badges);
}

export const DagNode = memo(function DagNode({ visual, labels, tabbable, onActivate, onHover, onFocus, visible = true }: NodeProps) {
  const { node, rect } = visual;
  const title = labels.find((l) => l.id.endsWith("#title"));
  const sub = labels.find((l) => l.id.endsWith("#sub"));
  const compact = rect.height < 72;
  const roomy = rect.height >= 144;
  const subText = sub && visual.subText ? ellipsize(visual.subText, compact ? 10.5 : roomy ? 14 : 12.5, sub.width) : null;
  const kind = node.kind;
  const pad = nodePad(kind);
  // The status glyph owns the node's top-left corner (DESIGN §7.2); text starts after it.
  const glyphX = pad;
  const glyphY = kind === "rdd" ? 7 : 8;
  const textPad = textColumnStart(kind);
  const titleSize = compact ? 12.5 : roomy ? 18 : 14.5;
  const row = nodeRowGeometry(rect.height, kind);
  const titleY = row.titleY;
  const progressY = row.progressY;
  const progressH = 7;
  const facts = [visual.subText ? null : partitionSummary(visual), badgeSummary(visual)]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
  const summary = taskSummary(visual);
  const firstMeta = visual.subText ? null : facts || summary;
  const secondMeta = visual.subText
    ? facts || (visual.subText !== visual.taskSummary ? summary : null)
    : facts && summary !== facts
      ? summary
      : null;
  const metaUsable = Math.max(0, rect.width - textPad - pad);
  const metaText = (value: string | null) => (value ? ellipsize(value, roomy ? 12.5 : 10.5, metaUsable) : null);
  const firstMetaText = compact ? null : metaText(firstMeta);
  const secondMetaText = metaText(secondMeta);

  return (
    <g
      className="burrow-dag-node"
      role="treeitem"
      aria-level={visual.depth}
      aria-selected={visual.selected}
      aria-label={visual.ariaLabel}
      tabIndex={tabbable ? 0 : -1}
      data-node-id={node.id}
      data-kind={kind}
      data-compact={compact ? "true" : undefined}
      data-roomy={roomy ? "true" : "false"}
      data-tone={visual.tone}
      data-status={visual.status.toLowerCase()}
      data-running={visual.running}
      data-cached={node.cached === true}
      data-skipped={visual.skipped}
      data-selected={visual.selected}
      data-hovered={visual.hovered}
      data-dimmed={visual.dimmed}
      transform={`translate(${rect.x} ${rect.y})`}
      onPointerEnter={() => onHover(node.id)}
      onPointerLeave={() => onHover(null)}
      onFocus={() => onFocus(node.id)}
      onClick={(e) => {
        e.stopPropagation();
        onActivate(visual);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          onActivate(visual);
        }
      }}
    >
      <title>{visual.node.detail ? `${visual.ariaLabel}\nPlan line: ${visual.node.detail}` : visual.ariaLabel}</title>
      {visible ? (
        <>
          <rect
            className={`burrow-tone-${visual.tone}`}
            data-role="flash-layer"
            width={rect.width}
            height={rect.height}
            rx={RADIUS}
            fill="transparent"
          />
          {visual.flash ? (
            <rect
              className={`burrow-dag-flash burrow-tone-${visual.flash}`}
              data-flash="true"
              width={rect.width}
              height={rect.height}
              rx={RADIUS}
            />
          ) : null}
          <rect className="burrow-dag-node-body" width={rect.width} height={rect.height} rx={RADIUS} />
          <rect
            className={`burrow-dag-node-spine burrow-tone-${visual.tone}`}
            width={SPINE_W}
            height={rect.height - 12}
            x={0}
            y={6}
            rx={1.5}
          />
          {visual.running ? (
            <>
              <rect className="burrow-dag-node-shimmer" x={SPINE_W} y={0} width={Math.max(24, rect.width * 0.35)} height={rect.height} />
              <Hatch visual={visual} />
            </>
          ) : null}
          {title ? (
            <text className="burrow-dag-title" x={textPad} y={titleY} fontSize={titleSize} data-label="title">
              <title>{node.label}</title>
              {title.text}
            </text>
          ) : null}
          {subText ? (
            <text className="burrow-dag-sub" x={textPad} y={row.subY} data-label="sub">
              {visual.subText && visual.subText !== subText ? <title>{visual.subText}</title> : null}
              {subText}
            </text>
          ) : null}
          {firstMetaText ? (
            <text className="burrow-dag-meta" x={textPad} y={row.subY} data-row="metadata-primary">
              {firstMeta && firstMeta !== firstMetaText ? <title>{firstMeta}</title> : null}
              {firstMetaText}
            </text>
          ) : null}
          {secondMetaText && row.metaY > 0 ? (
            <text className="burrow-dag-meta" x={textPad} y={row.metaY} data-row="metadata-secondary">
              {secondMeta && secondMeta !== secondMetaText ? <title>{secondMeta}</title> : null}
              {secondMetaText}
            </text>
          ) : null}
        </>
      ) : null}
      <NodeStatusGlyph shape={visual.statusShape} tone={visual.tone} x={glyphX} y={glyphY} title={visual.statusLabel} />
      {kind === "ghost" ? null : (
        <ProgressRow visual={visual} barX={28} barY={progressY} barW={Math.max(20, rect.width - 56)} barH={progressH} draw={visible} />
      )}
    </g>
  );
}, sameNodeProps);

/** Edge hit targets live in `edges.tsx`; this is the drawing surface for one cluster's frame + label. */
export const ClusterFrame = memo(function ClusterFrame({
  x,
  y,
  width,
  height,
  label,
  detail,
  depth,
  dimmed,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  detail?: string;
  depth: number;
  dimmed: boolean;
}) {
  return (
    // biome-ignore lint/a11y/noAriaHiddenOnFocusable: cluster frames are decoration; the nodes inside carry the a11y tree.
    <g className="burrow-dag-cluster-group" data-depth={depth} data-dimmed={dimmed} aria-hidden="true">
      <rect className="burrow-dag-cluster" data-depth={depth} data-dimmed={dimmed} x={x} y={y} width={width} height={height} rx={10} />
      {detail ? <title>{`${label} · ${detail}`}</title> : null}
      <text className="burrow-dag-cluster-label" x={x + 10} y={y + 19}>
        {label}
      </text>
    </g>
  );
});
