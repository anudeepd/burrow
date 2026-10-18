/**
 * URL state helpers for the scheduler routes. Everything the user can change lives in the search params (PLAN §5:
 * "URL is state"), in a readable form:
 *
 *   sort=<col>:<asc|desc>[,<col>:<dir>]   multi-sort, one param per table (e.g. `usersSort`, `appsSort`)
 *   hide=<col>[,<col>]                    hidden columns for that table (absent = the table's default set)
 *   openQueues=<queuePath>[,…]            expanded tree nodes (absent = every queue expanded, matching a freeness overview)
 *
 * Like every other search schema in the app, the enums `catch` a hand-typed value and fall back to "absent" instead of
 * failing the route: `/scheduler/root.etl.transform?tab=applications` should show the queue, not a zod error page.
 */
import type { ColumnVisibilityState, SortingState } from "@tanstack/react-table";
import { z } from "zod";

/** `/scheduler` search params. */
export const schedulerSearchSchema = z.object({
  /** expanded tree nodes; absent = every queue expanded (a freeness overview wants the whole tree open) */
  openQueues: z.string().optional(),
  sort: z.enum(["name", "used", "free", "apps"]).optional().catch(undefined),
  /** selected node-label partition ("" = default partition) */
  partition: z.string().optional(),
  basis: z.enum(["used", "capacity"]).optional().catch(undefined),
  tab: z.enum(["queues", "activities", "health", "conf"]).optional().catch(undefined),
  usersSort: z.string().optional(),
  usersHide: z.string().optional(),
  /** activities: NodeManager id (host:port) — empty = the RM's latest activity */
  nodeId: z.string().optional(),
  groupBy: z.enum(["DIAGNOSTIC"]).optional().catch(undefined),
  queueHide: z.string().optional(),
  actSort: z.string().optional(),
  actHide: z.string().optional(),
  confSort: z.string().optional(),
  confHide: z.string().optional(),
});
export type SchedulerSearch = z.infer<typeof schedulerSearchSchema>;

/** `/scheduler/$queue` search params. */
export const queueSearchSchema = z.object({
  tab: z.enum(["users", "apps", "partitions", "activities", "conf"]).optional().catch(undefined),
  usersSort: z.string().optional(),
  usersHide: z.string().optional(),
  appsSort: z.string().optional(),
  appsHide: z.string().optional(),
  partSort: z.string().optional(),
  partHide: z.string().optional(),
  actSort: z.string().optional(),
  actHide: z.string().optional(),
  confSort: z.string().optional(),
  confHide: z.string().optional(),
  confAll: z.coerce.boolean().optional(),
  nodeId: z.string().optional(),
  groupBy: z.enum(["DIAGNOSTIC"]).optional().catch(undefined),
});
export type QueueSearch = z.infer<typeof queueSearchSchema>;

export function parseSorting(raw: string | undefined): SortingState {
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [id, dir] = part.split(":");
      return { id: id ?? "", desc: dir === "desc" };
    })
    .filter((s) => s.id.length > 0);
}

export function serializeSorting(state: SortingState): string | undefined {
  if (!state.length) return undefined;
  return state.map((s) => `${s.id}:${s.desc ? "desc" : "asc"}`).join(",");
}

/** `hide=a,b` → `{a:false,b:false}`; absent → the table's default visibility. */
export function visibilityFromHide(hide: string | undefined, defaults: ColumnVisibilityState): ColumnVisibilityState {
  if (hide === undefined) return defaults;
  const hidden = hide.split(",").filter(Boolean);
  return Object.fromEntries(hidden.map((id) => [id, false]));
}

export function hideFromVisibility(visibility: ColumnVisibilityState): string | undefined {
  const hidden = Object.entries(visibility)
    .filter(([, visible]) => !visible)
    .map(([id]) => id);
  return hidden.length ? hidden.join(",") : "";
}

export function parseOpenQueues(raw: string | undefined): string[] | null {
  if (raw === undefined) return null; // null = all expanded
  return raw.split(",").filter(Boolean);
}

export function serializeOpenQueues(open: string[]): string {
  return open.join(",");
}
