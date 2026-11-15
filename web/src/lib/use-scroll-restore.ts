import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

export const SCROLL_RESTORE_LOCK_MS = 1500;

/** Restore and persist one scroll container's position across reloads. */
export function useScrollRestore(ref: RefObject<HTMLElement | null>, key: string, ready: boolean, lockMs: number) {
  const userInteracted = useRef(false);
  useLayoutEffect(() => {
    if (!ready) return;
    const element = ref.current;
    if (!element) return;
    const saved = Number(sessionStorage.getItem(key) ?? "0");
    if (saved <= 0) return;
    const apply = () => {
      if (!userInteracted.current) element.scrollTop = saved;
    };
    apply();
    const frame = requestAnimationFrame(apply);
    const timer = setTimeout(apply, 350);
    const fonts = document.fonts;
    if (fonts) void fonts.ready.then(() => requestAnimationFrame(apply));
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [key, ready, ref]);

  useEffect(() => {
    if (!ready) return;
    const element = ref.current;
    if (!element) return;
    const saved = Number(sessionStorage.getItem(key) ?? "0");
    let locked = saved > 0;
    let frame = 0;
    const release = () => {
      locked = false;
    };
    const interact = () => {
      locked = false;
      userInteracted.current = true;
    };
    const save = () => {
      if (locked) {
        if (element.scrollTop !== saved) element.scrollTop = saved;
        return;
      }
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => sessionStorage.setItem(key, String(element.scrollTop)));
    };
    element.addEventListener("scroll", save, { passive: true });
    const interactions = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    for (const type of interactions) element.addEventListener(type, interact, { passive: true });
    const timer = setTimeout(release, lockMs);
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener("scroll", save);
      for (const type of interactions) element.removeEventListener(type, interact);
      clearTimeout(timer);
    };
  }, [key, lockMs, ready, ref]);
}
