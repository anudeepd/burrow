/**
 * Structural guard for the timeline's SVG paint.
 *
 * The bars paint with `fill="var(--tone)"` / `stroke="var(--tone)"`, so the row's tone class has to be in scope inside
 * the chart cell — without it the paint falls back to the SVG initial value (black) in both themes, which is exactly
 * what shipped once.
 *
 * Parity mode is on (`window.__BURROW_PARITY__`) so the chart renders every row instead of a virtual window (jsdom has no
 * layout, so the virtualizer would otherwise render nothing).
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TimelineBar, TimelineRow } from "./Timeline";

window.__BURROW_PARITY__ = true;

const { buildTimelineRows, TimelineChart } = await import("./Timeline");
const { SparkExecutorSchema, SparkJobSchema, SparkStageSchema } = await import("../data/schemas");
const { parityStore } = await import("~/state/parity");

/** A job bar with the defaults filled in; `over` picks the tone and which branch of `Bar` is exercised. */
const bar = (over: Partial<TimelineBar> & { key: string }): TimelineBar => ({
  kind: "bar",
  group: "jobs",
  entity: over.key,
  label: `Job ${over.key}`,
  name: `Job ${over.key}`,
  tone: "ok",
  start: 1_000,
  end: 2_000,
  startField: "spark.job.submissionTime",
  endField: "spark.job.completionTime",
  durationField: "spark.job.durationMs",
  durationMs: 1_000,
  ...over,
});

const ROWS: TimelineRow[] = [
  { kind: "header", key: "h", group: "jobs", label: "Jobs (4)" },
  bar({ key: "succeeded", tone: "ok" }), // the plain rect
  bar({ key: "running", tone: "live", end: null, open: true }), // the zero-width tick (no end reported)
  bar({ key: "open", tone: "wait", open: true }), // the rect plus its dashed "still running" tail
  bar({ key: "skipped", tone: "idle", ghost: true, start: null, end: null }), // the dashed skipped marker
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  parityStore.setState(() => ({ enabled: true }));
});

