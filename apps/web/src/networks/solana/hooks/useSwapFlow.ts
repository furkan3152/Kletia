import { useCallback } from "react";
import { fromBaseUnits, toBaseUnits, WRAPPED_SOL_MINT, type SolanaTransactionRequest } from "@kletia/core";

import {
  parseQuote,
  prepareSwap,
  solanaPaths,
  type SolanaPortfolio,
  type SolanaPreparedSwap,
} from "../api";
import { formatTokenAmount, validateAmountInput } from "../format";
import type { TokenOption } from "../tokens";
import { useSolanaExecution } from "./useSolanaExecution";
import { useDebouncedValue, useSolanaResource } from "./useSolanaResource";

/** SOL kept back for fees and rent when the user picks "Max". */
export const SOL_FEE_RESERVE_LAMPORTS = 10_000_000n;

export function balanceOf(portfolio: SolanaPortfolio | null, token: TokenOption): string | null {
  if (!portfolio) return null;
  const isSol = token.mint === WRAPPED_SOL_MINT && token.symbol === "SOL";
  const holding = portfolio.holdings.find((candidate) =>
    isSol ? candidate.isNative : candidate.mint === token.mint && !candidate.isNative,
  );
  return holding ? holding.amount : "0";
}

/** Largest spendable decimal amount (keeps a SOL fee reserve). */
export function maxSpendable(portfolio: SolanaPortfolio | null, token: TokenOption): string | null {
  const units = balanceOf(portfolio, token);
  if (units === null) return null;
  let spendable = BigInt(units);
  if (token.mint === WRAPPED_SOL_MINT && token.symbol === "SOL") {
    spendable = spendable > SOL_FEE_RESERVE_LAMPORTS ? spendable - SOL_FEE_RESERVE_LAMPORTS : 0n;
  }
  return fromBaseUnits(spendable, token.decimals);
}

export function exceedsBalance(
  portfolio: SolanaPortfolio | null,
  token: TokenOption,
  amount: string,
): boolean {
  const units = balanceOf(portfolio, token);
  if (units === null) return false;
  try {
    return BigInt(toBaseUnits(amount.trim(), token.decimals)) > BigInt(units);
  } catch {
    return false;
  }
}

/**
 * Live Jupiter quote plus the prepare -> sign -> confirm flow for a swap on
 * Solana mainnet. Used by the Swap and Stake panels.
 */
export function useSwapFlow(input: {
  owner: string | null;
  from: TokenOption;
  to: TokenOption;
  amount: string;
  slippageBps: number;
  titleVerb?: string;
}) {
  const { owner, from, to, amount, slippageBps, titleVerb = "Swap" } = input;
  const amountError = amount.trim() ? validateAmountInput(amount, from.decimals) : null;
  const quotePath =
    !amountError && amount.trim() && from.mint !== to.mint
      ? solanaPaths.quote(from.mint, to.mint, amount.trim(), slippageBps)
      : null;
  const debouncedPath = useDebouncedValue(quotePath, 450);
  const quote = useSolanaResource(debouncedPath, parseQuote);
  const quoteIsCurrent = quotePath !== null && debouncedPath === quotePath;
  const execution = useSolanaExecution<SolanaPreparedSwap>();
  const { prepare } = execution;

  const startReview = useCallback(() => {
    if (!owner || !quotePath) return;
    const trimmed = amount.trim();
    void prepare(async (signal) => {
      const prepared = await prepareSwap(
        { owner, from: from.mint, to: to.mint, amount: trimmed, slippageBps },
        signal,
      );
      // Bind the prepared transaction to exactly what the user asked for.
      if (
        prepared.input.token.mint !== from.mint ||
        prepared.output.token.mint !== to.mint ||
        prepared.input.amount !== toBaseUnits(trimmed, from.decimals)
      ) {
        throw new Error("The prepared swap does not match the requested tokens and amount.");
      }
      const title = `${titleVerb} ${formatTokenAmount(prepared.input.formatted)} ${prepared.input.token.symbol} to ${prepared.output.token.symbol}`;
      const request: SolanaTransactionRequest = {
        vm: "svm",
        network: "solana",
        feePayer: owner,
        transaction: prepared.transaction.transaction,
        encoding: "base64",
        lastValidBlockHeight: prepared.transaction.lastValidBlockHeight,
        description: title,
      };
      return {
        request,
        title,
        details: prepared,
        blockedReason:
          prepared.priceImpactPct > 0.05
            ? "Price impact is above 5%; Kletia will not sign this swap."
            : null,
      };
    });
  }, [amount, from, owner, prepare, quotePath, slippageBps, titleVerb, to]);

  return {
    amountError,
    quote,
    quoteIsCurrent,
    quotePending: quotePath !== null && (!quoteIsCurrent || quote.loading),
    canReview: Boolean(owner && quotePath && !execution.busy),
    startReview,
    execution,
  };
}
