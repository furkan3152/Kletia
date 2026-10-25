/**
 * Walks the intent graph into stops and legs and assigns their states.
 */
import { CHAINS, type NetworkKey } from "../chains.js";
import { parseAccountId, sameAddressAccount, type AccountId } from "../caip.js";
import { getYieldVenue, type YieldVenue } from "../protocols.js";
import type { IntentPreview, StepPreview } from "../preview.js";
import { topologicalOrder } from "../lifecycle.js";
import {
  fundedFlow,
  fundingParent,
  isOwnRequestAccount,
  type FundedFlow,
  type ParentCredit,
} from "../flow.js";
import type { AssetRef, IntentGraph, IntentStep } from "../intent.js";
import type {
  CustodyState,
  HoldingRole,
  JourneyCertainty,
  StopKind,
  StopState,
} from "./constants.js";
import type {
  JourneyFacts,
  JourneyHolding,
  JourneyLeg,
  JourneyStop,
} from "./types.js";
import {
  assetIdentity,
  destinationOf,
  EXPLORER_REFERENCE,
  holderOf,
  isCross,
  isNativeOf,
  networkName,
  nonNegative,
  portionText,
  refOf,
  refundPath,
  sameAsset,
  shortAddress,
  started,
  valueOf,
  venueName,
  view,
} from "./helpers.js";

/* --------------------------------------------------------- stops and legs */

interface Credit {
  readonly asset: AssetRef;
  readonly expected: bigint;
  readonly worst: bigint;
  readonly certainty: JourneyCertainty;
}

export interface StopDraft {
  id: string;
  kind: StopKind;
  network: NetworkKey;
  holder: JourneyStop["holder"];
  custody: CustodyState;
  state: StopState;
  holdings: JourneyHolding[];
  eta?: JourneyStop["eta"];
  reachedAt?: string;
  evidence?: JourneyStop["evidence"];
  venue?: JourneyStop["venue"];
  readonly stepId: string;
  readonly role: "start" | "transit" | "out";
}

export interface Walk {
  readonly graph: IntentGraph;
  readonly preview: IntentPreview | null;
  readonly facts: JourneyFacts;
  readonly order: readonly IntentStep[];
  readonly stops: StopDraft[];
  readonly byId: Map<string, StopDraft>;
  /** Main output credit at out:<step>. */
  readonly credits: Map<string, Credit | null>;
  /** Funded flow of each funded step (what it spends of its parent's credit). */
  readonly flows: Map<string, FundedFlow>;
  /** Steps funded by each step, in order. */
  readonly children: Map<string, IntentStep[]>;
  /** Input stop id of each leg. */
  readonly inputStop: Map<string, string>;
}

function previewStepOf(preview: IntentPreview | null, stepId: string): StepPreview | undefined {
  return preview?.steps.find((entry) => entry.stepId === stepId);
}

function fundingOptions(walk: Pick<Walk, "facts">, step: IntentStep): { portionBps?: number; gasReserve?: bigint } {
  if (step.funding) return {};
  const fact = walk.facts.funding[step.id];
  if (!fact) return {};
  return {
    portionBps: fact.portionBps,
    ...(fact.gasReserve && /^\d+$/u.test(fact.gasReserve) ? { gasReserve: BigInt(fact.gasReserve) } : {}),
  };
}

function portionOf(walk: Pick<Walk, "facts">, step: IntentStep): number {
  return step.funding?.portionBps ?? walk.facts.funding[step.id]?.portionBps ?? 10_000;
}

