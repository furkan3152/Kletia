import { isBaseUnitAmount, isSolanaAddress } from "@kletia/core";
import {
  JUPITER_API_KEY,
  JUPITER_API_URL,
  SOLANA_DEFAULT_SLIPPAGE_BPS,
  SOLANA_MAX_SLIPPAGE_BPS,
} from "./config.js";
import { SolanaProviderError, fetchProviderJson, isRecord } from "./http.js";

export interface JupiterQuoteRequest {
  readonly inputMint: string;
  readonly outputMint: string;
  /** Base units of the input mint (ExactIn). */
  readonly amount: string;
  readonly slippageBps?: number;
  readonly restrictIntermediateTokens?: boolean;
}

export interface JupiterRouteLeg {
  readonly label: string;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly percent: number;
}

export interface JupiterQuote {
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inAmount: string;
  readonly outAmount: string;
  readonly minimumOutAmount: string;
  readonly slippageBps: number;
  readonly priceImpactPct: number;
  readonly route: readonly JupiterRouteLeg[];
  readonly contextSlot: string | null;
  /** Untouched provider payload, required verbatim by the swap endpoint. */
  readonly raw: Record<string, unknown>;
}

function headers(): Record<string, string> {
  return JUPITER_API_KEY ? { "x-api-key": JUPITER_API_KEY } : {};
}

export function normalizeSlippageBps(value: number | undefined): number {
  if (value === undefined) return SOLANA_DEFAULT_SLIPPAGE_BPS;
  if (!Number.isInteger(value) || value < 1 || value > SOLANA_MAX_SLIPPAGE_BPS) {
    throw new SolanaProviderError(
      `Slippage must be between 1 and ${SOLANA_MAX_SLIPPAGE_BPS} basis points.`,
      "SOLANA_SLIPPAGE_OUT_OF_RANGE",
      400,
    );
  }
  return value;
}

export function parseJupiterQuote(body: unknown, request: JupiterQuoteRequest): JupiterQuote {
  if (!isRecord(body)) throw new SolanaProviderError("Jupiter returned no quote.", "JUPITER_QUOTE_INVALID");
  const { inputMint, outputMint, inAmount, outAmount, otherAmountThreshold, slippageBps, routePlan } = body;
  if (
    inputMint !== request.inputMint ||
    outputMint !== request.outputMint ||
    inAmount !== request.amount ||
    !isBaseUnitAmount(outAmount) ||
    !isBaseUnitAmount(otherAmountThreshold) ||
    typeof slippageBps !== "number" ||
    !Array.isArray(routePlan) ||
    routePlan.length === 0
  ) {
    throw new SolanaProviderError("Jupiter quote did not match the request.", "JUPITER_QUOTE_MISMATCH");
  }
  if (BigInt(otherAmountThreshold) > BigInt(outAmount) || outAmount === "0") {
    throw new SolanaProviderError("Jupiter quote has an invalid output floor.", "JUPITER_QUOTE_MISMATCH");
  }
  const route = routePlan.flatMap((leg): JupiterRouteLeg[] => {
    if (!isRecord(leg) || !isRecord(leg.swapInfo)) return [];
    const info = leg.swapInfo;
    return [
      {
        label: typeof info.label === "string" ? info.label.slice(0, 48) : "Unknown venue",
        inputMint: typeof info.inputMint === "string" ? info.inputMint : "",
        outputMint: typeof info.outputMint === "string" ? info.outputMint : "",
        percent: typeof leg.percent === "number" ? leg.percent : 100,
      },
    ];
  });
  const impact = Number(body.priceImpactPct ?? 0);
  return {
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    inAmount: request.amount,
    outAmount,
    minimumOutAmount: otherAmountThreshold,
    slippageBps,
    priceImpactPct: Number.isFinite(impact) ? impact : 0,
    route,
    contextSlot: typeof body.contextSlot === "number" ? String(body.contextSlot) : null,
    raw: body,
  };
}

export async function quoteJupiterSwap(request: JupiterQuoteRequest): Promise<JupiterQuote> {
  if (!isSolanaAddress(request.inputMint) || !isSolanaAddress(request.outputMint)) {
    throw new SolanaProviderError("Swap mints must be Solana addresses.", "SOLANA_MINT_INVALID", 400);
  }
  if (request.inputMint === request.outputMint) {
    throw new SolanaProviderError("Input and output tokens must differ.", "SOLANA_SWAP_SAME_TOKEN", 400);
  }
  if (!isBaseUnitAmount(request.amount) || request.amount === "0") {
    throw new SolanaProviderError("Swap amount must be a positive integer of base units.", "SOLANA_AMOUNT_INVALID", 400);
  }
  const slippageBps = normalizeSlippageBps(request.slippageBps);
  const params = new URLSearchParams({
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    amount: request.amount,
    slippageBps: String(slippageBps),
    swapMode: "ExactIn",
    restrictIntermediateTokens: String(request.restrictIntermediateTokens ?? true),
  });
  const body = await fetchProviderJson<unknown>(`${JUPITER_API_URL}/swap/v1/quote?${params}`, {
    provider: "Jupiter",
    headers: headers(),
  });
  return parseJupiterQuote(body, request);
}

export interface JupiterSwapTransaction {
  readonly transaction: string;
  readonly lastValidBlockHeight: number;
  readonly prioritizationFeeLamports: number;
  readonly computeUnitLimit: number | null;
}

/** Ask Jupiter for an unsigned versioned transaction for a quote. */
export async function buildJupiterSwapTransaction(
  quote: JupiterQuote,
  userPublicKey: string,
): Promise<JupiterSwapTransaction> {
  if (!isSolanaAddress(userPublicKey)) {
    throw new SolanaProviderError("A valid Solana wallet is required.", "SOLANA_ADDRESS_INVALID", 400);
  }
  const body = await fetchProviderJson<unknown>(`${JUPITER_API_URL}/swap/v1/swap`, {
    provider: "Jupiter",
    method: "POST",
    headers: { "content-type": "application/json", ...headers() },
    body: JSON.stringify({
      userPublicKey,
      quoteResponse: quote.raw,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: { maxLamports: 2_000_000, priorityLevel: "high" },
      },
    }),
  });
  if (!isRecord(body) || typeof body.swapTransaction !== "string" || !/^[A-Za-z0-9+/]+=*$/u.test(body.swapTransaction)) {
    throw new SolanaProviderError("Jupiter did not return a transaction.", "JUPITER_SWAP_INVALID");
  }
  if (body.simulationError !== null && body.simulationError !== undefined) {
    const detail = isRecord(body.simulationError) && typeof body.simulationError.error === "string"
      ? body.simulationError.error
      : "simulation failed";
    throw new SolanaProviderError(`Jupiter simulation rejected the swap: ${detail.slice(0, 160)}`, "JUPITER_SIMULATION_FAILED", 422);
  }
  const lastValidBlockHeight = Number(body.lastValidBlockHeight);
  return {
    transaction: body.swapTransaction,
    lastValidBlockHeight: Number.isSafeInteger(lastValidBlockHeight) ? lastValidBlockHeight : 0,
    prioritizationFeeLamports: Number(body.prioritizationFeeLamports ?? 0) || 0,
    computeUnitLimit: typeof body.computeUnitLimit === "number" ? body.computeUnitLimit : null,
  };
}
