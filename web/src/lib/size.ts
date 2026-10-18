import { useEffect, useRef, useState } from "react";

/**
 * Measured content width of an element, kept in step with layout via a single `ResizeObserver` per element.
 *
 * SVG panes and grid rows need the *pixel* width they are actually drawn into: an SVG with a fixed viewBox stretched to a
 * wider container scales its text with it, and a flex row of fixed-width columns leaves the slack unused.
 */
export function useElementWidth<T extends Element>(fallback = 0): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width ?? 0);
      if (next > 0) setWidth(next);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}
