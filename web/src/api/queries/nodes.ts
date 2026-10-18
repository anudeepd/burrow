/**
 * Query factories for the Nodes / Node-labels domain (owned by the FE-NodesTools slice).
 *
 * Keys deliberately match the foundation factories in `api/queries.ts` (`["yarn","nodes",query]`, `["yarn","get-node-labels"]`, …)
 * so a route using either factory shares one cache entry. Factories here add the `select` the views want plus the NM
 * passthrough (`/api/nm/{host:port}/…`, contract §3) and the NM shapes (which are NOT the RM shapes — see `NmContainerSchema`).
 */
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { type Query, apiGet, topicOf } from "../client";
import { adaptive } from "../refetch";
import { num, obj } from "../schemas/_base";
import { boolish, list } from "../schemas/_lenient";
import type { Node, NodeLabel } from "../schemas";
import {
  LabelMappingsResponseSchema,
  NodeLabelsResponseSchema,
  NodeResponseSchema,
  NodeToLabelsResponseSchema,
  NodesResponseSchema,
  selectLabelMappings,
  selectNodeLabels,
  selectNodeToLabels,
} from "../schemas";

// Hadoop node IDs and NodeManager authorities are host:port path segments; keep the valid colon literal so the
// backend's route allowlist can match the same ID the ResourceManager reports.
const enc = (value: string) => encodeURIComponent(value).replaceAll("%3A", ":");
const asArray = <T>(x: T | T[] | null | undefined): T[] => (Array.isArray(x) ? x : x == null ? [] : [x]);

function rm<S extends z.ZodType>(key: readonly unknown[], path: string, schema: S, kind: "live" | "slow" | "static", query?: Query) {
  return queryOptions({
    queryKey: key,
    queryFn: ({ signal }) => apiGet(path, { schema, signal, query }),
    ...adaptive(kind, { topic: topicOf(path, query) }),
  });
}

// ── NM (NodeManager) shapes — `org.apache.hadoop.yarn.server.nodemanager.webapp.dao.*` ──────────────────────────────
/**
 * NM `ContainerInfo` (`/ws/v1/node/containers`) — **JAXB FIELD access**, so the JSON keys are the *field* names
 * (`totalMemoryNeededMB`, `totalVCoresNeeded`, `containerLogsLink`), not the getters (`getMemoryNeeded`, `getLogLink`).
 * Verified against a live NM 3.4.3 payload (`fixtures/rm/nodes/nm-127.0.0.4_8042-containers.json`).
 * Different from the RM's `ContainerInfo`, which is why it gets its own schema.
 */
export const NmContainerSchema = obj({
  id: z.string(),
  nodeId: z.string(),
  state: z.string(),
  exitCode: num,
  exitStatus: z.string().optional(),
  diagnostics: z.string().optional(),
  user: z.string(),
  totalMemoryNeededMB: num,
  totalVCoresNeeded: num,
  executionType: z.string().optional(),
  containerLogsLink: z.string().optional(),
  containerLogsShortLink: z.string().optional(),
  containerLogFiles: list(z.string()).optional(),
});
export type NmContainer = z.infer<typeof NmContainerSchema>;
const NmContainersInnerSchema = obj({
  container: list(NmContainerSchema),
});
/** `{"containers":{"container":[…]}}`; Hadoop emits `{"containers":{}}` when the node has none. */
export const NmContainersResponseSchema = obj({
  containers: NmContainersInnerSchema.nullish(),
}).transform((v) => v.containers?.container ?? []);
/** `GET /api/nm/{host:port}/containers` — the parsed container list (empty when the node has none). */
export type NmContainers = z.infer<typeof NmContainersResponseSchema>;

/** NM `NodeInfo` (`/ws/v1/node/info`) — the build/version + allocation totals the RM's node object does not carry. */
export const NmNodeInfoSchema = obj({
  id: z.string().optional(),
  nodeHostName: z.string().optional(),
  healthReport: z.string(),
  nodeHealthy: boolish,
  lastNodeUpdateTime: num,
  nmStartupTime: num.optional(),
  totalVmemAllocatedContainersMB: num,
  totalPmemAllocatedContainersMB: num,
  totalVCoresAllocatedContainers: num,
  vmemCheckEnabled: boolish,
  pmemCheckEnabled: boolish,
  resourceTypes: z.string().optional(),
  nodeManagerVersion: z.string(),
  nodeManagerBuildVersion: z.string().optional(),
  nodeManagerVersionBuiltOn: z.string().optional(),
  hadoopVersion: z.string().optional(),
  hadoopBuildVersion: z.string().optional(),
  hadoopVersionBuiltOn: z.string().optional(),
});
export type NmNodeInfo = z.infer<typeof NmNodeInfoSchema>;
export const NmInfoResponseSchema = obj({
  nodeInfo: NmNodeInfoSchema,
}).transform((v) => v.nodeInfo);

