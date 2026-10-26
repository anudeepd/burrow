/**
 * Dev mock of the burrow API (docs/contracts/api.md) + a same-origin dev server.
 *
 *   bun run dev:mock                      # mock API + vite dev, everything on http://127.0.0.1:5273
 *   BURROW_WEB_TARGET=dist bun run dev:mock   # mock API + built dist/client (used by Playwright)
 *
 * Feature slices extend the router by dropping `web/dev/mock-<slice>.ts` next to this file, exporting
 * `handle<Slice>(req: Request, path: string, url: URL): Promise<Response|null> | Response | null` where `path` is the
 * request path with a leading `/api/` stripped (`yarn/apps`). Returning `null` falls through to the next handler; the
 * first non-null response wins. Extensions are called BEFORE the generated router below.
 *
 * The mock is deliberately faithful to the wire format: YARN's wrapped roots (`{"apps":{"app":[…]}}`), Jersey "mapped"
 * notation where the DAOs are not JAXB-registered, `RemoteException` bodies, weak ETags + 304, `x-burrow-*` headers.
 * It is a REPLAY source for development: the Rust backend is the real thing.
 */
import { getCluster, errorResponse, jsonResponse, metaResponse, textResponse } from "./mock-data/instance.ts";
import { APP_ACTIVITIES, resourceProfilesResponse, resourceTypesResponse } from "./mock-data/extra.ts";
import {
  appPriorityResponse,
  appQueueResponse,
  appResponse,
  appStateResponse,
  appStatisticsResponse,
  appTimeoutsResponse,
  appsResponse,
  attemptsResponse,
  clusterInfoResponse,
  containerByIdResponse,
  containerResponse,
  containersResponse,
  labelMappingsResponse,
  metricsResponse,
  nodeLabelsResponse,
  nodeResponse,
  nodesResponse,
  nodeToLabelsResponse,
  RmError,
  schedulerActivitiesResponse,
} from "./mock-data/rm.ts";
import { schedulerConfResponse, schedulerResponse } from "./mock-data/scheduler.ts";

export type MockHandler = (req: Request, path: string, url: URL) => Promise<Response | null> | Response | null;

/**
 * Per-slice handler modules, loaded if present: a slice that has not landed yet must not break the mock, and the
 * specifier is genuinely runtime-selected (peers add files independently of this file), so a static import cannot work.
 */
const EXTENSION_MODULES = [
  "./mock-overview.ts",
  "./mock-nodes.ts",
  "./mock-tools.ts",
  "./mock-scheduler.ts",
  "./mock-spark.ts",
  "./mock-app.ts",
  "./mock-logs.ts",
  "./mock-dag.ts",
];

let extensions: MockHandler[] | null = null;

async function loadExtensions(): Promise<MockHandler[]> {
  const out: MockHandler[] = [];
  for (const spec of EXTENSION_MODULES) {
    try {
      const mod = (await import(spec)) as Record<string, unknown>;
      for (const [name, value] of Object.entries(mod)) {
        if (typeof value === "function" && /^handle[A-Z]/.test(name)) out.push(value as MockHandler);
      }
    } catch (e) {
      const msg = String(e);
      if (!msg.includes("Cannot find module") && !msg.includes("Cannot resolve")) console.warn(`[mock] failed to load ${spec}:`, e);
    }
  }
  return out;
}

/** RM's RemoteException is passed through with the upstream status unchanged (contract §1). */
function rmErrorResponse(e: RmError): Response {
  return new Response(JSON.stringify(e.body), {
    status: e.status,
    headers: { "content-type": "application/json; charset=utf-8", "x-burrow-api": "1", "x-burrow-cache": "miss" },
  });
}

/** `{id}` segments are validated by the real backend; the mock gets the same guard so bad URLs fail loudly. */
const ID = /^[A-Za-z0-9_:.-]+$/;

