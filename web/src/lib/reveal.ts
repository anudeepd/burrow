import { motionAllowed } from "./motion";

const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

/** Notify the caller when a person takes control of a scrollport while an automatic reveal is in progress. */
export function onUserScrollIntent(scrollport: HTMLElement, onIntent: () => void): () => void {
  const onWheel = (event: WheelEvent) => {
    if (event.deltaX !== 0 || event.deltaY !== 0) onIntent();
  };
  const onTouchMove = () => onIntent();
  const onPointerDown = (event: PointerEvent) => {
    // A scrollbar drag targets the scrollport itself; ignore clicks on its content.
    if (event.target === scrollport) onIntent();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!SCROLL_KEYS.has(event.key)) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("input, textarea, select, [contenteditable='true'], [role='combobox']")) return;
    onIntent();
  };

  scrollport.addEventListener("wheel", onWheel, { passive: true });
  scrollport.addEventListener("touchmove", onTouchMove, { passive: true });
  scrollport.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("keydown", onKeyDown, true);

  return () => {
    scrollport.removeEventListener("wheel", onWheel);
    scrollport.removeEventListener("touchmove", onTouchMove);
    scrollport.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("keydown", onKeyDown, true);
  };
}

/**
 * Bring the detail pane into view after a click opened it.
 *
 * Below `xl` the pane sits under the list, so a click that only sets the selection looks like it did nothing. At `xl` and
 * wider the pane is beside the list already, and scrolling to it would be noise.
 *
 * The glide is motion, so it obeys the same policy as everything else: reduced motion and parity jump instead of easing
 * (an explicit `behavior: "smooth"` overrides `scroll-behavior: auto`, so the CSS gate cannot do this for us).
 */
export function revealDetail(root: ParentNode = document): void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  if (window.matchMedia("(min-width: 1280px)").matches) return;
  const element = root.querySelector("[data-burrow-detail]");
  if (!element) return;
  const animate = motionAllowed();
  requestAnimationFrame(() => element.scrollIntoView({ block: "start", behavior: animate ? "smooth" : "auto" }));
}
