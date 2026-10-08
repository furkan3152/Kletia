/**
 * Canonical asset table. An entry binds a symbol to exactly one on-chain
 * identity per network; symbols are never resolved across networks by name.
 */
import { CHAINS, type NetworkKey } from "./chains.js";
import { formatAssetId, nativeAssetId, type AssetId } from "./caip.js";

export type AssetCategory = "native" | "stablecoin" | "wrapped" | "liquid-staking" | "governance" | "meme" | "btc";

export interface AssetDescriptor {
  readonly id: AssetId;
  readonly network: NetworkKey;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  /** Contract address (EVM) or mint (Solana); null for the native asset. */
  readonly address: string | null;
  readonly category: AssetCategory;
  /** Solana token program owning the mint. */
  readonly tokenProgram?: "spl-token" | "token-2022";
  /** Cross-network identity group: assets in the same group are fungible 1:1 in intent. */
  readonly group?: "USDC" | "USDT" | "ETH" | "BTC" | "EURC" | "SOL";
}

function native(network: NetworkKey, group?: AssetDescriptor["group"]): AssetDescriptor {
  const chain = CHAINS[network];
  return {
    id: nativeAssetId(chain),
    network,
    symbol: chain.nativeAsset.symbol,
    name: chain.nativeAsset.name,
    decimals: chain.nativeAsset.decimals,
    address: null,
    category: "native",
    ...(group ? { group } : {}),
  };
}

function evm(
  network: NetworkKey,
  symbol: string,
  name: string,
  address: string,
  decimals: number,
  category: AssetCategory,
  group?: AssetDescriptor["group"],
): AssetDescriptor {
  return {
    id: formatAssetId(network, "erc20", address),
    network,
    symbol,
    name,
    decimals,
    address,
    category,
    ...(group ? { group } : {}),
  };
}

function spl(
  network: NetworkKey,
  symbol: string,
  name: string,
  mint: string,
  decimals: number,
  category: AssetCategory,
  group?: AssetDescriptor["group"],
  tokenProgram: "spl-token" | "token-2022" = "spl-token",
): AssetDescriptor {
  return {
    id: formatAssetId(network, "token", mint),
    network,
    symbol,
    name,
    decimals,
    address: mint,
    category,
    tokenProgram,
    ...(group ? { group } : {}),
  };
}

export const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
export const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const SOLANA_DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

export const ASSETS: readonly AssetDescriptor[] = Object.freeze([
  // Base
  native("base", "ETH"),
  evm("base", "USDC", "USD Coin", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", 6, "stablecoin", "USDC"),
  evm("base", "WETH", "Wrapped Ether", "0x4200000000000000000000000000000000000006", 18, "wrapped", "ETH"),
  evm("base", "cbBTC", "Coinbase Wrapped BTC", "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", 8, "btc", "BTC"),
  evm("base", "DAI", "Dai Stablecoin", "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", 18, "stablecoin"),
  evm("base", "EURC", "Euro Coin", "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", 6, "stablecoin", "EURC"),
  evm("base", "AERO", "Aerodrome", "0x940181a94A35A4569E4529A3CDfB74e38FD98631", 18, "governance"),
  // Arbitrum One
  native("arbitrum", "ETH"),
  evm("arbitrum", "USDC", "USD Coin", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", 6, "stablecoin", "USDC"),
  evm("arbitrum", "WETH", "Wrapped Ether", "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", 18, "wrapped", "ETH"),
  evm("arbitrum", "ARB", "Arbitrum", "0x912CE59144191C1204E64559FE8253a0e49E6548", 18, "governance"),
  // Arc Testnet: USDC is the native gas asset (18 decimals) with a 6-decimal ERC-20 interface.
  evm("arc", "USDC", "USD Coin", "0x3600000000000000000000000000000000000000", 6, "stablecoin", "USDC"),
  // Arbitrum Sepolia
  native("arbitrum-sepolia", "ETH"),
  evm("arbitrum-sepolia", "USDC", "USD Coin", "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", 6, "stablecoin", "USDC"),
  // Solana
  native("solana", "SOL"),
  spl("solana", "USDC", "USD Coin", SOLANA_USDC_MINT, 6, "stablecoin", "USDC"),
  spl("solana", "USDT", "Tether USD", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", 6, "stablecoin", "USDT"),
  spl("solana", "PYUSD", "PayPal USD", "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", 6, "stablecoin", undefined, "token-2022"),
  spl("solana", "JitoSOL", "Jito Staked SOL", "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", 9, "liquid-staking", "SOL"),
  spl("solana", "mSOL", "Marinade Staked SOL", "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", 9, "liquid-staking", "SOL"),
  spl("solana", "JupSOL", "Jupiter Staked SOL", "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v", 9, "liquid-staking", "SOL"),
  spl("solana", "JUP", "Jupiter", "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", 6, "governance"),
  spl("solana", "cbBTC", "Coinbase Wrapped BTC", "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij", 8, "btc", "BTC"),
  spl("solana", "BONK", "Bonk", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", 5, "meme"),
  spl("solana", "WIF", "dogwifhat", "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", 6, "meme"),
  // Solana Devnet
  native("solana-devnet", "SOL"),
  spl("solana-devnet", "USDC", "USD Coin", SOLANA_DEVNET_USDC_MINT, 6, "stablecoin", "USDC"),
]);

const ASSET_BY_ID = new Map<string, AssetDescriptor>(ASSETS.map((asset) => [asset.id, asset]));

export function getAsset(id: string): AssetDescriptor | null {
  return ASSET_BY_ID.get(id) ?? null;
}

export function assetsForNetwork(network: NetworkKey): AssetDescriptor[] {
  return ASSETS.filter((asset) => asset.network === network);
}

/** Resolves a symbol on one network only. Case-insensitive; `SOL`/`ETH` map to natives. */
export function findAssetBySymbol(network: NetworkKey, symbol: string): AssetDescriptor | null {
  const wanted = symbol.trim().toUpperCase();
  return (
    ASSETS.find((asset) => asset.network === network && asset.symbol.toUpperCase() === wanted) ??
    null
  );
}

export function findAssetByAddress(network: NetworkKey, address: string): AssetDescriptor | null {
  const chain = CHAINS[network];
  const wanted = chain.namespace === "eip155" ? address.toLowerCase() : address;
  return (
    ASSETS.find(
      (asset) =>
        asset.network === network &&
        asset.address !== null &&
        (chain.namespace === "eip155" ? asset.address.toLowerCase() : asset.address) === wanted,
    ) ?? null
  );
}

/** The counterpart of an asset on another network within the same identity group. */
export function counterpartAsset(asset: AssetDescriptor, network: NetworkKey): AssetDescriptor | null {
  if (!asset.group) return null;
  const sameGroup = ASSETS.filter((candidate) => candidate.network === network && candidate.group === asset.group);
  return (
    sameGroup.find((candidate) => candidate.symbol.toUpperCase() === asset.symbol.toUpperCase()) ??
    sameGroup.find((candidate) => candidate.category === asset.category) ??
    sameGroup[0] ??
    null
  );
}