describe("TimelineChart", () => {
  it("changes the label gutter with the viewport and removes its listener", () => {
    let matches = true;
    let onChange: (() => void) | undefined;
    const media = {
      get matches() {
        return matches;
      },
      addEventListener: vi.fn((_type: string, listener: () => void) => {
        onChange = listener;
      }),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList;
    vi.spyOn(window, "matchMedia").mockReturnValue(media);
    const { container, unmount } = render(
      <TimelineChart
        rows={[]}
        window={[1_000, 1_000]}
        tz="utc"
        onZoom={() => undefined}
        onPan={() => undefined}
        onSelectRange={() => undefined}
        onFit={() => undefined}
        label="Equal time window"
      />,
    );
    const gutter = container.querySelector(".sticky.top-0 .shrink-0") as HTMLDivElement;
    expect(gutter.style.width).toBe("256px");

    act(() => {
      matches = false;
      onChange?.();
    });
    expect(gutter.style.width).toBe("132px");
    unmount();
    expect(media.removeEventListener).toHaveBeenCalledWith("change", onChange);
  });

  it("keeps the row tone in scope for every element that paints with var(--tone)", () => {
    const { container } = render(
      <TimelineChart
        rows={ROWS}
        bounds={[0, 4_000]}
        window={[0, 4_000]}
        zoom={1}
        tz="local"
        onZoom={() => undefined}
        onPan={() => undefined}
        onSelectRange={() => undefined}
        onFit={() => undefined}
        label="Timeline"
      />,
    );

    const painted = [...container.querySelectorAll('svg [fill="var(--tone)"], svg [stroke="var(--tone)"]')];
    expect(painted.length).toBeGreaterThan(0);
    for (const el of painted) {
      expect(
        el.closest('[class*="burrow-tone-"]'),
        `${el.tagName} paints var(--tone) with no tone class in scope (renders black in both themes)`,
      ).not.toBeNull();
    }
  });

  it("supports zoom and fit controls and announces a hovered row", () => {
    const onZoom = vi.fn();
    const onFit = vi.fn();
    const { container } = render(
      <TimelineChart
        rows={[
          { kind: "header", key: "header", group: "jobs", label: "Jobs (3)" },
          bar({
            key: "active",
            name: "Job 42",
            start: 1_000,
            end: 2_000,
            open: true,
            status: { domain: "spark.job", state: "RUNNING", raw: "RUNNING", label: "RUNNING", field: "spark.job.status" },
            note: "still running",
          }),
          bar({ key: "without-start", start: null, end: 2_000 }),
          bar({ key: "outside-window", start: 5_000, end: 6_000 }),
        ]}
        window={[0, 4_000]}
        now={2_500}
        tz="utc"
        onZoom={onZoom}
        onPan={() => undefined}
        onSelectRange={() => undefined}
        onFit={onFit}
        label="Timeline"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(screen.getByRole("button", { name: "Fit" }));
    expect(onZoom).toHaveBeenNthCalledWith(1, 0.5, 2_000);
    expect(onZoom).toHaveBeenNthCalledWith(2, 2, 2_000);
    expect(onFit).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Time (UTC)");

    fireEvent.mouseOver(container.querySelector('[data-ye="active"]')!);
    expect(screen.getByRole("status").textContent).toContain("job Job 42, RUNNING");
    expect(screen.getByRole("status").textContent).toContain("duration");
    expect(container.textContent).toContain("still running");
    expect(container.querySelectorAll('svg rect[fill="var(--tone)"]')).toHaveLength(1);
    fireEvent.mouseLeave(container.querySelector('[data-ye="active"]')!);
  });

  it("uses the virtual row range outside parity mode and cancels a range drag", () => {
    parityStore.setState(() => ({ enabled: false }));
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1_000);
    const onSelectRange = vi.fn();
    const { container } = render(
      <TimelineChart
        rows={ROWS}
        window={[0, 4_000]}
        tz="local"
        onZoom={() => undefined}
        onPan={() => undefined}
        onSelectRange={onSelectRange}
        onFit={() => undefined}
        label="Virtual timeline"
      />,
    );
    const figure = container.querySelector(".select-none") as HTMLDivElement;
    const list = container.querySelector(".burrow-scroll > .relative") as HTMLDivElement;
    expect(container.querySelectorAll("[data-ye]").length).toBeGreaterThan(0);
    Object.defineProperty(list, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 1_000, bottom: 400, width: 1_000, height: 400, toJSON: () => ({}) }),
    });
    Object.defineProperty(figure, "setPointerCapture", { configurable: true, value: () => {} });
    fireEvent.pointerDown(figure, { pointerId: 12, clientX: 500 });
    fireEvent.pointerMove(figure, { pointerId: 12, clientX: 700 });
    fireEvent.pointerCancel(figure, { pointerId: 12 });
    expect(onSelectRange).not.toHaveBeenCalled();
  });
  it("zooms over the axis, pans on Shift-wheel, and selects only a meaningful drag range", () => {
    const onZoom = vi.fn();
    const onPan = vi.fn();
    const onSelectRange = vi.fn();
    const { container } = render(
      <TimelineChart
        rows={ROWS}
        bounds={[0, 4_000]}
        window={[0, 4_000]}
        zoom={1}
        tz="local"
        onZoom={onZoom}
        onPan={onPan}
        onSelectRange={onSelectRange}
        onFit={() => undefined}
        label="Timeline interactions"
      />,
    );
    const figure = container.querySelector(".select-none") as HTMLDivElement;
    const list = container.querySelector('[data-ye="succeeded"]')!.parentElement!.parentElement!;
    Object.defineProperty(list, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 1_000, bottom: 400, width: 1_000, height: 400, toJSON: () => ({}) }),
    });
    const axis = container.querySelector(".z-rail .relative")!;
    const wheel = (target: Element, values: { deltaY: number; clientX?: number; shiftKey?: boolean; ctrlKey?: boolean }) => {
      const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: values.deltaY });
      for (const [key, value] of Object.entries(values)) Object.defineProperty(event, key, { value });
      target.dispatchEvent(event);
      return event;
    };

    const axisWheel = wheel(axis, { deltaY: -100, clientX: 600 });
    expect(axisWheel.defaultPrevented).toBe(true);
    expect(onZoom).toHaveBeenLastCalledWith(1.25, expect.any(Number));
    const plainRowWheel = wheel(figure, { deltaY: 100 });
    expect(plainRowWheel.defaultPrevented).toBe(false);
    expect(onZoom).toHaveBeenCalledOnce();
    const shiftedWheel = wheel(figure, { deltaY: 100, shiftKey: true });
    expect(shiftedWheel.defaultPrevented).toBe(true);
    expect(onPan).toHaveBeenCalledWith(0.1);
    wheel(figure, { deltaY: -100, shiftKey: true });
    expect(onPan).toHaveBeenLastCalledWith(-0.1);
    wheel(figure, { deltaY: -50, ctrlKey: true, clientX: 600 });
    expect(onZoom).toHaveBeenLastCalledWith(1.25, expect.any(Number));

    Object.defineProperty(figure, "setPointerCapture", { configurable: true, value: () => {} });
    fireEvent.pointerDown(figure, { pointerId: 8, clientX: 150 });
    fireEvent.pointerMove(figure, { pointerId: 8, clientX: 500 });
    fireEvent.pointerUp(figure, { pointerId: 8 });
    expect(onSelectRange).not.toHaveBeenCalled();

    fireEvent.pointerDown(figure, { pointerId: 9, clientX: 700 });
    fireEvent.pointerMove(figure, { pointerId: 9, clientX: 300 });
    fireEvent.pointerUp(figure, { pointerId: 9 });
    expect(onSelectRange).toHaveBeenCalledOnce();
    const [start, end] = onSelectRange.mock.calls[0]!;
    expect(start).toBeLessThan(end);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeLessThanOrEqual(4_000);
  });

  it("keeps sparse row details accessible and positions tooltips for a later row", () => {
    const { container } = render(
      <TimelineChart
        rows={[
          { kind: "header", key: "header", group: "jobs", label: "Jobs (2)" },
          bar({
            key: "missing",
            name: "Job with missing timestamps",
            start: null,
            end: null,
            durationMs: null,
            status: undefined,
            note: undefined,
          }),
          bar({
            key: "later",
            name: "Later job",
            sub: "retained description",
            start: 3_000,
            end: 4_000,
            status: { raw: "CUSTOM", label: "CUSTOM", field: "spark.job.status" },
            note: "derived from retained event data",
          }),
          bar({
            key: "ghost",
            group: "stages",
            name: "Skipped stage",
            start: 2_000,
            end: 2_000,
            durationMs: null,
            ghost: true,
            status: { domain: "spark.stage", raw: "SKIPPED", label: "SKIPPED", field: "spark.stage.status" },
            note: "retained as a skipped marker",
          }),
        ]}
        bounds={[0, 4_000]}
        window={[0, 4_000]}
        tz="local"
        onZoom={() => undefined}
        onPan={() => undefined}
        onSelectRange={() => undefined}
        onFit={() => undefined}
        label="Sparse timeline"
      />,
    );
    const missing = container.querySelector('[data-ye="missing"]')!;
    const later = container.querySelector('[data-ye="later"]')!;
    fireEvent.mouseOver(later);
    expect(screen.getByRole("status").textContent).toContain("job Later job, CUSTOM, from");
    const laterTooltip = later.querySelector(".burrow-enter-pop") as HTMLDivElement;
    expect(laterTooltip.textContent).toContain("derived from retained event data");
    expect(laterTooltip.style.right).toBe("4px");
    expect(laterTooltip.className).toContain("bottom-full");
    expect(container.querySelectorAll('[data-ye="ghost"] svg g line[stroke="var(--tone)"]')).toHaveLength(1);

    const ghost = container.querySelector('[data-ye="ghost"]')!;
    fireEvent.mouseOver(ghost);
    const ghostTooltip = ghost.querySelector(".burrow-enter-pop") as HTMLDivElement;
    expect(ghostTooltip.textContent).toContain("Skipped");
    expect(ghostTooltip.textContent).toContain("retained as a skipped marker");

    fireEvent.mouseOver(missing);
    fireEvent.mouseLeave(later);
    expect(screen.getByRole("status").textContent).toContain("no start, no end");
    expect(screen.getByRole("table").textContent).toContain("—");
  });

  it("keeps zoom and drag handlers safe when the chart pane has no width", () => {
    parityStore.setState(() => ({ enabled: false }));
    const onZoom = vi.fn();
    const onSelectRange = vi.fn();
    const { container } = render(
      <TimelineChart
        rows={ROWS}
        bounds={[0, 4_000]}
        window={[0, 4_000]}
        now={-1}
        tz="utc"
        onZoom={onZoom}
        onPan={() => undefined}
        onSelectRange={onSelectRange}
        onFit={() => undefined}
        label="Narrow timeline"
      />,
    );
    const figure = container.querySelector(".select-none") as HTMLDivElement;
    const list = container.querySelector(".burrow-scroll > .relative") as HTMLDivElement;
    let width = 20;
    Object.defineProperty(list, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ x: 0, y: 0, top: 0, left: 0, right: width, bottom: 400, width, height: 400, toJSON: () => ({}) }),
    });
    const axis = container.querySelector(".z-rail .relative")!;
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 200 });
    Object.defineProperty(wheel, "ctrlKey", { value: true });
    Object.defineProperty(wheel, "clientX", { value: 10 });
    figure.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(onZoom).toHaveBeenCalledWith(0.8, 2_000);

    fireEvent.pointerMove(figure, { pointerId: 20, clientX: 10 });
    fireEvent.pointerDown(figure, { pointerId: 20, clientX: 10 });
    fireEvent.pointerUp(figure, { pointerId: 20, clientX: 30 });

    Object.defineProperty(figure, "setPointerCapture", { configurable: true, value: () => undefined });
    width = 400;
    fireEvent.pointerDown(figure, { pointerId: 21, clientX: 300 });
    width = 200;
    fireEvent.pointerMove(figure, { pointerId: 21, clientX: 350 });
    fireEvent.pointerCancel(figure, { pointerId: 21 });
    expect(onSelectRange).not.toHaveBeenCalled();
    expect(axis).toBeTruthy();
  });
});

