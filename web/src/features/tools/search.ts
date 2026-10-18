/**
 * URL search-param schemas for the four daemon "Tools" pages. Each page keeps its query, selection and paging in the URL so
 * a stack trace / config key / log offset can be linked to a colleague.
 */
import { z } from "zod";
import { optFlag, optInt, optStr } from "../nodes/search";

export const confSearchSchema = z.object({
  q: optStr,
  /** only properties that differ from a Hadoop default (a `*-site.xml` or programmatic value, or a final one) */
  overridden: optFlag,
  /** only `isFinal` properties */
  final: optFlag,
  /** resource filter, e.g. `yarn-site.xml` */
  resource: optStr,
  sort: optStr,
  cols: optStr,
  /** expanded property key (value can be multi-line) */
  open: optStr,
  /** NodeManager `host:port` — read `/api/nm/{host:port}/conf` instead of the ResourceManager's (node detail links here) */
  host: optStr,
});
export type ConfSearch = z.infer<typeof confSearchSchema>;

export const jmxSearchSchema = z.object({
  q: optStr,
  /** daemon-side MBean name pattern passed through as `?qry=` (e.g. `Hadoop:service=ResourceManager,*`) */
  qry: optStr,
  /** selected bean name */
  bean: optStr,
  /** selected attribute (dotted path inside the bean) */
  attr: optStr,
  /** NodeManager `host:port` — read `/api/nm/{host:port}/jmx` instead of the ResourceManager's */
  host: optStr,
});
export type JmxSearch = z.infer<typeof jmxSearchSchema>;

export const THREAD_STATES = ["RUNNABLE", "WAITING", "TIMED_WAITING", "BLOCKED", "NEW", "TERMINATED", "UNKNOWN"] as const;

export const stacksSearchSchema = z.object({
  q: optStr,
  state: z.enum(THREAD_STATES).optional().catch(undefined),
  /** selected thread id */
  thread: optStr,
});
export type StacksSearch = z.infer<typeof stacksSearchSchema>;

export const logsSearchSchema = z.object({
  file: optStr,
  offset: optInt,
  /** bytes per page (defaults to 128 KiB) */
  len: optInt,
  /** "1" = keep appending new bytes at the end of the file */
  tail: optFlag,
  q: optStr,
});
export type LogsSearch = z.infer<typeof logsSearchSchema>;