/** Main output credit of a step: observed, else the preview's row, else the graph through core flow. */
function outputCredit(walk: Walk, step: IntentStep, flow: FundedFlow | null): Credit | null {
  if (step.status === "settled" && step.actualOutput) {
    const units = BigInt(step.actualOutput.amount);
    return { asset: refOf(step.actualOutput), expected: units, worst: units, certainty: "observed" };
  }
  if (step.status === "failed" && step.observedCredit) {
    const units = BigInt(step.observedCredit.amount);
    return { asset: refOf(step.observedCredit), expected: units, worst: units, certainty: "observed" };
  }
  const output = step.minimumOutput ?? step.expectedOutput;
  if (!output) return null;
  const asset = refOf(output);
  const holder = holderOf(walk.graph, step);
  const destination = destinationOf(step);
  const entry = previewStepOf(walk.preview, step.id);
  if (entry) {
    const row = entry.deltas.find((delta) =>
      delta.network === destination && sameAddressAccount(delta.account, holder) && sameAsset(delta.asset, asset.asset) && (BigInt(delta.expected.amount) > 0n || BigInt(delta.worst.amount) > 0n));
    if (row) return { asset, expected: nonNegative(BigInt(row.expected.amount)), worst: nonNegative(BigInt(row.worst.amount)), certainty: row.certainty };
    const payment = entry.payments.find((candidate) => candidate.stepId === step.id && sameAsset(candidate.asset, asset.asset));
    if (payment) return { asset, expected: nonNegative(BigInt(payment.expected.amount)), worst: nonNegative(BigInt(payment.worst.amount)), certainty: payment.certainty };
  }
  const expectedRaw = BigInt((step.expectedOutput ?? output).amount);
  const minimumRaw = BigInt((step.minimumOutput ?? output).amount);
  let expected = expectedRaw;
  let worst = minimumRaw;
  let certainty: JourneyCertainty = isCross(step) ? "venue-minimum" : "quoted";
  if (flow && flow.encoded > 0n) {
    if (flow.spends.expected !== flow.encoded) {
      expected = (expectedRaw * flow.spends.expected) / flow.encoded;
      certainty = "estimated";
    }
    if (flow.spends.worst < flow.encoded) worst = (minimumRaw * flow.spends.worst) / flow.encoded;
  }
  if (expected < worst) expected = worst;
  return { asset, expected, worst, certainty };
}

function holding(walk: Walk, network: NetworkKey, asset: AssetRef, expected: bigint, worst: bigint, certainty: JourneyCertainty, role: HoldingRole, venueHint: YieldVenue | null, next?: JourneyHolding["next"]): JourneyHolding {
  const identity = assetIdentity(asset, network, venueHint);
  return {
    asset,
    identity,
    expected: view(expected, asset.decimals),
    atLeast: view(worst, asset.decimals),
    certainty,
    value: valueOf(asset, identity, nonNegative(expected), nonNegative(worst), walk.facts, network, venueHint),
    role,
    ...(next ? { next } : {}),
  };
}

export function stepVenue(step: IntentStep): YieldVenue | null {
  return step.venue ? getYieldVenue(step.venue) : null;
}

function holderLabel(graph: IntentGraph, step: IntentStep, account: AccountId, network: NetworkKey): JourneyStop["holder"] {
  const own = isOwnRequestAccount(graph, account);
  if (own) return { account, own, label: `Your ${networkName(network)} wallet` };
  const parsed = parseAccountId(account);
  return { account, own, label: step.recipientName ?? shortAddress(parsed?.address ?? account) };
}

function settledAt(step: IntentStep): string | undefined {
  const evidence = [...step.evidence].reverse().find((entry) => entry.kind === "settlement" || entry.kind === "receipt" || entry.kind === "balance");
  return evidence?.observedAt;
}

export function explorerLink(network: NetworkKey, reference: string | undefined): { url: string; label: string } | null {
  if (!reference || !EXPLORER_REFERENCE.test(reference)) return null;
  const explorer = CHAINS[network].explorer;
  if (!explorer.tx.startsWith("https://")) return null;
  return { url: explorer.tx.replace("{hash}", reference), label: `View on ${explorer.name}` };
}

/**
 * The step's main transaction: the last one its wallet sent (approvals are
 * prepared before the swap, deposit or bridge they allow).
 */
export function mainReference(step: IntentStep): string | undefined {
  const references = step.references ?? [];
  return references[references.length - 1];
}

/** Explorer links of every transaction a step sent, the main one first; earlier ones named by their prepared description. */
function transactionLinks(step: IntentStep): { url: string; label: string }[] {
  const references = step.references ?? [];
  const described = step.prepared?.transactions.length === references.length ? step.prepared.transactions : null;
  const links: { url: string; label: string }[] = [];
  for (let index = references.length - 1; index >= 0; index -= 1) {
    const link = explorerLink(step.network, references[index]);
    if (!link) continue;
    const main = index === references.length - 1;
    const what = described?.[index]?.description.trim().slice(0, 60) || `Transaction ${index + 1} of ${references.length}`;
    links.push(main ? link : { url: link.url, label: `${what} on ${CHAINS[step.network].explorer.name}` });
  }
  return links;
}

