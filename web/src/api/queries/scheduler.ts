/**
 * Query factories for the Scheduler domain (owned by the FE-Scheduler slice).
 *
 * Keys deliberately match the foundation factories in `api/queries.ts` (`["yarn","scheduler"]`,
 * `["yarn","scheduler","activities",query]`, `["yarn","scheduler-conf"]`, `["yarn","apps","filtered",query]`) so a route
 * using either factory shares one cache entry. Factories here add the `select`s the views want, the `?type=` on
 * `/scheduler-conf` (contract §3: query forwarded upstream), and the per-queue app list.
 *
 * `GET /api/yarn/scheduler-conf` is admin-only and the configuration store is scheduler-specific: the CapacityScheduler
 * answers it (memory store), Fair/FIFO do not (upstream 500/404) — the UI shows that as an explicit unavailable state.
 */
import { queryOptions } from "@tanstack/react-query";
import type { z } from "zod";
import { type Query, apiGet, topicOf } from "../client";
import { adaptive } from "../refetch";
import {
  type App,
  AppsResponseSchema,
  type CapacitySchedulerInfo,
  type FairSchedulerInfo,
  type FifoSchedulerInfo,
  type Node,
  NodesResponseSchema,
  type SchedulerActivities,
  type SchedulerConf,
  SchedulerActivitiesSchema,
  SchedulerConfSchema,
  SchedulerResponseSchema,
  type SchedulerInfo,
  selectSchedulerInfo,
} from "../schemas";

const asArray = <T>(x: T | T[] | null | undefined): T[] => (Array.isArray(x) ? x : x == null ? [] : [x]);

function rm<S extends z.ZodType>(key: readonly unknown[], path: string, schema: S, kind: "live" | "slow" | "static", query?: Query) {
  return queryOptions({
    queryKey: key,
    queryFn: ({ signal }) => apiGet(path, { schema, signal, query }),
    ...adaptive(kind, { topic: topicOf(path, query) }),
  });
}

/** `GET /scheduler` — the whole scheduler tree. */
export const schedulerQuery = () => ({
  ...rm(["yarn", "scheduler"], "yarn/scheduler", SchedulerResponseSchema, "live"),
  select: (r: { scheduler: { schedulerInfo: SchedulerInfo } }): SchedulerInfo => selectSchedulerInfo(r),
});

/** `GET /scheduler/activities[?nodeId=&groupBy=DIAGNOSTIC]` — the latest allocation activity of one NodeManager. */
export const schedulerActivitiesQuery = (query?: Query) => ({
  ...rm(["yarn", "scheduler", "activities", query ?? {}], "yarn/scheduler/activities", SchedulerActivitiesSchema, "live", query),
  select: (r: SchedulerActivities) => r.activities,
});

/**
 * `GET /scheduler-conf[?type=…]`. `type` is the scheduler class discriminator the legacy UI sends; the RM ignores it for
 * Capacity (the only scheduler with a configuration store), so it only affects the cache key/topic.
 */
export const schedulerConfQuery = (type?: string) => ({
  ...rm(["yarn", "scheduler-conf", type ?? ""], "yarn/scheduler-conf", SchedulerConfSchema, "static", type ? { type } : undefined),
  select: (r: SchedulerConf) => r.property,
});

/**
 * Apps of one queue. Server-side filtered (contract §3: `apps?queue=…&states=…`), same key as
 * `api/queries.ts#appsFiltered` so both views share the cache entry.
 */
export const queueAppsQuery = (queue: string, states?: readonly string[]) => {
  const query: Query = { deSelects: "resourceRequests", queue, ...(states?.length ? { states: [...states].join(",") } : {}) };
  return {
    ...rm(["yarn", "apps", "filtered", query], "yarn/apps", AppsResponseSchema, "live", query),
    select: (r: { apps?: { app?: App | App[] | null } | null }): App[] => asArray(r.apps?.app),
  };
};

/** All nodes (same cache key as `api/queries.ts#nodes`); the scheduler page only needs their ids for the activity picker. */
export const nodesQuery = () => ({
  ...rm(["yarn", "nodes", {}], "yarn/nodes", NodesResponseSchema, "live"),
  select: (r: { nodes?: { node?: Node | Node[] | null } | null }): Node[] => asArray(r.nodes?.node),
});

export type { CapacitySchedulerInfo, FairSchedulerInfo, FifoSchedulerInfo, Node, SchedulerInfo };
