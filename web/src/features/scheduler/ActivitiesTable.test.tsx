import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Activities } from "~/api/schemas";

window.__BURROW_PARITY__ = true;

const { act, cleanup, fireEvent, render, screen } = await import("@testing-library/react");
const { ActivitiesTable } = await import("./ActivitiesTable");
afterEach(() => cleanup());

const fixture = JSON.parse(readFileSync(resolve(process.cwd(), "../fixtures/rm/scheduler/capacity/scheduler-activities.json"), "utf8")) as {
  activities: Activities;
};

describe("ActivitiesTable", () => {
  it("renders allocation activity and updates grouping and queue filters", () => {
    const onGroupByChange = vi.fn();
    const onClearQueueFilter = vi.fn();
    const onNodeIdChange = vi.fn();
    render(
      <div className="burrow-page-scroll">
        <ActivitiesTable
          activities={fixture.activities}
          sorting={[]}
          onSortingChange={vi.fn()}
          columnVisibility={{}}
          onColumnVisibilityChange={vi.fn()}
          nodeId=""
          onNodeIdChange={onNodeIdChange}
          nodeOptions={["127.0.0.2:8041"]}
          groupBy="DIAGNOSTIC"
          onGroupByChange={onGroupByChange}
          queueFilter="root"
          onClearQueueFilter={onClearQueueFilter}
          stableViewport
        />
      </div>,
    );

    expect(screen.getByRole("table", { name: "Scheduler allocation activities" })).toBeTruthy();
    expect(screen.getByText("root")).toBeTruthy();
    expect(screen.getAllByText("SKIPPED")).toHaveLength(2);
    expect(screen.getByText("Queue does not need more resource")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Detailed" }));
    expect(onGroupByChange).toHaveBeenCalledWith("");
    fireEvent.click(screen.getByRole("button", { name: /Queue filter: root/ }));
    expect(onClearQueueFilter).toHaveBeenCalledOnce();
  });

  it("renders nested allocation levels, node ID lists, and a diagnostic-only fallback row", () => {
    const activities = {
      timestamp: 1_791_011_019_914,
      nodeId: "fallback-node:8041",
      diagnostic: "No allocation root was returned",
      allocations: [
        {
          partition: "gpu",
          finalAllocationState: "ALLOCATED",
          updatedContainerId: "container_1_0001_01_000001",
          root: {
            name: "root.analytics",
            allocationState: "ALLOCATED",
            diagnostic: "Queue accepted the request",
            nodeIds: ["node-list-id:8041"],
            count: 2,
            children: [
              {
                name: "root.analytics.worker",
                allocationState: "SKIPPED",
                diagnostic: "Node has insufficient GPU memory",
                nodeId: "node-direct-id:8041",
                count: 1,
                children: [],
              },
            ],
          },
        },
        { updatedContainerId: "container_1_0001_01_000002" },
      ],
    } as Activities;
    render(
      <div className="burrow-page-scroll">
        <ActivitiesTable
          activities={activities}
          sorting={[]}
          onSortingChange={vi.fn()}
          columnVisibility={{}}
          onColumnVisibilityChange={vi.fn()}
          nodeId=""
          onNodeIdChange={vi.fn()}
          nodeOptions={[]}
          groupBy=""
          onGroupByChange={vi.fn()}
        />
      </div>,
    );

    const table = screen.getByRole("table", { name: "Scheduler allocation activities" });
    expect(table.textContent).toContain("root.analytics");
    expect(table.textContent).toContain("root.analytics.worker");
    expect(table.textContent).toContain("node-list-id:8041");
    expect(table.textContent).toContain("node-direct-id:8041");
    expect(table.textContent).toContain("No allocation root was returned");
    expect(table.textContent).toContain("container_1_0001_01_000002");
    expect(table.textContent).toContain("gpu");
  });

  it("reveals the table after filters change and lets the user stop a pending reveal", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const onGroupByChange = vi.fn();
    const renderActivities = (groupBy: string) => (
      <div className="burrow-page-scroll">
        <ActivitiesTable
          activities={fixture.activities}
          sorting={[]}
          onSortingChange={vi.fn()}
          columnVisibility={{}}
          onColumnVisibilityChange={vi.fn()}
          nodeId=""
          onNodeIdChange={vi.fn()}
          nodeOptions={[]}
          groupBy={groupBy}
          onGroupByChange={onGroupByChange}
        />
      </div>
    );
    const view = render(renderActivities("DIAGNOSTIC"));
    const scroller = view.container.querySelector<HTMLElement>(".burrow-page-scroll")!;
    const region = view.container.querySelector<HTMLElement>("[data-burrow-activities-region]")!;
    const table = view.container.querySelector<HTMLElement>("[data-burrow-table]")!;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 1000 },
      scrollTop: { configurable: true, writable: true, value: 0 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 100, width: 400, height: 100, toJSON: () => ({}) }),
      },
      scrollTo: { configurable: true, value: vi.fn() },
    });
    Object.defineProperty(region, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ x: 0, y: 200, top: 200, left: 0, right: 400, bottom: 400, width: 400, height: 200, toJSON: () => ({}) }),
    });
    Object.defineProperty(table, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ x: 0, y: 200, top: 200, left: 0, right: 400, bottom: 400, width: 400, height: 200, toJSON: () => ({}) }),
    });

    fireEvent.click(screen.getByRole("button", { name: "Detailed" }));
    view.rerender(renderActivities(""));
    expect(frames.length).toBeGreaterThan(0);
    act(() => frames.shift()?.(0));
    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 308, behavior: "auto" });
    expect(frames.length).toBe(0);

    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 100 });
    Object.defineProperty(region, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ x: 0, y: 500, top: 500, left: 0, right: 400, bottom: 800, width: 400, height: 300, toJSON: () => ({}) }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Group by diagnostic" }));
    view.rerender(renderActivities("DIAGNOSTIC"));
    expect(frames.length).toBeGreaterThan(0);
    act(() => frames.shift()?.(0));
    fireEvent.wheel(scroller, { deltaY: 20 });
  });
});
