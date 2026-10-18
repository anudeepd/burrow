import { Dialog as BDialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "~/lib/cn";
import { Button } from "./button";
import { Tooltip } from "./tooltip";

export const DialogRoot = BDialog.Root;
export const DialogTrigger = BDialog.Trigger;
export const DialogClose = BDialog.Close;

function CloseButton() {
  return (
    <Tooltip label="Close dialog">
      <BDialog.Close render={<Button variant="ghost" size="icon-sm" aria-label="Close" />}>
        <X className="size-4" aria-hidden="true" />
      </BDialog.Close>
    </Tooltip>
  );
}

/** Centered modal. Focus is trapped, Escape closes, focus returns to the trigger (Base UI). Modals stay centered (no origin scale). */
export function Modal({
  title,
  description,
  children,
  className,
  initialFocus,
  open,
  onOpenChange,
  defaultOpen = true,
  instant = false,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  initialFocus?: React.RefObject<HTMLElement | null>;
  /** controlled open state; omit for an uncontrolled modal that starts open (see defaultOpen) */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
  /** no entrance: for keyboard-first surfaces opened hundreds of times a day, where the animation is pure cost */
  instant?: boolean;
}) {
  return (
    <BDialog.Root open={open} onOpenChange={onOpenChange} defaultOpen={defaultOpen}>
      <BDialog.Portal>
        <BDialog.Backdrop className={cn("burrow-scrim fixed inset-0 z-overlay min-h-dvh", instant && "burrow-instant")} />
        <BDialog.Popup
          initialFocus={initialFocus}
          className={cn(
            "burrow-pop fixed top-[12vh] left-1/2 z-overlay w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 rounded-xl bg-fabric-2 p-4 text-ink",
            "shadow-(--shadow-overlay) outline-none data-ending-style:-translate-x-1/2 data-starting-style:-translate-x-1/2",
            instant && "burrow-instant",
            className,
          )}
        >
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <BDialog.Title className="text-lead font-semibold">{title}</BDialog.Title>
              {description && <BDialog.Description className="mt-0.5 text-small text-ink-3">{description}</BDialog.Description>}
            </div>
            <CloseButton />
          </div>
          {children}
        </BDialog.Popup>
      </BDialog.Portal>
    </BDialog.Root>
  );
}

/** Edge-anchored panel (detail drawers). Slides on transform only. */
export function Sheet({
  title,
  description,
  children,
  side = "right",
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  side?: "right" | "left" | "bottom";
  className?: string;
}) {
  return (
    <BDialog.Portal>
      <BDialog.Backdrop className="burrow-scrim fixed inset-0 z-overlay min-h-dvh" />
      <BDialog.Popup
        data-side={side}
        className={cn(
          "burrow-sheet fixed z-overlay flex flex-col bg-fabric-2 text-ink shadow-(--shadow-overlay) outline-none",
          side === "right" && "inset-y-0 right-0 w-[min(34rem,100vw)] rounded-l-xl",
          side === "left" && "inset-y-0 left-0 w-[min(22rem,100vw)] rounded-r-xl",
          side === "bottom" && "inset-x-0 bottom-0 max-h-[80dvh] rounded-t-xl",
          className,
        )}
      >
        <div className="flex items-start justify-between gap-3 border-b border-seam p-4">
          <div className="min-w-0">
            <BDialog.Title className="text-lead font-semibold">{title}</BDialog.Title>
            {description && <BDialog.Description className="mt-0.5 text-small text-ink-3">{description}</BDialog.Description>}
          </div>
          <CloseButton />
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
      </BDialog.Popup>
    </BDialog.Portal>
  );
}
