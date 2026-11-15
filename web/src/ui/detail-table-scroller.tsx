import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "~/lib/cn";

/** Small detail tables share the data grid's quiet scrollbars and conditional right-edge fade. */
export function DetailTableScroller({
  children,
  className,
  ariaLabel,
  maxHeight,
}: {
  children: ReactNode;
  className?: string;
  ariaLabel: string;
  /** Caps the scroll area so a long table cannot stretch the page; the header stays visible. */
  maxHeight?: string;
}) {
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
    // The region is rendered unconditionally above, so its ref is set before this effect runs.
    const scroller = scrollerRef.current!;
    const content = scroller.firstElementChild;
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
        style={maxHeight ? { maxHeight } : undefined}
        className={cn(
          "burrow-scroll burrow-table-scroll min-w-0 overflow-x-auto outline-none focus-visible:outline focus-visible:-outline-offset-2 focus-visible:outline-live",
          maxHeight ? "overflow-y-auto" : "overflow-y-hidden",
        )}
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
