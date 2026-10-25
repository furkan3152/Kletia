/**
 * Builds the journey: consequence ordering, stage, digest and blockers.
 */
import type { IntentPreview } from "../preview.js";
import { canonicalJson } from "../contracts.js";
import { sha256Hex } from "../hash.js";
import type { IntentGraph } from "../intent.js";
import { JOURNEY_SPEC, type JourneyStage } from "./constants.js";
import {
  type Journey,
  JOURNEY_LIMITS,
  type JourneyConsequence,
  type JourneyFacts,
  type JourneyStop,
} from "./types.js";
import {
  type Draft,
  IN_FLIGHT_STATUSES,
  KIND_RANK,
  normalizedAsset,
  OK_OPTION,
  SEVERITY_RANK,
  started,
  TERMINAL_INTENT_STATUSES,
} from "./helpers.js";
import { legsOf, type Walk, walkGraph } from "./walk.js";
import { ruleGasToContinue, ruleGasToLeave } from "./gasRules.js";
import {
  ruleAllowanceLeft,
  ruleAssetIdentity,
  ruleExitPath,
  ruleIdleFunds,
  ruleIfStopped,
  rulePriceExposure,
  ruleRefundPath,
  ruleRuleBook,
  ruleTimeWindow,
  ruleVenueCapacity,
} from "./rules.js";

/* -------------------------------------------------------------- assembly */

