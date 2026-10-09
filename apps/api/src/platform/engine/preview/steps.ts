/**
 * Step previews (asset-preview design §5.2-5.7): what one step does to the
 * user's accounts, from its simulation (EVM block, Solana transaction) or,
 * when it is not simulated, from its quote.
 *
 * - Deltas: ERC-20 / SPL / native changes of the user (balance reads where
 *   available, else logs), gas and Solana fees included as native debits.
 * - Payments: credits to recipients that are not the user's accounts.
 * - Bridge legs: the destination credit is the venue's committed minimum
 *   (`venue-minimum`), never "simulated" (S3).
 * - Funded steps model execution, not the plan (§5.5): the step spends its
 *   share of the funding step's output, so the transit row nets to zero in
 *   both the expected and the worst view, and the output is scaled
 *   (`estimated`). A funded step paying a third party is capped at its
 *   planned input plus slippage; the rest stays with the user.
 * - Invariants are evaluated on the same data (invariants.ts).
 *
 * Certainty is computed here from how each number was obtained, never chosen
 * by an adapter.
 */
import {
  CHAINS,
  findAssetByAddress,
  formatAssetId,
  formatPreviewAmount,
  getAsset,
  getProtocol,
  nativeAssetId,
  parseAccountId,
  parseAssetId,
  PREVIEW_WARNING_CODES,
  sameAddressAccount,
  WRAPPED_SOL_MINT,
  type AccountId,
  type AssetAmount,
  type AssetDeltaRow,
  type AssetRef,
  type Certainty,
  type ExternalPayment,
  type FeeLine,
  type ApprovalLine,
  type IntentGraph,
  type IntentStep,
  type NetworkKey,
  type PreviewIssue,
  type PreviewNeed,
  type PreviewStage,
  type StepPreview,
} from "@kletia/core";
import { readErc20Metadata, type EvmNetworkKey } from "../chains/evm.js";
import { userFlows, type FlowLog } from "../contracts/assetChanges.js";
import { readUint } from "../contracts/simulateEvm.js";
import { NATIVE_TRANSFER_EMITTER, TRANSFER_TOPIC } from "../contracts/simulationRpc.js";
import { decodeTokenAccount, tokenDeltasOf } from "../contracts/solanaActions.js";
import { lowestPreparedFloor } from "../adapters/verification.js";
import { decodeStepRef } from "../stepRef.js";
import { parseAccounts, ownAccountOn } from "../accounts.js";
import {
  evmViolations,
  isContractStep,
  solanaViolations,
  spenderLabel,
  tokenOf,
  violationCode,
  type InvariantViolation,
} from "./invariants.js";
import type { StepTransactions } from "./jobs.js";
import { blockGasUsed, blockOpStackL1Fee, type SimulatedBlock, type SimulatedJob, type SimulatedSolanaStep } from "./simulate.js";

export interface StepBuildContext {
  readonly graph: IntentGraph;
  readonly step: IntentStep;
  readonly stage: PreviewStage;
  readonly now: number;
  readonly source: StepTransactions | null;
  /** Previews built for earlier steps (funding parents). */
  readonly built: ReadonlyMap<string, StepPreview>;
  /** Native balances read for input and gas checks, by `${network}:${address}` (EVM lower-case). */
  readonly nativeBalances: ReadonlyMap<string, bigint>;
}

export interface BuiltStep {
  readonly preview: StepPreview;
  readonly violations: readonly InvariantViolation[];
  readonly needs: readonly PreviewNeed[];
  /** Intent-level notes (e.g. funds assumed in simulation). */
  readonly notes: readonly string[];
}

/* ------------------------------------------------------------------ helpers */

function ref(amount: Pick<AssetAmount, "asset" | "symbol" | "decimals">): AssetRef {
  return { asset: amount.asset, symbol: amount.symbol, decimals: amount.decimals };
}

function nativeRef(network: NetworkKey): AssetRef {
  const chain = CHAINS[network];
  return { asset: nativeAssetId(network), symbol: chain.nativeAsset.symbol, decimals: chain.nativeAsset.decimals };
}

function amountOf(units: bigint, decimals: number) {
  return { amount: units.toString(), formatted: formatPreviewAmount(units, decimals) };
}

function positive(units: bigint, decimals: number): string {
  return formatPreviewAmount(units < 0n ? -units : units, decimals).replace(/^[+-]/u, "");
}

function isOwn(graph: IntentGraph, account: string): boolean {
  return graph.request.accounts.some((own) => sameAddressAccount(own, account));
}

function stepNumber(graph: IntentGraph, step: IntentStep): number {
  return graph.steps.findIndex((candidate) => candidate.id === step.id) + 1;
}