/** Transactions a planned step asks for (prepared count when known; else the usual approve + action). */
function signaturesOf(step: IntentStep, preview: IntentPreview | null): number {
  if (step.mode !== "wallet") return 0;
  if (step.prepared) return step.prepared.transactions.length;
  const entry = previewStepOf(preview, step.id);
  if (CHAINS[step.network].vm === "svm") return 1;
  const tokenInput = step.input !== undefined && !isNativeOf(step.input.asset, step.network);
  if (entry && entry.approvals.length > 0) return entry.approvals.length + 1;
  if (!tokenInput || step.kind === "transfer" || step.kind === "withdraw") return 1;
  return 2;
}

export function legTitle(walk: Walk, step: IntentStep): string {
  const parent = fundingParent(walk.graph, step);
  if (!parent || !step.input) return step.title;
  const share = portionText(portionOf(walk, step));
  const match = /^(\S+)\s+[\d.,]+\s+(\S+)\s*(.*)$/u.exec(step.title);
  if (!match) return step.title;
  const verb = match[1] as string;
  const rest = match[3] ? ` ${match[3]}` : "";
  return `${verb} ${share}the ${step.input.symbol} that arrives${rest}`;
}

function etaOf(seconds: number, quoted: boolean): NonNullable<JourneyStop["eta"]> {
  return { afterFirstSignatureSeconds: Math.max(0, Math.round(seconds)), certainty: quoted ? "quoted" : "estimated" };
}

export function legSeconds(step: IntentStep): number | null {
  const seconds = step.estimatedSeconds ?? step.settlement?.expectedSeconds;
  return seconds === undefined || !Number.isFinite(seconds) ? null : seconds;
}

