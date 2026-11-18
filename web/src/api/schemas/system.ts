import { z } from "zod";
import { num, obj } from "./_base";

/** `GET /api/system` — Burrow's own process, traffic and cache health (docs/contracts/api.md). */
export const SystemMemorySchema = obj({
  rssBytes: num.nullable(),
  peakRssBytes: num.nullable(),
  virtualBytes: num.nullable(),
});
export type SystemMemory = z.infer<typeof SystemMemorySchema>;

export const SystemProcessSchema = obj({
  version: z.string(),
  pid: num,
  uptimeSeconds: num,
  startedAtMs: num,
  memory: SystemMemorySchema,
});
export type SystemProcess = z.infer<typeof SystemProcessSchema>;

export const SystemClientsSchema = obj({
  active: num,
  streams: num,
  windowSeconds: num,
});
export type SystemClients = z.infer<typeof SystemClientsSchema>;

export const SystemRequestHistorySchema = obj({
  atMs: num,
  requests: num,
  errors: num,
});
export type SystemRequestHistory = z.infer<typeof SystemRequestHistorySchema>;

export const SystemRequestsSchema = obj({
  total: num,
  inFlight: num,
  byStatus: obj({
    "1xx": num,
    "2xx": num,
    "3xx": num,
    "4xx": num,
    "5xx": num,
  }),
  errorsLast15m: num,
  p50Ms: num,
  p95Ms: num,
  history: z.array(SystemRequestHistorySchema),
});
export type SystemRequests = z.infer<typeof SystemRequestsSchema>;

export const SystemMemoryHistorySchema = obj({
  atMs: num,
  rssBytes: num,
});
export type SystemMemoryHistory = z.infer<typeof SystemMemoryHistorySchema>;

export const SystemRecentErrorSchema = obj({
  atMs: num,
  method: z.string(),
  path: z.string(),
  status: num,
  durationMs: num,
});
export type SystemRecentError = z.infer<typeof SystemRecentErrorSchema>;

export const SystemCacheSchema = obj({
  entries: num,
  bytes: num,
  hits: num,
  misses: num,
  coalesced: num,
  stale: num,
  bypass: num,
  upstreamFetches: num,
});
export type SystemCache = z.infer<typeof SystemCacheSchema>;

export const SystemAppsIndexSchema = obj({
  /** Rows in the complete applications snapshot; null when no snapshot is held. */
  apps: num.nullable(),
});
export type SystemAppsIndex = z.infer<typeof SystemAppsIndexSchema>;

export const SystemSchema = obj({
  process: SystemProcessSchema,
  clients: SystemClientsSchema,
  requests: SystemRequestsSchema,
  memoryHistory: z.array(SystemMemoryHistorySchema),
  recentErrors: z.array(SystemRecentErrorSchema),
  cache: SystemCacheSchema,
  appsIndex: SystemAppsIndexSchema,
});
export type System = z.infer<typeof SystemSchema>;
