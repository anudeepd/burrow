import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { stageMetricsFromRest } from "../metrics";
import type { EdgeVisual, NodeVisual } from "../render/scene";
import { MenuContent, MenuRoot } from "~/ui/menu";
import {
  DagLegend,
  DagToolbar,
  DagMinimap,
  StageDrawer,
  EdgeDrawer,
  EdgeListView,
  DagLoadingPanel,
  DagStatePanel,
  fmtForKey,
  humanizeKey,
} from "./chrome";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function node(overrides: Partial<NodeVisual> = {}): NodeVisual {
  return {
    node: { id: "stage-1", label: "Stage 1", kind: "stage", stageId: 1, attempt: 2, detail: "Stage detail", callsite: "job.scala:9" },
    rect: { x: 0, y: 0, width: 180, height: 90 },
    tone: "live",
    status: "ACTIVE",
    statusShape: "circle",
    statusLabel: "Active",
    running: true,
    skipped: false,
    selected: false,
    hovered: false,
    dimmed: false,
    flash: null,
    percent: 50,
    tweenMs: 0,
    segments: [],
    taskSummary: "5 / 10 tasks",
    badges: [],
    subText: null,
    depth: 1,
    ariaLabel: "Stage 1, active",
    labels: [],
    related: false,
    ...overrides,
  } as NodeVisual;
}

function metric(overrides: Record<string, unknown> = {}) {
  return stageMetricsFromRest([
    {
      stageId: 1,
      attemptId: 2,
      status: "ACTIVE",
      numTasks: 10,
      numActiveTasks: 2,
      numCompleteTasks: 5,
      numFailedTasks: 1,
      numKilledTasks: 0,
      submissionTime: 1_800_000_000_000,
      firstTaskLaunchedTime: 1_800_000_001_000,
      shuffleReadBytes: 2048,
      shuffleWriteBytes: 4096,
      shuffleWriteRecords: 32,
      shuffleFetchWaitTime: 15,
      customCamelCase: "value",
      custom_flag: true,
      customNull: null,
      customObject: { ignored: true },
      ...overrides,
    },
  ])[0]!;
}

const edge = (kind: "rdd" | "cross-stage" | "sql" = "rdd", overrides: Partial<EdgeVisual["edge"]> = {}): EdgeVisual => ({
  edge: { id: "e1", from: "a", to: "b", kind, ...overrides },
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
});

