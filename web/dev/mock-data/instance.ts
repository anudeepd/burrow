/**
 * Shared dev-mock runtime: ONE ticking `MockCluster` for every mock handler, plus the small response helpers every
 * `dev/mock-*.ts` handler uses so the wire format matches docs/contracts/api.md (§1 common behaviour).
 *
 * Handlers live in `web/dev/mock-<slice>.ts` and export `handle<Slice>(req, path, url)`; `dev/mock-api.ts` calls them
 * before its own generic router. `path` is the request path with a leading `/api/` stripped (`yarn/apps`).
 */
import { MockCluster } from "./cluster.ts";

/** Env knobs (read once): MOCK_SEED, MOCK_APPS, MOCK_FROZEN, MOCK_NO_NEW_APPS. */
export const MOCK_SEED = Number(process.env.MOCK_SEED ?? 20261003);
export const MOCK_APPS = Number(process.env.MOCK_APPS ?? 4000);
export const MOCK_FROZEN = process.env.MOCK_FROZEN === "1";
export const MOCK_NO_NEW_APPS = process.env.MOCK_NO_NEW_APPS === "1";

let cluster: MockCluster | null = null;
let lastAdvance = Date.now();

/**
 * The shared cluster. Lazily advances simulated time so a page left open keeps showing progress WITHOUT a background
 * timer: each access ticks at most as many times as wall-clock seconds elapsed (capped at 3, so an idle tab does not
 * fast-forward the whole cluster on the next request).
 */
export function getCluster(): MockCluster {
  if (!cluster) cluster = new MockCluster({ seed: MOCK_SEED, apps: MOCK_APPS, frozen: MOCK_FROZEN, allowNewApps: !MOCK_NO_NEW_APPS });
  const now = Date.now();
  const seconds = MOCK_FROZEN ? 0 : Math.min(3, Math.floor((now - lastAdvance) / 1000));
  if (seconds > 0) {
    lastAdvance = now;
    for (let i = 0; i < seconds; i++) cluster.tick();
  }
  return cluster;
}

/** Reset for tests (deterministic re-seed). */
export function resetCluster(): MockCluster {
  cluster = null;
  lastAdvance = Date.now();
  return getCluster();
}

// ── wire helpers ────────────────────────────────────────────────────────────────────────────────────────────────

/** Headers contract §1 requires on every /api response. */
export const BURROW_HEADERS: Record<string, string> = {
  "x-burrow-api": "1",
  "x-burrow-cache": "miss",
};

const encoder = new TextEncoder();

/** FNV-1a over the serialised body: a stand-in for the backend's weak ETag (same semantics, different hash). */
function etagOf(body: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    h ^= body.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `W/"${(h >>> 0).toString(16)}-${body.length.toString(16)}"`;
}

export interface JsonOptions extends ResponseInit {
  /** wrapper key whose value is the payload, mirroring Hadoop's JAXB root element (`{"app":{…}}`) */
  headers?: HeadersInit;
}

/**
 * JSON response with the contract's ETag/304 behaviour: a matching `If-None-Match` returns 304 with an empty body.
 * `request` is optional; pass it to get 304s.
 */
export function jsonResponse(data: unknown, init: ResponseInit = {}, request?: Request): Response {
  const body = JSON.stringify(data);
  const etag = etagOf(body);
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(BURROW_HEADERS)) headers.set(k, v);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("etag", etag);
  headers.set("x-burrow-age", "0");
  if (request && request.headers.get("if-none-match") === etag) {
    headers.set("x-burrow-cache", "hit");
    return new Response(null, { status: 304, headers });
  }
  return new Response(init.status ? body : body, { status: init.status ?? 200, headers });
}

export function textResponse(text: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(BURROW_HEADERS)) headers.set(k, v);
  headers.set("content-type", "text/plain; charset=utf-8");
  headers.set("content-length", String(encoder.encode(text).length));
  return new Response(text, { status: init.status ?? 200, headers });
}

export type ErrorCode = "upstream_unreachable" | "upstream_status" | "not_found" | "bad_request" | "forbidden" | "unavailable" | "internal";

/** Error envelope from contract §1 (`{error:{code,message,upstream?,hint?}}`). */
export function errorResponse(
  code: ErrorCode,
  message: string,
  status: number,
  extra: { upstream?: { url: string; status?: number }; hint?: string; headers?: HeadersInit } = {},
): Response {
  return jsonResponse(
    { error: { code, message, ...(extra.upstream ? { upstream: extra.upstream } : {}), ...(extra.hint ? { hint: extra.hint } : {}) } },
    { status, headers: extra.headers },
  );
}

/** `/api/meta` (contract §2) built from the mock cluster + the env-configured service URLs. */
export function metaResponse(): unknown {
  const c = getCluster();
  const rmUrl = `http://${MOCK_RM_HOST}`;
  const services = {
    sparkHistory: { configured: true, url: `http://${MOCK_SHS_HOST}`, reachable: true },
    jobHistory: { configured: true, url: `http://${MOCK_JHS_HOST}`, reachable: true },
    timeline: { configured: false },
  };
  return {
    name: "burrow",
    version: "0.1.0-mock",
    now: c.opts.frozen ? c.now : Date.now(),
    readOnly: true,
    rm: {
      urls: [rmUrl],
      active: rmUrl,
      haState: "ACTIVE",
      hadoopVersion: "3.4.3",
      reachable: true,
    },
    services,
    features: { sparkLive: true, sparkHistory: true, aggregatedLogs: true, nodeLogs: true, events: true, kerberos: false },
    yarn: { logServerUrl: services.jobHistory.url, httpPolicy: "HTTP_ONLY", scheduler: "capacity" },
  };
}

/** RM/NM/SHS/JHS hostnames the generated app JSON links to (kept in one place). */
export const MOCK_RM_HOST = "rm1.mock.local:8088";
export const MOCK_JHS_HOST = "jhs.mock.local:19888";
export const MOCK_SHS_HOST = "shs.mock.local:18080";
