/** Venue-pinned Jupiter transport. The platform adapter validates every instruction. */
import { isBaseUnitAmount, isSolanaAddress } from "@kletia/core";
import { JUPITER_API_KEY, JUPITER_API_URL } from "./config.js";
import { fetchProviderJson, isRecord, SolanaProviderError } from "./http.js";
import { normalizeSlippageBps, type JupiterQuoteRequest } from "./jupiter.js";
import type { ExternalSolanaInstruction } from "./transactions.js";

export type SolanaDex = "raydium" | "orca";
export const SOLANA_DEX_LABELS: Readonly<Record<SolanaDex, readonly string[]>> = Object.freeze({
  raydium: ["Raydium CLMM", "Raydium CP"],
  orca: ["Whirlpool"],
});

export interface SolanaDexQuote {
  readonly dex: SolanaDex;
  readonly label: string;
  readonly pool: string;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly inAmount: string;
  readonly outAmount: string;
  /** Conservative integer floor enforced by the encoded Jupiter instruction. */
  readonly minimumOutAmount: string;
  readonly slippageBps: number;
  readonly priceImpactPct: number;
  readonly raw: Record<string, unknown>;
}

function rejected(message: string): never {
  throw new SolanaProviderError(message, "DEX_QUOTE_MISMATCH");
}

export function swapMinimum(outAmount: bigint, slippageBps: number): bigint {
  return outAmount * BigInt(10_000 - slippageBps) / 10_000n;
}

/** Reject split, multi-hop, foreign-venue, exact-out and under-protected quotes. */
export function parseSolanaDexQuote(body: unknown, dex: SolanaDex, request: JupiterQuoteRequest): SolanaDexQuote {
  const slippageBps = normalizeSlippageBps(request.slippageBps);
  if (!isRecord(body) || body.inputMint !== request.inputMint || body.outputMint !== request.outputMint ||
      body.inAmount !== request.amount || body.swapMode !== "ExactIn" || body.slippageBps !== slippageBps ||
      !isBaseUnitAmount(body.outAmount) || !isBaseUnitAmount(body.otherAmountThreshold) ||
      !Array.isArray(body.routePlan) || body.routePlan.length !== 1 ||
      (body.instructionVersion !== undefined && body.instructionVersion !== "V1") ||
      (body.transactionVersion !== undefined && body.transactionVersion !== 0)) {
    rejected("The direct DEX quote does not match the requested swap.");
  }
  if (body.platformFee !== null && body.platformFee !== undefined) rejected("Direct DEX swaps do not allow platform fees.");
  const leg: unknown = body.routePlan[0];
  if (!isRecord(leg) || !isRecord(leg.swapInfo) || leg.percent !== 100 ||
      (leg.bps !== null && leg.bps !== undefined && leg.bps !== 10_000)) rejected("The DEX quote is not a single direct route.");
  const info = leg.swapInfo;
  if (typeof info.label !== "string" || !SOLANA_DEX_LABELS[dex].includes(info.label) ||
      typeof info.ammKey !== "string" || !isSolanaAddress(info.ammKey) || info.inputMint !== request.inputMint || info.outputMint !== request.outputMint ||
      info.inAmount !== request.amount || info.outAmount !== body.outAmount) rejected("The quote routes through another venue or asset.");
  const out = BigInt(body.outAmount);
  if (out > (1n << 64n) - 1n) rejected("The DEX quote output exceeds the on-chain u64 amount bound.");
  const minimum = swapMinimum(out, slippageBps);
  const threshold = BigInt(body.otherAmountThreshold);
  // Jupiter's HTTP quote rounds up; the on-chain calculation may round down by one.
  if (minimum <= 0n || threshold < minimum || threshold > minimum + 1n || threshold > out) rejected("The quote has an invalid slippage floor.");
  const impact = typeof body.priceImpactPct === "string" || typeof body.priceImpactPct === "number" ? Number(body.priceImpactPct) : NaN;
  if (!Number.isFinite(impact) || impact < 0) rejected("The DEX quote has no valid price-impact measurement.");
  return { dex, label: info.label, pool: info.ammKey, inputMint: request.inputMint, outputMint: request.outputMint,
    inAmount: request.amount, outAmount: body.outAmount, minimumOutAmount: minimum.toString(), slippageBps, priceImpactPct: impact, raw: body };
}

function headers(): Record<string, string> { return JUPITER_API_KEY ? { "x-api-key": JUPITER_API_KEY } : {}; }

