/**
 * Advisory USD prices for fee estimates. Prices come from Jupiter's price API
 * (WSOL for SOL, Wormhole-bridged WETH as an ETH proxy) and are cached
 * briefly. A missing price yields null; it never blocks planning.
 */
import { assetsForNetwork, CHAINS, WRAPPED_SOL_MINT, type NetworkKey } from "@kletia/core";
import { readSolanaPrices } from "../../networks/solana/index.js";

/** Wormhole-bridged WETH on Solana; tracks ETH closely and is priced by Jupiter. */
const ETH_PROXY_MINT = "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs";
const CACHE_TTL_MS = 60_000;

const cache = new Map<string, { value: number | null; expiresAt: number }>();
const inflight = new Map<string, Promise<number | null>>();

async function mintPrice(mint: string): Promise<number | null> {
  const cached = cache.get(mint);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const pending = inflight.get(mint);
  if (pending) return pending;
  const request = readSolanaPrices([mint])
    .then((prices) => prices.get(mint)?.usd ?? null)
    .catch(() => null)
    .then((value) => {
      cache.set(mint, { value, expiresAt: Date.now() + (value === null ? 10_000 : CACHE_TTL_MS) });
      inflight.delete(mint);
      return value;
    });
  inflight.set(mint, request);
  return request;
}

/**
 * Natives Jupiter cannot price (POL) fall back to the Rule Book's oracle
 * (Chainlink POL / USD on Polygon and Arbitrum), so Polygon fees are known
 * and `limits.maxFeeUsd` does not lock Polygon out (policy design §4.4).
 */
async function oracleNativePrice(network: NetworkKey): Promise<number | null> {
  const cached = cache.get(`oracle:${network}`);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const native = assetsForNetwork(network).find((asset) => asset.address === null);
  let value: number | null = null;
  if (native) {
    try {
      const { policyPrice, quoteUsdNumber } = await import("./policy/pricing.js");
      const quote = await policyPrice({ asset: native.id, symbol: native.symbol, decimals: native.decimals, network });
      value = quote ? quoteUsdNumber(quote) : null;
    } catch {
      value = null;
    }
  }
  cache.set(`oracle:${network}`, { value, expiresAt: Date.now() + (value === null ? 10_000 : CACHE_TTL_MS) });
  return value;
}

/** USD price of a network's native gas asset (testnets other than Arc price at 0). */
export async function nativeUsdPrice(network: NetworkKey): Promise<number | null> {
  const chain = CHAINS[network];
  if (chain.nativeAsset.symbol === "USDC") return 1;
  if (chain.environment === "testnet") return 0;
  if (chain.nativeAsset.symbol === "SOL") return mintPrice(WRAPPED_SOL_MINT);
  if (chain.nativeAsset.symbol === "ETH") return mintPrice(ETH_PROXY_MINT);
  return oracleNativePrice(network);
}

export async function solanaMintUsdPrice(mint: string): Promise<number | null> {
  return mintPrice(mint);
}
