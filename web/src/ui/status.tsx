import { cn } from "~/lib/cn";
import { useInView } from "~/lib/in-view";
import { type StatusDomain, type Shape, type StatusSpec, statusSpec } from "~/design/status";
import { Datum } from "./datum";
import { Tooltip } from "./tooltip";

const SHAPES: Record<Shape, React.ReactNode> = {
  disc: <circle cx="5" cy="5" r="3.6" fill="currentColor" />,
  ring: <circle cx="5" cy="5" r="3.1" fill="none" stroke="currentColor" strokeWidth="1.6" />,
  "ring-dash": <circle cx="5" cy="5" r="3.1" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 1.6" />,
  half: (
    <>
      <circle cx="5" cy="5" r="3.1" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5 1.9a3.1 3.1 0 0 1 0 6.2z" fill="currentColor" />
    </>
  ),
  square: <rect x="1.8" y="1.8" width="6.4" height="6.4" rx="1.3" fill="currentColor" />,
  diamond: <path d="M5 .9 9.1 5 5 9.1.9 5z" fill="currentColor" />,
  cross: <path d="m2.4 2.4 5.2 5.2m0-5.2-5.2 5.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />,
  slash: (
    <>
      <circle cx="5" cy="5" r="3.1" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2.8 7.2 7.2 2.8" stroke="currentColor" strokeWidth="1.4" />
    </>
  ),
  dash: <path d="M2 5h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />,
  triangle: <path d="M5 1.4 9.1 8.6H.9z" fill="currentColor" strokeLinejoin="round" stroke="currentColor" strokeWidth=".6" />,
  check: <path d="m2 5.3 2 2 4-4.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />,
};

/** 10px glyph: tone via colour, identity via shape, and optional motion per status semantics. */
export function StatusDot({
  domain,
  state,
  className,
  label = true,
}: {
  domain: StatusDomain;
  state: string | null | undefined;
  className?: string;
  label?: boolean;
}) {
  const spec = statusSpec(domain, state);
  const [ref, visible] = useInView<HTMLSpanElement>();
  return (
    <span
      ref={ref}
      role={label ? "img" : undefined}
      aria-label={label ? spec.label : undefined}
      aria-hidden={label ? undefined : true}
      data-visible={visible}
      className={cn(
        "relative inline-flex size-2.5 shrink-0 items-center justify-center text-(--tone)",
        `burrow-tone-${spec.tone}`,
        spec.motion === "pulse" && "burrow-dot-pulse",
        className,
      )}
    >
      <svg viewBox="0 0 10 10" className="relative size-full" aria-hidden="true">
        {SHAPES[spec.shape]}
      </svg>
    </span>
  );
}

export interface StatusPillProps {
  domain: StatusDomain;
  state: string | null | undefined;
  /** parity: field id + raw value to stamp. When provided the pill IS the datum. */
  field?: string;
  size?: "sm" | "md";
  className?: string;
  /** override the label (still stamped with the raw value) */
  children?: React.ReactNode;
  /** raw API value when `state` is a normalized status key */
  raw?: unknown;
  /** Optional extra context for this state, such as the timestamp it was last reported. */
  tooltipLabel?: React.ReactNode;
}

function PillBody({
  spec,
  size,
  visible,
  children,
}: {
  spec: StatusSpec;
  size: "sm" | "md";
  visible: boolean;
  children?: React.ReactNode;
}) {
  const Icon = spec.icon;
  return (
    <>
      {/* status motion rides on the leading icon and shares the same visibility gate as the dot */}
      <span className={cn("relative inline-flex shrink-0", spec.motion === "pulse" && "burrow-dot-pulse")} data-visible={visible}>
        <Icon className={size === "sm" ? "size-3" : "size-3.5"} aria-hidden="true" strokeWidth={2.25} />
      </span>
      <span className="truncate">{children ?? spec.label}</span>
    </>
  );
}

export function StatusPill({ domain, state, field, size = "md", className, children, raw, tooltipLabel }: StatusPillProps) {
  const spec = statusSpec(domain, state);
  const [ref, visible] = useInView<HTMLSpanElement>();
  const cls = cn(
    "burrow-pill relative inline-flex max-w-full items-center gap-1 rounded-full font-medium leading-none",
    size === "sm" ? "h-[18px] px-1.5 text-micro" : "h-5 px-2 text-caption",
    `burrow-tone-${spec.tone}`,
    spec.motion === "drain" && "burrow-drain",
    spec.tone === "idle" && "border-dashed",
    className,
  );
  if (field) {
    return (
      <Tooltip label={tooltipLabel ?? spec.hint}>
        <Datum
          ref={ref}
          data-visible={visible}
          field={field}
          raw={raw === undefined ? state : raw}
          fmt="text"
          className={cls}
          data-tone={spec.tone}
        >
          <PillBody spec={spec} size={size} visible={visible}>
            {children}
          </PillBody>
        </Datum>
      </Tooltip>
    );
  }
  return (
    <Tooltip label={tooltipLabel ?? spec.hint}>
      <span ref={ref} data-visible={visible} className={cls} data-tone={spec.tone}>
        <PillBody spec={spec} size={size} visible={visible}>
          {children}
        </PillBody>
      </span>
    </Tooltip>
  );
}
