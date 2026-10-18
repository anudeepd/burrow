/**
 * Container-log endpoints (docs/contracts/api.md §5) — the wire layer for the log viewer.
 *
 * Three routes:
 *   GET /api/logs/containers/{containerId}                        → file list
 *   GET /api/logs/containers/{containerId}/files/{name}           → text/plain byte window (+ x-burrow-log-* headers)
 *   GET /api/logs/containers/{containerId}/files/{name}/stream    → SSE follow (chunk · eof · error)
 *
 * The window reader does its own `fetch` because the `x-burrow-log-*` headers ARE the result: the server may clamp the
 * requested range and a `tail` read lands at an offset the client cannot predict, so `apiText()` (which keeps only the
 * body) cannot drive the pager. Error handling deliberately mirrors `api/client.ts` — same `ApiError`, same envelope,
 * same connection bookkeeping — so a log failure looks like every other failure in the product.
 */
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { API_BASE, ApiError, type Query, apiGet, canonicalQuery } from "../client";
import { type BurrowHeaders, parseBurrowHeaders, recordFailure, recordSuccess } from "../connection";
import { adaptive } from "../refetch";
import { obj } from "../schemas/_base";
import { list } from "../schemas/_lenient";

const enc = encodeURIComponent;

/** Contract §5: no range and no tail ⇒ the first 1 MiB; the backend hard-caps a request at 8 MiB. */
export const LOG_WINDOW_BYTES = 1024 * 1024;
export const LOG_MAX_BYTES = 8 * 1024 * 1024;
/** How much of a growing file the follow view loads up front when it starts at the tail. */
export const LOG_TAIL_BYTES = 256 * 1024;

/** Coordinates the SPA already knows from the RM's attempt/container lists; the backend validates `node` against the RM. */
export interface LogHints {
  node?: string | null;
  user?: string | null;
  app?: string | null;
}

/** Only non-empty hints are sent (an empty `node=` would fail the backend's host validation). */
export function hintQuery(hints: LogHints | undefined): Query | undefined {
  if (!hints) return undefined;
  const q: Query = {};
  if (hints.node) q.node = hints.node;
  if (hints.user) q.user = hints.user;
  if (hints.app) q.app = hints.app;
  return Object.keys(q).length ? q : undefined;
}

/**
 * One file in a container's log directory. `size`/`lastModified` are the inventory's `log.fileSize` /
 * `log.lastModifiedTime`; the backend normalises JHS's string sizes and `Times.format` dates onto numbers, but a
 * numeric string is tolerated so a slightly different backend still parses.
 */
export const LogFileInfoSchema = obj({
  name: z.string(),
  size: z
    .union([z.number(), z.string()])
    .nullish()
    .transform((v) => (typeof v === "string" ? Number(v.replace(/,/g, "")) : (v ?? 0)))
    .pipe(z.number()),
  lastModified: z
    .union([z.number(), z.string()])
    .nullish()
    .transform((v) => {
      if (v == null) return null;
      if (typeof v === "number") return v;
      const n = Number(v);
      if (Number.isFinite(n)) return n;
      const t = Date.parse(v); // JHS `Times.format` text, if a backend ever passes it through
      return Number.isNaN(t) ? null : t;
    }),
});
export type LogFileInfo = z.infer<typeof LogFileInfoSchema>;

export const LogFilesResponseSchema = obj({
  source: z.string().default("nm"),
  node: z.string().nullish(),
  files: list(LogFileInfoSchema),
});
export type LogFilesResponse = z.infer<typeof LogFilesResponseSchema>;

/** Size-descending is the useful default: the interesting file in a userlog dir is stdout/stderr, not directory.info. */
const FILE_ORDER: Record<string, number> = { stdout: 0, stderr: 1 };
export function orderLogFiles(files: readonly LogFileInfo[]): LogFileInfo[] {
  return [...files].sort((a, b) => {
    const ra = FILE_ORDER[a.name] ?? 2;
    const rb = FILE_ORDER[b.name] ?? 2;
    return ra !== rb ? ra - rb : a.name.localeCompare(b.name);
  });
}

export function logFilesPath(containerId: string): string {
  return `logs/containers/${enc(containerId)}`;
}

export function logFilePath(containerId: string, name: string): string {
  return `${logFilesPath(containerId)}/files/${enc(name)}`;
}

export function logStreamPath(containerId: string, name: string): string {
  return `${logFilePath(containerId, name)}/stream`;
}

export interface LogWindowRequest {
  offset?: number;
  length?: number;
  tail?: number;
  hints?: LogHints;
}

export interface LogWindowResult {
  text: string;
  /** total file size (x-burrow-log-size) */
  size: number;
  /** byte offset of the first byte served (x-burrow-log-start) */
  start: number;
  /** byte offset just past the last byte served (x-burrow-log-end) */
  end: number;
  /** which upstream answered (x-burrow-log-source) */
  source: string | null;
  responseMeta: BurrowHeaders;
}

