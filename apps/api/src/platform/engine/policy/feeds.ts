/**
 * Price sources of the Rule Book's conservative USD oracle. Data only:
 * Chainlink proxies (network, address, heartbeat from Chainlink's reference
 * data directory) and Jupiter mints, keyed by registry asset. Every proxy
 * and heartbeat was read live on 2026-10-09; decimals are never assumed and
 * are read on-chain (JITOSOL / USD has 18).
 *
 * Unlisted Solana mints are priced by Jupiter (liquidity floor applies);
 * unlisted EVM tokens have no source and are unpriced (fail closed wherever
 * a USD rule needs them). Testnet assets are worth $0 and are not listed.
 *
 * Read live on 2026-10-14:
 * - Chainlink readings on Arbitrum One, OP Mainnet and Base are gated by the
 *   network's L2 sequencer uptime feed: ignored while the sequencer is down,
 *   within SEQUENCER_GRACE_SECONDS of it coming back, or when the uptime feed
 *   cannot be read (fail closed).
 * - The Ethereum liquid staking tokens are priced from their verified feeds:
 *   wstETH = STETH / USD x wstETH.stEthPerToken(), rETH = RETH / ETH x ETH / USD,
 *   weETH = weETH / ETH x ETH / USD (`derived` sources, fresh only when every
 *   factor is fresh).
 * - Pyth push feeds on Solana are an additional source: the account is the
 *   PDA([shard 0 as u16 LE, feed_id]) of the push oracle, owned by the Pyth
 *   receiver, `verification_level` Full, its `feed_id` the Hermes id,
 *   `publish_time` within PYTH_MAX_AGE_SECONDS and `conf / price` at most
 *   PYTH_MAX_CONFIDENCE_BPS; otherwise the reading is ignored. The oracle
 *   still takes the maximum of fresh sources.
 */
import { ASSETS, CHAINS, parseAssetId, venueContracts, WRAPPED_SOL_MINT, type AssetDescriptor, type AssetId } from "@kletia/core";
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

/**
 * Chainlink L2 sequencer uptime feed: `answer` 0 = up, 1 = down; `startedAt`
 * is when the status last changed.
 */
export interface SequencerFeed {
  readonly kind: "sequencer";
  readonly network: EvmNetworkKey;
  readonly address: `0x${string}`;
  readonly description: string;
}

/** On-chain exchange rate read with one argument-less view returning a uint256 (18 decimals). */
export interface RateCall {
  readonly network: EvmNetworkKey;
  readonly address: `0x${string}`;
  /** `stEthPerToken()` of wstETH. */
  readonly functionName: "stEthPerToken";
  /** Sane bounds of the rate (18 decimals); a reading outside them is not used. */
  readonly min: bigint;
  readonly max: bigint;
}

/**
 * A price derived as the product of Chainlink readings (each scaled to 18
 * decimals: a USD price or an X / ETH ratio) and an optional on-chain rate.
 * Fresh only while every factor is fresh.
 */
export interface DerivedFeed {
  readonly kind: "derived";
  /** Stable id (`derived:<asset>`), also the reading id. */
  readonly id: string;
  readonly factors: readonly ChainlinkFeed[];
  readonly rate?: RateCall;
}

/** A Pyth push feed on Solana mainnet (sponsored shard 0). */
export interface PythFeed {
  readonly kind: "pyth";
  /** Hermes price feed id (32 bytes, lower-case hex). */
  readonly feedId: string;
  /** PDA([0u16 LE, feed_id], push oracle), read live on 2026-10-14; the reader re-derives it. */
  readonly account: string;
  readonly description: string;
}

export type PriceSource = ChainlinkFeed | JupiterFeed | DerivedFeed | PythFeed;

