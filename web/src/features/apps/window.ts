/**
 * Pure window arithmetic for the server-paged applications table.
 *
 * The backend owns the complete app list and can answer any `offset`/`limit` slice in memory. The browser only
 * needs to keep the contiguous slice around the viewport: start small for the first paint, widen once rows are
 * on screen, then slide the window forward/backward as the user scrolls. Every decision here is pure so it can
 * be tested without React or a virtualizer.
 */
import type { Query } from "~/api/client";
import { DEFAULT_SORT, type AppsSearch } from "./search";

/** First request: enough to fill any viewport while the RM answers a bounded `limit` query. */
export const INITIAL_WINDOW_ROWS = 100;
/** After first paint, widen in the background to cover a few pages of scrolling. */
export const PREFETCH_WINDOW_ROWS = 500;
/** Window size once scrolling starts. */
export const SLIDING_WINDOW_ROWS = 500;
/** Offsets are aligned to this boundary so small scroll jitters do not cause request churn. */
export const WINDOW_PAGE_ALIGN = 100;
/** Keep this many rows of overlap on each side of the viewport. */
export const WINDOW_MARGIN = 60;

export interface AppWindowState {
  offset: number;
  limit: number;
}

export interface VisibleRange {
  start: number;
  end: number;
}

export function initialWindow(): AppWindowState {
  return { offset: 0, limit: INITIAL_WINDOW_ROWS };
}

/** Widen the first page after it has painted; never moves the offset. */
export function expandWindow(state: AppWindowState, rowCount: number, ready = true): AppWindowState {
  if (state.offset !== 0 || state.limit >= PREFETCH_WINDOW_ROWS) return state;
  // A partial preview reports the number of rows it could see, not the number that exist. Widen anyway so
  // the background request can reveal the next pages as soon as the full index is ready.
  if (ready && rowCount <= state.limit) return state;
  return { offset: 0, limit: ready ? Math.min(Math.max(state.limit, PREFETCH_WINDOW_ROWS), rowCount) : PREFETCH_WINDOW_ROWS };
}

/**
 * Move the window only when `visible` leaves the current slice (plus `WINDOW_MARGIN`). The returned window is
 * aligned to `WINDOW_PAGE_ALIGN` and always covers the visible range, so a scroll of one row cannot produce a
 * request; a long drag produces one aligned request around the new position.
 */
export function nextWindow(state: AppWindowState, visible: VisibleRange, rowCount: number): AppWindowState {
  if (rowCount <= 0) return state;
  const start = Math.max(0, Math.min(visible.start, rowCount - 1));
  const end = Math.max(start, Math.min(visible.end, rowCount - 1));
  const covers = Math.max(0, start - WINDOW_MARGIN) >= state.offset && end + WINDOW_MARGIN < state.offset + state.limit;
  if (covers) return state;

  const offset = Math.floor(Math.max(0, start - WINDOW_MARGIN) / WINDOW_PAGE_ALIGN) * WINDOW_PAGE_ALIGN;
  const needed = end - offset + 1 + WINDOW_MARGIN;
  const limit = Math.max(1, Math.min(Math.max(SLIDING_WINDOW_ROWS, needed), Math.max(1, rowCount)));
  if (offset === state.offset && limit === state.limit) return state;
  return { offset, limit };
}

/**
 * Identity of the server-side view. Changing any filter or the sort resets the window to offset 0 and scrolls
 * the table to the top; the data identity itself does not.
 */
export function viewKey(search: AppsSearch): string {
  return JSON.stringify([
    search.states ?? "",
    search.final ?? "",
    search.user ?? "",
    search.queue ?? "",
    search.type ?? "",
    search.tag ?? "",
    search.name ?? "",
    search.startedAfter ?? "",
    search.startedBefore ?? "",
    search.finishedAfter ?? "",
    search.finishedBefore ?? "",
    search.sort ?? DEFAULT_SORT,
  ]);
}

/** Filters in the UI vocabulary; the backend translates them to RM query names for the fast preview. */
export function windowFilters(search: AppsSearch): Query {
  const filters: Query = {};
  if (search.states) filters.states = search.states;
  if (search.final) filters.final = search.final;
  if (search.user) filters.user = search.user;
  if (search.queue) filters.queue = search.queue;
  if (search.type) filters.type = search.type;
  if (search.tag) filters.tag = search.tag;
  if (search.name) filters.name = search.name;
  if (search.startedAfter !== undefined) filters.startedAfter = search.startedAfter;
  if (search.startedBefore !== undefined) filters.startedBefore = search.startedBefore;
  if (search.finishedAfter !== undefined) filters.finishedAfter = search.finishedAfter;
  if (search.finishedBefore !== undefined) filters.finishedBefore = search.finishedBefore;
  return filters;
}