/** NM `AppInfo` (`/ws/v1/node/apps`). */
export const NmAppSchema = obj({
  id: z.string(),
  user: z.string().optional(),
  state: z.string().optional(),
  containerids: list(z.string()).optional(),
});
export type NmApp = z.infer<typeof NmAppSchema>;
const NmAppsInnerSchema = obj({
  app: list(NmAppSchema),
});
export const NmAppsResponseSchema = obj({
  apps: NmAppsInnerSchema.nullish(),
}).transform((v) => v.apps?.app ?? []);

/** NM `/conf` (ConfServlet, same shape as the RM's). */
export const NmConfResponseSchema = obj({
  properties: list(
    obj({
      key: z.string(),
      value: z.string().nullable(),
      isFinal: boolish,
      resource: z.string().optional(),
    }),
  ),
});

/** NM `/jmx`. */
export const NmJmxSchema = obj({ beans: list(z.looseObject({ name: z.string() })) });

export const nmBase = (hostPort: string, path: string) => `nm/${enc(hostPort)}/${path}`;

export const nq = {
  // ── RM passthrough ───────────────────────────────────────────────────────────────────────────────────────────
  /** All nodes. `states`/`healthy` filters are sent upstream (legacy semantics) but the UI also facets client-side. */
  nodes: (query?: Query) => ({
    ...rm(["yarn", "nodes", query ?? {}], "yarn/nodes", NodesResponseSchema, "live", query),
    select: (r: { nodes?: { node?: Node | Node[] | null } | null }): Node[] => asArray(r.nodes?.node),
  }),
  node: (nodeId: string) => ({
    ...rm(["yarn", "nodes", nodeId], `yarn/nodes/${enc(nodeId)}`, NodeResponseSchema, "live"),
    select: (r: { node: Node }) => r.node,
  }),
  nodeLabels: () => ({
    ...rm(["yarn", "get-node-labels"], "yarn/get-node-labels", NodeLabelsResponseSchema, "slow"),
    select: selectNodeLabels,
  }),
  nodeToLabels: () => ({
    ...rm(["yarn", "get-node-to-labels"], "yarn/get-node-to-labels", NodeToLabelsResponseSchema, "slow"),
    select: selectNodeToLabels,
  }),
  labelMappings: () => ({
    ...rm(["yarn", "label-mappings"], "yarn/label-mappings", LabelMappingsResponseSchema, "slow"),
    select: selectLabelMappings,
  }),
  resourceTypes: () =>
    queryOptions({
      queryKey: ["yarn", "resource-types"],
      queryFn: ({ signal }) => apiGet("yarn/resource-types", { signal }),
      ...adaptive("static"),
    }),

  // ── NM passthrough (SSRF-guarded upstream: host must be an RM-known node) ────────────────────────────────────
  nmInfo: (hostPort: string) => ({
    ...rm(["nm", hostPort, "info"], nmBase(hostPort, "info"), NmInfoResponseSchema, "slow"),
  }),
  nmContainers: (hostPort: string) => ({
    ...rm(["nm", hostPort, "containers"], nmBase(hostPort, "containers"), NmContainersResponseSchema, "live"),
  }),
  nmApps: (hostPort: string) => ({
    ...rm(["nm", hostPort, "apps"], nmBase(hostPort, "apps"), NmAppsResponseSchema, "live"),
  }),
  nmConf: (hostPort: string) => ({
    ...rm(["nm", hostPort, "conf"], nmBase(hostPort, "conf"), NmConfResponseSchema, "static"),
  }),
  nmJmx: (hostPort: string, qry?: string) => ({
    ...rm(["nm", hostPort, "jmx", qry ?? ""], nmBase(hostPort, "jmx"), NmJmxSchema, "slow", qry ? { qry } : undefined),
  }),
};

export type { Node, NodeLabel };
