/**
 * The other consequence rules: asset identity, price exposure, venue
 * capacity, rule books, failures, refunds, allowances, time windows, idle
 * funds and exit paths.
 */
import { CHAINS, type NetworkKey } from "../chains.js";
import { fromBaseUnits } from "../amounts.js";
import { getProtocol, YIELD_VENUES } from "../protocols.js";
import { PREVIEW_CHANGE_LIMITS } from "../preview.js";
import { scheduleState } from "../policyEvaluate.js";
import { topologicalOrder } from "../lifecycle.js";
import { fundingParent } from "../flow.js";
import type {
  AssetRef,
  IntentActionSpec,
  IntentGraph,
  IntentRequest,
  IntentStep,
} from "../intent.js";
import {
  type ConsequenceSeverity,
  JOURNEY_DEPOSIT_OPTION_PREFIX,
  type JourneyStage,
} from "./constants.js";
import {
  JOURNEY_LIMITS,
  type JourneyHolding,
  type JourneyOption,
} from "./types.js";
import {
  actionsRequest,
  cents,
  type Draft,
  isCross,
  isNativeOf,
  isStable,
  lifiTool,
  lookupAsset,
  MANUAL_REVIEW_SECONDS,
  nativeKey,
  networkName,
  normalizedAsset,
  OK_OPTION,
  oneToOne,
  option,
  PAYLOAD_TTL_SECONDS,
  refundPath,
  sameAsset,
  started,
  symbolText,
  timeOf,
  underlyingRef,
  usdText,
  venueName,
  view,
} from "./helpers.js";
import {
  explorerLink,
  legSeconds,
  legTitle,
  mainReference,
  stepVenue,
  type StopDraft,
  type Walk,
} from "./walk.js";
import { actionsFromGraph, continuationRequest } from "./continuation.js";

function belowDust(entry: JourneyHolding): boolean {
  return entry.value.expectedUsd !== null && entry.value.expectedUsd < JOURNEY_LIMITS.dustUsd;
}

