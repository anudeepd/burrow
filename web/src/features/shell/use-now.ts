import { useEffect, useState } from "react";
import { usePref } from "~/state/prefs";

/**
 * A clock that only ticks while the UI is live: paused (or hidden) means the "updated 3s ago" readouts stop instead of
 * quietly drifting. Returns epoch ms.
 */
export function useNow(intervalMs = 1000): number {
  const paused = usePref("livePaused");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (paused) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [paused, intervalMs]);
  return now;
}
