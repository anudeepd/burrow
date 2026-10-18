/**
 * Public layout entry points.
 *
 *   layout(dag)          → Promise<LayoutResult>   worker + cache (the app path)
 *   layoutSync(dag)      → Promise<LayoutResult>   same geometry on the calling thread (tests, SSR)
 *
 * Both are pure with respect to their input: same `dag` (plus options) ⇒ same positions, because the graph hash keys
 * the cache and ELK is deterministic. They adapt first (`buildGraph` / `buildSqlPlanGraph`) so callers never have to.
 */
import type { BuildOptions } from "../dag-model";
import type { DagInput, LayoutResult, RenderGraph } from "../types";
import { toRenderGraph } from "./adapt";
import { LayoutClient, layoutClient } from "./client";

export { toRenderGraph } from "./adapt";
export type { LayoutRequest, LayoutWire } from "../types";
export { LayoutClient, layoutClient, layoutDag, layoutDagSync, type LayoutStats } from "./client";

// NOTE: `./elk` is deliberately *not* re-exported here. Import it from `./layout/elk` when you need the engine
// directly (tests do); application code goes through the worker-backed client so ELK never lands in the app chunk.

/** Pure: `dag` in, world-space positions out. Uses the shared client (worker when available). */
export function layout(input: DagInput, opts: BuildOptions = {}): Promise<LayoutResult> {
  return layoutClient().layout(toRenderGraph(input, opts));
}

/** Pure and caller-threaded: identical geometry, no worker. This is what tests and SSR use. */
export function layoutSync(input: DagInput, opts: BuildOptions = {}): Promise<LayoutResult> {
  return new LayoutClient(false).layoutSync(toRenderGraph(input, opts));
}

/** Synchronous geometry without any promise machinery (tests, SSR, small graphs). Engine loaded on demand. */
export async function layoutGraphSync(graph: RenderGraph): Promise<LayoutResult> {
  return new LayoutClient(false).layoutSync(graph);
}