/** R3 asset identity of arrival and end holdings. */
export function ruleAssetIdentity(walk: Walk, drafts: Draft[]): void {
  const seen = new Set<string>();
  for (const stop of walk.stops) {
    if ((stop.kind !== "arrival" && stop.kind !== "end") || stop.state === "skipped") continue;
    for (const entry of stop.holdings) {
      if (entry.role === "gas" || entry.identity.kind === "native" || entry.identity.kind === "issuer" || belowDust(entry)) continue;
      const id = `asset-identity:${stop.id}:${normalizedAsset(entry.asset.asset)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      drafts.push({
        id,
        kind: "asset-identity",
        severity: entry.identity.kind === "unlisted" ? "warn" : "info",
        stopId: stop.id,
        legIds: [],
        title: `${entry.asset.symbol} on ${networkName(stop.network)}: ${entry.identity.kind.replace("-", " ")}`,
        detail: entry.identity.label,
        certainty: "quoted",
        facts: { asset: entry.asset.asset },
        source: "Kletia asset and venue registry",
        options: [],
      });
    }
  }
}

/** R4 price exposure. */
export function rulePriceExposure(walk: Walk, drafts: Draft[]): void {
  for (const step of walk.order) {
    if (step.status === "settled" || step.status === "skipped") continue;
    const input = step.input;
    const output = step.minimumOutput ?? step.expectedOutput;
    const stopId = `out:${step.id}`;
    if (isCross(step) && input && output) {
      const sameKind = (lookupAsset(input.asset)?.group ?? input.symbol) === (lookupAsset(output.asset)?.group ?? output.symbol);
      if (sameKind && !isStable(input.asset)) {
        drafts.push({
          id: `price-exposure:${stopId}:units`, kind: "price-exposure", severity: "info", stopId, legIds: [step.id],
          title: `${input.symbol} units are fixed; their dollar value moves`,
          detail: `The ${input.symbol} amount is fixed when you sign; its dollar value moves with ${input.symbol} for about ${legSeconds(step) ?? 20} s until it arrives.`,
          certainty: "quoted", facts: {}, source: "Rule (volatile asset in transit)", options: [],
        });
      } else if (!sameKind) {
        drafts.push({
          id: `price-exposure:${stopId}:cross-asset`, kind: "price-exposure", severity: "info", stopId, legIds: [step.id],
          title: `${venueName(step)} swaps ${input.symbol} into ${output.symbol} on arrival`,
          detail: `The ${output.symbol} amount is fixed when you sign; a refund would return ${input.symbol} on ${networkName(step.network)}, not ${output.symbol}.`,
          certainty: "quoted", facts: {}, source: "Rule (cross-asset leg)", options: [],
        });
      }
    }
    const parent = fundingParent(walk.graph, step);
    if (parent && isCross(parent) && input && output && ["swap", "stake", "bridge"].includes(step.kind)) {
      const volatile = !isStable(input.asset) || !isStable(output.asset);
      drafts.push({
        id: `price-exposure:${walk.inputStop.get(step.id) ?? stopId}:reprice`, kind: "price-exposure", severity: volatile ? "warn" : "info",
        stopId: walk.inputStop.get(step.id) ?? stopId, legIds: [step.id],
        title: `Step ${walk.order.indexOf(step) + 1} is priced again when the money arrives`,
        detail: `${legTitle(walk, step)} is quoted again before you sign it; you are asked again if its guaranteed amount is more than ${(PREVIEW_CHANGE_LIMITS.amountToleranceBps / 100).toFixed(1)}% worse than what you approved.`,
        certainty: "quoted", facts: { toleranceBps: String(PREVIEW_CHANGE_LIMITS.amountToleranceBps) }, source: "Rule (preview binding tolerance)", options: [],
      });
    }
    const venue = stepVenue(step);
    if (step.kind === "deposit" && venue && !oneToOne(venue) && venue.kind !== "jupiter-lend" && venue.kind !== "kamino-reserve" && venue.kind !== "save-reserve") {
      drafts.push({
        id: `price-exposure:${stopId}:shares`, kind: "price-exposure", severity: "info", stopId, legIds: [step.id],
        title: `${venue.name} shares can lose value`,
        detail: `You hold vault shares; their value in ${venue.asset} follows the vault and can fall if the vault loses money.`,
        certainty: "quoted", facts: {}, source: "Rule (vault shares)", options: [],
      });
    }
  }
}

/** The whole intent as actions with `step` free to use any listed venue (plan stage: nothing landed yet). */
function withoutVenue(graph: IntentGraph, step: IntentStep): IntentRequest | null {
  const actions = actionsFromGraph(graph);
  const index = topologicalOrder(graph.steps).filter((candidate) => candidate.mode !== "read").findIndex((candidate) => candidate.id === step.id);
  if (!actions || index < 0 || !actions[index]) return null;
  const { protocol: _protocol, params, ...rest } = actions[index] as IntentActionSpec;
  void _protocol;
  const kept = params ? Object.fromEntries(Object.entries(params).filter(([key]) => key !== "venue")) : {};
  actions[index] = { ...rest, ...(Object.keys(kept).length > 0 ? { params: kept } : {}) };
  return actionsRequest(graph, actions);
}

/** R5 venue capacity of deposit and withdraw legs. */
export function ruleVenueCapacity(walk: Walk, drafts: Draft[]): void {
  for (const step of walk.order) {
    if ((step.kind !== "deposit" && step.kind !== "withdraw") || started(step) || step.status === "skipped") continue;
    const venue = stepVenue(step);
    if (!venue) continue;
    const fact = walk.facts.venues[venue.id];
    const stopId = step.kind === "deposit" ? `out:${step.id}` : (walk.inputStop.get(step.id) ?? `start:${step.id}`);
    const flow = walk.flows.get(step.id);
    const amount = flow ? flow.spends.expected : step.input ? BigInt(step.input.amount) : 0n;
    const decimals = step.input?.decimals ?? 0;
    const symbol = step.input?.symbol ?? venue.asset;
    const replan = continuationRequest(walk.graph, walk.inputStop.get(step.id) ?? `start:${step.id}`, { anyVenue: true }) ?? withoutVenue(walk.graph, step);
    const anyVenue = replan ? [option("replan-any-venue", "Plan it at another listed venue", "Re-plans the rest of the journey without this venue; you review the new fare before signing.", { type: "replan", request: replan }, null, true)] : [];
    if (walk.facts.reads === "none" && fact === undefined) continue;
    if (fact === undefined || fact === null) {
      drafts.push({
        id: `venue-capacity:${stopId}`, kind: "venue-capacity", severity: "info", stopId, legIds: [step.id],
        title: `Could not read ${venue.name}'s capacity`,
        detail: `Kletia could not read ${venue.name}'s caps and liquidity; the venue is checked again when the step is prepared.`,
        certainty: "estimated", facts: {}, source: `${venue.name} reads failed at ${timeOf(walk.facts.at)}`, options: [],
      });
      continue;
    }
    const base = { kind: "venue-capacity" as const, stopId, legIds: [step.id], certainty: "observed" as const, source: `${venue.name} on-chain state read at ${timeOf(fact.at)}` };
    if (fact.paused || fact.frozen) {
      drafts.push({
        ...base, id: `venue-capacity:${stopId}`, severity: "block",
        title: `${venue.name} is ${fact.paused ? "paused" : "frozen"}`,
        detail: `${venue.name} does not accept ${step.kind === "deposit" ? "deposits" : "withdrawals"} right now, so step ${walk.order.indexOf(step) + 1} would be refused.`,
        facts: { paused: String(fact.paused), frozen: String(fact.frozen) },
        options: [...anyVenue, OK_OPTION], question: `${venue.name} is not accepting this step. What should happen?`,
      });
      continue;
    }
    if (step.kind === "deposit" && fact.capRemaining !== null && /^\d+$/u.test(fact.capRemaining)) {
      const headroom = BigInt(fact.capRemaining);
      if (headroom < amount) {
        drafts.push({
          ...base, id: `venue-capacity:${stopId}`, severity: "block",
          title: `${venue.name} is nearly full`,
          detail: `${venue.name} can take ${symbolText(view(headroom, decimals), symbol)} more under its supply cap; this step deposits about ${symbolText(view(amount, decimals), symbol)}.`,
          facts: { capRemaining: fact.capRemaining, amount: amount.toString() },
          options: [...anyVenue, OK_OPTION], question: `${venue.name} cannot take the whole deposit. What should happen?`,
        });
        continue;
      }
      if (headroom < amount * BigInt(JOURNEY_LIMITS.capWarnMultiple)) {
        drafts.push({
          ...base, id: `venue-capacity:${stopId}`, severity: "warn",
          title: `${venue.name} has little room under its cap`,
          detail: `${symbolText(view(headroom, decimals), symbol)} still fits under ${venue.name}'s supply cap; it could fill before this step runs.`,
          facts: { capRemaining: fact.capRemaining, amount: amount.toString() },
          options: anyVenue,
        });
      }
    }
    if (step.kind === "withdraw" && fact.exitLiquidity !== null && /^\d+$/u.test(fact.exitLiquidity) && BigInt(fact.exitLiquidity) < amount) {
      drafts.push({
        ...base, id: `venue-capacity:${stopId}`, severity: "block",
        title: `${venue.name} cannot pay out ${symbolText(view(amount, decimals), symbol)} right now`,
        detail: `${symbolText(view(BigInt(fact.exitLiquidity), decimals), symbol)} can leave ${venue.name} now; borrowers hold the rest.`,
        facts: { exitLiquidity: fact.exitLiquidity, amount: amount.toString() },
        options: [OK_OPTION], question: `${venue.name} cannot pay out the whole amount now. What should happen?`,
      });
    }
  }
}

