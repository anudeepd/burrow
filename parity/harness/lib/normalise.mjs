// Normaliser vocabulary from parity/inventory/FORMAT.md.
//
// Both sides of a comparison are pushed through the SAME canonicaliser: `legacyText` (what the
// stock UI renders) and `raw` (the `data-yv` upstream value). The canonical form is a string
// (or null). Documented lossy normalisations *deliberately* truncate both sides so that e.g.
// legacy `Elapsed: 8sec` compares equal to a raw `elapsedTime: 8264` ms.
//
//   none · mb · bytes-desc · epoch · duration · percent · na-as-null · resource-string ·
//   lowercase · int · trim · html-strip · boolean-text · enum-name · url
//   Decorated-text primitives (each inverts ONE documented legacy decoration, source in the inventory item):
//   strip-scheme · after-colon · quoted-name · lead-int · before-colon · final-status-text · resource-mb · resource-vcores · join-comma · disabled-text ·
//   default-partition
//   combos with `+` (`na-as-null+epoch`), or `other:<text>` (opaque, string-only compare).
import { decodeEntities, htmlToText, parseDateTime } from "./util.mjs";

export const PRIMITIVES = new Set([
  "none",
  "mb",
  "bytes-desc",
  "epoch",
  "duration",
  "percent",
  "na-as-null",
  "resource-string",
  "lowercase",
  "int",
  "trim",
  "html-strip",
  "boolean-text",
  "enum-name",
  "url",
  "strip-scheme",
  "url-path",
  "after-colon",
  "quoted-name",
  "lead-int",
  "before-colon",
  "final-status-text",
  "resource-mb",
  "resource-vcores",
  "join-comma",
  "disabled-text",
  "default-partition",
]);

export function parseSpec(spec) {
  const parts = String(spec ?? "none")
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean);
  const opaque = parts.find((p) => p.startsWith("other:"));
  const known = parts.filter((p) => PRIMITIVES.has(p));
  const unknown = parts.filter((p) => !PRIMITIVES.has(p) && !p.startsWith("other:"));
  return {
    raw: String(spec ?? "none"),
    parts: known,
    opaque: opaque ? opaque.slice("other:".length) : null,
    unknown,
  };
}

/** null-gate shared by every primitive: empty / N/A / -1 / nullDisplay all mean "absent". */
export function isAbsent(v, ctx = {}) {
  if (v === null || v === undefined) return true;
  if (typeof v === "number") return Number.isNaN(v) || v === -1;
  if (typeof v === "boolean") return false;
  const s = String(v).trim();
  if (s === "") return true;
  if (ctx.nullDisplay != null && ctx.nullDisplay !== "" && s === String(ctx.nullDisplay).trim()) return true;
  if (/^n\/?a$/i.test(s)) return true;
  if (/^not\s+applicable$/i.test(s)) return true;
  if (/^-1(\.0+)?$/.test(s)) return true;
  return false;
}

const num = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim().replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** Canonical decimal: integers stay integral, floats get at most 4dp with trailing zeros cut. */
export function numCanon(n) {
  if (n == null || !Number.isFinite(n)) return null;
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toFixed(4)));
}

const BYTE_UNITS = {
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
  tb: 1024 ** 4,
  pb: 1024 ** 5,
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
  t: 1024 ** 4,
};

/** "3 GB" | "3072 MB" | 3072 -> bytes (number) or null. */
export function parseBytes(v) {
  if (typeof v === "number") return v;
  const s = String(v).trim();
  const m = s.match(/^(-?[\d.,]+)\s*([a-zA-Z]{1,3})?$/);
  if (!m) return null;
  const n = num(m[1]);
  if (n == null) return null;
  const unit = (m[2] ?? "").toLowerCase() || null;
  if (!unit) return n;
  const f = BYTE_UNITS[unit];
  return f == null ? null : n * f;
}

const DUR_UNITS = {
  ms: 1, msec: 1, msecs: 1, millisecond: 1, milliseconds: 1,
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
};

/** "8sec" | "1mins, 2sec" | "2hrs, 3mins" | 2000 -> ms (number) or null. */
export function parseDuration(v) {
  if (typeof v === "number") return v;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const re = /(-?[\d.]+)\s*([a-zA-Z]+)/g;
  let total = 0;
  let matched = false;
  let m;
  while ((m = re.exec(s))) {
    const n = num(m[1]);
    const f = DUR_UNITS[m[2].toLowerCase()];
    if (n == null || f == null) continue;
    total += n * f;
    matched = true;
  }
  return matched ? total : null;
}

