import { z } from "zod";
import { num, obj } from "./_base";
import { list } from "./_lenient";

/** RM `AppAttemptInfo` (`org.apache.hadoop.yarn.server.resourcemanager.webapp.dao`, JAXB FIELD). */
export const AppAttemptSchema = obj({
  id: num, // attempt number
  startTime: num,
  finishedTime: num, // 0 while running
  containerId: z.string(), // AM container; "" when unknown or no access
  nodeHttpAddress: z.string(),
  nodeId: z.string(),
  logsLink: z.string(),
  blacklistedNodes: z.string().optional(), // comma-joined
  nodesBlacklistedBySystem: z.string().optional(),
  appAttemptId: z.string(),
  exportPorts: z.string().optional(), // JSON text from Gson, e.g. "{}"
  appAttemptState: z.string(), // RMAppAttemptState (lenient)
});
export type AppAttempt = z.infer<typeof AppAttemptSchema>;

/** `GET /apps/{id}/appattempts` — `{appAttempts:{appAttempt:[…]}}`. */
export const AppAttemptsResponseSchema = obj({
  appAttempts: obj({ appAttempt: list(AppAttemptSchema) })
    .nullable()
    .optional(),
});
export type AppAttemptsResponse = z.infer<typeof AppAttemptsResponseSchema>;
export const selectAppAttempts = (r: AppAttemptsResponse): AppAttempt[] => r.appAttempts?.appAttempt ?? [];

/**
 * `GET /apps/{id}/appattempts/{attemptId}` — the single-attempt resource (webapp `AppAttemptInfo`, mapped notation:
 * numbers arrive as strings, root unwrapped). Unlike the list entry it carries what the legacy attempt page reads from
 * `ApplicationAttemptReport`: AM host/rpcPort, tracking URLs and the attempt's diagnostics. `host` is `"N/A"` and
 * `rpcPort` `-1` until the AM registers; `diagnosticsInfo` may be absent.
 */
export const AppAttemptDetailSchema = obj({
  appAttemptId: z.string(),
  host: z.string().optional(),
  rpcPort: num.optional(),
  trackingUrl: z.string().optional(),
  originalTrackingUrl: z.string().optional(),
  diagnosticsInfo: z.string().optional(),
  appAttemptState: z.string(),
  amContainerId: z.string().optional(),
  startedTime: num.optional(),
  finishedTime: num.optional(),
});
export type AppAttemptDetail = z.infer<typeof AppAttemptDetailSchema>;

export const AppAttemptDetailResponseSchema = z.union([
  obj({ appAttempt: AppAttemptDetailSchema }).transform((v) => v.appAttempt),
  AppAttemptDetailSchema,
]);
export type AppAttemptDetailResponse = z.infer<typeof AppAttemptDetailResponseSchema>;
