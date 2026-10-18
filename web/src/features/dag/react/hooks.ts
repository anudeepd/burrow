/**
 * Small React hooks shared by the DAG renderer.
 *  - `useElementSize`: ResizeObserver-backed pane size (the DAG fills its container, never the window).
 *  - `useMotion`: reduced-motion / parity gate (`useAnimationsEnabled` already folds OS + user pref + parity mode).
 *  - `useSampleClock`: throttled "now" for durations, paused when the tab is hidden so a background tab does not
 *    schedule rAF work.
 *  - `useRafValue`: rAF-coalesced state for high-frequency inputs (pan/zoom), so a 240 Hz trackpad cannot outrun React.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAnimationsEnabled } from "~/state/parity";

export interface ElementSize {
  width: number;
  height: number;
}

/** Tuple returned by `useElementSize`; named so callers can type a wrapper prop with it. */
export type ElementSizeRef<T extends Element> = [React.RefObject<T | null>, ElementSize];

export function useElementSize<T extends Element>(): ElementSizeRef<T> {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });
  // Runs once (plus on window resize when ResizeObserver is missing). It used to have no dependency array, so every
  // render called getBoundingClientRect() — and on a DAG that is 66 000 px wide that forces a synchronous layout of the
  // whole SVG, which is exactly the kind of cost that shows up as a frame-time floor rather than a tick spike.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => {
      const rect = el.getBoundingClientRect();
      setSize((prev) =>
        Math.abs(prev.width - rect.width) < 0.5 && Math.abs(prev.height - rect.height) < 0.5
          ? prev
          : { width: rect.width, height: rect.height },
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

/** True when motion is allowed (no OS reduced-motion, no user pref, not parity mode). */
export function useMotion(): boolean {
  return useAnimationsEnabled();
}

/** "now" that only ticks while the tab is visible; `intervalMs` 0 disables the clock entirely. */
export function useSampleClock(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs <= 0) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = (): void => {
      if (timer !== null) return;
      timer = setInterval(() => setNow(Date.now()), intervalMs);
    };
    const stop = (): void => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") {
        setNow(Date.now());
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs]);
  return now;
}

/** Coalesce high-frequency updates to one per animation frame. Returns the latest accepted value. */
export function useRafValue<T>(value: T): T {
  const [settled, setSettled] = useState(value);
  const pending = useRef(value);
  const frame = useRef(0);
  useEffect(() => {
    pending.current = value;
    if (frame.current !== 0) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      setSettled(pending.current);
    });
  }, [value]);
  useEffect(
    () => () => {
      if (frame.current !== 0) {
        cancelAnimationFrame(frame.current);
        // Clearing the marker matters: it is the "a frame is already scheduled" flag for the effect above, and an
        // effect remount (StrictMode's mount/unmount/mount, or any Suspense retry) cancels the frame without ever
        // running its callback. Left set, every later value change bails and the pane is stuck on its first value —
        // the DAG opened at 1:1 from the origin and pan/zoom/fit silently did nothing.
        frame.current = 0;
      }
    },
    [],
  );
  return settled;
}

/** Media query watcher with SSR-safe default. */
export function useMediaQuery(query: string, fallback = false): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined" || typeof window.matchMedia !== "function" ? fallback : window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const onChange = (): void => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}
