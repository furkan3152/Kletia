import type { IntentGraph } from "@kletia/core";

/**
 * Dependency depth of each step: the longest chain of dependencies (over
 * `dependsOn` and the graph's edges) that leads to it. Roots have depth 0.
 * Pure and Node-safe; a malformed cycle is broken where it repeats instead
 * of recursing forever.
 */
export function stepDepths(intent: Pick<IntentGraph, "steps" | "edges">): Map<string, number> {
  const parents = new Map<string, Set<string>>();
  const known = new Set(intent.steps.map((step) => step.id));
  for (const step of intent.steps) {
    const set = parents.get(step.id) ?? new Set<string>();
    for (const dependency of step.dependsOn) if (known.has(dependency) && dependency !== step.id) set.add(dependency);
    parents.set(step.id, set);
  }
  for (const edge of intent.edges) {
    if (!known.has(edge.from) || !known.has(edge.to) || edge.from === edge.to) continue;
    parents.get(edge.to)?.add(edge.from);
  }

  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let depth = 0;
    for (const parent of parents.get(id) ?? []) depth = Math.max(depth, depthOf(parent) + 1);
    visiting.delete(id);
    depths.set(id, depth);
    return depth;
  };
  for (const step of intent.steps) depthOf(step.id);
  return depths;
}

/** Build-in timing for the intent graph (ms). */
export const GRAPH_BUILD = Object.freeze({
  /** Delay added per dependency level. */
  depthStep: 140,
  /** Extra delay per lane, so parallel steps in different lanes cascade. */
  laneStep: 40,
  /** Edges start drawing this long after their target's level begins. */
  edgeOffset: 120,
  /** Node drop (kl-drop) and edge draw (kl-draw) durations. */
  nodeMs: 240,
  edgeMs: 380,
});

/** `--kl-delay` for a step node. */
export function nodeBuildDelay(depth: number, laneIndex: number): number {
  return Math.max(0, depth) * GRAPH_BUILD.depthStep + Math.max(0, laneIndex) * GRAPH_BUILD.laneStep;
}

/** `--kl-delay` for an edge into a step at `targetDepth`. */
export function edgeBuildDelay(targetDepth: number): number {
  return Math.max(0, targetDepth) * GRAPH_BUILD.depthStep + GRAPH_BUILD.edgeOffset;
}

/** How long the whole build runs, so the build classes can be dropped afterwards. */
export function graphBuildDuration(depths: ReadonlyMap<string, number>, laneCount: number): number {
  let maxDepth = 0;
  for (const depth of depths.values()) maxDepth = Math.max(maxDepth, depth);
  const nodes = nodeBuildDelay(maxDepth, Math.max(0, laneCount - 1)) + GRAPH_BUILD.nodeMs;
  const edges = maxDepth > 0 ? edgeBuildDelay(maxDepth) + GRAPH_BUILD.edgeMs : 0;
  // Margin for the measure pass that mounts the edges one frame later.
  return Math.max(nodes, edges) + 200;
}
