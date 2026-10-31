/**
 * Pure helpers for the JMX / Server-metrics page (`/tools/jmx`).
 *
 * The daemon answers `{"beans":[{"name","modelerType", …open attributes…}]}` (hadoop-common `JMXJsonServlet`): a flat list
 * of MBeans whose attribute set is open-ended, nested objects/arrays included. This module turns that into a browsable
 * tree (group -> bean -> attribute -> nested value), flattens the *visible* part for virtualization, searches it and
 * formats values — all without React so the behaviour is unit-testable against the real captured payload.
 *
 * Parity: each bean is an entity (`data-ye` = the MBean name) and every value carries `data-yf="jmx.<dotted path>"` with
 * `data-yv` holding the raw upstream value. JMX is open-ended, so the field-id grammar is the documented deviation
 * `data-ye={bean name}` + `data-yf={"jmx." + attrPath}` (array indices kept as `[i]` so ids stay unambiguous).
 */
import type { JmxBean } from "~/api/schemas";
import { fmtBytes, fmtDuration, fmtEpoch, type TzMode } from "~/lib/format";

// ── MBean name ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface JmxNameProperty {
  key: string;
  value: string;
}

export interface JmxObjectName {
  /** the part before the first `:` (`Hadoop`, `java.lang`, …) */
  domain: string;
  properties: JmxNameProperty[];
}

/** `Hadoop:service=ResourceManager,name=QueueMetrics,q0=root` -> `{domain:"Hadoop", properties:[…]}`. Total. */
export function parseObjectName(name: string): JmxObjectName {
  const colon = name.indexOf(":");
  const domain = colon >= 0 ? name.slice(0, colon) : name;
  const rest = colon >= 0 ? name.slice(colon + 1) : "";
  const properties: JmxNameProperty[] = [];
  for (const part of rest.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    properties.push({ key: part.slice(0, eq), value: part.slice(eq + 1) });
  }
  return { domain, properties };
}

/** Group key the tree roots use: the MBean name prefix before the first comma (`Hadoop:service=ResourceManager`). */
export function beanGroup(name: string): string {
  const comma = name.indexOf(",");
  return comma >= 0 ? name.slice(0, comma) : name;
}

/** The remainder of the MBean name after the group prefix (`name=QueueMetrics,q0=root`), for a compact row label. */
export function beanShort(name: string): string {
  const group = beanGroup(name);
  return name.slice(group.length).replace(/^,\s*/, "");
}

/** A daemon-side `?qry=` preset. `""` = every bean. */
export const JMX_PATTERNS: { value: string; label: string }[] = [
  { value: "", label: "All beans" },
  { value: "Hadoop:service=ResourceManager,*", label: "ResourceManager (*)" },
  { value: "Hadoop:service=NodeManager,*", label: "NodeManager (*)" },
  { value: "java.lang:*", label: "java.lang (*)" },
  { value: "java.nio:*", label: "java.nio (*)" },
];

/** True for the `{"result":"ERROR","message":"No MBean …"}` entry JMXJsonServlet returns for a pattern with no match. */
export function jmxErrorBean(bean: JmxBean): { message: string } | null {
  const rec = bean as Record<string, unknown>;
  if (rec.result === "ERROR") {
    const message = typeof rec.message === "string" ? rec.message : `The daemon rejected the pattern ${bean.name}`;
    return { message };
  }
  return null;
}

// ── values ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export type JmxValueKind = "null" | "boolean" | "number" | "string" | "object" | "array";

export function jmxValueKind(v: unknown): JmxValueKind {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return "number";
  if (typeof v === "string") return "string";
  if (Array.isArray(v)) return "array";
  return "object";
}

const intFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const floatFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });

/** Numbers keep their exact meaning: integers get thousands separators, doubles up to 4 fraction digits. */
export function fmtJmxNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return Number.isInteger(n) ? intFmt.format(n) : floatFmt.format(n);
}

/** Visible text of a scalar; `null`/absent renders `—` (the raw value is still stamped as `data-yn="1"`). */
export function jmxScalarText(v: unknown): string {
  switch (jmxValueKind(v)) {
    case "null":
      return "—";
    case "number":
      return fmtJmxNumber(v as number);
    case "boolean":
      return v ? "true" : "false";
    default:
      return String(v);
  }
}