function usdMicrosOf(value: string | null): number | null {
  if (value === null || !/^\d+(\.\d+)?$/u.test(value)) return null;
  return Number(value);
}

/** R6 Rule Book headroom, schedule and approval expiry. */
export function ruleRuleBook(walk: Walk, drafts: Draft[], now: number): void {
  const policy = walk.facts.policy;
  if (!policy || !walk.graph.policy) return;
  const later = walk.order.filter((step) => !started(step) && step.status !== "skipped" && step.status !== "settled" && step.mode === "wallet");
  const notional = (step: IntentStep): number | null => {
    const stop = walk.byId.get(walk.inputStop.get(step.id) ?? "");
    const entry = stop?.holdings.find((candidate) => candidate.next?.legId === step.id) ?? stop?.holdings[0];
    return entry?.value.expectedUsd ?? null;
  };
  const source = `Rule Book read at ${timeOf(walk.facts.at)}`;
  const perStep = usdMicrosOf(policy.perStepUsd);
  let total = 0;
  let priced = true;
  for (const step of later) {
    const value = notional(step);
    if (value === null) {
      priced = false;
      continue;
    }
    total += value;
    if (perStep === null || walk.order.indexOf(step) === 0) continue;
    const stopId = walk.inputStop.get(step.id) ?? null;
    if (value > perStep) {
      drafts.push({
        id: `rule-book:${stopId}:per-step`, kind: "rule-book", severity: "block", stopId, legIds: [step.id],
        title: `Step ${walk.order.indexOf(step) + 1} is above your Rule Book's per-step cap`,
        detail: `It moves about $${value.toFixed(2)}; the cap is $${perStep.toFixed(2)}, so prepare would refuse it.`,
        certainty: "estimated", facts: { notionalUsd: value.toFixed(2), perStepUsd: policy.perStepUsd ?? "" }, source,
        options: [OK_OPTION], question: "This step exceeds your Rule Book. What should happen?",
      });
    } else if (value > perStep * 0.8) {
      drafts.push({
        id: `rule-book:${stopId}:per-step`, kind: "rule-book", severity: "warn", stopId, legIds: [step.id],
        title: `Step ${walk.order.indexOf(step) + 1} is close to your per-step cap`,
        detail: `About $${value.toFixed(2)} of a $${perStep.toFixed(2)} cap; a price move could push it over.`,
        certainty: "estimated", facts: { notionalUsd: value.toFixed(2), perStepUsd: policy.perStepUsd ?? "" }, source, options: [OK_OPTION],
      });
    }
  }
  for (const [label, remaining] of [["daily", usdMicrosOf(policy.dailyRemainingUsd)], ["weekly", usdMicrosOf(policy.weeklyRemainingUsd)]] as const) {
    if (remaining === null || !priced || later.length === 0) continue;
    if (total > remaining) {
      drafts.push({
        id: `rule-book:${label}`, kind: "rule-book", severity: "block", stopId: null, legIds: later.map((step) => step.id),
        title: `The remaining steps exceed your ${label} Rule Book allowance`,
        detail: `They move about $${total.toFixed(2)}; $${remaining.toFixed(2)} is left in the ${label === "daily" ? "rolling 24 h" : "rolling 7 d"} window.`,
        certainty: "estimated", facts: { totalUsd: total.toFixed(2), remainingUsd: remaining.toFixed(2) }, source,
        options: [OK_OPTION], question: `The ${label} allowance would be exceeded. What should happen?`,
      });
    } else if (total > remaining * 0.8) {
      drafts.push({
        id: `rule-book:${label}`, kind: "rule-book", severity: "warn", stopId: null, legIds: later.map((step) => step.id),
        title: `The remaining steps use most of your ${label} allowance`,
        detail: `About $${total.toFixed(2)} of $${remaining.toFixed(2)} left.`,
        certainty: "estimated", facts: { totalUsd: total.toFixed(2), remainingUsd: remaining.toFixed(2) }, source, options: [OK_OPTION],
      });
    }
  }
  const eta = walk.stops.reduce((max, stop) => Math.max(max, stop.eta?.afterFirstSignatureSeconds ?? 0), 0);
  if (policy.schedule) {
    for (const step of later) {
      const at = now + (walk.byId.get(walk.inputStop.get(step.id) ?? "")?.eta?.afterFirstSignatureSeconds ?? 0) * 1000;
      const state = scheduleState(policy.schedule, at);
      if (state.open) continue;
      drafts.push({
        id: `rule-book:${walk.inputStop.get(step.id) ?? step.id}:schedule`, kind: "rule-book", severity: "warn", stopId: walk.inputStop.get(step.id) ?? null, legIds: [step.id],
        title: `Your Rule Book is closed when step ${walk.order.indexOf(step) + 1} would run`,
        detail: `Its schedule opens again at ${state.nextChange ? timeOf(state.nextChange) : "a later time"}; the money waits at that stop until then.`,
        certainty: "estimated", facts: { nextChange: state.nextChange ?? "" }, source, options: [OK_OPTION],
      });
      break;
    }
  }
  if (policy.approvalExpiresAt) {
    const expires = Date.parse(policy.approvalExpiresAt);
    if (Number.isFinite(expires) && expires < now + eta * 1000) {
      drafts.push({
        id: "rule-book:approval", kind: "rule-book", severity: "warn", stopId: null, legIds: later.map((step) => step.id),
        title: "The approval expires before the journey ends",
        detail: `The approval hold ends at ${timeOf(policy.approvalExpiresAt)}; later steps need a new approval after that.`,
        certainty: "observed", facts: { approvalExpiresAt: policy.approvalExpiresAt }, source,
        options: walk.graph.policy.approval ? [option("ok", "Understood", "Nothing changes.", { type: "link", url: walk.graph.policy.approval.url })] : [OK_OPTION],
      });
    }
  }
}

