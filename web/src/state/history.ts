/** Client-sampled utilisation history (session-local; PLAN non-goal: no server-side history). Fed from /yarn/metrics updates. */
import { createStore, useSelector } from "@tanstack/react-store";

export interface UtilSample {
  t: number;
  memPct: number;
  vcorePct: number;
  appsRunning: number;
  appsPending: number;
  containers: number;
}

const CAP = 900;
export const historyStore = createStore<{ samples: UtilSample[] }>({ samples: [] });

export function pushSample(s: UtilSample): void {
  historyStore.setState(({ samples }) => {
    const last = samples[samples.length - 1];
    if (last && s.t - last.t < 500) return { samples };
    const next = samples.length >= CAP ? samples.slice(samples.length - CAP + 1) : samples.slice();
    next.push(s);
    return { samples: next };
  });
}

export function useUtilisation(): UtilSample[] {
  return useSelector(historyStore, (s) => s.samples);
}