/**
 * Read one byte window as text. `tail` and `offset` are mutually exclusive on the wire; the caller decides which.
 * The window the server actually served is returned verbatim — the pager and the follow resume both key off it.
 */
export async function fetchLogWindow(
  containerId: string,
  name: string,
  req: LogWindowRequest,
  signal?: AbortSignal,
): Promise<LogWindowResult> {
  const path = logFilePath(containerId, name);
  const query: Query = { ...hintQuery(req.hints) };
  if (req.tail != null) query.tail = req.tail;
  else if (req.offset != null || req.length != null) {
    if (req.offset != null) query.offset = req.offset;
    if (req.length != null) query.length = req.length;
  }
  const url = `${API_BASE}/${path}${canonicalQuery(query)}`;
  const signals = [AbortSignal.timeout(30_000)];
  if (signal) signals.push(signal);
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: "text/plain" }, signal: AbortSignal.any(signals), credentials: "same-origin" });
  } catch (e) {
    if (signal?.aborted) throw new ApiError("Request cancelled", "abort", null);
    const timedOut = e instanceof DOMException && e.name === "TimeoutError";
    const err = new ApiError(
      timedOut ? `No response from ${url} within 30s` : `Cannot reach Burrow at ${url}`,
      timedOut ? "timeout" : "network",
      null,
      null,
      null,
      "The log read is a byte range from the NodeManager/JobHistory; a slow or dead upstream stalls here.",
    );
    recordFailure(err.message);
    throw err;
  }
  const responseMeta = parseBurrowHeaders(res.headers);
  if (!res.ok) {
    if (res.status !== 404) recordFailure(`HTTP ${res.status} from ${url}`);
    const text = await res.text().catch(() => "");
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text || null;
    }
    const e = (body as { error?: { code?: string; message?: string; hint?: string; upstream?: { url: string; status?: number } } } | null)
      ?.error;
    throw new ApiError(
      e?.message ?? `HTTP ${res.status} from ${url}`,
      "http",
      res.status,
      e?.code ?? null,
      e?.upstream ?? null,
      e?.hint ?? null,
      responseMeta,
      body,
    );
  }
  recordSuccess(responseMeta);
  const num = (name: string, dflt: number): number => {
    const v = res.headers.get(name);
    if (v == null) return dflt;
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
  };
  const text = await res.text();
  const start = num("x-burrow-log-start", req.offset ?? 0);
  const end = num("x-burrow-log-end", start + text.length);
  return {
    text,
    size: num("x-burrow-log-size", end),
    start,
    end,
    source: res.headers.get("x-burrow-log-source"),
    responseMeta,
  };
}

/** Same-origin download of the whole file (the browser streams it; nothing is buffered in JS). */
export function logFileHref(containerId: string, name: string, hints?: LogHints): string {
  return `${API_BASE}/${logFilePath(containerId, name)}${canonicalQuery(hintQuery(hints))}`;
}

/**
 * Fetch the whole file for download. The read endpoint caps one request at 8 MiB, so a larger log is fetched as a
 * sequence of byte ranges and stitched into one Blob — the same endpoint, no special-casing, and no silent truncation.
 * `size` is the file size the viewer already knows (0 = unknown, discovered from the first response).
 */
export async function downloadLogFile(
  containerId: string,
  name: string,
  size: number,
  hints?: LogHints,
  onProgress?: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  const chunks: string[] = [];
  let offset = 0;
  let total = size;
  for (;;) {
    const w = await fetchLogWindow(containerId, name, { offset, length: LOG_MAX_BYTES, hints }, signal);
    total = w.size;
    chunks.push(w.text);
    const next = Math.max(w.end, offset + w.text.length);
    onProgress?.(next, total);
    if (next <= offset || (total > 0 && next >= total)) break;
    offset = next;
  }
  return new Blob(chunks, { type: "text/plain;charset=utf-8" });
}

/** SSE follow URL; `offset` resumes from the last byte the viewer holds. */
export function logStreamUrl(containerId: string, name: string, hints: LogHints | undefined, offset: number): string {
  const query: Query = { ...hintQuery(hints), offset };
  return `${API_BASE}/${logStreamPath(containerId, name)}${canonicalQuery(query)}`;
}

/** True only when Burrow itself lacks the route; an upstream 404 may simply mean the log file is gone. */
export function isLogEndpointMissing(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && error.upstream === null && error.responseMeta?.upstream == null;
}

export const lq = {
  /** The container's log-file directory. */
  files: (containerId: string, hints?: LogHints) =>
    queryOptions({
      queryKey: ["logs", "files", containerId, hints ?? {}],
      queryFn: ({ signal }) => apiGet(logFilesPath(containerId), { schema: LogFilesResponseSchema, signal, query: hintQuery(hints) }),
      ...adaptive("slow", { topic: `logs/containers/${containerId}${canonicalQuery(hintQuery(hints))}` }),
    }),
};