const RETRY_REFUSED_CODES: ReadonlySet<string> = new Set(["SETTLEMENT_REFUNDED", "SETTLEMENT_FAILED", "SETTLEMENT_MISMATCH"]);

function bringBackText(stop: StopDraft, origin: NetworkKey): string | null {
  const main = stop.holdings.find((entry) => entry.role !== "gas" && entry.role !== "paid");
  if (!main || stop.network === origin) return null;
  return `bridge ${fromBaseUnits(main.atLeast.amount, main.asset.decimals)} ${main.asset.symbol} from ${stop.network} to ${origin}`;
}

/** The stop where the money waits after a failed leg. */
function failureStop(walk: Walk, step: IntentStep): string {
  const code = step.failure?.code ?? "";
  if (code === "SETTLEMENT_REFUNDED" || (code === "SETTLEMENT_FAILED" && isCross(step))) return `transit:${step.id}`;
  if (step.observedCredit) return `out:${step.id}`;
  return walk.inputStop.get(step.id) ?? `start:${step.id}`;
}

/** R7 if stopped (plan: folded notes per arrival stop; live: options after a failed leg). */
export function ruleIfStopped(walk: Walk, drafts: Draft[]): void {
  const origin = walk.order[0]?.network ?? "base";
  for (const step of walk.order) {
    if (step.status !== "failed") continue;
    const stopId = failureStop(walk, step);
    const stop = walk.byId.get(stopId);
    if (!stop) continue;
    const code = step.failure?.code ?? "";
    const options: JourneyOption[] = [];
    const retryable = !RETRY_REFUSED_CODES.has(code) && !step.observedCredit;
    if (retryable) options.push(option("retry", `Try step ${walk.order.indexOf(step) + 1} again`, "Prepares the same leg again with a fresh quote; you sign it again.", { type: "retry", legId: step.id }, null, true));
    const resumeFrom = stop.role === "transit" ? `start:${step.id}` : stopId;
    const same = continuationRequest(walk.graph, resumeFrom);
    const any = continuationRequest(walk.graph, resumeFrom, { anyVenue: true });
    if (same) options.push(option("replan-same-venue", "Plan the rest again", "Plans what is left from here as a new intent with the amount that landed; you review its fare first.", { type: "replan", request: same }, null, !retryable));
    if (any) options.push(option("replan-any-venue", "Plan the rest at any listed venue", "Same, without holding to this venue.", { type: "replan", request: any }));
    options.push(option("end-here", "End the journey here", `Stops the intent; the money stays where it is (${stop.holder.label}).`, { type: "stop" }));
    const back = bringBackText(stop, origin);
    if (back) options.push(option("bring-back", `Bring it back to ${networkName(origin)}`, "A separate new intent you review before signing.", { type: "plan-new", text: back }));
    const main = stop.holdings.find((entry) => entry.role !== "gas");
    drafts.push({
      id: `if-stopped:${stopId}`,
      kind: "if-stopped",
      severity: "act",
      stopId,
      legIds: [step.id],
      title: `Step ${walk.order.indexOf(step) + 1} did not complete`,
      detail: `${step.failure?.message ?? "The leg failed."} ${main ? `Your ${symbolText(main.atLeast, main.asset.symbol)} ${stop.custody === "refund-due" ? "is being refunded to" : stop.custody === "unknown" ? "is with" : "waits at"} ${stop.custody === "refund-due" ? `your ${networkName(step.network)} wallet` : stop.holder.label}.` : ""}`.trim(),
      certainty: main?.certainty ?? "observed",
      facts: { code },
      source: "Step status",
      options,
      question: `Step ${walk.order.indexOf(step) + 1} did not complete. What next?`,
    });
  }
  for (const stop of walk.stops) {
    if (stop.kind !== "arrival" || stop.state === "skipped" || stop.state === "passed") continue;
    const main = stop.holdings.find((entry) => entry.role === "spent-next");
    if (!main?.next) continue;
    const child = walk.graph.steps.find((candidate) => candidate.id === main.next?.legId);
    if (!child || child.status === "failed") continue;
    const number = walk.order.indexOf(child) + 1;
    drafts.push({
      id: `if-stopped:${stop.id}`, kind: "if-stopped", severity: "info", stopId: stop.id, legIds: [child.id],
      title: `If step ${number} cannot run, the money waits in ${stop.holder.label}`,
      detail: `Your ${symbolText(main.atLeast, main.asset.symbol)} would stay in ${stop.holder.label} on ${networkName(stop.network)}; nothing is re-planned on its own. You can retry, plan the rest again or end the journey there.`,
      certainty: main.certainty, facts: {}, source: "Rule (amount flow F5)", options: [],
    });
  }
}

