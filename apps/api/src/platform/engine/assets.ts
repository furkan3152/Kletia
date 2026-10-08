/**
 * Asset resolution for the planner. A symbol is resolved on exactly one
 * network: the canonical @kletia/core registry first, then (Solana mainnet
 * only) Jupiter's token list. Unverified tokens are refused unless the caller
 * named them by mint address.
 */
import {
  CHAINS,
  findAssetByAddress,
  findAssetBySymbol,
  formatAssetId,
  fromBaseUnits,
  getAsset,
  isEvmAddress,
  isSolanaAddress,
  nativeAssetId,
  parseAssetId,
  WRAPPED_SOL_MINT,
  type AssetAmount,
  type AssetCategory,
  type AssetDescriptor,
  type AssetId,
  type AssetRef,
  type NetworkKey,
} from "@kletia/core";
import { isSolanaNetworkKey, resolveSolanaToken } from "../../networks/solana/index.js";
import { PlatformError } from "../errors.js";
import { isEvmNetwork, readErc20Metadata } from "./chains/evm.js";

export interface ResolvedAsset {
  readonly network: NetworkKey;
  readonly id: AssetId;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  /** ERC-20 contract or SPL mint; null for the native asset. */
  readonly address: string | null;
  readonly isNative: boolean;
  readonly canonical: boolean;
  readonly verified: boolean;
  readonly category?: AssetCategory;
  readonly group?: AssetDescriptor["group"];
}

const USD_STABLECOINS = new Set(["USDC", "USDT", "PYUSD", "DAI", "USDBC"]);

function fromDescriptor(asset: AssetDescriptor): ResolvedAsset {
  return {
    network: asset.network,
    id: asset.id,
    symbol: asset.symbol,
    name: asset.name,
    decimals: asset.decimals,
    address: asset.address,
    isNative: asset.address === null,
    canonical: true,
    verified: true,
    category: asset.category,
    ...(asset.group ? { group: asset.group } : {}),
  };
}

function nativeAsset(network: NetworkKey): ResolvedAsset {
  const chain = CHAINS[network];
  const canonical = getAsset(nativeAssetId(chain));
  if (canonical) return fromDescriptor(canonical);
  return {
    network,
    id: nativeAssetId(chain),
    symbol: chain.nativeAsset.symbol,
    name: chain.nativeAsset.name,
    decimals: chain.nativeAsset.decimals,
    address: null,
    isNative: true,
    canonical: true,
    verified: true,
    category: "native",
  };
}

function knownSymbols(network: NetworkKey): string {
  const symbols = new Set<string>();
  const native = getAsset(nativeAssetId(network));
  if (native) symbols.add(native.symbol);
  for (const symbol of ["USDC", "USDT", "WETH", "cbBTC", "JitoSOL", "mSOL", "JupSOL", "JUP", "BONK", "ARB", "AERO", "EURC", "DAI", "PYUSD", "WIF"]) {
    if (findAssetBySymbol(network, symbol)) symbols.add(symbol);
  }
  return [...symbols].join(", ");
}

function unknownToken(network: NetworkKey, input: string): PlatformError {
  return new PlatformError(
    "TOKEN_UNKNOWN",
    `Unknown token "${input.slice(0, 48)}" on ${CHAINS[network].name}. Known symbols: ${knownSymbols(network)}.`,
    422,
  );
}

async function resolveSolana(network: NetworkKey, input: string): Promise<ResolvedAsset> {
  if (!isSolanaNetworkKey(network)) throw unknownToken(network, input);
  if (input.toUpperCase() === "SOL" || input === WRAPPED_SOL_MINT) return nativeAsset(network);
  const canonical = isSolanaAddress(input) ? findAssetByAddress(network, input) : findAssetBySymbol(network, input);
  if (canonical) return fromDescriptor(canonical);
  const token = await resolveSolanaToken(network, input);
  if (!token) throw unknownToken(network, input);
  const byMint = isSolanaAddress(input);
  if (!token.verified && !byMint) {
    throw new PlatformError(
      "TOKEN_UNVERIFIED",
      `${token.symbol} is not on Jupiter's verified list. Use its mint address (${token.mint}) to proceed deliberately.`,
      422,
    );
  }
  return {
    network,
    id: formatAssetId(network, "token", token.mint),
    symbol: token.symbol,
    name: token.name,
    decimals: token.decimals,
    address: token.mint,
    isNative: false,
    canonical: false,
    verified: token.verified,
  };
}

