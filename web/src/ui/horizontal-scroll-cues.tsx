import { useCallback, useEffect, useState, type RefObject } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "~/lib/cn";

export function useHorizontalScrollCues<T extends HTMLElement>(ref: RefObject<T | null>, enabled = true, contentVersion?: unknown) {
  const [edges, setEdges] = useState({ left: false, right: false });
  const sync = useCallback(() => {
    const element = ref.current;
    const next = {
      left: !!element && element.scrollLeft > 1,
      right: !!element && element.scrollLeft + element.clientWidth < element.scrollWidth - 1,
    };
    setEdges((current) => (current.left === next.left && current.right === next.right ? current : next));
  }, [ref]);

  useEffect(() => {
    if (!enabled) return;
    const element = ref.current;
    if (!element) return;

    const resize = new ResizeObserver(sync);
    resize.observe(element);
    for (const child of Array.from(element.children)) resize.observe(child);
    const mutations = new MutationObserver(sync);
    mutations.observe(element, { childList: true, characterData: true, subtree: true });
    sync();
    return () => {
      resize.disconnect();
      mutations.disconnect();
    };
  }, [enabled, contentVersion, ref, sync]);

  return { ...edges, onScroll: enabled ? sync : undefined };
}

export function HorizontalScrollCues({ left, right }: { left: boolean; right: boolean }) {
  return (
    <>
      <div
        aria-hidden="true"
        data-scroll-cue="left"
        className={cn(
          "burrow-tab-overflow-fade burrow-tab-overflow-fade--left pointer-events-none absolute inset-y-px left-0 z-10 grid w-7 place-items-center text-ink-2 transition-opacity duration-(--dur-fade)",
          left ? "opacity-100" : "opacity-0",
        )}
      >
        <ChevronLeft className="size-4" aria-hidden="true" />
      </div>
      <div
        aria-hidden="true"
        data-scroll-cue="right"
        className={cn(
          "burrow-tab-overflow-fade pointer-events-none absolute inset-y-px right-0 z-10 grid w-7 place-items-center text-ink-2 transition-opacity duration-(--dur-fade)",
          right ? "opacity-100" : "opacity-0",
        )}
      >
        <ChevronRight className="size-4" aria-hidden="true" />
      </div>
    </>
  );
}
