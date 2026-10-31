import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "~/lib/cn";

/** Small detail tables share the data grid's quiet scrollbars and conditional right-edge fade. */
export function DetailTableScroller({ children, className, ariaLabel }: { children: ReactNode; className?: string; ariaLabel: string }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const moreRightRef = useRef(false);
  const [moreRight, setMoreRight] = useState(false);

  const syncOverflowCue = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const next = scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1;
    if (next !== moreRightRef.current) {
      moreRightRef.current = next;
      setMoreRight(next);
    }
  }, []);

  useEffect(() => {
    const scroller = scrollerRef.current;
    const content = scroller?.firstElementChild;
    if (!scroller) return;
    const observer = new ResizeObserver(syncOverflowCue);
    observer.observe(scroller);
    if (content) observer.observe(content);
    syncOverflowCue();
    return () => observer.disconnect();
  }, [syncOverflowCue]);

  return (
    <div className={cn("relative min-w-0 overflow-hidden", className)}>
      <div
        ref={scrollerRef}
        aria-label={ariaLabel}
        role="region"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the scroll region must be keyboard focusable.
        tabIndex={0} //NOSONAR -- required for keyboard scrolling in Safari
        onScroll={syncOverflowCue}
        className="burrow-scroll burrow-table-scroll min-w-0 overflow-x-auto overflow-y-hidden outline-none focus-visible:outline focus-visible:outline-offset-[-2px] focus-visible:outline-live"
      >
        {children}
      </div>
      <div
        aria-hidden="true"
        className={cn(
          "burrow-table-edge-fade pointer-events-none absolute inset-y-0 right-0 z-10 w-8 transition-opacity duration-(--dur-fade)",
          moreRight ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
}