function sameAssetId(a: string, b: string): boolean {
  return a.startsWith("eip155:") && b.startsWith("eip155:") ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function deltaRow(
  network: NetworkKey,
  account: string,
  asset: AssetRef,
  expected: bigint,
  worst: bigint,
  certainty: Certainty,
  stepId: string,
): AssetDeltaRow {
  return {
    network,
    account: account as AccountId,
    asset: asset.asset,
    symbol: asset.symbol,
    decimals: asset.decimals,
    listed: getAsset(asset.asset) !== null,
    expected: amountOf(expected, asset.decimals),
    worst: amountOf(worst, asset.decimals),
    certainty,
    steps: [stepId],
    role: "you",
  };
}

function payment(
  step: IntentStep,
  network: NetworkKey,
  recipient: string,
  asset: AssetRef,
  expected: bigint,
  worst: bigint,
  certainty: Certainty,
): ExternalPayment {
  return {
    stepId: step.id,
    network,
    recipient: recipient as AccountId,
    ...(step.recipientName ? { recipientName: step.recipientName } : {}),
    asset: asset.asset,
    symbol: asset.symbol,
    decimals: asset.decimals,
    expected: amountOf(expected, asset.decimals),
    worst: amountOf(worst, asset.decimals),
    certainty,
  };
}

function issue(code: string, severity: PreviewIssue["severity"], message: string): PreviewIssue {
  return { code, severity, message };
}

function weakest(a: Certainty, b: Certainty): Certainty {
  const order: readonly Certainty[] = ["simulated", "simulated-assumed-funds", "venue-minimum", "quoted", "estimated"];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

/** CAIP-10 of the step's account re-homed on `network` (same address). */
function accountOn(account: string, network: NetworkKey): string {
  const parsed = parseAccountId(account);
  return parsed ? `${CHAINS[network].id}:${parsed.address}` : account;
}

/** Fee line with an amount in an asset (priced by aggregatePreview). */
function feeLine(
  step: IntentStep,
  network: NetworkKey,
  kind: FeeLine["kind"],
  label: string,
  asset: AssetRef,
  units: bigint,
  paid: FeeLine["paid"],
  certainty: Certainty,
): FeeLine {
  return { stepId: step.id, network, kind, label, asset, amount: units.toString(), formatted: positive(units, asset.decimals), paid, certainty };
}

function venueFeeLines(context: StepBuildContext): FeeLine[] {
  return (context.source?.venueFees ?? []).map((fee) => ({ ...fee, stepId: context.step.id, network: context.step.network }));
}

/** Extra costs paid on top of the input (deBridge's fixed fee): fee lines; the native debit is a row elsewhere. */
function extraCostLines(context: StepBuildContext, certainty: Certainty): FeeLine[] {
  const name = getProtocol(context.step.protocol)?.name ?? context.step.protocol;
  return (context.step.extraCosts ?? []).map((cost) =>
    feeLine(context.step, context.step.network, "extra", `${name} fixed fee`, ref(cost), BigInt(cost.amount), "on-top", certainty));
}

/* ------------------------------------------------------- funded modelling */

interface FundedModel {
  /** What the step spends at execution (positive), expected and worst. */
  readonly expected: bigint;
  readonly worst: bigint;
  /** The amount the transactions encode (what the simulation spent). */
  readonly encoded: bigint;
}

/**
 * The funding parent's credit to this step's account in the step's input
 * asset (the parent's step preview row, else the parent's amounts), and the
 * step's share of it (design §5.5).
 */
export function fundedModel(context: StepBuildContext): FundedModel | null {
  const { graph, step } = context;
  if (!step.input) return null;
  const edge = graph.edges.find((candidate) => candidate.to === step.id && candidate.kind === "funds");
  if (!edge) return null;
  const parent = graph.steps.find((candidate) => candidate.id === edge.from);
  if (!parent) return null;
  const portion = BigInt(decodeStepRef(step.quoteRef)?.portionBps ?? 10_000);
  const parentPreview = context.built.get(parent.id);
  const row = parentPreview?.deltas.find((delta) =>
    delta.network === step.network && sameAddressAccount(delta.account, step.account) && sameAssetId(delta.asset, step.input?.asset ?? "") && BigInt(delta.worst.amount) > 0n);
  let credit: { expected: bigint; worst: bigint } | null = row ? { expected: BigInt(row.expected.amount), worst: BigInt(row.worst.amount) } : null;
  if (!credit) {
    const actual = parent.actualOutput && sameAssetId(parent.actualOutput.asset, step.input.asset) ? BigInt(parent.actualOutput.amount) : null;
    const expected = parent.expectedOutput && sameAssetId(parent.expectedOutput.asset, step.input.asset) ? BigInt(parent.expectedOutput.amount) : null;
    const minimum = parent.minimumOutput && sameAssetId(parent.minimumOutput.asset, step.input.asset) ? BigInt(parent.minimumOutput.amount) : null;
    if (actual !== null) credit = { expected: actual, worst: actual };
    else if (expected !== null && minimum !== null) credit = { expected, worst: minimum };
  }
  if (!credit) return null;
  let expected = (credit.expected * portion) / 10_000n;
  let worst = (credit.worst * portion) / 10_000n;
  const recipient = step.recipient ?? step.account;
  if (!isOwn(graph, recipient)) {
    const ref = decodeStepRef(step.quoteRef);
    const slippage = BigInt(ref?.slippageBps ?? graph.request.constraints?.maxSlippageBps ?? 50);
    const cap = (BigInt(ref?.plannedInput ?? step.input.amount) * (10_000n + slippage)) / 10_000n;
    if (expected > cap) expected = cap;
    if (worst > cap) worst = cap;
  }
  return { expected, worst, encoded: BigInt(step.input.amount) };
}

/** Scales an output by the expected funded input over the encoded input (linear, `estimated`). */
function scaled(output: bigint, model: FundedModel | null): { value: bigint; estimated: boolean } {
  if (!model || model.encoded === 0n || model.expected === model.encoded) return { value: output, estimated: false };
  return { value: (output * model.expected) / model.encoded, estimated: true };
}

/**
 * The guaranteed output when the funding guarantee fell below what the
 * transactions encode (a fresher, lower bridge floor): scaled down, never up.
 */
function scaledWorst(minimum: bigint, model: FundedModel | null): bigint {
  if (!model || model.encoded === 0n || model.worst >= model.encoded) return minimum;
  return (minimum * model.worst) / model.encoded;
}

/* -------------------------------------------------------- destination leg */

/** The bridge's destination credit (venue minimum) as a row or a payment (design §5.5). */
function destinationLeg(context: StepBuildContext, model: FundedModel | null): { rows: AssetDeltaRow[]; payments: ExternalPayment[] } {
  const { graph, step } = context;
  const destination = step.settlement?.kind === "cross-network" ? step.settlement.destinationNetwork : undefined;
  const output = step.actualOutput ?? step.expectedOutput;
  if (!destination || !output) return { rows: [], payments: [] };
  const recipient = step.recipient ?? ownAccountOn(parseAccounts(graph.request.accounts), destination)?.id ?? accountOn(step.account, destination);
  let expected: bigint;
  let worst: bigint;
  let certainty: Certainty = "venue-minimum";
  if (step.actualOutput) {
    expected = BigInt(step.actualOutput.amount);
    worst = expected;
  } else {
    const floor = scaledWorst(lowestPreparedFloor(step) ?? BigInt(step.minimumOutput?.amount ?? "0"), model);
    const scaledExpected = scaled(BigInt(output.amount), model);
    expected = scaledExpected.value;
    worst = floor;
    if (scaledExpected.estimated) certainty = "estimated";
    if (expected < worst) expected = worst;
  }
  if (isOwn(graph, recipient)) return { rows: [deltaRow(destination, recipient, ref(output), expected, worst, certainty, step.id)], payments: [] };
  return { rows: [], payments: [payment(step, destination, recipient, ref(output), expected, worst, certainty)] };
}

/* ---------------------------------------------------------- quoted steps */

/**
 * A step that is not simulated: its numbers come from the quote (or, once
 * done, from what was observed). Labelled `quoted`; destination credits stay
 * `venue-minimum`.
 */
export function quotedStepPreview(
  context: StepBuildContext,
  status: StepPreview["status"],
  issues: readonly PreviewIssue[],
): BuiltStep {
  const { graph, step } = context;
  const certainty: Certainty = "quoted";
  const rows: AssetDeltaRow[] = [];
  const payments: ExternalPayment[] = [];
  const model = fundedModel(context);
  const own = step.recipient ?? step.account;
  if (step.input && step.kind !== "withdraw" && step.mode === "wallet") {
    const expected = model ? model.expected : BigInt(step.input.amount);
    const worst = model ? model.worst : BigInt(step.input.amount);
    rows.push(deltaRow(step.network, step.account, ref(step.input), -expected, -worst, certainty, step.id));
  }
  const cross = step.settlement?.kind === "cross-network";
  if (cross) {
    const leg = destinationLeg(context, model);
    rows.push(...leg.rows);
    payments.push(...leg.payments);
  } else {
    const output = step.actualOutput ?? step.expectedOutput;
    const minimum = step.actualOutput ?? step.minimumOutput;
    if (output && minimum && !(step.kind === "transfer" && isOwn(graph, own) && sameAddressAccount(own, step.account))) {
      const { value, estimated } = scaled(BigInt(output.amount), step.actualOutput ? null : model);
      const worst = step.actualOutput ? BigInt(step.actualOutput.amount) : scaledWorst(BigInt(minimum.amount), model);
      const expected = value < worst ? worst : value;
      const rowCertainty = estimated ? "estimated" : certainty;
      const transfer = step.kind === "transfer" && !step.actualOutput ? model : null;
      if (isOwn(graph, own)) rows.push(deltaRow(step.network, accountOn(own, step.network), ref(output), expected, worst, rowCertainty, step.id));
      else payments.push(payment(step, step.network, own, ref(output), transfer ? transfer.expected : expected, transfer ? transfer.worst : worst, rowCertainty));
    }
  }
  for (const cost of step.extraCosts ?? []) {
    rows.push(deltaRow(step.network, step.account, ref(cost), -BigInt(cost.amount), -BigInt(cost.amount), certainty, step.id));
  }
  const quotedIssues = [...issues];
  if (status === "quoted" && !step.actualOutput && !quotedIssues.some((entry) => entry.code === PREVIEW_WARNING_CODES.stepQuoted)) {
    quotedIssues.push(issue(PREVIEW_WARNING_CODES.stepQuoted, "warn", `Step ${stepNumber(graph, step)} is shown as quoted (not simulated); its network fee is not included.`));
  }
  return {
    preview: {
      stepId: step.id,
      network: step.network,
      kind: step.kind,
      status,
      at: new Date(context.now).toISOString(),
      ...(context.source?.quoteBinding ? { quoteBinding: context.source.quoteBinding } : {}),
      deltas: rows,
      payments,
      fees: [...venueFeeLines(context), ...extraCostLines(context, certainty)],
      approvals: [],
      issues: quotedIssues,
    },
    violations: [],
    needs: [],
    notes: [],
  };
}

/* ---------------------------------------------------------------- EVM steps */

const metaCache = new Map<string, AssetRef>();

/** Symbol and decimals of an ERC-20 the step touches (registry, step amounts, then the token itself). */
async function erc20Ref(network: EvmNetworkKey, token: string, known: readonly AssetRef[]): Promise<AssetRef> {
  const asset = formatAssetId(network, "erc20", token);
  const listed = findAssetByAddress(network, token);
  if (listed) return { asset: listed.id, symbol: listed.symbol, decimals: listed.decimals };
  const match = known.find((entry) => sameAssetId(entry.asset, asset));
  if (match) return match;
  const cached = metaCache.get(asset.toLowerCase());
  if (cached) return cached;
  try {
    const meta = await Promise.race([
      readErc20Metadata(network, token),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 2_000).unref?.()),
    ]);
    const out = { asset, symbol: meta.symbol, decimals: meta.decimals };
    metaCache.set(asset.toLowerCase(), out);
    return out;
  } catch {
    return { asset, symbol: `${token.slice(0, 6)}…${token.slice(-4)}`, decimals: 0 };
  }
}