/** "<memory:3 GB, vCores:4, name: 2 units>" | {memory:3072,vCores:4} -> "k=v;k=v" sorted. */
export function parseResourceString(v) {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const pairs = resourcePairsFromObject(v);
    if (!pairs.length) return null;
    return pairs.sort().join(";");
  }
  const s = String(v).trim().replace(/^<|>$/g, "");
  const pairs = [];
  for (const part of s.split(",")) {
    const mm = part.match(/^\s*(?:memory|mem)\s*:\s*(.+)$/i);
    if (mm) {
      const rawMemory = mm[1].trim();
      // Hadoop Resource.toString omits the unit for memory and means MiB; explicit units remain parsed as bytes.
      const bareMemory = /^[\d.,]+$/.test(rawMemory) ? num(rawMemory) : null;
      const b = bareMemory == null ? parseBytes(rawMemory) : null;
      const memoryMi = bareMemory ?? (b == null ? null : b / 1024 ** 2);
      pairs.push(memoryMi == null ? `memory=${rawMemory}` : `memory=${numCanon(memoryMi)}`);
      continue;
    }
    const m2 = part.match(/^\s*(vcores?|virtualcores?)\s*:\s*(.+)$/i);
    if (m2) {
      pairs.push(`vcores=${numCanon(num(m2[2]))}`);
      continue;
    }
    const m3 = part.match(/^\s*([^:=]+)\s*[:=]\s*(.+)$/);
    if (m3) pairs.push(`${m3[1].trim()}=${m3[2].trim()}`);
  }
  if (!pairs.length) return null;
  return pairs.sort().join(";");
}

function resourcePairsFromObject(o) {
  const out = [];
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "object") continue;
    const lk = k.toLowerCase();
    if (lk === "memory" || lk === "memorymb") {
      const b = Number(v) * 1024 ** 2; // REST resourceInfo memory is MB
      out.push(`memory=${numCanon(b / 1024 ** 2)}`);
    } else if (lk === "vcores" || lk === "virtualcores") {
      out.push(`vcores=${numCanon(num(v))}`);
    } else {
      out.push(`${k}=${v}`);
    }
  }
  return out;
}

/**
 * Apply one normaliser spec. `value` is the legacy text (string) or the raw upstream value.
 * `ctx`: { unit, nullDisplay, href, side }.
 * Returns { value: string|null, notes: string[] }.
 */
export function canonicalise(value, spec, ctx = {}) {
  const parsed = parseSpec(spec ?? "none");
  const notes = [];
  if (ctx.nullDisplay != null && ctx.nullDisplay !== "" && value != null) {
    const cmp = typeof value === "string" ? value.trim() : value;
    const nd = String(ctx.nullDisplay).trim();
    if (String(cmp) === nd) return { value: null, notes: [`nullDisplay:${nd}`] };
  }
  let cur = value;
  for (const p of parsed.parts) {
    const r = PRIM[p](cur, ctx, notes);
    cur = r;
  }
  if (typeof cur === "string") {
    // Every canonical form is trimmed and whitespace-collapsed so that DOM indentation never
    // matters; `none`/`lowercase` keep inner punctuation verbatim.
    cur = cur.replace(/\s+/g, " ").trim();
    if (cur === "") cur = null;
  }
  if (parsed.unknown.length) notes.push(`unknown-normaliser:${parsed.unknown.join(",")}`);
  if (parsed.opaque) notes.push(`opaque-normaliser:${parsed.opaque}`);
  return { value: cur, notes };
}

