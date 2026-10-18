/**
 * Overview-scoped query factories (docs/contracts/api.md). Imported directly by `~/features/overview/**`.
 *
 * Most of the Overview reads resources the shell already knows about, so the factories here are thin aliases of the
 * shared ones (`~/api/queries`) — same queryKey means one cache entry, one upstream fetch, one SSE topic. Only
 * `/api/yarn/scheduler-overview` (the legacy `#schedulermetricsoverview` block, Hadoop ≥ 2.x RMWebServices
 * `SCHEDULER_OVERVIEW`) is declared here because it is Overview-only.
 */
import { queryOptions } from "@tanstack/react-query";
import { apiGet, topicOf } from "~/api/client";
import { q } from "~/api/queries";
import { adaptive } from "~/api/refetch";
import { ApiError } from "~/api/client";
import { type ResourceInfo, ResourceInfoSchema } from "~/api/schemas";
import { num, obj } from "~/api/schemas/_base";
import { z } from "zod";
import { ACTIVE_STATES_QS } from "~/features/overview/derive";

/**
 * RM `SchedulerOverviewInfo` (`GET /ws/v1/cluster/scheduler-overview`).
 *
 * Not registered in `JAXBContextResolver.cTypes`, so Jersey serialises it in "mapped" notation: numbers arrive as
 * quoted strings and the root element is unwrapped. `num` accepts both spellings. `schedulerType` is the *display*
 * name ("Capacity Scheduler") unlike `scheduler.schedulerInfo.type`.
 */
export const SchedulerOverviewSchema = obj({
  schedulerType: z.string(),
  schedulingResourceType: z.string(),
  minimumAllocation: ResourceInfoSchema,
  maximumAllocation: ResourceInfoSchema,
  applicationPriority: num,
  schedulerBusy: num,
  rmDispatcherEventQueueSize: num,
  schedulerDispatcherEventQueueSize: num,
});
export type SchedulerOverview = {
  schedulerType: string;
  schedulingResourceType: string;
  minimumAllocation: ResourceInfo;
  maximumAllocation: ResourceInfo;
  applicationPriority: number;
  schedulerBusy: number;
  rmDispatcherEventQueueSize: number;
  schedulerDispatcherEventQueueSize: number;
};

export const ov = {
  /** `/api/meta` — shell-owned factory, shared cache entry. */
  meta: q.meta,
  info: q.info,
  metrics: q.metrics,
  nodes: q.nodes,
  scheduler: q.scheduler,

  /**
   * The "now active" rail: one server-filtered request instead of pulling every app. The RM accepts
   * `states=NEW,NEW_SAVING,SUBMITTED,ACCEPTED,RUNNING`; the query key carries the filter so the SSE topic matches
   * exactly this resource (contract §6).
   */
  appsActive: () => q.appsFiltered({ states: ACTIVE_STATES_QS }),

  schedulerOverview: () =>
    queryOptions({
      queryKey: ["yarn", "scheduler-overview"],
      queryFn: ({ signal }) => apiGet("yarn/scheduler-overview", { schema: SchedulerOverviewSchema, signal }),
      ...adaptive("live", { topic: topicOf("yarn/scheduler-overview") }),
    }),
};

/**
 * `true` when the failure means "this source cannot answer" rather than "the request failed": an RM older than the
 * endpoint, a route the backend allowlist does not carry (404), or a degraded upstream (502/503). The Overview renders
 * an explicit unavailable state for these instead of an error, and keeps the rest of the page live.
 */
export function isSourceUnavailable(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.status === 501 || err.status === 502 || err.status === 503);
}

/** Human-readable reason for an unavailable/error query, for the "source unavailable" affordances. */
export function errorReason(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return "the endpoint is not exposed by this ResourceManager (or is not in the backend allowlist)";
    if (err.hint) return err.hint;
    return err.message;
  }
  return err instanceof Error ? err.message : "unknown error";
}
