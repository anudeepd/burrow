/**
 * Dev mock for `/api/system`, Burrow's own runtime contract.
 *
 * Counts tick with wall-clock time so a page left open shows live traffic; cache fields are deterministic. The
 * endpoint is a backend-synthesized snapshot with no upstream, so it answers `x-burrow-cache: bypass`.
 */
import { jsonResponse } from "./mock-data/instance.ts";

const STARTED_AT = Date.now() - 92 * 60_000;
const BOOT_RSS = 96 * 1024 * 1024;
const BYTES_PER_MIB = 1024 * 1024;

function systemResponse(): Record<string, unknown> {
  const now = Date.now();
  const uptimeSeconds = Math.round((now - STARTED_AT) / 1000);
  const history = Array.from({ length: 15 }, (_, index) => {
    const minute = index - 14;
    return {
      atMs: now + minute * 60_000,
      requests: 22 + ((index * 7) % 19),
      errors: index === 11 ? 2 : index === 6 ? 1 : 0,
    };
  });
  const memoryHistory = Array.from({ length: 15 * 12 }, (_, index) => {
    const atMs = now - (15 * 12 - 1 - index) * 5_000;
    return { atMs, rssBytes: Math.round((BOOT_RSS + index * 1.15 * BYTES_PER_MIB) / BYTES_PER_MIB) * BYTES_PER_MIB };
  });

  return {
    process: {
      version: "0.2.3",
      pid: 4242,
      uptimeSeconds,
      startedAtMs: STARTED_AT,
      memory: {
        rssBytes: memoryHistory[memoryHistory.length - 1]!.rssBytes,
        peakRssBytes: memoryHistory[memoryHistory.length - 1]!.rssBytes + 18 * BYTES_PER_MIB,
        virtualBytes: 1_940 * BYTES_PER_MIB,
      },
    },
    clients: { active: 2, streams: 1, windowSeconds: 300 },
    requests: {
      total: 1234 + Math.round(uptimeSeconds / 90),
      inFlight: 1,
      byStatus: { "1xx": 0, "2xx": 1200, "3xx": 10, "4xx": 20, "5xx": 4 },
      errorsLast15m: 2,
      p50Ms: 3,
      p95Ms: 21,
      history,
    },
    memoryHistory,
    recentErrors: [
      {
        atMs: now - 4 * 60_000,
        method: "GET",
        path: "/api/yarn/apps",
        status: 502,
        durationMs: 12,
      },
    ],
    cache: { entries: 12, bytes: 123_456, hits: 100, misses: 5, coalesced: 3, stale: 1, bypass: 0, upstreamFetches: 9 },
    appsIndex: { apps: 3412 },
  };
}

export function handleSystem(req: Request, path: string): Response | null {
  if (path !== "system") return null;
  const response = jsonResponse(systemResponse(), {}, req);
  response.headers.set("x-burrow-cache", "bypass");
  return response;
}
