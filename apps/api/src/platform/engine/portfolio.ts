/**
 * Portfolios of CAIP-10 accounts.
 *
 * - `GET /v1/portfolio/{accountId}`: `readAccountPortfolio`. Solana uses the
 *   Solana module (SPL + Token-2022, Jupiter prices). EVM reads the native
 *   balance plus every canonical asset on that network (one Multicall3 read
 *   where it is deployed, per-token reads otherwise).
 * - `GET /v1/portfolio?accounts=`: `readAccountPortfolios`, up to 12
 *   accounts in request order, duplicates removed, 4 reads at a time, 8 s
 *   per account, a 15 s cache per account; a failing account becomes a
 *   `failures` entry and never fails the request.
 *
 * Every holding carries `priceSource` and `pricedAt` (journey design 6.7):
 * USD stablecoins at par, gas assets and other listed tokens through the
 * preview pricer (advisory, the source of fee estimates), Solana tokens
 * through Jupiter. Testnet assets other than stablecoins stay unpriced
 * (`usd: null`, source `testnet`); unknown is never shown as $0.
 * `positions: true` adds the account's venue positions (aTokens, Comet
 * balances, vault shares, mTokens, jlTokens) read through the adapters.
 */
import { erc20Abi, getAddress } from "viem";
import {
  assetsForNetwork,
  CHAINS,
  formatAssetId,
  fromBaseUnits,
  nativeAssetId,
  parseAccountId,
  type AccountId,
  type AssetId,
  type JourneyValueSource,
  type NetworkKey,
  type VenuePosition,
} from "@kletia/core";
import { isSolanaNetworkKey, readSolanaPortfolio, type SolanaNetworkKey } from "../../networks/solana/index.js";
import { PlatformError, toPlatformError } from "../errors.js";
import { isUsdStablecoin } from "./assets.js";
import { evmClient, isEvmNetwork } from "./chains/evm.js";
import { readVenuePositions, type VenuePositionsResult } from "./journey/positions.js";
import { quoteAsset } from "./preview/pricer.js";

export interface PortfolioHolding {
  readonly asset: AssetId;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly amount: string;
  readonly formatted: string;
  /** Advisory USD value; null when unpriced (never 0 for unknown). */
  readonly usd: number | null;
  readonly verified: boolean;
  readonly isNative: boolean;
  /** Where `usd` comes from (`unpriced` when it is null for lack of a price, `testnet` for testnet assets). */
  readonly priceSource: JourneyValueSource;
  /** ISO time of the price reading; null when unpriced. */
  readonly pricedAt: string | null;
}

/** A venue that could not be read (RPC trouble, no position reader yet, Kamino obligations). */
export interface PositionUnavailable {
  readonly venue: string;
  readonly code: string;
  readonly message: string;
}

export interface AccountPortfolio {
  readonly account: AccountId;
  readonly network: NetworkKey;
  readonly holdings: readonly PortfolioHolding[];
  /** Sum of the priced holdings (positions are not included). */
  readonly totalUsd: number;
  readonly unpricedCount: number;
  readonly observedAt: string;
  /** With `positions: true`: venue positions of the account on its network. */
  readonly positions?: readonly VenuePosition[];
  /** With `positions: true`: venues whose position could not be read (unknown, not empty). */
  readonly positionsUnavailable?: readonly PositionUnavailable[];
}

export interface PortfolioOptions {
  /** Also read venue positions (more RPC reads; journey design 6.7). */
  readonly positions?: boolean;
}

/** A holding as a chain reader returns it, before pricing. `usd` is a price the reader already has (Jupiter, par). */
export type RawHolding = Omit<PortfolioHolding, "priceSource" | "pricedAt"> & { readonly priceSource?: JourneyValueSource };