/** Grace on top of a Chainlink heartbeat before a reading counts as stale. */
export const CHAINLINK_GRACE_SECONDS = 300;
/** L2 Chainlink readings are ignored for this long after the sequencer comes back up. */
export const SEQUENCER_GRACE_SECONDS = 3_600;
/** Jupiter readings need this much liquidity (USD) behind the price. */
export const JUPITER_MIN_LIQUIDITY_USD = 100_000;
/** Jupiter's `blockId` may trail the current slot by at most this many slots (about 6 minutes). */
export const JUPITER_MAX_SLOT_LAG = 900;
/** Pyth readings older (or further in the future) than this are not fresh. */
export const PYTH_MAX_AGE_SECONDS = 60;
/** Pyth readings whose confidence interval exceeds this share of the price (basis points) are not used. */
export const PYTH_MAX_CONFIDENCE_BPS = 200;
/** Pyth push oracle (account seeds) and receiver (account owner) from the registry. */
export const PYTH_PUSH_ORACLE = venueContracts("pyth", "solana", "program")[0] as string;
export const PYTH_RECEIVER = venueContracts("pyth", "solana", "receiver")[0] as string;

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
  // Liquid staking: STETH / USD is 8 decimals; the two ETH ratios have 18.
  stethUsdEthereum: chainlink("ethereum", "0xCfE54B5cD566aB89272946F602D76Ea879CAb4a8", "STETH / USD", 3_600),
  rethEthEthereum: chainlink("ethereum", "0x536218f9E9Eb48863970252233c8F271f554C2d0", "RETH / ETH", 86_400),
  weethEthEthereum: chainlink("ethereum", "0x5c9C449BbC9a6075A2c061dF312a35fd1E05fF22", "weETH / ETH", 86_400),
  // Read live 2026-10-15 (heartbeats from Chainlink's reference data directory). The ETH ratios have 18
  // decimals: CBETH / ETH 1.14151 (cbETH.exchangeRate() 1.14164), ETHx / ETH 1.09593, mETH / ETH 1.10191.
  cbethEthEthereum: chainlink("ethereum", "0xF017fcB346A1885194689bA23Eff2fE6fA5C483b", "CBETH / ETH", 86_400),
  ethxEthEthereum: chainlink("ethereum", "0xC5f8c4aB091Be1A899214c0C3636ca33DcA0C547", "ETHx / ETH", 86_400),
  methEthEthereum: chainlink("ethereum", "0x5b563107C8666d2142C216114228443B94152362", "mETH / ETH", 86_400),
  usdsUsdEthereum: chainlink("ethereum", "0xfF30586cD0F29eD462364C7e81375FC0C71219b1", "USDS / USD", 82_800),
  opUsdOptimism: chainlink("optimism", "0x0D276FC14719f9292D5C1eA2198673d1f4269246", "OP / USD", 1_200),
  // description(), decimals() and latestRoundData() read live 2026-10-23: USDe / USD has 8 decimals, ezETH / ETH 18.
  usdeUsdEthereum: chainlink("ethereum", "0xa569d910839Ae8865Da8F8e70FfFb0cBA869F961", "USDe / USD", 86_400),
  ezethEthEthereum: chainlink("ethereum", "0x636A000262F6aA9e1F094ABF0aD8f645C44f641C", "ezETH / ETH", 86_400),
});

const sequencer = (network: EvmNetworkKey, address: `0x${string}`): SequencerFeed =>
  Object.freeze({ kind: "sequencer", network, address, description: "L2 Sequencer Uptime Status Feed" });

/** Sequencer uptime feeds of the L2 networks whose Chainlink readings they gate (all reported up on 2026-10-14). */
export const SEQUENCER_UPTIME_FEEDS: Readonly<Partial<Record<EvmNetworkKey, SequencerFeed>>> = Object.freeze({
  arbitrum: sequencer("arbitrum", "0xFdB631F5EE196F0ed6FAa767959853A9F217697D"),
  optimism: sequencer("optimism", "0x371EAD81c9102C9BF4874A9075FFFf170F2Ee389"),
  base: sequencer("base", "0xBCF85224fc0756B9Fa45aA7892530B47e10b6433"),
});

/** wstETH (Ethereum): the token whose stEthPerToken() converts STETH / USD into a wstETH price. */
export const WSTETH_ETHEREUM = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0" as const;

const derived = (id: string, factors: readonly ChainlinkFeed[], rate?: RateCall): DerivedFeed =>
  Object.freeze({ kind: "derived", id, factors: Object.freeze([...factors]), ...(rate ? { rate: Object.freeze({ ...rate }) } : {}) });

/** Derived liquid-staking prices (Ethereum). */
export const DERIVED_FEEDS = Object.freeze({
  // 1 wstETH was 1.2463 stETH on 2026-10-14 and only grows; outside [1, 2] the rate is not used.
  wstethUsd: derived("derived:wstETH", [CHAINLINK_FEEDS.stethUsdEthereum], {
    network: "ethereum", address: WSTETH_ETHEREUM, functionName: "stEthPerToken", min: 10n ** 18n, max: 2n * 10n ** 18n,
  }),
  rethUsd: derived("derived:rETH", [CHAINLINK_FEEDS.rethEthEthereum, CHAINLINK_FEEDS.ethUsdEthereum]),
  weethUsd: derived("derived:weETH", [CHAINLINK_FEEDS.weethEthEthereum, CHAINLINK_FEEDS.ethUsdEthereum]),
  // cbETH (Ethereum and Base), ETHx and mETH = X / ETH x ETH / USD.
  cbethUsd: derived("derived:cbETH", [CHAINLINK_FEEDS.cbethEthEthereum, CHAINLINK_FEEDS.ethUsdEthereum]),
  ethxUsd: derived("derived:ETHx", [CHAINLINK_FEEDS.ethxEthEthereum, CHAINLINK_FEEDS.ethUsdEthereum]),
  methUsd: derived("derived:mETH", [CHAINLINK_FEEDS.methEthEthereum, CHAINLINK_FEEDS.ethUsdEthereum]),
  // ezETH = ezETH / ETH x ETH / USD.
  ezethUsd: derived("derived:ezETH", [CHAINLINK_FEEDS.ezethEthEthereum, CHAINLINK_FEEDS.ethUsdEthereum]),
});

