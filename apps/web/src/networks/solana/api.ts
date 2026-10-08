/**
 * Typed client for Kletia's Solana endpoints (`/api/solana/*`). Every
 * response is validated before the UI reads it; anything that does not match
 * the contract is treated as an error rather than rendered.
 */
import {
  isBaseUnitAmount,
  isSolanaAddress,
  type NetworkKey,
} from "@kletia/core";

import { BACKEND_URL } from "../../shared/config/runtime";

export type SolanaNetworkKey = Extract<NetworkKey, "solana" | "solana-devnet">;

export class SolanaApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "SolanaApiError";
    this.code = code;
    this.status = status;
  }
}

type Parser<T> = (body: unknown) => T;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const shortText = (value: unknown, max = 64): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

function fail(what: string): never {
  throw new SolanaApiError("INVALID_RESPONSE", `${what} did not match the expected format.`, 0);
}

// ---------------------------------------------------------------------------
// Contract types (mirror apps/api/src/networks/solana)
// ---------------------------------------------------------------------------

export interface SolanaTokenInfo {
  readonly mint: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly verified: boolean;
  readonly tokenProgram: "spl-token" | "token-2022";
  readonly logoURI?: string;
  readonly canonical: boolean;
}

export interface SolanaHolding {
  readonly mint: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly amount: string;
  readonly formatted: string;
  readonly usdPrice: number | null;
  readonly usdValue: number | null;
  readonly change24h: number | null;
  readonly verified: boolean;
  readonly isNative: boolean;
}

export interface SolanaPortfolio {
  readonly network: SolanaNetworkKey;
  readonly owner: string;
  readonly totalUsd: number;
  readonly holdings: readonly SolanaHolding[];
  readonly unpricedCount: number;
  readonly observedAt: string;
  readonly slot: string;
}

export interface SolanaRouteLeg {
  readonly label: string;
  readonly inputMint: string;
  readonly outputMint: string;
  readonly percent: number;
}

export interface SolanaQuote {
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
  readonly route: readonly SolanaRouteLeg[];
  readonly warnings: readonly string[];
}

export interface SolanaPreparedSwap extends SolanaQuote {
  readonly transaction: {
    readonly transaction: string;
    readonly lastValidBlockHeight: number;
    readonly prioritizationFeeLamports: number;
    readonly computeUnitLimit: number | null;
  };
}

export interface SolanaSimulation {
  readonly ok: boolean;
  readonly unitsConsumed: number | null;
  readonly error: string | null;
}

export interface SolanaPreparedTransfer {
  readonly token: SolanaTokenInfo;
  readonly amount: string;
  readonly formatted: string;
  readonly prepared: {
    readonly transaction: string;
    readonly lastValidBlockHeight: number;
    readonly simulation: SolanaSimulation;
  };
}

