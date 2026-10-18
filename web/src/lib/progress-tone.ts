import type { Tone } from "~/design/status";

/** Queue pressure as percent of its guaranteed/fair share. */
export function pressureTone(percent: number | null | undefined): Tone {
  if (percent == null || Number.isNaN(percent)) return "idle";
  if (percent > 150) return "fail";
  if (percent > 100.01) return "warn";
  if (percent >= 85) return "wait";
  if (percent >= 50) return "live";
  return "ok";
}

/** Resource utilization as percent of available capacity. */
export function utilizationTone(percent: number | null | undefined): Tone {
  if (percent == null || !Number.isFinite(percent)) return "idle";
  if (percent > 100) return "fail";
  if (percent >= 85) return "warn";
  if (percent >= 50) return "live";
  return "ok";
}
