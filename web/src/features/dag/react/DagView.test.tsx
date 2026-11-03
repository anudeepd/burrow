/**
 * Render-level behaviour (jsdom): accessibility tree, keyboard navigation, drawer contents with parity attributes,
 * loading/partial states, and the "tokens only" guard on the markup we emit.
 *
 * Real fixtures are used for every case (including the REST fallback), and mount helpers below keep the specs short.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DagView } from "./DagView";
import { DagMinimap, EdgeDrawer } from "./chrome";
import { toRenderGraph } from "../layout";
import { layoutClient } from "../layout/client";
import { createSimulator, syntheticDag } from "../simulate";
import { stageMetricsFromRest } from "../metrics";
import { download } from "~/ui/data-table/export";
import type { Dag, DagInput, SqlPlanExecution, SqlPlanMetric } from "../types";
import type { EdgeVisual, Scene } from "../render/scene";
import type { LayoutResult } from "../types";

vi.mock("~/ui/data-table/export", () => ({ download: vi.fn() }));

const FIXTURES = join(process.cwd(), "..", "fixtures", "spark");

/**
 * jsdom has no layout engine, so every measured box is 0×0 and the DAG would never fit or zoom. A fixed pane is the
 * honest stand-in; the real geometry is covered by the Playwright spec.
 */
beforeEach(() => {
  document.documentElement.removeAttribute("data-motion");
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 600, width: 1200, height: 600, toJSON: () => ({}) }),
  });
});

function readDag(version: string, workload: string, file: string): Dag {
  return JSON.parse(readFileSync(join(FIXTURES, version, workload, file), "utf8")) as Dag;
}

function readStages(version: string, workload: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, version, workload, "rest", "final.stages.details.json"), "utf8"));
}

const wordcountStage = () => readDag("4.2.0", "rdd-wordcount", "dag-stage-0-0.json");
const barrierJob = () => readDag("4.2.0", "barrier-scopes", "dag-job-2.json");
const fallbackJob = () => readDag("4.2.0", "big-dag", "dag-fallback-job-2.json");

/** Wait for the (worker-free, but still async) layout to land and the tree to be present. */
async function mount(dag: DagInput, props: Record<string, unknown> = {}) {
  const view = render(<DagView dag={dag} height={400} {...props} />);
  await waitFor(() => expect(screen.queryAllByRole("treeitem").length).toBeGreaterThan(0), { timeout: 10_000 });
  return view;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("data-motion");
});

describe("accessibility tree", () => {
  it("exposes a tree with one labelled treeitem per node", async () => {
    const dag = wordcountStage();
    await mount(dag);
    const tree = screen.getByRole("tree");
    expect(tree.getAttribute("aria-label")).toBe("stage DAG");
    const items = screen.getAllByRole("treeitem");
    expect(items.length).toBe(dag.stages[0]!.nodes.length);
    for (const item of items) {
      expect(item.getAttribute("aria-label")).toBeTruthy();
      expect(item.getAttribute("aria-level")).toBe("1");
    }
    // the operation-scope clusters are groups, not items
    expect(screen.getAllByRole("group").length).toBeGreaterThan(0);
    // exactly one tab stop in the tree (roving tabindex)
    expect(items.filter((i) => i.getAttribute("tabindex") === "0")).toHaveLength(1);
  });

  it("keeps offscreen nodes accessible while culling their drawing", { timeout: 30_000 }, async () => {
    const dag = syntheticDag({ stages: 8, nodesPerStage: 8, skipEvery: 6, failStage: 4, seed: 3 });
    const graph = toRenderGraph(dag, { expandStages: true });
    await mount(dag, { expandStages: true });

    const items = screen.getAllByRole("treeitem");
    expect(items).toHaveLength(graph.nodes.length);
    const offscreen = items.filter((item) => item.querySelector(".burrow-dag-node-body") === null);
    expect(offscreen.length).toBeGreaterThan(0);
    expect(offscreen.length).toBeLessThan(items.length);
    for (const item of items) expect(item.querySelector("[data-glyph]")).not.toBeNull();

    const nonGhostItems = items.filter((item) => item.getAttribute("data-kind") !== "ghost");
    expect(screen.getAllByRole("progressbar")).toHaveLength(nonGhostItems.length);
    for (const item of offscreen) {
      const progress = item.querySelector('[role="progressbar"]');
      if (item.getAttribute("data-kind") !== "ghost") {
        expect(progress).not.toBeNull();
        expect(progress!.querySelector(".burrow-dag-progress-track")).toBeNull();
      }
    }

    const visibleEdges = screen.getByRole("tree").querySelectorAll(".burrow-dag-edge").length;
    expect(visibleEdges).toBeGreaterThan(0);
    expect(visibleEdges).toBeLessThan(graph.edges.length);
  });

  it("encodes status as shape + tone, never colour alone (DESIGN §7.2)", async () => {
    const metrics = stageMetricsFromRest(readStages("4.2.0", "rdd-wordcount"));
    await mount(wordcountStage(), { metrics });
    const items = screen.getAllByRole("treeitem");
    for (const item of items) {
      const glyph = item.querySelector("[data-glyph]");
      expect(glyph, "every node carries a status glyph").not.toBeNull();
      expect(glyph!.getAttribute("data-glyph")).toBe("check"); // the captured stage is COMPLETE
      expect(glyph!.getAttribute("class")).toContain("burrow-tone-");
    }
    // the skipped fallback stages use a different shape, so the shape really tracks the status
    await mount(fallbackJob());
    const shapes = new Set([...screen.getAllByRole("treeitem")].map((i) => i.querySelector("[data-glyph]")?.getAttribute("data-glyph")));
    expect(shapes.size).toBeGreaterThan(0);
    for (const shape of shapes) expect(shape).toBeTruthy();
  });

  it("announces when the layout is ready (parity wait condition)", async () => {
    await mount(wordcountStage());
    expect(screen.getByTestId("dag-canvas").getAttribute("data-dag-layout")).toBe("ready");
  });

  it("describes keyboard use and exposes a screen-reader summary", async () => {
    const dag = wordcountStage();
    await mount(dag);
    expect(screen.getByText(/Arrow keys move between nodes/)).toBeTruthy();
    const summary = screen.getByTestId("dag-sr-summary");
    expect(summary.textContent).toContain("nodes 4");
    expect(summary.textContent).toContain("edges 3");
  });

  it("gives every edge a focusable, labelled entry in the edge list", async () => {
    const dag = barrierJob();
    await mount(dag, { expandStages: true });
    fireEvent.click(screen.getByRole("button", { name: /^Edges \(\d+\)$/ }));
    const list = screen.getByTestId("dag-edge-list");
    const items = within(list).getAllByRole("menuitem");
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item.getAttribute("aria-label")).toMatch(/ to /);
  });

  it("keeps running state visible with a static hatch under reduced motion", async () => {
    const dag = syntheticDag({ stages: 2, nodesPerStage: 3, skipEvery: 0, seed: 3 });
    const metrics = createSimulator(dag).at(0);
    document.documentElement.setAttribute("data-motion", "reduced");

    await mount(dag, { metrics });

    const running = screen.getAllByRole("treeitem").filter((item) => item.getAttribute("data-running") === "true");
    expect(running.length).toBeGreaterThan(0);
    for (const item of running) {
      expect(item.querySelector(".burrow-dag-node-hatch")).not.toBeNull();
      expect(item.querySelector(".burrow-dag-node-shimmer")).not.toBeNull();
    }
  });
});

