/**
 * `/apps` URL state (docs/contracts/parity-dom.md: "URL is state"). One zod schema is the single decoder for the search
 * params; every writer goes through `withPatch`, so an unknown/broken value can never survive a round trip.
 *
 * Param names follow the RM REST vocabulary where one exists (`states`, `user`, `queue`, `applicationTypes`, time
 * ranges) so a URL can be pasted into `/ws/v1/cluster/apps` unchanged. `states` is a comma-joined subset of the eight
 * `YarnApplicationState`s; ABSENT means "no state filter" (the RM REST rejects `ALL`, so we never emit it — it is
 * tolerated on input and dropped).
 */
import { z } from "zod";
import { FINAL_STATUSES } from "~/api/schemas";
import { APP_STATE_ORDER, titleCase } from "~/design/status";
import type { AppState } from "~/api/schemas";

const optionalString = z.string().trim().min(1).optional().catch(undefined);
const optionalEpoch = z.coerce.number().int().min(0).optional().catch(undefined);

export const appsSearchSchema = z.object({
  /** comma-joined YarnApplicationState names; absent = all */
  states: optionalString,
  /** FinalApplicationStatus facet */
  final: optionalString,
  user: optionalString,
  queue: optionalString,
  type: optionalString,
  tag: optionalString,
  /** debounced name search */
  name: optionalString,
  startedAfter: optionalEpoch,
  startedBefore: optionalEpoch,
  finishedAfter: optionalEpoch,
  finishedBefore: optionalEpoch,
  /** `<columnId>` ascending, `-<columnId>` descending; default `-id` */
  sort: optionalString,
  /** comma-joined hidden column ids or `all` (absent = compact default; `all` reveals every column) */
  cols: optionalString,
});
export type AppsSearch = z.infer<typeof appsSearchSchema>;

export const DEFAULT_SORT = "-id";
/** The legacy default the table shows when the URL carries no `sort` — and what "clear sort" returns to. */
export const DEFAULT_SORTING: { id: string; desc: boolean }[] = [{ id: "id", desc: true }];

/** Category tabs: legacy `YarnApplicationState` order, plus dashboard roll-ups and All. */
export type AppTabId = "all" | "pending" | "active" | "completed" | AppState;
export const APP_TABS: { id: AppTabId; label: string; states: AppState[] | null }[] = [
  { id: "all", label: "All", states: null },
  { id: "pending", label: "Pending", states: ["NEW", "NEW_SAVING", "SUBMITTED", "ACCEPTED"] },
  { id: "active", label: "Active", states: ["NEW", "NEW_SAVING", "SUBMITTED", "ACCEPTED", "RUNNING"] },
  { id: "completed", label: "Completed", states: ["FINISHED", "FAILED", "KILLED"] },
  ...APP_STATE_ORDER.map((state) => ({ id: state as AppTabId, label: titleCase(state), states: [state] })),
];

/** Parse the `states` param: unknown names are dropped, `ALL` means "no filter". */
export function parseStates(value: string | undefined): AppState[] {
  if (!value) return [];
  const known = new Set<string>(APP_STATE_ORDER);
  const out: AppState[] = [];
  for (const raw of value.split(",")) {
    const name = raw.trim().toUpperCase();
    if (name === "ALL" || name === "") continue;
    if (known.has(name) && !out.includes(name as AppState)) out.push(name as AppState);
  }
  return out;
}

/** Which tab the current `states` param corresponds to (unknown combinations fall back to "all"). */
export function tabOf(states: string | undefined): AppTabId {
  const list = parseStates(states);
  if (list.length === 0) return "all";
  const tab = APP_TABS.find((t) => t.states?.length === list.length && t.states.every((s) => list.includes(s)));
  return tab?.id ?? "all";
}

/** Merge a patch into the current search, dropping empty values so the URL stays minimal. */
export function withPatch(search: AppsSearch, patch: Partial<AppsSearch>): AppsSearch {
  const next: AppsSearch = { ...search, ...patch };
  for (const key of Object.keys(next) as (keyof AppsSearch)[]) {
    const value = next[key];
    if (value === undefined || value === "" || value === null) delete next[key];
  }
  return next;
}

/** Active filter count, for the "n filters" readout and the Clear button. */
export function filterCount(search: AppsSearch): number {
  const keys: (keyof AppsSearch)[] = [
    "states",
    "final",
    "user",
    "queue",
    "type",
    "tag",
    "name",
    "startedAfter",
    "startedBefore",
    "finishedAfter",
    "finishedBefore",
  ];
  return keys.filter((k) => search[k] !== undefined).length;
}

export const FINAL_STATUS_OPTIONS = FINAL_STATUSES;

/** Human-facing name for the final-status facet; preserve the RM value in the URL. */
export function finalStatusLabel(status: string): string {
  return status === "UNDEFINED" ? "Not set" : titleCase(status);
}

/** `sort` param <-> TanStack Table sorting state. One token per column, `-` prefix = descending: `sort=-name,user`. */
export function sortFromParam(sort: string | undefined): { id: string; desc: boolean }[] {
  const raw = sort ?? DEFAULT_SORT;
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => ({ id: part.startsWith("-") ? part.slice(1) : part, desc: part.startsWith("-") }))
    .filter((s) => s.id.length > 0);
}

export function sortToParam(sorting: { id: string; desc: boolean }[]): string | undefined {
  const parts = sorting.filter((s) => s.id).map((s) => `${s.desc ? "-" : ""}${s.id}`);
  if (parts.length === 0) return undefined;
  const value = parts.join(",");
  return value === DEFAULT_SORT ? undefined : value;
}

/** `cols` param <-> TanStack visibility. Hidden ids preserve defaults for unlisted columns; `all` explicitly reveals every column. */
export function hiddenFromParam(cols: string | undefined): Set<string> {
  if (cols === "all") return new Set();
  return new Set(
    (cols ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function visibilityOf(columnIds: readonly string[], hidden: ReadonlySet<string>): Record<string, boolean> {
  return Object.fromEntries(columnIds.map((id) => [id, !hidden.has(id)]));
}

export function colsToParam(visibility: Record<string, boolean>): string {
  const hidden = Object.entries(visibility)
    .filter(([, visible]) => !visible)
    .map(([id]) => id)
    .sort();
  return hidden.length ? hidden.join(",") : "all";
}
