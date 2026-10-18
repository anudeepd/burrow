import { Tabs as BTabs } from "@base-ui/react/tabs";
import { useEffect, useRef, type ReactNode } from "react";
import { fadeIn } from "~/lib/motion";
import { cn } from "~/lib/cn";
import { HorizontalScrollCues, useHorizontalScrollCues } from "./horizontal-scroll-cues";

export const TabsRoot = BTabs.Root;
export const TabsPanel = BTabs.Panel;

/**
 * Underline tabs with a sliding thread indicator (transform-driven by Base UI's --active-tab-* vars).
 * `badge` renders a count after the label.
 */
export function TabsList({
  children,
  label,
  className,
  overflowFade = false,
}: {
  children: ReactNode;
  label: string;
  className?: string;
  overflowFade?: boolean;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const cues = useHorizontalScrollCues(listRef, overflowFade, children);

  return (
    <div className="relative min-w-0">
      <BTabs.List
        ref={listRef}
        aria-label={label}
        onScroll={cues.onScroll}
        className={cn(
          "burrow-scroll burrow-scroll-hidden relative flex items-center gap-0.5 overflow-x-auto border-b border-seam",
          className,
        )}
      >
        {children}
        {/* The bar is one absolutely-positioned 2px element, so its `width` tween re-lays out nothing — the sanctioned
            exception to "transform and opacity only" (DESIGN §5.5). On-screen movement uses `--ease-in-out`, and the
            tokens zero it under reduced motion/parity. */}
        <BTabs.Indicator className="absolute bottom-0 left-0 h-0.5 w-(--active-tab-width) translate-x-(--active-tab-left) rounded-full bg-live transition-[translate,width] duration-(--dur-base) ease-(--ease-in-out)" />
      </BTabs.List>
      {overflowFade && <HorizontalScrollCues left={cues.left} right={cues.right} />}
    </div>
  );
}

export function Tab({ value, children, badge, field }: { value: string; children: ReactNode; badge?: ReactNode; field?: string }) {
  return (
    <BTabs.Tab
      value={value}
      data-yt={field}
      className="burrow-tab relative inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap px-3 text-body font-medium text-ink-3 outline-offset-[-2px] transition-colors duration-(--dur-fast) ease-(--ease-out) hover:text-ink-2 data-active:text-ink"
    >
      {children}
      {badge != null && <span className="rounded-full bg-fabric-3 px-1.5 text-micro leading-[1.6] text-ink-2 tnum">{badge}</span>}
    </BTabs.Tab>
  );
}

/** Fades filtered data in place over the shared content duration without remounting its table or scroll state. */
export function TabContent({ value, children, className }: { value: string; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const previousValue = useRef(value);
  const animation = useRef<Animation | undefined>(undefined);

  useEffect(() => () => animation.current?.cancel(), []);
  useEffect(() => {
    if (previousValue.current === value) return;
    previousValue.current = value;
    const element = ref.current;
    if (!element) return;
    const from = animation.current?.playState === "running" ? Number.parseFloat(getComputedStyle(element).opacity) : 0;
    animation.current?.cancel();
    animation.current = fadeIn(element, Number.isFinite(from) ? from : 0);
  }, [value]);

  return (
    <div ref={ref} className={cn("burrow-tab-content", className)}>
      {children}
    </div>
  );
}
