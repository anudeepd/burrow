/** User preferences: theme, time zone and live-refresh behaviour. Persisted to localStorage; applied to <html>. */
import { createStore, useSelector } from "@tanstack/react-store";
import { prefsMotionProbe } from "./parity";

export type Theme = "system" | "dark" | "light";
export type TimeZoneMode = "local" | "utc";
export type MotionPref = "system" | "reduced";

export interface Prefs {
  theme: Theme;
  tz: TimeZoneMode;
  motion: MotionPref;
  /** polling cadence while live data is changing; "off" is expressed by livePaused. */
  liveIntervalMs: number;
  livePaused: boolean;
  railCollapsed: boolean;
}

export const LIVE_INTERVALS = [1000, 2000, 3000, 5000, 10000, 30000] as const;

const KEY = "burrow.prefs.v1";
/**
 * The defaults the **server** renders with (it cannot read `localStorage`). Anything that renders a pref during the
 * first client paint must render this value instead and swap after `useMounted()` — otherwise React #418.
 */
export const PREF_DEFAULTS: Prefs = {
  theme: "system",
  tz: "local",
  motion: "system",
  liveIntervalMs: 3000,
  livePaused: false,
  railCollapsed: false,
};
const DEFAULTS = PREF_DEFAULTS;

function load(): Prefs {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? "{}") as Partial<Prefs> & { density?: unknown };
    delete raw.density;
    return { ...DEFAULTS, ...raw };
  } catch {
    return DEFAULTS;
  }
}

export const prefsStore = createStore<Prefs>(load());

export function setPrefs(patch: Partial<Prefs>): void {
  prefsStore.setState((p) => ({ ...p, ...patch }));
}

export function usePref<K extends keyof Prefs>(key: K): Prefs[K] {
  return useSelector(prefsStore, (s) => s[key]);
}

export function resolvedTheme(theme: Theme): "dark" | "light" {
  if (theme !== "system") return theme;
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/**
 * Theme flips every colour in one frame, so the transition lock prevents the palette from smearing while it changes.
 * Motion here is not an affordance, it is an artifact, so this is not the reduced-motion gate's business.
 */
function withSwitchLock(changed: boolean, write: () => void): void {
  const el = document.documentElement;
  if (changed) el.setAttribute("data-switching", "1");
  write();
  if (!changed) return;
  requestAnimationFrame(() => requestAnimationFrame(() => el.removeAttribute("data-switching")));
}

export function applyPrefsToDom(p: Prefs): void {
  if (typeof document === "undefined") return;
  const el = document.documentElement;
  const theme = resolvedTheme(p.theme);
  const switched = el.getAttribute("data-theme") !== theme;
  withSwitchLock(switched, () => {
    el.setAttribute("data-theme", theme);
    el.setAttribute("data-theme-pref", p.theme);
    el.removeAttribute("data-density");
    el.setAttribute("data-tz", p.tz);
    // mirror of the rail pref for the pre-paint CSS hook (`public/theme-init.js` sets the same attribute on boot)
    if (p.railCollapsed) el.setAttribute("data-rail-collapsed", "true");
    else el.removeAttribute("data-rail-collapsed");
  });
  const osReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const reduced = p.motion === "reduced" || osReduced;
  if (p.motion === "reduced") el.setAttribute("data-motion", "reduced");
  else el.removeAttribute("data-motion");
  prefsMotionProbe.setState(() => ({ reduced }));
}

if (typeof window !== "undefined") {
  applyPrefsToDom(prefsStore.get());
  prefsStore.subscribe((p) => {
    applyPrefsToDom(p);
    try {
      window.localStorage.setItem(KEY, JSON.stringify(p));
    } catch {
      /* storage unavailable (private mode): prefs stay session-local */
    }
  });
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => applyPrefsToDom(prefsStore.get()));
  window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", () => applyPrefsToDom(prefsStore.get()));
}
