/**
 * One amount model for funded steps (journey design 3.2, amount flow F1-F7).
 *
 * A step funded by an earlier step spends its share of what that step
 * delivers. The preview, the journey and the planner all read the same rules
 * from here, so the review, the fare and the journey agree about the same
 * money:
 *
 * - F3: the step spends share x parent credit (shares round down; the
 *   remainder of a split stays at the parent's output stop as `kept`, F7);
 * - F6: a planned gas reserve (`funding.gasReserve`) is subtracted after the
 *   share and stays as `kept` too; it never makes the spend negative;
 * - a funded step paying a third party never pays more than its planned
 *   input x (1 + slippage); anything above stays with the user (`kept`).
 *
 * Pure integer math on base units; no I/O.
 */
import { parseAssetId, sameAddressAccount } from "./caip.js";
import type { Certainty } from "./preview.js";
import type { IntentGraph, IntentStep } from "./intent.js";

/** Default slippage of a step whose quote recorded none (engine `DEFAULT_SLIPPAGE_BPS`). */
export const FLOW_DEFAULT_SLIPPAGE_BPS = 50;

export interface ParentCredit {
  /** What the parent delivers to this step's account in the step's input asset. */
  readonly expected: bigint;
  readonly worst: bigint;
  /** "observed" once the parent settled (actualOutput), else the certainty of the parent's credit row. */
  readonly certainty: Certainty | "observed";
}

export interface FundedFlow {
  /** What the step spends at execution: share x parent credit - gas reserve, capped for third-party recipients. */
  readonly spends: { readonly expected: bigint; readonly worst: bigint };
  /** What stays at the parent's output stop: the rest of the share, plus the gas reserve (and anything above the cap). */
  readonly kept: { readonly expected: bigint; readonly worst: bigint };
  readonly reserve: bigint;
  /** Units the step's quote and transactions were built on (planned input). */
  readonly encoded: bigint;
}

export interface FundedFlowOptions {
  /** Slippage the step's quote recorded (step ref); defaults to the request's maxSlippageBps, else 50. */
  readonly slippageBps?: number;
  /** The planned input the third-party cap is held to (step ref `plannedInput`); defaults to step.input. */
  readonly plannedInput?: bigint;
  /** Share for steps without `funding` (older stored intents: the step ref's portionBps); default all. */
  readonly portionBps?: number;
  /** Gas reserve for steps without `funding` (older stored intents), base units of the input. */
  readonly gasReserve?: bigint;
}

function sameAsset(a: string, b: string): boolean {
  const left = parseAssetId(a);
  const right = parseAssetId(b);
  if (!left || !right) return a === b;
  if (left.chain.id !== right.chain.id || left.assetNamespace !== right.assetNamespace) return false;
  return left.assetNamespace === "erc20" ? left.reference.toLowerCase() === right.reference.toLowerCase() : left.reference === right.reference;
}

function nonNegative(value: bigint): bigint {
  return value < 0n ? 0n : value;
}

/** The step a funded step spends from: `funding.from`, else the `funds` edge into it. */
export function fundingParent(graph: IntentGraph, step: IntentStep): IntentStep | null {
  const from = step.funding?.from ?? graph.edges.find((edge) => edge.to === step.id && edge.kind === "funds")?.from;
  if (!from) return null;
  return graph.steps.find((candidate) => candidate.id === from) ?? null;
}

/** True when `account` is one of the request's own accounts (same address on any network of its VM). */
export function isOwnRequestAccount(graph: IntentGraph, account: string): boolean {
  return graph.request.accounts.some((own) => sameAddressAccount(own, account));
}

/**
 * Credit of the funding parent from the graph (actualOutput, else
 * expected/minimum output), when the preview has no row for it. Null when
 * the step is not funded or the parent delivers another asset.
 */
