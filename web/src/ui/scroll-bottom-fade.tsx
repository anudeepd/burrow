import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { cn } from "~/lib/cn";

export function useHasMoreBelow(ref: RefObject<HTMLElement | null>, enabled = true, contentRef?: RefObject<HTMLElement | null>) {
  const visibleRef = useRef(false);
  const [visible, setVisible] = useState(false);

  const sync = useCallback(() => {
    const element = ref.current;
    const content = contentRef?.current ?? element;
    const next = Boolean(element && content && element.scrollTop + element.clientHeight < content.scrollHeight - 1);
    if (next !== visibleRef.current) {
      visibleRef.current = next;
      setVisible(next);
    }
  }, [contentRef, ref]);

  useLayoutEffect(() => {
    if (!enabled) {
      if (visibleRef.current) {
        visibleRef.current = false;
        setVisible(false);
      }
      return;
    }
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    const content = contentRef?.current ?? element.firstElementChild;
    if (content) observer.observe(content);
    sync();
    return () => observer.disconnect();
  }, [contentRef, enabled, ref, sync]);

  return { visible, sync };
}

export function ScrollBottomFade({ visible }: { visible: boolean }) {
  return (
    <div
      aria-hidden="true"
      data-visible={visible}
      className={cn(
        "burrow-table-bottom-fade pointer-events-none absolute inset-x-px bottom-7 z-10 h-12 transition-opacity duration-(--dur-fade)",
        visible ? "opacity-100" : "opacity-0",
      )}
    />
  );
}
