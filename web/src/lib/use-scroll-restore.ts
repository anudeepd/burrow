import { useEffect, useLayoutEffect, type RefObject } from "react";

/** Restore and persist one scroll container's position across reloads. */
export function useScrollRestore(ref: RefObject<HTMLElement | null>, key: string, ready: boolean) {
  useLayoutEffect(() => {
    if (!ready) return;
    const element = ref.current;
    if (!element) return;
    const saved = Number(sessionStorage.getItem(key) ?? "0");
    if (saved <= 0) return;
    const apply = () => {
      element.scrollTop = saved;
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
    let frame = 0;
    const save = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => sessionStorage.setItem(key, String(element.scrollTop)));
    };
    element.addEventListener("scroll", save, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener("scroll", save);
    };
  }, [key, ready, ref]);
}
