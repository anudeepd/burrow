/**
 * Deriving the /apps view from the one cached app list: facet counts (for the tabs, chips and filter menus) and the
 * filtered rows. Filtering is client-side on purpose (PLAN §5): one upstream request, exact tab counts, and the URL
 * stays shareable. Everything here is pure so it can be unit-tested without React.
 */
import type { App, AppAttempt, AppState } from "~/api/schemas";
import { parseStates, type AppsSearch } from "./search";

export interface FacetCount {
  value: string;
  count: number;
}

export interface Facets {
  total: number;
  byState: Record<string, number>;
  byFinal: Record<string, number>;
  active: number;
  users: FacetCount[];
  queues: FacetCount[];
  types: FacetCount[];
  tags: FacetCount[];
}

const ACTIVE_STATES = new Set<string>(["NEW", "NEW_SAVING", "SUBMITTED", "ACCEPTED", "RUNNING"]);

function toFacets(counts: Map<string, number>): FacetCount[] {
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

export function computeFacets(apps: readonly App[]): Facets {
  const byState: Record<string, number> = {};
  const byFinal: Record<string, number> = {};
  const users = new Map<string, number>();
  const queues = new Map<string, number>();
  const types = new Map<string, number>();
  const tags = new Map<string, number>();
  let active = 0;
  for (const app of apps) {
    byState[app.state] = (byState[app.state] ?? 0) + 1;
    if (app.finalStatus) byFinal[app.finalStatus] = (byFinal[app.finalStatus] ?? 0) + 1;
    if (ACTIVE_STATES.has(app.state)) active++;
    users.set(app.user, (users.get(app.user) ?? 0) + 1);
    queues.set(app.queue, (queues.get(app.queue) ?? 0) + 1);
    if (app.applicationType) types.set(app.applicationType, (types.get(app.applicationType) ?? 0) + 1);
    for (const tag of app.applicationTags.split(",")) {
      const t = tag.trim();
      if (t) tags.set(t, (tags.get(t) ?? 0) + 1);
    }
  }
  return {
    total: apps.length,
    byState,
    byFinal,
    active,
    users: toFacets(users),
    queues: toFacets(queues),
    types: toFacets(types),
    tags: toFacets(tags),
  };
}

/** Empty facets, for the loading/error states (never `undefined` in the UI). */
export const NO_FACETS: Facets = { total: 0, byState: {}, byFinal: {}, active: 0, users: [], queues: [], types: [], tags: [] };

function appTags(app: App): string[] {
  return app.applicationTags
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Apply the URL filters. `name` searches the application NAME; a value that looks like an application id (contains
 * `application_`) searches the id instead — that is how the legacy DataTables search box behaves in practice, but
 * scoped to the two columns people actually paste.
 *
 * The time ranges mirror `RMWebServices`/`ApplicationsRequestBuilder` exactly: `startedTimeBegin/End` default to
 * `0..Long.MAX_VALUE` and are always applied, while the finished range is only applied when a bound was actually set —
 * which is why `finishedAfter` excludes not-yet-finished apps (`finishedTime === 0`) but `finishedBefore` alone keeps them.
 */
export function filterApps(apps: readonly App[], search: AppsSearch): App[] {
  const states = parseStates(search.states);
  const stateSet = new Set<string>(states);
  const needle = search.name?.toLowerCase();
  const byId = needle?.includes("application_") ?? false;
  const tag = search.tag?.toLowerCase();
  const startedBegin = search.startedAfter ?? 0;
  const startedEnd = search.startedBefore ?? Number.MAX_SAFE_INTEGER;
  const finishedBegin = search.finishedAfter ?? 0;
  const finishedEnd = search.finishedBefore ?? Number.MAX_SAFE_INTEGER;
  const hasFinishedRange = finishedBegin > 0 || finishedEnd !== Number.MAX_SAFE_INTEGER;
  return apps.filter((app) => {
    if (stateSet.size && !stateSet.has(app.state as AppState)) return false;
    if (search.final && app.finalStatus !== search.final) return false;
    if (search.user && app.user !== search.user) return false;
    if (search.queue && app.queue !== search.queue) return false;
    if (search.type && app.applicationType !== search.type) return false;
    if (tag && !appTags(app).includes(tag)) return false;
    if (app.startedTime < startedBegin || app.startedTime > startedEnd) return false;
    if (hasFinishedRange && (app.finishedTime < finishedBegin || app.finishedTime > finishedEnd)) return false;
    if (needle) {
      const hit = byId ? app.id.toLowerCase().includes(needle) : app.name.toLowerCase().includes(needle);
      if (!hit) return false;
    }
    return true;
  });
}

/**
 * Legacy "Blacklisted Nodes" cell (`RMAppsBlock.java:121-133`): the size of the CURRENT attempt's blacklisted-node list,
 * `N/A` when the app has no attempt yet. REST carries the list per attempt (`blacklistedNodes`, comma-joined) on
 * `/apps/{id}/appattempts`; the current attempt is the one with the highest attempt number. `undefined` = no attempt.
 */
export function blacklistedNodesCount(attempts: readonly Pick<AppAttempt, "id" | "blacklistedNodes">[]): number | undefined {
  let current: Pick<AppAttempt, "id" | "blacklistedNodes"> | undefined;
  for (const a of attempts) if (current === undefined || a.id > current.id) current = a;
  if (current === undefined) return undefined;
  return (current.blacklistedNodes ?? "").split(",").filter((n) => n.trim() !== "" && n.trim() !== "-").length;
}
