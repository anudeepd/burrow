/**
 * Adaptive refetch policy (one place):
 *  - fast while the tab is visible and the user has not paused live mode; paused while hidden
 *  - slower when the data is quiet (kind "slow") ; never for "static"
 *  - exponential backoff on consecutive errors (cap 30 s)
 *  - SSE healthy => polling relaxes to a 30 s safety net (push invalidations do the real work)
 *  - parity mode => never refetch (data frozen after first load)
 */
import { createStore } from "@tanstack/react-store";
import { isParity } from "~/state/parity";
import { prefsStore } from "~/state/prefs";

export type RefetchKind = "live" | "slow" | "static";

export const eventsStore = createStore<{
  state: "idle" | "connecting" | "open" | "down" | "unsupported";
  lastEventAt: number | null;
  topics: string[];
}>({
  state: "idle",
  lastEventAt: null,
  topics: [],
});

const MULT: Record<RefetchKind, number> = { live: 1, slow: 4, static: 0 };
const SSE_SAFETY_MS = 30_000;
const BACKOFF_CAP_MS = 30_000;

/** User-selected base cadence for this resource class, or false while live updates are suspended. */
export function configuredInterval(kind: RefetchKind): number | false {
  if (isParity() || kind === "static") return false;
  const p = prefsStore.get();
  if (p.livePaused) return false;
  if (typeof document !== "undefined" && document.hidden) return false;
  return p.liveIntervalMs * MULT[kind];
}

export function nextInterval(kind: RefetchKind, errorCount: number, topic?: string): number | false {
  const base = configuredInterval(kind);
  if (base === false) return false;
  // Push invalidations drive live queries; slower resources stay on their selected cadence and aren't SSE-subscribed.
  const events = eventsStore.get();
  if (kind === "live" && topic && events.state === "open" && events.topics.includes(topic)) return SSE_SAFETY_MS;
  return Math.min(BACKOFF_CAP_MS, base * 2 ** Math.min(errorCount, 5));
}

/** Spread into queryOptions(); meta carries the cadence so the SSE hub can subscribe/throttle correctly. */
export function adaptive(kind: RefetchKind, meta: Record<string, unknown> = {}) {
  return {
    refetchInterval: (query: { state: { fetchFailureCount: number }; meta?: Record<string, unknown> }) =>
      nextInterval(kind, query.state.fetchFailureCount, typeof query.meta?.topic === "string" ? query.meta.topic : undefined),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: () => kind !== "static" && !isParity() && !prefsStore.get().livePaused,
    staleTime: isParity() ? Number.POSITIVE_INFINITY : kind === "static" ? 60_000 : 500,
    meta: { ...meta, refetchKind: kind },
  } as const;
}
