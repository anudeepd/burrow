import { cn } from "~/lib/cn";
import { useInView } from "~/lib/in-view";
import { type StatusDomain, type StatusSpec, statusSpec } from "~/design/status";
import { Datum } from "./datum";
import { Tooltip } from "./tooltip";
import { STATUS_GLYPH_SHAPES } from "./status-glyph";

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
        {STATUS_GLYPH_SHAPES[spec.shape]}
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