describe("keyboard navigation", () => {
  it("moves the roving tab stop with the arrow keys", async () => {
    await mount(wordcountStage());
    await waitFor(() => expect(screen.getByTestId("dag-canvas").getAttribute("data-dag-layout")).toBe("ready"));
    const tree = screen.getByRole("tree");
    const tabbable = () => screen.getAllByRole("treeitem").filter((i) => i.getAttribute("tabindex") === "0");
    // svg <g> focus() is a no-op in jsdom, so the assertion is on the roving tabindex the component maintains
    expect(tabbable()).toHaveLength(1);
    const start = tabbable()[0]!;
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    const afterDown = tabbable();
    expect(afterDown).toHaveLength(1);
    expect(afterDown[0]).not.toBe(start);
    fireEvent.keyDown(tree, { key: "ArrowUp" });
    expect(tabbable()[0]).toBe(start);
    const items = screen.getAllByRole("treeitem");
    fireEvent.keyDown(tree, { key: "End" });
    expect(tabbable()[0]).not.toBe(start);
    expect(items).toContain(tabbable()[0]);
    fireEvent.keyDown(tree, { key: "Home" });
    expect(tabbable()[0]).toBe(start);
  });

  it("zooms and pans from the keyboard", async () => {
    await mount(wordcountStage());
    const canvas = screen.getByTestId("dag-canvas");
    const before = screen.getByTestId("dag-zoom").textContent;
    fireEvent.keyDown(canvas, { key: "+" });
    await waitFor(() => expect(screen.getByTestId("dag-zoom").textContent).not.toBe(before));
    const zoomed = screen.getByTestId("dag-zoom").textContent;
    fireEvent.keyDown(canvas, { key: "0" });
    await waitFor(() => expect(screen.getByTestId("dag-zoom").textContent).not.toBe(zoomed));
  });

  it("preserves the user's zoom when refreshed input keeps the same graph shape", async () => {
    const dag = wordcountStage();
    const layout = vi.spyOn(layoutClient(), "layout");
    const view = await mount(dag);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    await waitFor(() => expect(screen.getByTestId("dag-zoom").textContent).not.toBe("100%"));
    const zoomed = screen.getByTestId("dag-zoom").textContent;
    const layoutCalls = layout.mock.calls.length;

    // Live Spark queries return a new payload object even when only non-layout fields changed.
    view.rerender(<DagView dag={JSON.parse(JSON.stringify(dag)) as Dag} height={400} />);

    expect(layout).toHaveBeenCalledTimes(layoutCalls);
    expect(screen.getByTestId("dag-zoom").textContent).toBe(zoomed);
  });

  it("centres keyboard focus after zooming past the visible graph area", async () => {
    await mount(wordcountStage());
    const tree = screen.getByRole("tree");
    for (let i = 0; i < 7; i++) fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    await waitFor(() => expect(screen.getByTestId("dag-zoom").textContent).not.toBe("100%"));

    const before = screen.getAllByRole("treeitem").find((item) => item.getAttribute("tabindex") === "0");
    fireEvent.keyDown(tree, { key: "End" });
    const after = screen.getAllByRole("treeitem").find((item) => item.getAttribute("tabindex") === "0");
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
  });

  it("handles both arrow aliases, shifted panning, zoom-out aliases, and unknown keys", async () => {
    await mount(wordcountStage());
    const canvas = screen.getByTestId("dag-canvas");
    const tabbable = () => screen.getAllByRole("treeitem").find((item) => item.getAttribute("tabindex") === "0");
    const first = tabbable();
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    expect(tabbable()).not.toBe(first);
    const afterRight = tabbable();
    fireEvent.keyDown(canvas, { key: "ArrowLeft" });
    expect(tabbable()).toBe(first);
    fireEvent.keyDown(canvas, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(canvas, { key: "ArrowUp", shiftKey: true });
    const before = screen.getByTestId("dag-zoom").textContent;
    fireEvent.keyDown(canvas, { key: "=" });
    await waitFor(() => expect(screen.getByTestId("dag-zoom").textContent).not.toBe(before));
    const zoomed = screen.getByTestId("dag-zoom").textContent;
    fireEvent.keyDown(canvas, { key: "_" });
    await waitFor(() => expect(screen.getByTestId("dag-zoom").textContent).not.toBe(zoomed));
    const underscored = screen.getByTestId("dag-zoom").textContent;
    fireEvent.keyDown(canvas, { key: "-" });
    await waitFor(() => expect(screen.getByTestId("dag-zoom").textContent).not.toBe(underscored));
    fireEvent.keyDown(canvas, { key: "x" });
    expect(tabbable()).toBeTruthy();
    expect(afterRight).toBeTruthy();
  });

  it("handles keyboard navigation with no nodes and a stale focused id after graph changes", async () => {
    const empty: Dag = { kind: "job", granularity: "stage", stages: [], edges: [] };
    render(<DagView dag={empty} />);
    await waitFor(() => expect(screen.getByText(/has no nodes/)).toBeTruthy());
    for (const key of ["ArrowDown", "Home", "End"]) fireEvent.keyDown(screen.getByTestId("dag-canvas"), { key });
    cleanup();

    const wide = syntheticDag({ stages: 2, nodesPerStage: 3, skipEvery: 0, seed: 33 });
    const short = syntheticDag({ stages: 1, nodesPerStage: 3, skipEvery: 0, seed: 33 });
    const view = await mount(wide, { expandStages: true });
    fireEvent.keyDown(screen.getByTestId("dag-canvas"), { key: "End" });
    fireEvent.click(screen.getAllByRole("treeitem").at(-1)!);
    expect(screen.getByTestId("dag-drawer").getAttribute("data-open")).toBe("true");
    view.rerender(<DagView dag={short} height={400} expandStages />);
    await waitFor(() => expect(screen.getAllByRole("treeitem").length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByTestId("dag-drawer").getAttribute("data-open")).toBe("false"));
    fireEvent.keyDown(screen.getByTestId("dag-canvas"), { key: "ArrowDown" });
    expect(screen.getAllByRole("treeitem").some((item) => item.getAttribute("tabindex") === "0")).toBe(true);
  });

  it("scrolls its page on Shift-wheel and ignores a zero wheel delta", async () => {
    const dag = wordcountStage();
    const view = render(
      <div className="burrow-page-scroll" style={{ overflowY: "auto" }}>
        <DagView dag={dag} height={400} />
      </div>,
    );
    await waitFor(() => expect(screen.queryAllByRole("treeitem").length).toBeGreaterThan(0), { timeout: 10_000 });
    const scroller = view.container.firstElementChild as HTMLElement;
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, writable: true, value: 100 },
    });
    const stage = screen.getByTestId("dag-stage");
    const zoom = screen.getByTestId("dag-zoom").textContent;
    fireEvent.wheel(stage, { deltaY: 0 });
    expect(screen.getByTestId("dag-zoom").textContent).toBe(zoom);
    const shiftWheel = new WheelEvent("wheel", { deltaY: 20, bubbles: true, cancelable: true });
    Object.defineProperty(shiftWheel, "shiftKey", { value: true });
    stage.dispatchEvent(shiftWheel);
    expect(scroller.scrollTop).toBe(120);
  });

  it("leaves Shift-wheel unhandled when there is no scrollable page ancestor", async () => {
    await mount(wordcountStage());
    const stage = screen.getByTestId("dag-stage");
    const zoom = screen.getByTestId("dag-zoom").textContent;
    vi.spyOn(window, "getComputedStyle").mockReturnValue({ overflowY: "visible" } as CSSStyleDeclaration);
    const shiftWheel = new WheelEvent("wheel", { deltaY: 20, shiftKey: true, bubbles: true, cancelable: true });
    Object.defineProperty(shiftWheel, "shiftKey", { value: true });
    stage.dispatchEvent(shiftWheel);
    expect(shiftWheel.defaultPrevented).toBe(false);
    expect(screen.getByTestId("dag-zoom").textContent).toBe(zoom);
  });

  it("handles upward Shift-wheel, horizontal wheel deltas, modifiers, and line-mode zoom", async () => {
    const view = render(
      <div className="burrow-page-scroll" style={{ overflowY: "auto" }}>
        <DagView dag={wordcountStage()} height={400} />
      </div>,
    );
    await waitFor(() => expect(screen.getAllByRole("treeitem").length).toBeGreaterThan(0));
    const scroller = view.container.firstElementChild as HTMLElement;
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, writable: true, value: 100 },
    });
    const stage = screen.getByTestId("dag-stage");
    const up = new WheelEvent("wheel", { deltaY: -20, bubbles: true, cancelable: true });
    Object.defineProperty(up, "shiftKey", { value: true });
    stage.dispatchEvent(up);
    expect(scroller.scrollTop).toBe(80);
    expect(up.defaultPrevented).toBe(true);

    Object.defineProperty(scroller, "scrollTop", { configurable: true, writable: true, value: 0 });
    const atTop = new WheelEvent("wheel", { deltaY: -20, bubbles: true, cancelable: true });
    Object.defineProperty(atTop, "shiftKey", { value: true });
    stage.dispatchEvent(atTop);
    expect(atTop.defaultPrevented).toBe(false);

    const horizontal = new WheelEvent("wheel", { deltaY: 0, deltaX: 12, bubbles: true, cancelable: true });
    Object.defineProperty(horizontal, "shiftKey", { value: true });
    stage.dispatchEvent(horizontal);
    expect(scroller.scrollTop).toBe(12);

    const before = screen.getByTestId("dag-zoom").textContent;
    const modified = new WheelEvent("wheel", { deltaY: -3, deltaMode: 1, bubbles: true, cancelable: true });
    Object.defineProperties(modified, { shiftKey: { value: true }, ctrlKey: { value: true } });
    stage.dispatchEvent(modified);
    await waitFor(() => expect(screen.getByTestId("dag-zoom").textContent).not.toBe(before));
  });

  it("ignores secondary and chrome pointer presses and releases lazy pointer capture", async () => {
    await mount(wordcountStage());
    const stage = screen.getByTestId("dag-stage");
    const canvas = screen.getByTestId("dag-canvas");
    fireEvent.pointerDown(stage, { button: 2, pointerId: 7, clientX: 5, clientY: 5 });
    fireEvent.pointerMove(stage, { pointerId: 7, clientX: 30, clientY: 30 });
    expect(canvas.getAttribute("data-panning")).toBe("false");

    const capture = vi.fn();
    const release = vi.fn();
    const hasCapture = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    Object.defineProperty(stage, "hasPointerCapture", { configurable: true, value: hasCapture });
    Object.defineProperty(stage, "setPointerCapture", { configurable: true, value: capture });
    Object.defineProperty(stage, "releasePointerCapture", { configurable: true, value: release });
    fireEvent.pointerDown(screen.getByRole("button", { name: "Zoom in" }), { button: 0, pointerId: 8, clientX: 1, clientY: 1 });
    fireEvent.pointerMove(stage, { pointerId: 8, clientX: 20, clientY: 20 });
    expect(canvas.getAttribute("data-panning")).toBe("false");

    fireEvent.pointerDown(stage, { button: 0, pointerId: 9, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(stage, { pointerId: 9, clientX: 20, clientY: 20 });
    expect(canvas.getAttribute("data-panning")).toBe("true");
    fireEvent.pointerMove(stage, { pointerId: 9, clientX: 24, clientY: 24 });
    fireEvent.pointerUp(stage, { pointerId: 9, clientX: 20, clientY: 20 });
    expect(capture).toHaveBeenCalledWith(9);
    expect(release).toHaveBeenCalledWith(9);
    expect(canvas.getAttribute("data-panning")).toBe("false");

    const alreadyCaptured = vi.fn().mockReturnValue(true);
    Object.defineProperty(stage, "hasPointerCapture", { configurable: true, value: alreadyCaptured });
    fireEvent.pointerDown(stage, { button: 0, pointerId: 10, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(stage, { pointerId: 10, clientX: 20, clientY: 20 });
    expect(capture).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(stage, { pointerId: 10, clientX: 20, clientY: 20 });
  });

  it("opens the drawer with Enter and closes it with Escape", async () => {
    await mount(wordcountStage());
    const first = screen.getAllByRole("treeitem")[0]!;
    fireEvent.keyDown(first, { key: "Enter" });
    const drawer = await screen.findByRole("complementary", { name: /Details for/ });
    expect(drawer.getAttribute("data-open")).toBe("true");
    fireEvent.click(within(drawer).getByRole("button", { name: "Close details" }));
    await waitFor(() => expect(drawer.getAttribute("data-open")).toBe("false"));
    fireEvent.keyDown(first, { key: "Enter" });
    await waitFor(() => expect(drawer.getAttribute("data-open")).toBe("true"));
    fireEvent.keyDown(screen.getByTestId("dag-canvas"), { key: "Escape" });
    await waitFor(() => expect(screen.getByTestId("dag-drawer").getAttribute("data-open")).toBe("false"));
  });
});

describe("interaction", () => {
  it("shows only reported shuffle measurements in a cross-stage edge drawer", () => {
    const metrics = new Map(
      stageMetricsFromRest([
        { stageId: 2, status: "COMPLETE", numTasks: 1, shuffleWriteBytes: 1024, shuffleWriteRecords: null },
        { stageId: 3, status: "COMPLETE", numTasks: 1, shuffleReadBytes: null, shuffleFetchWaitTime: 12 },
      ]).map((metric) => [metric.stageId, metric]),
    );
    const edge = {
      edge: { id: "2-3", from: "stage-2", to: "stage-3", kind: "cross-stage", fromStage: 2, toStage: 3 },
      points: [],
      path: "",
      arrow: null,
      flowing: false,
      intensity: 0,
      opacity: 1,
      dashArray: "",
      animationSeconds: 0,
      travel: 0,
      selected: false,
      hovered: false,
      dimmed: false,
      shuffleLabel: null,
      labels: [],
    } as EdgeVisual;
    render(<EdgeDrawer open onClose={() => undefined} edge={edge} graphKind="job" metrics={metrics} producer={null} consumer={null} />);

    const table = document.querySelector(".burrow-dag-measure-table")!;
    expect(table.textContent).toContain("Stage 2 shuffle write");
    expect(table.textContent).toContain("Stage 3 fetch wait");
    expect(table.textContent).not.toContain("shuffle records written");
    expect(table.textContent).not.toContain("Stage 3 shuffle read");
  });

  it("uses toolbar zoom, fit, stage focus, and the accessible edge menu", async () => {
    const selected: unknown[] = [];
    await mount(barrierJob(), {
      expandStages: true,
      onSelectEdge: (edge: unknown) => selected.push(edge),
    });
    const zoom = screen.getByTestId("dag-zoom");
    const before = zoom.textContent;
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    await waitFor(() => expect(zoom.textContent).not.toBe(before));
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    fireEvent.click(screen.getByRole("button", { name: "Fit graph to view" }));
    fireEvent.click(screen.getByRole("button", { name: /^Focus stage/ }));

    fireEvent.click(screen.getByRole("button", { name: /^Edges \(/ }));
    const edgeItem = within(screen.getByTestId("dag-edge-list")).getAllByRole("menuitem")[0]!;
    fireEvent.click(edgeItem);
    expect(selected).toHaveLength(1);
    expect(selected[0]).toEqual(expect.objectContaining({ from: expect.any(Number), to: expect.any(Number) }));
    expect(screen.getByTestId("dag-edge-drawer").getAttribute("data-open")).toBe("true");
    fireEvent.click(within(screen.getByTestId("dag-edge-drawer")).getByRole("button", { name: "Close details" }));
    expect(screen.getByTestId("dag-edge-drawer").getAttribute("data-open")).toBe("false");
  });

  it("focuses a stage from its node bounds when cluster bounds are absent", async () => {
    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 320, bottom: 400, width: 320, height: 400, toJSON: () => ({}) }),
    });
    const dag = wordcountStage();
    dag.stages[0]!.attempt = undefined;
    const client = layoutClient();
    const layout = await client.layout(toRenderGraph(dag));
    vi.spyOn(client, "layout").mockResolvedValue({ ...layout, clusters: new Map() });
    await mount(dag, { selectedStageId: 0 });

    fireEvent.click(screen.getByRole("button", { name: "Focus stage 0" }));
    await waitFor(() => expect(Number.parseInt(screen.getByTestId("dag-zoom").textContent ?? "0", 10)).toBeLessThanOrEqual(75));
  });

  it("shows a layout failure and retries it", async () => {
    const client = layoutClient();
    const layout = vi.spyOn(client, "layout").mockRejectedValueOnce("worker unavailable");
    try {
      render(<DagView dag={wordcountStage()} height={400} />);
      expect(await screen.findByText(/worker unavailable/)).toBeTruthy();
      expect(screen.getByTestId("dag-canvas").getAttribute("data-dag-layout")).toBe("error");
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(screen.getAllByRole("treeitem").length).toBeGreaterThan(0), { timeout: 10_000 });
      expect(screen.getByTestId("dag-canvas").getAttribute("data-dag-layout")).toBe("ready");
    } finally {
      layout.mockRestore();
    }
  });

  it("zooms at the pointer and focuses the selected stage", async () => {
    await mount(wordcountStage(), { selectedStageId: 0 });
    const canvas = screen.getByTestId("dag-canvas");
    const stage = screen.getByTestId("dag-stage");
    const beforeWheel = screen.getByTestId("dag-zoom").textContent;
    const wheel = new WheelEvent("wheel", {
      deltaY: -120,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(wheel, "clientX", { value: 320 });
    Object.defineProperty(wheel, "clientY", { value: 180 });
    stage.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    await waitFor(() => expect(screen.getByTestId("dag-zoom").textContent).not.toBe(beforeWheel));

    fireEvent.click(screen.getByRole("button", { name: "Focus stage 0" }));
    expect(canvas.getAttribute("data-dag-layout")).toBe("ready");
  });

  it("reveals cross-stage shuffle labels at detail zoom", async () => {
    const metrics = stageMetricsFromRest(readStages("4.2.0", "barrier-scopes")).map((metric) => ({
      ...metric,
      shuffleReadBytes: metric.stageId === 1 ? 1024 : metric.shuffleReadBytes,
    }));
    const scenes: Scene[] = [];
    await mount(barrierJob(), { expandStages: true, metrics, onScene: (scene: Scene) => scenes.push(scene) });

    for (let i = 0; i < 8; i++) fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    await waitFor(() => expect(scenes.some((scene) => scene.edges.some((edge) => edge.shuffleLabel != null))).toBe(true));
    expect(scenes.some((scene) => scene.edges.some((edge) => Boolean(edge.shuffleLabel)))).toBe(true);
  });

  it("summarizes RDD partitions, refreshes changed badges, and tracks node hover", async () => {
    const dag = wordcountStage();
    for (const stage of dag.stages) for (const node of stage.nodes) node.callsite = "";
    const metrics = stageMetricsFromRest(readStages("4.2.0", "rdd-wordcount")).map((metric) => ({
      ...metric,
      stageId: 0,
      shuffleWriteBytes: 1024,
    }));
    const scenes: Scene[] = [];
    const view = await mount(dag, { metrics, onScene: (scene: Scene) => scenes.push(scene) });
    for (let i = 0; i < 8; i++) fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));

    const rddVisual = scenes.at(-1)?.nodes.find((visual) => visual.node.kind === "rdd");
    expect(rddVisual?.taskSummary).toMatch(/\d+ \/ \d+ tasks/);
    expect(rddVisual?.badges.some((badge) => badge.key === "sw" && badge.text.includes("1 KiB"))).toBe(true);
    const item = screen.getAllByRole("treeitem").find((candidate) => candidate.getAttribute("data-kind") === "rdd")!;
    fireEvent.pointerEnter(item);
    await waitFor(() => expect(item.getAttribute("data-hovered")).toBe("true"));
    fireEvent.pointerLeave(item);
    await waitFor(() => expect(item.getAttribute("data-hovered")).toBe("false"));

    const changedMetrics = metrics.map((metric) => ({
      ...metric,
      shuffleWriteBytes: (metric.shuffleWriteBytes ?? 0) + 1024,
    }));
    view.rerender(<DagView dag={dag} height={400} metrics={changedMetrics} onScene={(scene) => scenes.push(scene)} />);
    await waitFor(() => {
      const updatedRdd = scenes.at(-1)?.nodes.find((visual) => visual.node.kind === "rdd");
      expect(updatedRdd?.badges.some((badge) => badge.key === "sw" && badge.text.includes("2 KiB"))).toBe(true);
    });
  });

  it("opens a wide active graph focused on running work", async () => {
    const dag = syntheticDag({ stages: 120, nodesPerStage: 4, skipEvery: 0, seed: 7 });
    const metrics = createSimulator(dag).at(1000);
    const scenes: Scene[] = [];
    const view = await mount(dag, { onScene: (scene: Scene) => scenes.push(scene) });
    const initialTransform = screen.getByRole("tree").querySelector("g")?.getAttribute("transform");
    view.rerender(<DagView dag={dag} height={400} metrics={metrics} onScene={(scene) => scenes.push(scene)} />);

    await waitFor(() => expect(scenes.at(-1)?.runningNodes.length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByRole("tree").querySelector("g")?.getAttribute("transform")).not.toBe(initialTransform));
    expect(screen.getByTestId("dag-canvas").getAttribute("data-dag-layout")).toBe("ready");
  });

  it("uses the minimap to recenter and drag, while its wheel stays outside graph zoom", async () => {
    await mount(barrierJob(), { expandStages: true });
    const canvas = screen.getByTestId("dag-canvas");
    const stage = screen.getByTestId("dag-stage");
    const minimap = screen.getByTestId("dag-minimap");
    Object.defineProperty(minimap, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 168, bottom: 112, width: 168, height: 112, toJSON: () => ({}) }),
    });
    Object.defineProperty(minimap, "setPointerCapture", { configurable: true, value: () => {} });
    Object.defineProperty(minimap, "releasePointerCapture", { configurable: true, value: () => {} });
    const zoom = screen.getByTestId("dag-zoom").textContent;
    const wheel = new WheelEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true });
    minimap.dispatchEvent(wheel);
    expect(screen.getByTestId("dag-zoom").textContent).toBe(zoom);

    fireEvent.pointerDown(minimap, { pointerId: 12, clientX: 30, clientY: 20 });
    expect(canvas.getAttribute("data-panning")).toBe("true");
    fireEvent.pointerMove(minimap, { pointerId: 12, clientX: 40, clientY: 26, buttons: 1 });
    fireEvent.pointerLeave(stage);
    fireEvent.pointerUp(minimap, { pointerId: 12 });
    expect(canvas.getAttribute("data-panning")).toBe("false");
  });

  it("expands provenance notes on a REST fallback graph", async () => {
    await mount(fallbackJob(), { expandStages: true });
    const note = screen.getByRole("button", { name: /provenance note/ });
    expect(note.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(note);
    expect(note.getAttribute("aria-expanded")).toBe("true");
    expect(note.textContent).toContain("no RDD detail");
  });

  it("uses singular wording for a single provenance note", async () => {
    const dag = fallbackJob();
    dag.edgesInferred = false;
    await mount(dag);
    expect(screen.getByRole("button", { name: /provenance note$/ }).textContent).toContain("1 provenance note");
  });

  it("selects a node on click and reports the stage to the host", async () => {
    const seen: number[] = [];
    await mount(wordcountStage(), { onSelectStage: (stageId: number) => seen.push(stageId) });
    fireEvent.click(screen.getAllByRole("treeitem")[1]!);
    expect(seen).toContain(0);
    const drawer = screen.getByTestId("dag-drawer");
    expect(drawer.getAttribute("data-open")).toBe("true");
  });

  it("passes stage and RDD deep links to the selected-node drawer", async () => {
    const dag = wordcountStage();
    dag.stages[0]!.attempt = undefined;
    const stageHref = vi.fn((stageId: number, attempt: number) => `/stage/${stageId}/${attempt}`);
    const rddHref = vi.fn((rddId: number) => `/rdd/${rddId}`);
    const onSelectRdd = vi.fn();
    const onSelectStage = vi.fn();
    await mount(dag, { stageHref, rddHref, onSelectRdd, onSelectStage });
    fireEvent.click(screen.getAllByRole("treeitem")[0]!);
    expect(screen.getByRole("link", { name: "Open stage task list" }).getAttribute("href")).toMatch(/^\/stage\/0\//);
    expect(screen.getByRole("link", { name: "Open RDD storage detail" }).getAttribute("href")).toMatch(/^\/rdd\//);
    expect(onSelectStage).toHaveBeenCalledOnce();
    expect(onSelectRdd).toHaveBeenCalledOnce();
  });

  it("uses zero fallback refs for an inferred stage-summary edge and closes the node drawer for the edge menu", async () => {
    const selected: unknown[] = [];
    await mount(fallbackJob(), { expandStages: true, onSelectEdge: (value: unknown) => selected.push(value) });
    fireEvent.click(screen.getAllByRole("treeitem")[0]!);
    expect(screen.getByTestId("dag-drawer").getAttribute("data-open")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /^Edges \(/ }));
    await waitFor(() => expect(screen.getByTestId("dag-drawer").getAttribute("data-open")).toBe("false"));
    const item = within(screen.getByTestId("dag-edge-list")).getAllByRole("menuitem")[0]!;
    fireEvent.click(item);
    expect(selected[0]).toEqual(expect.objectContaining({ from: 0, to: 0 }));
  });

  it("sorts a selected stage chain when RDD references are missing", async () => {
    const dag = syntheticDag({ stages: 2, nodesPerStage: 4, skipEvery: 0, seed: 41 });
    const secondStage = dag.stages[1]!;
    expect(secondStage.stageId).not.toBe(0);
    secondStage.nodes[0]!.id = 0;
    secondStage.nodes[1]!.id = null as unknown as number;
    await mount(dag, { expandStages: true });
    const secondStageNode = screen.getAllByRole("treeitem").find((item) => item.getAttribute("data-node-id")?.startsWith("1.0."))!;
    fireEvent.click(secondStageNode);
    expect(screen.getByTestId("dag-drawer").getAttribute("data-open")).toBe("true");
  });

  it("breaks equal-position navigation ties by node id", async () => {
    const dag = wordcountStage();
    const graph = toRenderGraph(dag);
    const client = layoutClient();
    const layout = await client.layout(graph);
    vi.spyOn(client, "layout").mockResolvedValue({
      ...layout,
      nodes: new Map(graph.nodes.map((node) => [node.id, { x: 0, y: 0, width: 200, height: 84 }])),
    });
    await mount(dag);
    fireEvent.keyDown(screen.getByTestId("dag-canvas"), { key: "ArrowDown" });
    expect(screen.getAllByRole("treeitem").filter((item) => item.getAttribute("tabindex") === "0")).toHaveLength(1);
  });

  it("shows one and plural graph warnings", async () => {
    const one = wordcountStage();
    one.stages[0]!.edges.push({ from: 99_991, to: 99_992 });
    const single = await mount(one);
    await waitFor(() => expect(screen.getByTestId("dag-warnings").textContent).toContain("1 data warning"));
    single.unmount();

    const many = wordcountStage();
    many.stages[0]!.edges.push({ from: 99_991, to: 99_992 }, { from: 99_993, to: 99_994 });
    await mount(many);
    await waitFor(() => expect(screen.getByTestId("dag-warnings").textContent).toContain("data warnings"));
  });

  it("uses the canvas edge layer and dense-card mode for large expanded graphs", { timeout: 30_000 }, async () => {
    const dag = syntheticDag({ stages: 1, nodesPerStage: 460, skipEvery: 0, seed: 1 });
    const graph = toRenderGraph(dag, { expandStages: true });
    const geometry: LayoutResult = {
      hash: graph.hash,
      width: 20_000,
      height: 800,
      nodes: new Map(graph.nodes.map((item, index) => [item.id, { x: index * 220, y: 20, width: 200, height: 84 }])),
      clusters: new Map(graph.clusters.map((cluster) => [cluster.id, { x: 0, y: 0, width: 20_000, height: 500 }])),
      edges: new Map(
        graph.edges.map((item, index) => [
          item.id,
          [
            { x: index * 100, y: 100 },
            { x: index * 100 + 80, y: 100 },
          ],
        ]),
      ),
      durationMs: 1,
      ran: "main",
      rung: 0,
      ladderName: "coverage",
    };
    vi.spyOn(layoutClient(), "layout").mockResolvedValue(geometry);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    await mount(dag, { expandStages: true });
    expect(screen.getByTestId("dag-canvas").getAttribute("data-strategy")).toBe("canvas");
    expect(screen.getByTestId("dag-canvas").getAttribute("data-dense")).toBe("true");
    expect(document.querySelector("canvas.burrow-dag-edges-canvas, canvas")).not.toBeNull();
  });

  it("closes the drawer on a background click and keeps it on a node click", async () => {
    await mount(wordcountStage());
    fireEvent.click(screen.getAllByRole("treeitem")[1]!);
    const drawer = screen.getByTestId("dag-drawer");
    expect(drawer.getAttribute("data-open")).toBe("true");
    // The node's own click handler owns that selection, so a press that lands on the node must not clear it.
    const node = screen.getAllByRole("treeitem")[1]!;
    fireEvent.pointerDown(node, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(node, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    expect(drawer.getAttribute("data-open")).toBe("true");
    // An empty spot on the canvas is not a node: click it and the drawer goes away.
    const svg = screen.getByRole("tree");
    fireEvent.pointerDown(svg, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(svg, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    await waitFor(() => expect(screen.getByTestId("dag-drawer").getAttribute("data-open")).toBe("false"));
  });

  it("pans after the drag threshold and suppresses the click that follows a drag", async () => {
    const onSelectEdge = vi.fn();
    await mount(wordcountStage(), { onSelectEdge });
    const stage = screen.getByTestId("dag-stage");
    const node = screen.getAllByRole("treeitem")[0]!;
    fireEvent.pointerDown(node, { button: 0, pointerId: 9, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(stage, { pointerId: 9, clientX: 12, clientY: 10 });
    expect(screen.getByTestId("dag-canvas").getAttribute("data-panning")).toBe("false");
    fireEvent.pointerMove(stage, { pointerId: 9, clientX: 22, clientY: 20 });
    expect(screen.getByTestId("dag-canvas").getAttribute("data-panning")).toBe("true");
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    fireEvent.pointerUp(stage, { pointerId: 9, clientX: 22, clientY: 20 });
    fireEvent.click(node);
    const edge = screen.getByRole("tree").querySelector(".burrow-dag-edge-hit");
    expect(edge).not.toBeNull();
    fireEvent.click(edge!);
    expect(screen.getByTestId("dag-drawer").getAttribute("data-open")).toBe("false");
    expect(onSelectEdge).not.toHaveBeenCalled();
  });

  it("selects an edge from the hover target", async () => {
    const dag = barrierJob();
    const seen: unknown[] = [];
    await mount(dag, { expandStages: true, onSelectEdge: (e: unknown) => seen.push(e) });
    const svg = screen.getByRole("tree");
    const hit = svg.querySelector(".burrow-dag-edge-hit");
    expect(hit).not.toBeNull();
    fireEvent.click(hit!);
    expect(seen).toHaveLength(1);
    expect(screen.getByTestId("dag-edge-drawer").getAttribute("data-open")).toBe("true");
  });

  it("closes a stale edge selection after its edge disappears from the graph", async () => {
    const original = barrierJob();
    const view = await mount(original, { expandStages: true });
    fireEvent.click(screen.getByRole("tree").querySelector(".burrow-dag-edge-hit")!);
    expect(screen.getByTestId("dag-edge-drawer").getAttribute("data-open")).toBe("true");

    const changed = barrierJob();
    changed.edges = [];
    for (const stage of changed.stages) stage.edges = [];
    view.rerender(<DagView dag={changed} height={400} expandStages />);
    await waitFor(() => expect(screen.getByTestId("dag-canvas").getAttribute("data-dag-layout")).toBe("ready"));
    expect(screen.getByTestId("dag-edge-drawer").getAttribute("data-open")).toBe("false");
  });

  it("nests groups by compound scope, mirroring the layout hierarchy", async () => {
    await mount(barrierJob(), { expandStages: true });
    const groups = screen.getAllByRole("group");
    // root graph group + one group per stage container + one per operation scope
    expect(groups.length).toBeGreaterThan(2);
    const root = groups.find((g) => g.getAttribute("aria-label") === "graph nodes")!;
    expect(root).toBeTruthy();
    // every treeitem is inside the root group, and the stage containers are named
    for (const item of screen.getAllByRole("treeitem")) expect(root.contains(item)).toBe(true);
    const stageGroups = groups.filter((g) => (g.getAttribute("aria-label") ?? "").startsWith("Stage"));
    expect(stageGroups.length).toBe(2);
    for (const g of stageGroups) expect(g.querySelectorAll("[role='treeitem']").length).toBeGreaterThan(0);
    // nested scopes sit inside their stage group, not beside it
    const nested = groups.filter((g) => (g.getAttribute("aria-label") ?? "").endsWith("(scope)"));
    expect(nested.length).toBeGreaterThan(0);
    expect(stageGroups.some((s) => s.querySelector("[data-cluster]") !== null)).toBe(true);
  });
});

describe("DagMinimap", () => {
  it("picks points on pointer down and drag, and ends panning on pointer up", () => {
    const picked: Array<[number, number]> = [];
    const started = vi.fn();
    const ended = vi.fn();
    const { container } = render(
      <DagMinimap
        nodes={[]}
        width={168}
        height={112}
        contentWidth={336}
        contentHeight={224}
        projection={{ scale: 0.5, offsetX: 0, offsetY: 0 }}
        viewRect={{ x: 0, y: 0, width: 100, height: 100 }}
        onPick={(x, y) => picked.push([x, y])}
        onDragStart={started}
        onDragEnd={ended}
      />,
    );
    const minimap = container.querySelector("svg")!;
    Object.defineProperty(minimap, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 168, bottom: 112, width: 168, height: 112, toJSON: () => ({}) }),
    });
    Object.defineProperty(minimap, "setPointerCapture", { configurable: true, value: () => {} });
    Object.defineProperty(minimap, "releasePointerCapture", { configurable: true, value: () => {} });
    fireEvent.pointerDown(minimap, { pointerId: 4, clientX: 30, clientY: 25 });
    fireEvent.pointerMove(minimap, { pointerId: 4, clientX: 45, clientY: 35, buttons: 1 });
    fireEvent.pointerMove(minimap, { pointerId: 4, clientX: 50, clientY: 40, buttons: 0 });
    fireEvent.pointerUp(minimap, { pointerId: 4 });
    expect(started).toHaveBeenCalledOnce();
    expect(ended).toHaveBeenCalledOnce();
    expect(picked).toEqual([
      [60, 50],
      [90, 70],
    ]);
  });
});

describe("metrics and parity attributes", () => {
  const wordcountMetrics = () => stageMetricsFromRest(readStages("4.2.0", "rdd-wordcount"));
  const stage0 = () => wordcountMetrics().find((m) => m.stageId === 0)!;

  it("stamps every drawer metric row with its upstream field id and raw value", async () => {
    const metrics = wordcountMetrics();
    await mount(wordcountStage(), { metrics });
    fireEvent.click(screen.getAllByRole("treeitem")[0]!);
    const drawer = screen.getByTestId("dag-drawer");
    const stamped = drawer.querySelectorAll("[data-yf]");
    expect(stamped.length).toBeGreaterThan(5);
    for (const el of stamped) {
      expect(el.getAttribute("data-yf")).toMatch(/^spark\.stage\./);
      expect(el.getAttribute("data-yv")).not.toBeNull();
    }
    const entity = drawer.querySelector("[data-ye]")!;
    expect(entity.getAttribute("data-ye")).toMatch(/^\d+\/\d+$/);
    // the raw value is the payload's own value, not the formatted text
    const numTasks = drawer.querySelector('[data-yf="spark.stage.numTasks"]')!;
    expect(numTasks.getAttribute("data-yv")).toBe(String(stage0().numTasks));
  });

  it("exposes captured progress on the node itself, not only in the drawer", async () => {
    const metrics = wordcountMetrics();
    await mount(wordcountStage(), { metrics });
    const progress = screen.getAllByRole("progressbar")[0]!;
    const expected = Math.round((stage0().numCompleteTasks / stage0().numTasks) * 100);
    expect(progress.getAttribute("aria-valuenow")).toBe(String(expected));
    expect(progress.getAttribute("aria-valuetext")).toMatch(/completed/);
    expect(progress.getAttribute("aria-label")).toMatch(/task progress/);
  });

  it("applies the catch-up duration to live progress in the same render", async () => {
    const before = {
      ...stage0(),
      status: "ACTIVE" as const,
      numTasks: 100,
      numCompleteTasks: 10,
      numCompletedIndices: 10,
      numActiveTasks: 4,
      numFailedTasks: 0,
    };
    const after = { ...before, numCompleteTasks: 80, numCompletedIndices: 80 };
    const dag = wordcountStage();
    const { rerender } = await mount(dag, { metrics: [before] });

    rerender(<DagView dag={dag} height={400} metrics={[after]} />);
    const progressBars = screen.getAllByRole("progressbar");
    expect(progressBars).toHaveLength(4);
    for (const progress of progressBars) {
      expect(progress.getAttribute("aria-valuenow")).toBe("80");
      const segments = progress.querySelectorAll<SVGRectElement>(".burrow-dag-progress-seg");
      expect([...segments].some((segment) => segment.style.transitionDuration === "620ms")).toBe(true);
    }
  });

  it("maps newly entering stage progress onto its rendered RDD nodes", async () => {
    const first = syntheticDag({ stages: 1, nodesPerStage: 4, skipEvery: 0, seed: 13 });
    const expanded = syntheticDag({ stages: 2, nodesPerStage: 4, skipEvery: 0, seed: 13 });
    const firstMetrics = createSimulator(first).at(1000);
    const nextMetrics = createSimulator(expanded).at(1000);
    const view = await mount(first, { metrics: firstMetrics });
    const initialCount = screen.getAllByRole("treeitem").length;

    view.rerender(<DagView dag={expanded} height={400} metrics={nextMetrics} />);
    await waitFor(() => expect(screen.getAllByRole("treeitem").length).toBeGreaterThan(initialCount), { timeout: 10_000 });
  });
  it("makes skipped RDD state accessible in codegen clusters", async () => {
    const dag = readDag("4.2.0", "df-join-aqe", "dag-job-2.json");
    await mount(dag, { expandStages: true });
    const skippedNodes = screen
      .getAllByRole("treeitem")
      .filter((item) => item.getAttribute("data-kind") === "rdd" && item.getAttribute("data-skipped") === "true");
    expect(skippedNodes.length).toBeGreaterThan(0);
    for (const item of skippedNodes) expect(item.getAttribute("aria-label")).toMatch(/\bskipped\b/i);
  });

  /** The SQL plan the drawer's metric fallback is written against: one operator, two accumulables. */
  const SQL_METRICS: SqlPlanMetric[] = [
    { name: "number of output rows", value: "2" },
    { name: "time to build", value: "1 ms" },
  ];
  const sqlPlan = (metrics: SqlPlanMetric[] | undefined): SqlPlanExecution => ({
    id: 0,
    status: "COMPLETE",
    description: "SortMergeJoin",
    nodes: [{ nodeId: 17, nodeName: "SortMergeJoin", metrics }],
    edges: [],
  });

  it("falls back to a SQL plan operator's own metrics, with minted positional ids", async () => {
    await mount(sqlPlan(SQL_METRICS));
    fireEvent.click(screen.getAllByRole("treeitem")[0]!);
    const drawer = screen.getByTestId("dag-drawer");
    expect(within(drawer).getByText("SQL plan metrics")).toBeTruthy();
    expect(within(drawer).getByText("operator accumulables from the SQL plan — not stage task counters")).toBeTruthy();
    // one row per accumulable, name and value, ids minted by list position
    expect(drawer.querySelector('[data-yf="spark.sql.metrics[0].name"]')!.getAttribute("data-yv")).toBe("number of output rows");
    expect(drawer.querySelector('[data-yf="spark.sql.metrics[0].value"]')!.getAttribute("data-yv")).toBe("2");
    expect(drawer.querySelector('[data-yf="spark.sql.metrics[1].name"]')!.getAttribute("data-yv")).toBe("time to build");
    expect(drawer.querySelector('[data-yf="spark.sql.metrics[1].value"]')!.getAttribute("data-yv")).toBe("1 ms");
    // the plan's metrics are never stamped as stage counters
    expect(drawer.querySelectorAll('[data-yf^="spark.stage."]')).toHaveLength(0);
  });

  it("shows a Spark 2.4 operator's captured plan line in its hover title and drawer", async () => {
    const plan = sqlPlan(undefined);
    plan.nodes[0]!.planLine = "Range (0, 10000, step=1, splits=4)";
    await mount(plan);

    const item = screen.getByRole("treeitem");
    expect(item.querySelector("title")?.textContent).toContain("Plan line: Range (0, 10000, step=1, splits=4)");
    fireEvent.click(item);
    const drawer = screen.getByTestId("dag-drawer");
    expect(within(drawer).getByText("Plan line")).toBeTruthy();
    expect(within(drawer).getByText("Range (0, 10000, step=1, splits=4)")).toBeTruthy();
  });

  it("keeps the stage join as the only metric source for a stage node", async () => {
    const metrics = stageMetricsFromRest([
      { stageId: 2, attemptId: 0, status: "COMPLETE", numTasks: 4, numCompleteTasks: 4 },
      { stageId: 3, attemptId: 0, status: "COMPLETE", numTasks: 2, numCompleteTasks: 2 },
    ]);
    await mount(barrierJob(), { metrics });
    fireEvent.click(screen.getAllByRole("treeitem")[0]!);
    const drawer = screen.getByTestId("dag-drawer");
    expect(drawer.querySelectorAll('[data-yf^="spark.stage."]').length).toBeGreaterThan(0);
    expect(drawer.querySelectorAll('[data-yf^="spark.sql.metrics"]')).toHaveLength(0);
    expect(within(drawer).queryByText("SQL plan metrics")).toBeNull();
  });

  it("falls back to the no-metrics note when a SQL operator carries none", async () => {
    for (const metrics of [undefined, [] as SqlPlanMetric[]]) {
      const { unmount } = await mount(sqlPlan(metrics));
      fireEvent.click(screen.getAllByRole("treeitem")[0]!);
      const drawer = screen.getByTestId("dag-drawer");
      // A SQL operator with no accumulables must not claim the graph came from a DOT payload — that copy is for stage
      // nodes whose REST metrics have not landed.
      expect(within(drawer).getByText(/no accumulables in the plan JSON/)).toBeTruthy();
      expect(drawer.querySelectorAll('[data-yf^="spark.sql.metrics"]')).toHaveLength(0);
      unmount();
    }
  });
});

describe("layout lifecycle, exports, and progress announcements", () => {
  it("uses the default height and safely handles shortcuts before layout resolves", async () => {
    const client = layoutClient();
    const original = client.layout.bind(client);
    const layout = await original(toRenderGraph(wordcountStage()));
    let resolveLayout: ((value: LayoutResult) => void) | undefined;
    const pending = vi.spyOn(client, "layout").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLayout = resolve;
        }),
    );
    const view = render(<DagView dag={wordcountStage()} />);
    expect(view.container.querySelector(".burrow-dag-frame")?.getAttribute("style")).toContain("420px");
    const canvas = screen.getByTestId("dag-canvas");
    fireEvent.keyDown(canvas, { key: "+" });
    fireEvent.keyDown(canvas, { key: "0" });
    await act(async () => {
      resolveLayout?.(layout);
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getAllByRole("treeitem").length).toBeGreaterThan(0));
    pending.mockRestore();
  });

  it("keeps zoom and stage-focus controls safe when the measured pane has zero width", async () => {
    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }),
    });
    render(<DagView dag={wordcountStage()} height={400} selectedStageId={0} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Zoom in" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(screen.getByRole("button", { name: "Focus stage 0" }));
    fireEvent.pointerDown(screen.getByTestId("dag-minimap"), { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.keyDown(screen.getByTestId("dag-canvas"), { key: "ArrowDown" });
    expect(screen.getByTestId("dag-canvas").getAttribute("data-dag-layout")).toBe("ready");
  });

  it("uses identity viewports for keyboard, wheel, and drag input before layout resolves", async () => {
    const client = layoutClient();
    vi.spyOn(client, "layout").mockImplementation(() => new Promise(() => {}));
    const pendingView = () => render(<DagView dag={wordcountStage()} height={400} />);

    let view = pendingView();
    fireEvent.keyDown(screen.getByTestId("dag-canvas"), { key: "ArrowDown", shiftKey: true });
    view.unmount();

    view = pendingView();
    fireEvent.keyDown(screen.getByTestId("dag-canvas"), { key: "ArrowUp", shiftKey: true });
    view.unmount();

    view = pendingView();
    const wheel = new WheelEvent("wheel", { deltaY: -20, bubbles: true, cancelable: true });
    await act(() => {
      screen.getByTestId("dag-stage").dispatchEvent(wheel);
    });
    expect(wheel.defaultPrevented).toBe(true);
    view.unmount();

    view = pendingView();
    const stage = screen.getByTestId("dag-stage");
    fireEvent.pointerDown(stage, { button: 0, pointerId: 21, clientX: 2, clientY: 2 });
    fireEvent.pointerMove(stage, { pointerId: 21, clientX: 12, clientY: 12 });
    expect(screen.getByTestId("dag-canvas").getAttribute("data-panning")).toBe("true");
    view.unmount();
  });

  it("initializes an empty graph without a focus node", async () => {
    const empty: Dag = { kind: "job", granularity: "stage", stages: [], edges: [] };
    const graph = toRenderGraph(empty);
    vi.spyOn(layoutClient(), "layout").mockResolvedValue({
      hash: graph.hash,
      width: 100,
      height: 100,
      nodes: new Map(),
      clusters: new Map(),
      edges: new Map(),
      durationMs: 1,
      ran: "main",
      rung: 0,
      ladderName: "coverage",
    });
    render(<DagView dag={empty} height={400} />);
    await waitFor(() => expect(screen.getByTestId("dag-canvas").getAttribute("data-dag-layout")).toBe("ready"));
  });

  it("reports worker layouts and formats Error failures", async () => {
    const client = layoutClient();
    const original = client.layout.bind(client);
    const workerLayout = vi.spyOn(client, "layout").mockImplementation(async (graph) => ({ ...(await original(graph)), ran: "worker" }));
    const workerView = render(<DagView dag={wordcountStage()} height={400} />);
    await waitFor(() => expect(screen.getAllByRole("treeitem").length).toBeGreaterThan(0), { timeout: 10_000 });
    expect(screen.getByRole("toolbar").textContent).toContain("worker");
    workerView.unmount();
    workerLayout.mockRestore();

    const failed = vi.spyOn(client, "layout").mockRejectedValueOnce(new Error("layout exploded"));
    render(<DagView dag={wordcountStage()} height={400} />);
    expect(await screen.findByText(/layout exploded/)).toBeTruthy();
    failed.mockRestore();
  });

  it("ignores layout completion and errors after unmount", async () => {
    const client = layoutClient();
    let resolveLayout: ((layout: LayoutResult) => void) | undefined;
    const pendingSuccess = vi.spyOn(client, "layout").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLayout = resolve;
        }),
    );
    const successView = render(<DagView dag={wordcountStage()} height={400} />);
    successView.unmount();
    await act(async () => {
      resolveLayout?.({} as LayoutResult);
      await Promise.resolve();
    });
    pendingSuccess.mockRestore();

    let rejectLayout: ((error: unknown) => void) | undefined;
    const pendingFailure = vi.spyOn(client, "layout").mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectLayout = reject;
        }),
    );
    const failureView = render(<DagView dag={wordcountStage()} height={400} />);
    failureView.unmount();
    await act(async () => {
      rejectLayout?.(new Error("late layout error"));
      await Promise.resolve();
    });
    pendingFailure.mockRestore();
  });

  it("announces singular failure and completion transitions", async () => {
    const dag = wordcountStage();
    const before = stageMetricsFromRest([{ stageId: 0, status: "ACTIVE", numTasks: 10, numActiveTasks: 2, numCompleteTasks: 5 }]);
    const view = await mount(dag, { metrics: before });
    const live = () => view.container.querySelector('[aria-live="polite"]')?.textContent ?? "";
    view.rerender(
      <DagView
        dag={dag}
        height={400}
        metrics={stageMetricsFromRest([{ stageId: 0, status: "FAILED", numTasks: 10, numFailedTasks: 1, numCompleteTasks: 5 }])}
      />,
    );
    await waitFor(() => expect(live()).toContain("1 stage failed"));
    view.rerender(
      <DagView
        dag={dag}
        height={400}
        metrics={stageMetricsFromRest([{ stageId: 0, status: "COMPLETE", numTasks: 10, numCompleteTasks: 10 }])}
      />,
    );
    await waitFor(() => expect(live()).toContain("1 stage completed"));
  });

  it("announces plural failures and completions across stages", async () => {
    const dag = syntheticDag({ stages: 2, nodesPerStage: 2, skipEvery: 0, seed: 19 });
    const stageIds = dag.stages.map((stage) => stage.stageId);
    const active = () =>
      stageMetricsFromRest(
        stageIds.map((stageId) => ({ stageId, status: "ACTIVE", numTasks: 10, numActiveTasks: 2, numCompleteTasks: 5 })),
      );
    const failed = () =>
      stageMetricsFromRest(
        stageIds.map((stageId) => ({ stageId, status: "FAILED", numTasks: 10, numFailedTasks: 1, numCompleteTasks: 5 })),
      );
    const complete = () =>
      stageMetricsFromRest(stageIds.map((stageId) => ({ stageId, status: "COMPLETE", numTasks: 10, numCompleteTasks: 10 })));
    const view = await mount(dag, { metrics: active() });
    const live = () => view.container.querySelector('[aria-live="polite"]')?.textContent ?? "";
    view.rerender(<DagView dag={dag} height={400} metrics={failed()} />);
    await waitFor(() => expect(live()).toContain("2 stages failed"));
    view.rerender(<DagView dag={dag} height={400} metrics={complete()} />);
    await waitFor(() => expect(live()).toContain("2 stages completed"));
  });

  it("announces progress while layout is pending and clears the flash after its timer", async () => {
    const dag = wordcountStage();
    const client = layoutClient();
    vi.spyOn(client, "layout").mockImplementation(() => new Promise(() => {}));
    const active = stageMetricsFromRest([{ stageId: 0, status: "ACTIVE", numTasks: 10, numActiveTasks: 2, numCompleteTasks: 5 }]);
    const complete = stageMetricsFromRest([{ stageId: 0, status: "COMPLETE", numTasks: 10, numCompleteTasks: 10 }]);
    const view = render(<DagView dag={dag} height={400} metrics={active} />);
    await act(async () => {
      await Promise.resolve();
    });
    view.rerender(<DagView dag={dag} height={400} metrics={complete} />);
    const live = () => view.container.querySelector('[aria-live="polite"]')?.textContent ?? "";
    await waitFor(() => expect(live()).toContain("1 stage completed. 0 of 0 tasks complete"));

    view.unmount();
    vi.restoreAllMocks();

    const ready = await mount(dag, { metrics: active });
    ready.rerender(<DagView dag={dag} height={400} metrics={complete} />);
    await waitFor(() => expect(ready.container.querySelector('[data-flash="true"]')).not.toBeNull());
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 950));
    });
    expect(ready.container.querySelector('[data-flash="true"]')).toBeNull();
  });

  it("flashes newly reported stages as they enter the metrics stream", async () => {
    const dag = wordcountStage();
    const view = await mount(dag);
    const metrics = stageMetricsFromRest([{ stageId: 0, status: "ACTIVE", numTasks: 10, numActiveTasks: 1 }]);
    view.rerender(<DagView dag={dag} height={400} metrics={metrics} />);
    await waitFor(() => expect(view.container.querySelector('[data-flash="true"]')).not.toBeNull());
  });

  it("exports the interactive graph and falls back to a safe filename", async () => {
    vi.mocked(download).mockClear();
    const dag = wordcountStage();
    const view = await mount(dag, { ariaLabel: "$$$", showLegend: false, toolbarExtras: <button type="button">Preview control</button> });
    expect(screen.queryByText("cached RDD")).toBeNull();
    expect(screen.getByRole("button", { name: "Preview control" })).toBeTruthy();
    const originalGetComputedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
      if (element === screen.getByTestId("dag-stage")) {
        return { getPropertyValue: (name: string) => (name === "--ground" ? " #123456 " : "") } as CSSStyleDeclaration;
      }
      return originalGetComputedStyle(element);
    });
    fireEvent.click(screen.getByRole("button", { name: "Download interactive DAG snapshot (HTML)" }));
    await waitFor(() => expect(download).toHaveBeenCalledOnce());
    const [filename, mime, html] = vi.mocked(download).mock.calls[0]!;
    expect(filename).toBe("dag.html");
    expect(mime).toBe("text/html");
    expect(html).toContain("#123456");
    expect(html).toContain("burrow-dagviz-export");
    view.rerender(<DagView dag={dag} height={400} />);
    fireEvent.click(screen.getByRole("button", { name: "Download interactive DAG snapshot (HTML)" }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(2));
    expect(vi.mocked(download).mock.calls[1]?.[0]).toBe("stage-dag.html");
  });
});

