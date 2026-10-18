/**
 * DAG chrome: toolbar, legend, minimap, drawers, empty/loading/error states and the keyboard-accessible edge list.
 *
 * The drawers are where parity lives: every numeric row is a `<Datum>` stamped with the *upstream* key that produced
 * it (`spark.stage.<key>`), so the harness can read the value straight off the DOM (docs/contracts/parity-dom.md).
 * Only keys that exist in the payload are rendered — nothing is invented, so "no key left behind" stays checkable.
 */
import { Minus, Plus, Maximize2, Download, PanelRightClose, Crosshair, ChevronDown } from "lucide-react";
import { Fragment, memo, useEffect, useRef, useState } from "react";
import { Button } from "~/ui/button";
import { Entity, Datum } from "~/ui/datum";
import { StatusPill } from "~/ui/status";
import { Tooltip, OptionalTooltip } from "~/ui/tooltip";
import { MenuItem } from "~/ui/menu";
import { normalizeSegments } from "~/ui/progress-bar";
import { fmtBytes, fmtDuration, fmtInt, fmtPct } from "~/lib/format";
import type { Fmt } from "~/lib/format";
import type { StageMetric } from "../metrics";
import { progressSegments, stageProgress, stageDuration, stageStatusKey } from "../metrics";
import type { EdgeVisual, NodeVisual, Scene } from "../render/scene";
import type { GraphNode } from "../types";
import type { MinimapProjection } from "../render/viewport";

// ---------------------------------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------------------------------

export interface ToolbarProps {
  scale: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  onExportHtml: () => void;
  exporting: boolean;
  totals: Scene["totals"];
  percent: number;
  /** layout diagnostics, e.g. "worker · 42 ms" */
  layoutNote: string;
  nodeCount: number;
  edgeCount: number;
  focusStageId?: number | null;
  onFocusStage?: () => void;
  trailingControls?: React.ReactNode;
}

