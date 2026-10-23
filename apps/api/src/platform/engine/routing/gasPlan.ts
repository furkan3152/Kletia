/**
 * Gas on every network that signs later (design C.3, red-team C1).
 *
 * For each network where the person must sign a step after a crossing has
 * arrived there, the plan needs gas for every transaction the person signs
 * on that network (each step's transactions by kind and venue, approvals
 * unless the allowance suffices, Solana fees and new token-account rent).
 * It is compared with the gas balance there (holdings facts, cached) plus
 * what earlier legs deliver: a gas top-up planned on an arriving leg
 * (`constraints.gasOnArrival`), or the gas asset itself arriving for the
 * person (the funded step then keeps its F6 reserve).
 *
 * When a balance is known to be short and no top-up covers it, planning
 * fails with GAS_TOPUP_UNAVAILABLE and `details { network, needUnits,
 * haveUnits }` (seam S7: the decision layer asks GAS_ON_ARRIVAL). An
 * unreadable balance never refuses (the read is best effort, AR7); the plan
 * then carries a warning naming the gas the later steps need.
 *
 * The composer uses `arrivalGasState` first so a shape that swaps on arrival
 * is not chosen where the person holds no gas (C.3 (b)).
 */
import { CHAINS, fromBaseUnits, type IntentActionKind, type NetworkKey, type ProtocolId } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { estimateStepFee } from "../journey/fees.js";
import { rankingGasPrice } from "./score.js";

/** One step of the plan as the gas plan sees it. */
export interface GasPlanStep {
  readonly index: number;
  readonly network: NetworkKey;
  readonly kind: IntentActionKind;
  readonly protocol: ProtocolId;
  /** The step's input asset id (a native input changes the EVM operations). */
  readonly inputAsset?: string;
  /** Transactions the step signs (from its quote: an approval is counted only when needed). */
  readonly transactions: number;
  /** Where the step's output lands, when it pays the person's own account. */
  readonly arrives?: {
    readonly network: NetworkKey;
    /** The output is the destination's gas asset. */
    readonly native: boolean;
    /** Base units of the gas top-up this leg delivers there. */
    readonly topupUnits?: bigint;
  };
}

/** What the gas plan reads for one network (null: unknown). */
export interface GasPlanFacts {
  readonly balance: bigint | null;
  readonly gasPriceWei: bigint | null;
  readonly tokenAccountRentLamports: bigint | null;
}

export type GasPlanReader = (network: NetworkKey) => Promise<GasPlanFacts>;

export interface GasShortfall {
  readonly network: NetworkKey;
  /** Gas-asset base units the person's steps there need. */
  readonly needUnits: bigint;
  /** Gas-asset base units held there plus what earlier legs deliver. */
  readonly haveUnits: bigint;
  /** Step indexes signed there. */
  readonly steps: readonly number[];
}

export interface GasPlanResult {
  readonly shortfalls: readonly GasShortfall[];
  /** Networks whose balance could not be read, with what their steps need. */
  readonly unknown: readonly { readonly network: NetworkKey; readonly needUnits: bigint; readonly steps: readonly number[] }[];
}

/** Gas-asset base units one step needs on its network (0 when the fee cannot be estimated). */
export function stepGasUnits(step: Pick<GasPlanStep, "network" | "kind" | "protocol" | "inputAsset" | "transactions">, facts: Pick<GasPlanFacts, "gasPriceWei" | "tokenAccountRentLamports">): bigint {
  const svm = CHAINS[step.network].vm === "svm";
  const estimate = estimateStepFee(
    { kind: step.kind, network: step.network, protocol: step.protocol, ...(step.inputAsset ? { input: { asset: step.inputAsset } } : {}) },
    {
      // An unknown gas price counts at the network's upper-bound fallback (never as free).
      gasPriceWei: rankingGasPrice(step.network, facts.gasPriceWei),
      tokenAccountRentLamports: facts.tokenAccountRentLamports,
      // A swap, stake or deposit may create the output's token account (unknown counts as missing).
      ...(svm && step.kind !== "transfer" ? { tokenAccounts: [null] } : {}),
    },
  );
  return estimate.amount === null ? 0n : BigInt(estimate.amount);
}

/**
 * Networks where the person signs after a crossing arrived, what their
 * steps need there and what is available (C.3). Pure given the reader.
 */
