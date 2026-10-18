// Small, dependency-free helpers shared by every harness module.
// Nothing here knows about YARN: keep it boring and total (never throws on odd input).
import { createHash } from "node:crypto";

export const nowMs = () => Date.now();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function sha1(s) {
  return createHash("sha1").update(s).digest("hex");
}
export function sha1short(s, n = 12) {
  return sha1(s).slice(0, n);
}

/** YAML/JSON round-trip safe deep clone. */
export function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/** Stable JSON (sorted object keys) — for hashing/diffing recorded payloads. */
export function stableJson(v) {
  const seen = new WeakSet();
  const walk = (x) => {
    if (x === null || typeof x !== "object") return x;
    if (seen.has(x)) return "[circular]";
    seen.add(x);
    if (Array.isArray(x)) return x.map(walk);
    const out = {};
    for (const k of Object.keys(x).sort()) out[k] = walk(x[k]);
    return out;
  };
  return JSON.stringify(walk(v));
}

/**
 * Get a value by inventory-style path: dot separated, `*` for one array element / map key.
 * `apps.app[].id` and `apps.app.*.id` are both accepted; `[0]`/`[2]` index forms too.
 */
export function getPath(obj, path) {
  if (obj == null || path == null || path === "") return undefined;
  const segs = String(path)
    .replace(/\[(\d+|\*)\]/g, ".$1")
    .split(".")
    .filter((s) => s !== "");
  let cur = obj;
  for (const seg of segs) {
    if (cur == null) return undefined;
    if (seg === "*") {
      if (Array.isArray(cur)) {
        // "first array element" is what a scalar-ish path means in practice
        cur = cur.length ? cur[0] : undefined;
      } else if (typeof cur === "object") {
        const keys = Object.keys(cur);
        cur = keys.length ? cur[keys[0]] : undefined;
      } else return undefined;
      continue;
    }
    cur = cur[seg];
  }
  return cur;
}

/** True when an object is a "map" (dynamic keys) rather than a DTO. */
export function looksLikeMapKey(k) {
  return (
    /^\d+$/.test(k) ||
    /[-: +/]/.test(k) ||
    /^(application|container|appattempt)_/.test(k) ||
    k === ""
  );
}

export function isMapLike(key, val) {
  if (val === null || typeof val !== "object" || Array.isArray(val)) return false;
  if (/(Map|map)$/.test(key)) return true;
  const keys = Object.keys(val);
  if (!keys.length) return false;
  return keys.every(looksLikeMapKey);
}

/**
 * Walk a JSON body and produce a Set of canonical leaf paths.
 * Canonicalisation: array element => `*`, map key => `*`, DTO field names verbatim.
 * Also records the observed JSON types per path (`types`), which the coverage report prints.
 */
export function collectJsonPaths(body, { skipEmptyContainers = true } = {}) {
  const paths = new Map(); // path -> Set(type)
  const walk = (node, prefix) => {
    if (Array.isArray(node)) {
      const p = prefix ? `${prefix}.*` : "*";
      if (!node.length) {
        if (!skipEmptyContainers) bump(paths, p, "array[]");
        return;
      }
      for (const el of node) walk(el, p);
      return;
    }
    if (node !== null && typeof node === "object") {
      const keys = Object.keys(node);
      const asMap = isMapLike(lastSeg(prefix), node);
      if (!keys.length) {
        if (!skipEmptyContainers) bump(paths, prefix || "*", "object{}");
        return;
      }
      if (asMap) {
        const p = prefix ? `${prefix}.*` : "*";
        for (const k of keys) walk(node[k], p);
        return;
      }
      for (const k of keys) walk(node[k], prefix ? `${prefix}.${k}` : k);
      return;
    }
    if (!prefix) return;
    bump(paths, prefix, jsonType(node));
  };
  walk(body, "");
  return paths;
}

function lastSeg(p) {
  if (!p) return "";
  const i = p.lastIndexOf(".");
  return i < 0 ? p : p.slice(i + 1);
}

function bump(map, path, type) {
  let s = map.get(path);
  if (!s) map.set(path, (s = new Set()));
  s.add(type);
}

export function jsonType(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** Canonicalise an inventory-authored path (`apps.app[].id`, `m.a.b`) for comparison. */
export function canonicalPath(p) {
  return String(p)
    .replace(/\[\d*\]/g, ".*")
    .replace(/\.+/g, ".")
    .replace(/^\.|\.$/g, "");
}

/** html -> text: strip tags, decode the handful of entities Hadoop emits, collapse ws. */
export function htmlToText(html) {
  if (html == null) return "";
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/(p|div|li|tr|td|th|h\d)>/gi, " ")
      .replace(/<[^>]*>/g, "")
  )
    .replace(/\s+/g, " ")
    .trim();
}

