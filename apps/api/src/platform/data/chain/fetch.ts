/**
 * Outbound reads of the history providers: the engine's provider fetch
 * (`fetchProviderJson`: timeout, size cap, bounded 429 retries, errors
 * mapped to PlatformError without the URL) behind a per-provider pacer, so
 * one page of many accounts never bursts past a provider's published rate
 * (Etherscan's free tier: 5 calls a second). Tests replace the fetcher with
 * recorded fixtures (`configureHistoryFetch`).
 */
import { fetchProviderJson, type ProviderRequest } from "../../engine/http.js";

export type HistoryFetcher = (url: string, request: ProviderRequest) => Promise<unknown>;

/** Calls a second each provider is paced to (the free tiers' limits, minus headroom). */
const RATES: Readonly<Record<string, number>> = Object.freeze({
  Etherscan: 4,
  Alchemy: 10,
  Helius: 8,
  "Solana RPC": 4,
  DefiLlama: 5,
  CoinGecko: 0.4,
  Kamino: 4,
});

let fetcher: HistoryFetcher = fetchProviderJson;
const nextSlot = new Map<string, number>();

/** Replaces the fetcher (tests); null restores the live one. Also resets the pacing. */
export function configureHistoryFetch(next: HistoryFetcher | null): void {
  fetcher = next ?? fetchProviderJson;
  nextSlot.clear();
}

/** Waits for the provider's next slot (no wait under test fetchers, which are instant anyway). */
async function pace(provider: string): Promise<void> {
  const rate = RATES[provider];
  if (!rate || fetcher !== fetchProviderJson) return;
  const now = Date.now();
  const slot = Math.max(now, nextSlot.get(provider) ?? 0);
  nextSlot.set(provider, slot + 1000 / rate);
  if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));
}

/** A paced JSON read from a history or price provider. */
export async function historyFetch(url: string, request: ProviderRequest): Promise<unknown> {
  await pace(request.provider);
  return fetcher(url, request);
}