export async function planGas(steps: readonly GasPlanStep[], read: GasPlanReader): Promise<GasPlanResult> {
  const checked = new Set<NetworkKey>();
  steps.forEach((step, position) => {
    const arrivedBefore = steps.slice(0, position).some((earlier) => earlier.arrives?.network === step.network && earlier.network !== step.network);
    if (arrivedBefore) checked.add(step.network);
  });
  const shortfalls: GasShortfall[] = [];
  const unknown: { network: NetworkKey; needUnits: bigint; steps: number[] }[] = [];
  for (const network of checked) {
    const signed = steps.filter((step) => step.network === network);
    const arriving = steps.filter((step) => step.arrives?.network === network && step.network !== network);
    // The gas asset itself arriving for the person: the funded step keeps its F6 reserve from it.
    if (arriving.some((step) => step.arrives?.native)) continue;
    const facts = await read(network).catch((): GasPlanFacts => ({ balance: null, gasPriceWei: null, tokenAccountRentLamports: null }));
    const need = signed.reduce((total, step) => total + stepGasUnits(step, facts), 0n);
    if (need <= 0n) continue;
    const topups = arriving.reduce((total, step) => total + (step.arrives?.topupUnits ?? 0n), 0n);
    if (facts.balance === null) {
      if (topups < need) unknown.push({ network, needUnits: need, steps: signed.map((step) => step.index) });
      continue;
    }
    const have = facts.balance + topups;
    if (have < need) shortfalls.push({ network, needUnits: need, haveUnits: have, steps: signed.map((step) => step.index) });
  }
  return { shortfalls, unknown };
}

/**
 * Gas on the destination for a shape that swaps on arrival: "ok" when the
 * balance (or a planned top-up) covers one swap there, "short" when the
 * balance is known to be lower, "unknown" when it cannot be read.
 */
export async function arrivalGasState(network: NetworkKey, read: GasPlanReader, topupPlanned: boolean): Promise<"ok" | "short" | "unknown"> {
  if (topupPlanned) return "ok";
  const facts = await read(network).catch((): GasPlanFacts => ({ balance: null, gasPriceWei: null, tokenAccountRentLamports: null }));
  if (facts.balance === null) return "unknown";
  const need = stepGasUnits({ network, kind: "swap", protocol: "" as ProtocolId, transactions: 2 }, facts);
  return facts.balance >= need ? "ok" : "short";
}

function units(network: NetworkKey, amount: bigint): string {
  const native = CHAINS[network].nativeAsset;
  return `${fromBaseUnits(amount, native.decimals)} ${native.symbol}`;
}

/** The refusal of a known shortfall (seam S7 details: network, needUnits, haveUnits). */
export function gasShortfallError(shortfall: GasShortfall, topupOffered: boolean): PlatformError {
  const name = CHAINS[shortfall.network].name;
  const steps = shortfall.steps.map((index) => index + 1).join(", ");
  const evm = CHAINS[shortfall.network].vm === "evm";
  const way = evm && topupOffered
    ? `Set constraints.gasOnArrival.${shortfall.network} (for example "0.50") so the leg arriving there delivers gas, or bring ${CHAINS[shortfall.network].nativeAsset.symbol} there first.`
    : `No venue delivers gas there with this route; bring ${CHAINS[shortfall.network].nativeAsset.symbol} to ${name} first.`;
  return new PlatformError(
    "GAS_TOPUP_UNAVAILABLE",
    `Step${shortfall.steps.length === 1 ? "" : "s"} ${steps} must be signed on ${name}, which needs about ${units(shortfall.network, shortfall.needUnits)} for network fees; your account has ${units(shortfall.network, shortfall.haveUnits)} there. ${way}`,
    422,
    [{ path: `constraints.gasOnArrival.${shortfall.network}`, message: "Not enough gas on this network for the later steps." }],
    [],
    {
      network: shortfall.network,
      needUnits: shortfall.needUnits.toString(),
      haveUnits: shortfall.haveUnits.toString(),
    },
  );
}

/** Warning of an unreadable balance on a network that signs later. */
export function gasUnknownWarning(entry: GasPlanResult["unknown"][number]): string {
  const steps = entry.steps.map((index) => index + 1).join(", ");
  return `Could not read your ${CHAINS[entry.network].nativeAsset.symbol} on ${CHAINS[entry.network].name}: step${entry.steps.length === 1 ? " " + steps + " needs" : "s " + steps + " need"} about ${units(entry.network, entry.needUnits)} there for network fees.`;
}