/** Builds stops, their amounts and states. */
export function walkGraph(graph: IntentGraph, preview: IntentPreview | null, facts: JourneyFacts): Walk {
  const order = topologicalOrder(graph.steps);
  const walk: Walk = {
    graph, preview, facts, order, stops: [], byId: new Map(), credits: new Map(), flows: new Map(), children: new Map(), inputStop: new Map(),
  };
  const add = (stop: StopDraft) => {
    walk.stops.push(stop);
    walk.byId.set(stop.id, stop);
  };
  const cumulative = new Map<string, number>();
  for (const step of order) {
    const parent = fundingParent(graph, step);
    const parentCredit = parent ? walk.credits.get(parent.id) ?? null : null;
    let flow: FundedFlow | null = null;
    if (parent && parentCredit && step.input && sameAsset(parentCredit.asset.asset, step.input.asset)) {
      const credit: ParentCredit = { expected: parentCredit.expected, worst: parentCredit.worst, certainty: parentCredit.certainty === "observed" ? "observed" : parentCredit.certainty };
      flow = fundedFlow(graph, step, credit, fundingOptions(walk, step));
      walk.flows.set(step.id, flow);
      walk.children.set(parent.id, [...(walk.children.get(parent.id) ?? []), step]);
    }
    // Seconds from the first signature until this leg can start: the slowest dependency.
    const before = step.dependsOn.reduce((total, id) => Math.max(total, cumulative.get(id) ?? 0), 0);
    const own = legSeconds(step);
    cumulative.set(step.id, before + (own ?? 0));
    const quoted = step.estimatedSeconds !== undefined;
    const venue = stepVenue(step);

    // Input stop.
    if (parent && walk.byId.has(`out:${parent.id}`)) {
      walk.inputStop.set(step.id, `out:${parent.id}`);
    } else if (step.input) {
      const id = `start:${step.id}`;
      const withdraw = step.kind === "withdraw";
      const input = step.input;
      const units = BigInt(input.amount);
      add({
        id, kind: "start", network: step.network, stepId: step.id, role: "start",
        holder: withdraw && venue
          ? { account: step.account, own: true, label: venue.name }
          : holderLabel(graph, step, step.account, step.network),
        custody: withdraw ? "venue" : "wallet",
        state: "upcoming",
        holdings: [holding(walk, step.network, refOf(input), units, units, started(step) ? "observed" : "quoted", withdraw ? "position" : "spent-next", venue, { legId: step.id, portionBps: 10_000 })],
        ...(before > 0 ? { eta: etaOf(before, quoted) } : {}),
        ...(withdraw && venue ? { venue: { id: venue.id, name: venue.name, protocol: venue.protocol } } : {}),
      });
      walk.inputStop.set(step.id, id);
    }

    // Transit stop (cross-network legs only).
    if (isCross(step)) {
      const input = step.input;
      const deposited = flow ? flow.spends : input ? { expected: BigInt(input.amount), worst: BigInt(input.amount) } : null;
      const certainty: JourneyCertainty = flow ? (parentCredit?.certainty ?? "quoted") : started(step) ? "observed" : "quoted";
      const reference = mainReference(step);
      const link = explorerLink(step.network, reference);
      add({
        id: `transit:${step.id}`, kind: "transit", network: step.network, stepId: step.id, role: "transit",
        holder: { account: null, own: false, label: `${venueName(step)} (in transit)` },
        custody: "provider",
        state: "upcoming",
        holdings: input && deposited ? [holding(walk, step.network, refOf(input), deposited.expected, deposited.worst, certainty, "spent-next", null, { legId: step.id, portionBps: 10_000 })] : [],
        eta: etaOf(before, quoted),
        ...(reference ? { evidence: { reference, ...(link ? { url: link.url } : {}) } } : {}),
      });
    }

    // Output stop.
    const credit = outputCredit(walk, step, flow);
    walk.credits.set(step.id, credit);
    const destination = destinationOf(step);
    const holderAccount = holderOf(graph, step);
    const holderInfo = holderLabel(graph, step, holderAccount, destination);
    const custody: CustodyState = !holderInfo.own ? "third-party" : step.kind === "deposit" ? "venue" : "wallet";
    const reachedAt = step.status === "settled" ? settledAt(step) : undefined;
    const total = cumulative.get(step.id) ?? 0;
    add({
      id: `out:${step.id}`, kind: "end", network: destination, stepId: step.id, role: "out",
      holder: custody === "venue" && venue ? { account: holderAccount, own: true, label: venue.name } : holderInfo,
      custody,
      state: "upcoming",
      holdings: [],
      eta: etaOf(total, quoted),
      ...(reachedAt ? { reachedAt } : {}),
      ...(custody === "venue" && venue ? { venue: { id: venue.id, name: venue.name, protocol: venue.protocol } } : {}),
    });
    if (!walk.inputStop.has(step.id)) walk.inputStop.set(step.id, `out:${step.id}`);
  }

  // Holdings at output stops: the credit, split between the legs that spend it, what stays and gas.
  for (const step of order) {
    const stop = walk.byId.get(`out:${step.id}`);
    const credit = walk.credits.get(step.id) ?? null;
    if (!stop) continue;
    const venue = stepVenue(step);
    const children = walk.children.get(step.id) ?? [];
    if (children.length > 0) stop.kind = "arrival";
    if (credit) {
      if (children.length === 0) {
        const role: HoldingRole = stop.custody === "third-party" ? "paid" : stop.custody === "venue" ? "position" : "kept";
        stop.holdings.push(holding(walk, stop.network, credit.asset, credit.expected, credit.worst, credit.certainty, role, venue));
      } else {
        let spentExpected = 0n;
        let spentWorst = 0n;
        let reserve = 0n;
        for (const child of children) {
          const flow = walk.flows.get(child.id) as FundedFlow;
          spentExpected += flow.spends.expected;
          spentWorst += flow.spends.worst;
          reserve += flow.reserve;
          stop.holdings.push(holding(walk, stop.network, credit.asset, flow.spends.expected, flow.spends.worst, credit.certainty, "spent-next", venue, { legId: child.id, portionBps: portionOf(walk, child) }));
        }
        const keptExpected = nonNegative(credit.expected - spentExpected - reserve);
        const keptWorst = nonNegative(credit.worst - spentWorst - reserve);
        if (keptExpected > 0n || keptWorst > 0n) {
          stop.holdings.push(holding(walk, stop.network, credit.asset, keptExpected, keptWorst, credit.certainty, "kept", venue));
        }
        if (reserve > 0n) {
          const reserveWorst = credit.worst - spentWorst < reserve ? nonNegative(credit.worst - spentWorst) : reserve;
          stop.holdings.push(holding(walk, stop.network, credit.asset, reserve, reserveWorst, credit.certainty, "gas", null));
        }
      }
    }
    if (step.gasTopup && step.status !== "failed" && step.status !== "skipped") {
      const units = BigInt(step.gasTopup.amount);
      stop.holdings.push(holding(walk, stop.network, refOf(step.gasTopup), units, units, "quoted", "gas", null));
    }
  }
  assignStates(walk);
  return walk;
}

