/**
 * Price sources of the Rule Book's conservative USD oracle (policy design
 * §5.1). Data only: Chainlink proxies (network, address, heartbeat from
 * Chainlink's reference data directory) and Jupiter mints, keyed by registry
 * asset. Every proxy and heartbeat was read live on 2026-10-09 (design
 * Appendix A.1, A.2); decimals are never assumed and are read on-chain
 * (JITOSOL / USD has 18).
 *
 * Unlisted Solana mints are priced by Jupiter (liquidity floor applies);
 * unlisted EVM tokens have no source and are unpriced (fail closed wherever
 * a USD rule needs them). Testnet assets are worth $0 and are not listed.
 */
import { ASSETS, CHAINS, parseAssetId, WRAPPED_SOL_MINT, type AssetDescriptor, type AssetId } from "@kletia/core";
import type { EvmNetworkKey } from "../chains/evm.js";

export interface ChainlinkFeed {
  readonly kind: "chainlink";
  readonly network: EvmNetworkKey;
  /** Proxy (EIP-55). */
  readonly address: `0x${string}`;
  /** `description()` as read live (Polygon's POL feed still says MATIC / USD). */
  readonly description: string;
  /** Feed heartbeat; a reading is fresh while `now - updatedAt ≤ heartbeat + 300 s`. */
  readonly heartbeatSeconds: number;
}

export interface JupiterFeed {
  readonly kind: "jupiter";
  readonly mint: string;
}

export type PriceSource = ChainlinkFeed | JupiterFeed;

/** Grace on top of a Chainlink heartbeat before a reading counts as stale. */
export const CHAINLINK_GRACE_SECONDS = 300;
/** Jupiter readings need this much liquidity (USD) behind the price. */
export const JUPITER_MIN_LIQUIDITY_USD = 100_000;
/** Jupiter's `blockId` may trail the current slot by at most this many slots (about 6 minutes). */
export const JUPITER_MAX_SLOT_LAG = 900;

const chainlink = (network: EvmNetworkKey, address: `0x${string}`, description: string, heartbeatSeconds: number): ChainlinkFeed =>
  Object.freeze({ kind: "chainlink", network, address, description, heartbeatSeconds });
const jupiter = (mint: string): JupiterFeed => Object.freeze({ kind: "jupiter", mint });

/** Every Chainlink proxy the oracle reads. */
export const CHAINLINK_FEEDS = Object.freeze({
  ethUsdEthereum: chainlink("ethereum", "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419", "ETH / USD", 3_600),
  // Secondary proxy of 0x50015f8b…3a8b ("Shared SVR"); the directory lists it under the primary.
  ethUsdBase: chainlink("base", "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70", "ETH / USD", 1_200),
  ethUsdArbitrum: chainlink("arbitrum", "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612", "ETH / USD", 1_755),
  ethUsdOptimism: chainlink("optimism", "0x13e3Ee699D1909E989722E753853AE30b17e08c5", "ETH / USD", 1_200),
  ethUsdPolygon: chainlink("polygon", "0xF9680D99D6C9589e2a93a78A04A279e509205945", "ETH / USD", 27),
  polUsdPolygon: chainlink("polygon", "0xAB594600376Ec9fD91F8e885dADF0CE036862dE0", "MATIC / USD", 27),
  polUsdArbitrum: chainlink("arbitrum", "0x82BA56a2fADF9C14f17D08bc51bDA0bDB83A8934", "POL / USD", 86_400),
  usdcUsdEthereum: chainlink("ethereum", "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6", "USDC / USD", 82_800),
  usdcUsdBase: chainlink("base", "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B", "USDC / USD", 86_400),
  usdcUsdArbitrum: chainlink("arbitrum", "0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3", "USDC / USD", 255),
  usdtUsdEthereum: chainlink("ethereum", "0x3E7d1eAB13ad0104d2750B8863b489D65364e32D", "USDT / USD", 86_400),
  daiUsdEthereum: chainlink("ethereum", "0xAed0c38402a5d19df6E4c03F4E2DceD6e29c1ee9", "DAI / USD", 3_600),
  eurcUsdBase: chainlink("base", "0x9867186e52d2F1C2c565CDA6E747101Fa56501e0", "EURC / USD", 3_600),
  eurUsdEthereum: chainlink("ethereum", "0xb49f677943BC038e9857d61E7d053CaA2C1734C1", "EUR / USD", 86_400),
  cbbtcUsdBase: chainlink("base", "0x07DA0E54543a844a80ABE69c8A12F22B3aA59f9D", "cbBTC / USD", 1_200),
  btcUsdEthereum: chainlink("ethereum", "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c", "BTC / USD", 3_600),
  arbUsdArbitrum: chainlink("arbitrum", "0xb2A824043730FE05F3DA2efaFa1CBbe83fa548D6", "ARB / USD", 86_400),
  aeroUsdBase: chainlink("base", "0x4EC5970fC728C5f65ba413992CD5fF6FD70fcfF0", "AERO / USD", 86_400),
  solUsdEthereum: chainlink("ethereum", "0x4ffC43a60e009B551865A93d232E33Fce9f01507", "SOL / USD", 86_400),
  solUsdArbitrum: chainlink("arbitrum", "0x24ceA4b8ce57cdA5058b924B9B9987992450590c", "SOL / USD", 86_400),
  jitosolUsdBase: chainlink("base", "0x0ca181015d21A5ed19baFC17F2138883C2b16D54", "JITOSOL / USD", 86_400),
  wifUsdArbitrum: chainlink("arbitrum", "0xF7Ee427318d2Bd0EEd3c63382D0d52Ad8A68f90D", "WIF / USD", 86_400),
});