async function resolveEvm(network: NetworkKey, input: string): Promise<ResolvedAsset> {
  if (!isEvmNetwork(network)) throw unknownToken(network, input);
  if (isEvmAddress(input)) {
    const canonical = findAssetByAddress(network, input);
    if (canonical) return fromDescriptor(canonical);
    const metadata = await readErc20Metadata(network, input);
    return {
      network,
      id: formatAssetId(network, "erc20", metadata.address),
      symbol: metadata.symbol,
      name: metadata.name || metadata.symbol,
      decimals: metadata.decimals,
      address: metadata.address,
      isNative: false,
      canonical: false,
      verified: false,
    };
  }
  const nativeSymbol = CHAINS[network].nativeAsset.symbol;
  const canonical = findAssetBySymbol(network, input);
  if (canonical) return fromDescriptor(canonical);
  if (input.toUpperCase() === nativeSymbol.toUpperCase()) return nativeAsset(network);
  throw unknownToken(network, input);
}

/** Resolve a symbol, address/mint or CAIP-19 id on one network. */
export async function resolveAsset(network: NetworkKey, rawInput: string): Promise<ResolvedAsset> {
  const input = rawInput.trim();
  if (!input || input.length > 128) throw unknownToken(network, rawInput);
  if (input.includes("/")) {
    const parsed = parseAssetId(input);
    if (!parsed) throw new PlatformError("ASSET_INVALID", `Invalid CAIP-19 asset id "${input.slice(0, 80)}".`, 422);
    if (parsed.chain.key !== network) {
      throw new PlatformError(
        "ASSET_NETWORK_MISMATCH",
        `Asset ${input.slice(0, 80)} is on ${parsed.chain.name}, not ${CHAINS[network].name}.`,
        422,
      );
    }
    if (parsed.isNative) return nativeAsset(network);
    return resolveAsset(network, parsed.reference);
  }
  return CHAINS[network].vm === "svm" ? resolveSolana(network, input) : resolveEvm(network, input);
}

/** Rebuilds a resolved asset from a recorded AssetRef (prepare-time; no lookups). */
export function assetFromRef(ref: AssetRef): ResolvedAsset {
  const parsed = parseAssetId(ref.asset);
  if (!parsed) throw new PlatformError("ASSET_INVALID", "The recorded asset id is invalid.", 500);
  const canonical = getAsset(parsed.id);
  return {
    network: parsed.chain.key,
    id: parsed.id,
    symbol: ref.symbol,
    name: canonical?.name ?? ref.symbol,
    decimals: ref.decimals,
    address: parsed.isNative ? null : parsed.reference,
    isNative: parsed.isNative,
    canonical: canonical !== null,
    verified: canonical !== null,
    ...(canonical ? { category: canonical.category } : {}),
    ...(canonical?.group ? { group: canonical.group } : {}),
  };
}

export function isUsdStablecoin(asset: Pick<ResolvedAsset, "symbol" | "canonical" | "category">): boolean {
  return asset.canonical && asset.category === "stablecoin" && USD_STABLECOINS.has(asset.symbol.toUpperCase());
}

export function assetAmount(asset: ResolvedAsset, units: string, usd?: number): AssetAmount {
  const formatted = fromBaseUnits(units, asset.decimals);
  const value = usd ?? (isUsdStablecoin(asset) ? Number(formatted) : undefined);
  return {
    asset: asset.id,
    symbol: asset.symbol,
    decimals: asset.decimals,
    amount: units,
    formatted,
    ...(value !== undefined && Number.isFinite(value) ? { usd: Math.round(value * 100) / 100 } : {}),
  };
}

/** CAIP-19 equality: EVM ids compare case-insensitively; Solana mints are case-sensitive base58. */
export function sameAsset(a: { readonly id: string } | { readonly asset: string }, b: { readonly id: string } | { readonly asset: string }): boolean {
  const left = "id" in a ? a.id : a.asset;
  const right = "id" in b ? b.id : b.asset;
  if (left.startsWith("eip155:") && right.startsWith("eip155:")) return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

/** The address a provider (Relay/Jupiter) uses for an asset. */
export function providerCurrency(asset: ResolvedAsset): string {
  if (!asset.isNative) return asset.address as string;
  return CHAINS[asset.network].vm === "svm" ? "11111111111111111111111111111111" : "0x0000000000000000000000000000000000000000";
}

/** Mint used by Jupiter (native SOL routes through wrapped SOL). */
export function jupiterMint(asset: ResolvedAsset): string {
  return asset.isNative ? WRAPPED_SOL_MINT : (asset.address as string);
}