function knownRefs(step: IntentStep): AssetRef[] {
  return [step.input, step.expectedOutput, step.minimumOutput, step.actualOutput, ...(step.extraCosts ?? [])]
    .filter((entry): entry is AssetAmount => entry !== undefined)
    .map(ref);
}

/** Wei credited to `recipient` by traced native transfers. */
function nativeCredit(logs: readonly FlowLog[], recipient: string): bigint {
  const to = `0x${recipient.toLowerCase().replace(/^0x/u, "").padStart(64, "0")}`;
  let total = 0n;
  for (const log of logs) {
    if (log.address.toLowerCase() !== NATIVE_TRANSFER_EMITTER || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC || log.topics[2]?.toLowerCase() !== to) continue;
    total += /^0x[0-9a-fA-F]{1,64}$/u.test(log.data) ? BigInt(log.data) : 0n;
  }
  return total;
}

function erc20Credit(logs: readonly FlowLog[], token: string, recipient: string): bigint {
  const to = `0x${recipient.toLowerCase().replace(/^0x/u, "").padStart(64, "0")}`;
  let total = 0n;
  for (const log of logs) {
    if (log.address.toLowerCase() !== token || log.topics.length !== 3 || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC || log.topics[2]?.toLowerCase() !== to) continue;
    total += /^0x[0-9a-fA-F]{1,64}$/u.test(log.data) ? BigInt(log.data) : 0n;
  }
  return total;
}

