/**
 * ELK layered layout. The main path runs inside `worker.ts`; the small-graph fallback and test/SSR API run on their
 * caller. Browser builds load the large algorithm file as a standalone asset; tests/SSR use the package's inline
 * worker export.
 *
 * Determinism: ELK is deterministic for identical input + options, so the same DAG always lays out identically (the
 * cache depends on it). See `wire.ts` for why the model-order options are absent — they crash ELK on hierarchical
 * graphs, measured against every golden in the corpus.
 */
import ELK, { type ELK as ElkEngine } from "elkjs/lib/elk-api.js";
import type { Worker as ElkWorker } from "elkjs/lib/elk-worker.min.js";
import elkWorkerUrl from "elkjs/lib/elk-worker.min.js?url";
import type { LayoutRequest, LayoutWire } from "../types";
import { LAYOUT_LADDER, clusterPaddingOption } from "./wire";

export { LAYOUT_LADDER, LAYOUT_OPTIONS, clusterPaddingOption, decodeWire, layoutRequest } from "./wire";

/** One ELK instance per thread: constructing it registers the algorithms, which is the expensive part. */
let elkPromise: Promise<ElkEngine> | null = null;

type ElkWorkerConstructor = new (url?: string) => ElkWorker;
interface ElkWorkerExports {
  Worker?: ElkWorkerConstructor;
}
interface ElkWorkerModule {
  exports: ElkWorkerExports;
}

function restoreGlobal(scope: object, name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(scope, name, descriptor);
  else Reflect.deleteProperty(scope, name);
}

/** SSR has no browser asset loader; only there, import ELK's CommonJS worker export directly. */
async function loadInlineWorkerModule(): Promise<ElkWorkerConstructor> {
  const scope = globalThis as typeof globalThis & { document?: unknown };
  const documentDescriptor = Object.getOwnPropertyDescriptor(scope, "document");
  if (!documentDescriptor) Object.defineProperty(scope, "document", { configurable: true, value: {} });
  try {
    // SSR needs the CommonJS module; browser builds load the same file as an asset to avoid a huge JS chunk.
    const { Worker } = await import("elkjs/lib/elk-worker.min.js");
    return Worker;
  } finally {
    if (!documentDescriptor) Reflect.deleteProperty(scope, "document");
  }
}

/**
 * Load ELK's UMD worker as a script asset and provide the CommonJS globals it expects to expose its inline Worker.
 * `importScripts` is available in the classic layout worker; the small-graph fallback uses a script element on window.
 */
async function loadInlineWorkerAsset(): Promise<ElkWorkerConstructor> {
  const scope = globalThis as unknown as Record<string, unknown>;
  const documentDescriptor = Object.getOwnPropertyDescriptor(scope, "document");
  const moduleDescriptor = Object.getOwnPropertyDescriptor(scope, "module");
  const exportsDescriptor = Object.getOwnPropertyDescriptor(scope, "exports");
  const module: ElkWorkerModule = { exports: {} };

  if (!documentDescriptor) Object.defineProperty(scope, "document", { configurable: true, value: {} });
  Object.defineProperty(scope, "module", { configurable: true, value: module });
  Object.defineProperty(scope, "exports", { configurable: true, value: module.exports });
  try {
    const assetUrl = new URL(elkWorkerUrl, `${globalThis.location.origin}/`).href;
    const importScripts = scope.importScripts;
    if (typeof importScripts === "function") {
      Reflect.apply(importScripts, scope, [assetUrl]);
    } else if (typeof document !== "undefined") {
      const script = document.createElement("script");
      script.src = assetUrl;
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Failed to load ELK worker asset"));
      document.head.append(script);
      try {
        await promise;
      } finally {
        script.remove();
      }
    } else {
      throw new Error("No script loader is available for the ELK worker asset");
    }

    const Worker = module.exports.Worker;
    if (!Worker) throw new Error("ELK worker asset did not expose its inline Worker");
    return Worker;
  } finally {
    restoreGlobal(scope, "exports", exportsDescriptor);
    restoreGlobal(scope, "module", moduleDescriptor);
    if (!documentDescriptor) restoreGlobal(scope, "document", undefined);
  }
}

async function loadInlineWorker(): Promise<ElkWorkerConstructor> {
  if (import.meta.env.SSR) return await loadInlineWorkerModule();
  return await loadInlineWorkerAsset();
}

export function getElk(): Promise<ElkEngine> {
  if (!elkPromise) {
    const pending = (async () => {
      const ElkFakeWorker = await loadInlineWorker();
      return new ELK({
        // The standalone asset exposes ELK's inline adapter. It runs the algorithm on this worker thread rather than
        // creating a nested Worker; the main thread sees only the compact, transferable layout result.
        workerFactory: () => new ElkFakeWorker() as unknown as Worker,
        defaultLayoutOptions: LAYOUT_LADDER[0]!.options,
      });
    })();
    elkPromise = pending;
    void pending.catch(() => {
      if (elkPromise === pending) elkPromise = null;
    });
  }
  return elkPromise;
}

