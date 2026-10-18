/**
 * Public API of the DAG engine (`~/features/dag`).
 *
 * Consumed by the Spark job/stage/SQL pages and by the review route. Everything heavy (ELK, the renderer) hangs off
 * this module, so a consumer that only needs types should import from `~/features/dag/types` instead to stay out of
 * the lazy chunk.
 */
import "./dag.css";

export { DagView, DAG_ZOOM_STEP } from "./react/DagView";
export type { DagViewProps, DagSelection } from "./react/DagView";
export { DagViewLazy, preloadDagView } from "./react/DagViewLazy";

export { buildGraph, hashGraph, rddChainSummary, EXPAND_LIMIT, CANVAS_THRESHOLD, HARD_LIMIT } from "./dag-model";
export { buildSqlPlanGraph, sqlMetricSummary, codegenClusterLabel } from "./sql-plan";
export { toRenderGraph, layout, layoutSync, layoutGraphSync } from "./layout";
// The engine (`./layout/elk`) is intentionally not part of this surface: it is reachable through the worker or a
// dynamic import, and importing it here would put ELK back into every consumer's chunk.

export {
  flowByProducer,
  flowReading,
  indexStageMetrics,
  normalizeStageStatus,
  parseSparkTime,
  progressSegments,
  stageDuration,
  stageMetricsFromRest,
  stageProgress,
  stageStatusKey,
  stageTone,
  toStageMetric,
} from "./metrics";
export type { FlowReading, ProgressSegments, StageMetric, StageMetricInput, StageStatus } from "./metrics";

export {
  FLASH_MS,
  JUMP_PP,
  JUMP_TWEEN_MS,
  TWEEN_MS,
  accumulateTotals,
  diffProgress,
  stageVisual,
  weightedPercent,
} from "./progress-diff";
export type { DiffPlan, NodeUpdate, StageVisual } from "./progress-diff";

export {
  DEFAULT_PROGRESS,
  createSimulator,
  pendingMetrics,
  simulatedCompletion,
  syntheticDag,
} from "./simulate";
export type { ProgressConfig, Simulator, SyntheticOptions } from "./simulate";

export {
  IDENTITY_VIEWPORT,
  INITIAL_MAX_SCALE,
  LEGIBLE_MIN_SCALE,
  LEVEL_DETAIL_MIN,
  LEVEL_OVERVIEW_MAX,
  MAX_SCALE,
  MIN_SCALE,
  boundsOf,
  centerOn,
  clampScale,
  fitViewport,
  focusScale,
  initialViewport,
  minimapProjection,
  isTooWideToFit,
  panBy,
  rectContains,
  screenToWorld,
  semanticLevel,
  visibleWorldRect,
  viewportTransform,
  worldToScreen,
  zoomAt,
  zoomTo,
} from "./render/viewport";
export type { MinimapProjection, SemanticLevel, Size, Viewport, WorldRect } from "./render/viewport";

export { buildScene, labelCandidates, flattenCandidates } from "./render/scene";
export type { EdgeVisual, NodeVisual, Scene } from "./render/scene";
export { findOverlaps, measureText, resolveLabelCollisions, ellipsize } from "./render/labels";
export type { LabelCandidate, LabelPlacement } from "./render/labels";
export { arrowAt, flowDash, pathFromPoints, pointAlong, straightEdge } from "./render/paths";
export { CanvasEdgeLayer, EdgeLayer, dashPhase, renderStrategy } from "./react/edges";
export type { RenderStrategy } from "./react/edges";

export type {
  Dag,
  DagCluster,
  DagEdge,
  DagGranularity,
  DagInput,
  DagKind,
  DagNode,
  DagStage,
  GraphCluster,
  GraphEdge,
  GraphNode,
  LayoutResult,
  LayoutWire,
  NodeSize,
  Rect,
  RenderGraph,
  SqlPlanEdge,
  SqlPlanExecution,
  SqlPlanMetric,
  SqlPlanNode,
} from "./types";
