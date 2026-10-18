import { useEffect } from "react";

/** Focus and select the active log search when the user presses Ctrl+F or Cmd+F. */
export function useLogSearchHotkey(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.shiftKey ||
        event.isComposing ||
        !(event.ctrlKey || event.metaKey) ||
        event.key.toLowerCase() !== "f" ||
        document.querySelector('[role="dialog"]')
      ) {
        return;
      }

      const input = document.querySelector<HTMLInputElement>('[data-burrow-log-search] input[type="search"]');
      if (!input || input.disabled) return;

      event.preventDefault();
      input.focus();
      input.select();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
