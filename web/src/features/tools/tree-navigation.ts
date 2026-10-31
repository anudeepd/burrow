import type { KeyboardEvent } from "react";

/** Move the active row for keys shared by the virtual JMX and thread-dump trees. */
export function handleTreeNavigationEvent<T extends HTMLElement>(
  event: KeyboardEvent<T>,
  scrollHeight: number,
  rowHeight: number,
  activeIndex: number,
  rowCount: number,
  move: (index: number) => void,
): boolean {
  if (event.target !== event.currentTarget) return false;

  const pageSize = Math.max(1, Math.floor(scrollHeight / rowHeight) - 2);
  const { key } = event;
  switch (key) {
    case "ArrowDown":
    case "j":
      move(activeIndex + 1);
      break;
    case "ArrowUp":
    case "k":
      move(activeIndex - 1);
      break;
    case "PageDown":
      move(activeIndex + pageSize);
      break;
    case "PageUp":
      move(activeIndex - pageSize);
      break;
    case "Home":
      move(0);
      break;
    case "End":
      move(rowCount - 1);
      break;
    default:
      return false;
  }

  event.preventDefault();
  return true;
}
