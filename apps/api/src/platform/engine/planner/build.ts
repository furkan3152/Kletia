/**
 * Turns drafts into planned steps (funding, quote evidence) and summarises
 * the plan.
 */
import {
  CHAINS,
  fromBaseUnits,
  getProtocol,
  fundedFlow,
  type AssetAmount,
  type IntentEdge,
  type IntentGraph,
  type IntentRequest,
  type IntentStep,
  type IntentSummary,
  type NetworkKey,
  type StepEvidence,
} from "@kletia/core";
import { sameAddress } from "../accounts.js";
import type { ContractPlannedStep, PlannedStep } from "../adapters/types.js";
import {
  contractDirectory,
  contractsEnabled,
  type ContractPhrase,
} from "../contracts/directory.js";
import { sameAsset } from "../assets.js";
import { describeQuote, exclusionReason } from "../auction.js";
import { decodeStepRef, encodeStepRef } from "../stepRef.js";
import { roundUsd } from "../util.js";
import type { PreviousStep, StepDraft } from "./types.js";

/** Quote evidence for the selected venue, the venues it beat and the ones that could not quote. */
function quoteEvidence(draft: StepDraft, now: string): StepEvidence[] {
  const { planned, action } = draft;
  const competitors = (draft.auction?.losers.length ?? 0) + (draft.auction?.failures.length ?? 0);
  const selected: StepEvidence = {
    kind: "quote",
    network: action.network,
    observedAt: now,
    ...(planned.quoteId ? { reference: planned.quoteId } : {}),
    detail: `Quoted by ${draft.adapter.label}.${competitors > 0 ? ` Selected over ${competitors} other venue(s) by expected value after gas, fees and time.` : ""}`,
  };
  // Provider quote ids of other venues stay out of `reference`: references of quote evidence bind deposits.
  const losers: StepEvidence[] = (draft.auction?.losers ?? []).map((quote) => ({
    kind: "quote",
    network: action.network,
    observedAt: now,
    detail: `Also quoted: ${describeQuote(quote)}; not selected${exclusionReason(quote) ? ` (${exclusionReason(quote)})` : ""}.`.slice(0, 300),
  }));
  const failures: StepEvidence[] = (draft.auction?.failures ?? []).map((failure) => ({
    kind: "quote",
    network: action.network,
    observedAt: now,
    detail: `${getProtocol(failure.protocol)?.name ?? failure.adapter.label} could not quote (${failure.error.code}).`,
  }));
  const resolution: StepEvidence[] = draft.name
    ? [{
        kind: "note",
        network: draft.recipient.chain.key,
        ...(draft.name.reference ? { reference: draft.name.reference.slice(0, 100) } : {}),
        observedAt: now,
        detail: `Resolved ${draft.name.name} to ${draft.recipient.address} via ${getProtocol(draft.name.protocol)?.name ?? draft.name.protocol}: ${draft.name.detail}`.slice(0, 300),
      }]
    : [];
  return [selected, ...losers, ...failures, ...resolution];
}

/** `funding` of a step that spends the previous step's output (share and F6 reserve); none otherwise. */
function stepFunding(draft: StepDraft, previous: PreviousStep | null): Pick<IntentStep, "funding"> {
  if (!draft.funded || !previous) return {};
  return {
    funding: {
      from: previous.step.id,
      portionBps: draft.portionBps ?? 10_000,
      ...(draft.gasReserve ? { gasReserve: draft.gasReserve } : {}),
    },
  };
}

