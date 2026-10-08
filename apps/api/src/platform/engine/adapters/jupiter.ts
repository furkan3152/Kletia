/**
 * Jupiter adapter: Solana swaps and liquid staking (SOL -> JitoSOL / mSOL /
 * JupSOL executed as a Jupiter route into the LST).
 */
import { fromBaseUnits, formatAmount, type AssetAmount, type IntentStep } from "@kletia/core";
import {
  buildJupiterSwapTransaction,
  quoteJupiterSwap,
  readSolanaPrices,
  SOLANA_MAX_SLIPPAGE_BPS,
  type JupiterQuote,
} from "../../../networks/solana/index.js";
import { PlatformError } from "../../errors.js";
import { assetAmount, assetFromRef, jupiterMint, sameAsset, type ResolvedAsset } from "../assets.js";
import { assertSolanaTransactionOwner, SOLANA_PROGRAM_IDS } from "../chains/solana.js";
import { nativeUsdPrice } from "../prices.js";
import { decodeStepRef } from "../stepRef.js";
import type { AdapterAction, PlannedStep, PreparedPayload, ProtocolAdapter, VerificationResult } from "./types.js";
import { effectiveSolDelta, SOL_RENT_TOLERANCE_LAMPORTS, stepOwner, tokenDelta, verifySolanaReferences } from "./verification.js";

const MAX_PRICE_IMPACT = 0.05;
const WARN_PRICE_IMPACT = 0.01;
/** Typical base + priority fee for one Jupiter swap, in SOL. */
const ESTIMATED_NETWORK_FEE_SOL = 0.0001;
/** Clock skew tolerated between prepare time (server clock) and block time. */
const CLOCK_SKEW_SECONDS = 300;
/** A prepared payload lands within this long or never: payload TTL (90 s) plus blockhash expiry grace. */
const PAYLOAD_LANDING_SECONDS = 90 + 180;

function clampSlippage(requested: number, warnings: string[]): number {
  if (requested > SOLANA_MAX_SLIPPAGE_BPS) {
    warnings.push(`Slippage capped at ${SOLANA_MAX_SLIPPAGE_BPS} bps for Jupiter routes.`);
    return SOLANA_MAX_SLIPPAGE_BPS;
  }
  return requested;
}

function assertStakeShape(action: Pick<AdapterAction, "kind" | "input" | "output">): void {
  if (action.kind !== "stake") return;
  if (!action.input.isNative) {
    throw new PlatformError("INTENT_UNSUPPORTED", "Liquid staking starts from native SOL.", 422);
  }
  if (action.output.category !== "liquid-staking") {
    throw new PlatformError("INTENT_UNSUPPORTED", "Stake into JitoSOL, mSOL or JupSOL.", 422);
  }
}

async function quote(action: Pick<AdapterAction, "input" | "output" | "amount">, slippageBps: number): Promise<JupiterQuote> {
  return quoteJupiterSwap({
    inputMint: jupiterMint(action.input),
    outputMint: jupiterMint(action.output),
    amount: action.amount,
    slippageBps,
  });
}

function impactWarnings(result: JupiterQuote, warnings: string[]): void {
  if (result.priceImpactPct > MAX_PRICE_IMPACT) {
    throw new PlatformError(
      "PRICE_IMPACT_TOO_HIGH",
      `Price impact is ${(result.priceImpactPct * 100).toFixed(2)}%; routes above 5% are refused.`,
      422,
    );
  }
  if (result.priceImpactPct > WARN_PRICE_IMPACT) {
    warnings.push(`Price impact is ${(result.priceImpactPct * 100).toFixed(2)}%.`);
  }
}

async function priced(asset: ResolvedAsset, units: string, prices: Map<string, { usd: number }>): Promise<AssetAmount> {
  const price = prices.get(jupiterMint(asset));
  return assetAmount(asset, units, price ? Number(fromBaseUnits(units, asset.decimals)) * price.usd : undefined);
}

async function amounts(action: Pick<AdapterAction, "input" | "output" | "amount">, result: JupiterQuote) {
  const prices = await readSolanaPrices([jupiterMint(action.input), jupiterMint(action.output)]).catch(
    () => new Map<string, { usd: number }>(),
  );
  return {
    input: await priced(action.input, action.amount, prices),
    expectedOutput: await priced(action.output, result.outAmount, prices),
    minimumOutput: await priced(action.output, result.minimumOutAmount, prices),
  };
}

function title(action: Pick<AdapterAction, "kind" | "input" | "output" | "amount" | "provider">): string {
  const amount = formatAmount(fromBaseUnits(action.amount, action.input.decimals));
  return action.kind === "stake"
    ? `Stake ${amount} SOL as ${action.output.symbol} (${action.provider ?? "liquid staking"} via Jupiter)`
    : `Swap ${amount} ${action.input.symbol} for ${action.output.symbol} on Solana`;
}

/**
 * Output floor (base units) for a swap that landed at `blockTime` (unix s):
 * the lowest guarantee among the payloads prepared for this step that could
 * have landed then, so an earlier payload landing after a re-prepare raised
 * the floor still verifies against its own on-chain minimum. Steps without
 * recorded floors (or none in the window) use the current minimum.
 */
