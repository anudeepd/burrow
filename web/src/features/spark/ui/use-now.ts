/**
 * A wall-clock tick shared by live Spark pages (running stage durations, streaming batch ages, the timeline "now" line).
 *
 * One interval per page, not per row: the value is published through a TanStack store so any number of subscribers
 * re-render together. Paused while the tab is hidden and in parity mode (data frozen after first load).
 */
import { createStore, useSelector } from "@tanstack/react-store";
import { useEffect } from "react";
import { useParity } from "~/state/parity";
import { usePref } from "~/state/prefs";

export const nowStore = createStore<{ now: number }>({ now: Date.now() });

const TICK_MS = 1000;

/** Subscribe the page to a 1 s clock; returns epoch-ms. */
export function useNow(): number {
  const parity = useParity();
  const paused = usePref("livePaused");
  useEffect(() => {
    if (parity || paused) return;
    const id = window.setInterval(() => nowStore.setState(() => ({ now: Date.now() })), TICK_MS);
    return () => window.clearInterval(id);
  }, [parity, paused]);
  return useSelector(nowStore, (s) => s.now);
}
