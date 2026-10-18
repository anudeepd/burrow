/**
 * queryOptions factories — ONE per contract route (docs/contracts/api.md §2–§3). Pages/loaders only ever use these.
 * Every factory carries `meta.topic` (the SSE topic = API path without /api/ + canonical query) so the events client can map
 * `invalidate` pushes to queries, and an adaptive refetch policy (see refetch.ts).
 */
import { queryOptions } from "@tanstack/react-query";
import { type Query, apiGet, apiText, topicOf } from "./client";
import { adaptive } from "./refetch";
import {
  type App,
  AppActivitiesSchema,
  AppAttemptDetailResponseSchema,
  AppAttemptsResponseSchema,
  AppPriorityResponseSchema,
  AppQueueResponseSchema,
  AppResponseSchema,
  AppsResponseSchema,
  AppStateResponseSchema,
  AppStatisticsResponseSchema,
  AppTimeoutResponseSchema,
  AppTimeoutsResponseSchema,
  ClusterInfoResponseSchema,
  ClusterMetricsResponseSchema,
  ConfResponseSchema,
  ContainerResponseSchema,
  ContainersResponseSchema,
  JmxResponseSchema,
  LabelMappingsResponseSchema,
  MetaSchema,
  NodeLabelsResponseSchema,
  NodeResponseSchema,
  NodesResponseSchema,
  NodeToLabelsResponseSchema,
  ResourceProfilesSchema,
  ResourceTypesSchema,
  RmLogsListingSchema,
  SchedulerActivitiesSchema,
  SchedulerConfSchema,
  SchedulerResponseSchema,
} from "./schemas";

const asArray = <T>(x: T | T[] | null | undefined): T[] => (Array.isArray(x) ? x : x == null ? [] : [x]);
// ResourceManager IDs may contain a literal colon (notably node host:port IDs), which the backend route allowlist matches.
const enc = (value: string) => encodeURIComponent(value).replaceAll("%3A", ":");

function rm<S extends import("zod").ZodType>(
  key: readonly unknown[],
  path: string,
  schema: S,
  kind: "live" | "slow" | "static",
  query?: Query,
) {
  return queryOptions({
    queryKey: key,
    queryFn: ({ signal }) => apiGet(path, { schema, signal, query }),
    ...adaptive(kind, { topic: topicOf(path, query) }),
  });
}

/** The apps list is fetched whole (all states) and filtered in the browser: one cache entry, exact tab counts, no comma-in-topic. */
export const APPS_QUERY: Query = { deSelects: "resourceRequests" };

