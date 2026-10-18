import { z } from "zod";
import { num, obj } from "./_base";
import { boolish, list } from "./_lenient";

/**
 * Hadoop `ConfServlet` / `Configuration.dumpConfiguration` (verified against hadoop-common 3.4.3):
 * `GET /conf?format=json` => `{"properties":[{"key","value","isFinal","resource"}]}`;
 * with `?name=<key>` => `{"property":{"key","value","isFinal","resource"}}`.
 */
export const ConfPropertySchema = obj({
  key: z.string(),
  value: z.string().nullable(), // redacted values are "<redacted>"
  isFinal: boolish,
  resource: z.string().optional(), // "yarn-site.xml", "programmatically", "Unknown"
});
export type ConfProperty = z.infer<typeof ConfPropertySchema>;

export const ConfResponseSchema = z.union([
  obj({ properties: list(ConfPropertySchema) }),
  obj({ property: ConfPropertySchema }).transform((v) => ({ properties: [v.property] })),
]);
export type ConfResponse = z.infer<typeof ConfResponseSchema>;
export const selectConf = (r: ConfResponse): ConfProperty[] => r.properties;

/**
 * Hadoop `JMXJsonServlet`: `{"beans":[{"name":"…","modelerType":"…", <attributes…>}]}`.
 * A bean's attribute set is open-ended, so beans are DELIBERATELY loose objects even in strict mode.
 * Query errors come back as `{"result":"ERROR","message":"…"}` bean entries.
 */
export const JmxBeanSchema = z.looseObject({
  name: z.string(),
  modelerType: z.string().optional(),
});
export type JmxBean = z.infer<typeof JmxBeanSchema>;
export const JmxResponseSchema = obj({ beans: list(JmxBeanSchema) });
export type JmxResponse = z.infer<typeof JmxResponseSchema>;
export const selectJmxBeans = (r: JmxResponse): JmxBean[] => r.beans;

/**
 * `GET /api/rm/logs` — synthesized by the Rust backend from the RM's HTML directory listing.
 * The listing mirrors the RM page, so a directory entry carries the RM's own fields: `name`, `size`, `modified`
 * (the locale date string printed by the RM, verbatim), `isDir`. `lastModified` (epoch ms) is accepted too because the
 * dev mock and older captures emit it. At least one of the two timestamps is present for files.
 */
export const RmLogFileSchema = obj({
  name: z.string(),
  size: num.nullish(),
  /** epoch ms (mock captures / future backend normalisation) */
  lastModified: num.nullish(),
  /** the RM HTML listing's date string, e.g. "Oct 3, 2026, 12:30:42 PM" */
  modified: z.string().nullish(),
  isDir: z.boolean().nullish(),
});
export type RmLogFile = z.infer<typeof RmLogFileSchema>;
export const RmLogsListingSchema = obj({ files: list(RmLogFileSchema) });
export type RmLogsListing = z.infer<typeof RmLogsListingSchema>;
