/**
 * URL state for the container-log viewer (PLAN §5: "URL is state").
 *
 *   ?container=container_…_01_000001   which container (required to show a viewer)
 *   &file=stdout                        which file in its userlog dir (defaults to the first)
 *   &node=127.0.0.4:8042                NM host:port hint (from the RM's container record)
 *   &user=alice&app=application_…       remaining hints the backend uses to resolve the log source
 *   &follow=1                           live follow (SSE, polling fallback)
 *   &tail=262144                        start at the last N bytes (implies follow unless follow=0)
 *   &filter=WARN                        minimum log level shown
 *   &q=Exception&re=1&cs=1              search: query, regex mode, case-sensitive
 *   &wrap=1&ts=relative                 wrap long lines; timestamp rendering
 *
 * Every one of these is shareable: "the WARN+ lines of this container's stderr, following" is a link.
 *
 * The codecs are the shared ones from `features/nodes/search.ts` (used by the Nodes, node-labels and Tools routes):
 * TanStack Router JSON-parses search values, so a hand-typed `?follow=1` arrives as the number 1 while a
 * router-serialised `follow=%221%22` arrives as the string "1" — a string-only schema would make an ordinary shared
 * link fail to render.
 */
import { z } from "zod";
import { optFlag, optInt, optStr } from "~/features/nodes/search";

export const logsSearchSchema = z.object({
  container: optStr,
  file: optStr,
  node: optStr,
  user: optStr,
  app: optStr,
  follow: optFlag,
  tail: optInt,
  filter: optStr,
  q: optStr,
  re: optFlag,
  cs: optFlag,
  wrap: optFlag,
  ts: z.enum(["absolute", "relative"]).optional().catch(undefined),
});

export type LogsSearch = z.output<typeof logsSearchSchema>;

/** Default tail window when `?tail` is a bare flag rather than a byte count. */
export const DEFAULT_TAIL_BYTES = 256 * 1024;

/**
 * `?tail` → bytes to show from the end, or null when the viewer should start at the beginning.
 * `tail=1` means "the default tail"; any other count is taken literally (clamped to 1 byte..1 GiB).
 */
export function tailBytes(value: number | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  if (value === 1) return DEFAULT_TAIL_BYTES;
  return Math.min(Math.floor(value), 1024 * 1024 * 1024);
}

/** Follow is on when asked for, or implied by a tail window unless explicitly disabled (`follow=0`). */
export function followEnabled(search: LogsSearch): boolean {
  if (search.follow === false) return false;
  if (search.follow === true) return true;
  return tailBytes(search.tail) != null;
}

export function timestampMode(search: LogsSearch): "absolute" | "relative" {
  return search.ts === "relative" ? "relative" : "absolute";
}

/**
 * Re-exported so the route validates through the shared helper: it keeps `?parity=1` (and any sibling's params)
 * instead of letting zod strip unknown keys.
 */
export { parseSearch } from "~/features/app/search";