/** Branch summary shown instead of the (unrendered) children: `{4 keys}`, `[150 items]`, `{}`, `[]`. */
export function jmxBranchSummary(kind: JmxValueKind, count: number): string {
  if (kind === "array") return count === 0 ? "[]" : `[${count} item${count === 1 ? "" : "s"}]`;
  return count === 0 ? "{}" : `{${count} key${count === 1 ? "" : "s"}}`;
}

/** Raw-value text used for the search index and for copy/tooltip: scalars as-is, objects as compact JSON. */
export function jmxValueText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return String(v);
  }
}

/** Full JSON of the value, for the details pane / copy button. */
export function jmxValueJson(v: unknown): string {
  if (v === undefined) return "";
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}

export interface JmxHint {
  kind: "bytes" | "epoch" | "duration";
  text: string;
}

const BYTES_RE = /Bytes|Memory|Size/;
const TIME_RE = /Time$|Millis/;

/** 1 ms is below the epoch floor YARN uses for "not set"; anything smaller reads as a duration instead. */
const EPOCH_FLOOR = 1e11;

/**
 * Human reading of a large attribute, keyed off the attribute name (the whole dotted path, so `HeapMemoryUsage.used`
 * matches on `Memory`). Never replaces the raw number — the caller renders it next to it.
 */
export function jmxNumberHint(path: string[], value: number, tz: TzMode = "local"): JmxHint | null {
  if (!Number.isFinite(value)) return null;
  const name = path.join(".");
  if (BYTES_RE.test(name)) return { kind: "bytes", text: fmtBytes(value) };
  if (TIME_RE.test(name)) {
    return value >= EPOCH_FLOOR ? { kind: "epoch", text: fmtEpoch(value, tz) } : { kind: "duration", text: fmtDuration(value) };
  }
  return null;
}

export interface JmxMemory {
  init?: number;
  committed?: number;
  max?: number;
  used?: number;
}

const MEMORY_KEYS = ["init", "committed", "max", "used"] as const;

/** A `java.lang.management.MemoryUsage`-shaped object: exactly the four numeric keys (Hadoop emits this verbatim). */
export function jmxMemoryShape(v: unknown): JmxMemory | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const rec = v as Record<string, unknown>;
  for (const key of Object.keys(rec)) if (!(MEMORY_KEYS as readonly string[]).includes(key)) return null;
  const out: JmxMemory = {};
  let present = 0;
  for (const key of MEMORY_KEYS) {
    const raw = rec[key];
    if (typeof raw === "number") {
      out[key] = raw;
      present++;
    }
  }
  return present > 0 ? out : null;
}

/** used/max, falling back to used/committed when `max` is -1 (the JVM's "no limit"), never NaN. */
export function memoryPercent(m: JmxMemory): number {
  const used = m.used;
  if (typeof used !== "number" || used < 0) return 0;
  const pct =
    typeof m.max === "number" && m.max > 0
      ? (used / m.max) * 100
      : typeof m.committed === "number" && m.committed > 0
        ? (used / m.committed) * 100
        : 0;
  return Number.isFinite(pct) ? Math.max(0, pct) : 0;
}

/** `used 1.2 GiB of 2 GiB (60%)` — the compact summary next to the bar. */
export function memorySummary(m: JmxMemory): string {
  const used = fmtBytes(m.used);
  const pct = `${memoryPercent(m).toFixed(0)}%`;
  if (typeof m.max === "number" && m.max > 0) return `used ${used} of ${fmtBytes(m.max)} (${pct})`;
  if (typeof m.committed === "number" && m.committed > 0) return `used ${used} of ${fmtBytes(m.committed)} committed (${pct})`;
  return `used ${used}`;
}

// ── tree ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type JmxNodeKind = "group" | "bean" | "object" | "array" | "value";

export interface JmxNode {
  /** stable identity: `g:<group>` | `b:<bean>` | `a:<bean>#<path>` */
  id: string;
  kind: JmxNodeKind;
  /** visible label: group prefix, MBean name, attribute key or `[i]` */
  label: string;
  /** owning MBean name — the parity entity key ("" for group roots) */
  bean: string;
  /** dotted attribute path inside the bean; `[]` for group/bean nodes, `[i]` for array elements */
  path: string[];
  value?: unknown;
  children: JmxNode[];
  parent: JmxNode | null;
  depth: number;
  /** scalar values in this subtree (a `null` counts as one — it is a value the daemon reported) */
  leaves: number;
}

