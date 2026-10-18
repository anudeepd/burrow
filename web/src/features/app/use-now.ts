/**
 * A clock that ticks only while something on screen is live.
 *
 * Elapsed durations must advance for a running application/attempt, but a frozen clock in parity mode and no timer for
 * finished entities. Ticks *data* (not an animation), so `prefers-reduced-motion` does not disable it; parity does.
 */
import { useEffect, useState } from "react";
import { isParity } from "~/state/parity";

export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || isParity()) return;
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [active, intervalMs]);
  return now;
}
