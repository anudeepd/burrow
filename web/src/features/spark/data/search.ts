/**
 * URL ↔ table-state helpers for the Spark pages.
 *
 * Every list view is linkable: sorting, the visible columns, the status filter and page controls live in the URL.
 * These parsers are deliberately total (never throw, never return NaN) so a hand-typed URL degrades to defaults instead
 * of a route error. Pages spread `sparkSearch(query)` into their `validateSearch`.
 */
import type { ColumnVisibilityState, SortingState } from "@tanstack/react-table";

/** `?sort=numTasks&dir=desc` — one sort column (the URL form Spark's own UI uses for its paged tables). */
export function parseSort(search: Record<string, unknown>): SortingState {
  const id = typeof search.sort === "string" ? search.sort : null;
  if (!id) return [];
  return [{ id, desc: search.dir === "desc" }];
}

export function serializeSort(sorting: SortingState): { sort?: string; dir?: "asc" | "desc" } {
  const first = sorting[0];
  /* Removing the last sort must *clear* the params: callers merge this into the previous search (`compact` drops
     undefined), so returning `{}` would leave a stale `sort`/`dir` in the URL and pin the table to the old order. */
  if (!first) return { sort: undefined, dir: undefined };
  return { sort: String(first.id), dir: first.desc ? "desc" : "asc" };
}

/** `?cols=index,status,-error` — `-` marks an explicitly hidden column; unlisted columns follow their default. */
export function parseColumns(search: Record<string, unknown>): ColumnVisibilityState {
  const raw = typeof search.cols === "string" ? search.cols : "";
  if (!raw) return {};
  const vis: ColumnVisibilityState = {};
  for (const part of raw.split(",")) {
    const t = part.trim();
    if (!t) continue;
    if (t.startsWith("-")) vis[t.slice(1)] = false;
    else vis[t] = true;
  }
  return vis;
}

export function serializeColumns(v: ColumnVisibilityState): { cols?: string } {
  const parts: string[] = [];
  for (const [id, on] of Object.entries(v)) {
    if (on === false) parts.push(`-${id}`);
    else if (on === true) parts.push(id);
  }
  parts.sort();
  return { cols: parts.length ? parts.join(",") : undefined };
}

/** The search keys the Spark tree understands. Kept in one place so parent (attempt) and child (filters) never disagree. */
export const SPARK_SEARCH_KEYS = [
  "attempt",
  "sort",
  "dir",
  "cols",
  "q",
  "status",
  "stage",
  "taskStatus",
  "agg",
  "all",
  "page",
  "size",
  "from",
  "to",
  "zoom",
  "level",
  "rdd",
  "more",
  "expand",
] as const;

export interface SparkSearch extends Record<string, unknown> {
  attempt?: string;
  sort?: string;
  dir?: "asc" | "desc";
  cols?: string;
  q?: string;
  status?: string;
  stage?: string;
  taskStatus?: string;
  agg?: string;
  all?: string;
  page?: string;
  size?: string;
  from?: string;
  to?: string;
  zoom?: string;
  level?: string;
  expand?: string;
}

/**
 * `validateSearch` for every Spark route: copies the whitelisted keys verbatim (strings only) and keeps an index signature
 * so `navigate({ search: (prev) => ... })` stays untyped-but-valid as pages add their own params.
 */
export function sparkSearch(s: Record<string, unknown>): SparkSearch {
  const out: Record<string, unknown> = {};
  for (const k of SPARK_SEARCH_KEYS) {
    const v = s[k];
    if (typeof v === "string" && v !== "") out[k] = v;
    else if (typeof v === "number") out[k] = String(v);
  }
  return out as SparkSearch;
}

/** Drop empty/undefined values so URLs stay clean and `navigate` diffs stay stable. */
export function compact<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || v === "" || v === false) continue;
    out[k] = v;
  }
  return out as T;
}

export function intParam(v: unknown, fallback?: number): number | undefined {
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export function strParam(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

export function boolParam(v: unknown): boolean | undefined {
  if (v === "1" || v === "true" || v === true) return true;
  if (v === "0" || v === "false" || v === false) return false;
  return undefined;
}

/** Quantile set for the distribution charts — a fixed, Spark-UI-compatible ladder (also what the fixtures captured). */
export const DEFAULT_QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95] as const;

/** `?q=…` filter used by the task table's error/status filter and the environment search. */
export function matchesQuery(haystack: (string | number | null | undefined)[], q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return haystack.some((h) => h != null && String(h).toLowerCase().includes(needle));
}