/** Builds the step preview of one simulated EVM block. */
export async function evmStepPreview(context: StepBuildContext, job: Extract<SimulatedJob, { status: "ok" }>, block: SimulatedBlock): Promise<BuiltStep> {
  const { graph, step, stage } = context;
  const network = job.job.network;
  const chain = CHAINS[network];
  const owner = block.plan.owner;
  const prepare = stage === "prepare";
  if (block.overrideMissing) {
    return quotedStepPreview(context, "quoted", [
      issue(PREVIEW_WARNING_CODES.overrideUnavailable, "warn", `Step ${stepNumber(graph, step)} spends funds that arrive later, and no balance override is known for ${step.input?.symbol ?? "its input"} on ${chain.name}; it is shown as quoted.`),
    ]);
  }
  const txCalls = block.plan.index.transactions.map((at) => block.calls[at]);
  const reverted = txCalls.find((call) => call?.status !== "success");
  const logs: FlowLog[] = txCalls.flatMap((call) => call?.logs ?? []);
  const flows = userFlows(logs, owner);
  const reads = new Map<string, { before: bigint | null; after: bigint | null }>();
  for (const entry of block.plan.index.before) reads.set(entry.token, { before: readUint(block.calls[entry.at]), after: null });
  for (const entry of block.plan.index.after) {
    const current = reads.get(entry.token) ?? { before: null, after: null };
    reads.set(entry.token, { ...current, after: readUint(block.calls[entry.at]) });
  }
  const net = new Map<string, bigint>();
  for (const token of new Set([...flows.debits.keys(), ...flows.credits.keys(), ...reads.keys()])) {
    const read = reads.get(token);
    const delta = read && read.before !== null && read.after !== null
      ? read.after - read.before
      : (flows.credits.get(token) ?? 0n) - (flows.debits.get(token) ?? 0n);
    if (delta !== 0n) net.set(token, delta);
  }
  const evmTransactions = context.source?.transactions.filter((transaction) => transaction.vm === "evm") ?? [];
  const valueTotal = evmTransactions.reduce((total, transaction) => total + (transaction.vm === "evm" ? BigInt(transaction.value) : 0n), 0n);
  const inputToken = tokenOf(step.input?.asset, step.network);
  const inputNative = step.input !== undefined && inputToken === null && parseAssetId(step.input.asset)?.isNative === true;
  const assumed = block.overridden !== null;
  const balanceBefore = inputToken
    ? reads.get(inputToken)?.before ?? null
    : inputNative
      ? context.nativeBalances.get(`${network}:${owner}`) ?? null
      : null;
  const ready = !assumed && block.plan.assumeFunds === null;
  const recipient = step.recipient ?? step.account;
  const cross = step.settlement?.kind === "cross-network";
  const ownRecipient = isOwn(graph, recipient);
  const outputAmount = step.minimumOutput ?? step.expectedOutput;
  const outputToken = !cross && outputAmount ? tokenOf(outputAmount.asset, step.network) : null;
  const outputNative = !cross && outputAmount !== undefined && parseAssetId(outputAmount.asset)?.isNative === true && parseAssetId(outputAmount.asset)?.chain.key === step.network;
  const sameAsInput = outputAmount !== undefined && step.input !== undefined && sameAssetId(outputAmount.asset, step.input.asset);
  const checkOutput = !cross && ownRecipient && !sameAsInput && step.minimumOutput !== undefined && ["swap", "stake", "deposit", "withdraw", "bridge"].includes(step.kind);
  const violations = evmViolations(
    {
      reverted: reverted ? reverted.error ?? "execution reverted" : null,
      debits: flows.debits,
      credits: flows.credits,
      net,
      nativeOut: flows.nativeOut,
      nativeIn: flows.nativeIn,
      nftOut: flows.nftOut,
      approvals: flows.approvals,
      approvalsForAll: flows.approvalsForAll,
      valueTotal,
      balanceBefore,
    },
    {
      step,
      input: step.input ? { token: inputToken, amount: BigInt(step.input.amount) } : null,
      extraNative: (step.extraCosts ?? []).filter((cost) => parseAssetId(cost.asset)?.isNative).reduce((total, cost) => total + BigInt(cost.amount), 0n),
      minimumOutput: checkOutput && step.minimumOutput ? { token: outputNative ? null : outputToken, amount: BigInt(step.minimumOutput.amount) } : null,
      ...(context.source?.approvalSpender ? { adapterSpender: context.source.approvalSpender } : {}),
      ready,
    },
  );
  const severity: PreviewIssue["severity"] = prepare ? "block" : "warn";
  const issues: PreviewIssue[] = violations.map((violation) => issue(violationCode(violation.rule), severity, `Step ${stepNumber(graph, step)}: ${violation.message}`));
  const needs: PreviewNeed[] = [];
  if (ready && step.input && balanceBefore !== null && balanceBefore < BigInt(step.input.amount) && step.kind !== "withdraw") {
    needs.push({
      network: step.network,
      account: step.account as AccountId,
      asset: ref(step.input),
      amount: step.input.amount,
      formatted: positive(BigInt(step.input.amount), step.input.decimals),
      reason: "input-balance",
      have: balanceBefore.toString(),
    });
  }
  if (reverted) {
    const fallback = quotedStepPreview(context, "failed", issues);
    return { ...fallback, violations, needs };
  }

  const status: StepPreview["status"] = assumed ? "simulated-assumed-funds" : "simulated";
  const certainty: Certainty = status;
  const model = fundedModel(context);
  const known = knownRefs(step);
  const rows: AssetDeltaRow[] = [];
  const payments: ExternalPayment[] = [];
  const fees: FeeLine[] = [];
  const nativeAsset = nativeRef(network);

  // Gas: Σ gasUsed of the step's own transactions × eth_gasPrice, plus the L1 data fee.
  const gasUsed = blockGasUsed(block);
  const l1Fee = (block.plan.index.l1Fees.length > 0 ? blockOpStackL1Fee(block) : null) ??
    (job.arbitrumL1.size > 0
      ? evmTransactions.reduce((total, _transaction, position) => total + (job.arbitrumL1.get(`${step.id}:${position}`) ?? 0n), 0n)
      : null);
  const gasWei = job.gasPrice !== null ? gasUsed * job.gasPrice : null;
  if (gasWei !== null) fees.push(feeLine(step, network, "network", `${chain.name} network fee`, nativeAsset, gasWei, "on-top", certainty));
  if (l1Fee !== null && l1Fee > 0n) fees.push(feeLine(step, network, "l1-data", `${chain.name} L1 data fee`, nativeAsset, l1Fee, "on-top", certainty));

  // Native: traced value in − out, minus gas (validation:false charges none).
  let nativeExpected = flows.nativeIn - flows.nativeOut - (gasWei ?? 0n) - (l1Fee ?? 0n);
  let nativeWorst = nativeExpected;
  if (inputNative && model && step.kind !== "withdraw") {
    nativeExpected += model.encoded - model.expected;
    nativeWorst += model.encoded - model.worst;
  }
  if (checkOutput && outputNative && step.minimumOutput && flows.nativeIn > 0n) {
    // A native output (e.g. a withdraw paid out in ETH): the worst case is the guaranteed minimum, not the simulated credit.
    const minimum = scaledWorst(BigInt(step.minimumOutput.amount), model);
    if (flows.nativeIn > minimum) nativeWorst -= flows.nativeIn - minimum;
  }
  if (nativeExpected !== 0n || nativeWorst !== 0n) rows.push(deltaRow(network, step.account, nativeAsset, nativeExpected, nativeWorst, certainty, step.id));
  for (const [token, delta] of net) {
    const asset = await erc20Ref(network, token, known);
    let expected = delta;
    let worst = delta;
    let rowCertainty: Certainty = certainty;
    if (token === inputToken && model && step.kind !== "withdraw") {
      expected = delta + model.encoded - model.expected;
      worst = delta + model.encoded - model.worst;
      rowCertainty = weakest(certainty, "simulated-assumed-funds");
    } else if (token === outputToken && delta > 0n && step.minimumOutput && !sameAsInput) {
      const minimum = scaledWorst(BigInt(step.minimumOutput.amount), model);
      const { value, estimated } = scaled(delta, model);
      expected = value;
      worst = delta < minimum ? delta : minimum;
      if (estimated) rowCertainty = "estimated";
    }
    if (expected === 0n && worst === 0n) continue;
    rows.push(deltaRow(network, step.account, asset, expected, worst, rowCertainty, step.id));
  }

  // Same-network payments to third parties.
  if (!cross && !ownRecipient) {
    const parsed = parseAccountId(recipient);
    const output = step.expectedOutput ?? step.minimumOutput;
    if (parsed && output) {
      const token = tokenOf(output.asset, step.network);
      const credited = token ? erc20Credit(logs, token, parsed.address) : nativeCredit(logs, parsed.address);
      if (credited > 0n) {
        const minimum = scaledWorst(BigInt((step.minimumOutput ?? output).amount), model);
        const transfer = step.kind === "transfer" ? model : null;
        payments.push(payment(
          step,
          step.network,
          recipient,
          ref(output),
          transfer ? transfer.expected : credited,
          transfer ? transfer.worst : credited < minimum ? credited : minimum,
          transfer ? weakest(certainty, "simulated-assumed-funds") : certainty,
        ));
      }
    }
  }
  if (cross) {
    const leg = destinationLeg(context, model);
    rows.push(...leg.rows);
    payments.push(...leg.payments);
  }
  fees.push(...venueFeeLines(context), ...extraCostLines(context, certainty));

  // Approvals granted by the transactions, with what is left after the block.
  const approvals: ApprovalLine[] = [];
  for (const approval of block.plan.approvals) {
    const read = block.plan.index.allowances.find((entry) => entry.token === approval.token && entry.spender === approval.spender);
    const left = read ? readUint(block.calls[read.at]) : null;
    const token = await erc20Ref(network, approval.token, known);
    approvals.push({
      stepId: step.id,
      network,
      token,
      spender: approval.spender,
      spenderLabel: spenderLabel(step, approval.spender, context.source?.approvalSpender),
      amount: approval.amount.toString(),
      formatted: positive(approval.amount, token.decimals),
      leftAfter: left === null ? null : left.toString(),
    });
    if (left !== null && left > 0n) {
      issues.push(issue(PREVIEW_WARNING_CODES.allowanceLeft, "warn", `${positive(left, token.decimals)} ${token.symbol} of the approval to ${spenderLabel(step, approval.spender, context.source?.approvalSpender)} stays approved after step ${stepNumber(graph, step)}.`));
    }
  }
  const notes = assumed && step.input
    ? [`Step ${stepNumber(graph, step)} was simulated with ${positive(BigInt(step.input.amount), step.input.decimals)} ${step.input.symbol} that ${parentLabel(graph, step)} delivers to you on ${chain.name}; it will be simulated again before you sign it.`]
    : [];
  return {
    preview: {
      stepId: step.id,
      network,
      kind: step.kind,
      status,
      at: new Date(job.at).toISOString(),
      block: job.block.toString(),
      endpoint: job.endpoint,
      ...(block.overridden ? { overrides: [{ asset: block.overridden.asset as AssetRef["asset"], amount: block.overridden.amount }] } : {}),
      ...(context.source?.quoteBinding ? { quoteBinding: context.source.quoteBinding } : {}),
      deltas: rows,
      payments,
      fees,
      approvals,
      gas: { used: gasUsed.toString(), price: (job.gasPrice ?? 0n).toString(), ...(l1Fee !== null ? { l1Fee: l1Fee.toString() } : {}) },
      issues,
    },
    violations,
    needs,
    notes,
  };
}

