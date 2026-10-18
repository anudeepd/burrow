/**
 * Same-origin fetch wrapper for the Burrow API (docs/contracts/api.md).
 *  - parses the error envelope AND Hadoop's RemoteException passthrough into one `ApiError`
 *  - captures x-burrow-* headers (cache state, upstream, age) and feeds the connection store
 *  - abort + timeout; `noCache` sends `Cache-Control: no-cache` (hard refresh / parity)
 *  - zod validation: loose by default (issues are logged + exposed, data still flows), strict in test mode (throws)
 */
import type { z } from "zod";
import { STRICT_SCHEMAS } from "./schemas/_base";
import { isParity } from "~/state/parity";
import { type BurrowHeaders, parseBurrowHeaders, recordFailure, recordSuccess } from "./connection";

export const API_BASE = "/api";

export type ErrorKind = "network" | "timeout" | "http" | "schema" | "abort";

export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    message: string,
    readonly kind: ErrorKind,
    readonly status: number | null,
    readonly code: string | null = null,
    readonly upstream: { url: string; status?: number } | null = null,
    readonly hint: string | null = null,
    readonly responseMeta: BurrowHeaders | null = null,
    readonly body: unknown = null,
  ) {
    super(message);
  }
  get isUnreachable(): boolean {
    return this.status === 502 || this.code === "upstream_unreachable" || this.kind === "network" || this.kind === "timeout";
  }
}

export type Query = Record<string, string | number | boolean | readonly string[] | null | undefined>;

/** Canonical query: params sorted by name, arrays comma-joined, empties dropped. Also the SSE topic suffix. */
export function canonicalQuery(q?: Query): string {
  if (!q) return "";
  const parts: string[] = [];
  for (const k of Object.keys(q).sort()) {
    const v = q[k];
    if (v == null || v === "") continue;
    const s = Array.isArray(v) ? v.join(",") : String(v);
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(s).replaceAll("%2C", ",")}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

/** `topic` for an API path: resource path without `/api/` incl. canonical query (contract §6). */
export function topicOf(path: string, q?: Query): string {
  return `${path}${canonicalQuery(q)}`;
}

export interface FetchOptions<S extends z.ZodType | undefined = undefined> {
  query?: Query;
  signal?: AbortSignal;
  timeoutMs?: number;
  noCache?: boolean;
  schema?: S;
}

export interface ApiResult<T> {
  data: T;
  responseMeta: BurrowHeaders;
}

declare global {
  interface Window {
    __BURROW_SCHEMA_ISSUES__?: { path: string; issues: unknown }[];
  }
}

async function request(
  path: string,
  opts: FetchOptions<z.ZodType | undefined>,
  accept: string,
): Promise<{ res: Response; responseMeta: BurrowHeaders; url: string }> {
  const url = `${API_BASE}/${path}${canonicalQuery(opts.query)}`;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
  if (opts.signal) signals.push(opts.signal);
  const signal = AbortSignal.any(signals);
  const headers: Record<string, string> = { Accept: accept };
  if (opts.noCache || isParity()) headers["Cache-Control"] = "no-cache";
  let res: Response;
  try {
    res = await fetch(url, { headers, signal, credentials: "same-origin" });
  } catch (e) {
    if (opts.signal?.aborted) throw new ApiError("Request cancelled", "abort", null);
    const timedOut = e instanceof DOMException && e.name === "TimeoutError";
    const err = new ApiError(
      timedOut ? `No response from ${url} within ${Math.round(timeoutMs / 1000)}s` : `Cannot reach Burrow at ${url}`,
      timedOut ? "timeout" : "network",
      null,
      null,
      null,
      timedOut ? "Burrow or the ResourceManager is slow to answer." : "Is the Burrow server still running?",
    );
    recordFailure(err.message);
    throw err;
  }
  const responseMeta = parseBurrowHeaders(res.headers);
  if (!res.ok) {
    const err = await toApiError(res, responseMeta, url);
    // a 404 for one resource is not a connectivity problem; everything else counts against the connection
    if (res.status !== 404) recordFailure(err.message);
    throw err;
  }
  recordSuccess(responseMeta);
  return { res, responseMeta, url };
}

async function toApiError(res: Response, responseMeta: BurrowHeaders, url: string): Promise<ApiError> {
  let body: unknown = null;
  const text = await res.text().catch(() => "");
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text || null;
  }
  const b = body as {
    error?: { code?: string; message?: string; upstream?: { url: string; status?: number }; hint?: string };
    RemoteException?: { exception?: string; message?: string; javaClassName?: string };
  } | null;
  if (b && typeof b === "object" && b.error) {
    return new ApiError(
      b.error.message ?? `HTTP ${res.status}`,
      "http",
      res.status,
      b.error.code ?? null,
      b.error.upstream ?? null,
      b.error.hint ?? null,
      responseMeta,
      body,
    );
  }
  if (b && typeof b === "object" && b.RemoteException) {
    const r = b.RemoteException;
    return new ApiError(
      r.message ?? r.exception ?? `HTTP ${res.status}`,
      "http",
      res.status,
      r.exception ?? "RemoteException",
      { url, status: res.status },
      null,
      responseMeta,
      body,
    );
  }
  return new ApiError(`HTTP ${res.status} from ${url}`, "http", res.status, null, null, null, responseMeta, body);
}

function validate<S extends z.ZodType>(schema: S, data: unknown, path: string): z.output<S> {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const issues = r.error.issues.slice(0, 12).map((i) => ({ path: i.path.join("."), code: i.code, message: i.message }));
  if (STRICT_SCHEMAS) {
    throw new ApiError(`Response from ${path} does not match the schema`, "schema", null, "schema_mismatch", null, null, null, issues);
  }
  console.warn(`[schema] ${path}`, issues);
  if (!window.__BURROW_SCHEMA_ISSUES__) window.__BURROW_SCHEMA_ISSUES__ = [];
  window.__BURROW_SCHEMA_ISSUES__.push({ path, issues });
  return data as z.output<S>;
}

export async function apiGetWithMeta<S extends z.ZodType>(
  path: string,
  opts: FetchOptions<S> & { schema: S },
): Promise<ApiResult<z.output<S>>>;
export async function apiGetWithMeta(path: string, opts?: FetchOptions): Promise<ApiResult<unknown>>;
export async function apiGetWithMeta(path: string, opts: FetchOptions<z.ZodType | undefined> = {}): Promise<ApiResult<unknown>> {
  const { res, responseMeta } = await request(path, opts, "application/json");
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ApiError(`Response from ${path} is not valid JSON`, "schema", res.status, "bad_json", null, null, responseMeta);
  }
  return { data: opts.schema ? validate(opts.schema, json, path) : json, responseMeta };
}

export async function apiGet<S extends z.ZodType>(path: string, opts: FetchOptions<S> & { schema: S }): Promise<z.output<S>>;
export async function apiGet<T = unknown>(path: string, opts?: FetchOptions): Promise<T>;
export async function apiGet(path: string, opts: FetchOptions<z.ZodType | undefined> = {}): Promise<unknown> {
  return (await apiGetWithMeta(path, opts as FetchOptions)).data;
}

/** text/plain endpoints (stacks, daemon logs). */
export async function apiText(path: string, opts: FetchOptions = {}): Promise<ApiResult<string>> {
  const { res, responseMeta } = await request(path, opts, "text/plain");
  return { data: await res.text(), responseMeta };
}