/** R8 refund path of every cross-network leg. */
export function ruleRefundPath(walk: Walk, drafts: Draft[]): void {
  for (const step of walk.order) {
    if (!isCross(step) || step.status === "settled" || step.status === "skipped") continue;
    const refund = refundPath(walk.graph, step);
    if (!refund) continue;
    const stopId = `transit:${step.id}`;
    let severity: ConsequenceSeverity = "info";
    const options: JourneyOption[] = [];
    let detail = refund.label;
    if (refund.needs && refund.needs.account) {
      const balance = walk.facts.native[nativeKey(refund.needs.network, refund.needs.account)];
      if (balance && BigInt(balance.amount) === 0n) {
        severity = "act";
        detail = `${refund.label} Your ${networkName(refund.needs.network)} account holds no ${refund.needs.asset.symbol} now: to cancel an unfilled order you need ${refund.needs.asset.symbol} on ${networkName(refund.needs.network)}.`;
        options.push(option("bring-gas", `Keep some ${refund.needs.asset.symbol} on ${networkName(refund.needs.network)}`, `Send a little ${refund.needs.asset.symbol} to that account if the order stays unfilled.`, { type: "acknowledge" }));
      }
    }
    drafts.push({
      id: `refund-path:${stopId}`, kind: "refund-path", severity, stopId, legIds: [step.id],
      title: `If ${venueName(step)} cannot fill`,
      detail,
      certainty: "quoted",
      facts: { mode: refund.mode, delay: refund.typicalDelay },
      source: `${venueName(step)} documentation`,
      options,
    });
  }
}

