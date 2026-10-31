/** Move the active row for keys shared by the virtual JMX and thread-dump trees. */
export function handleTreeNavigationKey(
  key: string,
  activeIndex: number,
  rowCount: number,
  pageSize: number,
  move: (index: number) => void,
): boolean {
  switch (key) {
    case "ArrowDown":
    case "j":
      move(activeIndex + 1);
      return true;
    case "ArrowUp":
    case "k":
      move(activeIndex - 1);
      return true;
    case "PageDown":
      move(activeIndex + pageSize);
      return true;
    case "PageUp":
      move(activeIndex - pageSize);
      return true;
    case "Home":
      move(0);
      return true;
    case "End":
      move(rowCount - 1);
      return true;
    default:
      return false;
  }
}
