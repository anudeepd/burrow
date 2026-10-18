/**
 * Pure helpers for the daemon log viewer (`/tools/logs`).
 *
 * The RM's log directory is read as a byte-addressed file: `GET /api/rm/logs/{file}?offset=&length=` returns a window of
 * `text/plain`. Paging therefore never re-reads the whole file, and the window the server actually served is taken from the
 * `x-burrow-log-size|start|end|source` headers when they are present (the dev mock and contract §5 set them) and derived from
 * the request + the listing size when they are not (the Rust handler currently streams the range without them).
 */
import { API_BASE, ApiError, canonicalQuery } from "~/api/client";
import { type BurrowHeaders, parseBurrowHeaders, recordFailure, recordSuccess } from "~/api/connection";
import { LOG_PAGE_BYTES, type LogFileEntry, logWindow } from "~/api/queries/tools";
import { fmtBytes } from "~/lib/format";

export { LOG_PAGE_BYTES };
export type { LogFileEntry };

export type LogSortKey = "name" | "size" | "lastModified";

/**
 * Pages are aligned blocks `[k·page, min(size, (k+1)·page))`, so the last page always ends exactly at the end of the file
 * and paging can never skip the tail. A tail window is simply the last page.
 */
export function lastPageOffset(size: number, pageBytes = LOG_PAGE_BYTES): number {
  if (size <= 0) return 0;
  return Math.max(0, Math.floor((size - 1) / pageBytes) * pageBytes);
}

export interface LogPage {
  /** byte the window starts at (0 or a multiple of `length`, clamped to the file) */
  offset: number;
  /** requested window length (`logWindow` clamps it to what is left) */
  length: number;
  /** exclusive end of the window: `[offset, end)` */
  end: number;
  /** offset of the previous page, or null at the start */
  prev: number | null;
  /** offset of the next page, or null on the last page */
  next: number | null;
  /** offset of the last page ("jump to end") */
  last: number;
}

export function logPage(size: number, offset: number, pageBytes = LOG_PAGE_BYTES): LogPage {
  const { offset: start, length } = logWindow(size, offset, pageBytes);
  const end = Math.min(size, start + length) || start + length;
  const last = lastPageOffset(size, pageBytes);
  return {
    offset: start,
    length,
    end,
    prev: start > 0 ? Math.max(0, start - pageBytes) : null,
    next: start + pageBytes < size ? start + pageBytes : null,
    last,
  };
}

export interface LogWindowInfo {
  /** total file size in bytes */
  size: number;
  /** inclusive first byte of the served window */
  start: number;
  /** exclusive last byte of the served window */
  end: number;
  /** which daemon served it (`x-burrow-log-source`) */
  source: string | null;
  /** true when the endpoint sent no `x-burrow-log-*` headers and the numbers were derived from the request */
  derived: boolean;
}

/**
 * The window the server served. Three sources, most specific first:
 *  1. `x-burrow-log-size|start|end` (dev mock, contract §5 container logs) — byte counts;
 *  2. `content-range: bytes s-e/total` (the Rust handler passes Jetty's 206 through; `e` is inclusive);
 *  3. what Burrow asked for, plus the bytes that actually arrived.
 * Never invents a size smaller than what arrived, and a 206 is a success, not an error.
 */
