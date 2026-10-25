/**
 * DEX deployments, Curve pools, Across spoke pools and CCTP testnet
 * contracts.
 */
import type { NetworkKey } from "../chains.js";
import type { ProtocolId, VenueContract, VenueContractRole } from "./types.js";

/* --------------------------------------------------------- DEX deployments */

export type DexDialect = "uniswap-v3" | "slipstream" | "solidly-v2" | "algebra";

/** Protocols with pinned concentrated-liquidity (or classic) deployments in DEX_DEPLOYMENTS. */
export type DexProtocolId = Extract<ProtocolId, "uniswap-v3" | "aerodrome" | "velodrome" | "pancakeswap-v3" | "camelot">;

export interface DexDeployment {
  /** `${network}:${protocol}:${slug}`. */
  readonly id: string;
  readonly protocol: DexProtocolId;
  readonly network: NetworkKey;
  readonly dialect: DexDialect;
  /** Pools are accepted only when this factory's getPool(...) returns them. */
  readonly factory: string;
  /** The only contract called and the only approval spender. */
  readonly router: string;
  /** Concentrated-liquidity dialects; solidly-v2 quotes with router.getAmountsOut. */
  readonly quoter?: string;
  /** router WETH9() / weth() must equal it. */
  readonly wrappedNative: string;
  /** uniswap-v3 fee tiers. */
  readonly feeTiers?: readonly number[];
  /** Slipstream tick spacings. */
  readonly tickSpacings?: readonly number[];
  /** solidly-v2: FactoryRegistry.isPoolFactoryApproved(factory) must be true. */
  readonly factoryRegistry?: string;
  /**
   * Pool deployer the router and quoter must report (PancakeSwap V3
   * `deployer()`; Algebra factory `poolDeployer()`).
   */
  readonly poolDeployer?: string;
  /**
   * A test deployment on a testnet network (test tokens, no oracle price).
   * Never set on a mainnet network (registry test).
   */
  readonly testnet?: true;
}

const UNISWAP_FEE_TIERS: readonly number[] = Object.freeze([100, 500, 3000, 10000]);
const PANCAKESWAP_FEE_TIERS: readonly number[] = Object.freeze([100, 500, 2500, 10000]);
const SLIPSTREAM_TICK_SPACINGS: readonly number[] = Object.freeze([1, 50, 100, 200, 2000]);
export const WRAPPED_NATIVE: Readonly<Partial<Record<NetworkKey, string>>> = Object.freeze({
  ethereum: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  arbitrum: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  optimism: "0x4200000000000000000000000000000000000006",
  polygon: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  base: "0x4200000000000000000000000000000000000006",
  "arbitrum-sepolia": "0x980B62Da83eFf3D4576C647993b0c1D7faf17c73",
});

/** The canonical wrapped gas asset of an EVM network (WETH9, WPOL), or null (Solana, Arc). */
export function wrappedNativeAddress(network: NetworkKey): string | null {
  return WRAPPED_NATIVE[network] ?? null;
}

function uniswapV3(network: NetworkKey, factory: string, router: string, quoter: string): DexDeployment {
  return {
    id: `${network}:uniswap-v3:v3`, protocol: "uniswap-v3", network, dialect: "uniswap-v3", factory, router, quoter,
    wrappedNative: WRAPPED_NATIVE[network] as string, feeTiers: UNISWAP_FEE_TIERS,
  };
}

function pancakeswapV3(network: NetworkKey, router: string): DexDeployment {
  return {
    id: `${network}:pancakeswap-v3:v3`, protocol: "pancakeswap-v3", network, dialect: "uniswap-v3",
    factory: PANCAKESWAP_FACTORY, router, quoter: PANCAKESWAP_QUOTER, wrappedNative: WRAPPED_NATIVE[network] as string,
    feeTiers: PANCAKESWAP_FEE_TIERS, poolDeployer: PANCAKESWAP_POOL_DEPLOYER,
  };
}

const PANCAKESWAP_FACTORY = "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865";
const PANCAKESWAP_QUOTER = "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997";
const PANCAKESWAP_POOL_DEPLOYER = "0x41ff9AA7e16B8B1a8a8dc4f0eFacd93D02d071c9";

function slipstream(protocol: "aerodrome" | "velodrome", network: NetworkKey, slug: string, factory: string, router: string, quoter: string): DexDeployment {
  return {
    id: `${network}:${protocol}:${slug}`, protocol, network, dialect: "slipstream", factory, router, quoter,
    wrappedNative: WRAPPED_NATIVE[network] as string, tickSpacings: SLIPSTREAM_TICK_SPACINGS,
  };
}