export function DagToolbar({
  scale,
  onZoomIn,
  onZoomOut,
  onFit,
  onExportHtml,
  exporting,
  totals,
  percent,
  layoutNote,
  nodeCount,
  edgeCount,
  focusStageId,
  onFocusStage,
  trailingControls,
}: ToolbarProps) {
  return (
    <div className="burrow-dag-toolbar" role="toolbar" aria-label="DAG view controls">
      <Tooltip label="Fit graph to view (0)">
        <Button size="icon-sm" variant="ghost" aria-label="Fit graph to view" onClick={onFit}>
          <Maximize2 className="size-3.5" aria-hidden="true" />
        </Button>
      </Tooltip>
      <Tooltip label="Zoom out (−)">
        <Button size="icon-sm" variant="ghost" aria-label="Zoom out" onClick={onZoomOut}>
          <Minus className="size-3.5" aria-hidden="true" />
        </Button>
      </Tooltip>
      {focusStageId != null && onFocusStage ? (
        <Tooltip label={`Focus stage ${focusStageId} at a readable scale`}>
          <Button
            size="sm"
            variant="ghost"
            className="burrow-dag-focus-stage"
            aria-label={`Focus stage ${focusStageId}`}
            onClick={onFocusStage}
          >
            <Crosshair className="size-3.5" aria-hidden="true" />
            <span>Focus stage {focusStageId}</span>
          </Button>
        </Tooltip>
      ) : null}
      <OptionalTooltip label={"Scroll to zoom · Shift+scroll to scroll the page"}>
        <span className="mono px-0.5 text-micro text-ink-3 tabular-nums" data-testid="dag-zoom">
          {fmtPct(scale * 100, 0)}
        </span>
      </OptionalTooltip>
      <Tooltip label="Zoom in (+)">
        <Button size="icon-sm" variant="ghost" aria-label="Zoom in" onClick={onZoomIn}>
          <Plus className="size-3.5" aria-hidden="true" />
        </Button>
      </Tooltip>
      <Tooltip label={exporting ? "Preparing interactive DAG snapshot" : "Download interactive DAG snapshot (HTML)"}>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={exporting ? "Preparing interactive DAG snapshot" : "Download interactive DAG snapshot (HTML)"}
          onClick={onExportHtml}
          disabled={exporting}
        >
          <Download className="size-3.5" aria-hidden="true" />
        </Button>
      </Tooltip>
      <span className="burrow-dag-toolbar-summary ml-1 hidden text-micro text-ink-3 sm:inline">
        {fmtInt(totals.done)}/{fmtInt(totals.total)} tasks · {fmtPct(percent, 0)} · {nodeCount} nodes / {edgeCount} edges
        <span className="ml-1 text-ink-4">· {layoutNote}</span>
      </span>
      {trailingControls}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------------------------------

const LEGEND_TONES: { tone: string; label: string }[] = [
  { tone: "ok", label: "complete" },
  { tone: "live", label: "active" },
  { tone: "wait", label: "pending" },
  { tone: "fail", label: "failed" },
  { tone: "idle", label: "skipped / idle" },
  { tone: "fresh", label: "cached RDD" },
];

export function DagLegend({ showFlow = true, inferred = false }: { showFlow?: boolean; inferred?: boolean }) {
  return (
    <div className="burrow-dag-legend" aria-hidden="true">
      {LEGEND_TONES.map((t) => (
        <span key={t.tone} className="burrow-dag-legend-item">
          <span className={`burrow-dag-legend-swatch burrow-tone-${t.tone}`} />
          {t.label}
        </span>
      ))}
      {showFlow ? (
        <span className="burrow-dag-legend-item">
          <span className="burrow-dag-legend-dash" />
          data flowing now
        </span>
      ) : null}
      <span className="burrow-dag-legend-item">▤ barrier · ◌ indeterminate</span>
      {inferred ? (
        <span className="burrow-dag-legend-item burrow-dag-legend-note">
          <span className="burrow-dag-legend-hatch" />
          edges inferred (REST only)
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------
// Minimap
// ---------------------------------------------------------------------------------------------------

export interface MinimapProps {
  nodes: readonly NodeVisual[];
  width: number;
  height: number;
  contentWidth: number;
  contentHeight: number;
  projection: MinimapProjection;
  viewRect: { x: number; y: number; width: number; height: number };
  onPick: (worldX: number, worldY: number) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}
function sameMinimapProps(prev: MinimapProps, next: MinimapProps): boolean {
  if (
    prev.width !== next.width ||
    prev.height !== next.height ||
    prev.contentWidth !== next.contentWidth ||
    prev.contentHeight !== next.contentHeight ||
    prev.projection !== next.projection ||
    prev.viewRect.x !== next.viewRect.x ||
    prev.viewRect.y !== next.viewRect.y ||
    prev.viewRect.width !== next.viewRect.width ||
    prev.viewRect.height !== next.viewRect.height ||
    prev.onPick !== next.onPick ||
    prev.onDragStart !== next.onDragStart ||
    prev.onDragEnd !== next.onDragEnd
  ) {
    return false;
  }
  if (prev.nodes === next.nodes) return true;
  if (prev.nodes.length !== next.nodes.length) return false;
  for (let i = 0; i < prev.nodes.length; i += 1) {
    const a = prev.nodes[i]!;
    const b = next.nodes[i]!;
    if (
      a.node.id !== b.node.id ||
      a.tone !== b.tone ||
      a.rect.x !== b.rect.x ||
      a.rect.y !== b.rect.y ||
      a.rect.width !== b.rect.width ||
      a.rect.height !== b.rect.height
    ) {
      return false;
    }
  }
  return true;
}

export const DagMinimap = memo(function DagMinimap({
  nodes,
  width,
  height,
  contentWidth,
  contentHeight,
  projection,
  viewRect,
  onPick,
  onDragStart,
  onDragEnd,
}: MinimapProps) {
  const toMini = (x: number, y: number) => ({
    x: x * projection.scale + projection.offsetX,
    y: y * projection.scale + projection.offsetY,
  });
  const scale = Math.max(projection.scale, 0.001);
  const view = toMini(viewRect.x, viewRect.y);
  const pick = (e: React.PointerEvent<SVGSVGElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    onPick((mx - projection.offsetX) / scale, (my - projection.offsetY) / scale);
  };
  return (
    <svg
      className="burrow-dag-minimap"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Graph minimap: ${nodes.length} nodes; drag to pan`}
      data-testid="dag-minimap"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        onDragStart();
        pick(e);
      }}
      onPointerMove={(e) => {
        if (e.buttons === 0) return;
        pick(e);
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        onDragEnd();
      }}
    >
      <rect x={0} y={0} width={width} height={height} fill="var(--well)" opacity={0.001} />
      {nodes.map((n) => {
        const p = toMini(n.rect.x, n.rect.y);
        return (
          <rect
            key={n.node.id}
            className="burrow-dag-minimap-node"
            data-tone={n.tone}
            x={p.x}
            y={p.y}
            width={Math.max(1, n.rect.width * scale)}
            height={Math.max(1, n.rect.height * scale)}
            rx={0.5}
          />
        );
      })}
      <rect
        className="burrow-dag-minimap-view"
        x={Math.max(0, view.x)}
        y={Math.max(0, view.y)}
        width={Math.min(width - Math.max(0, view.x), Math.max(4, viewRect.width * scale))}
        height={Math.min(height - Math.max(0, view.y), Math.max(4, viewRect.height * scale))}
      />
      <title>{`Minimap: ${nodes.length} nodes in ${Math.round(contentWidth)}×${Math.round(contentHeight)} world px`}</title>
    </svg>
  );
}, sameMinimapProps);

// ---------------------------------------------------------------------------------------------------
// Drawers
// ---------------------------------------------------------------------------------------------------

function useDrawerScrollCue<T extends HTMLElement>(open: boolean, contentKey: string) {
  const ref = useRef<T | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const drawer = ref.current;
    if (!drawer || !open) {
      setVisible(false);
      return;
    }

    const update = () => {
      const hasMore = drawer.scrollHeight > drawer.clientHeight + 3 && drawer.scrollTop + drawer.clientHeight < drawer.scrollHeight - 3;
      setVisible(hasMore);
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(drawer);
    if (drawer.firstElementChild) observer?.observe(drawer.firstElementChild);
    const mutations = new MutationObserver(update);
    mutations.observe(drawer, { childList: true, characterData: true, subtree: true });
    drawer.addEventListener("scroll", update, { passive: true });
    const frame = requestAnimationFrame(update);

    return () => {
      cancelAnimationFrame(frame);
      drawer.removeEventListener("scroll", update);
      observer?.disconnect();
      mutations.disconnect();
    };
  }, [open, contentKey]);

  return { ref, visible };
}

function DrawerScrollCue({ visible }: { visible: boolean }) {
  return (
    <div className="burrow-dag-scroll-cue" data-visible={visible} aria-hidden="true">
      <span>Scroll for more details</span>
      <ChevronDown className="size-3" />
    </div>
  );
}

/** Human label for a REST key: `numCompleteTasks` → "Num complete tasks", `shuffleReadBytes` → "Shuffle read bytes". */
export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replace(/\s+/g, " ")
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/** Units come from the upstream key name; only used for display, never for `data-yv`. */
export function fmtForKey(key: string, value: unknown): { text: string; fmt: Fmt } {
  const n = typeof value === "number" ? value : Number.NaN;
  if (key.endsWith("Bytes") || key === "resultSize" || key === "peakExecutionMemory") {
    return { text: fmtBytes(n), fmt: "bytes" };
  }
  if (key.endsWith("Time") || key === "duration") return { text: fmtDuration(n), fmt: "dur" };
  if (key.endsWith("Records") || key.endsWith("Tasks") || key === "stageId" || key === "attemptId" || key.endsWith("Indices")) {
    return { text: fmtInt(n), fmt: "int" };
  }
  return { text: typeof value === "number" ? fmtInt(n) : String(value), fmt: "text" };
}

export interface StageDrawerProps {
  open: boolean;
  onClose: () => void;
  node: NodeVisual | null;
  metric: StageMetric | null;
  now: number;
  /** link to the Spark stage page (provided by the embedding route) */
  stageHref?: string | null;
  /** link to the Spark RDD page */
  rddHref?: string | null;
  /** the node's RDD chain (job DAG: the stage's RDDs) */
  chain: readonly GraphNode[];
}

export function StageDrawer({ open, onClose, node, metric, now, stageHref, rddHref, chain }: StageDrawerProps) {
  const progress = metric ? stageProgress(metric) : null;
  const segments = progress ? progressSegments(progress) : [];
  const normalizedSegments = normalizeSegments(segments);
  const duration = stageDuration(metric ?? undefined, now);
  const raw = metric?.raw ?? {};
  const rawKeys = Object.keys(raw).filter((k) => {
    const v = raw[k];
    return typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null;
  });
  /**
   * SQL plan operators carry their own accumulables and have no stage to join against, so the drawer falls back to
   * the plan's own metric list. Stage joins stay the first source: a node that has one renders exactly as before.
   */
  const sqlMetrics = node?.node.kind === "sql" ? (node.node.metrics ?? []) : [];
  const showSqlMetrics = !metric && sqlMetrics.length > 0;
  const entityKey = metric ? `${metric.stageId}/${metric.attemptId}` : "";
  const scrollCue = useDrawerScrollCue<HTMLElement>(open, `${node?.node.id ?? ""}|${rawKeys.length}|${chain.length}|${sqlMetrics.length}`);
  return (
    <aside
      ref={scrollCue.ref}
      className="burrow-dag-drawer burrow-scroll burrow-table-scroll"
      data-open={open}
      aria-hidden={!open}
      tabIndex={open ? 0 : -1}
      aria-label={node ? `Details for ${node.node.label}` : "Stage details"}
      data-testid="dag-drawer"
      data-scroll-cue={scrollCue.visible}
    >
      {node ? (
        <Entity id={entityKey} className="flex w-full min-w-0 flex-col gap-3 p-3">
          <header className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 className="break-words text-lead font-semibold text-ink">{node.node.label}</h2>
              <p className="truncate text-caption text-ink-3">
                {node.node.kind === "sql"
                  ? "physical operator"
                  : node.node.stageId != null
                    ? `stage ${node.node.stageId} · attempt ${node.node.attempt ?? 0}`
                    : node.node.kind}
              </p>
            </div>
            <Button size="icon-sm" variant="ghost" aria-label="Close details" title="Close details" onClick={onClose}>
              <PanelRightClose className="size-3.5" aria-hidden="true" />
            </Button>
          </header>

          {metric ? (
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill domain="spark.stage" state={stageStatusKey(metric, node.skipped)} size="sm" />
              {duration != null ? (
                <span className="text-caption text-ink-3">
                  <Datum field="spark.stage.derived.durationText" raw={duration} fmt="dur" />
                </span>
              ) : null}
              {metric.numFailedTasks > 0 ? (
                <span className="text-caption text-fail">
                  <Datum field="spark.stage.numFailedTasks" raw={metric.numFailedTasks} fmt="int" /> failed
                </span>
              ) : null}
            </div>
          ) : showSqlMetrics ? null : (
            <p className="text-caption text-ink-3">
              {node.node.kind === "sql"
                ? "This operator reports no accumulables in the plan JSON."
                : `No REST metrics for this ${node.node.kind === "stage" ? "stage" : "node"} yet — the graph is rendered from the DOT payload only.`}
            </p>
          )}

          {segments.length > 0 ? (
            <div className="flex flex-col gap-1">
              <div
                className="burrow-thread flex gap-px"
                data-segments="true"
                role="progressbar"
                aria-label={`Stage ${metric?.stageId ?? ""} task progress`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress?.percent ?? 0)}
                aria-valuetext={normalizedSegments.map((s) => `${s.label} ${s.percent.toFixed(0)}%`).join(", ")}
              >
                {normalizedSegments.map((s) => (
                  <OptionalTooltip key={s.label} label={`${s.label}: ${s.percent.toFixed(1)}%`}>
                    <span className={`block h-full burrow-tone-${s.tone} bg-(--tone)`} style={{ width: `${Math.max(0, s.percent)}%` }} />
                  </OptionalTooltip>
                ))}
              </div>
              <p className="text-micro text-ink-3">
                {progress ? `${fmtInt(progress.done)} of ${fmtInt(progress.total)} tasks complete` : null}
                {progress && progress.active > 0 ? ` · ${fmtInt(progress.active)} running` : null}
                {progress && progress.pending > 0 ? ` · ${fmtInt(progress.pending)} pending` : null}
                {progress && progress.failed > 0 ? ` · ${fmtInt(progress.failed)} failed` : null}
              </p>
            </div>
          ) : null}

          {chain.length > 0 ? (
            <section className="flex flex-col gap-1">
              <h3 className="text-caption font-semibold text-ink-2">RDD chain ({chain.length})</h3>
              <ol className="flex flex-col gap-0.5">
                {chain.map((n) => (
                  <li key={n.id} className="flex items-center justify-between gap-2 text-caption text-ink-3">
                    <span className="truncate">
                      {n.label}
                      {n.cached ? " (cached)" : ""}
                    </span>
                    <span className="mono shrink-0 text-micro text-ink-4">{n.ref}</span>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          {rawKeys.length > 0 ? (
            <section className="flex flex-col gap-1">
              <h3 className="text-caption font-semibold text-ink-2">Stage metrics (upstream keys)</h3>
              <table className="burrow-dag-measure-table">
                <tbody>
                  {rawKeys.map((k) => {
                    const { text, fmt } = fmtForKey(k, raw[k]);
                    return (
                      <tr key={k}>
                        <td className="text-caption">{humanizeKey(k)}</td>
                        <td className="text-caption">
                          <Datum field={`spark.stage.${k}`} raw={raw[k]} fmt={fmt}>
                            {text}
                          </Datum>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          ) : null}

          {showSqlMetrics ? (
            <section className="flex flex-col gap-1">
              <h3 className="text-caption font-semibold text-ink-2">SQL plan metrics</h3>
              <p className="text-micro text-ink-3">operator accumulables from the SQL plan — not stage task counters</p>
              <table className="burrow-dag-measure-table">
                <tbody>
                  {sqlMetrics.map((m, i) => (
                    <tr key={`${i}:${m.name}`}>
                      <td className="text-caption">
                        <Datum field={`spark.sql.metrics[${i}].name`} raw={m.name} fmt="text">
                          {m.name}
                        </Datum>
                      </td>
                      <td className="text-caption">
                        <Datum field={`spark.sql.metrics[${i}].value`} raw={m.value} fmt="text">
                          {m.value}
                        </Datum>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}

          {node.node.detail ? (
            <section className="flex flex-col gap-1">
              <h3 className="text-caption font-semibold text-ink-2">Plan line</h3>
              <p className="mono min-w-0 break-words whitespace-pre-line text-micro text-ink-3">{node.node.detail}</p>
            </section>
          ) : null}

          {node.node.callsite ? (
            <section className="flex flex-col gap-1">
              <h3 className="text-caption font-semibold text-ink-2">Callsite</h3>
              <p className="mono break-all text-micro text-ink-3">{node.node.callsite}</p>
            </section>
          ) : null}

          <div className="mt-auto flex flex-wrap gap-2 pt-2">
            {stageHref ? (
              <a className="text-caption text-live underline" href={stageHref}>
                Open stage task list
              </a>
            ) : null}
            {rddHref ? (
              <a className="text-caption text-live underline" href={rddHref}>
                Open RDD storage detail
              </a>
            ) : null}
          </div>
        </Entity>
      ) : null}
      <DrawerScrollCue visible={scrollCue.visible} />
    </aside>
  );
}

export interface EdgeDrawerProps {
  open: boolean;
  onClose: () => void;
  edge: EdgeVisual | null;
  graphKind: "job" | "stage" | "sql";
  metrics: ReadonlyMap<number, StageMetric>;
  producer: NodeVisual | null;
  consumer: NodeVisual | null;
}

export function EdgeDrawer({ open, onClose, edge, graphKind, metrics, producer, consumer }: EdgeDrawerProps) {
  const isPlanDependency = graphKind === "sql" || edge?.edge.kind === "sql";
  const isShuffleEdge = !isPlanDependency && edge?.edge.kind === "cross-stage";
  const from = edge?.edge.fromStage != null ? metrics.get(edge.edge.fromStage) : undefined;
  const to = edge?.edge.toStage != null ? metrics.get(edge.edge.toStage) : undefined;
  const rows: { label: string; field: string; raw: unknown; fmt: Fmt; text: string }[] = [];
  if (isShuffleEdge && from) {
    rows.push(
      {
        label: `Stage ${from.stageId} shuffle write`,
        field: "spark.stage.shuffleWriteBytes",
        raw: from.raw.shuffleWriteBytes,
        fmt: "bytes",
        text: fmtBytes(from.shuffleWriteBytes),
      },
      {
        label: `Stage ${from.stageId} shuffle records written`,
        field: "spark.stage.shuffleWriteRecords",
        raw: from.raw.shuffleWriteRecords,
        fmt: "int",
        text: fmtInt(from.shuffleWriteRecords),
      },
    );
  }
  if (isShuffleEdge && to) {
    rows.push(
      {
        label: `Stage ${to.stageId} shuffle read`,
        field: "spark.stage.shuffleReadBytes",
        raw: to.raw.shuffleReadBytes,
        fmt: "bytes",
        text: fmtBytes(to.shuffleReadBytes),
      },
      {
        label: `Stage ${to.stageId} fetch wait`,
        field: "spark.stage.shuffleFetchWaitTime",
        raw: to.raw.shuffleFetchWaitTime,
        fmt: "ms",
        text: fmtDuration(to.shuffleFetchWaitTime),
      },
    );
  }
  const entityKey = edge ? `edge/${edge.edge.id}` : "";
  const title = isPlanDependency ? "Plan dependency" : isShuffleEdge ? "Shuffle edge" : "RDD dependency";
  const fromLabel = `${producer?.node.label ?? edge?.edge.from ?? ""}${isPlanDependency && producer?.node.ref != null ? ` #${producer.node.ref}` : ""}`;
  const toLabel = `${consumer?.node.label ?? edge?.edge.to ?? ""}${isPlanDependency && consumer?.node.ref != null ? ` #${consumer.node.ref}` : ""}`;
  const scrollCue = useDrawerScrollCue<HTMLElement>(open, `${edge?.edge.id ?? ""}|${rows.length}`);
  return (
    <aside
      ref={scrollCue.ref}
      className="burrow-dag-drawer burrow-scroll burrow-table-scroll"
      data-open={open}
      aria-hidden={!open}
      tabIndex={open ? 0 : -1}
      aria-label={`${title} details`}
      data-testid="dag-edge-drawer"
      data-scroll-cue={scrollCue.visible}
    >
      {edge ? (
        <Entity id={entityKey} className="flex w-full min-w-0 flex-col gap-3 p-3">
          <header className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 className="text-lead font-semibold text-ink">{title}</h2>
              <OptionalTooltip label={`${fromLabel} → ${toLabel}`}>
                <p className="break-words text-caption text-ink-3">
                  {fromLabel} → {toLabel}
                </p>
              </OptionalTooltip>
            </div>
            <Button size="icon-sm" variant="ghost" aria-label="Close details" title="Close details" onClick={onClose}>
              <PanelRightClose className="size-3.5" aria-hidden="true" />
            </Button>
          </header>
          {isPlanDependency ? (
            <p className="text-caption text-ink-3">Physical-plan dependency between these operators.</p>
          ) : isShuffleEdge && edge.flowing ? (
            <p className="text-caption text-live">Data is flowing now ({fmtPct((edge.intensity ?? 0) * 100, 0)} intensity)</p>
          ) : isShuffleEdge ? (
            <p className="text-caption text-ink-3">Not transferring right now.</p>
          ) : (
            <p className="text-caption text-ink-3">RDD lineage dependency; no shuffle metrics apply to this edge.</p>
          )}
          {isShuffleEdge && rows.length > 0 ? (
            <table className="burrow-dag-measure-table">
              <tbody>
                {rows.map((r) =>
                  r.raw == null ? null : (
                    <tr key={r.label}>
                      <td className="text-caption">{r.label}</td>
                      <td className="text-caption">
                        <Datum field={r.field} raw={r.raw} fmt={r.fmt}>
                          {r.text}
                        </Datum>
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          ) : isShuffleEdge ? (
            <p className="text-caption text-ink-3">No shuffle metrics reported for this edge yet.</p>
          ) : null}
        </Entity>
      ) : null}
      <DrawerScrollCue visible={scrollCue.visible} />
    </aside>
  );
}

// ---------------------------------------------------------------------------------------------------
// States + a11y edge list
// ---------------------------------------------------------------------------------------------------

/** Shared by the lazy engine fallback and the layout-pending canvas so loading feels continuous. */
export function DagLoadingPanel({ detail, hidden = false }: { detail?: string; hidden?: boolean }) {
  return (
    <div
      className="burrow-dag-state burrow-dag-loading absolute inset-0 z-10 grid place-content-center gap-3 px-6 text-center"
      role="status"
      aria-hidden={hidden}
      data-testid="dag-state"
    >
      <div className="mx-auto flex items-center justify-center" aria-hidden="true">
        {[0, 1, 2].map((node) => (
          <Fragment key={node}>
            {node > 0 ? <span className="h-px w-3 shrink-0 bg-seam-strong" /> : null}
            <span className="flex h-12 w-[4.5rem] shrink-0 flex-col justify-center gap-1.5 rounded-md border border-seam bg-fabric px-2">
              <span className="burrow-skeleton block h-1.5 w-6 rounded-sm" data-visible="true" />
              <span className="burrow-skeleton block h-1.5 w-full rounded-sm" data-visible="true" />
              <span className="burrow-skeleton block h-1.5 w-8 rounded-sm" data-visible="true" />
            </span>
          </Fragment>
        ))}
      </div>
      <p className="text-lead font-semibold text-ink-2">Preparing the graph…</p>
      {detail ? <p className="text-caption text-ink-3">{detail}</p> : null}
    </div>
  );
}

export function DagStatePanel({ title, detail, action }: { title: string; detail?: string; action?: React.ReactNode }) {
  return (
    <div className="burrow-dag-state" role="status" data-testid="dag-state">
      <p className="text-lead font-semibold text-ink-2">{title}</p>
      {detail ? <p className="text-caption text-ink-3">{detail}</p> : null}
      {action ? <div className="mt-1 flex justify-center">{action}</div> : null}
    </div>
  );
}

/** Screen-reader and keyboard access to edges, exposed as MenuItems beside the SVG tree. */
export function EdgeListView({
  edges,
  nodes,
  onActivate,
  metrics,
}: {
  edges: readonly EdgeVisual[];
  nodes: ReadonlyMap<string, NodeVisual>;
  onActivate: (edge: EdgeVisual) => void;
  metrics: ReadonlyMap<number, StageMetric>;
}) {
  return (
    <>
      {edges.map((e) => {
        const from = nodes.get(e.edge.from);
        const to = nodes.get(e.edge.to);
        const isPlanDependency = e.edge.kind === "sql";
        const fromRef = isPlanDependency && from?.node.ref != null ? ` #${from.node.ref}` : "";
        const toRef = isPlanDependency && to?.node.ref != null ? ` #${to.node.ref}` : "";
        const shuffle = !isPlanDependency && e.edge.toStage != null ? metrics.get(e.edge.toStage)?.shuffleReadBytes : undefined;
        const label = `${from?.node.label ?? e.edge.from}${fromRef} to ${to?.node.label ?? e.edge.to}${toRef}${e.flowing && !isPlanDependency ? ", flowing now" : ""}${
          shuffle ? `, shuffle read ${fmtBytes(shuffle)}` : ""
        }`;
        return (
          <MenuItem key={e.edge.id} wrap ariaLabel={label} title={label} onClick={() => onActivate(e)}>
            {label}
          </MenuItem>
        );
      })}
    </>
  );
}