export function parseLogWindow(headers: Headers, fallback: { offset: number; size: number; byteLength: number }): LogWindowInfo {
  const read = (name: string): number | null => {
    const raw = headers.get(name);
    if (raw === null || raw.trim() === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const contentRange = headers.get("content-range");
  let rangeStart: number | null = null;
  let rangeEnd: number | null = null;
  let rangeSize: number | null = null;
  const m = contentRange ? /^bytes\s+(\d+)-(\d+)\s*\/\s*(\d+|\*)$/.exec(contentRange.trim()) : null;
  if (m && m[1] !== undefined && m[2] !== undefined && m[3] !== undefined) {
    rangeStart = Number(m[1]);
    rangeEnd = Number(m[2]) + 1; // content-range's end is inclusive, ours is exclusive
    rangeSize = m[3] === "*" ? null : Number(m[3]);
  }
  const sizeHeader = read("x-burrow-log-size") ?? rangeSize;
  const startHeader = read("x-burrow-log-start") ?? rangeStart;
  const endHeader = read("x-burrow-log-end") ?? rangeEnd;
  const size = sizeHeader ?? Math.max(fallback.size, fallback.offset + fallback.byteLength);
  const start = startHeader ?? fallback.offset;
  const end = endHeader ?? Math.min(size, start + fallback.byteLength);
  return {
    size,
    start,
    end,
    source: headers.get("x-burrow-log-source"),
    derived: sizeHeader === null || startHeader === null || endHeader === null,
  };
}

const COUNT = new Intl.NumberFormat("en-US");

/** `bytes 93 655–222 178 of 222 179 · 125.5 KiB` — inclusive ends, because that is how a hex dump is read. */
export function byteRangeLabel(info: LogWindowInfo): string {
  const end = Math.max(info.start, info.end - 1);
  const span = Math.max(0, info.end - info.start);
  return `bytes ${COUNT.format(info.start)}–${COUNT.format(end)} of ${COUNT.format(info.size)} · ${fmtBytes(span)}`;
}

export interface LogChunk extends LogWindowInfo {
  text: string;
}

/** The read timeout, combined with the caller's signal — degrading to whichever of the two exists. */
function readSignal(signal?: AbortSignal): AbortSignal | undefined {
  const timeout = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(30_000) : undefined;
  if (!signal) return timeout;
  if (!timeout || typeof AbortSignal.any !== "function") return signal;
  return AbortSignal.any([signal, timeout]);
}

/**
 * Read one byte window. Deliberately does its own `fetch`: the shared `apiText()` throws the `x-burrow-log-*` headers away, and
 * the window the server served is exactly what the pager must display. Error handling mirrors `api/client.ts` (same error
 * envelope, same connection bookkeeping) so a failure here looks like every other failure in the product.
 */
export async function fetchLogChunk(
  file: string,
  range: { offset: number; length: number; size: number },
  signal?: AbortSignal,
): Promise<LogChunk> {
  const path = `${API_BASE}/${logFilePath(file)}${canonicalQuery({ offset: range.offset, length: range.length })}`;
  let res: Response;
  try {
    res = await fetch(path, { headers: { accept: "text/plain" }, signal: readSignal(signal) });
  } catch (e) {
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    const message = timeout ? `Timed out reading ${logFilePath(file)}` : `Cannot reach Burrow to read ${logFilePath(file)}`;
    recordFailure(message);
    throw new ApiError(message, timeout ? "timeout" : "network", null, "network");
  }
  const responseMeta = parseBurrowHeaders(res.headers);
  if (!res.ok) {
    const err = await responseError(res, path, responseMeta);
    recordFailure(err.message);
    throw err;
  }
  recordSuccess(responseMeta);
  const text = await res.text();
  const byteLength = new TextEncoder().encode(text).length;
  return { text, ...parseLogWindow(res.headers, { offset: range.offset, size: range.size, byteLength }) };
}

async function responseError(res: Response, path: string, responseMeta: BurrowHeaders): Promise<ApiError> {
  const raw = await res.text().catch(() => "");
  let body: unknown = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = raw || null;
  }
  const envelope = body as {
    error?: { code?: string; message?: string; hint?: string };
    RemoteException?: { message?: string; exception?: string };
  } | null;
  if (envelope && typeof envelope === "object" && envelope.error) {
    return new ApiError(
      envelope.error.message ?? `HTTP ${res.status}`,
      "http",
      res.status,
      envelope.error.code ?? null,
      null,
      envelope.error.hint ?? null,
      responseMeta,
      body,
    );
  }
  if (envelope && typeof envelope === "object" && envelope.RemoteException) {
    return new ApiError(
      envelope.RemoteException.message ?? `HTTP ${res.status}`,
      "http",
      res.status,
      "RemoteException",
      null,
      null,
      responseMeta,
      body,
    );
  }
  return new ApiError(`HTTP ${res.status} from ${path}`, "http", res.status, null, null, null, responseMeta, body);
}

export function logFilePath(file: string): string {
  return `rm/logs/${encodeURIComponent(file)}`;
}

/** Same-origin download of the whole file (`<a download>`), the same URL the viewer pages through. */
export function logFileHref(file: string): string {
  return `${API_BASE}/${logFilePath(file)}`;
}

/** True when the endpoint itself is missing (404) — the honest "the backend does not serve this yet" case. */
export function isEndpointMissing(error: unknown): boolean {
  // A proxied 404 from the ResourceManager means its `/logs/` directory is unavailable; only a local 404 means this
  // Burrow backend does not expose the API route at all.
  return error instanceof ApiError && error.status === 404 && error.upstream === null && error.responseMeta?.upstream === null;
}

/**
 * Sort the directory listing: directories last (they are never readable here), then the chosen key. The time key orders by
 * `modifiedSortKey` — the zone-free key the listing's printed date yields — so ordering never asserts a timezone; an epoch
 * (`lastModified`, container-log shape) is used when the backend reports one.
 */
export function sortLogFiles(files: readonly LogFileEntry[], key: LogSortKey, desc: boolean): LogFileEntry[] {
  const dir = desc ? -1 : 1;
  return [...files].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? 1 : -1;
    if (key === "name") return dir * a.name.localeCompare(b.name);
    if (key === "size") return dir * (a.size - b.size) || a.name.localeCompare(b.name);
    const av = a.modifiedSortKey ?? a.lastModified ?? 0;
    const bv = b.modifiedSortKey ?? b.lastModified ?? 0;
    return dir * (av - bv) || a.name.localeCompare(b.name);
  });
}
