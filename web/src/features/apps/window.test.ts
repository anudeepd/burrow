import { describe, expect, it } from "vitest";
import {
  expandWindow,
  INITIAL_WINDOW_ROWS,
  initialWindow,
  nextWindow,
  PREFETCH_WINDOW_ROWS,
  SLIDING_WINDOW_ROWS,
  viewKey,
  WINDOW_MARGIN,
  WINDOW_PAGE_ALIGN,
  windowFilters,
} from "./window";

describe("application window arithmetic", () => {
  it("starts at the top with the first-paint size", () => {
    expect(initialWindow()).toEqual({ offset: 0, limit: INITIAL_WINDOW_ROWS });
  });

  it("widens only the first page, and only once", () => {
    expect(expandWindow({ offset: 0, limit: INITIAL_WINDOW_ROWS }, 10_000)).toEqual({
      offset: 0,
      limit: PREFETCH_WINDOW_ROWS,
    });
    // already at the prefetch size
    expect(expandWindow({ offset: 0, limit: PREFETCH_WINDOW_ROWS }, 10_000)).toEqual({
      offset: 0,
      limit: PREFETCH_WINDOW_ROWS,
    });
    // a scrolled window never jumps back to zero
    expect(expandWindow({ offset: 500, limit: INITIAL_WINDOW_ROWS }, 10_000)).toEqual({
      offset: 500,
      limit: INITIAL_WINDOW_ROWS,
    });
    // never ask for more rows than the server says exist
    expect(expandWindow({ offset: 0, limit: 100 }, 200)).toEqual({ offset: 0, limit: 200 });
    // and do nothing while the first page already covers a complete result
    expect(expandWindow({ offset: 0, limit: 100 }, 80)).toEqual({ offset: 0, limit: 100 });
    // a partial preview must widen even when it only saw a couple of rows
    expect(expandWindow({ offset: 0, limit: 100 }, 2, false)).toEqual({
      offset: 0,
      limit: PREFETCH_WINDOW_ROWS,
    });
    expect(expandWindow({ offset: 0, limit: PREFETCH_WINDOW_ROWS }, 2, false)).toEqual({
      offset: 0,
      limit: PREFETCH_WINDOW_ROWS,
    });
  });

  it("keeps the window when the visible range stays inside the margin", () => {
    const state = { offset: 0, limit: 100 };
    expect(nextWindow(state, { start: 10, end: 20 }, 1_000)).toBe(state);
  });

  it("slides down and up on aligned boundaries with overlap", () => {
    const down = nextWindow({ offset: 0, limit: SLIDING_WINDOW_ROWS }, { start: 900, end: 950 }, 10_000);
    expect(down).toEqual({ offset: 800, limit: SLIDING_WINDOW_ROWS });
    expect(down.offset % WINDOW_PAGE_ALIGN).toBe(0);
    expect(down.offset).toBeLessThanOrEqual(900 - WINDOW_MARGIN);
    expect(down.offset + down.limit - WINDOW_MARGIN).toBeGreaterThan(950);

    const up = nextWindow(down, { start: 120, end: 160 }, 10_000);
    expect(up).toEqual({ offset: 0, limit: SLIDING_WINDOW_ROWS });
  });

  it("clamps to a small or empty result instead of inventing rows", () => {
    expect(nextWindow({ offset: 0, limit: 100 }, { start: 0, end: 2 }, 0)).toEqual({ offset: 0, limit: 100 });
    expect(nextWindow({ offset: 500, limit: 100 }, { start: 150, end: 160 }, 30)).toEqual({
      offset: 0,
      limit: 30,
    });
    expect(nextWindow({ offset: 1, limit: 1 }, { start: 9, end: 4 }, 1)).toEqual({
      offset: 0,
      limit: 1,
    });
  });

  it("returns the same object when a recomputation lands on the current window", () => {
    const state = { offset: 800, limit: PREFETCH_WINDOW_ROWS };
    expect(nextWindow(state, { start: 860, end: 900 }, 10_000)).toBe(state);
  });

  it("returns the same object when re-alignment produces the same boundary", () => {
    const state = { offset: 0, limit: 100 };
    // The visible end plus the margin is exactly the window edge: it is "outside" coverage, but the
    // recomputed aligned window is identical, so no request should be issued.
    expect(nextWindow(state, { start: 0, end: 40 }, 100)).toBe(state);
  });
});

describe("application view identity", () => {
  it("changes for every filter and for the sort", () => {
    const base = viewKey({});
    for (const patch of [
      { states: "RUNNING" },
      { final: "FAILED" },
      { user: "alice" },
      { queue: "root.default" },
      { type: "SPARK" },
      { tag: "etl" },
      { name: "job" },
      { startedAfter: 1 },
      { startedBefore: 2 },
      { finishedAfter: 3 },
      { finishedBefore: 4 },
      { sort: "name" },
    ]) {
      expect(viewKey(patch)).not.toBe(base);
    }
    expect(viewKey({ sort: "-starttime" })).toBe(base);
  });

  it("maps the URL filters to the backend vocabulary and drops empty values", () => {
    expect(windowFilters({})).toEqual({});
    expect(
      windowFilters({
        states: "RUNNING",
        final: "SUCCEEDED",
        user: "alice",
        queue: "root.default",
        type: "SPARK",
        tag: "etl",
        name: "job",
        startedAfter: 1,
        startedBefore: 2,
        finishedAfter: 3,
        finishedBefore: 4,
      }),
    ).toEqual({
      states: "RUNNING",
      final: "SUCCEEDED",
      user: "alice",
      queue: "root.default",
      type: "SPARK",
      tag: "etl",
      name: "job",
      startedAfter: 1,
      startedBefore: 2,
      finishedAfter: 3,
      finishedBefore: 4,
    });
  });
});
