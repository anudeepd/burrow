/**
 * The freeness primitives — how much room a queue has left, which is the point of this page.
 *
 *  - `CapacityBar`: used / guaranteed share / maxCapacity, all in % of the cluster, with markers at the two limits.
 *  - `FairBar`:     used / min / fair share / max, in MB (Fair has no percentages).
 *
 * Both carry the raw `usedCapacity` (or `usedResources.memory`) datum on the element that encodes it, and the derived
 * freeness readouts use `queue.derived.*` ids (see the scheduler slice report: those need declaring in the inventory).
 */
import { Datum, type DatumAttrs, datumAttrs } from "~/ui/datum";
import { ProgressBar, type ProgressMarker } from "~/ui/progress-bar";
import { cn } from "~/lib/cn";
import type { Tone } from "~/design/status";
import { fmtMB, fmtPct } from "~/lib/format";
import { countText, pctText } from "./format";

const scaleOf = (values: (number | null | undefined)[]): number => {
  let m = 100;
  for (const v of values) if (v != null && Number.isFinite(v) && v > m) m = v;
  return m;
};

function addMarker(markers: ProgressMarker[], percent: number | null, className: string, atTrackEnd = false) {
  if (percent == null || percent > 100 || (percent === 100 && !atTrackEnd) || markers.some((marker) => marker.percent === percent)) return;
  markers.push({ percent, className });
}

export interface CapacityBarProps {
  /** used, % of cluster (`absoluteUsedCapacity`, or `usedCapacity` on the root) */
  usedPct: number | null;
  /** guaranteed share, % of cluster */
  capPct: number | null;
  /** maxCapacity, % of cluster */
  maxPct: number | null;
  tone: Tone;
  label: string;
  /** raw used datum (rule 2) */
  datum: DatumAttrs;
  /** Shared scale across the tree, so bar lengths compare across rows. */
  scale?: number;
  className?: string;
}

export function CapacityBar({ usedPct, capPct, maxPct, tone, label, datum, className, scale: sharedScale }: CapacityBarProps) {
  const scale = Math.max(sharedScale ?? 0, scaleOf([usedPct, capPct, maxPct]));
  const pos = (v: number | null) => (v == null ? null : Math.max(0, Math.min(100, (v / scale) * 100)));
  const markers: ProgressMarker[] = [];
  const capPosition = pos(capPct);
  const maxPosition = pos(maxPct);
  if (capPosition != null && capPosition === maxPosition) {
    markers.push({ percent: capPosition, className: "burrow-progress-marker-overlap" });
  } else {
    addMarker(markers, capPosition, "burrow-progress-marker-guarantee");
    addMarker(markers, maxPosition, "burrow-progress-marker-max", true);
  }
  return (
    <ProgressBar
      percent={pos(usedPct) ?? 0}
      tone={tone}
      live
      label={`${label}: ${pctText(usedPct)} of the cluster used${capPct != null ? `, guaranteed share ${pctText(capPct)}` : ""}${maxPct != null ? `, max ${pctText(maxPct)}` : ""}`}
      valueText={`${pctText(usedPct)} used${capPct != null ? `, guaranteed share ${pctText(capPct)}` : ""}${maxPct != null ? `, max ${pctText(maxPct)}` : ""}`}
      markers={markers}
      className={cn("burrow-thread--headroom w-full min-w-16", className)}
      datum={datum}
    />
  );
}

export interface FairBarProps {
  usedMb: number | null;
  minMb: number | null;
  fairMb: number | null;
  maxMb: number | null;
  tone: Tone;
  label: string;
  datum: DatumAttrs;
  scale?: number;
  className?: string;
}

export function FairBar({ usedMb, minMb, fairMb, maxMb, tone, label, datum, scale: sharedScale, className }: FairBarProps) {
  const scale = Math.max(1, sharedScale ?? 0, usedMb ?? 0, minMb ?? 0, fairMb ?? 0, maxMb ?? 0);
  const pos = (v: number | null) => (v == null ? null : Math.max(0, Math.min(100, (v / scale) * 100)));
  const markers: ProgressMarker[] = [];
  const minPosition = pos(minMb);
  const fairPosition = pos(fairMb);
  const maxPosition = pos(maxMb);
  addMarker(markers, minPosition, "burrow-progress-marker-minimum");
  addMarker(markers, fairPosition, "burrow-progress-marker-fair");
  addMarker(markers, maxPosition, "burrow-progress-marker-max", true);
  return (
    <ProgressBar
      percent={pos(usedMb) ?? 0}
      tone={tone}
      live
      label={`${label}: ${usedMb == null ? "no usage" : fmtMB(usedMb)} used${fairMb != null ? `, fair share ${fmtMB(fairMb)}` : ""}${minMb != null ? `, minimum ${fmtMB(minMb)}` : ""}`}
      valueText={`${usedMb == null ? "no usage" : fmtMB(usedMb)} used${fairMb != null ? `, fair share ${fmtMB(fairMb)}` : ""}${minMb != null ? `, minimum ${fmtMB(minMb)}` : ""}`}
      markers={markers}
      className={cn("burrow-thread--headroom w-full min-w-16", className)}
      datum={datum}
    />
  );
}

/** "38.2% free of its share" — a derived datum, so the harness can normalise it. */
export function FreeReadout({
  freePct,
  freeMb,
  field,
  className,
}: {
  freePct: number | null;
  freeMb: number | null;
  /** derived field id, e.g. `queue.derived.freeGuaranteedPct` */
  field: string;
  className?: string;
}) {
  if (freePct == null && freeMb == null) {
    return <span className={cn("text-ink-4", className)}>—</span>;
  }
  return (
    <span className={cn("inline-flex items-baseline gap-1 tnum", className)}>
      <Datum field={field} raw={freePct ?? freeMb} fmt="pct" className="font-medium text-ink-2">
        {freePct != null ? fmtPct(freePct) : fmtMB(freeMb)}
      </Datum>
      <span className="text-micro text-ink-4">free</span>
    </span>
  );
}

/** Compact used-of-share figure with its datum. */
export function UsedReadout({
  usedPct,
  field,
  raw,
  className,
}: {
  usedPct: number | null;
  field: string;
  raw: unknown;
  className?: string;
}) {
  return (
    <Datum field={field} raw={raw} fmt="pct" className={cn("tnum", className)}>
      {pctText(usedPct)}
    </Datum>
  );
}

export function AppsReadout({
  active,
  pending,
  fieldActive,
  fieldPending,
}: {
  active: number | null;
  pending: number | null;
  fieldActive: string;
  fieldPending: string;
}) {
  return (
    <span className="inline-flex items-baseline gap-1 tnum">
      <Datum field={fieldActive} raw={active} fmt="int" className="text-ink-2">
        {countText(active)}
      </Datum>
      <span className="text-micro text-ink-4">active</span>
      <span className="text-ink-4">·</span>
      <Datum field={fieldPending} raw={pending} fmt="int" className="text-ink-2">
        {countText(pending)}
      </Datum>
      <span className="text-micro text-ink-4">pending</span>
    </span>
  );
}

export { datumAttrs };
