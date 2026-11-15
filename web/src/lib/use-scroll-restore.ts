import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

export const SCROLL_RESTORE_LOCK_MS = 1500;
/** A scroll this soon after a wheel, touch, pointer or key is the user's own. */
export const USER_SCROLL_WINDOW_MS = 150;

/**
 * Restore and persist one scroll container's position across reloads.
 *
 * Live data can reflow the page and move the browser's scroll without input. That
 * movement is not the user's position, so it is never saved and is rolled back.
 */
export function useScrollRestore(ref: RefObject<HTMLElement | null>, key: string, ready: boolean, lockMs: number) {
  const userInteracted = useRef(false);
  const lastUser = useRef(0);
  const applied = useRef(0);
  const lastInteraction = useRef(0);

  useLayoutEffect(() => {
    if (!ready) return;
    const element = ref.current;
    if (!element) return;
    const saved = Number(sessionStorage.getItem(key) ?? "0");
    if (saved <= 0) return;
    lastUser.current = saved;
    applied.current = element.scrollTop;
    const apply = () => {
      if (userInteracted.current) return;
      if (element.scrollTop !== applied.current) return;
      element.scrollTop = saved;
      applied.current = saved;
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
    lastUser.current = saved;
    let locked = saved > 0;
    let frame = 0;
    let pressing = false;
    const release = () => {
      locked = false;
    };
    const interact = () => {
      locked = false;
      userInteracted.current = true;
      lastInteraction.current = performance.now();
    };
    const press = () => {
      pressing = true;
      interact();
    };
    const unpress = () => {
      pressing = false;
    };
    const save = () => {
      const y = element.scrollTop;
      if (locked) {
        if (y !== saved) {
          element.scrollTop = saved;
          applied.current = saved;
        }
        return;
      }
      const own = pressing || performance.now() - lastInteraction.current < USER_SCROLL_WINDOW_MS;
      if (own) {
        lastUser.current = y;
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => sessionStorage.setItem(key, String(y)));
        return;
      }
      if (Math.abs(y - lastUser.current) > 1) {
        element.scrollTop = lastUser.current;
        applied.current = lastUser.current;
      }
    };
    element.addEventListener("scroll", save, { passive: true });
    const interactions = ["wheel", "touchmove", "pointerdown", "keydown"] as const;
    for (const type of interactions) element.addEventListener(type, interact, { passive: true });
    element.addEventListener("pointerdown", press, { passive: true });
    for (const type of ["pointerup", "pointercancel", "touchend", "touchcancel"] as const) {
      element.addEventListener(type, unpress, { passive: true });
    }
    const timer = setTimeout(release, lockMs);
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener("scroll", save);
      for (const type of interactions) element.removeEventListener(type, interact);
      for (const type of ["pointerup", "pointercancel", "touchend", "touchcancel"] as const) {
        element.removeEventListener(type, unpress);
      }
      clearTimeout(timer);
    };
  }, [key, lockMs, ready, ref]);
}