function setState(walk: Walk, id: string, state: StopState, custody?: CustodyState): void {
  const stop = walk.byId.get(id);
  if (!stop) return;
  stop.state = state;
  if (custody) stop.custody = custody;
}

/** Stop states and custody from step statuses. */
function assignStates(walk: Walk): void {
  for (const step of walk.order) {
    const start = `start:${step.id}`;
    const transit = `transit:${step.id}`;
    const out = `out:${step.id}`;
    const cross = isCross(step);
    const code = step.failure?.code ?? "";
    switch (step.status) {
      case "pending":
      case "ready":
      case "awaiting_signature":
        setState(walk, start, "current");
        break;
      case "submitted":
      case "confirmed":
      case "settling":
        setState(walk, start, "passed");
        if (cross) setState(walk, transit, "current", "provider");
        break;
      case "settled":
        setState(walk, start, "passed");
        setState(walk, transit, "passed");
        setState(walk, out, "current");
        break;
      case "indeterminate":
        setState(walk, start, "passed");
        if (cross) setState(walk, transit, "current", "unknown");
        else setState(walk, out, "current", "unknown");
        break;
      case "failed":
        if (code === "SETTLEMENT_REFUNDED") {
          setState(walk, start, "passed");
          setState(walk, transit, "current", "refund-due");
          setState(walk, out, "skipped");
        } else if (step.observedCredit) {
          setState(walk, start, "passed");
          setState(walk, transit, "passed");
          setState(walk, out, "current", isOwnRequestAccount(walk.graph, holderOf(walk.graph, step)) ? "wallet" : "third-party");
        } else if (code === "SETTLEMENT_FAILED" && cross) {
          setState(walk, start, "passed");
          setState(walk, transit, "current", "unknown");
          setState(walk, out, "skipped");
        } else {
          // Failed before landing (reverted, references rejected): the money is still at the input stop.
          setState(walk, start, "current");
        }
        break;
      case "skipped":
        setState(walk, start, "skipped");
        setState(walk, transit, "skipped");
        setState(walk, out, "skipped");
        break;
    }
  }
  // A settled stop is passed once a leg spending from it is under way (a failed leg leaves it current).
  for (const step of walk.order) {
    if (step.status !== "settled") continue;
    const children = walk.children.get(step.id) ?? [];
    if (children.some((child) => started(child))) setState(walk, `out:${step.id}`, "passed");
  }
  // Skipped steps whose input waits in a settled parent's stop leave it current (stopped there).
}

export function legsOf(walk: Walk): JourneyLeg[] {
  return walk.order.map((step, index) => {
    const venue = stepVenue(step);
    const refund = refundPath(walk.graph, step);
    const transactions = transactionLinks(step);
    const tracking = transactions[0] ?? null;
    return {
      id: step.id,
      index,
      from: walk.inputStop.get(step.id) ?? `out:${step.id}`,
      ...(isCross(step) ? { via: `transit:${step.id}` } : {}),
      to: `out:${step.id}`,
      kind: step.kind,
      title: legTitle(walk, step),
      network: step.network,
      destinationNetwork: destinationOf(step),
      venue: { protocol: step.protocol, name: venue?.name ?? venueName(step), ...(step.venue ? { venueId: step.venue } : {}) },
      signer: step.mode === "wallet" ? step.account : null,
      signatures: signaturesOf(step, walk.preview),
      seconds: legSeconds(step),
      status: step.status,
      ...(step.failure ? { failure: { code: step.failure.code, message: step.failure.message } } : {}),
      ...(refund ? { refund } : {}),
      ...(step.gasTopup ? { gasTopup: { asset: refOf(step.gasTopup), amount: view(BigInt(step.gasTopup.amount), step.gasTopup.decimals), usd: step.gasTopup.usd ?? null } } : {}),
      ...(tracking ? { tracking } : {}),
      ...(transactions.length > 1 ? { transactions } : {}),
    };
  });
}
