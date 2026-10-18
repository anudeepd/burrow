/**
 * Parity mode (docs/contracts/parity-dom.md §Parity mode).
 *
 * Enabled by `?parity=1` on any route or `window.__BURROW_PARITY__ = true` set before load. Decided ONCE per page load and kept for
 * the page lifetime (client-side navigation drops the query string, parity must not flip mid-crawl).
 * Effects, all implemented by consumers of this store:
 *  - DataTable: every column visible, no virtualization window, no pagination (render all rows)  -> useParity() in DataTable
 *  - animations/transitions disabled (CSS: html[data-parity]; JS tweens: useAnimationsEnabled())
 *  - auto-refresh disabled: refetchInterval=false, staleTime=Infinity, no SSE                       -> api/refetch.ts, api/events.ts
 *  - collapsible panels holding data open themselves                                                -> <ParityOpen>/useParityOpen()
 */
import { createStore, useSelector } from "@tanstack/react-store";

declare global {
  interface Window {
    __BURROW_PARITY__?: boolean;
    __BURROW_STRICT_SCHEMAS__?: boolean;
  }
}

function detect(): boolean {
  if (typeof window === "undefined") return false;
  if (window.__BURROW_PARITY__ === true) return true;
  const v = new URLSearchParams(window.location.search).get("parity");
  return v === "1" || v === "true";
}

export const parityStore = createStore<{ enabled: boolean }>({ enabled: detect() });

if (typeof document !== "undefined" && parityStore.get().enabled) {
  document.documentElement.setAttribute("data-parity", "1");
}

/** Imperative read for non-React code (query options, SSE). */
export function isParity(): boolean {
  return parityStore.get().enabled;
}

export function useParity(): boolean {
  return useSelector(parityStore, (s) => s.enabled);
}

/** Tweens, springs, count-ups and any JS-driven motion must be gated on this. */
export function useAnimationsEnabled(): boolean {
  const parity = useParity();
  const reduced = useSelector(prefsMotionProbe, (s) => s.reduced);
  return !parity && !reduced;
}

// Small standalone store so parity.ts does not import prefs.ts (prefs imports parity). prefs.ts feeds it.
export const prefsMotionProbe = createStore<{ reduced: boolean }>({ reduced: false });