function outputFloor(step: IntentStep, minimum: AssetAmount, blockTime: number | null): bigint {
  const eligible = blockTime === null
    ? []
    : (decodeStepRef(step.quoteRef)?.floors ?? [])
        .filter((floor) => floor.at - CLOCK_SKEW_SECONDS <= blockTime && blockTime <= floor.at + PAYLOAD_LANDING_SECONDS + CLOCK_SKEW_SECONDS)
        .map((floor) => BigInt(floor.min));
  return eligible.length > 0 ? eligible.reduce((low, value) => (value < low ? value : low)) : BigInt(minimum.amount);
}

async function feeUsd(): Promise<number | undefined> {
  const sol = await nativeUsdPrice("solana");
  return sol === null ? undefined : ESTIMATED_NETWORK_FEE_SOL * sol;
}

export const jupiterAdapter: ProtocolAdapter = {
  id: "jupiter",
  protocols: ["jupiter"],
  label: "Jupiter",

  supports(route) {
    return (
      route.network === "solana" &&
      route.destinationNetwork === "solana" &&
      (route.kind === "swap" || route.kind === "stake") &&
      !sameAsset(route.input, route.output)
    );
  },

  async plan(action): Promise<PlannedStep> {
    assertStakeShape(action);
    const warnings: string[] = [];
    const slippageBps = clampSlippage(action.slippageBps, warnings);
    const result = await quote(action, slippageBps);
    impactWarnings(result, warnings);
    if (!action.output.verified) warnings.push(`${action.output.symbol} is not on Jupiter's verified list.`);
    const route = result.route.map((leg) => leg.label).filter((label, index, all) => all.indexOf(label) === index);
    if (route.length > 0) warnings.push(`Route: ${route.slice(0, 4).join(" → ")}.`);
    const fees = await feeUsd();
    return {
      protocol: "jupiter",
      title: title(action),
      mode: "wallet",
      ...(await amounts(action, result)),
      ...(fees !== undefined ? { feesUsd: fees } : {}),
      estimatedSeconds: 15,
      settlement: { kind: "same-network" },
      warnings,
      ...(result.contextSlot ? { quoteId: `slot:${result.contextSlot}` } : {}),
      transactionCount: 1,
      slippageBps,
    };
  },

  async prepare({ step, action }): Promise<PreparedPayload> {
    assertStakeShape(action);
    const warnings: string[] = [];
    const slippageBps = clampSlippage(decodeStepRef(step.quoteRef)?.slippageBps ?? action.slippageBps, warnings);
    const result = await quote(action, slippageBps);
    impactWarnings(result, warnings);
    const built = await buildJupiterSwapTransaction(result, action.account.address);
    const info = assertSolanaTransactionOwner(built.transaction, action.account.address);
    if (!info.programs.includes(SOLANA_PROGRAM_IDS.jupiterV6)) {
      throw new PlatformError("PROVIDER_TRANSACTION_REJECTED", "Jupiter returned a transaction that does not invoke the Jupiter program.", 502);
    }
    const description = title(action);
    const fees = await feeUsd();
    return {
      transactions: [
        {
          vm: "svm",
          network: "solana",
          feePayer: action.account.address,
          transaction: built.transaction,
          encoding: "base64",
          lastValidBlockHeight: built.lastValidBlockHeight,
          description,
        },
      ],
      records: [{ vm: "svm", network: "solana", feePayer: action.account.address, to: SOLANA_PROGRAM_IDS.jupiterV6, description }],
      ...(await amounts(action, result)),
      ...(fees !== undefined ? { feesUsd: fees } : {}),
      ...(result.contextSlot ? { quoteId: `slot:${result.contextSlot}` } : {}),
      warnings,
    };
  },

  async verify(context): Promise<VerificationResult> {
    const { step } = context;
    const input = step.input ? assetFromRef(step.input) : null;
    const output = step.minimumOutput ? assetFromRef(step.minimumOutput) : null;
    const owner = stepOwner(step);
    const observed: { actual?: AssetAmount } = {};
    const { result } = await verifySolanaReferences(context, (observations) => {
      if (!input || !output || !step.input || !step.minimumOutput) {
        return { failure: { code: "STEP_INVALID", message: "The swap step has no recorded amounts." } };
      }
      const mismatch = (message: string) => ({ failure: { code: "REFERENCE_MISMATCH", message } });
      // Input: the swap must have spent the step amount from the step account.
      const spent = input.isNative
        ? -effectiveSolDelta(observations, owner) + SOL_RENT_TOLERANCE_LAMPORTS
        : -tokenDelta(observations, owner, input.address as string);
      if (spent < BigInt(step.input.amount)) {
        return mismatch(`The transaction did not spend ${step.input.formatted} ${input.symbol} from the step account.`);
      }
      // Output: at least the landed payload's guaranteed minimum must have reached the step account.
      const received = output.isNative
        ? effectiveSolDelta(observations, owner)
        : tokenDelta(observations, owner, output.address as string);
      const guaranteed = outputFloor(step, step.minimumOutput, observations[0]?.blockTime ?? null);
      const floor = guaranteed - (output.isNative ? SOL_RENT_TOLERANCE_LAMPORTS : 0n);
      if (received < floor || received <= 0n) {
        return mismatch(`The transaction did not credit at least ${fromBaseUnits(guaranteed, output.decimals)} ${output.symbol} to the step account.`);
      }
      observed.actual = assetAmount(output, received.toString());
    });
    if (result.status === "confirmed" && observed.actual) return { ...result, actualOutput: observed.actual };
    return result;
  },
};
