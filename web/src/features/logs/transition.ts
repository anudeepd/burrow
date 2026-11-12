/**
 * A scoped view transition for the container-log pane.
 *
 * The old and new log are two complete snapshots of the same pane, so a file switch or a wrap reflow crossfades
 * without animating layout properties or every row. The root page stays still. When the platform cannot run a view
 * transition, or motion is gated off, the update is applied directly and the caller can add its opacity fallback.
 */
import { flushSync } from "react-dom";
import { motionAllowed } from "~/lib/motion";

interface LogTransition {
  finished: Promise<void>;
}
type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => LogTransition;
};

/** Returns true when the browser took the crossfade. The update always runs exactly once. */
export function withLogPaneTransition(pane: HTMLElement | null, update: () => void): boolean {
  if (!pane || !motionAllowed()) {
    update();
    return false;
  }
  const doc = document as ViewTransitionDocument;
  if (typeof doc.startViewTransition !== "function") {
    update();
    return false;
  }
  let applied = false;
  const run = () => {
    applied = true;
    flushSync(update);
  };
  pane.style.viewTransitionName = "burrow-log-pane";
  try {
    const transition = doc.startViewTransition(run);
    const clear = () => {
      pane.style.viewTransitionName = "";
    };
    void transition.finished.then(clear, clear);
    return true;
  } catch {
    pane.style.viewTransitionName = "";
    if (!applied) update();
    return false;
  }
}