export function buildStep(draft: StepDraft, index: number, previous: PreviousStep | null, now: string): IntentStep {
  const { action } = draft;
  const contract = "kind" in draft.planned && draft.planned.kind === "call";
  // Call steps record a third-party recipient (entries with recipient "any") so prepare rebuilds it.
  const paysRecipient = action.kind === "transfer" || action.kind === "bridge" || (contract && !sameAddress(draft.recipient, draft.account));
  const recipient = paysRecipient ? draft.recipient.id : undefined;
  const warnings = [...new Set([...draft.notes, ...draft.planned.warnings, ...(draft.name?.warnings ?? [])])];
  if (contract) return buildContractStep(draft, draft.planned as ContractPlannedStep, index, previous, now, recipient, warnings);
  const planned = draft.planned as PlannedStep;
  return {
    id: `s${index + 1}`,
    index,
    kind: action.kind,
    title: planned.title,
    network: action.network,
    chain: CHAINS[action.network].id,
    account: draft.account.id,
    protocol: planned.protocol,
    mode: planned.mode,
    input: planned.input,
    expectedOutput: planned.expectedOutput,
    minimumOutput: planned.minimumOutput,
    ...(recipient ? { recipient } : {}),
    ...(recipient && draft.name ? { recipientName: draft.name.name } : {}),
    ...(draft.venue ? { venue: draft.venue.id } : {}),
    dependsOn: previous ? [previous.step.id] : [],
    ...stepFunding(draft, previous),
    ...(draft.gasTopupUsd !== undefined && planned.gasTopup ? { gasTopup: planned.gasTopup } : {}),
    settlement: planned.settlement,
    ...(planned.feesUsd !== undefined ? { feesUsd: roundUsd(planned.feesUsd) } : {}),
    ...(planned.extraCosts && planned.extraCosts.length > 0 ? { extraCosts: planned.extraCosts } : {}),
    estimatedSeconds: planned.estimatedSeconds,
    status: previous ? "pending" : "ready",
    evidence: quoteEvidence(draft, now),
    quoteRef: encodeStepRef({
      v: 1,
      slippageBps: planned.slippageBps,
      ...(planned.quoteId ? { quote: planned.quoteId } : {}),
      ...(draft.portionBps !== undefined ? { portionBps: draft.portionBps } : {}),
      ...((planned.provider ?? action.provider) ? { provider: planned.provider ?? action.provider } : {}),
      // Every prepare is held to this floor (QUOTE_MOVED), not to the previous prepare's.
      plannedInput: planned.input.amount,
      plannedMinimum: planned.minimumOutput.amount,
      ...(action.amount.type === "position" ? { closePosition: true as const } : {}),
      // Prepare asks the same top-up again.
      ...(draft.gasTopupUsd !== undefined && planned.gasTopup ? { gasTopupUsd: draft.gasTopupUsd } : {}),
    }),
    ...(warnings.length > 0 ? { warnings: warnings.slice(0, 12) } : {}),
  };
}

/** IntentStep of a call / action step: input and outputs only when the entry has them; the snapshot in `call`. */
function buildContractStep(
  draft: StepDraft,
  planned: ContractPlannedStep,
  index: number,
  previous: PreviousStep | null,
  now: string,
  recipient: IntentStep["recipient"],
  warnings: readonly string[],
): IntentStep {
  const { action } = draft;
  return {
    id: `s${index + 1}`,
    index,
    kind: action.kind,
    title: planned.title,
    network: action.network,
    chain: CHAINS[action.network].id,
    account: draft.account.id,
    protocol: planned.protocol,
    mode: planned.mode,
    ...(planned.input ? { input: planned.input } : {}),
    ...(planned.expectedOutput ? { expectedOutput: planned.expectedOutput } : {}),
    ...(planned.minimumOutput ? { minimumOutput: planned.minimumOutput } : {}),
    ...(recipient ? { recipient } : {}),
    dependsOn: previous ? [previous.step.id] : [],
    ...stepFunding(draft, previous),
    settlement: planned.settlement,
    ...(planned.feesUsd !== undefined ? { feesUsd: roundUsd(planned.feesUsd) } : {}),
    estimatedSeconds: planned.estimatedSeconds,
    status: previous ? "pending" : "ready",
    evidence: quoteEvidence(draft, now),
    quoteRef: encodeStepRef({
      v: 1,
      slippageBps: planned.slippageBps,
      ...(draft.portionBps !== undefined ? { portionBps: draft.portionBps } : {}),
      ...(planned.input && planned.minimumOutput ? { plannedInput: planned.input.amount, plannedMinimum: planned.minimumOutput.amount } : {}),
    }),
    ...(warnings.length > 0 ? { warnings: warnings.slice(0, 12) } : {}),
    call: planned.call,
  };
}