/** R9 approvals that stay open. */
export function ruleAllowanceLeft(walk: Walk, drafts: Draft[]): void {
  const seen = new Set<string>();
  const push = (network: NetworkKey, token: AssetRef, spender: string, spenderLabel: string, amount: string, source: string, stepId: string | null) => {
    const id = `allowance-left:${network}:${normalizedAsset(token.asset)}:${spender.toLowerCase()}`;
    if (seen.has(id) || !/^\d+$/u.test(amount) || BigInt(amount) === 0n) return;
    seen.add(id);
    const explorer = CHAINS[network].explorer.address.replace("{address}", spender);
    drafts.push({
      id, kind: "allowance-left", severity: "warn", stopId: stepId ? `out:${stepId}` : null, legIds: stepId ? [stepId] : [],
      title: `${symbolText(view(BigInt(amount), token.decimals), token.symbol)} stays approved to ${spenderLabel}`,
      detail: `${spenderLabel} can still move that much ${token.symbol} from your ${networkName(network)} wallet. To close it, call approve(${spender}, 0) on the ${token.symbol} contract.`,
      certainty: "simulated", facts: { amount, spender }, source,
      options: [option("ok", "Understood", "Nothing changes; you can revoke it any time.", { type: "link", url: explorer })],
    });
  };
  for (const approval of walk.preview?.approvals ?? []) {
    if (approval.leftAfter !== null) push(approval.network, approval.token, approval.spender, approval.spenderLabel, approval.leftAfter, "Simulation of the step", approval.stepId);
  }
  for (const allowance of walk.facts.allowances) push(allowance.network, allowance.token, allowance.spender, allowance.spenderLabel, allowance.amount, `RPC read at ${timeOf(allowance.at)}`, null);
}