export async function quoteSolanaDexSwap(dex: SolanaDex, request: JupiterQuoteRequest): Promise<SolanaDexQuote> {
  if (!isSolanaAddress(request.inputMint) || !isSolanaAddress(request.outputMint) || request.inputMint === request.outputMint ||
      !isBaseUnitAmount(request.amount) || request.amount === "0" || BigInt(request.amount) > (1n << 64n) - 1n) {
    throw new SolanaProviderError("A direct DEX swap needs two distinct mints and a positive u64 input amount.", "SOLANA_SWAP_INVALID", 422);
  }
  const params = new URLSearchParams({ inputMint: request.inputMint, outputMint: request.outputMint, amount: request.amount,
    slippageBps: String(normalizeSlippageBps(request.slippageBps)), swapMode: "ExactIn", onlyDirectRoutes: "true",
    restrictIntermediateTokens: "true", dexes: SOLANA_DEX_LABELS[dex].join(","), instructionVersion: "V1" });
  const body = await fetchProviderJson<unknown>(`${JUPITER_API_URL}/swap/v1/quote?${params}`, { provider: "Jupiter", headers: headers() });
  return parseSolanaDexQuote(body, dex, request);
}

export interface SolanaDexInstructions {
  readonly instructions: readonly ExternalSolanaInstruction[];
  readonly lookupTables: readonly string[];
}

function instruction(raw: unknown): ExternalSolanaInstruction {
  if (!isRecord(raw) || typeof raw.programId !== "string" || !isSolanaAddress(raw.programId) || !Array.isArray(raw.accounts) || raw.accounts.length > 64 ||
      typeof raw.data !== "string" || raw.data.length > 2048 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(raw.data)) {
    throw new SolanaProviderError("The DEX provider returned a malformed instruction.", "DEX_INSTRUCTION_INVALID");
  }
  const keys = raw.accounts.map((key: unknown) => {
    if (!isRecord(key) || typeof key.pubkey !== "string" || !isSolanaAddress(key.pubkey) || typeof key.isSigner !== "boolean" || typeof key.isWritable !== "boolean") {
      throw new SolanaProviderError("The DEX provider returned invalid instruction accounts.", "DEX_INSTRUCTION_INVALID");
    }
    return { pubkey: key.pubkey, isSigner: key.isSigner, isWritable: key.isWritable };
  });
  return { programId: raw.programId, keys, data: Buffer.from(raw.data, "base64").toString("hex") };
}

export function parseSolanaDexInstructions(body: unknown): SolanaDexInstructions {
  if (!isRecord(body) || body.tokenLedgerInstruction != null || body.simulationError != null ||
      (body.transactionVersion !== undefined && body.transactionVersion !== 0) || !Array.isArray(body.computeBudgetInstructions) ||
      !Array.isArray(body.setupInstructions) || !Array.isArray(body.otherInstructions) || body.otherInstructions.length !== 0 ||
      !Array.isArray(body.addressLookupTableAddresses) || body.addressLookupTableAddresses.length > 4 ||
      !body.addressLookupTableAddresses.every(isSolanaAddress)) {
    throw new SolanaProviderError("The DEX provider returned an unsupported instruction bundle.", "DEX_INSTRUCTION_INVALID");
  }
  const all = [...body.computeBudgetInstructions, ...body.setupInstructions, body.swapInstruction,
    ...(body.cleanupInstruction == null ? [] : [body.cleanupInstruction])];
  if (all.length > 16) throw new SolanaProviderError("The DEX provider returned too many instructions.", "DEX_INSTRUCTION_INVALID");
  return { instructions: all.map(instruction), lookupTables: body.addressLookupTableAddresses as string[] };
}

export async function fetchSolanaDexInstructions(quote: SolanaDexQuote, owner: string): Promise<SolanaDexInstructions> {
  const body = await fetchProviderJson<unknown>(`${JUPITER_API_URL}/swap/v1/swap-instructions`, { provider: "Jupiter", method: "POST",
    headers: { "content-type": "application/json", ...headers() }, body: JSON.stringify({ userPublicKey: owner,
      quoteResponse: quote.raw, wrapAndUnwrapSol: true, useSharedAccounts: false, dynamicComputeUnitLimit: false,
      dynamicSlippage: false, prioritizationFeeLamports: 0 }) });
  return parseSolanaDexInstructions(body);
}
