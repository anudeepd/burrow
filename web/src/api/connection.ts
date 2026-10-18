/** Connection health derived from real responses (the x-burrow-* headers + failures). Drives the top-bar connection popover. */
import { createStore, useSelector } from "@tanstack/react-store";

export interface BurrowHeaders {
  api: string | null;
  /** hit | miss | stale | coalesced | bypass */
  cache: string | null;
  upstream: string | null;
  ageMs: number | null;
  etag: string | null;
}

export interface ConnectionState {
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  /** last x-burrow-cache seen; "stale" => backend is serving cached data because the upstream failed */
  lastCache: string | null;
  lastUpstream: string | null;
  /** server clock - client clock, from /api/meta.now (ms) */
  clockSkewMs: number;
}

export const connectionStore = createStore<ConnectionState>({
  lastOkAt: null,
  lastErrorAt: null,
  lastError: null,
  consecutiveFailures: 0,
  lastCache: null,
  lastUpstream: null,
  clockSkewMs: 0,
});

export function recordSuccess(h: BurrowHeaders): void {
  connectionStore.setState((s) => ({
    ...s,
    lastOkAt: Date.now(),
    consecutiveFailures: 0,
    lastCache: h.cache ?? s.lastCache,
    lastUpstream: h.upstream ?? s.lastUpstream,
  }));
}

export function recordFailure(message: string): void {
  connectionStore.setState((s) => ({
    ...s,
    lastErrorAt: Date.now(),
    lastError: message,
    consecutiveFailures: s.consecutiveFailures + 1,
  }));
}

export function setClockSkew(serverNow: number): void {
  connectionStore.setState((s) => ({ ...s, clockSkewMs: serverNow - Date.now() }));
}

export function useConnection<T>(select: (s: ConnectionState) => T): T {
  return useSelector(connectionStore, select);
}

export function parseBurrowHeaders(h: Headers): BurrowHeaders {
  const age = h.get("x-burrow-age");
  return {
    api: h.get("x-burrow-api"),
    cache: h.get("x-burrow-cache"),
    upstream: h.get("x-burrow-upstream"),
    ageMs: age == null || Number.isNaN(Number(age)) ? null : Number(age),
    etag: h.get("etag"),
  };
}