const UNISWAP_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
const UNISWAP_ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const UNISWAP_QUOTER = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e";

/**
 * Pinned swap deployments: Uniswap V3 on the five EVM production networks
 * and the Slipstream (concentrated) deployments of Aerodrome (Base) and
 * Velodrome (OP Mainnet). Classic (solidly-v2) pools are not listed: the
 * dialect exists, but nothing routes to them today.
 */
export const DEX_DEPLOYMENTS: readonly DexDeployment[] = Object.freeze([
  uniswapV3("ethereum", UNISWAP_FACTORY, UNISWAP_ROUTER, UNISWAP_QUOTER),
  uniswapV3("arbitrum", UNISWAP_FACTORY, UNISWAP_ROUTER, UNISWAP_QUOTER),
  uniswapV3("optimism", UNISWAP_FACTORY, UNISWAP_ROUTER, UNISWAP_QUOTER),
  uniswapV3("polygon", UNISWAP_FACTORY, UNISWAP_ROUTER, UNISWAP_QUOTER),
  uniswapV3("base", "0x33128a8fC17869897dcE68Ed026d694621f6FDfD", "0x2626664c2603336E57B271c5C0b26F421741e481", "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a"),
  slipstream("aerodrome", "base", "cl-initial", "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A", "0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5", "0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0"),
  slipstream("aerodrome", "base", "cl-gauge-caps", "0xaDe65c38CD4849aDBA595a4323a8C7DdfE89716a", "0xcbBb8035cAc7D4B3Ca7aBb74cF7BdF900215Ce0D", "0x3d4C22254F86f64B7eC90ab8F7aeC1FBFD271c6C"),
  slipstream("aerodrome", "base", "cl-gauges-v3", "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef", "0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F", "0x514c8B5f54112481E28028F1166Bd78501089259"),
  slipstream("velodrome", "optimism", "cl-initial", "0xCc0bDDB707055e04e497aB22a59c2aF4391cd12F", "0x0792a633F0c19c351081CF4B211F68F79bCc9676", "0x89D8218ed5fF1e46d8dcd33fb0bbeE3be1621466"),
  slipstream("velodrome", "optimism", "cl-gauges-v2", "0xe13Dd1fbA721Aa81a1826D9523AC9BC7d260c879", "0xbA3aEe516399388C779463183d00bB579f5041Ca", "0xAd432b2ca49965266133F2bd4c17dc1Ec12f5DEB"),
  // ---- read back 2026-10-15: router WETH9/factory/deployer, quoter factory/deployer
  // PancakeSwap V3: one factory and QuoterV2 on all three networks; the SmartRouter differs on the L2s.
  pancakeswapV3("ethereum", "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4"),
  pancakeswapV3("base", "0x678Aa4bF4E210cf2166753e054d5b7c31cc7fa86"),
  pancakeswapV3("arbitrum", "0x32226588378236Fd0c7c4053999F88aC0e5cAc77"),
  // Camelot V3 (Algebra): one dynamic-fee pool per pair, no tiers (router WNativeToken()/factory() read back).
  {
    id: "arbitrum:camelot:v3", protocol: "camelot", network: "arbitrum", dialect: "algebra",
    factory: "0x1a3c9B1d2F0529D97f2afC5136Cc23e58f1FD35B", router: "0x1F721E2E82F6676FCE4eA07A5958cF098D339e18",
    quoter: "0x0Fc73040b26E9bC8514fA028D998E73A254Fa76E", wrappedNative: WRAPPED_NATIVE.arbitrum as string,
    poolDeployer: "0x6Dd3FB9653B10e806650F107C3B5A0a6fF974F65",
  },
  // Uniswap V3 on Arbitrum Sepolia (test tokens: testnet guard mode, never on a mainnet network).
  {
    ...uniswapV3("arbitrum-sepolia", "0x248AB79Bbb9bC29bB72f7Cd42F17e054Fc40188e", "0x101F443B4d1b059569D643917553c771E1b9663E", "0x2779a0CC1c3e0E44D2542EC3e79e3864Ae93Ef0B"),
    testnet: true,
  },
] satisfies readonly DexDeployment[]);

export function dexDeploymentsFor(network: NetworkKey, protocol?: DexDeployment["protocol"]): DexDeployment[] {
  return DEX_DEPLOYMENTS.filter((deployment) => deployment.network === network && (!protocol || deployment.protocol === protocol));
}

