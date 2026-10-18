import { useCallback, useLayoutEffect, useRef } from "react";
import { cn } from "~/lib/cn";
import { fmtInt } from "~/lib/format";
import { useInView } from "~/lib/in-view";
import { useAnimationsEnabled } from "~/state/parity";
import { datumAttrs } from "./datum";
import type { Fmt } from "~/lib/format";

/**
 * Number tween. The visible text eases to the new value; `data-yv` (when `field` is given) is ALWAYS the final raw value.
 * No re-render per frame: the tween writes textContent directly. Off when reduced-motion/parity/offscreen-unmounted.
 *
 * `useLayoutEffect` (not `useEffect`) because React would otherwise paint the final digits for a frame before the tween
 * rewinds to the previous value — the number visibly jumped to the new value and then counted up to it.
 */
export function Ticker({
  value,
  format = fmtInt,
  className,
  field,
  fmt,
  durationMs = 420,
}: {
  value: number | null | undefined;
  format?: (n: number) => string;
  className?: string;
  field?: string;
  fmt?: Fmt;
  durationMs?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef<number | null>(value ?? null);
  const animate = useAnimationsEnabled();
  /* A metric card scrolled out of view has no reader, so its tween is pure cost: offscreen the value is written once
     instead of running a rAF loop per card (the overview alone mounts ~25 of them). */
  const [inViewRef, visible] = useInView<HTMLSpanElement>();

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || value == null) return;
    const from = shown.current;
    if (from == null || from === value || !animate || !visible) {
      shown.current = value;
      el.textContent = format(value);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - (1 - t) ** 3;
      const cur = from + (value - from) * eased;
      shown.current = cur;
      el.textContent = format(t === 1 ? value : Math.round(cur));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, animate, durationMs, format, visible]);

  const setRefs = useCallback(
    (el: HTMLSpanElement | null) => {
      ref.current = el;
      inViewRef.current = el;
    },
    [inViewRef],
  );

  return (
    <span ref={setRefs} className={cn("tnum", className)} {...(field ? datumAttrs(field, value, fmt) : {})}>
      {value == null ? "—" : format(value)}
    </span>
  );
}
