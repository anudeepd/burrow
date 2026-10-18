/**
 * Web-worker entry for DAG layout. Receives a `LayoutRequest`, replies with a `LayoutWire` whose Float32Array/Uint32Array
 * buffers are *transferred* (zero copy) — the main thread never waits on a structured clone of geometry.
 *
 * The worker never throws at the caller: a failure is reported as `{ok:false,error}` so the client can fall back to the
 * synchronous main-thread path (and the UI can say which one it used).
 */
import { runLayout } from "./elk";
import type { LayoutRequest, LayoutResponse } from "../types";

/** Minimal structural view of the worker global; the DOM lib's `self` has a different postMessage signature. */
interface WorkerScope {
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: LayoutResponse, transfer?: Transferable[]): void;
}
const scope = globalThis as unknown as WorkerScope;

function isRequest(v: unknown): v is LayoutRequest {
  if (!v || typeof v !== "object") return false;
  if (!("requestId" in v) || !("graph" in v)) return false;
  const g = v.graph;
  if (!g || typeof g !== "object") return false;
  if (!("nodes" in g) || !("edges" in g) || !("clusters" in g)) return false;
  return Array.isArray(g.nodes) && Array.isArray(g.edges) && Array.isArray(g.clusters);
}

async function handle(req: LayoutRequest): Promise<LayoutResponse> {
  try {
    const wire = await runLayout(req);
    return { requestId: req.requestId, ok: true, wire };
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { requestId: req.requestId, ok: false, error: message };
  }
}

scope.addEventListener("message", (event) => {
  const data = event.data;
  if (!isRequest(data)) {
    scope.postMessage({ requestId: -1, ok: false, error: "malformed layout request" });
    return;
  }
  void handle(data).then((res) => {
    if (res.ok) {
      const { wire } = res;
      scope.postMessage(res, [wire.nodeBoxes.buffer, wire.clusterBoxes.buffer, wire.edgeOffsets.buffer, wire.edgePoints.buffer]);
    } else {
      scope.postMessage(res);
    }
  });
});
