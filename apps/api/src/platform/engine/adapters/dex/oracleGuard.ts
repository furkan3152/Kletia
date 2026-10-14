/**
 * Chainlink price band of the Kletia-encoded EVM swaps: the pool quote is
 * compared with the output the Rule Book's conservative oracle implies
 * (`policyPrices`: Chainlink with heartbeat and sequencer checks, derived
 * LST prices, the maximum of fresh sources).
 *
 * - Either asset unpriced: PRICE_UNAVAILABLE (fail closed; a swap is never
 *   planned without an independent price).
 * - Quote more than 5 % below the oracle-implied output: PRICE_IMPACT_TOO_HIGH.
 * - More than 1 % below: a warning ("Price impact: ...") on the step.
 *
 * The band bounds pool manipulation and thin pools; the on-chain
 * `amountOutMinimum` bounds what can happen between quote and execution.
 */
import { CHAINS, type NetworkKey } from "@kletia/core";
import { PlatformError } from "../../../errors.js";
import type { ResolvedAsset } from "../../assets.js";
import { policyPrices } from "../../policy/pricing.js";

/** A quote further below the oracle than this (bps) is refused. */
export const ORACLE_REFUSE_BPS = 500n;
/** A quote further below the oracle than this (bps) carries a warning. */
export const ORACLE_WARN_BPS = 100n;

export interface OracleCheck {
  /** Output the oracle prices imply for the input amount (base units of the output). */
  readonly impliedOutput: bigint;
  /** How far the quote is below the implied output, in bps (negative: above it). */
  readonly shortfallBps: bigint;
  readonly warnings: readonly string[];
}

function percent(bps: bigint): string {
  const sign = bps < 0n ? "-" : "";
  const value = bps < 0n ? -bps : bps;
  return `${sign}${value / 100n}.${(value % 100n).toString().padStart(2, "0")} %`;
}

/**
 * Checks a same-network swap quote against the oracle. Throws
 * PRICE_UNAVAILABLE or PRICE_IMPACT_TOO_HIGH (422); returns the warnings to
 * attach otherwise.
 */
export async function oracleGuard(
  network: NetworkKey,
  input: ResolvedAsset,
  amountIn: bigint,
  output: ResolvedAsset,
  quotedOutput: bigint,
): Promise<OracleCheck> {
  const ref = (asset: ResolvedAsset) => ({ asset: asset.id, symbol: asset.symbol, decimals: asset.decimals, network });
  const prices = await policyPrices([ref(input), ref(output)]);
  const inPrice = prices.get(input.id) ?? null;
  const outPrice = prices.get(output.id) ?? null;
  const unpriced = [inPrice ? null : input.symbol, outPrice ? null : output.symbol].filter((symbol): symbol is string => symbol !== null);
  if (!inPrice || !outPrice || inPrice.basis !== "oracle" || outPrice.basis !== "oracle" || inPrice.usd18 <= 0n || outPrice.usd18 <= 0n) {
    throw new PlatformError(
      "PRICE_UNAVAILABLE",
      `No fresh oracle price covers ${unpriced.length > 0 ? unpriced.join(" and ") : `${input.symbol} and ${output.symbol}`} on ${CHAINS[network].name}, so the swap's price guard refuses it. Plan again once the price feed updates.`,
      422,
    );
  }
  // amountIn x priceIn / priceOut, converted between the two assets' decimals (rounded down).
  const impliedOutput = (amountIn * inPrice.usd18 * 10n ** BigInt(output.decimals)) / (outPrice.usd18 * 10n ** BigInt(input.decimals));
  if (impliedOutput <= 0n) {
    throw new PlatformError("AMOUNT_TOO_SMALL", `The amount is too small to price ${input.symbol} against ${output.symbol}.`, 422);
  }
  const shortfallBps = ((impliedOutput - quotedOutput) * 10_000n) / impliedOutput;
  if (shortfallBps > ORACLE_REFUSE_BPS) {
    throw new PlatformError(
      "PRICE_IMPACT_TOO_HIGH",
      `The best pool quote is ${percent(shortfallBps)} below the Chainlink oracle price of ${input.symbol} in ${output.symbol}; swaps more than 5 % below it are refused. Move a smaller amount.`,
      422,
    );
  }
  const warnings = shortfallBps > ORACLE_WARN_BPS
    ? [`Price impact: the quote is ${percent(shortfallBps)} below the Chainlink oracle price (pool fee and depth included).`]
    : [];
  return { impliedOutput, shortfallBps, warnings };
}
