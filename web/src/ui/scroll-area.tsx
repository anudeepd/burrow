import { ScrollArea as BScrollArea } from "@base-ui/react/scroll-area";
import type { ReactNode, Ref } from "react";
import { cn } from "~/lib/cn";

/** Native scrolling with thin custom bars. `viewportRef` lets virtualizers attach to the scroll element. */
export function ScrollArea({
  children,
  className,
  viewportClassName,
  viewportRef,
  orientation = "vertical",
}: {
  children: ReactNode;
  className?: string;
  viewportClassName?: string;
  viewportRef?: Ref<HTMLDivElement>;
  orientation?: "vertical" | "horizontal" | "both";
}) {
  const bar = (o: "vertical" | "horizontal") => (
    <BScrollArea.Scrollbar
      orientation={o}
      className={cn(
        "m-0.5 flex touch-none select-none rounded-full opacity-0 transition-opacity duration-(--dur-base) data-hovering:opacity-100 data-scrolling:opacity-100",
        o === "vertical" ? "w-1.5" : "h-1.5 flex-col",
      )}
    >
      <BScrollArea.Thumb className="flex-1 rounded-full bg-seam-strong" />
    </BScrollArea.Scrollbar>
  );
  return (
    <BScrollArea.Root className={cn("relative min-h-0 overflow-hidden", className)}>
      <BScrollArea.Viewport ref={viewportRef} className={cn("size-full overscroll-contain", viewportClassName)}>
        {/* Base UI gives Content `min-width: fit-content` so a horizontal bar has something to scroll. A
            vertical-only area renders no horizontal bar, so that width only leaks the widest descendant (a
            wide table) into the page and pushes everything else off-screen. */}
        <BScrollArea.Content className={cn(orientation === "vertical" && "min-w-0!")}>{children}</BScrollArea.Content>
      </BScrollArea.Viewport>
      {orientation !== "horizontal" && bar("vertical")}
      {orientation !== "vertical" && bar("horizontal")}
    </BScrollArea.Root>
  );
}