describe("states", () => {
  it("renders the REST fallback meaningfully and marks it inferred", async () => {
    const dag = fallbackJob();
    await mount(dag);
    const canvas = screen.getByTestId("dag-canvas");
    expect(canvas.getAttribute("data-inferred")).toBe("true");
    expect(screen.getAllByRole("treeitem")).toHaveLength(dag.stages.length);
    expect(screen.getByText(/edges inferred/)).toBeTruthy();
    expect(screen.getAllByText(/RDDs?$/).length).toBeGreaterThan(0);
  });

  it("explains a graph with no metrics instead of pretending it is live", async () => {
    await mount(wordcountStage());
    expect(screen.getByTestId("dag-partial").textContent).toMatch(/Waiting for stage metrics/);
  });

  it("says so when a stage-level payload has no RDD detail to expand", async () => {
    await mount(fallbackJob(), { expandStages: true });
    const canvas = screen.getByTestId("dag-canvas");
    expect(canvas).toBeTruthy();
    expect(screen.getAllByRole("treeitem").length).toBeGreaterThan(0);
  });

  it("renders an empty DAG without crashing", async () => {
    const empty: Dag = { kind: "job", granularity: "stage", stages: [], edges: [] };
    render(<DagView dag={empty} height={200} />);
    await waitFor(() => expect(screen.getByTestId("dag-state")).toBeTruthy());
    expect(screen.getByText(/has no nodes/)).toBeTruthy();
  });
});

describe("tokens only", () => {
  it("emits no literal colours in the rendered markup", async () => {
    const metrics = stageMetricsFromRest(readStages("4.2.0", "rdd-wordcount"));
    await mount(wordcountStage(), { metrics });
    fireEvent.click(screen.getAllByRole("treeitem")[0]!);
    const html = screen.getByTestId("dag-canvas").outerHTML;
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(html).not.toMatch(/\brgba?\(/);
    expect(html).not.toMatch(/\bhsla?\(/);
  });
});
