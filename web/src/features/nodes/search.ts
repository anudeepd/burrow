/**
 * URL search-param schemas for the Nodes section. Every list view is linkable: filters, sort, visible columns and the
 * selected node live in the URL (PLAN §5, "URL is state").
 */
import { z } from "zod";
import { NODE_STATE_TABS } from "./domain";

const stateIds = NODE_STATE_TABS.map((t) => t.id) as [string, ...string[]];

/**
 * Search-param codecs. IMPORTANT: TanStack parses search values with `JSON.parse`, so `?thread=3` arrives as the *number*
 * 3 and `?overridden=1` as the number 1. A `z.string()` (or a string-only enum) rejects those and `.catch` then silently
 * drops the value, which makes the router canonicalise the URL without the param (a hand-typed `?q=42` filter vanished).
 * Every codec therefore accepts the JSON-parsed type as well as the string form, and normalises to one shape.
 */
export const flag = z
  .union([z.boolean(), z.number(), z.enum(["1", "0", "true", "false"])])
  .transform((v) => v === true || v === 1 || v === "1" || v === "true");

export const optFlag = flag.optional().catch(undefined);
export const optStr = z
  .union([z.string(), z.number(), z.boolean()])
  .transform((v) => String(v))
  .optional()
  .catch(undefined);
export const optInt = z.coerce.number().int().optional().catch(undefined);

export const nodesSearchSchema = z.object({
  state: z.enum(stateIds).optional().catch(undefined),
  label: optStr,
  rack: optStr,
  q: optStr,
  view: z.enum(["table", "heatmap"]).optional().catch(undefined),
  /** `column:asc,column2:desc` */
  sort: optStr,
  /** comma-separated visible column ids (absent = defaults) */
  cols: optStr,
  /** selected node id (row highlight / heatmap cell) */
  sel: optStr,
});
export type NodesSearch = z.infer<typeof nodesSearchSchema>;

export const NODES_DEFAULTS: NodesSearch = { state: "ALL", view: "table" };

export const nodeLabelsSearchSchema = z.object({
  label: optStr,
  q: optStr,
  view: z.enum(["labels", "mapping"]).optional().catch(undefined),
  /** label whose node list is expanded */
  open: optStr,
  sort: optStr,
  hide: optStr,
  mappingSort: optStr,
  mappingHide: optStr,
});
export type NodeLabelsSearch = z.infer<typeof nodeLabelsSearchSchema>;

const SORT_RE = /^[A-Za-z0-9_.]+:(asc|desc)$/;

/** `"user:desc,name:asc"` -> `[{id:"user",desc:true}, …]`; ignores anything malformed. */
export function parseSort(raw: string | undefined): { id: string; desc: boolean }[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => SORT_RE.test(part))
    .map((part) => {
      const [id, dir] = part.split(":");
      return { id: id as string, desc: dir === "desc" };
    });
}

export function formatSort(sort: readonly { id: string; desc: boolean }[]): string | undefined {
  if (sort.length === 0) return undefined;
  return sort.map((s) => `${s.id}:${s.desc ? "desc" : "asc"}`).join(",");
}

export function parseCols(raw: string | undefined): Record<string, boolean> | undefined {
  if (!raw) return undefined;
  const out: Record<string, boolean> = {};
  for (const id of raw.split(",")) if (id.trim()) out[id.trim()] = true;
  return Object.keys(out).length ? out : undefined;
}

export function formatCols(visibility: Record<string, boolean>): string | undefined {
  const ids = Object.entries(visibility)
    .filter(([, v]) => v)
    .map(([k]) => k);
  return ids.length ? ids.join(",") : undefined;
}
