import { reducedMotion } from "../../kit/motion";

/** Brings a newly arrived turn into view above the docked composer (smooth unless motion is off). */
export function reveal(element: Element | null | undefined, block: ScrollLogicalPosition = "nearest"): void {
  if (!element) return;
  requestAnimationFrame(() => element.scrollIntoView({ block, behavior: reducedMotion() ? "auto" : "smooth" }));
}