export interface SolanaYieldReserve {
  readonly reserve: string;
  readonly symbol: string;
  readonly mint: string;
  readonly supplyApy: number;
  readonly borrowApy: number;
  readonly maxLtv: number;
  readonly totalSupplyUsd: number;
  readonly totalBorrowUsd: number;
  readonly utilization: number;
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

const BASE64_PATTERN = /^[A-Za-z0-9+/]+=*$/u;

function parseToken(value: unknown): SolanaTokenInfo {
  if (
    !isRecord(value) ||
    !isSolanaAddress(value.mint) ||
    !shortText(value.symbol, 32) ||
    typeof value.name !== "string" ||
    !Number.isInteger(value.decimals) ||
    (value.decimals as number) < 0 ||
    (value.decimals as number) > 18 ||
    typeof value.verified !== "boolean" ||
    (value.tokenProgram !== "spl-token" && value.tokenProgram !== "token-2022")
  ) {
    fail("Token metadata");
  }
  const logo =
    typeof value.logoURI === "string" && value.logoURI.startsWith("https://")
      ? value.logoURI
      : undefined;
  return {
    mint: value.mint as string,
    symbol: value.symbol,
    name: value.name.slice(0, 64),
    decimals: value.decimals as number,
    verified: value.verified,
    tokenProgram: value.tokenProgram,
    canonical: value.canonical === true,
    ...(logo ? { logoURI: logo } : {}),
  };
}

function nullableNumber(value: unknown): number | null {
  return finite(value) ? value : null;
}

export const parsePortfolio: Parser<SolanaPortfolio> = (body) => {
  if (!isRecord(body) || body.success !== true || !isRecord(body.portfolio)) fail("Portfolio");
  const portfolio = body.portfolio;
  if (
    (portfolio.network !== "solana" && portfolio.network !== "solana-devnet") ||
    !isSolanaAddress(portfolio.owner) ||
    !finite(portfolio.totalUsd) ||
    !Array.isArray(portfolio.holdings)
  ) {
    fail("Portfolio");
  }
  const holdings = portfolio.holdings.slice(0, 250).map((raw): SolanaHolding => {
    if (
      !isRecord(raw) ||
      !isSolanaAddress(raw.mint) ||
      !shortText(raw.symbol, 32) ||
      !Number.isInteger(raw.decimals) ||
      !isBaseUnitAmount(raw.amount) ||
      typeof raw.formatted !== "string"
    ) {
      fail("Portfolio holding");
    }
    return {
      mint: raw.mint as string,
      symbol: raw.symbol,
      name: typeof raw.name === "string" ? raw.name.slice(0, 64) : raw.symbol,
      decimals: raw.decimals as number,
      amount: raw.amount as string,
      formatted: raw.formatted,
      usdPrice: nullableNumber(raw.usdPrice),
      usdValue: nullableNumber(raw.usdValue),
      change24h: nullableNumber(raw.change24h),
      verified: raw.verified === true,
      isNative: raw.isNative === true,
    };
  });
  return {
    network: portfolio.network,
    owner: portfolio.owner as string,
    totalUsd: portfolio.totalUsd,
    holdings,
    unpricedCount: finite(portfolio.unpricedCount) ? portfolio.unpricedCount : 0,
    observedAt: typeof portfolio.observedAt === "string" ? portfolio.observedAt : "",
    slot: typeof portfolio.slot === "string" ? portfolio.slot : "",
  };
};

export const parseTokenSearch: Parser<SolanaTokenInfo[]> = (body) => {
  if (!isRecord(body) || body.success !== true || !Array.isArray(body.tokens)) fail("Token search");
  return body.tokens.slice(0, 20).flatMap((token) => {
    try {
      return [parseToken(token)];
    } catch {
      return [];
    }
  });
};

function parseQuoteFields(value: unknown): SolanaQuote {
  if (!isRecord(value) || !isRecord(value.input) || !isRecord(value.output)) fail("Quote");
  const { input, output } = value;
  if (
    !isBaseUnitAmount(input.amount) ||
    typeof input.formatted !== "string" ||
    !isBaseUnitAmount(output.amount) ||
    typeof output.formatted !== "string" ||
    !isBaseUnitAmount(output.minimum) ||
    typeof output.minimumFormatted !== "string" ||
    BigInt(output.minimum as string) > BigInt(output.amount as string) ||
    !Number.isInteger(value.slippageBps) ||
    !finite(value.priceImpactPct) ||
    !Array.isArray(value.route)
  ) {
    fail("Quote");
  }
  const route = value.route.slice(0, 12).map((leg): SolanaRouteLeg => {
    if (!isRecord(leg) || typeof leg.label !== "string") fail("Quote route");
    return {
      label: leg.label.slice(0, 48),
      inputMint: typeof leg.inputMint === "string" ? leg.inputMint : "",
      outputMint: typeof leg.outputMint === "string" ? leg.outputMint : "",
      percent: finite(leg.percent) ? leg.percent : 100,
    };
  });
  const warnings = Array.isArray(value.warnings)
    ? value.warnings.filter((warning): warning is string => typeof warning === "string").slice(0, 6)
    : [];
  return {
    input: {
      token: parseToken(input.token),
      amount: input.amount as string,
      formatted: input.formatted,
    },
    output: {
      token: parseToken(output.token),
      amount: output.amount as string,
      formatted: output.formatted,
      minimum: output.minimum as string,
      minimumFormatted: output.minimumFormatted,
    },
    slippageBps: value.slippageBps as number,
    priceImpactPct: value.priceImpactPct,
    route,
    warnings,
  };
}

export const parseQuote: Parser<SolanaQuote> = (body) => {
  if (!isRecord(body) || body.success !== true) fail("Quote");
  return parseQuoteFields(body.quote);
};

export const parsePreparedSwap: Parser<SolanaPreparedSwap> = (body) => {
  if (!isRecord(body) || body.success !== true || !isRecord(body.swap)) fail("Prepared swap");
  const quote = parseQuoteFields(body.swap);
  const transaction = body.swap.transaction;
  if (
    !isRecord(transaction) ||
    typeof transaction.transaction !== "string" ||
    transaction.transaction.length > 4_000 ||
    !BASE64_PATTERN.test(transaction.transaction) ||
    !Number.isSafeInteger(transaction.lastValidBlockHeight)
  ) {
    fail("Prepared swap transaction");
  }
  return {
    ...quote,
    transaction: {
      transaction: transaction.transaction,
      lastValidBlockHeight: transaction.lastValidBlockHeight as number,
      prioritizationFeeLamports: finite(transaction.prioritizationFeeLamports)
        ? transaction.prioritizationFeeLamports
        : 0,
      computeUnitLimit: finite(transaction.computeUnitLimit) ? transaction.computeUnitLimit : null,
    },
  };
};

export const parsePreparedTransfer: Parser<SolanaPreparedTransfer> = (body) => {
  if (!isRecord(body) || body.success !== true || !isRecord(body.transfer)) fail("Prepared transfer");
  const transfer = body.transfer;
  const prepared = transfer.prepared;
  if (
    !isBaseUnitAmount(transfer.amount) ||
    typeof transfer.formatted !== "string" ||
    !isRecord(prepared) ||
    typeof prepared.transaction !== "string" ||
    prepared.transaction.length > 4_000 ||
    !BASE64_PATTERN.test(prepared.transaction) ||
    !Number.isSafeInteger(prepared.lastValidBlockHeight) ||
    !isRecord(prepared.simulation) ||
    typeof prepared.simulation.ok !== "boolean"
  ) {
    fail("Prepared transfer");
  }
  const simulation = prepared.simulation;
  return {
    token: parseToken(transfer.token),
    amount: transfer.amount as string,
    formatted: transfer.formatted,
    prepared: {
      transaction: prepared.transaction,
      lastValidBlockHeight: prepared.lastValidBlockHeight as number,
      simulation: {
        ok: simulation.ok as boolean,
        unitsConsumed: nullableNumber(simulation.unitsConsumed),
        error: typeof simulation.error === "string" ? simulation.error.slice(0, 200) : null,
      },
    },
  };
};

export const parseYields: Parser<SolanaYieldReserve[]> = (body) => {
  if (!isRecord(body) || body.success !== true || !Array.isArray(body.reserves)) fail("Yields");
  return body.reserves.slice(0, 100).flatMap((raw): SolanaYieldReserve[] => {
    if (
      !isRecord(raw) ||
      typeof raw.reserve !== "string" ||
      !shortText(raw.symbol, 32) ||
      typeof raw.mint !== "string" ||
      !finite(raw.supplyApy) ||
      !finite(raw.borrowApy) ||
      !finite(raw.totalSupplyUsd) ||
      !finite(raw.totalBorrowUsd) ||
      !finite(raw.utilization)
    ) {
      return [];
    }
    return [
      {
        reserve: raw.reserve,
        symbol: raw.symbol,
        mint: raw.mint,
        supplyApy: raw.supplyApy,
        borrowApy: raw.borrowApy,
        maxLtv: finite(raw.maxLtv) ? raw.maxLtv : 0,
        totalSupplyUsd: raw.totalSupplyUsd,
        totalBorrowUsd: raw.totalBorrowUsd,
        utilization: raw.utilization,
      },
    ];
  });
};

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface SolanaRequestOptions {
  readonly method?: "GET" | "POST";
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/** Fetch `/api/solana{path}` with a timeout and validate the body with `parse`. */
export async function solanaRequest<T>(
  path: string,
  parse: Parser<T>,
  options: SolanaRequestOptions = {},
): Promise<T> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 15_000;
  let timedOut = false;
  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forwardAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  try {
    let response: Response;
    try {
      response = await fetch(`${BACKEND_URL}/api/solana${path}`, {
        method: options.method ?? "GET",
        headers: {
          Accept: "application/json",
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) {
        throw new SolanaApiError("TIMEOUT", "The Solana service did not respond in time.", 0);
      }
      if (options.signal?.aborted) throw error;
      throw new SolanaApiError("NETWORK_ERROR", "The Solana service is unreachable.", 0);
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok || (isRecord(body) && body.success === false)) {
      const code = isRecord(body) && typeof body.code === "string" ? body.code : `HTTP_${response.status}`;
      const message =
        isRecord(body) && typeof body.message === "string"
          ? body.message.slice(0, 240)
          : `The Solana service returned HTTP ${response.status}.`;
      throw new SolanaApiError(code, message, response.status);
    }
    return parse(body);
  } finally {
    window.clearTimeout(timer);
    options.signal?.removeEventListener("abort", forwardAbort);
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export function errorMessage(error: unknown): string {
  if (error instanceof SolanaApiError) return error.message;
  if (error instanceof Error && error.message) return error.message.slice(0, 240);
  return "Something went wrong.";
}

// Endpoint helpers ----------------------------------------------------------

export const solanaPaths = {
  portfolio: (owner: string, network: SolanaNetworkKey) =>
    `/portfolio/${encodeURIComponent(owner)}?network=${network}`,
  tokenSearch: (query: string) => `/tokens/search?q=${encodeURIComponent(query)}`,
  quote: (from: string, to: string, amount: string, slippageBps: number) =>
    `/quote?${new URLSearchParams({ from, to, amount, slippageBps: String(slippageBps) })}`,
  yields: () => "/yields",
};

export function prepareSwap(
  input: { owner: string; from: string; to: string; amount: string; slippageBps: number },
  signal?: AbortSignal,
): Promise<SolanaPreparedSwap> {
  return solanaRequest("/swap/prepare", parsePreparedSwap, {
    method: "POST",
    body: input,
    timeoutMs: 25_000,
    ...(signal ? { signal } : {}),
  });
}

export function prepareTransfer(
  input: {
    network: SolanaNetworkKey;
    owner: string;
    recipient: string;
    asset: string;
    amount: string;
  },
  signal?: AbortSignal,
): Promise<SolanaPreparedTransfer> {
  return solanaRequest("/transfer/prepare", parsePreparedTransfer, {
    method: "POST",
    body: input,
    timeoutMs: 25_000,
    ...(signal ? { signal } : {}),
  });
}
