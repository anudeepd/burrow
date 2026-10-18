import { Tooltip as BTooltip } from "@base-ui/react/tooltip";
import { Popover as BPopover } from "@base-ui/react/popover";
import { Info } from "lucide-react";
import { type ReactElement, type ReactNode, useId, useState } from "react";
import { cn } from "~/lib/cn";

export const TooltipProvider = BTooltip.Provider;

const HELP_SURFACE =
  "burrow-pop max-w-[min(22rem,calc(100vw-1rem))] rounded-md border border-seam-strong bg-fabric-3 px-2.5 py-2 text-caption leading-relaxed text-ink shadow-(--shadow-overlay) [transition-duration:var(--dur-fast)]";

/** Wrap an interactive or hoverable trigger. Tooltips supplement visible/accessibility-tree content. */
export function Tooltip({
  label,
  children,
  side = "top",
  align = "center",
  anchor,
  open,
  disabled = false,
}: {
  label: ReactNode;
  children: ReactElement;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  /** Position near a meaningful sub-element when the trigger itself spans a large area. */
  anchor?: Element | null | (() => Element | null);
  /** Control visibility for chart interactions whose hover target is separate from the anchor. */
  open?: boolean;
  /** Keep the trigger mounted while temporarily suppressing its tooltip. */
  disabled?: boolean;
}) {
  const tooltipId = useId();
  const [visible, setVisible] = useState(false);
  const describedBy = (children.props as { "aria-describedby"?: string })["aria-describedby"];
  const active = open ?? visible;
  return (
    <BTooltip.Root open={open} onOpenChange={setVisible} disabled={disabled}>
      <BTooltip.Trigger render={children} aria-describedby={active ? [describedBy, tooltipId].filter(Boolean).join(" ") : describedBy} />
      <BTooltip.Portal>
        <BTooltip.Positioner side={side} align={align} anchor={anchor} sideOffset={6} className="pointer-events-none z-tooltip">
          <BTooltip.Popup id={tooltipId} role="tooltip" className={cn(HELP_SURFACE, "pointer-events-none")}>
            {label}
          </BTooltip.Popup>
        </BTooltip.Positioner>
      </BTooltip.Portal>
    </BTooltip.Root>
  );
}

/** Keep optional hover hints inside the shared tooltip style instead of the browser's native `title` popup. */
export function OptionalTooltip({ label, children }: { label: ReactNode; children: ReactElement }) {
  return label == null || label === "" ? children : <Tooltip label={label}>{children}</Tooltip>;
}

/** Explicit help for definitions and units: hover/focus to preview, click/tap to keep it open. */
export function HelpTip({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <BPopover.Root open={open} onOpenChange={setOpen}>
      <Tooltip label={children} open={open ? false : undefined}>
        <BPopover.Trigger
          type="button"
          aria-label={`About ${label}`}
          data-burrow-help={label}
          className={cn(
            "burrow-help inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-ink-3 hover:bg-fabric-2 hover:text-ink focus-visible:text-ink",
            className,
          )}
        >
          <Info className="size-3.5" aria-hidden="true" />
        </BPopover.Trigger>
      </Tooltip>
      <BPopover.Portal>
        <BPopover.Positioner side="top" sideOffset={6} className="z-popover">
          <BPopover.Popup className={cn(HELP_SURFACE, "burrow-scroll max-h-[min(24rem,calc(100dvh-2rem))] overflow-y-auto outline-none")}>
            <BPopover.Title className="mb-1 text-small font-semibold">{label}</BPopover.Title>
            {children}
          </BPopover.Popup>
        </BPopover.Positioner>
      </BPopover.Portal>
    </BPopover.Root>
  );
}
