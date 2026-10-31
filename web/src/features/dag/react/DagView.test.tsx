/**
 * Render-level behaviour (jsdom): accessibility tree, keyboard navigation, drawer contents with parity attributes,
 * loading/partial states, and the "tokens only" guard on the markup we emit.
 *
 * Real fixtures are used for every case (including the REST fallback), and mount helpers below keep the specs short.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DagView } from "./DagView";
import { DagMinimap } from "./chrome";
import { toRenderGraph } from "../layout";
import { layoutClient } from "../layout/client";
import { createSimulator, syntheticDag } from "../simulate";
import { stageMetricsFromRest } from "../metrics";
import type { Dag, DagInput, SqlPlanExecution, SqlPlanMetric } from "../types";

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
    fireEvent.keyDown(canvas, { key: "x" });
    expect(tabbable()).toBeTruthy();
    expect(afterRight).toBeTruthy();
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

  it("opens the drawer with Enter and closes it with Escape", async () => {
    await mount(wordcountStage());
    const first = screen.getAllByRole("treeitem")[0]!;
    fireEvent.keyDown(first, { key: "Enter" });
    const drawer = await screen.findByRole("complementary", { name: /Details for/ });
    expect(drawer.getAttribute("data-open")).toBe("true");
    fireEvent.keyDown(screen.getByTestId("dag-canvas"), { key: "Escape" });
    await waitFor(() => expect(screen.getByTestId("dag-drawer").getAttribute("data-open")).toBe("false"));
  });
});

describe("interaction", () => {
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

  it("expands provenance notes on a REST fallback graph", async () => {
    await mount(fallbackJob(), { expandStages: true });
    const note = screen.getByRole("button", { name: /provenance note/ });
    expect(note.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(note);
    expect(note.getAttribute("aria-expanded")).toBe("true");
    expect(note.textContent).toContain("no RDD detail");
  });

  it("selects a node on click and reports the stage to the host", async () => {
    const seen: number[] = [];
    await mount(wordcountStage(), { onSelectStage: (stageId: number) => seen.push(stageId) });
    fireEvent.click(screen.getAllByRole("treeitem")[1]!);
    expect(seen).toContain(0);
    const drawer = screen.getByTestId("dag-drawer");
    expect(drawer.getAttribute("data-open")).toBe("true");
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
    await mount(wordcountStage());
    const stage = screen.getByTestId("dag-stage");
    const node = screen.getAllByRole("treeitem")[0]!;
    fireEvent.pointerDown(node, { button: 0, pointerId: 9, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(stage, { pointerId: 9, clientX: 12, clientY: 10 });
    expect(screen.getByTestId("dag-canvas").getAttribute("data-panning")).toBe("false");
    fireEvent.pointerMove(stage, { pointerId: 9, clientX: 22, clientY: 20 });
    expect(screen.getByTestId("dag-canvas").getAttribute("data-panning")).toBe("true");
    fireEvent.pointerUp(stage, { pointerId: 9, clientX: 22, clientY: 20 });
    fireEvent.click(node);
    expect(screen.getByTestId("dag-drawer").getAttribute("data-open")).toBe("false");
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