interface ElkShape {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}
interface ElkEdgeSection {
  startPoint: { x: number; y: number };
  endPoint: { x: number; y: number };
  bendPoints?: { x: number; y: number }[];
}
interface ElkEdgeLayout {
  id: string;
  container?: string;
  sections?: ElkEdgeSection[];
}
interface ElkNodeLayout extends ElkShape {
  children?: ElkNodeLayout[];
  edges?: ElkEdgeLayout[];
}

/**
 * Harvest absolute geometry from ELK's tree, which is parent-relative at every level.
 * Order follows the request arrays (not ELK's internal order) so the cache and the renderer agree.
 *
 * Edge sections need a second pass: ELK lists every edge under the tree root (`INCLUDE_CHILDREN`) but writes the
 * section coordinates in the frame of the edge's own `container` — for a compound graph, the nested cluster. Shifting
 * by the *listing* shape's offset (the root, i.e. zero) left those edges floating outside their nodes, so the shift
 * is applied after the walk, from the container's absolute origin.
 */
function harvest(root: ElkNodeLayout, req: LayoutRequest, durationMs: number, rung: number, ladderName: string): LayoutWire {
  const nodeBox = new Map<string, { x: number; y: number; w: number; h: number }>();
  const clusterBox = new Map<string, { x: number; y: number; w: number; h: number }>();
  /** Section points exactly as ELK emitted them, with the frame they belong to. First listing wins (merged edges repeat). */
  const rawEdges = new Map<string, { pts: number[]; container?: string; dx: number; dy: number }>();
  const clusterOf = new Set(req.graph.clusters.map((c) => c.id));

  const walk = (shape: ElkNodeLayout, dx: number, dy: number): void => {
    const x = dx + (shape.x ?? 0);
    const y = dy + (shape.y ?? 0);
    const box = { x, y, w: shape.width ?? 0, h: shape.height ?? 0 };
    if (shape.id !== "__root__" && shape.id !== "") {
      if (clusterOf.has(shape.id)) clusterBox.set(shape.id, box);
      else nodeBox.set(shape.id, box);
    }
    for (const child of shape.children ?? []) walk(child, x, y);
    // Edges are attached to the container that owns them; with INCLUDE_CHILDREN that is the root, but be tolerant.
    for (const e of shape.edges ?? []) {
      const sec = e.sections?.[0];
      if (!sec) continue;
      const pts: number[] = [sec.startPoint.x, sec.startPoint.y];
      for (const b of sec.bendPoints ?? []) pts.push(b.x, b.y);
      pts.push(sec.endPoint.x, sec.endPoint.y);
      if (!rawEdges.has(e.id)) rawEdges.set(e.id, { pts, container: e.container, dx, dy });
    }
  };
  walk(root, 0, 0);

  /** Absolute origin of an edge section's frame: the root has none, a cluster is named, anything else keeps the old shift. */
  const frameOrigin = (e: { container?: string; dx: number; dy: number }): [number, number] => {
    if (!e.container || e.container === "__root__" || e.container === "") return [0, 0];
    const c = clusterBox.get(e.container);
    return c ? [c.x, c.y] : [e.dx, e.dy];
  };

  const edgePoints = new Map<string, number[]>();
  for (const [id, e] of rawEdges) {
    const [ox, oy] = frameOrigin(e);
    const pts = e.pts.slice();
    for (let i = 0; i < pts.length; i += 2) {
      pts[i] = pts[i]! + ox;
      pts[i + 1] = pts[i + 1]! + oy;
    }
    edgePoints.set(id, pts);
  }

  const nodeIds = req.graph.nodes.map((n) => n.id);
  const nodeBoxes = new Float32Array(nodeIds.length * 4);
  nodeIds.forEach((id, i) => {
    const b = nodeBox.get(id);
    // ELK can omit a shape (merged edges, or a payload we synthesised); zeros keep the arrays aligned and the corpus
    // test asserts completeness separately.
    if (!b) return;
    nodeBoxes[i * 4] = b.x;
    nodeBoxes[i * 4 + 1] = b.y;
    nodeBoxes[i * 4 + 2] = b.w;
    nodeBoxes[i * 4 + 3] = b.h;
  });
  const clusterIds = req.graph.clusters.map((c) => c.id);
  const clusterBoxes = new Float32Array(clusterIds.length * 4);
  clusterIds.forEach((id, i) => {
    const b = clusterBox.get(id);
    if (!b) return;
    clusterBoxes[i * 4] = b.x;
    clusterBoxes[i * 4 + 1] = b.y;
    clusterBoxes[i * 4 + 2] = b.w;
    clusterBoxes[i * 4 + 3] = b.h;
  });
  const edgeIds: string[] = [];
  const offsets: number[] = [0];
  const points: number[] = [];
  for (const e of req.graph.edges) {
    const pts = edgePoints.get(e.id);
    if (!pts) continue;
    edgeIds.push(e.id);
    points.push(...pts);
    offsets.push(points.length / 2);
  }
  return {
    hash: req.graph.hash,
    width: root.width ?? 0,
    height: root.height ?? 0,
    durationMs,
    rung,
    ladderName,
    nodeIds,
    nodeBoxes,
    clusterIds,
    clusterBoxes,
    edgeIds,
    edgeOffsets: Uint32Array.from(offsets),
    edgePoints: Float32Array.from(points),
  };
}