export interface JmxTree {
  roots: JmxNode[];
  byId: Map<string, JmxNode>;
  groups: number;
  beans: number;
  /** root attributes across all beans */
  attributes: number;
  /** scalar values in the whole tree */
  values: number;
  nodes: number;
}

const attrId = (bean: string, path: string[]) => `a:${bean}#${path.join(".")}`;

function buildValue(bean: string, parent: JmxNode, key: string, path: string[], value: unknown): JmxNode {
  const kind = jmxValueKind(value);
  const depth = parent.depth + 1;
  if (kind === "object" || kind === "array") {
    const node: JmxNode = {
      id: attrId(bean, path),
      kind,
      label: key,
      bean,
      path,
      value,
      children: [],
      parent,
      depth,
      leaves: 0,
    };
    if (kind === "object") {
      const rec = value as Record<string, unknown>;
      for (const childKey of Object.keys(rec).sort((a, b) => a.localeCompare(b)))
        node.children.push(buildValue(bean, node, childKey, [...path, childKey], rec[childKey]));
    } else {
      const arr = value as unknown[];
      for (let i = 0; i < arr.length; i++) node.children.push(buildValue(bean, node, `[${i}]`, [...path, `[${i}]`], arr[i]));
    }
    node.leaves = node.children.reduce((a, c) => a + c.leaves, 0);
    return node;
  }
  return { id: attrId(bean, path), kind: "value", label: key, bean, path, value, children: [], parent, depth, leaves: 1 };
}

/** Build the whole tree eagerly (nodes hold references, not copies — 9k nodes for the 464 KB RM payload). */
export function buildJmxTree(beans: JmxBean[]): JmxTree {
  const roots: JmxNode[] = [];
  const byId = new Map<string, JmxNode>();
  const groups = new Map<string, JmxNode>();
  let attributes = 0;
  let values = 0;
  let nodes = 0;

  const register = (node: JmxNode) => {
    byId.set(node.id, node);
    nodes++;
  };

  const sorted = [...beans].sort((a, b) => a.name.localeCompare(b.name));
  for (const bean of sorted) {
    const groupLabel = beanGroup(bean.name);
    let group = groups.get(groupLabel);
    if (!group) {
      group = {
        id: `g:${groupLabel}`,
        kind: "group",
        label: groupLabel,
        bean: "",
        path: [],
        children: [],
        parent: null,
        depth: 0,
        leaves: 0,
      };
      groups.set(groupLabel, group);
      roots.push(group);
      register(group);
    }
    const beanNode: JmxNode = {
      id: `b:${bean.name}`,
      kind: "bean",
      label: bean.name,
      bean: bean.name,
      path: [],
      value: bean.modelerType,
      children: [],
      parent: group,
      depth: 1,
      leaves: 0,
    };
    register(beanNode);
    for (const key of Object.keys(bean).sort((a, b) => a.localeCompare(b))) {
      if (key === "name") continue; // the MBean name is the entity key, rendered as the row label / details heading
      const child = buildValue(bean.name, beanNode, key, [key], (bean as Record<string, unknown>)[key]);
      beanNode.children.push(child);
      attributes++;
    }
    const walk = (n: JmxNode) => {
      register(n);
      if (n.kind === "value") values += n.leaves;
      for (const c of n.children) walk(c);
    };
    for (const c of beanNode.children) walk(c);
    beanNode.leaves = beanNode.children.reduce((a, c) => a + c.leaves, 0);
    group.children.push(beanNode);
    group.leaves += beanNode.leaves;
  }

  return { roots, byId, groups: roots.length, beans: beans.length, attributes, values, nodes };
}

/** `jmx.<path...>` — the parity field id of a value. */
export function attrFieldId(path: string[]): string {
  return `jmx.${path.join(".")}`;
}

export function findBeanNode(tree: JmxTree, name: string): JmxNode | undefined {
  return tree.byId.get(`b:${name}`);
}

export function findValueNode(tree: JmxTree, bean: string, path: string[]): JmxNode | undefined {
  return tree.byId.get(attrId(bean, path));
}

