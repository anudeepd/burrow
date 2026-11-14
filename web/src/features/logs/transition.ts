/**
 * A pane replacement animation for the container-log viewer.
 *
 * The old log is cloned into a fixed, inert overlay before React commits the new window or wrap layout. The clone
 * contributes only its rows; the live pane keeps the opaque well background. The old rows dissolve out while the new
 * rows dissolve in over that one constant surface. Only the rows animate, because fading the pane itself lets the page
 * behind flash through, and dimming the rows to empty reads as a blink. A View Transition snapshot pair would be less
 * code, but Chrome paints the updated live pane for a frame before the pseudo tree is ready; dense log text then
 * flashes the new layout before the fade. The clone is taken in the same task as the update, before that paint, so it
 * cannot flash.
 *
 * The update is flushed synchronously so the new layout is final before the rows start dissolving; callers must
 * therefore invoke this outside a React render or lifecycle (an event handler, or a microtask scheduled from an effect).
 *
 * `rise` is the entrance offset for the new rows: the house 4px for a file switch, 0 for a wrap reflow that keeps the
 * reader's line still. When motion is gated off or WAAPI is unavailable, the update is applied directly and the caller
 * can add its opacity fallback.
 */
import { flushSync } from "react-dom";
import { EASE_OUT, cancelAnimation, motionAllowed, tokenMs } from "~/lib/motion";

/** Marks the temporary old-content overlay; also the test seam for "a pane transition ran". */
export const LOG_PANE_GHOST = "data-log-pane-ghost";
export interface LogPaneTransitionOptions {
  /** Entrance offset for the new rows; 0 for a reflow of the same lines. */
  rise?: number;
}

interface ActiveTransition {
  host: HTMLElement;
  animations: Animation[];
}
/** The newest transition owns the overlay; a retarget removes the previous ghost instead of stacking them. */
let active: ActiveTransition | null = null;

function clearActive(): void {
  if (!active) return;
  const { host, animations } = active;
  active = null;
  host.remove();
  for (const animation of animations) cancelAnimation(animation);
}

/** Returns true when the browser took the fade-through. The update always runs exactly once. */
export function withLogPaneTransition(pane: HTMLElement | null, update: () => void, { rise = 0 }: LogPaneTransitionOptions = {}): boolean {
  if (!pane?.isConnected || !motionAllowed() || typeof pane.animate !== "function") {
    update();
    return false;
  }
  const durationMs = tokenMs(pane, "--dur-content", 220);
  if (durationMs <= 0) {
    update();
    return false;
  }

  const rect = pane.getBoundingClientRect();
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.setAttribute(LOG_PANE_GHOST, "");
  host.inert = true;
  host.style.position = "fixed";
  host.style.left = `${rect.left}px`;
  host.style.top = `${rect.top}px`;
  host.style.width = `${rect.width}px`;
  host.style.height = `${rect.height}px`;
  host.style.overflow = "hidden";
  host.style.pointerEvents = "none";
  // Cover pane content and its sticky chip, but leave the topbar, popovers, toasts and tooltips above it.
  host.style.zIndex = "10";
  const ghost = pane.cloneNode(true) as HTMLElement;
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  // The live pane keeps the opaque well background. The ghost only contributes old rows, so both row layers can
  // dissolve over one constant surface instead of fading the surface itself.
  ghost.style.backgroundColor = "transparent";
  host.append(ghost);
  document.body.append(host);
  ghost.scrollTop = pane.scrollTop;
  ghost.scrollLeft = pane.scrollLeft;

  clearActive();
  const animations: Animation[] = [];
  try {
    flushSync(update);
    if (!pane.isConnected) {
      host.remove();
      return true;
    }
    // The live well stays opaque under both row layers. A complementary dissolve keeps the visible row opacity constant:
    // the old rows never dim to empty and the new layout never appears as a flash.
    const ghostContent = (ghost.firstElementChild as HTMLElement | null) ?? ghost;
    const content = (pane.firstElementChild as HTMLElement | null) ?? pane;
    animations.push(ghostContent.animate([{ opacity: 1 }, { opacity: 0 }], { duration: durationMs, easing: EASE_OUT, fill: "both" }));
    animations.push(
      content.animate(
        rise
          ? [
              { opacity: 0, transform: `translateY(${rise}px)` },
              { opacity: 1, transform: "translateY(0)" },
            ]
          : [{ opacity: 0 }, { opacity: 1 }],
        { duration: durationMs, easing: EASE_OUT, fill: "both" },
      ),
    );
  } catch (error) {
    for (const animation of animations) cancelAnimation(animation);
    host.remove();
    throw error;
  }

  const current: ActiveTransition = { host, animations };
  active = current;
  // Both row layers finish together; the host is gone once its transparent background and old rows are done.
  void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
    if (active !== current) return;
    active = null;
    host.remove();
    for (const animation of animations) cancelAnimation(animation);
  });
  return true;
}
