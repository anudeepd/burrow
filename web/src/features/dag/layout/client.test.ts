// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { LayoutClient, layoutClient, layoutDag, layoutDagSync } from "./client";
import { syntheticDag } from "../simulate";
import { layout, toRenderGraph } from "./index";
import type { LayoutRequest, LayoutWire, RenderGraph } from "../types";

const { runLayout } = vi.hoisted(() => ({ runLayout: vi.fn() }));
vi.mock("./elk", () => ({ runLayout }));

class FailedWorker {
  private readonly listeners = new Map<string, (event: { data?: unknown; message?: string }) => void>();

  addEventListener(type: string, listener: (event: { data?: unknown; message?: string }) => void) {
    this.listeners.set(type, listener);
  }

  postMessage() {
    queueMicrotask(() => this.listeners.get("error")?.({ message: "worker failed" }));
  }

  terminate() {}
}

class SuccessfulWorker {
  protected readonly listeners = new Map<string, (event: { data?: unknown; message?: string }) => void>();
  readonly terminate = vi.fn();

  addEventListener(type: string, listener: (event: { data?: unknown; message?: string }) => void) {
    this.listeners.set(type, listener);
  }

  postMessage(request: LayoutRequest) {
    queueMicrotask(() => this.emit({ requestId: request.requestId, ok: true, wire: wireFor(request.graph.hash) }));
  }

  protected emit(data: unknown) {
    this.listeners.get("message")?.({ data });
  }
}

class ReplyFailureWorker extends SuccessfulWorker {
  override postMessage(request: LayoutRequest) {
    queueMicrotask(() => this.emit({ requestId: request.requestId, ok: false, error: "ELK unavailable" }));
  }
}

class HangingWorker extends SuccessfulWorker {
  override postMessage() {}
}

class ThrowingWorker {
  constructor() {
    throw new Error("Worker API unavailable");
  }
}

const smallGraph = () => toRenderGraph(syntheticDag({ stages: 1, nodesPerStage: 2, skipEvery: 0, seed: 4 }), { expandStages: true });

function wireFor(hash: string): LayoutWire {
  return {
    hash,
    width: 1,
    height: 1,
    durationMs: 2,
    rung: 0,
    ladderName: "layered/orthogonal/compound",
    nodeIds: [],
    nodeBoxes: new Float32Array(0),
    clusterIds: [],
    clusterBoxes: new Float32Array(0),
    edgeIds: [],
    edgeOffsets: new Uint32Array([0]),
    edgePoints: new Float32Array(0),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  runLayout.mockReset();
});

describe("LayoutClient worker failure", () => {
  it("does not run ELK on the main thread when a large graph's worker fails", async () => {
    vi.stubGlobal("Worker", FailedWorker as unknown as typeof Worker);
    const graph = toRenderGraph(syntheticDag({ stages: 50, nodesPerStage: 12, skipEvery: 6, failStage: 9, seed: 3 }), {
      expandStages: true,
    });
    expect(graph.large).toBe(true);

    const client = new LayoutClient(true);
    await expect(client.layout(graph)).rejects.toThrow(/large DAG/i);
    expect(runLayout).not.toHaveBeenCalled();
    client.dispose();
  });

  it("falls back for small graphs when the Worker constructor throws", async () => {
    vi.stubGlobal("Worker", ThrowingWorker as unknown as typeof Worker);
    const graph = smallGraph();
    runLayout.mockResolvedValue(wireFor(graph.hash));

    const client = new LayoutClient(true);
    const result = await client.layout(graph);

    expect(result.ran).toBe("main");
    expect(client.getStats()).toMatchObject({ fallbacks: 1, workerReady: false, lastRan: "main" });
    expect(runLayout).toHaveBeenCalledOnce();
  });

  it("uses a healthy worker, coalesces duplicate requests, and caches the result", async () => {
    vi.stubGlobal("Worker", SuccessfulWorker as unknown as typeof Worker);
    const graph = smallGraph();
    const client = new LayoutClient(true);

    const first = client.layout(graph);
    const duplicate = client.layout(graph);
    const [result, coalesced] = await Promise.all([first, duplicate]);
    expect(result).toBe(coalesced);
    expect(result.ran).toBe("worker");
    expect(await client.layout(graph)).toBe(result);
    expect(client.getStats()).toMatchObject({ requests: 1, misses: 1, coalesced: 1, hits: 1, workerReady: true });

    client.resetStats();
    expect(client.getStats()).toMatchObject({ requests: 0, hits: 0, workerReady: true });
    expect(client.workerReady).toBe(true);
    client.clearCache();
    expect(client.cacheSize()).toBe(0);
    client.dispose();
    expect(client.workerReady).toBe(false);
  });

  it("falls back when the worker returns a request failure", async () => {
    vi.stubGlobal("Worker", ReplyFailureWorker as unknown as typeof Worker);
    const graph = smallGraph();
    runLayout.mockResolvedValue(wireFor(graph.hash));

    const client = new LayoutClient(true);
    expect((await client.layout(graph)).ran).toBe("main");
    expect(client.getStats().fallbacks).toBe(1);
  });

  it("rejects pending work on disposal and evicts the oldest cache entry", async () => {
    vi.stubGlobal("Worker", HangingWorker as unknown as typeof Worker);
    const graph = toRenderGraph(syntheticDag({ stages: 50, nodesPerStage: 12, skipEvery: 6, failStage: 9, seed: 3 }), {
      expandStages: true,
    });
    const client = new LayoutClient(true);
    const pending = client.layout(graph);
    const rejected = expect(pending).rejects.toThrow(/large DAG/i);
    client.dispose();
    await rejected;

    const sync = new LayoutClient(false);
    runLayout.mockImplementation(async (request: LayoutRequest) => wireFor(request.graph.hash));
    for (let i = 0; i < 25; i++) await sync.layoutSync({ ...graph, hash: `graph-${i}` } as RenderGraph);
    expect(sync.cacheSize()).toBe(24);
    expect(runLayout).toHaveBeenCalledTimes(25);
    sync.dispose();
  });

  it("exposes the shared worker-free entry points for app and SSR callers", async () => {
    vi.stubGlobal("Worker", undefined);
    const graph = smallGraph();
    runLayout.mockResolvedValue(wireFor(graph.hash));

    const shared = layoutClient();
    expect(layoutClient()).toBe(shared);
    expect((await layout(syntheticDag({ stages: 1, nodesPerStage: 2, skipEvery: 0, seed: 4 }), { expandStages: true })).ran).toBe("main");
    expect((await layoutDag(graph)).ran).toBe("main");
    expect((await layoutDagSync(graph)).ran).toBe("main");
    shared.dispose();
  });

  it("caches caller-threaded geometry and exposes the direct wire test seam", async () => {
    const graph = smallGraph();
    runLayout.mockResolvedValue(wireFor(graph.hash));
    const client = new LayoutClient(false);

    const first = await client.layoutSync(graph);
    expect(await client.layoutSync(graph)).toBe(first);
    expect(client.getStats().hits).toBe(1);
    await client.layoutWire(graph);
    expect(runLayout).toHaveBeenCalledTimes(2);
    client.dispose();
  });
});
