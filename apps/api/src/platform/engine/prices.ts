/**
 * Advisory USD prices for fee estimates. Prices come from Jupiter's price API
 * (WSOL for SOL, Wormhole-bridged WETH as an ETH proxy) and are cached
 * briefly. A missing price yields null; it never blocks planning. Cache
 * entries keep the time of their reading, so the journey can say where a
 * value comes from and when it was read (`nativeUsdQuote`, `solanaMintUsdQuote`).
 */
import { assetsForNetwork, CHAINS, WRAPPED_SOL_MINT, type NetworkKey } from "@kletia/core";
import { readSolanaPrices } from "../../networks/solana/index.js";

/** Wormhole-bridged WETH on Solana; tracks ETH closely and is priced by Jupiter. */
const ETH_PROXY_MINT = "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs";
const CACHE_TTL_MS = 60_000;

/** A USD price with where it came from and when it was read. */
export interface UsdQuote {
  readonly usd: number;
  readonly source: "usd-par" | "jupiter" | "chainlink" | "testnet";
  /** Unix ms of the reading. */
  readonly at: number;
}

interface CacheEntry {
  readonly value: number | null;
  readonly expiresAt: number;
  /** Unix ms of the reading. */
  readonly at: number;
  readonly source: UsdQuote["source"];
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<CacheEntry>>();

function remember(key: string, value: number | null, source: UsdQuote["source"], at = Date.now()): CacheEntry {
  const entry = { value, expiresAt: Date.now() + (value === null ? 10_000 : CACHE_TTL_MS), at, source };
  cache.set(key, entry);
  return entry;
}

async function mintEntry(mint: string): Promise<CacheEntry> {
  const cached = cache.get(mint);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const pending = inflight.get(mint);
  if (pending) return pending;
  const request = readSolanaPrices([mint])
    .then((prices) => prices.get(mint)?.usd ?? null)
    .catch(() => null)
    .then((value) => {
      inflight.delete(mint);
      return remember(mint, value, "jupiter");
    });
  inflight.set(mint, request);
  return request;
}

async function mintPrice(mint: string): Promise<number | null> {
  return (await mintEntry(mint)).value;
}

function quoteOf(entry: CacheEntry): UsdQuote | null {
  return entry.value === null ? null : { usd: entry.value, source: entry.source, at: entry.at };
}

/**
 * Natives Jupiter cannot price (POL) fall back to the Rule Book's oracle
 * (Chainlink POL / USD on Polygon and Arbitrum), so Polygon fees are known
 * and `limits.maxFeeUsd` does not lock Polygon out (policy design §4.4).
 */
async function oracleNativeEntry(network: NetworkKey): Promise<CacheEntry> {
  const cached = cache.get(`oracle:${network}`);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const native = assetsForNetwork(network).find((asset) => asset.address === null);
  let value: number | null = null;
  let at = Date.now();
  if (native) {
    try {
      const { policyPrice, quoteUsdNumber } = await import("./policy/pricing.js");
      const quote = await policyPrice({ asset: native.id, symbol: native.symbol, decimals: native.decimals, network });
      value = quote ? quoteUsdNumber(quote) : null;
      // The oldest oracle reading the price rests on.
      const observed = quote?.readings.reduce((oldest, reading) => Math.min(oldest, reading.observedAt), Number.MAX_SAFE_INTEGER);
      if (observed !== undefined && observed !== Number.MAX_SAFE_INTEGER) at = observed * 1000;
    } catch {
      value = null;
    }
  }
  return remember(`oracle:${network}`, value, "chainlink", at);
}

async function nativeEntry(network: NetworkKey): Promise<CacheEntry> {
  const chain = CHAINS[network];
  if (chain.nativeAsset.symbol === "USDC") return { value: 1, expiresAt: Number.MAX_SAFE_INTEGER, at: Date.now(), source: "usd-par" };
  if (chain.environment === "testnet") return { value: 0, expiresAt: Number.MAX_SAFE_INTEGER, at: Date.now(), source: "testnet" };
  if (chain.nativeAsset.symbol === "SOL") return mintEntry(WRAPPED_SOL_MINT);
  if (chain.nativeAsset.symbol === "ETH") return mintEntry(ETH_PROXY_MINT);
  return oracleNativeEntry(network);
}

/** USD price of a network's native gas asset (testnets other than Arc price at 0). */
export async function nativeUsdPrice(network: NetworkKey): Promise<number | null> {
  return (await nativeEntry(network)).value;
}

/** The native price with its source and reading time; null when unpriced. */
export async function nativeUsdQuote(network: NetworkKey): Promise<UsdQuote | null> {
  return quoteOf(await nativeEntry(network));
}

export async function solanaMintUsdPrice(mint: string): Promise<number | null> {
  return mintPrice(mint);
}

/** A Solana mint's Jupiter price with its reading time; null when unpriced. */
export async function solanaMintUsdQuote(mint: string): Promise<UsdQuote | null> {
  return quoteOf(await mintEntry(mint));
}

/** Forgets cached prices (tests). */
export function resetPriceCache(): void {
  cache.clear();
  inflight.clear();
}
