import { cn } from "~/lib/cn";
import type { Tone } from "~/design/status";

/**
 * Used / reserved / total as a ring. `used` and `reserved` are absolute numbers in the same unit as `total`.
 * Centre shows the used percentage; the accessible name carries the absolute numbers.
 *
 * Both arcs tween `stroke-dashoffset` (the short-path SVG exception in DESIGN §5.5.2 — `stroke-dasharray` is not
 * interpolable across a length change, `dashoffset` is), so the reserved arc cannot snap while the used arc eases.
 */
export function ResourceRing({
  used,
  reserved = 0,
  total,
  size = 72,
  stroke = 7,
  tone = "live",
  label,
  centre,
  className,
}: {
  used: number;
  reserved?: number;
  total: number;
  size?: number;
  stroke?: number;
  tone?: Tone;
  label: string;
  centre?: React.ReactNode;
  className?: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const frac = (n: number) => (total > 0 && Number.isFinite(total) && Number.isFinite(n) ? Math.max(0, Math.min(1, n / total)) : 0);
  const u = frac(used);
  const rv = Math.min(frac(reserved), 1 - u);
  const usedPct = total > 0 && Number.isFinite(total) && Number.isFinite(used) ? Math.max(0, (used / total) * 100) : 0;
  return (
    <div
      role="img"
      aria-label={`${label}: ${usedPct.toFixed(0)}% used`}
      className={cn("relative inline-grid shrink-0 place-items-center", `burrow-tone-${tone}`, className)}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--seam)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--tone)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c - u * c}
          style={{ transition: "stroke-dashoffset var(--dur-base) var(--ease-in-out)" }}
        />
        {rv > 0 && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="var(--wait)"
            strokeWidth={stroke}
            strokeDasharray={`${rv * c - 2} ${c}`}
            strokeDashoffset={-u * c}
            opacity="0.85"
            style={{ transition: "stroke-dashoffset var(--dur-base) var(--ease-in-out)" }}
          />
        )}
      </svg>
      <div className="absolute inset-0 grid place-items-center text-small font-semibold tnum">{centre ?? `${(u * 100).toFixed(0)}%`}</div>
    </div>
  );
}