/** Jupiter Price v3 ids (Solana mainnet mints). */
export const JUPITER_MINTS = Object.freeze({
  /** Wormhole-bridged WETH: tracks ETH. */
  weth: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
  wsol: WRAPPED_SOL_MINT,
  usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  usdt: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  pyusd: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
  jitosol: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
  msol: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
  jupsol: "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v",
  jup: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  cbbtc: "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij",
  bonk: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  wif: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
});

const F = CHAINLINK_FEEDS;
const J = JUPITER_MINTS;

const ETH_BY_NETWORK: Readonly<Partial<Record<EvmNetworkKey, ChainlinkFeed>>> = {
  ethereum: F.ethUsdEthereum,
  base: F.ethUsdBase,
  arbitrum: F.ethUsdArbitrum,
  optimism: F.ethUsdOptimism,
  polygon: F.ethUsdPolygon,
};

/** Sources by registry symbol (groups resolved below); the network matters only for ETH. */
const BY_SYMBOL: Readonly<Record<string, readonly PriceSource[]>> = {
  POL: [F.polUsdPolygon, F.polUsdArbitrum],
  WPOL: [F.polUsdPolygon, F.polUsdArbitrum],
  USDC: [F.usdcUsdEthereum, F.usdcUsdBase, F.usdcUsdArbitrum, jupiter(J.usdc)],
  USDT: [F.usdtUsdEthereum, jupiter(J.usdt)],
  DAI: [F.daiUsdEthereum],
  PYUSD: [jupiter(J.pyusd)],
  EURC: [F.eurcUsdBase, F.eurUsdEthereum],
  CBBTC: [F.cbbtcUsdBase, F.btcUsdEthereum, jupiter(J.cbbtc)],
  ARB: [F.arbUsdArbitrum],
  AERO: [F.aeroUsdBase],
  SOL: [jupiter(J.wsol), F.solUsdEthereum, F.solUsdArbitrum],
  JITOSOL: [jupiter(J.jitosol), F.jitosolUsdBase],
  MSOL: [jupiter(J.msol)],
  JUPSOL: [jupiter(J.jupsol)],
  JUP: [jupiter(J.jup)],
  BONK: [jupiter(J.bonk)],
  WIF: [jupiter(J.wif), F.wifUsdArbitrum],
};

/** CAIP-19 text with EVM token addresses lower-cased (registry lookups are case-insensitive). */
export function normalizeAssetKey(asset: string): string {
  const parsed = parseAssetId(asset);
  if (!parsed) return asset;
  return parsed.assetNamespace === "erc20" ? `${parsed.chain.id}/erc20:${parsed.reference.toLowerCase()}` : parsed.id;
}

function sourcesForListed(symbol: string, network: string, group: string | undefined): readonly PriceSource[] {
  if (group === "ETH") {
    const feed = ETH_BY_NETWORK[network as EvmNetworkKey];
    return feed ? [feed, jupiter(J.weth)] : [jupiter(J.weth)];
  }
  return BY_SYMBOL[symbol.toUpperCase()] ?? [];
}

const LISTED: ReadonlyMap<string, AssetDescriptor> = new Map(ASSETS.map((asset) => [normalizeAssetKey(asset.id), asset]));

/** The registry descriptor of an asset id (EVM addresses compared case-insensitively). */
export function listedAsset(asset: AssetId | string): AssetDescriptor | null {
  return LISTED.get(normalizeAssetKey(asset)) ?? null;
}

/** Price sources of every mainnet registry asset, keyed by normalised CAIP-19 id. */
export const ASSET_PRICE_SOURCES: ReadonlyMap<string, readonly PriceSource[]> = new Map(
  ASSETS.filter((asset) => CHAINS[asset.network].environment !== "testnet").map((asset) => [
    normalizeAssetKey(asset.id),
    Object.freeze([...sourcesForListed(asset.symbol, asset.network, asset.group)]),
  ]),
);

/**
 * Sources for any asset id: registry assets from the table, unlisted Solana
 * mainnet mints through Jupiter, everything else none (unpriced).
 */
export function priceSourcesFor(asset: AssetId | string): readonly PriceSource[] {
  const listed = ASSET_PRICE_SOURCES.get(normalizeAssetKey(asset));
  if (listed) return listed;
  const parsed = parseAssetId(asset);
  if (parsed && parsed.chain.key === "solana" && parsed.assetNamespace === "token") return [jupiter(parsed.reference)];
  return [];
}