/** The raw reads, replaceable in tests (`configurePortfolioReaders`). Read-only. */
export interface PortfolioReaders {
  holdings(account: AccountId, network: NetworkKey, address: string): Promise<RawHolding[]>;
  positions(account: AccountId, network: NetworkKey): Promise<VenuePositionsResult>;
}

/* ------------------------------------------------------------------ reads */

function erc20Holding(network: NetworkKey, asset: ReturnType<typeof assetsForNetwork>[number], balance: bigint): RawHolding {
  const formatted = fromBaseUnits(balance, asset.decimals);
  const stable = isUsdStablecoin({ symbol: asset.symbol, canonical: true, category: asset.category });
  return {
    asset: formatAssetId(network, "erc20", asset.address as string),
    symbol: asset.symbol,
    name: asset.name,
    decimals: asset.decimals,
    amount: balance.toString(),
    formatted,
    usd: stable ? Number(formatted) : null,
    ...(stable ? { priceSource: "usd-par" as const } : {}),
    verified: true,
    isNative: false,
  };
}

/** ERC-20 balances: one Multicall3 read where it is deployed, per-token reads otherwise (a failed token is skipped). */
async function readErc20Balances(network: NetworkKey, account: `0x${string}`, tokens: readonly ReturnType<typeof assetsForNetwork>[number][]): Promise<(bigint | null)[]> {
  if (!isEvmNetwork(network) || tokens.length === 0) return [];
  const client = evmClient(network);
  const contracts = tokens.map((asset) => ({ address: getAddress(asset.address as string), abi: erc20Abi, functionName: "balanceOf" as const, args: [account] as const }));
  if (client.chain?.contracts?.multicall3) {
    try {
      const results = await client.multicall({ contracts, allowFailure: true });
      return results.map((result) => (result.status === "success" && typeof result.result === "bigint" ? result.result : null));
    } catch {
      // Fall through to per-token reads.
    }
  }
  const settled = await Promise.allSettled(contracts.map((contract) => client.readContract(contract)));
  return settled.map((result) => (result.status === "fulfilled" && typeof result.value === "bigint" ? result.value : null));
}

async function readEvmHoldings(network: NetworkKey, owner: string): Promise<RawHolding[]> {
  if (!isEvmNetwork(network)) throw new PlatformError("NETWORK_UNSUPPORTED", "Not an EVM network.", 422);
  const client = evmClient(network);
  const account = getAddress(owner);
  const chain = CHAINS[network];
  const tokens = assetsForNetwork(network).filter((asset) => asset.address !== null);
  const [native, balances] = await Promise.all([client.getBalance({ address: account }), readErc20Balances(network, account, tokens)]);
  const holdings: RawHolding[] = [];
  // Arc's gas asset is USDC exposed through its ERC-20 interface, so it is listed once (as the token).
  if (assetsForNetwork(network).some((asset) => asset.address === null)) {
    holdings.push({
      asset: nativeAssetId(chain),
      symbol: chain.nativeAsset.symbol,
      name: chain.nativeAsset.name,
      decimals: chain.nativeAsset.decimals,
      amount: native.toString(),
      formatted: fromBaseUnits(native, chain.nativeAsset.decimals),
      usd: null,
      verified: true,
      isNative: true,
    });
  }
  tokens.forEach((asset, index) => {
    const balance = balances[index];
    if (balance === null || balance === undefined || balance === 0n) return;
    holdings.push(erc20Holding(network, asset, balance));
  });
  return holdings;
}

async function readSolanaHoldings(network: SolanaNetworkKey, address: string): Promise<RawHolding[]> {
  const chain = CHAINS[network];
  const portfolio = await readSolanaPortfolio(network, address);
  return portfolio.holdings.map((holding) => ({
    asset: holding.isNative ? nativeAssetId(chain) : formatAssetId(chain, "token", holding.mint),
    symbol: holding.symbol,
    name: holding.name,
    decimals: holding.decimals,
    amount: holding.amount,
    formatted: holding.formatted,
    usd: holding.usdValue,
    ...(holding.usdValue !== null ? { priceSource: "jupiter" as const } : {}),
    verified: holding.verified,
    isNative: holding.isNative,
  }));
}

