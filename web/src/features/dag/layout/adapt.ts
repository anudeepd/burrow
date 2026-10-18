/**
 * Payload → render graph, **without** the layout engine.
 *
 * Kept separate from `layout/index.ts` on purpose: the adapters are tiny and used by the renderer, while `index.ts`
 * used to re-export the ELK-backed entry points — which dragged ~1.5 MB of ELK into whichever chunk imported the
 * adapter. The engine is now reachable only through the worker or a dynamic import (see `client.ts`).
 */
import { buildGraph, type BuildOptions } from "../dag-model";
import { buildSqlPlanGraph } from "../sql-plan";
import { isDag } from "../dag-model";
import type { DagInput, RenderGraph } from "../types";

/** Adapt any accepted payload to a render graph (SQL plans included). */
export function toRenderGraph(input: DagInput, opts: BuildOptions = {}): RenderGraph {
  if (isDag(input)) return buildGraph(input, opts);
  return buildSqlPlanGraph(input);
}