/** Ancestors from the root down to (excluding) the node — used to expand the path of a deep link or a match. */
export function ancestorIds(node: JmxNode): string[] {
  const out: string[] = [];
  for (let p = node.parent; p; p = p.parent) out.push(p.id);
  return out.reverse();
}

export interface JmxMatch {
  /** true when a query is active (an empty query means "browse") */
  active: boolean;
  /** every node to render: matches plus their ancestors */
  ids: Set<string>;
  /** ancestor ids to add to the expanded set (so clearing the query leaves the path open) */
  expand: Set<string>;
  count: number;
}

/**
 * Case-insensitive substring search over attribute paths and values (plus MBean names). Branches match on their path so
 * `HeapMemoryUsage` finds the object even though only its leaves carry values.
 */
export function matchJmxTree(tree: JmxTree, query: string): JmxMatch {
  const needle = query.trim().toLowerCase();
  const ids = new Set<string>();
  const expand = new Set<string>();
  if (!needle) return { active: false, ids, expand, count: 0 };

  let count = 0;
  const selfMatch = (n: JmxNode): boolean => {
    if (n.kind === "bean") return n.label.toLowerCase().includes(needle);
    const path = n.path.join(".").toLowerCase();
    if (path.includes(needle)) return true;
    return n.kind === "value" && jmxValueText(n.value).toLowerCase().includes(needle);
  };
  const visit = (n: JmxNode): boolean => {
    const self = selfMatch(n);
    if (self) count++;
    let any = self;
    for (const child of n.children) if (visit(child)) any = true;
    if (any) {
      ids.add(n.id);
      if (!self) expand.add(n.id);
    }
    return any;
  };
  for (const root of tree.roots) visit(root);
  return { active: true, ids, expand, count };
}

export interface FlattenOptions {
  expanded: ReadonlySet<string>;
  /** from `matchJmxTree`; when active, only matches + ancestors are visible and the expanded set is ignored */
  match?: JmxMatch;
  /** parity mode: every node visible */
  all?: boolean;
}

/** Depth-first flatten of the *visible* tree — the input of the virtualizer. */
export function flattenJmxTree(tree: JmxTree, opts: FlattenOptions): JmxNode[] {
  const out: JmxNode[] = [];
  if (opts.all) {
    const visit = (n: JmxNode) => {
      out.push(n);
      for (const c of n.children) visit(c);
    };
    for (const root of tree.roots) visit(root);
    return out;
  }
  const match = opts.match?.active ? opts.match : null;
  const visit = (n: JmxNode) => {
    if (match && !match.ids.has(n.id)) return;
    out.push(n);
    if (n.children.length === 0) return;
    if (!match && !opts.expanded.has(n.id)) return;
    for (const c of n.children) visit(c);
  };
  for (const root of tree.roots) visit(root);
  return out;
}

/** Every expandable node id (groups, beans, objects, arrays) — "expand all". */
export function allExpandableIds(tree: JmxTree): string[] {
  const out: string[] = [];
  for (const node of tree.byId.values()) if (node.children.length > 0) out.push(node.id);
  return out;
}

// ── search highlighting ──────────────────────────────────────────────────────────────────────────────────────────────

export interface JmxHighlightPart {
  text: string;
  hit: boolean;
}

/** Split `text` into alternating plain/matched runs for `<mark>` rendering. Total, case-insensitive. */
export function highlightJmxText(text: string, query: string): JmxHighlightPart[] {
  const needle = query.trim();
  if (!needle) return [{ text, hit: false }];
  const hay = text.toLowerCase();
  const low = needle.toLowerCase();
  const parts: JmxHighlightPart[] = [];
  let from = 0;
  for (;;) {
    const at = hay.indexOf(low, from);
    if (at < 0) break;
    if (at > from) parts.push({ text: text.slice(from, at), hit: false });
    parts.push({ text: text.slice(at, at + needle.length), hit: true });
    from = at + needle.length;
  }
  if (parts.length === 0) return [{ text, hit: false }];
  if (from < text.length) parts.push({ text: text.slice(from), hit: false });
  return parts;
}

/** Middle-truncate long single-line strings, keeping both ends readable. */
export function truncateMiddle(text: string, max = 120): string {
  if (text.length <= max) return text;
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}
