import { useEffect, useRef, type RefObject } from "react";
import { EASE_OUT, motionAllowed, tokenMs } from "~/lib/motion";

/** Pulse on successful responses at the selected cadence without canceling it on intervening responses. */
export function useResponsePulse(dot: RefObject<HTMLSpanElement | null>, lastOkAt: number | null, interval: number): void {
  const seenOkAt = useRef<number | null>(null);
  const lastPulseAt = useRef<number | null>(null);
  const animation = useRef<Animation | null>(null);

  useEffect(() => {
    const node = dot.current;
    if (!node || lastOkAt === null || lastOkAt === seenOkAt.current) return;
    seenOkAt.current = lastOkAt;
    // SSE can refresh more often than polling; keep this cue on the user-selected cadence.
    if (lastPulseAt.current !== null && lastOkAt - lastPulseAt.current < interval) return;
    lastPulseAt.current = lastOkAt;
    if (!motionAllowed()) return;

    // A suppressed response must not cancel the active animation. Cancel only when another pulse starts.
    animation.current?.cancel();
    animation.current = node.animate(
      [
        { transform: "scale(.75)", boxShadow: "0 0 0 0 color-mix(in oklch, var(--live) 42%, transparent)" },
        { transform: "scale(1)", boxShadow: "0 0 0 6px transparent" },
      ],
      { duration: tokenMs(node, "--dur-flash", 900), easing: EASE_OUT },
    );
  }, [dot, interval, lastOkAt]);

  useEffect(
    () => () => {
      animation.current?.cancel();
      animation.current = null;
    },
    [],
  );
}