const pyth = (description: string, feedId: string, account: string): PythFeed => Object.freeze({ kind: "pyth", feedId, account, description });

/** Pyth push feeds (shard 0); feed ids from Hermes, accounts derived and read live on 2026-10-14 (all Full, seconds old). */
export const PYTH_FEEDS = Object.freeze({
  solUsd: pyth("SOL/USD", "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d", "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"),
  usdcUsd: pyth("USDC/USD", "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a", "Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),
  jitosolUsd: pyth("JITOSOL/USD", "67be9f519b95cf24338801051f9a808eff0a578ccb388db73b7f6fe1de019ffb", "AxaxyeDT8JnWERSaTKvFXvPKkEdxnamKSqpWbsSjYg1g"),
  msolUsd: pyth("MSOL/USD", "c2289a6a43d2ce91c6f55caec370f4acc38a2ed477f58813334c6d03749ff2a4", "5CKzb9j4ChgLUt8Gfm5CNGLN6khXKiqMbnGAW4cgXgxK"),
  ethUsd: pyth("ETH/USD", "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace", "42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC"),
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
const P = PYTH_FEEDS;

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
  USDC: [F.usdcUsdEthereum, F.usdcUsdBase, F.usdcUsdArbitrum, jupiter(J.usdc), P.usdcUsd],
  USDT: [F.usdtUsdEthereum, jupiter(J.usdt)],
  // USDT0 is Tether's USDT on Arbitrum and Polygon (same USD sources).
  USDT0: [F.usdtUsdEthereum, jupiter(J.usdt)],
  DAI: [F.daiUsdEthereum],
  PYUSD: [jupiter(J.pyusd)],
  EURC: [F.eurcUsdBase, F.eurUsdEthereum],
  CBBTC: [F.cbbtcUsdBase, F.btcUsdEthereum, jupiter(J.cbbtc)],
  ARB: [F.arbUsdArbitrum],
  AERO: [F.aeroUsdBase],
  SOL: [jupiter(J.wsol), F.solUsdEthereum, F.solUsdArbitrum, P.solUsd],
  JITOSOL: [jupiter(J.jitosol), F.jitosolUsdBase, P.jitosolUsd],
  MSOL: [jupiter(J.msol), P.msolUsd],
  JUPSOL: [jupiter(J.jupsol)],
  JUP: [jupiter(J.jup)],
  BONK: [jupiter(J.bonk)],
  WIF: [jupiter(J.wif), F.wifUsdArbitrum],
  WSTETH: [DERIVED_FEEDS.wstethUsd],
  RETH: [DERIVED_FEEDS.rethUsd],
  WEETH: [DERIVED_FEEDS.weethUsd],
  // sfrxETH has no Chainlink feed: see UNPRICED_ASSETS.
  CBETH: [DERIVED_FEEDS.cbethUsd],
  ETHX: [DERIVED_FEEDS.ethxUsd],
  METH: [DERIVED_FEEDS.methUsd],
  USDS: [F.usdsUsdEthereum],
  OP: [F.opUsdOptimism],
  // rsETH has no verified Chainlink feed: see UNPRICED_SYMBOLS.
  USDE: [F.usdeUsdEthereum],
  EZETH: [DERIVED_FEEDS.ezethUsd],
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
    return feed ? [feed, jupiter(J.weth), P.ethUsd] : [jupiter(J.weth), P.ethUsd];
  }
  return BY_SYMBOL[symbol.toUpperCase()] ?? [];
}

/**
 * Mainnet registry assets with no verified price source (fail closed: no
 * swap guard or USD rule can use them; staking that mints them still works,
 * its USD value reads as unknown). sfrxETH: Chainlink lists no sfrxETH or
 * frxETH feed, and the oracle's on-chain rate reader covers wstETH only.
 * rsETH: no rsETH feed was confirmed on-chain, so none is pinned.
 */
export const UNPRICED_SYMBOLS: Readonly<Partial<Record<EvmNetworkKey, readonly string[]>>> = Object.freeze({
  ethereum: Object.freeze(["sfrxETH", "rsETH"]),
});

const LISTED: ReadonlyMap<string, AssetDescriptor> = new Map(ASSETS.map((asset) => [normalizeAssetKey(asset.id), asset]));

/** The registry descriptor of an asset id (EVM addresses compared case-insensitively). */
export function listedAsset(asset: AssetId | string): AssetDescriptor | null {
  return LISTED.get(normalizeAssetKey(asset)) ?? null;
}

/** Price sources of every mainnet registry asset, keyed by normalised CAIP-19 id. */
export const ASSET_PRICE_SOURCES: ReadonlyMap<string, readonly PriceSource[]> = new Map(
  ASSETS.filter((asset) => CHAINS[asset.network].environment !== "testnet" &&
    !(UNPRICED_SYMBOLS[asset.network as EvmNetworkKey] ?? []).includes(asset.symbol)).map((asset) => [
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
