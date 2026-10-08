import {
  assetsForNetwork,
  findAssetByAddress,
  findAssetBySymbol,
  isSolanaAddress,
  WRAPPED_SOL_MINT,
  type AssetDescriptor,
} from "@kletia/core";
import { JUPITER_API_KEY, JUPITER_API_URL, type SolanaNetworkKey } from "./config.js";
import { fetchProviderJson, isRecord } from "./http.js";

export interface SolanaTokenInfo {
  readonly mint: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly verified: boolean;
  readonly tokenProgram: "spl-token" | "token-2022";
  readonly logoURI?: string;
  /** True when the token comes from Kletia's canonical registry. */
  readonly canonical: boolean;
}

function jupiterHeaders(): Record<string, string> {
  return JUPITER_API_KEY ? { "x-api-key": JUPITER_API_KEY } : {};
}

function fromCanonical(asset: AssetDescriptor): SolanaTokenInfo {
  return {
    mint: asset.address ?? WRAPPED_SOL_MINT,
    symbol: asset.symbol,
    name: asset.name,
    decimals: asset.decimals,
    verified: true,
    tokenProgram: asset.tokenProgram ?? "spl-token",
    canonical: true,
  };
}

const TOKEN_CACHE = new Map<string, { info: SolanaTokenInfo | null; expiresAt: number }>();
const TOKEN_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Native SOL is represented by the wrapped-SOL mint for routing purposes. */
export function nativeSolToken(network: SolanaNetworkKey): SolanaTokenInfo {
  const native = assetsForNetwork(network).find((asset) => asset.address === null);
  return {
    mint: WRAPPED_SOL_MINT,
    symbol: "SOL",
    name: native?.name ?? "Solana",
    decimals: 9,
    verified: true,
    tokenProgram: "spl-token",
    canonical: true,
  };
}

function parseJupiterToken(value: unknown): SolanaTokenInfo | null {
  if (!isRecord(value)) return null;
  const mint = value.id;
  const symbol = value.symbol;
  const decimals = value.decimals;
  if (typeof mint !== "string" || !isSolanaAddress(mint)) return null;
  if (typeof symbol !== "string" || !symbol || symbol.length > 32) return null;
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) return null;
  return {
    mint,
    symbol: symbol.replace(/[^\w$.-]/gu, "").slice(0, 16) || symbol.slice(0, 16),
    name: typeof value.name === "string" ? value.name.slice(0, 64) : symbol,
    decimals,
    verified: value.isVerified === true,
    tokenProgram: value.tokenProgram === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" ? "token-2022" : "spl-token",
    ...(typeof value.icon === "string" && value.icon.startsWith("https://") ? { logoURI: value.icon } : {}),
    canonical: false,
  };
}

export async function searchSolanaTokens(query: string): Promise<SolanaTokenInfo[]> {
  const trimmed = query.trim().slice(0, 64);
  if (!trimmed) return [];
  const body = await fetchProviderJson<unknown>(
    `${JUPITER_API_URL}/tokens/v2/search?query=${encodeURIComponent(trimmed)}`,
    { provider: "Jupiter", headers: jupiterHeaders() },
  );
  if (!Array.isArray(body)) return [];
  return body.slice(0, 20).map(parseJupiterToken).filter((token): token is SolanaTokenInfo => token !== null);
}

/**
 * Resolve a symbol or mint on one Solana network. Canonical registry first;
 * mainnet falls back to Jupiter's verified token list. Unverified tokens are
 * returned with `verified: false` so callers can refuse or warn.
 */
export async function resolveSolanaToken(
  network: SolanaNetworkKey,
  symbolOrMint: string,
): Promise<SolanaTokenInfo | null> {
  const input = symbolOrMint.trim();
  if (!input) return null;
  if (input.toUpperCase() === "SOL" || input === WRAPPED_SOL_MINT) return nativeSolToken(network);
  const canonical = isSolanaAddress(input)
    ? findAssetByAddress(network, input)
    : findAssetBySymbol(network, input);
  if (canonical) return fromCanonical(canonical);
  if (network !== "solana") return null;

  const key = `${network}:${input.toLowerCase()}`;
  const cached = TOKEN_CACHE.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.info;
  const results = await searchSolanaTokens(input);
  const match = isSolanaAddress(input)
    ? results.find((token) => token.mint === input) ?? null
    : results
        .filter((token) => token.symbol.toUpperCase() === input.toUpperCase())
        .sort((a, b) => Number(b.verified) - Number(a.verified))[0] ?? null;
  TOKEN_CACHE.set(key, { info: match, expiresAt: Date.now() + TOKEN_CACHE_TTL_MS });
  return match;
}

export interface TokenPrice {
  readonly usd: number;
  readonly change24h?: number;
}

/** USD prices from Jupiter Price API v3 (mainnet mints only). */
export async function readSolanaPrices(mints: readonly string[]): Promise<Map<string, TokenPrice>> {
  const unique = [...new Set(mints.filter(isSolanaAddress))].slice(0, 50);
  const prices = new Map<string, TokenPrice>();
  if (unique.length === 0) return prices;
  const body = await fetchProviderJson<unknown>(
    `${JUPITER_API_URL}/price/v3?ids=${unique.join(",")}`,
    { provider: "Jupiter", headers: jupiterHeaders() },
  );
  if (!isRecord(body)) return prices;
  for (const mint of unique) {
    const entry = body[mint];
    if (!isRecord(entry)) continue;
    const usd = entry.usdPrice;
    if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) continue;
    prices.set(mint, {
      usd,
      ...(typeof entry.priceChange24h === "number" && Number.isFinite(entry.priceChange24h)
        ? { change24h: entry.priceChange24h }
        : {}),
    });
  }
  return prices;
}
