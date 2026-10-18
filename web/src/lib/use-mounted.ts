/**
 * "Has the client taken over yet?" — the one supported way to render something the *server* cannot know.
 *
 * The shell is server-rendered (TanStack Start prerenders it and serves that HTML for every route), while user
 * preferences live in `localStorage`. A pref that changes the client's **first** render — markup, text, or even an
 * attribute — does not line up with the server's HTML: React throws #418, throws the tree away and rebuilds it (an
 * uncaught error on every load), and for attributes it simply *keeps the server's value*, so a collapsed rail would
 * render expanded forever.
 *
 * So two mechanisms, in this order:
 *
 * 1. **Pre-paint, by CSS**: anything that must look right *before* the bundle loads is mirrored onto `<html>` by
 *    `public/theme-init.js` (theme, motion, the rail's collapsed width) and consumed by CSS. `applyPrefsToDom`
 *    keeps those attributes in sync at runtime.
 * 2. **After mount, by `useMounted()`**: JS values (timestamp text, a select's label, a control that only exists for a
 *    pref) render the *default* on the server and the first client pass, then the real value. The flip happens in a
 *    layout effect, so it lands in the same painted frame — no flash — and hydration never sees a difference.
 */
import { useEffect, useLayoutEffect, useState } from "react";

/** `useLayoutEffect` on the client, `useEffect` on the server (where layout effects do not run and would warn). */
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useIsomorphicLayoutEffect(() => {
    setMounted(true);
  }, []);
  return mounted;
}
