import { useEffect, useState } from "react";

import { useReducedMotion } from "../motion/useReducedMotion";

/** Intent ids whose graph already built in this page session (survives remounts, e.g. review → execution). */
const built = new Set<string>();

/**
 * True while the intent graph for `intentId` should play its build-in
 * (lanes drop, nodes drop by dependency depth, edges draw). It runs once per
 * intent id per page session: live updates, resize re-measures and remounts
 * of the same intent never replay it. Reduced motion never builds.
 */
export function useGraphBuild(intentId: string, durationMs: number): boolean {
  const reduced = useReducedMotion();
  const [state, setState] = useState(() => ({ id: intentId, building: !built.has(intentId) }));
  let current = state;
  if (state.id !== intentId) {
    // A new intent in the same view (adjusting state during render).
    current = { id: intentId, building: !built.has(intentId) };
    setState(current);
  }
  const building = current.building;

  useEffect(() => {
    if (!building) return undefined;
    built.add(intentId);
    const timer = window.setTimeout(
      () => setState((previous) => (previous.id === intentId ? { id: intentId, building: false } : previous)),
      Math.max(0, durationMs),
    );
    return () => window.clearTimeout(timer);
  }, [building, intentId, durationMs]);

  return building && !reduced;
}
