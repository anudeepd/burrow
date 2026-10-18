import { Popover as BPopover } from "@base-ui/react/popover";
import type { ReactNode } from "react";
import { cn } from "~/lib/cn";

export const PopoverRoot = BPopover.Root;
export const PopoverTrigger = BPopover.Trigger;
export const PopoverClose = BPopover.Close;

/** Origin-aware (scales from the trigger via --transform-origin). Positioner owns collision handling. */
export function PopoverContent({
  children,
  className,
  side = "bottom",
  align = "end",
  sideOffset = 6,
  title,
}: {
  children: ReactNode;
  className?: string;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  title?: string;
}) {
  return (
    <BPopover.Portal>
      <BPopover.Positioner side={side} align={align} sideOffset={sideOffset} className="z-popover">
        <BPopover.Popup
          className={cn(
            "burrow-pop max-w-[calc(100vw-1rem)] rounded-lg bg-fabric-2 p-3 text-body text-ink shadow-(--shadow-overlay) outline-none",
            className,
          )}
        >
          {title && <BPopover.Title className="mb-2 text-small font-semibold text-ink-2">{title}</BPopover.Title>}
          {children}
        </BPopover.Popup>
      </BPopover.Positioner>
    </BPopover.Portal>
  );
}
