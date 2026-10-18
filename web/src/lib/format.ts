/**
 * Display formatters. They only ever produce the *visible* text; the raw upstream value is stamped separately by `Datum`
 * (data-yv), so formatting here can be as friendly as we like. Every formatter is pure and total (never throws, never "NaN").
 */

export type Fmt = "bytes" | "mb" | "ms" | "dur" | "epoch" | "pct" | "int" | "id" | "text";

const NA = "—";

const intFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function fmtInt(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? NA : intFmt.format(n);
}

/** Identifiers (cluster id, stage/task/job ids) are never group-separated, matching YARN/Spark exactly. */
export function fmtId(n: number | string | null | undefined): string {
  if (n == null) return NA;
  return typeof n === "number" ? (Number.isFinite(n) ? String(n) : NA) : n;
}

/** 0.5 -> "0.5%"; value is already a percentage (RM reports 0..100). */
export function fmtPct(n: number | null | undefined, digits = 1): string {
  return n == null || !Number.isFinite(n) || n < 0 ? NA : `${n.toFixed(digits)}%`;
}

const UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;

export function fmtBytes(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n) || n < 0) return NA;
  let v = n;
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(digits).replace(/\.0+$/, "")} ${UNITS[i]}`;
}

/** YARN reports memory in MB (mebibytes). */
export function fmtMB(mb: number | null | undefined, digits = 1): string {
  if (mb == null || !Number.isFinite(mb) || mb < 0) return NA;
  return fmtBytes(mb * 1024 * 1024, digits);
}

/** 3725000 -> "1h 2m 5s"; sub-second -> "340 ms". */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return NA;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (d || h) parts.push(`${h}h`);
  if (d || h || m) parts.push(`${m}m`);
  if (!d) parts.push(`${sec}s`);
  return parts.join(" ");
}

export type TzMode = "local" | "utc";

const dtCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: TzMode): Intl.DateTimeFormat {
  let f = dtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZone: tz === "utc" ? "UTC" : undefined,
    });
    dtCache.set(tz, f);
  }
  return f;
}

/** Epoch ms -> "2026-10-03 12:04:09" in the chosen zone; 0 / negative / null -> "—" (YARN uses 0 for "not yet"). */
export function fmtEpoch(ms: number | null | undefined, tz: TzMode = "local"): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return NA;
  return dtf(tz).format(ms).replace(",", "");
}

/** ISO timestamp with explicit zone -> the selected zone; unzoned or non-ISO metadata stays literal. */
export function fmtIsoTimestamp(value: string | null | undefined, tz: TzMode = "local"): string {
  if (value == null || value.trim() === "") return NA;
  const text = value.trim();
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) return text;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? fmtEpoch(ms, tz) : text;
}

/** Time only, for "updated 12:04:09". */
export function fmtClock(ms: number, tz: TzMode = "local"): string {
  return fmtEpoch(ms, tz).split(" ")[1] ?? NA;
}

export function fmtRelative(fromMs: number, nowMs: number): string {
  const d = Math.max(0, nowMs - fromMs);
  if (d < 1500) return "just now";
  if (d < 60_000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  return `${Math.floor(d / 3_600_000)}h ago`;
}

/** Stringify a raw upstream value exactly as JSON would — used for data-yv. Never formats. */
export function rawString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  return JSON.stringify(v);
}

export function formatByTag(tag: Fmt, v: unknown, tz: TzMode = "local"): string {
  if (v == null) return NA;
  switch (tag) {
    case "bytes":
      return fmtBytes(Number(v));
    case "mb":
      return fmtMB(Number(v));
    case "ms":
    case "dur":
      return fmtDuration(Number(v));
    case "epoch":
      return fmtEpoch(Number(v), tz);
    case "pct":
      return fmtPct(Number(v));
    case "int":
      return fmtInt(Number(v));
    case "id":
      return fmtId(typeof v === "number" || typeof v === "string" ? v : String(v));
    default:
      return String(v);
  }
}
