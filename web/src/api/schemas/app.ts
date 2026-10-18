import { z } from "zod";
import { num, obj } from "./_base";
import { entryMap, list } from "./_lenient";
import { ResourceInfoSchema, ResourcesInfoSchema } from "./resource";

/** Known `YarnApplicationState` / `FinalApplicationStatus` values. Schema fields stay lenient strings. */
export const YARN_APP_STATES = ["NEW", "NEW_SAVING", "SUBMITTED", "ACCEPTED", "RUNNING", "FINISHED", "FAILED", "KILLED"] as const;
export type AppState = (typeof YARN_APP_STATES)[number];
export const FINAL_STATUSES = ["UNDEFINED", "SUCCEEDED", "FAILED", "KILLED", "ENDED"] as const;
export type FinalStatus = (typeof FINAL_STATUSES)[number];
/** Known `LogAggregationStatus` values (RM `AppInfo.logAggregationStatus`). */
export const LOG_AGGREGATION_STATUSES = [
  "DISABLED",
  "NOT_START",
  "RUNNING",
  "RUNNING_WITH_FAILURE",
  "SUCCEEDED",
  "FAILED",
  "TIME_OUT",
] as const;

/** `ExecutionTypeRequestInfo` (`ResourceRequestInfo.executionTypeRequest`). */
export const ExecutionTypeRequestSchema = obj({
  executionType: z.string(), // GUARANTEED | OPPORTUNISTIC
  enforceExecutionType: z.boolean(),
});
export type ExecutionTypeRequest = z.infer<typeof ExecutionTypeRequestSchema>;

/** RM `ResourceRequestInfo` (entries of `AppInfo.resourceRequests`). */
export const ResourceRequestInfoSchema = obj({
  priority: num,
  allocationRequestId: num,
  resourceName: z.string().optional(), // "*", rack or host; absent for scheduling requests
  capability: ResourceInfoSchema.optional(),
  numContainers: num,
  relaxLocality: z.boolean(),
  nodeLabelExpression: z.string().optional(),
  executionTypeRequest: ExecutionTypeRequestSchema.optional(),
  placementConstraint: z.string().optional(),
  allocationTags: list(z.string()),
});
export type ResourceRequestInfo = z.infer<typeof ResourceRequestInfoSchema>;

/** RM `AppTimeoutInfo`. */
export const AppTimeoutInfoSchema = obj({
  type: z.string(), // LIFETIME
  expiryTime: z.string().optional(), // ISO-8601 or "UNLIMITED"
  remainingTimeInSeconds: num.optional(), // -1 = unlimited
});
export type AppTimeoutInfo = z.infer<typeof AppTimeoutInfoSchema>;

/** RM `AppTimeoutsInfo`: `{timeout:[…]}`. */
export const AppTimeoutsInfoSchema = obj({ timeout: list(AppTimeoutInfoSchema) });
export type AppTimeoutsInfo = z.infer<typeof AppTimeoutsInfoSchema>;

/**
 * RM `AppInfo` (JAXB FIELD access). Required = emitted for every app on every Hadoop 2.x/3.x;
 * optional = nullable, ACL-gated (`hasAccess=false` leaves them unset), or added after 2.7.
 * `Map<String,Long>` fields (`*SecondsMap`) are normalised to `Record<string, number>`.
 */
export const AppSchema = obj({
  id: z.string(),
  user: z.string(),
  name: z.string(),
  queue: z.string(),
  state: z.string(), // YarnApplicationState (lenient)
  finalStatus: z.string(), // FinalApplicationStatus (lenient)
  progress: num, // 0..100
  trackingUI: z.string(), // "UNASSIGNED" | "ApplicationMaster" | "History"
  trackingUrl: z.string().optional(),
  diagnostics: z.string(),
  clusterId: num, // RM start timestamp
  rmClusterId: z.string().optional(), // yarn.resourcemanager.cluster-id (ACL-gated)
  applicationType: z.string().optional(),
  applicationTags: z.string(), // comma-joined
  priority: num, // application priority; JSON key is `priority`
  startedTime: num,
  launchTime: num.optional(),
  finishedTime: num,
  elapsedTime: num,
  amContainerLogs: z.string().optional(),
  amHostHttpAddress: z.string().optional(),
  amRPCAddress: z.string().optional(),
  masterNodeId: z.string().optional(),
  allocatedMB: num, // -1 when the report is unavailable
  allocatedVCores: num,
  allocatedGpus: num.optional(), // -1 when the GPU resource type is not configured (AppInfo.getAllocatedGpus)
  reservedMB: num.optional(),
  reservedVCores: num.optional(),
  reservedGpus: num.optional(), // see allocatedGpus
  runningContainers: num,
  memorySeconds: num,
  vcoreSeconds: num,
  queueUsagePercentage: num,
  clusterUsagePercentage: num,
  resourceSecondsMap: entryMap(num).optional(),
  preemptedResourceMB: num,
  preemptedResourceVCores: num,
  numNonAMContainerPreempted: num,
  numAMContainerPreempted: num,
  preemptedMemorySeconds: num.optional(),
  preemptedVcoreSeconds: num.optional(),
  preemptedResourceSecondsMap: entryMap(num).optional(),
  resourceRequests: list(ResourceRequestInfoSchema), // absent with ?deSelects=resourceRequests
  logAggregationStatus: z.string().optional(),
  unmanagedApplication: z.boolean(),
  appNodeLabelExpression: z.string().optional(),
  amNodeLabelExpression: z.string().optional(),
  resourceInfo: ResourcesInfoSchema.optional(), // Capacity Scheduler only; absent for FAIR/FIFO and finished apps
  timeouts: AppTimeoutsInfoSchema.optional(),
});
export type App = z.infer<typeof AppSchema>;

/** `GET /apps` — `{"apps": null}` when no application matches. */
export const AppsResponseSchema = obj({
  apps: obj({ app: list(AppSchema) })
    .nullable()
    .optional(),
});
export type AppsResponse = z.infer<typeof AppsResponseSchema>;
export const selectApps = (r: AppsResponse): App[] => r.apps?.app ?? [];

/** `GET /apps/{id}`. */
export const AppResponseSchema = obj({ app: AppSchema });
export type AppResponse = z.infer<typeof AppResponseSchema>;
export const selectApp = (r: AppResponse): App => r.app;