function scaleUsd(amount: AssetAmount, units: bigint): number | undefined {
  if (amount.usd === undefined || amount.amount === "0") return undefined;
  return Math.round((amount.usd * Number(units)) / Number(amount.amount) * 100) / 100;
}

/**
 * What a funded child takes from its parent's output in the summary: its
 * share of what the parent produces (observed, else expected) minus its gas
 * reserve (which stays with the user), capped for a third-party recipient:
 * the same rule prepare applies (core flow.ts). The planned input (a share
 * of the guaranteed minimum) is not used: it would list the gap between
 * expected and minimum as money "received" at the stop.
 */
function consumedByChild(child: IntentStep, produced: AssetAmount, flowGraph: IntentGraph): bigint {
  const ref = decodeStepRef(child.quoteRef);
  const units = BigInt(produced.amount);
  const flow = fundedFlow(flowGraph, child, { expected: units, worst: units, certainty: "quoted" }, {
    ...(ref?.slippageBps !== undefined ? { slippageBps: ref.slippageBps } : {}),
    ...(ref?.plannedInput !== undefined ? { plannedInput: BigInt(ref.plannedInput) } : {}),
    ...(ref?.portionBps !== undefined ? { portionBps: ref.portionBps } : {}),
  });
  return flow.spends.expected;
}

export function summarize(
  steps: readonly IntentStep[],
  edges: readonly IntentEdge[],
  signatures: number,
  title: string,
  request: Pick<IntentRequest, "accounts" | "constraints">,
): IntentSummary {
  const funded = new Set(edges.filter((edge) => edge.kind === "funds").map((edge) => edge.to));
  // fundedFlow reads only the graph's request (own accounts, slippage); the summary has no full graph yet.
  const flowGraph = { request, steps, edges } as unknown as IntentGraph;
  const networks: NetworkKey[] = [];
  for (const step of steps) {
    for (const network of [step.network, step.settlement?.destinationNetwork]) {
      if (network && !networks.includes(network)) networks.push(network);
    }
  }
  // A withdraw's input comes out of a venue position, not out of the wallet.
  const inputs = steps.filter((step) => !funded.has(step.id) && step.input && step.kind !== "withdraw").map((step) => step.input as AssetAmount);
  const outputs: AssetAmount[] = [];
  for (const step of steps) {
    const produced = step.actualOutput ?? step.expectedOutput;
    if (!produced) continue;
    const consumed = edges
      .filter((edge) => edge.kind === "funds" && edge.from === step.id)
      .map((edge) => steps.find((candidate) => candidate.id === edge.to))
      .filter((child): child is IntentStep => child?.input !== undefined && sameAsset(child.input, produced))
      .reduce((total, child) => total + consumedByChild(child, produced, flowGraph), 0n);
    const remaining = BigInt(produced.amount) - consumed;
    if (remaining <= 0n) continue;
    const usd = scaleUsd(produced, remaining);
    outputs.push({
      ...produced,
      amount: remaining.toString(),
      formatted: fromBaseUnits(remaining, produced.decimals),
      ...(usd !== undefined ? { usd } : {}),
    });
  }
  const fees = steps.map((step) => step.feesUsd).filter((fee): fee is number => fee !== undefined);
  return {
    title,
    networks,
    inputs,
    outputs,
    ...(fees.length > 0 ? { totalFeesUsd: roundUsd(fees.reduce((total, fee) => total + fee, 0)) } : {}),
    estimatedSeconds: steps.reduce((total, step) => total + (step.estimatedSeconds ?? 0), 0),
    signaturesRequired: signatures,
    crossNetwork: steps.some((step) => step.settlement?.kind === "cross-network"),
  };
}

/** Phrases of the registrations the key may use (none without a key, a directory or with the kill switch on). */
export async function contractPhrases(ownerKeyId: string | undefined): Promise<readonly ContractPhrase[]> {
  const directory = contractDirectory();
  if (!ownerKeyId || !directory || !contractsEnabled()) return [];
  return directory.phrases(ownerKeyId);
}