export function parentCreditFromGraph(graph: IntentGraph, step: IntentStep): ParentCredit | null {
  if (!step.input) return null;
  const parent = fundingParent(graph, step);
  if (!parent) return null;
  const input = step.input.asset;
  if (parent.actualOutput && sameAsset(parent.actualOutput.asset, input)) {
    const observed = BigInt(parent.actualOutput.amount);
    return { expected: observed, worst: observed, certainty: "observed" };
  }
  if (!parent.minimumOutput || !sameAsset(parent.minimumOutput.asset, input)) return null;
  const worst = BigInt(parent.minimumOutput.amount);
  const expected = parent.expectedOutput && sameAsset(parent.expectedOutput.asset, input) ? BigInt(parent.expectedOutput.amount) : worst;
  const certainty: Certainty = parent.settlement?.kind === "cross-network" ? "venue-minimum" : "quoted";
  return { expected: expected < worst ? worst : expected, worst, certainty };
}

/** F3, F6, F7 and the third-party cap, in base units. */
export function fundedFlow(graph: IntentGraph, step: IntentStep, credit: ParentCredit, options: FundedFlowOptions = {}): FundedFlow {
  const portion = BigInt(step.funding?.portionBps ?? options.portionBps ?? 10_000);
  const reserve = nonNegative(step.funding?.gasReserve ? BigInt(step.funding.gasReserve.amount) : (options.gasReserve ?? 0n));
  const encoded = step.input ? BigInt(step.input.amount) : 0n;
  let expected = nonNegative((credit.expected * portion) / 10_000n - reserve);
  let worst = nonNegative((credit.worst * portion) / 10_000n - reserve);
  const recipient = step.recipient ?? step.account;
  if (!isOwnRequestAccount(graph, recipient)) {
    const slippage = BigInt(options.slippageBps ?? graph.request.constraints?.maxSlippageBps ?? FLOW_DEFAULT_SLIPPAGE_BPS);
    const cap = ((options.plannedInput ?? encoded) * (10_000n + slippage)) / 10_000n;
    if (expected > cap) expected = cap;
    if (worst > cap) worst = cap;
  }
  return {
    spends: { expected, worst },
    kept: { expected: nonNegative(credit.expected - expected), worst: nonNegative(credit.worst - worst) },
    reserve,
    encoded,
  };
}

/** Linear scaling of a step's output by spends / encoded (the preview's `estimated` rule). */
export function scaleOutput(output: bigint, flow: FundedFlow | null): { readonly expected: bigint; readonly estimated: boolean } {
  if (!flow || flow.encoded === 0n || flow.spends.expected === flow.encoded) return { expected: output, estimated: false };
  return { expected: (output * flow.spends.expected) / flow.encoded, estimated: true };
}

/** The guaranteed output when the funding floor fell below the encoded input: scaled down, never up. */
export function scaleFloor(minimum: bigint, flow: FundedFlow | null): bigint {
  if (!flow || flow.encoded === 0n || flow.spends.worst >= flow.encoded) return minimum;
  return (minimum * flow.spends.worst) / flow.encoded;
}

/** F6: a planned gas reserve may take at most this share of what the step's share of the floor is (else AMOUNT_TOO_SMALL). */
export const GAS_RESERVE_MAX_SHARE_BPS = 2_500;

/** Rounds a non-negative integer up to `digits` significant digits (4,458 -> 4,500 with two). */
export function ceilSignificant(value: bigint, digits = 2): bigint {
  if (value <= 0n) return 0n;
  const width = value.toString().length;
  if (width <= digits) return value;
  const unit = 10n ** BigInt(width - digits);
  return ((value + unit - 1n) / unit) * unit;
}

/**
 * F6: the gas reserve a funded step keeps from a gas-asset input when the
 * account holds too little gas on that network: two times the estimated
 * fees of the step and the later wallet steps there, plus `extra` (Solana:
 * the rent-exempt minimum of an empty wallet), rounded up to two
 * significant digits.
 */
export function gasReserveUnits(fees: bigint, extra = 0n): bigint {
  return ceilSignificant(2n * (fees < 0n ? 0n : fees) + (extra < 0n ? 0n : extra));
}

/** True when `reserve` takes GAS_RESERVE_MAX_SHARE_BPS or more of `share` (what arrives would mostly pay network fees). */
export function reserveTooLarge(reserve: bigint, share: bigint): boolean {
  return reserve > 0n && reserve * 10_000n >= share * BigInt(GAS_RESERVE_MAX_SHARE_BPS);
}