describe("buildTimelineRows", () => {
  it("derives executor, job and stage rows from Spark timestamps and status", () => {
    const jobs = [
      SparkJobSchema.parse({
        jobId: 9,
        name: "fallback name",
        description: "<b>live query</b>",
        submissionTime: "2000",
        stageIds: [5],
        jobTags: [],
        status: "RUNNING",
      }),
      SparkJobSchema.parse({
        jobId: 3,
        name: "finished query",
        submissionTime: "1000",
        completionTime: "3000",
        stageIds: [5],
        jobTags: [],
        status: "SUCCEEDED",
      }),
      SparkJobSchema.parse({ jobId: 7, stageIds: [], jobTags: [], status: "FAILED" }),
    ];
    const stages = [
      SparkStageSchema.parse({ stageId: 5, status: "SKIPPED", rddIds: [], accumulatorUpdates: [] }),
      SparkStageSchema.parse({ stageId: 6, status: "SKIPPED", attemptId: 2, rddIds: [], accumulatorUpdates: [] }),
      SparkStageSchema.parse({
        stageId: 8,
        status: "ACTIVE",
        firstTaskLaunchedTime: "2000",
        name: "launched only",
        attemptId: 1,
        rddIds: [],
        accumulatorUpdates: [],
      }),
      SparkStageSchema.parse({
        stageId: 10,
        status: "FAILED",
        submissionTime: "5000",
        completionTime: "4000",
        rddIds: [],
        accumulatorUpdates: [],
      }),
      SparkStageSchema.parse({ stageId: 11, status: "PENDING", submissionTime: "3000", rddIds: [], accumulatorUpdates: [] }),
      SparkStageSchema.parse({ stageId: 12, status: "ACTIVE", rddIds: [], accumulatorUpdates: [] }),
      SparkStageSchema.parse({ stageId: 13, submissionTime: "6000", rddIds: [], accumulatorUpdates: [] }),
    ];
    const executors = [
      SparkExecutorSchema.parse({ id: "1", hostPort: "worker:1234", isActive: true, addTime: "1000", blacklistedInStages: [] }),
      SparkExecutorSchema.parse({ id: "2", isActive: false, addTime: "1000", removeTime: "3500", blacklistedInStages: [] }),
      SparkExecutorSchema.parse({ id: "3", isActive: null, blacklistedInStages: [] }),
    ];

    const rows = buildTimelineRows({ jobs, stages, executors, now: 4_000 });
    expect(rows.filter((row) => row.kind === "header").map((row) => row.label)).toEqual(["Executors (3)", "Jobs (3)", "Stages (7)"]);
    const byKey = new Map(rows.filter((row) => row.kind === "bar").map((row) => [row.key, row]));

    expect(byKey.get("executor:1")).toMatchObject({
      start: 1_000,
      end: 4_000,
      durationMs: 3_000,
      open: true,
      tone: "live",
      sub: "worker:1234",
    });
    expect(byKey.get("executor:2")).toMatchObject({ end: 3_500, durationMs: 2_500, tone: "idle", note: undefined });
    expect(byKey.get("executor:3")).toMatchObject({
      start: null,
      end: null,
      durationMs: null,
      tone: "wait",
      note: "Spark reported no addTime for this executor.",
    });

    expect(byKey.get("job:9")).toMatchObject({ end: 4_000, durationMs: 2_000, open: true, sub: "live query", note: undefined });
    expect(byKey.get("job:3")).toMatchObject({ end: 3_000, durationMs: 2_000, open: false, sub: "finished query" });
    expect(byKey.get("job:7")).toMatchObject({
      start: null,
      end: null,
      durationMs: null,
      note: "Spark reported no submissionTime for this job.",
    });

    expect(byKey.get("stage:5/0")).toMatchObject({ start: 1_000, end: 1_000, ghost: true, durationMs: null });
    expect(byKey.get("stage:6/2")).toMatchObject({
      start: null,
      end: null,
      ghost: true,
      note: expect.stringContaining("no job referenced it"),
    });
    expect(byKey.get("stage:8/1")).toMatchObject({
      start: 2_000,
      end: 4_000,
      open: true,
      durationMs: 2_000,
      name: "Stage 8 attempt 1",
      note: "Spark reported no submissionTime; the bar starts at firstTaskLaunchedTime.",
    });
    expect(byKey.get("stage:10/0")).toMatchObject({ durationMs: 0, note: undefined });
    expect(byKey.get("stage:11/0")).toMatchObject({
      end: null,
      durationMs: 1_000,
      note: "Spark reported no completionTime for this stage.",
    });
    expect(byKey.get("stage:12/0")).toMatchObject({ start: null, end: 4_000, durationMs: null, open: true, note: undefined });
    expect(byKey.get("stage:13/0")).toMatchObject({ status: { label: "unknown" }, start: 6_000 });
  });

  it("anchors skipped stages to the earliest valid job and leaves closed unknown executors off the axis", () => {
    const jobs = [
      SparkJobSchema.parse({ jobId: 1, submissionTime: "3000", stageIds: [4], jobTags: [] }),
      SparkJobSchema.parse({ jobId: 2, submissionTime: "invalid", stageIds: [4], jobTags: [] }),
      SparkJobSchema.parse({ jobId: 3, submissionTime: "1000", stageIds: [4], jobTags: [] }),
      SparkJobSchema.parse({ jobId: 4, submissionTime: "4000", stageIds: [4], jobTags: [] }),
    ];
    const stages = [SparkStageSchema.parse({ stageId: 4, status: "SKIPPED", rddIds: [], accumulatorUpdates: [] })];
    const executors = [
      SparkExecutorSchema.parse({ id: "removed-time-missing", isActive: false, addTime: "1000", blacklistedInStages: [] }),
    ];

    const rows = buildTimelineRows({ jobs, stages, executors, now: null });
    expect(rows.find((row) => row.kind === "bar" && row.key === "stage:4/0")).toMatchObject({ start: 1_000, end: 1_000 });
    expect(rows.find((row) => row.kind === "bar" && row.key.startsWith("executor:"))).toMatchObject({
      end: null,
      open: false,
      note: "Spark reported no removeTime for this executor, so it has no end on the axis.",
    });
  });

  it("uses the current clock for an active stage when no clock value is supplied", () => {
    vi.spyOn(Date, "now").mockReturnValue(3_000);
    const rows = buildTimelineRows({
      jobs: [],
      stages: [SparkStageSchema.parse({ stageId: 20, status: "ACTIVE", submissionTime: "1000", rddIds: [], accumulatorUpdates: [] })],
      executors: [],
      now: null,
    });
    expect(rows.find((row) => row.kind === "bar" && row.key === "stage:20/0")).toMatchObject({ durationMs: 2_000 });
  });
});