/** `decodeURIComponent` that leaves malformed escapes alone (mirrors the backend's lenient percent-decoder). */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export async function handleApi(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/?/, "");
  if (req.method !== "GET" && req.method !== "HEAD") {
    return errorResponse("bad_request", `${req.method} is not supported (read-only product)`, 405);
  }

  if (!extensions) extensions = await loadExtensions();
  for (const h of extensions) {
    const res = await h(req, path, url);
    if (res) return res;
  }

  const c = getCluster();
  const q = url.searchParams;
  const seg = path.split("/");

  try {
    // ── synthesized ────────────────────────────────────────────────────────────────────────────────────────
    if (path === "healthz") return textResponse("ok");
    if (path === "meta") return jsonResponse(metaResponse(), {}, req);
    if (path === "events") return sseResponse(url.search);

    // ── ResourceManager passthrough ────────────────────────────────────────────────────────────────────────
    if (seg[0] === "yarn") {
      const rest = seg.slice(1).join("/");
      switch (rest) {
        case "info":
          return jsonResponse(clusterInfoResponse(c), {}, req);
        case "metrics":
          return jsonResponse(metricsResponse(c), {}, req);
        case "scheduler":
          return jsonResponse(schedulerResponse(c), {}, req);
        case "scheduler/activities":
          return jsonResponse(schedulerActivitiesResponse(c), {}, req);
        case "scheduler-conf":
          return jsonResponse(schedulerConfResponse(), {}, req);
        case "apps":
          return jsonResponse(appsResponse(c, q), {}, req);
        case "appstatistics":
          return jsonResponse(appStatisticsResponse(c, q), {}, req);
        case "nodes":
          return jsonResponse(nodesResponse(c, q), {}, req);
        case "get-node-labels":
          return jsonResponse(nodeLabelsResponse(c), {}, req);
        case "get-node-to-labels":
          return jsonResponse(nodeToLabelsResponse(c), {}, req);
        case "label-mappings":
          return jsonResponse(labelMappingsResponse(c), {}, req);
        case "resource-types":
          return jsonResponse(resourceTypesResponse(), {}, req);
        case "resource-profiles":
          return jsonResponse(resourceProfilesResponse(), {}, req);
      }
      if (seg[1] === "apps" && seg[2] && seg[2].startsWith("application") && ID.test(seg[2])) {
        const id = decodeURIComponent(seg[2]);
        if (seg.length === 3) return jsonResponse(appResponse(c, id, q), {}, req);
        const sub = seg[3];
        if (sub === "appattempts" && seg.length === 4) return jsonResponse(attemptsResponse(c, id), {}, req);
        if (sub === "appattempts" && seg[5] === "containers") {
          const aid = decodeURIComponent(seg[4] ?? "");
          if (seg.length === 6) return jsonResponse(containersResponse(c, id, aid), {}, req);
          if (seg.length === 7) return jsonResponse(containerResponse(c, id, aid, decodeURIComponent(seg[6] ?? "")), {}, req);
        }
        if (sub === "timeout" && seg.length === 5)
          return jsonResponse(appTimeoutsResponse(c, id, decodeURIComponent(seg[4] ?? "")), {}, req);
        if (seg.length === 4) {
          switch (sub) {
            case "state":
              return jsonResponse(appStateResponse(c, id), {}, req);
            case "priority":
              return jsonResponse(appPriorityResponse(c, id), {}, req);
            case "queue":
              return jsonResponse(appQueueResponse(c, id), {}, req);
            case "timeouts":
              return jsonResponse(appTimeoutsResponse(c, id), {}, req);
            case "statistics":
              return jsonResponse(appStatisticsResponse(c, q), {}, req);
            case "appactivities":
              return jsonResponse(APP_ACTIVITIES(c, id), {}, req);
          }
        }
      }
      if (seg[1] === "nodes" && seg[2] && seg.length === 3) return jsonResponse(nodeResponse(c, decodeURIComponent(seg[2])), {}, req);
      if (seg[1] === "containers" && seg[2] && seg.length === 3)
        return jsonResponse(containerByIdResponse(c, decodeURIComponent(seg[2])), {}, req);
      return errorResponse("not_found", `No RM REST resource at /ws/v1/cluster/${rest}`, 404);
    }

    // ── daemon pages / spark / logs: owned by feature slices (handlers above) ───────────────────────────────
    if (seg[0] === "rm" || seg[0] === "nm") {
      return errorResponse("not_found", `No RM daemon page handler registered for /${path}`, 404, {
        hint: "this path is served by the Rust backend; add web/dev/mock-tools.ts to mock it",
      });
    }
    if (seg[0] === "spark") {
      return errorResponse("unavailable", `Spark data is not mocked for /${path}`, 503, {
        hint: "add web/dev/mock-spark.ts, or run against a real cluster",
      });
    }
    if (seg[0] === "logs") return errorResponse("not_found", `Container logs are not mocked for /${path}`, 404);
    return errorResponse("not_found", `Unknown API resource /api/${path}`, 404);
  } catch (e) {
    if (e instanceof RmError) return rmErrorResponse(e);
    console.error("[mock] handler error", e);
    return errorResponse("internal", e instanceof Error ? e.message : "mock handler failed", 500);
  }
}

