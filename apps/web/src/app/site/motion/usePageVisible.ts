import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void): () => void {
  if (typeof document === "undefined") return () => undefined;
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

/** Non-hook form: true unless the document is hidden (background tab, minimised window). */
export function isPageVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

const serverSnapshot = () => true;

/** Live page visibility; loops and timers should pause while this is false. */
export function usePageVisible(): boolean {
  return useSyncExternalStore(subscribe, isPageVisible, serverSnapshot);
}