describe("DAG toolbar, legend, and status panels", () => {
  it("exposes toolbar controls with and without stage focus", () => {
    const fit = vi.fn();
    const zoomIn = vi.fn();
    const zoomOut = vi.fn();
    const exportHtml = vi.fn();
    const focus = vi.fn();
    const view = render(
      <DagToolbar
        scale={1.25}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onFit={fit}
        onExportHtml={exportHtml}
        exporting={false}
        totals={{ done: 4, total: 8, active: 2, failed: 1 }}
        percent={50}
        layoutNote="worker · 12 ms"
        nodeCount={4}
        edgeCount={3}
        focusStageId={7}
        onFocusStage={focus}
        trailingControls={<span>More controls</span>}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Fit graph to view" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    fireEvent.click(screen.getByRole("button", { name: "Download interactive DAG snapshot (HTML)" }));
    fireEvent.click(screen.getByRole("button", { name: "Focus stage 7" }));
    expect(fit).toHaveBeenCalledOnce();
    expect(zoomIn).toHaveBeenCalledOnce();
    expect(zoomOut).toHaveBeenCalledOnce();
    expect(exportHtml).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expect(view.getByTestId("dag-zoom").textContent).toContain("125");
    expect(view.container.textContent).toContain("More controls");
    view.rerender(
      <DagToolbar
        scale={1}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onFit={fit}
        onExportHtml={exportHtml}
        exporting
        onFocusStage={focus}
        totals={{ done: 0, total: 0, active: 0, failed: 0 }}
        percent={0}
        layoutNote="main"
        nodeCount={0}
        edgeCount={0}
      />,
    );
    expect(screen.queryByRole("button", { name: "Focus stage 7" })).toBeNull();
    expect(screen.getByRole("button", { name: "Preparing interactive DAG snapshot" }).hasAttribute("disabled")).toBe(true);
  });

  it("shows optional flow and inferred-edge legend items and both status panels", () => {
    const flow = render(<DagLegend />);
    expect(flow.container.textContent).toContain("data flowing now");
    expect(flow.container.textContent).not.toContain("edges inferred");
    flow.rerender(<DagLegend showFlow={false} inferred />);
    expect(flow.container.textContent).not.toContain("data flowing now");
    expect(flow.container.textContent).toContain("edges inferred (REST only)");

    const loading = render(<DagLoadingPanel detail="Waiting for layout" />);
    expect(loading.getByRole("status").textContent).toContain("Waiting for layout");
    loading.rerender(<DagLoadingPanel hidden />);
    expect(loading.getByTestId("dag-state").getAttribute("aria-hidden")).toBe("true");

    const state = render(<DagStatePanel title="Layout failed" detail="Try again" action={<button type="button">Retry</button>} />);
    expect(state.getByRole("button", { name: "Retry" })).toBeDefined();
    state.rerender(<DagStatePanel title="No graph" />);
    expect(state.container.textContent).not.toContain("Try again");
  });

  it("formats metric keys by their upstream units", () => {
    expect(humanizeKey("numCompleteTasks")).toBe("Num complete tasks");
    expect(humanizeKey("HTTPServer_ID")).toBe("Http server id");
    expect(humanizeKey(" already spaced ")).toBe("Already spaced");
    expect(fmtForKey("shuffleReadBytes", 1024).fmt).toBe("bytes");
    expect(fmtForKey("resultSize", 2).fmt).toBe("bytes");
    expect(fmtForKey("peakExecutionMemory", 2).fmt).toBe("bytes");
    expect(fmtForKey("executorRunTime", 10).fmt).toBe("dur");
    expect(fmtForKey("duration", 10).fmt).toBe("dur");
    for (const key of ["inputRecords", "numTasks", "stageId", "attemptId", "numCompletedIndices"])
      expect(fmtForKey(key, 10).fmt).toBe("int");
    expect(fmtForKey("custom", 10).fmt).toBe("text");
    expect(fmtForKey("custom", "value")).toEqual({ text: "value", fmt: "text" });
  });
});

describe("DAG drawers", () => {
  it("renders a stage drawer with progress, raw fields, chain links, and close behavior", () => {
    const onClose = vi.fn();
    const view = render(
      <StageDrawer
        open
        onClose={onClose}
        node={node()}
        metric={metric()}
        now={1_800_000_010_000}
        stageHref="/stages/1"
        rddHref="/rdd/1"
        chain={
          [
            { id: "r1", label: "ParallelCollectionRDD", kind: "rdd", cached: true, ref: 11 },
            { id: "r2", label: "MapPartitionsRDD", kind: "rdd", cached: false, ref: 12 },
          ] as never
        }
      />,
    );
    expect(view.getByTestId("dag-drawer").getAttribute("aria-hidden")).toBe("false");
    expect(view.container.textContent).toContain("5 of 10 tasks complete");
    expect(view.container.textContent).toContain("RDD chain (2)");
    expect(view.container.textContent).toContain("(cached)");
    expect(view.container.textContent).toContain("Custom camel case");
    expect(view.container.textContent).not.toContain("Custom object");
    expect(view.getByRole("link", { name: "Open stage task list" }).getAttribute("href")).toBe("/stages/1");
    expect(view.getByRole("link", { name: "Open RDD storage detail" }).getAttribute("href")).toBe("/rdd/1");
    fireEvent.click(view.getByRole("button", { name: "Close details" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("covers empty metrics, no node, and SQL operator metric/fallback states", () => {
    const empty = render(<StageDrawer open={false} onClose={() => undefined} node={null} metric={null} now={0} chain={[]} />);
    expect(empty.getByTestId("dag-drawer").getAttribute("aria-hidden")).toBe("true");
    expect(empty.container.textContent).not.toContain("Details");
    empty.unmount();

    const noStageMetric = render(
      <StageDrawer
        open
        onClose={() => undefined}
        node={node({ node: { id: "ghost", label: "Outside", kind: "ghost" } as never })}
        metric={null}
        now={0}
        chain={[]}
      />,
    );
    expect(noStageMetric.container.textContent).toContain("No REST metrics for this node yet");
    noStageMetric.unmount();

    const firstAttempt = render(
      <StageDrawer
        open
        onClose={() => undefined}
        node={node({ node: { ...node().node, attempt: undefined } })}
        metric={null}
        now={0}
        chain={[]}
      />,
    );
    expect(firstAttempt.container.textContent).toContain("stage 1 · attempt 0");
    firstAttempt.unmount();

    const sqlNode = node({
      node: { id: "sql", label: "Scan", kind: "sql", ref: 19, metrics: [{ name: "number of output rows", value: "42" }] } as never,
    });
    const sql = render(<StageDrawer open onClose={() => undefined} node={sqlNode} metric={null} now={0} chain={[]} />);
    expect(sql.container.textContent).toContain("physical operator");
    expect(sql.container.textContent).toContain("number of output rows");
    expect(sql.container.textContent).not.toContain("No REST metrics");
    sql.unmount();

    const sqlEmpty = render(
      <StageDrawer
        open
        onClose={() => undefined}
        node={node({ node: { id: "sql", label: "Scan", kind: "sql" } as never })}
        metric={null}
        now={0}
        chain={[]}
      />,
    );
    expect(sqlEmpty.container.textContent).toContain("This operator reports no accumulables");
  });

  it("shows the scroll cue only while there is content below the drawer viewport", async () => {
    const view = render(<StageDrawer open onClose={() => undefined} node={node()} metric={null} now={0} chain={[]} />);
    const drawer = view.getByTestId("dag-drawer");
    Object.defineProperties(drawer, {
      scrollHeight: { configurable: true, value: 400 },
      clientHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    await act(async () => fireEvent.scroll(drawer));
    expect(drawer.getAttribute("data-scroll-cue")).toBe("true");
    Object.defineProperty(drawer, "scrollTop", { configurable: true, writable: true, value: 300 });
    await act(async () => fireEvent.scroll(drawer));
    expect(drawer.getAttribute("data-scroll-cue")).toBe("false");
    Object.defineProperty(drawer, "scrollHeight", { configurable: true, value: 100 });
    Object.defineProperty(drawer, "scrollTop", { configurable: true, writable: true, value: 0 });
    await act(async () => fireEvent.scroll(drawer));
    expect(drawer.getAttribute("data-scroll-cue")).toBe("false");
  });

  it("runs the scroll observer path when ResizeObserver is unavailable", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const view = render(<StageDrawer open onClose={() => undefined} node={null} metric={null} now={0} chain={[]} />);
    expect(view.getByTestId("dag-drawer")).toBeDefined();
    view.unmount();
  });

  it("covers plan, shuffle, and plain RDD edge drawer branches", () => {
    const metrics = new Map([
      [1, metric()],
      [2, metric({ stageId: 2, shuffleReadBytes: 3072, shuffleFetchWaitTime: 15 })],
    ]);
    const planEdge = render(
      <EdgeDrawer
        open
        onClose={() => undefined}
        edge={edge("sql")}
        graphKind="sql"
        metrics={metrics}
        producer={node({ node: { id: "p", label: "Scan", kind: "sql", ref: 4 } as never })}
        consumer={node({ node: { id: "c", label: "Filter", kind: "sql", ref: 5 } as never })}
      />,
    );
    expect(planEdge.container.textContent).toContain("Plan dependency");
    expect(planEdge.container.textContent).toContain("#4");
    expect(planEdge.container.textContent).toContain("Physical-plan dependency");
    planEdge.unmount();

    const shuffle = edge("cross-stage", { fromStage: 1, toStage: 2 });
    const flowing = render(
      <EdgeDrawer
        open
        onClose={() => undefined}
        edge={{ ...shuffle, flowing: true, intensity: null } as unknown as EdgeVisual}
        graphKind="job"
        metrics={metrics}
        producer={node()}
        consumer={node({ node: { ...node().node, label: "Consumer" } as never })}
      />,
    );
    expect(flowing.container.textContent).toContain("Data is flowing now");
    expect(flowing.container.textContent).toContain("shuffle write");
    expect(flowing.container.textContent).toContain("shuffle read");
    flowing.unmount();

    const stopped = render(
      <EdgeDrawer
        open
        onClose={() => undefined}
        edge={edge("cross-stage", { fromStage: 8, toStage: 9 })}
        graphKind="job"
        metrics={new Map()}
        producer={null}
        consumer={null}
      />,
    );
    expect(stopped.container.textContent).toContain("Not transferring right now");
    expect(stopped.container.textContent).toContain("No shuffle metrics reported");
    stopped.unmount();

    const rdd = render(
      <EdgeDrawer open onClose={() => undefined} edge={edge()} graphKind="stage" metrics={metrics} producer={null} consumer={null} />,
    );
    expect(rdd.container.textContent).toContain("RDD dependency");
    expect(rdd.container.textContent).toContain("no shuffle metrics apply");
    rdd.unmount();

    const noEdge = render(
      <EdgeDrawer open={false} onClose={() => undefined} edge={null} graphKind="job" metrics={metrics} producer={null} consumer={null} />,
    );
    expect(noEdge.container.querySelector("[data-testid='dag-edge-drawer']")?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("DAG minimap and accessible edge list", () => {
  it("renders scaled nodes and ignores pointer movement without a pressed button", () => {
    const pick = vi.fn();
    const started = vi.fn();
    const ended = vi.fn();
    const n = node({ node: { id: "n", label: "N", kind: "rdd" } as never, rect: { x: 20, y: 30, width: 0, height: 0 } });
    const view = render(
      <DagMinimap
        nodes={[n]}
        width={100}
        height={80}
        contentWidth={200}
        contentHeight={160}
        projection={{ scale: 0, offsetX: 2, offsetY: 3 }}
        viewRect={{ x: -20, y: -10, width: 200, height: 160 }}
        onPick={pick}
        onDragStart={started}
        onDragEnd={ended}
      />,
    );
    const svg = view.getByTestId("dag-minimap");
    Object.defineProperty(svg, "getBoundingClientRect", { configurable: true, value: () => ({ left: 5, top: 10 }) });
    Object.defineProperty(svg, "setPointerCapture", { configurable: true, value: vi.fn() });
    Object.defineProperty(svg, "releasePointerCapture", { configurable: true, value: vi.fn() });
    fireEvent.pointerMove(svg, { pointerId: 2, clientX: 50, clientY: 40, buttons: 0 });
    expect(pick).not.toHaveBeenCalled();
    fireEvent.pointerDown(svg, { pointerId: 2, clientX: 25, clientY: 30 });
    fireEvent.pointerMove(svg, { pointerId: 2, clientX: 30, clientY: 35, buttons: 1 });
    fireEvent.pointerUp(svg, { pointerId: 2 });
    expect(pick).toHaveBeenCalledTimes(2);
    expect(started).toHaveBeenCalledOnce();
    expect(ended).toHaveBeenCalledOnce();
    expect(view.container.querySelector(".burrow-dag-minimap-node")?.getAttribute("width")).toBe("1");

    const projection = { scale: 0, offsetX: 2, offsetY: 3 };
    const viewRect = { x: -20, y: -10, width: 200, height: 160 };
    const baseProps = {
      nodes: [n],
      width: 100,
      height: 80,
      contentWidth: 200,
      contentHeight: 160,
      projection,
      viewRect,
      onPick: pick,
      onDragStart: started,
      onDragEnd: ended,
    };
    const memoView = render(<DagMinimap {...baseProps} />);
    memoView.rerender(<DagMinimap {...baseProps} />);
    memoView.rerender(<DagMinimap {...baseProps} nodes={[n]} />);
    memoView.rerender(<DagMinimap {...baseProps} nodes={[]} />);
    for (const change of [
      { width: 101 },
      { height: 81 },
      { contentWidth: 201 },
      { contentHeight: 161 },
      { projection: { ...projection } },
      { viewRect: { ...viewRect, x: 1 } },
      { viewRect: { ...viewRect, y: 1 } },
      { viewRect: { ...viewRect, width: 201 } },
      { viewRect: { ...viewRect, height: 161 } },
      { onPick: vi.fn() },
      { onDragStart: vi.fn() },
      { onDragEnd: vi.fn() },
    ]) {
      memoView.rerender(<DagMinimap {...baseProps} {...change} />);
    }
    for (const visualChange of [
      { node: { ...n.node, id: "other" } },
      { tone: "idle" },
      { rect: { ...n.rect, x: 1 } },
      { rect: { ...n.rect, y: 1 } },
      { rect: { ...n.rect, width: 1 } },
      { rect: { ...n.rect, height: 1 } },
    ]) {
      memoView.rerender(<DagMinimap {...baseProps} nodes={[{ ...n, ...visualChange } as NodeVisual]} />);
    }
    memoView.rerender(<DagMinimap {...baseProps} nodes={[{ ...n }]} />);
  });

  it("labels SQL references, live shuffle metrics, missing endpoints, and activates edge menu items", () => {
    const sql = edge("sql");
    const shuffle = edge("cross-stage", { toStage: 2 });
    const fallback = edge("rdd", { id: "missing", from: "absent", to: "elsewhere" });
    const nodes = new Map([
      ["a", node({ node: { id: "a", label: "Scan", kind: "sql", ref: 10 } as never })],
      ["b", node({ node: { id: "b", label: "Filter", kind: "sql", ref: 11 } as never })],
    ]);
    const activated = vi.fn();
    render(
      <MenuRoot open>
        <MenuContent>
          <EdgeListView
            edges={[sql, { ...shuffle, flowing: true }, fallback]}
            nodes={nodes}
            onActivate={activated}
            metrics={new Map([[2, metric({ stageId: 2 })]])}
          />
        </MenuContent>
      </MenuRoot>,
    );
    const items = screen.getAllByRole("menuitem");
    expect(items[0]?.textContent).toContain("Scan #10 to Filter #11");
    expect(items[1]?.textContent).toContain("flowing now");
    expect(items[1]?.textContent).toContain("shuffle read");
    expect(items[2]?.textContent).toBe("absent to elsewhere");
    fireEvent.click(items[0]!);
    expect(activated).toHaveBeenCalledWith(sql);
  });
});