export function decodeEntities(s) {
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    "#39": "'",
    "#x27": "'",
    "#x2F": "/",
  };
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (Object.hasOwn(named, e)) return named[e];
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (Number.isFinite(code)) return String.fromCodePoint(code);
    }
    return m;
  });
}

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Parse the formats Hadoop's `Times.format` (java DateTimeFormatter
 * "EEE MMM dd HH:mm:ss Z yyyy") and JS Date produce. Returns epoch ms or null.
 * Parsing is explicit (no `new Date(string)` guessing) so results are deterministic.
 */
export function parseDateTime(s) {
  if (s == null) return null;
  if (typeof s === "number") return Number.isFinite(s) ? s : null;
  const raw = String(s).trim();
  if (!raw || /^n\/?a$/i.test(raw) || raw === "-") return null;
  if (/^\d{10,16}$/.test(raw)) return Number(raw); // epoch ms / s heuristic
  // java: Sat Oct 03 12:21:32 +0530 2026
  let m = raw.match(
    /^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+([+-]\d{4})\s+(\d{4})$/
  );
  if (m) {
    const [, mon, day, hh, mm, ss, off, year] = m;
    const mo = MONTHS[mon.toLowerCase()];
    if (mo === undefined) return null;
    const sign = off[0] === "-" ? -1 : 1;
    const offMin = sign * (Number(off.slice(1, 3)) * 60 + Number(off.slice(3, 5)));
    const utc = Date.UTC(Number(year), mo, Number(day), Number(hh), Number(mm), Number(ss));
    return utc - offMin * 60_000;
  }
  // ISO-ish (2026-10-03T12:21:32.614+05:30 / with space / trailing Z)
  m = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:?\d{2})?$/
  );
  if (m) {
    const [, y, mo, d, hh, mm, ss, ms, off] = m;
    let offMin = 0;
    if (off && off !== "Z") {
      const sign = off[0] === "-" ? -1 : 1;
      const digits = off.slice(1).replace(":", "");
      offMin = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
    }
    return (
      Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), Number(ss), Number(ms ?? 0)) -
      offMin * 60_000
    );
  }
  return null;
}

export function sortBy(arr, fn) {
  return [...arr].sort((a, b) => {
    const ka = fn(a);
    const kb = fn(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

export function uniq(arr) {
  return [...new Set(arr)];
}

export function groupBy(arr, fn) {
  const m = new Map();
  for (const x of arr) {
    const k = fn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

/** Count elements of an array into a plain object, largest first. */
export function tally(arr) {
  const m = new Map();
  for (const x of arr) m.set(x, (m.get(x) ?? 0) + 1);
  return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))));
}

export function truncate(s, n = 160) {
  const t = String(s ?? "");
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

/** Recursive deep equality with a path trail on the first difference. */
export function deepDiff(a, b, path = "$", out = [], limit = 40) {
  if (out.length >= limit) return out;
  if (a === b) return out;
  const ta = jsonType(a);
  const tb = jsonType(b);
  if (ta !== tb) {
    out.push({ path, kind: "type", a: preview(a), b: preview(b) });
    return out;
  }
  if (ta === "array") {
    if (a.length !== b.length) out.push({ path, kind: "array-length", a: a.length, b: b.length });
    for (let i = 0; i < Math.min(a.length, b.length); i++) deepDiff(a[i], b[i], `${path}[${i}]`, out, limit);
    return out;
  }
  if (ta === "object") {
    const keys = uniq([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (!(k in a)) out.push({ path: `${path}.${k}`, kind: "missing-in-a", b: preview(b[k]) });
      else if (!(k in b)) out.push({ path: `${path}.${k}`, kind: "missing-in-b", a: preview(a[k]) });
      else deepDiff(a[k], b[k], `${path}.${k}`, out, limit);
      if (out.length >= limit) break;
    }
    return out;
  }
  if (Number.isNaN(a) && Number.isNaN(b)) return out;
  out.push({ path, kind: "value", a: preview(a), b: preview(b) });
  return out;
}

const preview = (v) => (typeof v === "string" && v.length > 120 ? `${v.slice(0, 120)}…` : v);

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