const PRIM = {
  none: (v) => (v === undefined ? null : v),
  trim: (v) => (v === undefined ? null : v),
  "html-strip": (v) => (v == null ? null : htmlToText(String(v))),
  lowercase: (v) => (v == null ? null : String(v).toLowerCase()),
  "na-as-null": (v, ctx) => (isAbsent(v, ctx) ? null : v),
  int: (v) => {
    const n = num(v);
    return n == null ? null : String(Math.trunc(n));
  },
  mb: (v, ctx) => {
    if (isAbsent(v, ctx)) return null;
    const b = parseBytes(v);
    if (b == null) return null;
    // Ambiguity rule: a bare number is MB (the unit every MB-valued YARN field carries);
    // an explicit unit is converted from bytes.
    const explicit = typeof v === "string" && /[a-zA-Z]/.test(v.trim());
    const mbs = explicit ? b / 1024 ** 2 : b;
    return numCanon(round1(mbs));
  },
  "bytes-desc": (v, ctx) => {
    if (isAbsent(v, ctx)) return null;
    const b = parseBytes(v);
    return b == null ? null : numCanon(b);
  },
  epoch: (v, ctx) => {
    if (isAbsent(v, ctx)) return null;
    const ms = parseDateTime(v);
    if (ms == null || ms <= 0) return null;
    return String(Math.floor(ms / 1000) * 1000); // display resolution is seconds
  },
  duration: (v, ctx) => {
    if (isAbsent(v, ctx)) return null;
    const ms = parseDuration(v);
    if (ms == null || ms < 0) return null;
    return String(Math.floor(ms / 1000) * 1000);
  },
  percent: (v, ctx) => {
    if (isAbsent(v, ctx)) return null;
    const n = num(String(v).replace(/%$/, ""));
    return n == null ? null : numCanon(round1(n));
  },
  "resource-string": (v, ctx) => {
    if (isAbsent(v, ctx)) return null;
    return parseResourceString(v);
  },
  "boolean-text": (v, ctx) => {
    if (isAbsent(v, ctx)) return null;
    if (typeof v === "boolean") return String(v);
    const s = String(v).trim().toLowerCase();
    if (["true", "yes", "1", "on"].includes(s)) return "true";
    if (["false", "no", "0", "off"].includes(s)) return "false";
    return String(v).trim();
  },
  "enum-name": (v, ctx) => {
    if (isAbsent(v, ctx)) return null;
    return String(v).trim().toUpperCase();
  },
  url: (v, ctx) => {
    if (isAbsent(v, ctx)) return null;
    const s = String(ctx.href ?? v).trim();
    // "#" is the Hamlet placeholder href; a bare scheme is `httpSchemePrefix + ""` (RMAppBlock builds the node link as
    // prefix + nodeHttpAddress even when the attempt has no node yet) — both mean "no link"
    if (!s || s === "#" || /^[a-z][a-z0-9+.-]*:\/\/$/i.test(s)) return null;
    return s.replace(/\/+$/, "");
  },
  // RMAppBlock/AppAttemptBlock render a node link as `httpSchemePrefix + nodeHttpAddress`; REST carries host:port only. A bare
  // prefix ("http://", attempt not yet on a node) is "no node".
  // Outbound links: burrow deliberately rebuilds RM/JHS/SHS URLs from the operator-configured base
  // (web/src/lib/upstream-url.ts), while the stock UI prints the hostname the RM advertises for itself
  // (`smadayma:8088`). The *path* is the datum that must match; the origin is a documented product choice,
  // visible as `normaliserOverride` on every affected row.
  "url-path": (v, ctx) => {
    if (isAbsent(v, ctx)) return null;
    const t = String(v).trim();
    if (t === "" || t === "#") return null;
    const m = t.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/.*)$/i);
    const out = (m ? m[1] : t).replace(/\/+$/, "");
    return out === "" ? "/" : out;
  },
  "strip-scheme": (v, ctx) => {
    if (isAbsent(v, ctx)) return null;
    const t = String(v).trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/+$/, "");
    return t === "" || t === "#" ? null : t;
  },
  // "Log Aggregation: NOT_START" (RMAppLogAggregationStatusBlock.java:116) -> the part after the first colon
  "after-colon": (v, ctx) => {
    if (isAbsent(v, ctx)) return null;
    const t = String(v);
    const i = t.indexOf(":");
    return i < 0 ? t.trim() : t.slice(i + 1).trim();
  },
  // "'root.default' Queue Status [for Partition '<p>']" (CapacitySchedulerPage.java:197, QueueInfoBlock title) -> the first quoted name
  "quoted-name": (v, ctx) => {
    if (isAbsent(v, ctx)) return null;
    const m = String(v).match(/'([^']*)'/);
    return m ? m[1] : String(v).trim();
  },
  // "0 (Higher Integer value indicates higher priority)" (AppBlock.clarifyAppPriority), "30 seconds"
  // (AppBlock.java:276-278) -> the leading integer; -1/"Unlimited"/N/A stay absent
  "lead-int": (v, ctx) => {
    if (isAbsent(v, ctx)) return null;
    if (typeof v === "number") return String(Math.trunc(v));
    const m = String(v).trim().replace(/,/g, "").match(/^(-?\d+)(?:\D|$)/);
    return m ? String(Number(m[1])) : null;
  },
  // "ACCEPTED: waiting for AM container..." (AppBlock.clarifyAppState) -> "ACCEPTED"
  "before-colon": (v, ctx) => {
    if (isAbsent(v, ctx)) return null;
    return String(v).split(":")[0].trim();
  },
  // AppBlock.clairfyAppFinalStatus: UNDEFINED is rendered as "Application has not completed yet."
  "final-status-text": (v, ctx) => {
    if (isAbsent(v, ctx)) return null;
    const t = String(v).trim();
    return /^application has not completed yet\.?$/i.test(t) ? "UNDEFINED" : t.toUpperCase();
  },
  // "<memory:128, vCores:1>" -> memory in MB / vCores (REST exposes preemptedResourceMB / VCores as separate keys)
  "resource-mb": (v, ctx) => {
    if (isAbsent(v, ctx)) return null;
    if (typeof v === "number" || /^-?\d+(\.\d+)?$/.test(String(v).trim())) return numCanon(Number(v));
    const m = String(v).match(/memory:\s*([^,>]+)/i);
    if (!m) return null;
    const b = parseBytes(m[1].trim());
    if (b == null) return null;
    return numCanon(round1(/[a-zA-Z]/.test(m[1]) ? b / 1024 ** 2 : b));
  },
  "resource-vcores": (v, ctx) => {
    if (isAbsent(v, ctx)) return null;
    if (typeof v === "number" || /^-?\d+(\.\d+)?$/.test(String(v).trim())) return numCanon(Number(v));
    const m = String(v).match(/vcores:\s*(-?\d+)/i);
    return m ? m[1] : null;
  },
  // StringUtils.join(",", labels) on the legacy side; ours/REST carry the array (or its JSON text)
  "join-comma": (v) => {
    if (v == null) return null;
    let arr = v;
    if (typeof v === "string" && /^\s*\[/.test(v)) {
      try {
        arr = JSON.parse(v);
      } catch {
        arr = v;
      }
    }
    if (Array.isArray(arr)) return arr.length ? arr.map(String).join(",") : null;
    const t = String(arr).trim();
    return t === "" ? null : t;
  },
  // CapacitySchedulerPage.java:216-219: getPreemptionDisabled() ? "disabled" : "enabled"; REST carries the boolean
  "disabled-text": (v, ctx) => {
    if (typeof v === "boolean") return String(v);
    if (v == null) return null;
    const t = String(v).trim().toLowerCase();
    if (t === "disabled" || t === "true") return "true";
    if (t === "enabled" || t === "false") return "false";
    return t || null;
  },
  // RMAppImpl.getAmNodeLabelExpression (:1814-1823) feeds the legacy page: null -> "<Not set>", blank ->
  // "<DEFAULT_PARTITION>"; the REST AppInfo carries the raw request expression ("" for the default partition)
  "default-partition": (v) => {
    if (v == null) return null;
    const t = String(v).trim();
    return t === "" ? "<DEFAULT_PARTITION>" : t;
  },
};

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Compare two canonical values. Returns { equal, why }.
 * Numbers that survived canonicalisation are compared numerically so "3072" == "3072.0".
 */
export function canonicalEqual(a, b) {
  if (a == null && b == null) return { equal: true, why: "both-absent" };
  if (a == null || b == null) return { equal: false, why: a == null ? "legacy-absent" : "ours-absent" };
  if (typeof a === "boolean") a = String(a);
  if (typeof b === "boolean") b = String(b);
  if (String(a) === String(b)) return { equal: true, why: "exact" };
  const na = num(a);
  const nb = num(b);
  if (na != null && nb != null && na === nb) return { equal: true, why: "numeric" };
  return { equal: false, why: "differ" };
}

/** Loose textual equality used for derived fields (no raw upstream counterpart). */
export function looseText(s) {
  if (s == null) return null;
  const t = decodeEntities(String(s)).replace(/\s+/g, " ").trim();
  return t === "" ? null : t;
}

export function looseEqual(a, b) {
  const x = looseText(a);
  const y = looseText(b);
  if (x == null && y == null) return { equal: true, why: "both-absent" };
  if (x == null || y == null) return { equal: false, why: x == null ? "legacy-absent" : "ours-absent" };
  if (x === y) return { equal: true, why: "exact" };
  if (x.toLowerCase() === y.toLowerCase()) return { equal: true, why: "ci" };
  return { equal: false, why: "differ" };
}