const DEFAULT_READERS: PortfolioReaders = {
  holdings: (_account, network, address) => (isSolanaNetworkKey(network) ? readSolanaHoldings(network, address) : readEvmHoldings(network, address)),
  positions: (account, network) => readVenuePositions(account, network),
};

let readers: PortfolioReaders = DEFAULT_READERS;

/** Replaces the raw readers (tests); `null` restores the RPC readers. Clears the batch cache. */
export function configurePortfolioReaders(next: Partial<PortfolioReaders> | null): void {
  readers = next === null ? DEFAULT_READERS : { ...DEFAULT_READERS, ...next };
  resetPortfolioCache();
}

/* ---------------------------------------------------------------- pricing */

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Prices one holding the reader left unpriced (gas assets, listed tokens) through the preview pricer. */
async function priceHolding(holding: RawHolding, network: NetworkKey, observedAt: string): Promise<PortfolioHolding> {
  const { priceSource, ...rest } = holding;
  if (holding.usd !== null) return { ...rest, priceSource: priceSource ?? "usd-par", pricedAt: observedAt };
  const testnet = CHAINS[network].environment === "testnet";
  if (holding.amount === "0") return { ...rest, priceSource: testnet ? "testnet" : "unpriced", pricedAt: null };
  if (testnet) return { ...rest, priceSource: "testnet", pricedAt: null };
  const quote = await quoteAsset(holding.asset);
  if (!quote || quote.source === "testnet" || quote.source === "unpriced" || !Number.isFinite(quote.usd)) {
    return { ...rest, priceSource: "unpriced", pricedAt: null };
  }
  return { ...rest, usd: round2(Number(holding.formatted) * quote.usd), priceSource: quote.source, pricedAt: quote.at };
}

/* ------------------------------------------------------------ one account */

/** Balances (and, with `positions`, venue positions) of one CAIP-10 account. */
export async function readAccountPortfolio(accountId: string, options: PortfolioOptions = {}): Promise<AccountPortfolio> {
  try {
    const parsed = parseAccountId(accountId);
    if (!parsed) throw new PlatformError("ACCOUNT_INVALID", "accountId must be a CAIP-10 account (e.g. eip155:8453:0x…).", 400);
    const network = parsed.chain.key;
    const [raw, positions] = await Promise.all([
      readers.holdings(parsed.id, network, parsed.address),
      options.positions ? readers.positions(parsed.id, network) : Promise.resolve(null),
    ]);
    const observedAt = new Date().toISOString();
    const holdings = await Promise.all(raw.map((holding) => priceHolding(holding, network, observedAt)));
    holdings.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
    return {
      account: parsed.id,
      network,
      holdings,
      totalUsd: round2(holdings.reduce((total, holding) => total + (holding.usd ?? 0), 0)),
      unpricedCount: holdings.filter((holding) => holding.usd === null && holding.amount !== "0").length,
      observedAt,
      ...(positions ? { positions: positions.positions, positionsUnavailable: positions.unavailable } : {}),
    };
  } catch (error) {
    throw toPlatformError(error);
  }
}

/* ---------------------------------------------------------------- batched */

/** Batch limits (console design 4.2). */
export const PORTFOLIO_BATCH_LIMITS = Object.freeze({
  maxAccounts: 12,
  concurrency: 4,
  perAccountTimeoutMs: 8_000,
  cacheTtlMs: 15_000,
  cacheEntries: 2_000,
});

export interface PortfolioFailure {
  readonly account: string;
  readonly code: string;
  readonly message: string;
}

export interface AccountPortfolios {
  /** Successful reads, in request order (duplicates removed). */
  readonly portfolios: readonly AccountPortfolio[];
  readonly failures: readonly PortfolioFailure[];
  readonly observedAt: string;
}

