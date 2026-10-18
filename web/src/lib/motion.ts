/**
 * The JS half of the motion policy (the CSS half lives in `styles/app.css`, DESIGN §5).
 *
 * One policy, with a tier-3 exception: parity disables every JS animation; movement/feedback also obey reduced motion.
 * CSS state fades use `--dur-fade`; tab-content WAAPI fades use `--dur-content` so they stay in sync with CSS panels.
 * `fadeIn()` remains an opacity-only bridge and survives reduced motion through the content token's fallback.
 *
 * `flash()` is the shared "this value just changed" cue used by data-table rows: a live-tinted overlay fades from 0.5
 * to 0, timed by `--dur-flash`, so the token and the code cannot drift apart.
 */
import { isParity } from "~/state/parity";

const REDUCE_QUERY = "(prefers-reduced-motion: reduce)";

/** The OS setting alone (the in-app toggle is read from `<html data-motion>`). */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(REDUCE_QUERY).matches;
}

/** True when JS motion beyond the Tier-3 opacity fade may run: no parity mode or reduced-motion preference. */
export function motionAllowed(): boolean {
  if (typeof document === "undefined") return false;
  if (isParity() || prefersReducedMotion()) return false;
  return document.documentElement.dataset.motion !== "reduced";
}

/** The strong ease-out every entrance in this product uses (`--ease-out` in tokens.css). */
export const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";

/** Resolve CSS time tokens (`ms` or `s`) to milliseconds; falls back when the token is missing or unsupported. */
export function tokenMs(el: Element | null, token: string, fallback: number): number {
  if (!el || typeof getComputedStyle !== "function") return fallback;
  const value = getComputedStyle(el).getPropertyValue(token);
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount)) return fallback;
  if (value.endsWith("ms")) return amount;
  if (value.endsWith("s")) return amount * 1000;
  return fallback;
}
/** Fade changed tab content in place; `from` preserves opacity when a switch retargets in flight. */
export function fadeIn(el: Element | null, from = 0): Animation | undefined {
  if (!el || isParity() || typeof el.animate !== "function") return undefined;
  const duration = tokenMs(el, "--dur-content", 220);
  if (duration <= 0) return undefined;
  return el.animate([{ opacity: from }, { opacity: 1 }], { duration, easing: EASE_OUT });
}

/** The row/line change cue: overlay opacity 0.5 → 0 over `--dur-flash`. No-op when motion is off. */
export function flash(el: Element | null): Animation | undefined {
  if (!el || !motionAllowed()) return undefined;
  if (typeof el.animate !== "function") return undefined; // jsdom and other DOM shims have no WAAPI
  const duration = tokenMs(el, "--dur-flash", 900);
  if (duration <= 0) return undefined;
  return el.animate([{ opacity: 0.5 }, { opacity: 0 }], { duration, easing: EASE_OUT });
}
