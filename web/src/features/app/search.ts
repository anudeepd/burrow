/**
 * URL state codecs for the app-detail tables. The URL is the state (PLAN §5): sorting and visible columns survive a
 * reload, a shared link and a parity crawl. Encodings are deliberately tiny and human-readable:
 *
 *   ?sort=startedTime:desc,appAttemptId:asc      (":asc" default when omitted)
 *   ?cols=all | none | appAttemptId,startTime    (absent -> the column defaults)
 */
import type { ColumnVisibilityState, SortingState } from "@tanstack/react-table";
import { z } from "zod";

export function sortingFromParam(value: string | undefined): SortingState {
  if (!value) return [];
  const out: SortingState = [];
  for (const part of value.split(",")) {
    const [id, dir] = part.split(":");
    if (!id) continue;
    out.push({ id, desc: dir === "desc" });
  }
  return out;
}

export function sortingToParam(sorting: SortingState): string | undefined {
  if (sorting.length === 0) return undefined;
  return sorting.map((s) => `${s.id}:${s.desc ? "desc" : "asc"}`).join(",");
}

export function visibilityFromParam(value: string | undefined, defaults: ColumnVisibilityState): ColumnVisibilityState {
  if (value == null) return defaults;
  const ids = Object.keys(defaults);
  if (value === "all") return Object.fromEntries(ids.map((id) => [id, true]));
  if (value === "none") return Object.fromEntries(ids.map((id) => [id, false]));
  const visible = new Set(value.split(",").filter(Boolean));
  return Object.fromEntries(ids.map((id) => [id, visible.has(id)]));
}

export function visibilityToParam(visibility: ColumnVisibilityState, defaults: ColumnVisibilityState): string | undefined {
  const ids = Object.keys(defaults);
  const isVisible = (id: string) => visibility[id] ?? defaults[id] ?? true;
  if (ids.every((id) => !isVisible(id))) return "none";
  if (ids.every(isVisible)) return ids.every((id) => defaults[id] ?? true) ? undefined : "all";
  const shown = ids.filter(isVisible).sort();
  const defaultShown = ids.filter((id) => defaults[id] ?? true).sort();
  if (shown.join(",") === defaultShown.join(",")) return undefined;
  return shown.join(",");
}

/** Search schema for the attempts tab (the table is the page's only stateful surface). */
export const attemptsSearchSchema = z.object({
  sort: z.string().optional(),
  cols: z.string().optional(),
});

/** Search schema for the container page: the attempt id is normally derived from the container id, override with `?attempt=`. */
export const containerSearchSchema = z.object({
  attempt: z.string().optional(),
});

/**
 * Validate the known keys with the schema while **preserving every other query param** — `?parity=1` (docs/contracts/parity-dom.md)
 * and any future sibling's params must survive a client-side navigation, so a plain `schema.parse()` (which strips
 * unknown keys in zod) would silently drop them.
 */
export function parseSearch<S extends z.ZodType>(schema: S, search: Record<string, unknown>): z.output<S> & Record<string, unknown> {
  return { ...search, ...(schema.parse(search) as Record<string, unknown>) } as z.output<S> & Record<string, unknown>;
}
