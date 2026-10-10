import { useEffect, useState } from "react";

/**
 * The current time, refreshed every `intervalMs` while the tab is visible
 * (countdowns to activation, expiry and amendments). Never inside a live
 * region: screen readers would hear every tick.
 */
export function useNow(intervalMs = 1_000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    let timer = 0;
    const tick = () => {
      setNow(Date.now());
      timer = window.setTimeout(tick, intervalMs);
    };
    const onVisibility = () => {
      window.clearTimeout(timer);
      if (document.visibilityState === "visible") tick();
    };
    timer = window.setTimeout(tick, intervalMs);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs, enabled]);
  return now;
}