function parentLabel(graph: IntentGraph, step: IntentStep): string {
  const edge = graph.edges.find((candidate) => candidate.to === step.id && candidate.kind === "funds");
  const parent = edge ? graph.steps.find((candidate) => candidate.id === edge.from) : undefined;
  return parent ? getProtocol(parent.protocol)?.name ?? `step ${stepNumber(graph, parent)}` : "the previous step";
}

/* ------------------------------------------------------------- Solana steps */

/** Builds the step preview of a simulated Solana step (one simulation per transaction). */
export function solanaStepPreview(context: StepBuildContext, simulations: readonly SimulatedSolanaStep[]): BuiltStep {
  const { graph, step, stage } = context;
  const network = step.network;
  const user = parseAccountId(step.account)?.address ?? "";
  const prepare = stage === "prepare";
  const error = simulations.find((entry) => entry.simulation.error !== null)?.simulation.error ?? null;
  let lamports = 0n;
  let fee = 0n;
  let rent = 0n;
  const tokenDeltas = new Map<string, bigint>();
  const decimals = new Map<string, number>();
  const tokenAccounts: { account: string; owner: string; delegate: string | null }[] = [];
  let inputBefore: bigint | null = null;
  const inputMint = tokenOf(step.input?.asset, network);
  const inputNative = step.input !== undefined && parseAssetId(step.input.asset)?.isNative === true;
  for (const [position, entry] of simulations.entries()) {
    const simulation = entry.simulation;
    const keys = simulation.accountKeys;
    const index = keys.indexOf(user);
    if (index >= 0 && simulation.preBalances && simulation.postBalances) {
      const pre = simulation.preBalances[index] ?? 0n;
      lamports += (simulation.postBalances[index] ?? 0n) - pre;
      if (position === 0 && inputNative) inputBefore = pre;
    }
    fee += simulation.fee ?? 0n;
    const owned = new Set(
      [...simulation.preTokenBalances, ...simulation.postTokenBalances].filter((balance) => balance.owner === user).map((balance) => balance.account),
    );
    if (simulation.preBalances && simulation.postBalances) {
      for (const [keyIndex, key] of keys.entries()) {
        if (key === user || !owned.has(key)) continue;
        const pre = simulation.preBalances[keyIndex] ?? 0n;
        const post = simulation.postBalances[keyIndex] ?? 0n;
        if (pre === 0n && post > 0n) rent += post;
      }
    }
    const { deltas, decimals: seen } = tokenDeltasOf(simulation.preTokenBalances, simulation.postTokenBalances, user);
    for (const [mint, delta] of deltas) tokenDeltas.set(mint, (tokenDeltas.get(mint) ?? 0n) + delta);
    for (const [mint, value] of seen) decimals.set(mint, value);
    if (position === 0 && inputMint) {
      inputBefore = simulation.preTokenBalances.filter((balance) => balance.owner === user && balance.mint === inputMint).reduce((total, balance) => total + balance.amount, 0n);
    }
    for (const [requestedIndex, account] of entry.requested.entries()) {
      if (!owned.has(account)) continue;
      const state = decodeTokenAccount(simulation.accounts[requestedIndex] ?? null);
      if (state) tokenAccounts.push({ account, owner: state.owner, delegate: state.delegate });
    }
  }
  const wsol = tokenDeltas.get(WRAPPED_SOL_MINT) ?? 0n;
  tokenDeltas.delete(WRAPPED_SOL_MINT);
  const solDelta = lamports + wsol;
  const solSpent = -solDelta - fee - rent;
  const recipient = step.recipient ?? step.account;
  const cross = step.settlement?.kind === "cross-network";
  const ownRecipient = isOwn(graph, recipient);
  const outputMint = !cross && step.minimumOutput ? tokenOf(step.minimumOutput.asset, network) : null;
  const sameAsInput = step.minimumOutput !== undefined && step.input !== undefined && sameAssetId(step.minimumOutput.asset, step.input.asset);
  const checkOutput = !cross && ownRecipient && !sameAsInput && step.minimumOutput !== undefined && ["swap", "stake", "deposit", "withdraw"].includes(step.kind);
  const ready = true;
  const violations = solanaViolations(
    { error, tokenDeltas, solSpent, balanceBefore: inputBefore, tokenAccounts, user },
    {
      step,
      input: step.input ? { mint: inputNative ? null : inputMint, amount: BigInt(step.input.amount) } : null,
      extraLamports: (step.extraCosts ?? []).filter((cost) => parseAssetId(cost.asset)?.isNative).reduce((total, cost) => total + BigInt(cost.amount), 0n),
      minimumOutput: checkOutput && step.minimumOutput && outputMint ? { mint: outputMint, amount: BigInt(step.minimumOutput.amount) } : null,
      ready,
    },
  );
  const severity: PreviewIssue["severity"] = prepare ? "block" : "warn";
  const issues: PreviewIssue[] = violations.map((violation) => issue(violationCode(violation.rule), severity, `Step ${stepNumber(graph, step)}: ${violation.message}`));
  const needs: PreviewNeed[] = [];
  if (step.input && inputBefore !== null && inputBefore < BigInt(step.input.amount) && step.kind !== "withdraw") {
    needs.push({
      network,
      account: step.account as AccountId,
      asset: ref(step.input),
      amount: step.input.amount,
      formatted: positive(BigInt(step.input.amount), step.input.decimals),
      reason: "input-balance",
      have: inputBefore.toString(),
    });
  }
  if (error !== null) {
    const fallback = quotedStepPreview(context, "failed", issues);
    return { ...fallback, violations, needs };
  }
  const certainty: Certainty = "simulated";
  const model = fundedModel(context);
  const rows: AssetDeltaRow[] = [];
  const payments: ExternalPayment[] = [];
  const nativeAsset = nativeRef(network);
  const fees: FeeLine[] = [feeLine(step, network, "network", `${CHAINS[network].name} network fee`, nativeAsset, fee, "on-top", certainty)];
  if (rent > 0n) {
    fees.push(feeLine(step, network, "rent", "Token account rent (refundable)", nativeAsset, rent, "refundable", certainty));
    needs.push({ network, account: step.account as AccountId, asset: nativeAsset, amount: rent.toString(), formatted: positive(rent, nativeAsset.decimals), reason: "rent" });
  }
  let solExpected = solDelta;
  let solWorst = solDelta;
  if (inputNative && model && step.kind !== "withdraw") {
    solExpected += model.encoded - model.expected;
    solWorst += model.encoded - model.worst;
  }
  if (solExpected !== 0n || solWorst !== 0n) rows.push(deltaRow(network, step.account, nativeAsset, solExpected, solWorst, certainty, step.id));
  const known = knownRefs(step);
  for (const [mint, delta] of tokenDeltas) {
    if (delta === 0n) continue;
    const asset = formatAssetId(network, "token", mint);
    const listed = getAsset(asset);
    const match = known.find((entry) => entry.asset === asset);
    const assetRef: AssetRef = listed
      ? { asset: listed.id, symbol: listed.symbol, decimals: listed.decimals }
      : match ?? { asset, symbol: `${mint.slice(0, 4)}…${mint.slice(-4)}`, decimals: decimals.get(mint) ?? 0 };
    let expected = delta;
    let worst = delta;
    let rowCertainty: Certainty = certainty;
    if (mint === inputMint && model && step.kind !== "withdraw") {
      expected = delta + model.encoded - model.expected;
      worst = delta + model.encoded - model.worst;
    } else if (mint === outputMint && delta > 0n && step.minimumOutput && !sameAsInput) {
      const minimum = scaledWorst(BigInt(step.minimumOutput.amount), model);
      const { value, estimated } = scaled(delta, model);
      expected = value;
      worst = delta < minimum ? delta : minimum;
      if (estimated) rowCertainty = "estimated";
    }
    rows.push(deltaRow(network, step.account, assetRef, expected, worst, rowCertainty, step.id));
  }
  if (!cross && !ownRecipient && step.expectedOutput) {
    // Third-party payee: the quoted amount (Solana balances are per token account, not per payee here).
    const minimum = BigInt((step.minimumOutput ?? step.expectedOutput).amount);
    payments.push(payment(step, network, recipient, ref(step.expectedOutput), BigInt(step.expectedOutput.amount), minimum, "quoted"));
  }
  if (cross) {
    const leg = destinationLeg(context, model);
    rows.push(...leg.rows);
    payments.push(...leg.payments);
  }
  fees.push(...venueFeeLines(context), ...extraCostLines(context, certainty));
  const first = simulations[0];
  return {
    preview: {
      stepId: step.id,
      network,
      kind: step.kind,
      status: "simulated",
      at: new Date(first?.at ?? context.now).toISOString(),
      ...(first?.simulation.slot !== null && first?.simulation.slot !== undefined ? { slot: first.simulation.slot.toString() } : {}),
      ...(first ? { endpoint: first.endpoint } : {}),
      ...(context.source?.quoteBinding ? { quoteBinding: context.source.quoteBinding } : {}),
      deltas: rows,
      payments,
      fees,
      approvals: [],
      issues,
    },
    violations,
    needs,
    notes: [],
  };
}

export { isContractStep };
