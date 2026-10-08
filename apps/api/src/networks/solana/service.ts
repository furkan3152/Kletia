/**
 * High-level Solana operations shared by the Solana HTTP routes and the
 * cross-network intent engine. Amounts enter as human decimals and leave as
 * exact base units plus a formatted string.
 */
import { fromBaseUnits, toBaseUnits } from "@kletia/core";
import { SolanaProviderError } from "./http.js";
import { buildJupiterSwapTransaction, quoteJupiterSwap, type JupiterQuote } from "./jupiter.js";
import { buildSolanaTransfer, type PreparedSolanaTransaction } from "./transactions.js";
import { resolveSolanaToken, type SolanaTokenInfo } from "./tokens.js";
import type { SolanaNetworkKey } from "./config.js";

export async function requireSolanaToken(network: SolanaNetworkKey, symbolOrMint: string): Promise<SolanaTokenInfo> {
  const token = await resolveSolanaToken(network, symbolOrMint);
  if (!token) {
    throw new SolanaProviderError(`Unknown token "${symbolOrMint.slice(0, 48)}" on ${network}.`, "SOLANA_TOKEN_UNKNOWN", 422);
  }
  return token;
}

function baseUnits(amount: string, decimals: number): string {
  try {
    const units = toBaseUnits(amount, decimals);
    if (units === "0") throw new Error("zero");
    return units;
  } catch {
    throw new SolanaProviderError("Amount must be a positive decimal within token precision.", "SOLANA_AMOUNT_INVALID", 400);
  }
}

export interface SolanaSwapQuoteSummary {
  readonly network: "solana";
  readonly input: { readonly token: SolanaTokenInfo; readonly amount: string; readonly formatted: string };
  readonly output: {
    readonly token: SolanaTokenInfo;
    readonly amount: string;
    readonly formatted: string;
    readonly minimum: string;
    readonly minimumFormatted: string;
  };
  readonly slippageBps: number;
  readonly priceImpactPct: number;
  readonly route: JupiterQuote["route"];
  readonly warnings: readonly string[];
  readonly quote: JupiterQuote;
}

export async function quoteSolanaSwap(input: {
  from: string;
  to: string;
  amount: string;
  slippageBps?: number;
}): Promise<SolanaSwapQuoteSummary> {
  const [fromToken, toToken] = await Promise.all([
    requireSolanaToken("solana", input.from),
    requireSolanaToken("solana", input.to),
  ]);
  const amount = baseUnits(input.amount, fromToken.decimals);
  const quote = await quoteJupiterSwap({
    inputMint: fromToken.mint,
    outputMint: toToken.mint,
    amount,
    ...(input.slippageBps !== undefined ? { slippageBps: input.slippageBps } : {}),
  });
  const warnings: string[] = [];
  if (!toToken.verified) warnings.push(`${toToken.symbol} is not on Jupiter's verified list.`);
  if (quote.priceImpactPct > 0.01) warnings.push(`Price impact is ${(quote.priceImpactPct * 100).toFixed(2)}%.`);
  return {
    network: "solana",
    input: { token: fromToken, amount, formatted: fromBaseUnits(amount, fromToken.decimals) },
    output: {
      token: toToken,
      amount: quote.outAmount,
      formatted: fromBaseUnits(quote.outAmount, toToken.decimals),
      minimum: quote.minimumOutAmount,
      minimumFormatted: fromBaseUnits(quote.minimumOutAmount, toToken.decimals),
    },
    slippageBps: quote.slippageBps,
    priceImpactPct: quote.priceImpactPct,
    route: quote.route,
    warnings,
    quote,
  };
}

export async function prepareSolanaSwap(input: {
  owner: string;
  from: string;
  to: string;
  amount: string;
  slippageBps?: number;
}) {
  const summary = await quoteSolanaSwap(input);
  if (summary.priceImpactPct > 0.05) {
    throw new SolanaProviderError("Price impact above 5% is refused.", "SOLANA_PRICE_IMPACT_TOO_HIGH", 422);
  }
  const transaction = await buildJupiterSwapTransaction(summary.quote, input.owner);
  const { quote: _raw, ...publicSummary } = summary;
  return { ...publicSummary, transaction };
}

export async function prepareSolanaTransfer(input: {
  network: SolanaNetworkKey;
  owner: string;
  recipient: string;
  asset: string;
  amount: string;
}): Promise<{ token: SolanaTokenInfo; amount: string; formatted: string; prepared: PreparedSolanaTransaction }> {
  const token = await requireSolanaToken(input.network, input.asset);
  const amount = baseUnits(input.amount, token.decimals);
  const prepared = await buildSolanaTransfer({
    network: input.network,
    from: input.owner,
    to: input.recipient,
    mint: token.symbol === "SOL" && token.canonical ? "SOL" : token.mint,
    amount,
    decimals: token.decimals,
  });
  return { token, amount, formatted: fromBaseUnits(amount, token.decimals), prepared };
}
