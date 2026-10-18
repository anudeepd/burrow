import type { ButtonHTMLAttributes, Ref } from "react";
import { cn } from "~/lib/cn";
import { OptionalTooltip } from "~/ui/tooltip";

type Variant = "default" | "primary" | "ghost" | "quiet";
type Size = "sm" | "md" | "icon" | "icon-sm";

const VARIANTS: Record<Variant, string> = {
  default: "bg-fabric-2 text-ink border-seam-strong hover:bg-fabric-3",
  primary: "bg-live text-on-live border-transparent hover:brightness-110",
  ghost: "bg-transparent text-ink-2 border-transparent hover:bg-fabric-3 hover:text-ink",
  quiet: "bg-transparent text-ink-3 border-seam hover:bg-fabric-3 hover:text-ink",
};
const SIZES: Record<Size, string> = {
  sm: "h-[calc(var(--ctl-h)-4px)] px-2 text-small gap-1.5",
  md: "h-(--ctl-h) px-2.5 text-body gap-2",
  icon: "size-(--ctl-h) justify-center",
  "icon-sm": "size-[calc(var(--ctl-h)-4px)] justify-center",
};

/** Anchor styled as a control for page actions and back navigation. Keep in sync with Button's default variant/md size. */
export const ACTION_LINK_CLASS =
  "inline-flex h-(--ctl-h) shrink-0 select-none items-center gap-2 whitespace-nowrap rounded-md border border-seam-strong bg-fabric-2 px-2.5 font-medium text-body text-ink transition-[background-color,color,transform,filter] duration-(--dur-fast) ease-(--ease-out) hover:bg-fabric-3 motion-safe:motion-ok:active:scale-[0.97]";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({ variant = "default", size = "md", className, type = "button", title, ...props }: ButtonProps) {
  const button = (
    <button
      type={type}
      className={cn(
        "burrow-control inline-flex shrink-0 select-none items-center whitespace-nowrap rounded-md border font-medium",
        (size === "icon" || size === "icon-sm") && "burrow-control--icon",
        // press feedback is movement, so it is gated: reduced motion keeps the colour change and drops the 3% scale
        "transition-[background-color,color,transform,filter] duration-(--dur-fast) ease-(--ease-out) motion-safe:motion-ok:active:scale-[0.97]",
        "disabled:pointer-events-none disabled:opacity-45 aria-disabled:opacity-45",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  );
  if (!title) return button;

  // Native disabled buttons do not receive pointer events. Keep a small wrapper as the tooltip trigger so disabled
  // controls can still explain themselves on hover without making the button itself focusable or clickable.
  if (props.disabled) {
    return (
      <OptionalTooltip label={title}>
        <span className="inline-flex">{button}</span>
      </OptionalTooltip>
    );
  }
  return <OptionalTooltip label={title}>{button}</OptionalTooltip>;
}

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex shrink-0 min-w-[1.4em] items-center justify-center whitespace-nowrap rounded-xs border border-seam-strong bg-well px-1 font-mono text-micro text-ink-3 leading-[1.5]",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
