/**
 * Application-detail source resolution and the shared scheduler-activities query:
 *
 *  - `appSparkSource` — `/api/spark/{appId}/source` (synthesized by the backend) powers the "Spark UI" affordance on the
 *    overview tab. FE-Spark owns the Spark domain itself; this is only the source-resolution state, and the query key
 *    `["spark", appId, "source"]` is shared with them on purpose (same cache entry, one upstream call).
 *  - `schedulerAppActivities` — the RM's `scheduler/app-activities/{appId}` path (the app-scoped scheduler activities
 *    that used to back the legacy attempt page's diagnostics refresh). Contract CH-1: RM 3.4.3 does not serve
 *    `apps/{id}/appactivities`; this path does answer 200 (captured in fixtures/rm/app/running/scheduler-app-activities.json).
 *
 * Scheduler activities reuse `q.appActivities`; app, attempts, containers and timeouts also come from that catalogue.
 */
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { apiGet, topicOf } from "~/api/client";
import { q } from "~/api/queries";
import { adaptive } from "~/api/refetch";

/** `GET /api/spark/{appId}/source` (docs/contracts/api.md §4). */
export const SparkSourceSchema = z.object({
  mode: z.enum(["live-proxy", "history", "none"]),
  baseUrl: z.string().nullable().optional(),
  sparkAppId: z.string().nullable().optional(),
  attempt: z.string().nullable().optional(),
  available: z.boolean(),
  reason: z.string().nullable().optional(),
  hint: z.string().nullable().optional(),
});
export type SparkSource = z.infer<typeof SparkSourceSchema>;

const enc = encodeURIComponent;

export const appSparkSource = (appId: string) =>
  queryOptions({
    queryKey: ["spark", appId, "source"],
    queryFn: ({ signal }) => apiGet(`spark/${enc(appId)}/source`, { schema: SparkSourceSchema, signal }),
    ...adaptive("slow", { topic: topicOf(`spark/${enc(appId)}/source`) }),
  });

export const schedulerAppActivities = q.appActivities;
