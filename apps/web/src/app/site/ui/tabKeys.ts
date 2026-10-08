/** Roving-tabindex keyboard handling for tab lists: returns the next index, or null for other keys. */
export function nextTabIndex(key: string, index: number, length: number): number | null {
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (index + 1) % length;
    case "ArrowLeft":
    case "ArrowUp":
      return (index - 1 + length) % length;
    case "Home":
      return 0;
    case "End":
      return length - 1;
    default:
      return null;
  }
}