/**
 * SSE hub stand-in (contract §6): `hello`, then `invalidate` when a subscribed topic's version changes. Topic
 * versions are coarse (cluster version + tick), which is all the SPA needs to trigger a refetch.
 *
 * Topics are split on the **raw** value: a literal comma separates topics while `%2C` belongs to a topic's query (the
 * SPA encodes each topic, not the joined list). Decoding first would tear `states=NEW,NEW_SAVING,…` apart.
 */
function sseResponse(search: string): Response {
  const raw =
    search
      .replace(/^\?/, "")
      .split("&")
      .find((p) => p.startsWith("topics="))
      ?.slice("topics=".length) ?? "";
  const topics = raw
    .split(",")
    .map((t) => safeDecode(t.trim()))
    .filter(Boolean)
    .slice(0, 64);
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown, comment = false) => {
        controller.enqueue(encoder.encode(comment ? `: ${event}\n\n` : `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send("hello", { serverTime: Date.now(), topics });
      const versions = new Map<string, string>();
      const versionOf = () => `${getCluster().version}.${getCluster().tickCount}`;
      for (const t of topics) versions.set(t, versionOf());
      timer = setInterval(() => {
        const cluster = getCluster();
        for (const t of topics) {
          const v = versionOf();
          if (versions.get(t) === v) continue;
          versions.set(t, v);
          send("invalidate", { topic: t, etag: `W/"mock-${cluster.version}"`, at: Date.now() });
        }
        send("heartbeat", null, true);
      }, 1000);
    },
    cancel() {
      clearInterval(timer);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-burrow-api": "1",
    },
  });
}

// ── server ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface ServeOptions {
  port: number;
  /** directory of the built SPA; when set, non-/api requests are served from it (SPA fallback to _shell.html) */
  webRoot?: string;
  /** when set, non-/api requests are proxied here (vite dev server) */
  proxyTo?: string;
}

const MIME: Record<string, string> = {
  css: "text/css; charset=utf-8",
  html: "text/html; charset=utf-8",
  ico: "image/x-icon",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  woff: "font/woff",
  woff2: "font/woff2",
};

/** `_shell.html` gives fresh HTML + immutable hashed assets, matching the Rust static layer (contract §7). */
async function serveStatic(root: string, url: URL): Promise<Response> {
  const rel = url.pathname.replace(/^\/+/, "");
  const candidate = rel ? Bun.file(`${root}/${rel}`) : null;
  if (candidate && (await candidate.exists()) && candidate.size > 0) {
    const headers: Record<string, string> = {
      "content-type": MIME[rel.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream",
    };
    if (rel.startsWith("assets/")) headers["cache-control"] = "public, max-age=31536000, immutable";
    return new Response(candidate, { headers });
  }
  const shell = Bun.file(`${root}/_shell.html`);
  if (await shell.exists()) {
    return new Response(shell, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
  }
  return new Response("burrow: no web build found — run `bun run build`", { status: 404 });
}

export function startMockServer(opts: ServeOptions) {
  return Bun.serve({
    port: opts.port,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/api/")) return handleApi(req);
      if (opts.webRoot) return serveStatic(opts.webRoot, url);
      if (opts.proxyTo) {
        const target = new URL(url.pathname + url.search, opts.proxyTo);
        const init: RequestInit = { method: req.method, headers: req.headers, redirect: "manual" };
        if (req.method !== "GET" && req.method !== "HEAD") init.body = req.body;
        return fetch(target, init);
      }
      return new Response("burrow mock: pass webRoot or proxyTo", { status: 500 });
    },
  });
}

if (import.meta.main) {
  const port = Number(process.env.MOCK_PORT ?? 5273);
  const dist = process.env.BURROW_WEB_TARGET === "dist";
  let vite: ReturnType<typeof Bun.spawn> | null = null;
  if (!dist) {
    console.log("[mock] starting vite dev on :5173");
    vite = Bun.spawn(["bunx", "vite", "dev", "--port", "5173", "--strictPort"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, BURROW_DEV_MOCK: "1", VITE_API_TARGET: `http://127.0.0.1:${port}` },
      stdout: "inherit",
      stderr: "inherit",
    });
  }
  const webDir = process.env.BURROW_WEB_ROOT ?? new URL("../dist/client", import.meta.url).pathname;
  const server = startMockServer(dist ? { port, webRoot: webDir } : { port, proxyTo: "http://127.0.0.1:5173" });
  console.log(`[mock] ${getCluster().apps.length} mock apps · API + web on http://127.0.0.1:${server.port}`);
  const shutdown = () => {
    server.stop(true);
    vite?.kill();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