const cache = new Map<string, { readonly portfolio: AccountPortfolio; readonly at: number }>();

/** Forgets cached batch reads (tests). */
export function resetPortfolioCache(): void {
  cache.clear();
}

function withTimeout<T>(read: Promise<T>, ms: number): Promise<T> {
  read.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    read,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PlatformError("RPC_TIMEOUT", `The account was not read within ${ms / 1000} s.`, 504)), ms);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function cachedPortfolio(account: AccountId, options: PortfolioOptions): Promise<AccountPortfolio> {
  const key = `${account}|${options.positions ? "positions" : "balances"}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < PORTFOLIO_BATCH_LIMITS.cacheTtlMs) return hit.portfolio;
  const portfolio = await withTimeout(readAccountPortfolio(account, options), PORTFOLIO_BATCH_LIMITS.perAccountTimeoutMs);
  cache.delete(key);
  cache.set(key, { portfolio, at: Date.now() });
  while (cache.size > PORTFOLIO_BATCH_LIMITS.cacheEntries) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return portfolio;
}

/**
 * Accounts of a batch request, validated: at least one, at most 12 after
 * removing duplicates (same chain and address; EVM ignoring case), each a
 * CAIP-10 account.
 * Throws INVALID_REQUEST with the issue path `accounts[i]`.
 */
export function parsePortfolioAccounts(values: readonly string[]): AccountId[] {
  if (values.length === 0) {
    throw new PlatformError("INVALID_REQUEST", "accounts is required: comma-separated CAIP-10 accounts.", 400, [{ path: "accounts", message: "Required." }]);
  }
  const out: AccountId[] = [];
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const parsed = parseAccountId(value.trim());
    if (!parsed) {
      throw new PlatformError("INVALID_REQUEST", `accounts[${index}] is not a CAIP-10 account (e.g. eip155:8453:0x… or solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:<address>).`, 400, [
        { path: `accounts[${index}]`, message: "Invalid CAIP-10 account id." },
      ]);
    }
    // EVM addresses are case-insensitive (checksummed or not): the first spelling is kept.
    const key = parsed.chain.namespace === "eip155" ? parsed.id.toLowerCase() : parsed.id;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(parsed.id);
  });
  if (out.length > PORTFOLIO_BATCH_LIMITS.maxAccounts) {
    throw new PlatformError("INVALID_REQUEST", `At most ${PORTFOLIO_BATCH_LIMITS.maxAccounts} accounts per request.`, 400, [
      { path: "accounts", message: `More than ${PORTFOLIO_BATCH_LIMITS.maxAccounts} accounts.` },
    ]);
  }
  return out;
}

/**
 * Portfolios of several accounts (validated with `parsePortfolioAccounts`):
 * 4 reads at a time, 8 s each, 15 s cache per account. A failed read is a
 * `failures` entry with the Platform API error code; never throws for one.
 */
export async function readAccountPortfolios(accounts: readonly AccountId[], options: PortfolioOptions = {}): Promise<AccountPortfolios> {
  const results: ({ ok: true; portfolio: AccountPortfolio } | { ok: false; failure: PortfolioFailure })[] = new Array(accounts.length);
  let next = 0;
  const worker = async () => {
    while (next < accounts.length) {
      const index = next;
      next += 1;
      const account = accounts[index] as AccountId;
      try {
        results[index] = { ok: true, portfolio: await cachedPortfolio(account, options) };
      } catch (error) {
        const failure = toPlatformError(error);
        results[index] = { ok: false, failure: { account, code: failure.code, message: failure.message } };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PORTFOLIO_BATCH_LIMITS.concurrency, accounts.length) }, worker));
  return {
    portfolios: results.flatMap((result) => (result.ok ? [result.portfolio] : [])),
    failures: results.flatMap((result) => (result.ok ? [] : [result.failure])),
    observedAt: new Date().toISOString(),
  };
}
