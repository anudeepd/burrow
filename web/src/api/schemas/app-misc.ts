import { z } from "zod";
import { num, obj } from "./_base";
import { entryMap, list } from "./_lenient";
import { AppTimeoutInfoSchema, AppTimeoutsInfoSchema } from "./app";
import { ResourceInformationSchema } from "./resource";

// ------------------------------------------------- /apps/{id}/{state|priority|queue|timeout|timeouts}

/** `AppState` (unwrapped root): `GET /apps/{id}/state`. */
export const AppStateResponseSchema = obj({
  state: z.string(),
  diagnostics: z.string().optional(),
});
export type AppStateResponse = z.infer<typeof AppStateResponseSchema>;

/** `AppPriority` (unwrapped root): `GET /apps/{id}/priority`. */
export const AppPriorityResponseSchema = obj({ priority: num });
export type AppPriorityResponse = z.infer<typeof AppPriorityResponseSchema>;

/** `AppQueue` (unwrapped root): `GET /apps/{id}/queue`. */
export const AppQueueResponseSchema = obj({ queue: z.string() });
export type AppQueueResponse = z.infer<typeof AppQueueResponseSchema>;

/** `GET /apps/{id}/timeouts/{type}` (wrapped: `{timeout:{…}}`). The singular `/timeout` path is PUT-only upstream. */
export const AppTimeoutResponseSchema = obj({ timeout: AppTimeoutInfoSchema });
export type AppTimeoutResponse = z.infer<typeof AppTimeoutResponseSchema>;

/** `GET /apps/{id}/timeouts`: `{timeouts:{timeout:[…]}}`. */
export const AppTimeoutsResponseSchema = obj({ timeouts: AppTimeoutsInfoSchema });
export type AppTimeoutsResponse = z.infer<typeof AppTimeoutsResponseSchema>;
export const selectAppTimeouts = (r: AppTimeoutsResponse) => r.timeouts.timeout;

// ------------------------------------------------------------------------------ /appstatistics

/** `StatisticsItemInfo`. */
export const StatisticsItemSchema = obj({
  state: z.string(), // YarnApplicationState
  type: z.string(), // application type, "*" = all
  count: num,
});
export type StatisticsItem = z.infer<typeof StatisticsItemSchema>;

/** `GET /appstatistics` — `{appStatInfo:{statItem:[…]}}`. */
export const AppStatisticsResponseSchema = obj({
  appStatInfo: obj({ statItem: list(StatisticsItemSchema) })
    .nullable()
    .optional(),
});
export type AppStatisticsResponse = z.infer<typeof AppStatisticsResponseSchema>;
export const selectAppStatistics = (r: AppStatisticsResponse): StatisticsItem[] => r.appStatInfo?.statItem ?? [];

// -------------------------------------------------------- scheduler activities / app activities

/** `ActivityNodeInfo` (recursive via `children`). */
export const ActivityNodeSchema = obj({
  name: z.string().optional(), // queue path / "App: …" / "Container: …" / node host
  appPriority: num.optional(),
  requestPriority: num.optional(),
  allocationRequestId: num.optional(),
  allocationState: z.string().optional(),
  diagnostic: z.string().optional(),
  nodeId: z.string().optional(),
  count: num.optional(),
  nodeIds: list(z.string()),
  get children() {
    return list(ActivityNodeSchema);
  },
});
export type ActivityNode = z.infer<typeof ActivityNodeSchema>;

/** `NodeAllocationInfo`. */
export const NodeAllocationSchema = obj({
  partition: z.string().optional(),
  updatedContainerId: z.string().optional(),
  finalAllocationState: z.string().optional(),
  root: ActivityNodeSchema.optional(),
});
export type NodeAllocation = z.infer<typeof NodeAllocationSchema>;

/** `ActivitiesInfo`. */
export const ActivitiesSchema = obj({
  nodeId: z.string().optional(),
  timestamp: num.optional(),
  dateTime: z.string().optional(),
  diagnostic: z.string().optional(),
  allocations: list(NodeAllocationSchema),
});
export type Activities = z.infer<typeof ActivitiesSchema>;

/** `GET /scheduler/activities` — `{activities:{…}}`. */
export const SchedulerActivitiesSchema = obj({ activities: ActivitiesSchema });
export type SchedulerActivities = z.infer<typeof SchedulerActivitiesSchema>;

/** `BulkActivitiesInfo`: `GET /scheduler/bulk-activities` — `{bulkActivities:{activities:[…]}}`. */
export const BulkActivitiesSchema = obj({
  bulkActivities: obj({
    activities: list(ActivitiesSchema),
    subClusterId: z.string().optional(),
  }),
});
export type BulkActivities = z.infer<typeof BulkActivitiesSchema>;

