import { z } from "zod";
import { num, obj } from "./_base";

/** One auxiliary service entry in `/api/meta` `services.*`. */
export const MetaServiceSchema = obj({
  configured: z.boolean(),
  url: z.string().nullable().optional(),
  urls: z.array(z.string()).optional(),
  reachable: z.boolean().nullable().optional(),
  reason: z.string().nullable().optional(), // why not reachable
  candidates: z
    .array(
      obj({
        url: z.string(),
        reachable: z.boolean(),
        reason: z.string().optional(),
      }),
    )
    .optional(),
});
export type MetaService = z.infer<typeof MetaServiceSchema>;

/** `GET /api/meta` (synthesized) — docs/contracts/api.md §2. */
export const MetaSchema = obj({
  name: z.string(),
  version: z.string(),
  now: num, // server epoch ms (clock-skew correction)
  readOnly: z.boolean(),
  rm: obj({
    urls: z.array(z.string()),
    active: z.string().nullable().optional(),
    haState: z.string().nullable().optional(), // "ACTIVE" | "STANDBY" | null
    hadoopVersion: z.string().nullable().optional(),
    reachable: z.boolean(),
  }),
  services: obj({
    sparkHistory: MetaServiceSchema,
    jobHistory: MetaServiceSchema,
    timeline: MetaServiceSchema,
  }),
  features: obj({
    sparkLive: z.boolean(),
    sparkHistory: z.boolean(),
    aggregatedLogs: z.boolean(),
    nodeLogs: z.boolean(),
    events: z.boolean(),
    kerberos: z.boolean(),
  }),
  yarn: obj({
    logServerUrl: z.string().nullable(),
    httpPolicy: z.string(), // HTTP_ONLY | HTTPS_ONLY | HTTP_AND_HTTPS
    scheduler: z.string().nullable(), // "capacity" | "fair" | "fifo" | null
  }),
});
export type Meta = z.infer<typeof MetaSchema>;
