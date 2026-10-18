// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { LayoutClient } from "./client";
import { syntheticDag } from "../simulate";
import { toRenderGraph } from "./index";

const { runLayout } = vi.hoisted(() => ({ runLayout: vi.fn() }));
vi.mock("./elk", () => ({ runLayout }));

class FailedWorker {
  private readonly listeners = new Map<string, (event: { message?: string }) => void>();

  addEventListener(type: string, listener: (event: { message?: string }) => void) {
    this.listeners.set(type, listener);
  }

  postMessage() {
    queueMicrotask(() => this.listeners.get("error")?.({ message: "worker failed" }));
  }

  terminate() {}
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
});