export const q = {
  // ── synthesized ──────────────────────────────────────────────────────────────────────────────────────────────
  meta: () =>
    queryOptions({
      queryKey: ["meta"],
      queryFn: ({ signal }) => apiGet("meta", { schema: MetaSchema, signal }),
      ...adaptive("slow"),
    }),

  // ── RM passthrough: /api/yarn/* ───────────────────────────────────────────────────────────────────────────
  info: () => ({
    ...rm(["yarn", "info"], "yarn/info", ClusterInfoResponseSchema, "slow"),
    select: (r: { clusterInfo: unknown }) => r.clusterInfo as import("./schemas").ClusterInfo,
  }),
  metrics: () => ({
    ...rm(["yarn", "metrics"], "yarn/metrics", ClusterMetricsResponseSchema, "live"),
    select: (r: { clusterMetrics: unknown }) => r.clusterMetrics as import("./schemas").ClusterMetrics,
  }),
  scheduler: () => rm(["yarn", "scheduler"], "yarn/scheduler", SchedulerResponseSchema, "live"),
  schedulerActivities: (query?: Query) =>
    rm(["yarn", "scheduler", "activities", query ?? {}], "yarn/scheduler/activities", SchedulerActivitiesSchema, "live", query),
  schedulerConf: () => rm(["yarn", "scheduler-conf"], "yarn/scheduler-conf", SchedulerConfSchema, "static"),

  apps: () => ({
    ...rm(["yarn", "apps"], "yarn/apps", AppsResponseSchema, "live", APPS_QUERY),
    select: (r: { apps?: { app?: App | App[] | null } | null }): App[] => asArray(r.apps?.app),
  }),
  /** server-side filtered list, for slices that need a narrow query (e.g. a queue's running apps) */
  appsFiltered: (query: Query) => ({
    ...rm(["yarn", "apps", "filtered", query], "yarn/apps", AppsResponseSchema, "live", { deSelects: "resourceRequests", ...query }),
    select: (r: { apps?: { app?: App | App[] | null } | null }): App[] => asArray(r.apps?.app),
  }),
  app: (appId: string) => ({
    ...rm(["yarn", "apps", appId], `yarn/apps/${enc(appId)}`, AppResponseSchema, "live"),
    select: (r: { app: App }) => r.app,
  }),
  appAttempts: (appId: string) =>
    rm(["yarn", "apps", appId, "appattempts"], `yarn/apps/${enc(appId)}/appattempts`, AppAttemptsResponseSchema, "live"),
  /** the single-attempt resource: AM host/rpcPort, tracking URL, diagnostics (absent from the list entries) */
  appAttemptDetail: (appId: string, attemptId: string) =>
    rm(
      ["yarn", "apps", appId, "appattempts", attemptId],
      `yarn/apps/${enc(appId)}/appattempts/${enc(attemptId)}`,
      AppAttemptDetailResponseSchema,
      "live",
    ),
  appContainers: (appId: string, attemptId: string) =>
    rm(
      ["yarn", "apps", appId, "appattempts", attemptId, "containers"],
      `yarn/apps/${enc(appId)}/appattempts/${enc(attemptId)}/containers`,
      ContainersResponseSchema,
      "live",
    ),
  appContainer: (appId: string, attemptId: string, containerId: string) =>
    rm(
      ["yarn", "apps", appId, "appattempts", attemptId, "containers", containerId],
      `yarn/apps/${enc(appId)}/appattempts/${enc(attemptId)}/containers/${enc(containerId)}`,
      ContainerResponseSchema,
      "live",
    ),
  appState: (appId: string) => rm(["yarn", "apps", appId, "state"], `yarn/apps/${enc(appId)}/state`, AppStateResponseSchema, "live"),
  appPriority: (appId: string) =>
    rm(["yarn", "apps", appId, "priority"], `yarn/apps/${enc(appId)}/priority`, AppPriorityResponseSchema, "slow"),
  appQueue: (appId: string) => rm(["yarn", "apps", appId, "queue"], `yarn/apps/${enc(appId)}/queue`, AppQueueResponseSchema, "slow"),
  appTimeout: (appId: string, type: string) =>
    rm(["yarn", "apps", appId, "timeouts", type], `yarn/apps/${enc(appId)}/timeouts/${enc(type)}`, AppTimeoutResponseSchema, "slow"),
  appTimeouts: (appId: string) =>
    rm(["yarn", "apps", appId, "timeouts"], `yarn/apps/${enc(appId)}/timeouts`, AppTimeoutsResponseSchema, "slow"),
  appActivities: (appId: string) =>
    rm(["yarn", "scheduler", "app-activities", appId], `yarn/scheduler/app-activities/${enc(appId)}`, AppActivitiesSchema, "live"),
  appStatisticsAll: (query?: Query) =>
    rm(["yarn", "appstatistics", query ?? {}], "yarn/appstatistics", AppStatisticsResponseSchema, "slow", query),

  nodes: (query?: Query) => rm(["yarn", "nodes", query ?? {}], "yarn/nodes", NodesResponseSchema, "live", query),
  node: (nodeId: string) => rm(["yarn", "nodes", nodeId], `yarn/nodes/${enc(nodeId)}`, NodeResponseSchema, "live"),
  nodeLabels: () => rm(["yarn", "get-node-labels"], "yarn/get-node-labels", NodeLabelsResponseSchema, "slow"),
  nodeToLabels: () => rm(["yarn", "get-node-to-labels"], "yarn/get-node-to-labels", NodeToLabelsResponseSchema, "slow"),
  labelMappings: () => rm(["yarn", "label-mappings"], "yarn/label-mappings", LabelMappingsResponseSchema, "slow"),
  resourceProfiles: () => rm(["yarn", "resource-profiles"], "yarn/resource-profiles", ResourceProfilesSchema, "static"),
  resourceTypes: () => rm(["yarn", "resource-types"], "yarn/resource-types", ResourceTypesSchema, "static"),
  /** `/yarn/containers/{id}` (only on RMs that expose it) */
  container: (containerId: string) =>
    rm(["yarn", "containers", containerId], `yarn/containers/${enc(containerId)}`, ContainerResponseSchema, "live"),

  // ── RM daemon pages: /api/rm/* ────────────────────────────────────────────────────────────────────────────
  rmConf: () => rm(["rm", "conf"], "rm/conf", ConfResponseSchema, "static", { format: "json" }),
  rmJmx: (qry?: string) => rm(["rm", "jmx", qry ?? ""], "rm/jmx", JmxResponseSchema, "slow", qry ? { qry } : undefined),
  rmStacks: () =>
    queryOptions({
      queryKey: ["rm", "stacks"],
      queryFn: async ({ signal }) => (await apiText("rm/stacks", { signal })).data,
      ...adaptive("static"),
    }),
  rmLogs: () => rm(["rm", "logs"], "rm/logs", RmLogsListingSchema, "static"),
  rmLogFile: (file: string, range?: { offset?: number; length?: number }) =>
    queryOptions({
      queryKey: ["rm", "logs", file, range ?? {}],
      queryFn: async ({ signal }) => (await apiText(`rm/logs/${enc(file)}`, { signal, query: range })).data,
      ...adaptive("static"),
    }),
  rmMetrics: () =>
    queryOptions({
      queryKey: ["rm", "metrics"],
      queryFn: ({ signal }) => apiGet("rm/metrics", { signal }),
      ...adaptive("slow", { topic: "rm/metrics" }),
    }),
};