function compareDrafts(walk: Walk, a: Draft, b: Draft): number {
  const stopIndex = (draft: Draft) => (draft.stopId ? walk.stops.findIndex((stop) => stop.id === draft.stopId) : -1);
  const left = [SEVERITY_RANK[a.severity], stopIndex(a) === -1 ? Number.MAX_SAFE_INTEGER : stopIndex(a), KIND_RANK.get(a.kind) ?? 99];
  const right = [SEVERITY_RANK[b.severity], stopIndex(b) === -1 ? Number.MAX_SAFE_INTEGER : stopIndex(b), KIND_RANK.get(b.kind) ?? 99];
  for (let index = 0; index < left.length; index += 1) {
    const diff = (left[index] as number) - (right[index] as number);
    if (diff !== 0) return diff;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Severity order, folding and the one question per block / recommended act. */
function finishConsequences(walk: Walk, drafts: readonly Draft[]): JourneyConsequence[] {
  const unique = new Map<string, Draft>();
  for (const draft of drafts) if (!unique.has(draft.id)) unique.set(draft.id, draft);
  const sorted = [...unique.values()].sort((a, b) => compareDrafts(walk, a, b));
  let expanded = 0;
  let warnShown = false;
  return sorted.map((draft) => {
    let open = false;
    if (draft.severity === "block") open = true;
    else if (draft.severity === "act" && expanded < JOURNEY_LIMITS.maxExpanded) open = true;
    else if (draft.severity === "warn" && !warnShown && expanded < JOURNEY_LIMITS.maxExpanded) {
      open = true;
      warnShown = true;
    }
    if (open) expanded += 1;
    const recommended = draft.options.find((entry) => entry.recommended) ?? null;
    const asks = draft.severity === "block" || (draft.severity === "act" && recommended !== null);
    const { question, ...rest } = draft;
    const options = draft.severity === "block" && !draft.options.some((entry) => entry.action.type === "acknowledge")
      ? [...draft.options, OK_OPTION]
      : draft.options;
    return {
      ...rest,
      options,
      ...(asks ? { prompt: { question: question ?? draft.title, defaultOptionId: recommended?.id ?? null } } : {}),
      collapsed: !open,
    };
  });
}

function stageOf(graph: IntentGraph): JourneyStage {
  if (TERMINAL_INTENT_STATUSES.has(graph.status)) return "final";
  return graph.steps.some((step) => started(step) || step.status === "failed" || (step.references?.length ?? 0) > 0) ? "live" : "plan";
}

function nowOf(walk: Walk): Journey["now"] {
  const current = walk.stops.filter((stop) => stop.state === "current").map((stop) => stop.id);
  const flight = walk.order.find((step) => IN_FLIGHT_STATUSES.has(step.status));
  if (flight) return { stopIds: current, legId: flight.id, waitingFor: "settlement" };
  const failed = walk.order.find((step) => step.status === "failed");
  if (failed) return { stopIds: current, legId: failed.id, waitingFor: "decision" };
  const next = walk.order.find((step) => (step.status === "ready" || step.status === "awaiting_signature") && step.mode === "wallet") ??
    walk.order.find((step) => step.status === "pending" && step.mode === "wallet");
  if (next) return { stopIds: current, legId: next.id, waitingFor: "signature" };
  return { stopIds: current, legId: null, waitingFor: "nothing" };
}

/** "sha256:" over stops, holding amounts and consequence ids and severities. */
export function journeyDigest(journey: Omit<Journey, "digest">): string {
  const material = {
    spec: journey.spec,
    intentId: journey.intentId,
    stops: journey.stops.map((stop) => [
      stop.id,
      stop.network,
      stop.custody,
      stop.state,
      stop.holdings.map((entry) => [normalizedAsset(entry.asset.asset), entry.expected.amount, entry.atLeast.amount, entry.role]),
    ]),
    consequences: journey.consequences.map((consequence) => [consequence.id, consequence.severity]),
  };
  return `sha256:${sha256Hex(canonicalJson(material))}`;
}

/**
 * The journey of an intent: a pure, deterministic function of the graph,
 * the preview it was built from and the facts the engine read. Same
 * inputs give byte-identical JSON.
 */
export function buildJourney(graph: IntentGraph, preview: IntentPreview | null, facts: JourneyFacts, now: string | number | Date): Journey {
  const at = new Date(now);
  const time = at.getTime();
  const walk = walkGraph(graph, preview, facts);
  const stage = stageOf(graph);
  const drafts: Draft[] = [];
  const gasFired = ruleGasToContinue(walk, drafts);
  ruleGasToLeave(walk, drafts, gasFired);
  ruleAssetIdentity(walk, drafts);
  rulePriceExposure(walk, drafts);
  ruleVenueCapacity(walk, drafts);
  ruleRuleBook(walk, drafts, time);
  ruleIfStopped(walk, drafts);
  ruleRefundPath(walk, drafts);
  ruleAllowanceLeft(walk, drafts);
  ruleTimeWindow(walk, drafts, time, stage);
  const nowView = nowOf(walk);
  if (nowView.waitingFor !== "decision" && !graph.steps.some((step) => step.status === "failed")) ruleIdleFunds(walk, drafts);
  ruleExitPath(walk, drafts);
  const consequences = finishConsequences(walk, drafts);
  const stops: JourneyStop[] = walk.stops.map((stop, index) => ({
    id: stop.id,
    index,
    kind: stop.kind,
    network: stop.network,
    holder: stop.holder,
    custody: stop.custody,
    state: stop.state,
    holdings: stop.holdings,
    ...(stop.eta ? { eta: stop.eta } : {}),
    ...(stop.reachedAt ? { reachedAt: stop.reachedAt } : {}),
    ...(stop.evidence ? { evidence: stop.evidence } : {}),
    ...(stop.venue ? { venue: stop.venue } : {}),
  }));
  const journey: Omit<Journey, "digest"> = {
    spec: JOURNEY_SPEC,
    intentId: preview?.intentId ?? graph.id,
    computedAt: at.toISOString(),
    stage,
    basis: { intentUpdatedAt: graph.updatedAt, previewDigest: preview?.digest ?? null, reads: facts.reads, factsAt: facts.reads === "none" ? null : facts.at },
    stops,
    legs: legsOf(walk),
    now: nowView,
    consequences,
    blockers: consequences.filter((consequence) => consequence.severity === "block").map((consequence) => consequence.id),
  };
  return { ...journey, digest: journeyDigest(journey) };
}

/** Blocking consequences not answered in `answered` (consequence id → option id of that consequence). */
export function openBlockers(journey: Journey, answered: Readonly<Record<string, string>>): readonly JourneyConsequence[] {
  return journey.consequences.filter((consequence) => {
    if (consequence.severity !== "block") return false;
    const answer = answered[consequence.id];
    return answer === undefined || !consequence.options.some((entry) => entry.id === answer);
  });
}
