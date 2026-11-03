// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LayoutRequest, LayoutWire } from "../types";

const { runLayout } = vi.hoisted(() => ({ runLayout: vi.fn() }));
vi.mock("./elk", () => ({ runLayout }));

const request: LayoutRequest = {
  requestId: 7,
  graph: { hash: "graph", nodes: [], edges: [], clusters: [] },
  options: {},
};
const wire: LayoutWire = {
  hash: "graph",
  width: 0,
  height: 0,
  durationMs: 1,
  rung: 0,
  ladderName: "layered",
  nodeIds: [],
  nodeBoxes: new Float32Array(0),
  clusterIds: [],
  clusterBoxes: new Float32Array(0),
  edgeIds: [],
  edgeOffsets: new Uint32Array([0]),
  edgePoints: new Float32Array(0),
};

async function loadWorker() {
  let onMessage: ((event: { data: unknown }) => void) | undefined;
  const postMessage = vi.fn();
  vi.stubGlobal("addEventListener", (_type: string, listener: (event: { data: unknown }) => void) => {
    onMessage = listener;
  });
  vi.stubGlobal("postMessage", postMessage);
  vi.resetModules();
  await import("./worker");
  return { dispatch: (data: unknown) => onMessage?.({ data }), postMessage };
}

async function flushWorkerResponse() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.unstubAllGlobals();
  runLayout.mockReset();
});

describe("DAG layout worker protocol", () => {
  it("rejects malformed messages without invoking ELK", async () => {
    const worker = await loadWorker();
    for (const malformed of [
      null,
      "message",
      { graph: { nodes: [], edges: [], clusters: [] } },
      { requestId: 1 },
      { requestId: 1, graph: null },
      { requestId: 1, graph: "graph" },
      { requestId: 1, graph: {} },
      { requestId: 1, graph: { edges: [], clusters: [] } },
      { requestId: 1, graph: { nodes: [], clusters: [] } },
      { requestId: 1, graph: { nodes: [], edges: [], clusters: {} } },
    ]) {
      worker.dispatch(malformed);
    }

    expect(worker.postMessage).toHaveBeenCalledWith({ requestId: -1, ok: false, error: "malformed layout request" });
    expect(worker.postMessage).toHaveBeenCalledTimes(10);
    expect(runLayout).not.toHaveBeenCalled();
  });

  it("transfers all geometry buffers after a successful layout", async () => {
    runLayout.mockResolvedValue(wire);
    const worker = await loadWorker();
    worker.dispatch(request);
    await flushWorkerResponse();

    expect(worker.postMessage).toHaveBeenCalledWith({ requestId: 7, ok: true, wire }, [
      wire.nodeBoxes.buffer,
      wire.clusterBoxes.buffer,
      wire.edgeOffsets.buffer,
      wire.edgePoints.buffer,
    ]);
  });

  it("returns Error details when layout fails", async () => {
    runLayout.mockRejectedValue(new Error("ELK failed"));
    const worker = await loadWorker();
    worker.dispatch(request);
    await flushWorkerResponse();

    expect(worker.postMessage).toHaveBeenCalledWith({ requestId: 7, ok: false, error: "Error: ELK failed" });
  });

  it("stringifies non-Error layout failures", async () => {
    runLayout.mockRejectedValue("worker crash");
    const worker = await loadWorker();
    worker.dispatch(request);
    await flushWorkerResponse();

    expect(worker.postMessage).toHaveBeenCalledWith({ requestId: 7, ok: false, error: "worker crash" });
  });
});
