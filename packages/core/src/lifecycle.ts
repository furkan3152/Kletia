/**
 * Intent lifecycle: allowed step transitions, graph validation and status
 * derivation. Shared by the API (authoritative), SDK and UI (optimistic).
 */
import { CHAINS, sameCapitalLane } from "./chains.js";
import { parseAccountId } from "./caip.js";
import type {
  IntentEdge,
  IntentGraph,
  IntentStatus,
  IntentStep,
  StepStatus,
} from "./intent.js";

const STEP_TRANSITIONS: Readonly<Record<StepStatus, readonly StepStatus[]>> = Object.freeze({
  pending: ["ready", "skipped", "failed"],
  ready: ["awaiting_signature", "submitted", "skipped", "failed", "pending"],
  awaiting_signature: ["submitted", "ready", "failed"],
  submitted: ["confirmed", "failed", "indeterminate", "settling"],
  confirmed: ["settling", "settled"],
  settling: ["settled", "failed", "indeterminate"],
  settled: [],
  failed: ["ready"],
  skipped: [],
  indeterminate: ["confirmed", "settling", "settled", "failed"],
});

export const TERMINAL_STEP_STATUSES: readonly StepStatus[] = Object.freeze(["settled", "failed", "skipped"]);

export function canTransitionStep(from: StepStatus, to: StepStatus): boolean {
  return from === to || STEP_TRANSITIONS[from].includes(to);
}

export function assertStepTransition(from: StepStatus, to: StepStatus): void {
  if (!canTransitionStep(from, to)) {
    throw new Error(`Illegal step transition ${from} -> ${to}.`);
  }
}

export function isStepDone(step: Pick<IntentStep, "status" | "mode">): boolean {
  return step.status === "settled" || step.status === "skipped" ||
    (step.mode === "read" && step.status === "confirmed");
}

/** Steps whose dependencies are all done and which are not yet started. */
export function readySteps(steps: readonly IntentStep[]): IntentStep[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  return steps.filter(
    (step) =>
      (step.status === "pending" || step.status === "ready") &&
      step.dependsOn.every((dependency) => {
        const parent = byId.get(dependency);
        return parent !== undefined && isStepDone(parent);
      }),
  );
}

export function deriveIntentStatus(
  steps: readonly IntentStep[],
  expiresAt?: string,
  now: number = Date.now(),
): IntentStatus {
  if (steps.length === 0) return "failed";
  const statuses = steps.map((step) => step.status);
  const done = steps.filter(isStepDone).length;
  if (done === steps.length) return "completed";
  if (statuses.includes("indeterminate")) return "indeterminate";
  if (statuses.includes("failed")) return done > 0 ? "partially_completed" : "failed";
  if (statuses.includes("settling")) return "settling";
  const started = statuses.some((status) =>
    status === "awaiting_signature" || status === "submitted" || status === "confirmed" || status === "settled",
  );
  if (!started && expiresAt && Date.parse(expiresAt) < now) return "expired";
  return started ? "executing" : "planned";
}

/** Kahn topological order; throws on cycles. */
export function topologicalOrder(steps: readonly IntentStep[]): IntentStep[] {
  const indegree = new Map<string, number>(steps.map((step) => [step.id, 0]));
  const children = new Map<string, string[]>();
  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      indegree.set(step.id, (indegree.get(step.id) ?? 0) + 1);
      children.set(dependency, [...(children.get(dependency) ?? []), step.id]);
    }
  }
  const byId = new Map(steps.map((step) => [step.id, step]));
  const queue = steps.filter((step) => (indegree.get(step.id) ?? 0) === 0).map((step) => step.id);
  const ordered: IntentStep[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    const step = byId.get(id);
    if (step) ordered.push(step);
    for (const child of children.get(id) ?? []) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) queue.push(child);
    }
  }
  if (ordered.length !== steps.length) throw new Error("Intent graph contains a cycle.");
  return ordered;
}

export function edgesFromSteps(steps: readonly IntentStep[]): IntentEdge[] {
  return steps.flatMap((step) =>
    step.dependsOn.map((dependency) => ({ from: dependency, to: step.id, kind: "funds" as const })),
  );
}

export interface GraphValidationIssue {
  readonly path: string;
  readonly message: string;
}

/** Structural validation of a compiled graph. Returns an empty list when valid. */
export function validateIntentGraph(graph: IntentGraph): GraphValidationIssue[] {
  const issues: GraphValidationIssue[] = [];
  const ids = new Set<string>();
  for (const [index, step] of graph.steps.entries()) {
    const path = `steps[${index}]`;
    if (ids.has(step.id)) issues.push({ path, message: `Duplicate step id ${step.id}.` });
    ids.add(step.id);
    const chain = CHAINS[step.network];
    if (!chain) {
      issues.push({ path, message: `Unknown network ${String(step.network)}.` });
      continue;
    }
    if (chain.id !== step.chain) issues.push({ path, message: "Step chain does not match its network." });
    const account = parseAccountId(step.account);
    if (!account || account.chain.id !== chain.id) {
      issues.push({ path, message: "Step account must be a CAIP-10 account on the step network." });
    }
    if (step.settlement?.destinationNetwork &&
      !sameCapitalLane(step.network, step.settlement.destinationNetwork)) {
      issues.push({ path, message: "Cross-network step mixes mainnet and testnet capital." });
    }
  }
  for (const [index, step] of graph.steps.entries()) {
    for (const dependency of step.dependsOn) {
      if (!ids.has(dependency)) {
        issues.push({ path: `steps[${index}].dependsOn`, message: `Unknown dependency ${dependency}.` });
      }
    }
  }
  try {
    topologicalOrder(graph.steps);
  } catch (error) {
    issues.push({ path: "steps", message: (error as Error).message });
  }
  return issues;
}