/** Build the ELK tree: clusters nest by `parentId`, nodes land in their cluster (or the root). */
function toElkGraph(req: LayoutRequest, options: Record<string, string>) {
  const depth = new Map<string, number>();
  for (const c of req.graph.clusters) depth.set(c.id, c.depth);
  interface Box {
    id: string;
    width?: number;
    height?: number;
    labels?: { text: string; width: number; height: number }[];
    layoutOptions?: Record<string, string>;
    children: Box[];
  }
  const boxes = new Map<string, Box>();
  const ensure = (id: string): Box => {
    const existing = boxes.get(id);
    if (existing) return existing;
    const box: Box = { id, children: [] };
    boxes.set(id, box);
    return box;
  };
  for (const c of req.graph.clusters) {
    const box = ensure(c.id);
    box.labels = [{ text: c.label, width: Math.max(40, c.label.length * 6.6), height: 16 }];
    box.layoutOptions = { "elk.padding": clusterPaddingOption(), "elk.direction": "RIGHT" };
  }
  for (const n of req.graph.nodes) {
    const box = ensure(n.id);
    box.width = n.width;
    box.height = n.height;
    // FIXED_SIZE: the renderer draws exactly the box we asked for, so ELK must not grow it behind our back.
    box.layoutOptions = { "elk.nodeSize.constraints": "FIXED_SIZE" };
  }
  const rootChildren: Box[] = [];
  // Deepest container first, so a nested scope exists before it is attached to its parent.
  const ordered = [...req.graph.clusters].sort((a, b) => (depth.get(b.id) ?? 0) - (depth.get(a.id) ?? 0));
  for (const c of ordered) {
    const box = boxes.get(c.id);
    if (!box) continue;
    const parent = c.parentId ? boxes.get(c.parentId) : undefined;
    if (parent) parent.children.push(box);
    else rootChildren.push(box);
  }
  for (const n of req.graph.nodes) {
    const box = boxes.get(n.id);
    if (!box) continue;
    const parent = n.clusterId ? boxes.get(n.clusterId) : undefined;
    if (parent) parent.children.push(box);
    else rootChildren.push(box);
  }
  return {
    id: "__root__",
    layoutOptions: { ...options },
    children: rootChildren,
    edges: req.graph.edges.map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  };
}

/** An empty payload is legitimate but ELK has nothing to do; return empty geometry instead of an error. */
function emptyWire(req: LayoutRequest): LayoutWire {
  return {
    hash: req.graph.hash,
    width: 0,
    height: 0,
    durationMs: 0,
    rung: 0,
    ladderName: LAYOUT_LADDER[0]!.name,
    nodeIds: [],
    nodeBoxes: new Float32Array(0),
    clusterIds: [],
    clusterBoxes: new Float32Array(0),
    edgeIds: [],
    edgeOffsets: Uint32Array.from([0]),
    edgePoints: new Float32Array(0),
  };
}

/**
 * Run layout for one request, walking `LAYOUT_LADDER` until a rung succeeds. The returned wire carries the rung index
 * so callers can surface "laid out with a simplified routing" instead of pretending nothing happened.
 */
export async function runLayout(req: LayoutRequest): Promise<LayoutWire> {
  if (req.graph.nodes.length === 0 && req.graph.clusters.length === 0) return emptyWire(req);
  const elk = await getElk();
  let lastError: unknown = null;
  for (const [rung, attempt] of LAYOUT_LADDER.entries()) {
    const options = rung === 0 ? req.options : attempt.options;
    try {
      const graph = toElkGraph(req, options);
      const t0 = performance.now();
      const result = (await elk.layout(graph, { layoutOptions: { ...options } })) as unknown as ElkNodeLayout;
      return harvest(result, req, performance.now() - t0, rung, attempt.name);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