/** R10 time windows: expiry, payload lifetime, legs overdue in transit. */
export function ruleTimeWindow(walk: Walk, drafts: Draft[], now: number, stage: JourneyStage): void {
  if (stage === "plan") {
    const first = walk.stops[0];
    const across = walk.order.some((step) => step.protocol === "across" || (step.protocol === "lifi" && lifiTool(step) !== "polymer" && isCross(step)));
    const solana = walk.order.some((step) => CHAINS[step.network].vm === "svm" && step.mode === "wallet");
    drafts.push({
      id: `time-window:${first?.id ?? "plan"}`, kind: "time-window", severity: "info", stopId: first?.id ?? null, legIds: [],
      title: "Time limits of this plan",
      detail: [
        `The plan expires at ${timeOf(walk.graph.expiresAt)} if nothing is signed.`,
        `Each prepared step is valid for ${PAYLOAD_TTL_SECONDS} s${solana ? " (Solana: until its blockhash expires)" : ""}.`,
        ...(across ? ["Across fills have a fill deadline of at least 10 minutes; unfilled deposits are refunded after it."] : []),
      ].join(" "),
      certainty: "quoted", facts: { expiresAt: walk.graph.expiresAt }, source: "Plan", options: [],
    });
    return;
  }
  for (const step of walk.order) {
    if (step.status !== "submitted" && step.status !== "settling" && step.status !== "confirmed") continue;
    const seconds = legSeconds(step);
    const evidence = step.evidence.find((entry) => entry.kind === "transaction")?.observedAt ?? step.prepared?.preparedAt;
    const since = evidence ? Date.parse(evidence) : NaN;
    if (seconds === null || !Number.isFinite(since)) continue;
    const elapsed = (now - since) / 1000;
    if (elapsed <= seconds * 2 + 60) continue;
    const tracking = explorerLink(step.network, mainReference(step));
    const left = Math.max(0, MANUAL_REVIEW_SECONDS - elapsed);
    drafts.push({
      id: `time-window:transit:${step.id}`, kind: "time-window", severity: "warn", stopId: isCross(step) ? `transit:${step.id}` : `out:${step.id}`, legIds: [step.id],
      title: `Step ${walk.order.indexOf(step) + 1} is taking longer than usual`,
      detail: `It usually takes about ${Math.round(seconds)} s and has taken ${Math.round(elapsed)} s. Kletia keeps checking; after 3 hours an unresolved leg goes to manual review (${Math.round(left / 60)} min left).`,
      certainty: "observed", facts: { elapsedSeconds: String(Math.round(elapsed)), expectedSeconds: String(Math.round(seconds)) }, source: "Clock and step evidence",
      options: tracking ? [option("track", tracking.label, "Opens the explorer for the deposit transaction.", { type: "link", url: tracking.url })] : [],
    });
  }
}

/** R11 idle funds: listed venues on the same network for kept or end wallet holdings. */
export function ruleIdleFunds(walk: Walk, drafts: Draft[]): void {
  const { facts } = walk;
  for (const stop of walk.stops) {
    if (stop.custody !== "wallet" || !stop.holder.own || stop.state === "skipped") continue;
    for (const entry of stop.holdings) {
      const idle = entry.role === "kept" && (stop.kind === "end" || stop.kind === "arrival");
      if (!idle || isNativeOf(entry.asset.asset, stop.network)) continue;
      const usd = entry.value.atLeastUsd;
      if (usd === null || usd < JOURNEY_LIMITS.idleMinUsd) continue;
      const amount = BigInt(entry.atLeast.amount);
      const candidates = YIELD_VENUES.filter((venue) => {
        if (venue.network !== stop.network || !venue.actions.includes("deposit")) return false;
        const underlying = underlyingRef(venue);
        if (!underlying || !sameAsset(underlying.asset, entry.asset.asset)) return false;
        const fact = facts.venues[venue.id];
        if (!fact || fact.paused || fact.frozen || fact.apy === null || fact.apy < JOURNEY_LIMITS.suggestionMinApy) return false;
        if (fact.utilization === null || fact.utilization >= JOURNEY_LIMITS.suggestionMaxUtilization) return false;
        if (fact.exitLiquidity === null || !/^\d+$/u.test(fact.exitLiquidity)) return false;
        return BigInt(fact.exitLiquidity) >= amount * BigInt(JOURNEY_LIMITS.suggestionMinExitMultiple);
      }).sort((a, b) => (facts.venues[b.id]?.apy ?? 0) - (facts.venues[a.id]?.apy ?? 0) || a.id.localeCompare(b.id)).slice(0, 2);
      if (candidates.length === 0) continue;
      drafts.push({
        id: `idle-funds:${stop.id}:${normalizedAsset(entry.asset.asset)}`, kind: "idle-funds", severity: "info", stopId: stop.id, legIds: [],
        title: `${symbolText(entry.atLeast, entry.asset.symbol)} stays idle on ${networkName(stop.network)}`,
        detail: `It earns nothing in your wallet. Listed venues there: ${candidates.map((venue) => `${venue.name} ${((facts.venues[venue.id]?.apy ?? 0) * 100).toFixed(2)}% APY`).join(", ")} (variable, not guaranteed).`,
        certainty: entry.certainty, facts: { amount: entry.atLeast.amount }, source: `Venue reads at ${timeOf(facts.at)}`,
        options: candidates.map((venue) => option(
          `${JOURNEY_DEPOSIT_OPTION_PREFIX}${venue.id}`,
          `Deposit into ${venue.name}`,
          "A separate new intent you review before signing; nothing runs on its own.",
          { type: "plan-new", text: `deposit ${fromBaseUnits(entry.atLeast.amount, entry.asset.decimals)} ${entry.asset.symbol} into ${(getProtocol(venue.protocol)?.name ?? venue.protocol).toLowerCase()} on ${stop.network}` },
        )),
      });
    }
  }
}

