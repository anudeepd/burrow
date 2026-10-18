/**
 * Dev mock for the Overview's data sources, backed by the same ticking cluster as the rest of the mock API.
 *
 * This keeps the overview cards and their app, node and queue links on the same simulated dataset. A small captured
 * scheduler-overview payload supplies legacy RM-only fields; the activity counters are refreshed from the simulator.
 *
 * `web/dev/mock-api.ts` (owned by the web-foundation slice) calls `handleOverview` before anything else and falls
 * through on `null`. `/api/meta` is deliberately NOT handled here — the shell's own mock owns it.
 */
import { readFile } from "node:fs/promises";
import { appsResponse, clusterInfoResponse, metricsResponse, nodesResponse } from "./mock-data/rm.ts";
import { getCluster, jsonResponse } from "./mock-data/instance.ts";
import { schedulerResponse } from "./mock-data/scheduler.ts";

const FIXTURE_DIR = new URL("../../fixtures/rm/overview/", import.meta.url);

const cache = new Map<string, unknown>();

async function fixture<T = unknown>(name: string): Promise<T> {
  const hit = cache.get(name);
  if (hit !== undefined) return hit as T;
  const text = await readFile(new URL(name, FIXTURE_DIR), "utf8");
  const parsed = JSON.parse(text) as T;
  cache.set(name, parsed);
  return parsed;
}

const json = (body: unknown, req: Request): Response => jsonResponse(body, {}, req);

/**
 * Claim a request, or return `null` to let the shell's mock handle it.`req.url` may be absolute; the path is matched
 * after stripping a leading `/api/` (same convention as `dev/mock-api.ts`).
 */
export async function handleOverview(req: Request): Promise<Response | null> {
  const url = new URL(req.url, "http://127.0.0.1");
  const path = url.pathname.replace(/^\/api\//, "").replace(/^\//, "");

  switch (path) {
    case "yarn/info":
      return json(clusterInfoResponse(getCluster()), req);
    case "yarn/metrics":
      return json(metricsResponse(getCluster()), req);
    case "yarn/scheduler":
      // Allow the scheduler extension below to serve the requested fair/FIFO capture.
      if (process.env.BURROW_MOCK_SCHEDULER) return null;
      return json(schedulerResponse(getCluster()), req);
    case "yarn/scheduler-overview": {
      const cluster = getCluster();
      const captured = await fixture<Record<string, unknown>>("scheduler-overview.json");
      const metrics = metricsResponse(cluster).clusterMetrics;
      return json(
        {
          ...captured,
          schedulerBusy: String(metrics.rmSchedulerBusyPercent),
          rmDispatcherEventQueueSize: String(metrics.rmEventQueueSize),
          schedulerDispatcherEventQueueSize: String(metrics.schedulerEventQueueSize),
        },
        req,
      );
    }
    case "yarn/nodes": {
      return json(nodesResponse(getCluster(), url.searchParams), req);
    }
    case "yarn/apps": {
      // The bare list (no `states`) is the applications view's dataset and belongs to the shell's generated mock;
      // the generated router handles it with this same shared cluster.
      if (!url.searchParams.has("states")) return null;
      return json(appsResponse(getCluster(), url.searchParams), req);
    }
    default:
      // Anything else (including /api/meta and other domains) belongs to the shell's mock.
      return null;
  }
}
