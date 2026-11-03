import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { Activities } from "~/api/schemas";

window.__BURROW_PARITY__ = false;

vi.mock("~/ui/data-table/data-table", () => ({
  DataTable: ({ label }: { label: string }) => <div data-burrow-table={label} />,
}));

const { ActivitiesTable } = await import("./ActivitiesTable");
const { parityStore } = await import("~/state/parity");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  parityStore.setState({ enabled: false });
});

const activity = { allocations: [] } as Activities;

function table(groupBy: string, nodeId = "", fetching = false) {
  return (
    <div className="burrow-page-scroll">
      <ActivitiesTable
        activities={activity}
        fetching={fetching}
        sorting={[]}
        onSortingChange={() => undefined}
        columnVisibility={{}}
        onColumnVisibilityChange={() => undefined}
        nodeId={nodeId}
        onNodeIdChange={() => undefined}
        nodeOptions={[]}
        groupBy={groupBy}
        onGroupByChange={() => undefined}
      />
    </div>
  );
}

function setGeometry(scroller: HTMLElement, region: HTMLElement, regionRect: DOMRect) {
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: 100 },
    clientTop: { configurable: true, value: 0 },
    scrollHeight: { configurable: true, value: 1_000 },
    scrollTop: { configurable: true, writable: true, value: 50 },
    getBoundingClientRect: {
      configurable: true,
      value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 100, width: 400, height: 100, toJSON: () => ({}) }),
    },
    scrollTo: { configurable: true, value: vi.fn() },
  });
  Object.defineProperty(region, "getBoundingClientRect", { configurable: true, value: () => regionRect });
}

describe("ActivitiesTable reveal lifecycle", () => {
  it("skips the reveal when detached from the page scroller", () => {
    const view = render(
      <ActivitiesTable
        activities={activity}
        sorting={[]}
        onSortingChange={() => undefined}
        columnVisibility={{}}
        onColumnVisibilityChange={() => undefined}
        nodeId=""
        onNodeIdChange={() => undefined}
        nodeOptions={[]}
        groupBy=""
        onGroupByChange={() => undefined}
      />,
    );

    view.rerender(
      <ActivitiesTable
        activities={activity}
        sorting={[]}
        onSortingChange={() => undefined}
        columnVisibility={{}}
        onColumnVisibilityChange={() => undefined}
        nodeId="node-1"
        onNodeIdChange={() => undefined}
        nodeOptions={[]}
        groupBy=""
        onGroupByChange={() => undefined}
      />,
    );
    expect(view.container.querySelector("[data-burrow-activities-region]")).toBeTruthy();
  });

  it("coalesces reveal frames, waits for fetching, and cancels a pending frame on cleanup", () => {
    const frames = new Map<number, FrameRequestCallback>();
    const canceled: number[] = [];
    let nextFrame = 1;
    vi.stubGlobal("ResizeObserver", undefined);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      canceled.push(id);
      frames.delete(id);
    });

    const mutationCallbacks: MutationCallback[] = [];
    vi.stubGlobal(
      "MutationObserver",
      class TestMutationObserver {
        constructor(callback: MutationCallback) {
          mutationCallbacks.push(callback);
        }
        observe() {}
        disconnect() {}
        takeRecords() {
          return [];
        }
      },
    );

    const view = render(table("", "", true));
    const scroller = view.container.querySelector<HTMLElement>(".burrow-page-scroll")!;
    const region = view.container.querySelector<HTMLElement>("[data-burrow-activities-region]")!;
    const regionRect = {
      x: 0,
      y: 20,
      top: 20,
      left: 0,
      right: 400,
      bottom: 70,
      width: 400,
      height: 50,
      toJSON: () => ({}),
    } as DOMRect;
    setGeometry(scroller, region, regionRect);

    fireEvent.wheel(scroller, { deltaY: 10 });
    view.rerender(table("DIAGNOSTIC", "", true));
    expect(frames.size).toBe(1);
    act(() => mutationCallbacks.at(-1)?.([], {} as MutationObserver));
    expect(canceled).toHaveLength(1);
    expect(frames.size).toBe(1);
    const [frameId, callback] = [...frames.entries()][0]!;
    frames.delete(frameId);
    act(() => callback(0));

    // A settled, fully visible panel does not clear the pending reveal while cached rows are still fetching.
    fireEvent.wheel(scroller, { deltaY: 10 });
    act(() => mutationCallbacks.at(-1)?.([], {} as MutationObserver));
    expect(frames.size).toBe(0);

    // Clear a second scheduled reveal before its frame runs to exercise the stale-frame guard.
    view.rerender(table("DIAGNOSTIC", "node-1", false));
    expect(frames.size).toBe(1);
    const [staleId, staleFrame] = [...frames.entries()][0]!;
    fireEvent.wheel(scroller, { deltaY: 10 });
    frames.delete(staleId);
    act(() => staleFrame(0));
    expect(frames.size).toBe(0);

    // A later node change schedules another frame; unmount cancels it and disconnects its observers.
    view.rerender(table("DIAGNOSTIC", "node-2", false));
    expect(frames.size).toBe(1);
    view.unmount();
    expect(canceled.length).toBeGreaterThanOrEqual(2);
  });

  it("scrolls a fitting panel into view with motion enabled", () => {
    parityStore.setState({ enabled: false });
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    vi.stubGlobal("ResizeObserver", undefined);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));

    const view = render(table("", ""));
    const scroller = view.container.querySelector<HTMLElement>(".burrow-page-scroll")!;
    const region = view.container.querySelector<HTMLElement>("[data-burrow-activities-region]")!;
    const topRect = {
      x: 0,
      y: -10,
      top: -10,
      left: 0,
      right: 400,
      bottom: 40,
      width: 400,
      height: 50,
      toJSON: () => ({}),
    } as DOMRect;
    setGeometry(scroller, region, topRect);

    view.rerender(table("DIAGNOSTIC", ""));
    const [topId, topFrame] = [...frames.entries()].at(-1)!;
    frames.delete(topId);
    act(() => topFrame(0));
    expect(scroller.scrollTo).toHaveBeenLastCalledWith({ top: 32, behavior: "smooth" });

    const bottomRect = { ...topRect, y: 80, top: 80, bottom: 130 } as DOMRect;
    setGeometry(scroller, region, bottomRect);
    view.rerender(table("DIAGNOSTIC", "node-1"));
    const [bottomId, bottomFrame] = [...frames.entries()].at(-1)!;
    frames.delete(bottomId);
    act(() => bottomFrame(0));
    expect(scroller.scrollTo).toHaveBeenLastCalledWith({ top: 88, behavior: "smooth" });
  });
});