/** R12 exit path of end stops: venue liquidity, liquid staking, money bridged away. */
export function ruleExitPath(walk: Walk, drafts: Draft[]): void {
  const origin = walk.order[0]?.network;
  for (const stop of walk.stops) {
    if (stop.kind !== "end" || stop.state === "skipped" || !stop.holder.own) continue;
    const main = stop.holdings.find((entry) => entry.role !== "gas");
    if (!main || belowDust(main)) continue;
    const step = walk.graph.steps.find((candidate) => candidate.id === stop.stepId);
    const venue = step ? stepVenue(step) : null;
    if (stop.custody === "venue" && venue) {
      const fact = walk.facts.venues[venue.id];
      const underlying = underlyingRef(venue);
      const flowIn = step ? walk.flows.get(step.id) : undefined;
      const deposited = flowIn ? flowIn.spends.worst : step?.input ? BigInt(step.input.amount) : 0n;
      const decimals = underlying?.decimals ?? main.asset.decimals;
      const symbol = underlying?.symbol ?? venue.asset;
      if (!fact) {
        drafts.push({
          id: `exit-path:${stop.id}`, kind: "exit-path", severity: "info", stopId: stop.id, legIds: [],
          title: `Withdraw from ${venue.name} any time while liquidity lasts`,
          detail: `${venue.name}'s exit liquidity could not be read now.`,
          certainty: "estimated", facts: {}, source: "Venue reads unavailable", options: [],
        });
        continue;
      }
      const exit = fact.exitLiquidity !== null && /^\d+$/u.test(fact.exitLiquidity) ? BigInt(fact.exitLiquidity) : null;
      const limited = (fact.utilization !== null && fact.utilization >= JOURNEY_LIMITS.suggestionMaxUtilization) || (exit !== null && exit < deposited);
      const liquidity = exit !== null ? `${symbolText(view(exit, decimals), symbol)} available now` : "exit liquidity not exposed";
      const utilization = fact.utilization !== null ? ` (${Math.round(fact.utilization * 100)}% utilized)` : "";
      drafts.push({
        id: `exit-path:${stop.id}`, kind: "exit-path", severity: limited ? "warn" : "info", stopId: stop.id, legIds: [],
        title: limited ? `Withdrawals from ${venue.name} are limited right now` : `Withdraw from ${venue.name} any time while liquidity lasts`,
        detail: `${liquidity}${utilization}.`,
        certainty: "observed", facts: { ...(fact.exitLiquidity !== null ? { exitLiquidity: fact.exitLiquidity } : {}), ...(fact.utilization !== null ? { utilization: String(fact.utilization) } : {}) },
        source: `${venue.name} read at ${timeOf(fact.at)}`, options: [],
      });
      continue;
    }
    if (main.identity.kind === "liquid-staking") {
      const solana = CHAINS[stop.network].vm === "svm";
      drafts.push({
        id: `exit-path:${stop.id}`, kind: "exit-path", severity: "info", stopId: stop.id, legIds: [],
        title: `Leaving ${main.asset.symbol}`,
        detail: solana
          ? `Swap ${main.asset.symbol} back to SOL through Jupiter any time, or unstake it (about 2 days).`
          : `Swap ${main.asset.symbol} back to ETH through a listed DEX any time, or redeem it through its issuer (days, the withdrawal queue).`,
        certainty: "quoted", facts: {}, source: "Rule (liquid staking)", options: [],
      });
      continue;
    }
    if (origin && stop.network !== origin && stop.custody === "wallet") {
      const crossFees = walk.order.filter((candidate) => isCross(candidate)).reduce((total, candidate) => total + (candidate.feesUsd ?? 0), 0);
      const back = bringBackText(stop, origin);
      drafts.push({
        id: `exit-path:${stop.id}`, kind: "exit-path", severity: "info", stopId: stop.id, legIds: [],
        title: `Bringing it back to ${networkName(origin)}`,
        detail: `Bringing it back costs about ${usdText(crossFees > 0 ? cents(crossFees) : null)} today (this route's fee; quote to be sure).`,
        certainty: "estimated", facts: { routeFeeUsd: crossFees.toFixed(4) }, source: "This route's fee",
        options: back ? [option("bring-back", `Bring it back to ${networkName(origin)}`, "A separate new intent you review before signing.", { type: "plan-new", text: back })] : [],
      });
    }
  }
}
