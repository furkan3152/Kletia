/**
 * Continuation requests built from an intent graph.
 */
import { fromBaseUnits } from "../amounts.js";
import { topologicalOrder } from "../lifecycle.js";
import { fundedFlow, fundingParent, isOwnRequestAccount } from "../flow.js";
import type {
  IntentActionSpec,
  IntentGraph,
  IntentRequest,
  IntentStep,
} from "../intent.js";
import { destinationOf, sameAsset, started } from "./helpers.js";

/* ------------------------------------------------------ actions from graph */

function decimalOf(units: bigint, decimals: number): string {
  return fromBaseUnits(units, decimals);
}

function actionFor(graph: IntentGraph, step: IntentStep, amount: string, portionBps: number | null, anyVenue: boolean): IntentActionSpec | null {
  if (step.kind === "call" || step.kind === "action" || step.mode === "read") return null;
  const output = step.minimumOutput ?? step.expectedOutput;
  const recipient = step.recipient && !isOwnRequestAccount(graph, step.recipient) ? step.recipient : undefined;
  const destination = destinationOf(step);
  const params: Record<string, string | number | boolean> = {};
  if (portionBps !== null && portionBps !== 10_000) params.portionBps = portionBps;
  if (step.venue && !anyVenue) params.venue = step.venue;
  const withOutput = step.kind === "swap" || step.kind === "bridge" || step.kind === "stake" || step.kind === "unstake";
  return {
    kind: step.kind,
    network: step.network,
    ...(step.input ? { from: step.input.asset } : {}),
    ...(withOutput && output ? { to: output.asset } : {}),
    amount,
    ...(destination !== step.network ? { toNetwork: destination } : {}),
    ...(recipient ? { recipient } : {}),
    ...(!anyVenue ? { protocol: step.protocol } : {}),
    ...(Object.keys(params).length > 0 ? { params } : {}),
  };
}

/**
 * Structured actions equivalent to the graph (merged legs are one bridge with
 * `to`); null when a step cannot be expressed (call / action steps).
 */
export function actionsFromGraph(graph: IntentGraph, options: { readonly anyVenue?: boolean } = {}): IntentActionSpec[] | null {
  const actions: IntentActionSpec[] = [];
  for (const step of topologicalOrder(graph.steps)) {
    if (step.mode === "read") continue;
    const funded = fundingParent(graph, step) !== null;
    const portion = step.funding?.portionBps ?? 10_000;
    const amount = funded ? "max" : step.input ? decimalOf(BigInt(step.input.amount), step.input.decimals) : "max";
    const action = actionFor(graph, step, amount, funded ? portion : null, options.anyVenue === true);
    if (!action) return null;
    actions.push(action);
  }
  return actions.length > 0 ? actions : null;
}

function descendantsOf(graph: IntentGraph, ids: ReadonlySet<string>): Set<string> {
  const out = new Set(ids);
  let grew = true;
  while (grew) {
    grew = false;
    for (const step of graph.steps) {
      if (out.has(step.id)) continue;
      if (step.dependsOn.some((id) => out.has(id)) || (fundingParent(graph, step) && out.has(fundingParent(graph, step)!.id))) {
        out.add(step.id);
        grew = true;
      }
    }
  }
  return out;
}

/**
 * The request that re-plans what is left from a stop (amount flow F5): the
 * first action spends the landed amount (or the observed credit) exactly,
 * later ones keep their `max` + `portionBps` shape; same accounts and
 * constraints (a passed deadline dropped), `metadata.continues` = the intent
 * id. Null when nothing is left, the stop is unknown, or a step cannot be
 * expressed (call / action).
 */
export function continuationRequest(graph: IntentGraph, stopId: string, options: { readonly anyVenue?: boolean; readonly now?: number } = {}): IntentRequest | null {
  const match = /^(start|transit|out):(.+)$/u.exec(stopId);
  if (!match) return null;
  const [, role, stepId] = match as unknown as [string, string, string];
  const anchor = graph.steps.find((step) => step.id === stepId);
  if (!anchor) return null;
  const order = topologicalOrder(graph.steps);
  const anyVenue = options.anyVenue === true;
  let roots: IntentStep[];
  let firstAmount: (step: IntentStep) => string | null;
  if (role === "out") {
    const landed = anchor.status === "settled" ? anchor.actualOutput : anchor.observedCredit ?? anchor.actualOutput;
    if (!landed) return null;
    roots = order.filter((step) => fundingParent(graph, step)?.id === anchor.id && !started(step) && step.status !== "settled");
    firstAmount = (step) => {
      if (!step.input || !sameAsset(step.input.asset, landed.asset)) return null;
      const units = BigInt(landed.amount);
      const flow = fundedFlow(graph, step, { expected: units, worst: units, certainty: "observed" });
      return flow.spends.worst > 0n ? decimalOf(flow.spends.worst, step.input.decimals) : null;
    };
  } else {
    if (started(anchor) && anchor.status !== "failed") return null;
    roots = [anchor];
    firstAmount = (step) => {
      if (!step.input) return null;
      if (fundingParent(graph, step)) return null;
      return decimalOf(BigInt(step.input.amount), step.input.decimals);
    };
  }
  if (roots.length === 0) return null;
  const remaining = descendantsOf(graph, new Set(roots.map((step) => step.id)));
  const actions: IntentActionSpec[] = [];
  for (const step of order) {
    if (!remaining.has(step.id) || step.mode === "read") continue;
    if (step.status === "settled" || started(step)) continue;
    const isRoot = roots.includes(step);
    let action: IntentActionSpec | null;
    if (isRoot) {
      const amount = firstAmount(step);
      if (amount === null) return null;
      action = actionFor(graph, step, amount, null, anyVenue);
    } else {
      action = actionFor(graph, step, "max", step.funding?.portionBps ?? 10_000, anyVenue);
    }
    if (!action) return null;
    actions.push(action);
  }
  if (actions.length === 0) return null;
  const { text: _text, actions: _actions, sourceNetwork: _source, constraints, metadata, clientReference: _reference, ...rest } = graph.request;
  void _text;
  void _actions;
  void _source;
  void _reference;
  const now = options.now ?? Date.now();
  const keptConstraints = constraints
    ? Object.fromEntries(Object.entries(constraints).filter(([key, value]) => !(key === "deadline" && typeof value === "number" && value * 1000 <= now)))
    : undefined;
  return {
    ...rest,
    actions,
    ...(keptConstraints && Object.keys(keptConstraints).length > 0 ? { constraints: keptConstraints } : {}),
    metadata: { ...(metadata ?? {}), continues: graph.id },
  };
}