/** VENUE_CONTRACTS rows of the deployments: factory, router, quoter and factory registry, each address once per (protocol, network, role). */
export function dexContracts(deployments: readonly DexDeployment[]): VenueContract[] {
  const rows: VenueContract[] = [];
  const add = (deployment: DexDeployment, role: VenueContractRole, address: string | undefined): void => {
    if (!address) return;
    const duplicate = rows.some((row) => row.protocol === deployment.protocol && row.network === deployment.network &&
      row.role === role && row.address.toLowerCase() === address.toLowerCase());
    if (!duplicate) rows.push({ protocol: deployment.protocol, network: deployment.network, role, address });
  };
  for (const deployment of deployments) {
    add(deployment, "pool-factory", deployment.factory);
    add(deployment, "swap-router", deployment.router);
    add(deployment, "quoter", deployment.quoter);
    add(deployment, "factory-registry", deployment.factoryRegistry);
    add(deployment, "pool-deployer", deployment.poolDeployer);
  }
  return rows;
}

/* ------------------------------------------------------------- Curve pools */

/**
 * A pinned Curve pool. `coins[i]` are registry symbols on `network` in the
 * pool's own coin order: `coins(i)` is re-read and must equal the asset's
 * address before any quote (`get_dy(i, j, dx)`) or `exchange(i, j, dx, min_dy)`.
 */
export interface CurvePool {
  /** `${network}:curve:<slug>`. */
  readonly id: string;
  readonly protocol: "curve";
  readonly network: NetworkKey;
  /** The pool: the only contract called and the only approval spender. */
  readonly pool: string;
  readonly coins: readonly string[];
  /** Plain stable pool (int128 indices, no native ETH leg). */
  readonly kind: "plain";
}

export const CURVE_POOLS: readonly CurvePool[] = Object.freeze([
  // 3pool: coins(0..2) = DAI, USDC, USDT (read back 2026-10-15; MetaRegistry find_pool_for_coins(USDC, USDT) returns it)
  { id: "ethereum:curve:3pool", protocol: "curve", network: "ethereum", pool: "0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7", coins: ["DAI", "USDC", "USDT"], kind: "plain" },
  // stable-ng USDC/USDT0, added 2026-10-23 (coins(0..1) read back; the stable-ng factory 0x9AF14D26…167b lists it for the pair)
  { id: "arbitrum:curve:usdc-usdt0", protocol: "curve", network: "arbitrum", pool: "0x49b720F1Aab26260BEAec93A7BeB5BF2925b2A8F", coins: ["USDC", "USDT0"], kind: "plain" },
] satisfies readonly CurvePool[]);

/** Pinned Curve pools on `network` (optionally the ones holding both symbols). */
export function curvePoolsFor(network: NetworkKey, symbols?: readonly [string, string]): CurvePool[] {
  return CURVE_POOLS.filter((entry) => entry.network === network && (!symbols || symbols.every((symbol) =>
    entry.coins.some((coin) => coin.toUpperCase() === symbol.toUpperCase()))));
}

export const ACROSS_SPOKE_POOLS: Readonly<Partial<Record<NetworkKey, string>>> = Object.freeze({
  ethereum: "0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5",
  base: "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64",
  arbitrum: "0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A",
  optimism: "0x6f26Bf09B1C792e3228e5467807a900A503c0281",
  polygon: "0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096",
});

/**
 * Circle CCTP V2 testnet contracts (read back 2026-10-15: TokenMessengerV2 reports the transmitter and minter;
 * localDomain 26 on Arc, 3 on Arbitrum Sepolia; the Solana Devnet programs
 * are executable). Pinned in VENUE_CONTRACTS: the CCTP adapter serves
 * every network whose contracts are pinned, reads testnet fees and messages
 * from Circle's sandbox Iris (chosen from the source network) and refuses any
 * route whose source and destination sit on different capital lanes.
 * Declared before VENUE_CONTRACTS, which spreads it.
 */
export const CCTP_V2_TESTNET_CONTRACTS: readonly VenueContract[] = Object.freeze([
  ...(["arc", "arbitrum-sepolia"] as const).flatMap((network): VenueContract[] => [
    { protocol: "cctp-v2", network, role: "token-messenger", address: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" },
    { protocol: "cctp-v2", network, role: "message-transmitter", address: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275" },
    { protocol: "cctp-v2", network, role: "token-minter", address: "0xb43db544E2c27092c107639Ad201b3dEfAbcF192" },
  ]),
  { protocol: "cctp-v2", network: "solana-devnet", role: "token-messenger-minter", address: "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe" },
  { protocol: "cctp-v2", network: "solana-devnet", role: "message-transmitter", address: "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC" },
] satisfies readonly VenueContract[]);
