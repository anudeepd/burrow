/**
 * Query factories for the daemon "Tools" pages (owned by the FE-NodesTools slice): RM `/conf`, `/jmx`, `/stacks`, `/logs`.
 *
 * Shapes (verified against hadoop-common 3.4.3 `ConfServlet` + `JMXJsonServlet`, and the live RM):
 *  - `rm/conf`  → `{properties:[{key,value,isFinal,resource}]}`   (Content-Type json comes from an `Accept` header, not `?format`)
 *  - `rm/jmx`   → `{beans:[{name,modelerType,…open attributes…}]}`
 *  - `rm/stacks`→ text/plain thread dump
 *  - `rm/logs`  → synthesized by the backend from the RM's directory listing: `{files:[{name,size,lastModified}]}`
 *  - `rm/logs/{file}?offset&length` → text/plain byte range
 *
 * Keys match the foundation factories in `api/queries.ts` so both share one cache entry.
 */
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import type { ZodType } from "zod";
import { type Query, apiGet, apiText, topicOf } from "../client";
import { adaptive } from "../refetch";
import { obj } from "../schemas/_base";
import { list } from "../schemas/_lenient";
import { ConfResponseSchema, JmxResponseSchema, selectConf, selectJmxBeans, type ConfProperty, type JmxBean } from "../schemas";

const enc = encodeURIComponent;

function rm<S extends ZodType>(
  key: readonly unknown[],
  path: string,
  schema: S,
  kind: "live" | "slow" | "static",
  query?: Query,
  timeoutMs?: number,
) {
  return queryOptions({
    queryKey: key,
    queryFn: ({ signal }) => apiGet(path, { schema, signal, query, timeoutMs }),
    ...adaptive(kind, { topic: topicOf(path, query) }),
  });
}

export const LOG_PAGE_BYTES = 128 * 1024;

/**
 * One entry of the daemon's log directory. **Tolerant on purpose, and honest about time zones.**
 *
 * `/api/rm/logs` is synthesized by the backend from the RM's Jetty directory listing, which prints a *zone-free* date
 * (`Oct 3, 2026, 12:31:04 PM`). Minting an epoch from it would be an assumption about the daemon's zone and would show the
 * wrong time to anyone in another zone — so this type keeps the verbatim string for display, exposes an epoch only when the
 * backend reports one (the container-log shape in `docs/contracts/api.md` §5, where the NM/JHS really send epoch ms), and
 * offers a zone-free sort key for ordering.
 */
export interface LogFileEntry {
  name: string;
  /** bytes; absent/unknown size is 0 (the backend also sets 0 for directories, see `isDir`) */
  size: number;
  /** epoch ms — only when the backend reported one; NEVER guessed from the listing's zone-free date */
  lastModified: number | null;
  /** the daemon's verbatim date, to be displayed as-is */
  modifiedText: string | null;
  /** zone-free ordering key built from `modifiedText` (year-first); display never uses it */
  modifiedSortKey: number | null;
  isDir: boolean;
}

// Hadoop prints grouped digits ("1,712 bytes") in the listing, so a string size must lose its commas before Number().
const numeric = z
  .union([z.number(), z.string()])
  .nullish()
  .transform((v) => (typeof v === "string" ? Number(v.replace(/,/g, "")) : (v ?? 0)));

const LogFileEntrySchema = obj({
  name: z.string(),
  size: numeric,
  lastModified: numeric,
  modified: z.string().nullish(),
  isDir: z.boolean().optional(),
});

export const RmLogsSchema = obj({ files: list(LogFileEntrySchema) }).transform((r): LogFileEntry[] =>
  r.files
    .map((f) => ({
      name: f.name,
      size: Number.isFinite(f.size) ? f.size : 0,
      lastModified: f.lastModified > 0 ? f.lastModified : null,
      modifiedText: f.modified ?? null,
      modifiedSortKey: daemonDateSortKey(f.modified ?? null),
      isDir: f.isDir ?? false,
    }))
    .sort((a, b) => (a.isDir === b.isDir ? (b.modifiedSortKey ?? 0) - (a.modifiedSortKey ?? 0) : a.isDir ? 1 : -1)),
);

/**
 * `"Oct 3, 2026, 12:31:04 PM"` / `"Oct 3, 2026 12:02:00 PM"` (Jetty's `lastmodified` column) → a year-first numeric key.
 * It is built with `Date.UTC` **only** so months compare numerically; it is not the instant the file was written and is
 * never displayed (the UI shows `modifiedText` verbatim). Returns null when the text is unparseable.
 */
export function daemonDateSortKey(text: string | null): number | null {
  if (!text) return null;
  const m = /([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{4})(?:,?\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)?)?/.exec(text.replace(/\u00a0/g, " "));
  if (!m) return null;
  const month = MONTHS[(m[1] ?? "").slice(0, 3).toLowerCase()];
  if (month === undefined) return null;
  let hour = m[4] ? Number(m[4]) : 0;
  const ampm = (m[7] ?? "").toUpperCase();
  if (ampm === "PM" && hour < 12) hour += 12;
  if (ampm === "AM" && hour === 12) hour = 0;
  return Date.UTC(Number(m[3]), month, Number(m[2]), hour, m[5] ? Number(m[5]) : 0, m[6] ? Number(m[6]) : 0);
}

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

export const tq = {
  conf: () => ({
    ...rm(["rm", "conf"], "rm/conf", ConfResponseSchema, "static", { format: "json" }),
    select: (r: { properties: ConfProperty[] }): ConfProperty[] => selectConf(r),
  }),
  jmx: (qry?: string) => ({
    ...rm(["rm", "jmx", qry ?? ""], "rm/jmx", JmxResponseSchema, "slow", qry ? { qry } : undefined),
    select: (r: { beans: JmxBean[] }): JmxBean[] => selectJmxBeans(r),
  }),
  stacks: () =>
    queryOptions({
      queryKey: ["rm", "stacks"],
      queryFn: async ({ signal }) => (await apiText("rm/stacks", { signal, timeoutMs: 30_000 })).data,
      ...adaptive("static"),
    }),
  // This directory is optional and can be absent on secured or customized clusters. Fail quickly so the page can explain
  // that instead of spending nearly a minute retrying a discovery request that is unlikely to become available.
  logs: () => ({
    ...rm(["rm", "logs"], "rm/logs", RmLogsSchema, "slow", undefined, 8_000),
    retry: false,
    // Outside tail mode, do not repeatedly probe an optional directory that this cluster may not expose.
    refetchInterval: false as const,
  }),
  logFile: (file: string, range?: { offset?: number; length?: number; tail?: number }) =>
    queryOptions({
      queryKey: ["rm", "logs", file, range ?? {}],
      queryFn: async ({ signal }) => (await apiText(`rm/logs/${enc(file)}`, { signal, query: range, timeoutMs: 30_000 })).data,
      ...adaptive("slow"),
    }),
};

/** RM paginated log window helper: clamps a byte range to the file size and returns both feed params. */
export function logWindow(size: number, offset: number, pageBytes = LOG_PAGE_BYTES) {
  const max = Number.isFinite(size) && size > 0 ? size : 0;
  const start = Math.max(0, Math.min(offset, Math.max(0, max - 1)));
  const length = Math.max(1, Math.min(pageBytes, Math.max(0, max - start) || pageBytes));
  return { offset: start, length };
}