/** `AppRequestAllocationInfo`. */
export const AppRequestAllocationSchema = obj({
  requestPriority: num.optional(),
  allocationRequestId: num.optional(),
  allocationState: z.string().optional(),
  diagnostic: z.string().optional(),
  children: list(ActivityNodeSchema),
});
export type AppRequestAllocation = z.infer<typeof AppRequestAllocationSchema>;

/** `AppAllocationInfo`. */
export const AppAllocationSchema = obj({
  nodeId: z.string().optional(),
  timestamp: num.optional(),
  dateTime: z.string().optional(),
  queueName: z.string().optional(),
  appPriority: num.optional(),
  allocationState: z.string().optional(),
  diagnostic: z.string().optional(),
  children: list(AppRequestAllocationSchema),
});
export type AppAllocation = z.infer<typeof AppAllocationSchema>;

/** `AppActivitiesInfo`: `GET /scheduler/app-activities/{appId}` (or `/apps/{id}/appactivities`) — `{appActivities:{…}}`. */
export const AppActivitiesSchema = obj({
  appActivities: obj({
    applicationId: z.string().optional(),
    diagnostic: z.string().optional(),
    timestamp: num.optional(),
    dateTime: z.string().optional(),
    allocations: list(AppAllocationSchema),
  }),
});
export type AppActivities = z.infer<typeof AppActivitiesSchema>;

// ------------------------------------------------------------------------- scheduler-conf

/** `ConfInfo.ConfItem`. */
export const SchedulerConfItemSchema = obj({
  name: z.string(),
  value: z.string().optional(),
});
export type SchedulerConfItem = z.infer<typeof SchedulerConfItemSchema>;

const SchedulerConfInnerSchema = obj({
  property: list(SchedulerConfItemSchema),
  subClusterId: z.string().optional(),
});
/** `GET /scheduler-conf` (admin only): `ConfInfo` — `{property:[{name,value}]}` (unwrapped; wrapped `{configuration:{…}}` tolerated). */
export const SchedulerConfSchema = z.union([
  obj({ configuration: SchedulerConfInnerSchema }).transform((v) => v.configuration),
  SchedulerConfInnerSchema,
]);
export type SchedulerConf = z.infer<typeof SchedulerConfSchema>;

// ------------------------------------------------------------------------- user info

/** `ClusterUserInfo`: `GET /userinfo` (unwrapped root; wrapped `{clusterUserInfo:{…}}` tolerated). */
const ClusterUserInfoInnerSchema = obj({
  rmLoginUser: z.string().optional(),
  requestedUser: z.string().optional(),
  subClusterId: z.string().optional(),
});
export const ClusterUserInfoSchema = z.union([
  obj({ clusterUserInfo: ClusterUserInfoInnerSchema }).transform((v) => v.clusterUserInfo),
  ClusterUserInfoInnerSchema,
]);
export type ClusterUserInfo = z.infer<typeof ClusterUserInfoSchema>;

// ------------------------------------------------------------- resource types / profiles

/**
 * `GET /resource-types`. NOT served by Hadoop 3.4.3's RM REST (no such DAO/path; upstream answers 404), so the shape is an
 * assumption: array | `{resourceInformation:[…]}` | `{resourceInformations:{resourceInformation:[…]}}` — all normalised to an array.
 */
export const ResourceTypesSchema = z.union([
  z.array(ResourceInformationSchema),
  obj({ resourceInformations: obj({ resourceInformation: list(ResourceInformationSchema) }) }).transform(
    (v) => v.resourceInformations.resourceInformation,
  ),
  obj({ resourceInformation: list(ResourceInformationSchema) }).transform((v) => v.resourceInformation),
]);
export type ResourceTypes = z.infer<typeof ResourceTypesSchema>;

/**
 * `GET /resource-profiles`. NOT served by Hadoop 3.4.3's RM REST (ASSUMPTION, see above): profile name → resource name → value.
 * Accepts `{profiles:{…}}`, `{profile:[{name,value:{…}}]}` or the bare record.
 */
const ProfileResourcesSchema = z.record(z.string(), num);
export const ResourceProfilesSchema = z.union([
  obj({ profiles: z.record(z.string(), ProfileResourcesSchema) }).transform((v) => v.profiles),
  obj({ profile: list(obj({ name: z.string(), value: entryMap(num) })) }).transform((v) => {
    const out: Record<string, Record<string, number>> = {};
    for (const p of v.profile) out[p.name] = p.value;
    return out;
  }),
  z.record(z.string(), ProfileResourcesSchema),
]);
export type ResourceProfiles = z.infer<typeof ResourceProfilesSchema>;
