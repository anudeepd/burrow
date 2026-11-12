import { Tabs as BTabs } from "@base-ui/react/tabs";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { cancelAnimation, fadeIn } from "~/lib/motion";
import { cn } from "~/lib/cn";
import { HorizontalScrollCues, useHorizontalScrollCues } from "./horizontal-scroll-cues";

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

const TAB_BASE_CLASS =
  "burrow-tab relative inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap px-3 text-body font-medium text-ink-3 -outline-offset-2 transition-colors duration-(--dur-fast) ease-out hover:text-ink-2";
export const TAB_STRIP_CLASS =
  "burrow-scroll burrow-scroll-hidden relative flex min-w-0 items-center gap-0.5 overflow-x-auto border-b border-seam";
export const TAB_LINK_CLASS = `${TAB_BASE_CLASS} aria-[current=page]:text-ink`;
const TAB_INDICATOR_CLASS =
  "burrow-tab-indicator pointer-events-none absolute bottom-0 left-0 h-0.5 w-(--active-tab-width) translate-x-(--active-tab-left) rounded-full bg-live transition-[translate,width] duration-(--dur-base) ease-(--ease-in-out)";

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
      <BTabs.List ref={listRef} aria-label={label} onScroll={cues.onScroll} className={cn(TAB_STRIP_CLASS, className)}>
        {children}
        {/* The bar is one absolutely-positioned 2px element, so its `width` tween re-lays out nothing — the sanctioned
            exception to "transform and opacity only" (DESIGN §5.5). On-screen movement uses `--ease-in-out`, and the
            tokens zero it under reduced motion/parity. */}
        <BTabs.Indicator className={TAB_INDICATOR_CLASS} />
      </BTabs.List>
      {overflowFade && <HorizontalScrollCues left={cues.left} right={cues.right} />}
    </div>
  );
}

export function Tab({ value, children, badge, field }: { value: string; children: ReactNode; badge?: ReactNode; field?: string }) {
  return (
    <BTabs.Tab value={value} data-yt={field} className={cn(TAB_BASE_CLASS, "data-active:text-ink")}>
      {children}
      {badge != null && <span className="rounded-full bg-fabric-3 px-1.5 text-micro leading-[1.6] text-ink-2 tnum">{badge}</span>}
    </BTabs.Tab>
  );
}

/** Route links keep native navigation semantics while sharing the in-page tabs' sliding underline. */
export function RouteTabIndicator({
  listRef,
  value,
  as: Indicator = "span",
}: {
  listRef: RefObject<HTMLElement | null>;
  value: string;
  as?: "span" | "li";
}) {
  const [position, setPosition] = useState<{ left: number; width: number } | null>(null);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const sync = () => {
      const active = list.querySelector<HTMLElement>('[aria-current="page"]');
      if (!active) {
        setPosition(null);
        return;
      }
      const listBounds = list.getBoundingClientRect();
      const tabBounds = active.getBoundingClientRect();
      const left = tabBounds.left - listBounds.left - list.clientLeft + list.scrollLeft;
      const width = tabBounds.width;
      setPosition((current) => (current?.left === left && current.width === width ? current : { left, width }));
    };
    sync();
    const resize = new ResizeObserver(sync);
    resize.observe(list);
    for (const tab of list.querySelectorAll(".burrow-tab")) resize.observe(tab);
    return () => resize.disconnect();
  }, [listRef, value]);

  if (!position) return null;
  return (
    <Indicator aria-hidden="true" className={TAB_INDICATOR_CLASS} style={{ width: position.width, translate: `${position.left}px` }} />
  );
}

/** Fades an explicit content change without remounting controls or scroll state; `initial` also covers a newly ready body. */
export function TabContent({
  value,
  children,
  className,
  initial = false,
  motion = "content",
  shift = 0,
}: {
  value: string;
  children: ReactNode;
  className?: string;
  initial?: boolean;
  motion?: "content" | "cards";
  /** Optional rise in px for a content switch that should read as a deliberate replace. */
  shift?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const previousValue = useRef<string | null>(initial ? null : value);
  const animation = useRef<Animation | undefined>(undefined);

  useEffect(() => () => cancelAnimation(animation.current), []);
  useIsomorphicLayoutEffect(() => {
    if (previousValue.current === value) return;
    previousValue.current = value;
    // This ref is attached to the content div rendered below before effects run.
    const element = ref.current!;
    const from = animation.current?.playState === "running" ? Number.parseFloat(getComputedStyle(element).opacity) : 0;
    cancelAnimation(animation.current);
    animation.current = fadeIn(element, Number.isFinite(from) ? from : 0, shift);
  }, [value, shift]);

  return (
    <div ref={ref} data-page-motion={motion} className={cn("burrow-tab-content", className)}>
      {children}
    </div>
  );
}
