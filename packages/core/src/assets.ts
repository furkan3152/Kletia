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
  /**
   * The ERC-20 is a view of the account's native balance (no storage slot):
   * simulations that need funds in flight override the native balance,
   * scaled by 10^(native decimals - token decimals). Arc USDC.
   */
  readonly nativeBalanceView?: true;
  /**
   * Listed so balances and transfers show the token by name, but no swap,
   * bridge, deposit or price route uses it: a step that would spend or
   * receive it through a venue is ROUTE_UNSUPPORTED. USDbC (Base's legacy
   * bridged USDC, a different token from USDC).
   */
  readonly transferOnly?: true;
  /**
   * The token reverts `approve(spender, x > 0)` while the current allowance
   * is non-zero (Ethereum USDT): approval helpers reset it to zero first.
   */
  readonly approvalReset?: true;
  /**
   * Other names of this same token on its network only (USDT0 is "USDT" on
   * Arbitrum and Polygon): findAssetBySymbol resolves them everywhere. An
   * exact symbol match always wins.
   */
  readonly aliases?: readonly string[];
  /**
   * Readings of a different asset's name that a user's sentence may mean
   * (Polygon's bridged WETH for "ETH", whose gas asset is POL). Resolved only
   * when the reader opts in (`{ readings: true }`) and shows `aliasNote`;
   * funding, links and routing never resolve them.
   */
  readonly readings?: readonly string[];
  /** One line shown when an alias or a reading was used. */
  readonly aliasNote?: string;
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
  { ...evm("base", "USDbC", "USD Base Coin", "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", 6, "stablecoin"), transferOnly: true },
  // round 7 (tokens.json, read back 2026-10-15). weETH on Base is listed for balances only: its pools trade far below fair value.
  evm("base", "wstETH", "Wrapped liquid staked Ether 2.0", "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", 18, "liquid-staking"),
  evm("base", "cbETH", "Coinbase Wrapped Staked ETH", "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", 18, "liquid-staking"),
  { ...evm("base", "weETH", "Wrapped eETH", "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A", 18, "liquid-staking"), transferOnly: true },
  // Arbitrum One
  native("arbitrum", "ETH"),
  evm("arbitrum", "USDC", "USD Coin", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", 6, "stablecoin", "USDC"),
  evm("arbitrum", "WETH", "Wrapped Ether", "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", 18, "wrapped", "ETH"),
  evm("arbitrum", "ARB", "Arbitrum", "0x912CE59144191C1204E64559FE8253a0e49E6548", 18, "governance"),
  // round 7 (tokens.json, read back 2026-10-15). USDT0 is Tether's canonical USDT on Arbitrum (on-chain symbol "USD₮0").
  {
    ...evm("arbitrum", "USDT0", "USDT0 (Tether USD)", "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", 6, "stablecoin", "USDT"),
    aliases: ["USDT"], aliasNote: "USDT on Arbitrum One is USDT0, Tether's canonical USDT there.",
  },
  evm("arbitrum", "wstETH", "Wrapped liquid staked Ether 2.0", "0x5979D7b546E38E414F7E9822514be443A4800529", 18, "liquid-staking"),
  evm("arbitrum", "DAI", "Dai Stablecoin", "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", 18, "stablecoin"),
  // Ethereum (USDC is Circle-native, CCTP V2 domain 0)
  native("ethereum", "ETH"),
  evm("ethereum", "USDC", "USD Coin", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 6, "stablecoin", "USDC"),
  evm("ethereum", "WETH", "Wrapped Ether", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", 18, "wrapped", "ETH"),
  // EVM liquid staking tokens (no identity group: they accrue against ETH, never 1:1)
  evm("ethereum", "wstETH", "Wrapped liquid staked Ether 2.0", "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", 18, "liquid-staking"),
  evm("ethereum", "rETH", "Rocket Pool ETH", "0xae78736Cd615f374D3085123A210448E74Fc6393", 18, "liquid-staking"),
  evm("ethereum", "weETH", "Wrapped eETH", "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee", 18, "liquid-staking"),
  // round 7 (tokens.json, read back 2026-10-15). USDT reverts approve(x > 0) over a non-zero allowance.
  { ...evm("ethereum", "USDT", "Tether USD", "0xdAC17F958D2ee523a2206206994597C13D831ec7", 6, "stablecoin", "USDT"), approvalReset: true },
  evm("ethereum", "DAI", "Dai Stablecoin", "0x6B175474E89094C44Da98b954EedeAC495271d0F", 18, "stablecoin"),
  evm("ethereum", "USDS", "USDS Stablecoin", "0xdC035D45d973E3EC169d2276DDab16f1e407384F", 18, "stablecoin"),
  evm("ethereum", "cbBTC", "Coinbase Wrapped BTC", "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", 8, "btc", "BTC"),
  evm("ethereum", "cbETH", "Coinbase Wrapped Staked ETH", "0xBe9895146f7AF43049ca1c1AE358B0541Ea49704", 18, "liquid-staking"),
  evm("ethereum", "ETHx", "Stader ETHx", "0xA35b1B31Ce002FBF2058D22F30f95D405200A15b", 18, "liquid-staking"),
  evm("ethereum", "mETH", "Mantle Staked Ether", "0xd5F7838F5C461fefF7FE49ea5ebaF7728bB0ADfa", 18, "liquid-staking"),
  evm("ethereum", "sfrxETH", "Staked Frax Ether", "0xac3E018457B222d93114458476f3E3416Abbe38F", 18, "liquid-staking"),
  // round 9 (symbol() and decimals() read back 2026-10-23): Ethena's USDe and the restaking tokens of Kelp and Renzo
  evm("ethereum", "USDe", "Ethena USDe", "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3", 18, "stablecoin"),
  evm("ethereum", "rsETH", "KelpDAO Restaked ETH", "0xA1290d69c65A6Fe4DF752f95823fae25cB99e5A7", 18, "liquid-staking"),
  evm("ethereum", "ezETH", "Renzo Restaked ETH", "0xbf5495Efe5DB9ce00f80364C8B423567e58d2110", 18, "liquid-staking"),
  // OP Mainnet (USDC is Circle-native, CCTP V2 domain 2)
  native("optimism", "ETH"),
  evm("optimism", "USDC", "USD Coin", "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", 6, "stablecoin", "USDC"),
  evm("optimism", "WETH", "Wrapped Ether", "0x4200000000000000000000000000000000000006", 18, "wrapped", "ETH"),
  // round 7 (tokens.json, read back 2026-10-15)
  evm("optimism", "USDT", "Tether USD", "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", 6, "stablecoin", "USDT"),
  evm("optimism", "wstETH", "Wrapped liquid staked Ether 2.0", "0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb", 18, "liquid-staking"),
  evm("optimism", "OP", "Optimism", "0x4200000000000000000000000000000000000042", 18, "governance"),
  // Polygon PoS (native USDC, CCTP V2 domain 7; the gas asset is POL, WETH is bridged ETH)
  native("polygon"),
  evm("polygon", "USDC", "USD Coin", "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", 6, "stablecoin", "USDC"),
  evm("polygon", "WPOL", "Wrapped POL", "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", 18, "wrapped"),
  {
    ...evm("polygon", "WETH", "Wrapped Ether", "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", 18, "wrapped", "ETH"),
    readings: ["ETH"], aliasNote: "ETH on Polygon is bridged WETH (the gas asset there is POL).",
  },
  // round 7 (tokens.json, read back 2026-10-15). USDT0 upgraded Polygon's USDT in place (same address).
  {
    ...evm("polygon", "USDT0", "USDT0 (Tether USD)", "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", 6, "stablecoin", "USDT"),
    aliases: ["USDT"], aliasNote: "USDT on Polygon is USDT0, Tether's canonical USDT there.",
  },
  evm("polygon", "wstETH", "Wrapped liquid staked Ether 2.0", "0x03b54A6e9a984069379fae1a4fC4dBAE93B3bCCD", 18, "liquid-staking"),
  evm("polygon", "DAI", "Dai Stablecoin", "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", 18, "stablecoin"),
  // Arc Testnet: USDC is the native gas asset (18 decimals) with a 6-decimal ERC-20 interface.
  { ...evm("arc", "USDC", "USD Coin", "0x3600000000000000000000000000000000000000", 6, "stablecoin", "USDC"), nativeBalanceView: true },
  evm("arc", "EURC", "Euro Coin", "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a", 6, "stablecoin", "EURC"),
  // Arbitrum Sepolia
  native("arbitrum-sepolia", "ETH"),
  evm("arbitrum-sepolia", "USDC", "USD Coin", "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", 6, "stablecoin", "USDC"),
  evm("arbitrum-sepolia", "WETH", "Wrapped Ether", "0x980B62Da83eFf3D4576C647993b0c1D7faf17c73", 18, "wrapped", "ETH"),
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

/**
 * Resolves a symbol on one network only. Case-insensitive; `SOL`/`ETH` map to
 * natives. An exact symbol wins over an alias (`USDT` -> USDT0 on Arbitrum);
 * `readings` (Polygon "ETH" -> WETH) resolve only with `{ readings: true }`.
 */
export function findAssetBySymbol(network: NetworkKey, symbol: string, options?: { readonly readings?: boolean }): AssetDescriptor | null {
  const wanted = symbol.trim().toUpperCase();
  const named = (names: readonly string[] | undefined) => (names ?? []).some((name) => name.toUpperCase() === wanted);
  return (
    ASSETS.find((asset) => asset.network === network && asset.symbol.toUpperCase() === wanted) ??
    ASSETS.find((asset) => asset.network === network && named(asset.aliases)) ??
    (options?.readings ? ASSETS.find((asset) => asset.network === network && named(asset.readings)) : undefined) ??
    null
  );
}

/**
 * The note to show when `symbol` resolves on `network` through an alias or
 * (with `{ readings: true }`) a reading rather than the asset's own symbol,
 * else null.
 */
export function assetAliasNote(network: NetworkKey, symbol: string, options?: { readonly readings?: boolean }): string | null {
  const asset = findAssetBySymbol(network, symbol, options);
  if (!asset || asset.symbol.toUpperCase() === symbol.trim().toUpperCase()) return null;
  return asset.aliasNote ?? `${symbol.trim()} on ${CHAINS[network].name} is ${asset.symbol}.`;
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
