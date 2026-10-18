import { Dialog as BDialog } from "@base-ui/react/dialog";
import type { RefObject } from "react";
import { Rail } from "./rail";

/** Mobile navigation drawer. It is code-split from the desktop shell and remains mounted after first open for its exit animation. */
export function RailDrawer({
  open,
  onOpenChange,
  returnFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocus: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <BDialog.Root open={open} onOpenChange={onOpenChange}>
      <BDialog.Portal>
        <BDialog.Backdrop className="burrow-scrim fixed inset-0 z-overlay min-h-dvh md:hidden" />
        <BDialog.Popup
          finalFocus={returnFocus}
          data-side="left"
          className="burrow-sheet fixed inset-y-0 left-0 z-overlay flex flex-col bg-fabric text-ink shadow-(--shadow-overlay) outline-none md:hidden"
        >
          <BDialog.Title className="sr-only">Navigation</BDialog.Title>
          <Rail inDrawer className="h-full border-r-0" onNavigate={() => onOpenChange(false)} />
        </BDialog.Popup>
      </BDialog.Portal>
    </BDialog.Root>
  );
}
