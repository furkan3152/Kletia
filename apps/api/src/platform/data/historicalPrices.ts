/**
 * USD prices at a past time, for transaction legs and cost basis: DefiLlama's
 * keyless coins API (`GET coins.llama.fi/batchHistorical`, the price closest
 * to the hour within 6 hours), cached per coin and hour (a past price never
 * changes). With COINGECKO_API_KEY, coins DefiLlama has no price for are
 * looked up on CoinGecko (`/coins/{id}/history`, gas assets only: its token
 * ids need a separate lookup Kletia does not make). Only Kletia's listed
 * assets and gas assets are priced: an unlisted token (often spam) is never
 * valued from a provider symbol.
 */
import { CHAINS, findAssetByAddress, type DataHistoricalPriceSource, type NetworkKey } from "@kletia/core";
import { toPlatformError } from "../errors.js";
import { historyFetch } from "./chain/fetch.js";

const HOUR_MS = 3_600_000;
const BATCH = 40;
const MAX_CACHE = 50_000;

/** DefiLlama chain slugs of Kletia's production networks. */
const LLAMA_CHAINS: Readonly<Partial<Record<NetworkKey, string>>> = Object.freeze({
  ethereum: "ethereum",
  base: "base",
  arbitrum: "arbitrum",
  optimism: "optimism",
  polygon: "polygon",
  solana: "solana",
});

/** CoinGecko ids of the production gas assets. */
const GAS_COINS: Readonly<Record<string, string>> = Object.freeze({ ETH: "ethereum", POL: "polygon-ecosystem-token", SOL: "solana" });

export interface HistoricalPrice {
  readonly usd: number;
  readonly source: DataHistoricalPriceSource;
}

export type PriceLookup = { readonly coin: string; readonly hour: number } | { readonly coin: null; readonly reason: string };

const cache = new Map<string, HistoricalPrice | null>();

export function resetHistoricalPrices(): void {
  cache.clear();
}

/** The coin to look up for a token (address null: the gas asset) on `network` at `time`, or why it is not priced. */
export function priceLookup(network: NetworkKey, address: string | null, time: number): PriceLookup {
  const chain = CHAINS[network];
  if (chain.environment === "testnet") return { coin: null, reason: "Testnet assets have no market price." };
  const slug = LLAMA_CHAINS[network];
  if (!slug) return { coin: null, reason: "No historical price source covers this network." };
  const hour = Math.round(time / HOUR_MS) * HOUR_MS;
  if (address === null) {
    const gas = GAS_COINS[chain.nativeAsset.symbol];
    return gas ? { coin: `coingecko:${gas}`, hour } : { coin: null, reason: "No historical price source covers this gas asset." };
  }
  const listed = findAssetByAddress(network, address);
  if (!listed) return { coin: null, reason: "Unlisted token: Kletia does not price it." };
  return { coin: `${slug}:${chain.vm === "evm" ? address.toLowerCase() : address}`, hour };
}

const cacheKey = (coin: string, hour: number) => `${coin}@${hour}`;

function remember(key: string, value: HistoricalPrice | null): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

async function llamaBatch(wanted: ReadonlyMap<string, readonly number[]>): Promise<void> {
  const coins: Record<string, number[]> = {};
  for (const [coin, hours] of wanted) coins[coin] = hours.map((hour) => hour / 1000);
  const query = new URLSearchParams({ coins: JSON.stringify(coins), searchWidth: "6h" });
  const body = (await historyFetch(`https://coins.llama.fi/batchHistorical?${query}`, { provider: "DefiLlama" })) as {
    coins?: Record<string, { prices?: { timestamp?: number; price?: number }[] }>;
  } | null;
  for (const [coin, hours] of wanted) {
    const prices = body?.coins?.[coin]?.prices ?? [];
    for (const hour of hours) {
      // The returned point closest to the asked hour (DefiLlama answers each asked timestamp within the search width).
      let best: { timestamp: number; price: number } | null = null;
      for (const point of prices) {
        if (typeof point.timestamp !== "number" || typeof point.price !== "number" || !(point.price >= 0)) continue;
        if (Math.abs(point.timestamp * 1000 - hour) > 6 * HOUR_MS) continue;
        if (!best || Math.abs(point.timestamp * 1000 - hour) < Math.abs(best.timestamp * 1000 - hour)) best = { timestamp: point.timestamp, price: point.price };
      }
      // A missing recent price may still arrive: only older misses are remembered.
      if (best) remember(cacheKey(coin, hour), { usd: best.price, source: "defillama" });
      else if (hour < Date.now() - 12 * HOUR_MS) remember(cacheKey(coin, hour), null);
    }
  }
}

function coingeckoKey(): string | null {
  return process.env.COINGECKO_API_KEY?.trim() || null;
}

/** CoinGecko's daily price of a gas asset (`coingecko:<id>`), with the demo or pro key. */
async function coingeckoGas(coin: string, hour: number, key: string): Promise<HistoricalPrice | null> {
  if (!coin.startsWith("coingecko:")) return null;
  const date = new Date(hour);
  const day = `${String(date.getUTCDate()).padStart(2, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${date.getUTCFullYear()}`;
  const pro = process.env.COINGECKO_API_PLAN?.trim() === "pro";
  const body = (await historyFetch(`https://${pro ? "pro-api" : "api"}.coingecko.com/api/v3/coins/${coin.slice("coingecko:".length)}/history?date=${day}&localization=false`, {
    provider: "CoinGecko",
    headers: { [pro ? "x-cg-pro-api-key" : "x-cg-demo-api-key"]: key },
  })) as { market_data?: { current_price?: { usd?: number } } } | null;
  const usd = body?.market_data?.current_price?.usd;
  return typeof usd === "number" && usd >= 0 ? { usd, source: "coingecko" } : null;
}

/**
 * Prices of the lookups (by `coin@hour`), from the cache or one DefiLlama
 * batch per 40 coins. A provider failure leaves the prices unknown (null)
 * and is not cached, so a later read tries again.
 */
export async function historicalPrices(lookups: readonly PriceLookup[]): Promise<Map<string, HistoricalPrice | null>> {
  const wanted = new Map<string, number[]>();
  for (const lookup of lookups) {
    if (lookup.coin === null || cache.has(cacheKey(lookup.coin, lookup.hour))) continue;
    const hours = wanted.get(lookup.coin) ?? [];
    if (!hours.includes(lookup.hour)) hours.push(lookup.hour);
    wanted.set(lookup.coin, hours);
  }
  const entries = [...wanted.entries()];
  for (let index = 0; index < entries.length; index += BATCH) {
    await llamaBatch(new Map(entries.slice(index, index + BATCH))).catch((error: unknown) => {
      console.warn("[platform] historical prices unavailable:", toPlatformError(error).code);
    });
  }
  const key = coingeckoKey();
  if (key) {
    const missing = entries.flatMap(([coin, hours]) => hours.filter((hour) => !cache.get(cacheKey(coin, hour))).map((hour) => ({ coin, hour }))).slice(0, 10);
    for (const { coin, hour } of missing) {
      const price = await coingeckoGas(coin, hour, key).catch(() => null);
      if (price) remember(cacheKey(coin, hour), price);
    }
  }
  const out = new Map<string, HistoricalPrice | null>();
  for (const lookup of lookups) {
    if (lookup.coin === null) continue;
    const key = cacheKey(lookup.coin, lookup.hour);
    out.set(key, cache.get(key) ?? null);
  }
  return out;
}

export function lookupKey(lookup: PriceLookup): string | null {
  return lookup.coin === null ? null : cacheKey(lookup.coin, lookup.hour);
}
