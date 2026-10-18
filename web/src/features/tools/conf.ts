/**
 * Pure helpers for the daemon configuration page (`/tools/conf`).
 *
 * `/conf` is the daemon's *effective* configuration: every property the RM (or NM) actually loaded, the file it came from
 * (`resource`) and whether it was declared `<final>`. Hadoop exposes **no defaults endpoint**, so Burrow cannot diff
 * "what the file says" against "what the default would have been". "Overridden" therefore means exactly what the dump
 * states and nothing more:
 *
 *   overridden  ⇔  resource is a `*-site.xml` file, or `programmatically`
 *   default     ⇔  resource is one of Hadoop's `*-default.xml` files
 *   unknown     ⇔  no resource at all, or one Hadoop did not name (`Unknown`)
 *
 * A `final` value is different from an overridden one: it is locked by a `<final>` tag in the site file and cannot be
 * overridden again from anywhere else. Both are surfaced separately, and the page states this definition in the UI.
 */
import type { ConfProperty } from "~/api/schemas";

/** Hadoop prints this instead of the value of a sensitive key (`hadoop.security.sensitive-config-keys`). */
export const REDACTED = "<redacted>";
/** `resource` is absent (or literally "Unknown") when the daemon could not attribute the property to a file. */
export const UNKNOWN_RESOURCE = "Unknown";

export type ResourceKind = "site" | "programmatic" | "default" | "unknown";

/** The resource name as shown to the user; never empty (the upstream may omit `resource` entirely). */
export function resourceName(p: Pick<ConfProperty, "resource">): string {
  const r = p.resource?.trim();
  return r ? r : UNKNOWN_RESOURCE;
}

export function resourceKind(resource: string | null | undefined): ResourceKind {
  const r = (resource ?? "").trim().toLowerCase();
  if (!r || r === "unknown") return "unknown";
  if (r === "programmatically") return "programmatic";
  if (r.endsWith("-site.xml")) return "site";
  if (r.endsWith(".xml")) return "default";
  return "unknown";
}

/** True when the value comes from a site file or was set programmatically — i.e. not a Hadoop default. */
export function isOverridden(p: Pick<ConfProperty, "resource">): boolean {
  const kind = resourceKind(p.resource);
  return kind === "site" || kind === "programmatic";
}

/** A redacted value carries no information; the page styles it instead of pretending it is a value. */
export function isRedacted(p: Pick<ConfProperty, "value">): boolean {
  return (p.value ?? "").includes(REDACTED);
}

/** Multi-line values (e.g. `fs.s3a.aws.credentials.provider`) collapse to one line in the table. */
export function lineCount(value: string | null | undefined): number {
  return value ? value.split("\n").length : 0;
}

export interface ConfFilter {
  /** substring of the key OR the value, case-insensitive */
  q?: string;
  overridden?: boolean;
  final?: boolean;
  /** exact resource name (as produced by {@link resourceFacets}); empty/absent = every resource */
  resource?: string;
}

export function confMatches(p: ConfProperty, f: ConfFilter): boolean {
  if (f.overridden && !isOverridden(p)) return false;
  if (f.final && !p.isFinal) return false;
  if (f.resource && f.resource !== resourceName(p)) return false;
  const q = f.q?.trim().toLowerCase();
  if (!q) return true;
  return p.key.toLowerCase().includes(q) || (p.value ?? "").toLowerCase().includes(q);
}

export interface ResourceFacet {
  value: string;
  count: number;
  kind: ResourceKind;
}

/** Distinct resources with their property counts, most-populated first (`Unknown` is a real facet, not a dropped row). */
export function resourceFacets(props: readonly ConfProperty[]): ResourceFacet[] {
  const counts = new Map<string, number>();
  for (const p of props) {
    const name = resourceName(p);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count, kind: resourceKind(value) }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

export interface ConfSummary {
  total: number;
  overridden: number;
  final: number;
  redacted: number;
  /** number of distinct resources the dump attributes properties to */
  sources: number;
}

export function summarizeConf(props: readonly ConfProperty[]): ConfSummary {
  let overridden = 0;
  let final = 0;
  let redacted = 0;
  const sources = new Set<string>();
  for (const p of props) {
    if (isOverridden(p)) overridden++;
    if (p.isFinal) final++;
    if (isRedacted(p)) redacted++;
    sources.add(resourceName(p));
  }
  return { total: props.length, overridden, final, redacted, sources: sources.size };
}

/** Cheap row fingerprint (the config is a static dump, but a refresh must still repaint changed values). */
export function confRowVersion(p: ConfProperty): string {
  return `${p.isFinal}:${p.value ?? ""}`;
}

export interface UsedIn {
  /** Burrow route that renders this key's effect */
  to: string;
  label: string;
  /** one-line reason, shown in the chip tooltip */
  why: string;
}

/**
 * Curated map from REAL keys in the captured RM configuration (`fixtures/rm/tools/conf.json`, re-checked against the live
 * RM) to the Burrow view that shows them. Deliberately short: a chip that lies is worse than no chip.
 */
const RULES: { test: (key: string) => boolean; used: UsedIn }[] = [
  {
    test: (k) => k.startsWith("yarn.scheduler."),
    used: { to: "/scheduler", label: "Scheduler", why: "queue capacities, allocation limits and application counts" },
  },
  {
    test: (k) => k === "yarn.resourcemanager.scheduler.class",
    used: { to: "/scheduler", label: "Scheduler", why: "the queue tree the Scheduler view renders is built by this class" },
  },
  {
    test: (k) => k.startsWith("yarn.nodemanager."),
    used: { to: "/nodes", label: "Nodes", why: "node memory/vCore totals, local and log directories, shuffle settings" },
  },
  {
    test: (k) => k === "yarn.log-aggregation-enable" || k === "yarn.log.server.url",
    used: { to: "/apps", label: "Apps", why: "aggregated container-log links on the Apps view" },
  },
];

/**
 * Keys with no Burrow view at all. Kept explicit (and documented in the page) so "no chip" never looks like an
 * oversight: these are the addresses Burrow itself uses, or endpoints no view renders.
 */
export const NO_VIEW: Record<string, string> = {
  "yarn.resourcemanager.webapp.address": "the RM web UI address — shown in the connection popover, no separate view",
  "yarn.resourcemanager.address": "the RM RPC address — no Burrow view renders it",
  "yarn.resourcemanager.admin.address": "the RM admin RPC address — no Burrow view renders it",
  "yarn.resourcemanager.hostname": "the RM host name — shown as the upstream in the connection popover",
};

/** The chip for a key, or null when no view renders it (see {@link NO_VIEW} for the documented exceptions). */
export function usedIn(key: string): UsedIn | null {
  if (key in NO_VIEW) return null;
  for (const rule of RULES) if (rule.test(key)) return rule.used;
  return null;
}
