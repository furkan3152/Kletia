/**
 * Protocol registry. A protocol is an execution or settlement venue that an
 * intent step can be bound to. `status` states what Kletia can actually do
 * with it today; a registry entry is never a promise of execution.
 *
 * Two pinned tables sit next to it and are the only place execution adapters
 * read venue addresses from (adapters never hard-code them and never take an
 * address from a provider at runtime):
 *
 * - `YIELD_VENUES`: lending markets and vaults (deposit / withdraw), keyed by
 *   `(network, address)` because the same address can be a different market on
 *   another network.
 * - `VENUE_CONTRACTS`: contracts and programs a settlement venue, aggregator or
 *   name service may be called through, per network.
 *
 * Every address below was read back on-chain (eth_call / getAccountInfo) on
 * 2026-10-09; see docs/networks/*.md for the evidence.
 */
import type { NetworkKey } from "./chains.js";
import type { IntentActionKind } from "./intent.js";

export type ProtocolCategory =
  | "dex-aggregator"
  | "dex"
  | "bridge"
  | "intent-network"
  | "lending"
  | "liquid-staking"
  | "yield"
  | "naming"
  | "payments"
  | "security"
  | "data"
  | "token-program"
  /** Integrator-registered contracts and Solana Actions (bring your own contract). */
  | "custom";

/**
 * - `execute`: Kletia builds wallet-ready transactions.
 * - `quote`: Kletia returns live quotes and routes, execution handled elsewhere.
 * - `discover`: Read-only market/yield discovery (and, for naming, resolution).
 */
export type ProtocolCapability = "execute" | "quote" | "discover";

export type ProtocolId =
  | "kletia-router-v2"
  | "uniswap-v3"
  | "aerodrome"
  | "aave-v3"
  | "compound-v3"
  | "moonwell"
  | "morpho"
  | "basenames"
  | "ens"
  | "sns"
  | "x402"
  | "across"
  | "cctp-v2"
  | "relay"
  | "lifi"
  | "debridge-dln"
  | "jupiter"
  | "jupiter-lend"
  | "kamino"
  | "jito"
  | "marinade"
  | "sanctum"
  | "spl-token"
  | "system-transfer"
  | "erc20-transfer"
  | "arc-native"
  | "circle-app-kit"
  | "webacy"
  | "allora"
  | "custom-call"
  | "solana-actions";

export interface ProtocolDescriptor {
  readonly id: ProtocolId;
  readonly name: string;
  readonly category: ProtocolCategory;
  readonly networks: readonly NetworkKey[];
  readonly capabilities: readonly ProtocolCapability[];
  readonly website: string;
  readonly summary: string;
  /** Cross-network venue that can move value between networks. */
  readonly crossChain?: boolean;
  /**
   * Intent action kinds Kletia executes through this protocol (when
   * `capabilities` includes `execute`). Whether an adapter is live on a given
   * deployment is reported by GET /v1/protocols (`executable`).
   */
  readonly kinds?: readonly IntentActionKind[];
}

const EVM_PRODUCTION: readonly NetworkKey[] = ["base", "arbitrum", "ethereum", "optimism", "polygon"];

export const PROTOCOLS: readonly ProtocolDescriptor[] = Object.freeze([
  {
    id: "kletia-router-v2",
    name: "Kletia Intent Router V2",
    category: "dex-aggregator",
    networks: ["base"],
    capabilities: ["execute", "quote"],
    website: "https://basescan.org",
    summary: "Identity-pinned router that executes reviewed Base swap routes with exact output floors.",
  },
  {
    id: "uniswap-v3",
    name: "Uniswap V3",
    category: "dex",
    networks: ["base", "arbitrum"],
    capabilities: ["execute", "quote"],
    website: "https://uniswap.org",
    summary: "Concentrated-liquidity AMM used for quoted single-hop and multi-hop swaps.",
  },
  {
    id: "aerodrome",
    name: "Aerodrome",
    category: "dex",
    networks: ["base"],
    capabilities: ["quote", "discover"],
    website: "https://aerodrome.finance",
    summary: "Base liquidity hub; volatile, stable and Slipstream pools.",
  },
  {
    id: "aave-v3",
    name: "Aave V3",
    category: "lending",
    networks: [...EVM_PRODUCTION, "arbitrum-sepolia"],
    capabilities: ["execute", "discover"],
    website: "https://aave.com",
    summary: "Supply and withdraw (exact or full position); outcomes proven by Pool Supply/Withdraw events.",
    kinds: ["deposit", "withdraw"],
  },
  {
    id: "compound-v3",
    name: "Compound V3",
    category: "lending",
    networks: ["base", "arbitrum", "ethereum", "optimism"],
    capabilities: ["execute", "discover"],
    website: "https://compound.finance",
    summary: "Comet base-asset supply and withdraw (USDC, WETH); refuses accounts with an open borrow.",
    kinds: ["deposit", "withdraw"],
  },
  {
    id: "moonwell",
    name: "Moonwell",
    category: "lending",
    networks: ["base", "optimism"],
    capabilities: ["execute", "discover"],
    website: "https://moonwell.fi",
    summary: "mToken supply and redeem; success requires Mint/Redeem events (error codes do not revert). WETH markets pay withdrawals out in native ETH.",
    kinds: ["deposit", "withdraw"],
  },
  {
    id: "morpho",
    name: "Morpho Vaults",
    category: "yield",
    networks: ["base", "arbitrum", "ethereum"],
    capabilities: ["execute", "discover"],
    website: "https://morpho.org",
    summary: "Allowlisted MetaMorpho and Vault V2 ERC-4626 vaults with factory-proven provenance.",
    kinds: ["deposit", "withdraw"],
  },
  {
    id: "basenames",
    name: "Basenames",
    category: "naming",
    networks: ["base"],
    capabilities: ["execute", "discover"],
    website: "https://www.base.org/names",
    summary: "Onchain names on Base; resolution and registration.",
  },
  {
    id: "ens",
    name: "ENS",
    category: "naming",
    networks: EVM_PRODUCTION,
    capabilities: ["discover"],
    website: "https://ens.domains",
    summary: "Ethereum Name Service recipients (*.eth), resolved on Ethereum mainnet and re-resolved before every prepare.",
  },
  {
    id: "sns",
    name: "Solana Name Service",
    category: "naming",
    networks: ["solana"],
    capabilities: ["discover"],
    website: "https://sns.id",
    summary: "Solana Name Service recipients, resolved on-chain by registry owner and re-resolved before every prepare.",
  },
  {
    id: "x402",
    name: "x402 payments",
    category: "payments",
    networks: ["base"],
    capabilities: ["execute", "discover"],
    website: "https://x402.org",
    summary: "HTTP-native USDC payments for paid APIs and agents.",
  },
  {
    id: "across",
    name: "Across",
    category: "bridge",
    networks: ["base", "arbitrum"],
    capabilities: ["execute", "quote"],
    website: "https://across.to",
    summary: "Intent-based bridge for fast EVM-to-EVM transfers.",
    crossChain: true,
  },
  {
    id: "cctp-v2",
    name: "Circle CCTP V2",
    category: "bridge",
    networks: [...EVM_PRODUCTION, "arc", "arbitrum-sepolia", "solana", "solana-devnet"],
    capabilities: ["execute", "quote"],
    website: "https://www.circle.com/cross-chain-transfer-protocol",
    summary: "Native USDC burn-and-mint with attested messages.",
    crossChain: true,
  },
  {
    id: "relay",
    name: "Relay",
    category: "intent-network",
    networks: [...EVM_PRODUCTION, "solana"],
    capabilities: ["execute", "quote"],
    website: "https://relay.link",
    summary: "Solver-filled cross-chain intents between EVM networks and Solana, including swap-and-bridge.",
    crossChain: true,
    kinds: ["bridge", "swap"],
  },
  {
    id: "lifi",
    name: "LI.FI",
    category: "bridge",
    networks: [...EVM_PRODUCTION, "solana"],
    capabilities: ["execute", "quote"],
    website: "https://li.fi",
    summary: "Bridge aggregator; calls go only to the pinned LiFiDiamond with decoded, allowlisted bridge facets (LI.FI charges 0.25%).",
    crossChain: true,
    kinds: ["bridge"],
  },
  {
    id: "debridge-dln",
    name: "deBridge DLN",
    category: "intent-network",
    networks: [...EVM_PRODUCTION, "solana"],
    capabilities: ["execute", "quote"],
    website: "https://debridge.finance",
    summary: "Solver-filled cross-chain orders paid with a fixed native fee; deposits proven by CreatedOrder events.",
    crossChain: true,
    kinds: ["bridge"],
  },
  {
    id: "jupiter",
    name: "Jupiter",
    category: "dex-aggregator",
    networks: ["solana"],
    capabilities: ["execute", "quote"],
    website: "https://jup.ag",
    summary: "Solana liquidity aggregator across Meteora, Raydium, Orca, Phoenix and more.",
    kinds: ["swap", "stake"],
  },
  {
    id: "jupiter-lend",
    name: "Jupiter Lend",
    category: "lending",
    networks: ["solana"],
    capabilities: ["execute", "discover"],
    website: "https://jup.ag/lend",
    summary: "Jupiter Lend Earn deposits and withdrawals; the jlToken receipt lands in the wallet.",
    kinds: ["deposit", "withdraw"],
  },
  {
    id: "kamino",
    name: "Kamino Lend",
    category: "lending",
    networks: ["solana"],
    capabilities: ["execute", "discover"],
    website: "https://kamino.finance",
    summary: "Main-market reserve deposits and withdrawals, pinned by reserve address (never by symbol).",
    kinds: ["deposit", "withdraw"],
  },
  {
    id: "jito",
    name: "Jito",
    category: "liquid-staking",
    networks: ["solana"],
    capabilities: ["execute", "quote"],
    website: "https://www.jito.network",
    summary: "MEV-boosted liquid staking (JitoSOL), entered through Jupiter routes.",
  },
  {
    id: "marinade",
    name: "Marinade",
    category: "liquid-staking",
    networks: ["solana"],
    capabilities: ["execute", "quote"],
    website: "https://marinade.finance",
    summary: "Liquid staking (mSOL), entered through Jupiter routes.",
  },
  {
    id: "sanctum",
    name: "Jupiter / Sanctum LSTs",
    category: "liquid-staking",
    networks: ["solana"],
    capabilities: ["execute", "quote"],
    website: "https://sanctum.so",
    summary: "JupSOL and the Sanctum LST family, entered through Jupiter routes.",
  },
  {
    id: "spl-token",
    name: "SPL Token",
    category: "token-program",
    networks: ["solana", "solana-devnet"],
    capabilities: ["execute"],
    website: "https://spl.solana.com/token",
    summary: "Checked SPL transfers with idempotent associated token account creation.",
    kinds: ["transfer"],
  },
  {
    id: "system-transfer",
    name: "Native transfer",
    category: "token-program",
    networks: [...EVM_PRODUCTION, "arc", "arbitrum-sepolia", "solana", "solana-devnet"],
    capabilities: ["execute"],
    website: "https://kletiaai.xyz",
    summary: "Native asset transfers (ETH, POL, USDC on Arc, SOL).",
    kinds: ["transfer"],
  },
  {
    id: "erc20-transfer",
    name: "ERC-20 transfer",
    category: "token-program",
    networks: [...EVM_PRODUCTION, "arc", "arbitrum-sepolia"],
    capabilities: ["execute"],
    website: "https://eips.ethereum.org/EIPS/eip-20",
    summary: "Standard ERC-20 transfers.",
    kinds: ["transfer"],
  },
  {
    id: "arc-native",
    name: "Kletia Arc suite",
    category: "payments",
    networks: ["arc"],
    capabilities: ["execute", "discover"],
    website: "https://testnet.arcscan.app",
    summary: "Arc Testnet swap, lending, vault, staking, batch and memo payments.",
  },
  {
    id: "circle-app-kit",
    name: "Circle App Kit",
    category: "bridge",
    networks: ["arc", "arbitrum-sepolia"],
    capabilities: ["execute", "quote"],
    website: "https://developers.circle.com",
    summary: "Circle-managed USDC transfer and unified balance planning on Arc.",
    crossChain: true,
  },
  {
    id: "webacy",
    name: "Webacy",
    category: "security",
    networks: ["base", "arbitrum", "solana"],
    capabilities: ["discover"],
    website: "https://webacy.com",
    summary: "Address and token risk screening before value moves.",
  },
  {
    id: "allora",
    name: "Allora",
    category: "data",
    networks: ["base"],
    capabilities: ["discover"],
    website: "https://allora.network",
    summary: "Decentralised price inference used as advisory market context.",
  },
  {
    id: "custom-call",
    name: "Custom contract call",
    category: "custom",
    networks: [...EVM_PRODUCTION, "arc", "arbitrum-sepolia"],
    capabilities: ["execute"],
    website: "https://kletiaai.xyz/developers",
    summary: "Integrator-registered EVM contract actions: encoded from the registered ABI and bindings, code-pinned, simulated and verified. Not audited by Kletia.",
    kinds: ["call"],
  },
  {
    id: "solana-actions",
    name: "Solana Actions",
    category: "custom",
    networks: ["solana", "solana-devnet"],
    capabilities: ["execute"],
    website: "https://solana.com/developers/guides/advanced/actions",
    summary: "Integrator-registered Solana Actions: program-allowlisted, instruction-checked, simulated and verified transactions. Not audited by Kletia.",
    kinds: ["action"],
  },
] satisfies readonly ProtocolDescriptor[]);

export function getProtocol(id: string): ProtocolDescriptor | null {
  return PROTOCOLS.find((protocol) => protocol.id === id) ?? null;
}

export function protocolsForNetwork(network: NetworkKey): ProtocolDescriptor[] {
  return PROTOCOLS.filter((protocol) => protocol.networks.includes(network));
}

/** True when the registry lists `kind` as executable through `protocol`. */
export function protocolExecutesKind(protocol: ProtocolId, kind: IntentActionKind): boolean {
  const descriptor = getProtocol(protocol);
  return descriptor !== null && descriptor.capabilities.includes("execute") && (descriptor.kinds ?? []).includes(kind);
}

/* ------------------------------------------------------------ yield venues */

export type YieldVenueKind = "aave-reserve" | "comet" | "erc4626" | "ctoken" | "jupiter-lend" | "kamino-reserve";
export type YieldVenueAction = "deposit" | "withdraw";
export type MorphoGeneration = "metamorpho-v1.0" | "metamorpho-v1.1" | "vault-v2";

export interface ReceiptToken {
  /** ERC-20 (or SPL mint) the position is held in. Never added to ASSETS: receipt symbols are ambiguous. */
  readonly address: string;
  readonly decimals: number;
}

interface YieldVenueBase {
  /** Stable id `<network>:<protocol>:<slug>`; carried by AdapterAction.venue and IntentStep.venue. */
  readonly id: string;
  /** Short handle unique per (network, protocol), accepted in `params.venue` and the grammar. */
  readonly slug: string;
  readonly protocol: ProtocolId;
  readonly network: NetworkKey;
  readonly name: string;
  /**
   * Underlying asset symbol on `network`; resolves through
   * findAssetBySymbol(network, asset) and must equal the venue's on-chain
   * baseToken() / asset() / underlying() / reserve mint.
   */
  readonly asset: string;
  /** EVM: the contract the wallet calls. Solana: the program the transaction invokes. */
  readonly target: string;
  /** Actions Kletia executes against this venue (empty: listed for discovery only). */
  readonly actions: readonly YieldVenueAction[];
}

export interface AaveReserveVenue extends YieldVenueBase {
  readonly kind: "aave-reserve";
  /** The Pool: ERC-20 spender for supply. */
  readonly spender: string;
  readonly dataProvider: string;
  /** The reserve's aToken. */
  readonly receipt: ReceiptToken;
}

export interface CometVenue extends YieldVenueBase {
  readonly kind: "comet";
  /** The Comet proxy (spender = target = receipt). */
  readonly spender: string;
  readonly receipt: ReceiptToken;
}

export interface Erc4626Venue extends YieldVenueBase {
  readonly kind: "erc4626";
  /** The vault (spender = target = share token). */
  readonly spender: string;
  readonly receipt: ReceiptToken;
  readonly generation: MorphoGeneration;
  /** Factory that must confirm the vault (`isMetaMorpho` / `isVaultV2`). */
  readonly factory: string;
}

export interface CTokenVenue extends YieldVenueBase {
  readonly kind: "ctoken";
  /** The mToken (spender = target = receipt). */
  readonly spender: string;
  readonly receipt: ReceiptToken;
  /** Comptroller (Unitroller proxy) the mToken must report. */
  readonly comptroller: string;
  /** Router that wraps native ETH into this market (`mint(address)` payable). */
  readonly nativeRouter?: string;
  /**
   * WETH unwrapper of a market that pays redeems out in native ETH
   * (Moonwell MWethDelegate). The mToken's `wethUnwrapper()` must equal it;
   * it is only matched in receipt logs, never called or approved.
   */
  readonly nativePayout?: string;
}

export interface JupiterLendVenue extends YieldVenueBase {
  readonly kind: "jupiter-lend";
  /** The jlToken mint credited to the wallet. */
  readonly receipt: ReceiptToken;
  /** Liquidity program the lending program CPIs into. */
  readonly liquidityProgram: string;
}

export interface KaminoReserveVenue extends YieldVenueBase {
  readonly kind: "kamino-reserve";
  readonly market: string;
  readonly reserve: string;
  /** PDA("lma", market): owner of every reserve supply vault in the market. */
  readonly marketAuthority: string;
  /** Reserve liquidity supply vault (reserve account offset 160), when verified. */
  readonly supplyVault?: string;
}

export type YieldVenue = AaveReserveVenue | CometVenue | Erc4626Venue | CTokenVenue | JupiterLendVenue | KaminoReserveVenue;

/** MetaMorpho / Vault V2 factories per network (null: no such factory is used there). */
export const MORPHO_FACTORIES: Readonly<Partial<Record<NetworkKey, Readonly<Record<MorphoGeneration, string | null>>>>> = Object.freeze({
  base: {
    "metamorpho-v1.0": "0xA9c3D3a366466Fa809d1Ae982Fb2c46E5fC41101",
    "metamorpho-v1.1": "0xFf62A7c278C62eD665133147129245053Bbf5918",
    "vault-v2": "0x4501125508079A99ebBebCE205DeC9593C2b5857",
  },
  arbitrum: {
    "metamorpho-v1.0": null,
    "metamorpho-v1.1": "0x878988f5f561081deEa117717052164ea1Ef0c82",
    "vault-v2": "0x6b46fa3cc9EBF8aB230aBAc664E37F2966Bf7971",
  },
  ethereum: {
    "metamorpho-v1.0": null,
    "metamorpho-v1.1": null,
    "vault-v2": "0xA1D94F746dEfa1928926b84fB2596c06926C0405",
  },
});

const BOTH: readonly YieldVenueAction[] = ["deposit", "withdraw"];

function aave(network: NetworkKey, pool: string, dataProvider: string, asset: string, aToken: string, decimals: number): AaveReserveVenue {
  const slug = asset.toLowerCase();
  return {
    id: `${network}:aave-v3:${slug}`, slug, protocol: "aave-v3", network, kind: "aave-reserve", name: `Aave V3 ${asset}`,
    asset, target: pool, spender: pool, dataProvider, receipt: { address: aToken, decimals }, actions: BOTH,
  };
}

function comet(network: NetworkKey, address: string, asset: string, decimals: number): CometVenue {
  const slug = asset.toLowerCase();
  return {
    id: `${network}:compound-v3:${slug}`, slug, protocol: "compound-v3", network, kind: "comet", name: `Compound V3 ${asset}`,
    asset, target: address, spender: address, receipt: { address, decimals }, actions: BOTH,
  };
}

function vault(network: NetworkKey, slug: string, name: string, address: string, asset: string, generation: MorphoGeneration): Erc4626Venue {
  const factory = MORPHO_FACTORIES[network]?.[generation];
  if (!factory) throw new Error(`No ${generation} factory is pinned for ${network}.`);
  return {
    id: `${network}:morpho:${slug}`, slug, protocol: "morpho", network, kind: "erc4626", name,
    asset, target: address, spender: address, receipt: { address, decimals: 18 }, generation, factory, actions: BOTH,
  };
}

function mtoken(
  network: NetworkKey,
  address: string,
  asset: string,
  comptroller: string,
  native?: { readonly router: string; readonly payout: string },
): CTokenVenue {
  const slug = asset.toLowerCase();
  return {
    id: `${network}:moonwell:${slug}`, slug, protocol: "moonwell", network, kind: "ctoken", name: `Moonwell ${asset}`,
    asset, target: address, spender: address, receipt: { address, decimals: 8 }, comptroller,
    ...(native ? { nativeRouter: native.router, nativePayout: native.payout } : {}), actions: BOTH,
  };
}

const JUPITER_LEND_PROGRAM = "jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9";
const JUPITER_LIQUIDITY_PROGRAM = "jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC";

function jlToken(asset: string, mint: string, decimals: number, actions: readonly YieldVenueAction[] = BOTH): JupiterLendVenue {
  const slug = asset.toLowerCase();
  return {
    id: `solana:jupiter-lend:${slug}`, slug, protocol: "jupiter-lend", network: "solana", kind: "jupiter-lend",
    name: `Jupiter Lend ${asset}`, asset, target: JUPITER_LEND_PROGRAM, receipt: { address: mint, decimals },
    liquidityProgram: JUPITER_LIQUIDITY_PROGRAM, actions,
  };
}

const KAMINO_PROGRAM = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
const KAMINO_MAIN_MARKET = "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";
const KAMINO_MAIN_MARKET_AUTHORITY = "9DrvZvyWh1HuAoZxvYWMvkf2XCzryCpGgHqrMjyDWpmo";

function kaminoReserve(asset: string, reserve: string, supplyVault?: string): KaminoReserveVenue {
  const slug = asset.toLowerCase();
  return {
    id: `solana:kamino:${slug}`, slug, protocol: "kamino", network: "solana", kind: "kamino-reserve",
    name: `Kamino Main ${asset}`, asset, target: KAMINO_PROGRAM, market: KAMINO_MAIN_MARKET, reserve,
    marketAuthority: KAMINO_MAIN_MARKET_AUTHORITY, ...(supplyVault ? { supplyVault } : {}), actions: BOTH,
  };
}

const BASE_AAVE_POOL = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
const BASE_AAVE_DATA = "0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A";
/** Arbitrum, OP Mainnet and Polygon share the Pool and data-provider addresses (different deployments). */
const L2_AAVE_POOL = "0x794a61358D6845594F94dc1DB02A252b5b4814aD";
const L2_AAVE_DATA = "0x243Aa95cAC2a25651eda86e80bEe66114413c43b";
const ETHEREUM_AAVE_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const ETHEREUM_AAVE_DATA = "0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD";
const BASE_MOONWELL = "0xfBb21d0380beE3312B33c4353c8936a0F13EF26C";
const OPTIMISM_MOONWELL = "0xCa889f40aae37FFf165BccF69aeF1E82b5C511B9";

/**
 * Curated deposit/withdraw venues. Within one (network, protocol, asset) the
 * first entry is the default the planner picks when no venue is named.
 */
export const YIELD_VENUES: readonly YieldVenue[] = Object.freeze([
  // Aave V3 reserves (Pool = spender; aToken = receipt)
  aave("base", BASE_AAVE_POOL, BASE_AAVE_DATA, "USDC", "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB", 6),
  aave("base", BASE_AAVE_POOL, BASE_AAVE_DATA, "WETH", "0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7", 18),
  aave("base", BASE_AAVE_POOL, BASE_AAVE_DATA, "cbBTC", "0xBdb9300b7CDE636d9cD4AFF00f6F009fFBBc8EE6", 8),
  aave("arbitrum", L2_AAVE_POOL, L2_AAVE_DATA, "USDC", "0x724dc807b04555b71ed48a6896b6F41593b8C637", 6),
  aave("arbitrum", L2_AAVE_POOL, L2_AAVE_DATA, "WETH", "0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8", 18),
  aave("ethereum", ETHEREUM_AAVE_POOL, ETHEREUM_AAVE_DATA, "USDC", "0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c", 6),
  aave("ethereum", ETHEREUM_AAVE_POOL, ETHEREUM_AAVE_DATA, "WETH", "0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8", 18),
  aave("optimism", L2_AAVE_POOL, L2_AAVE_DATA, "USDC", "0x38d693cE1dF5AaDF7bC62595A37D667aD57922e5", 6),
  aave("optimism", L2_AAVE_POOL, L2_AAVE_DATA, "WETH", "0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8", 18),
  aave("polygon", L2_AAVE_POOL, L2_AAVE_DATA, "USDC", "0xA4D94019934D8333Ef880ABFFbF2FDd611C762BD", 6),
  aave("polygon", L2_AAVE_POOL, L2_AAVE_DATA, "WETH", "0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8", 18),
  // Compound V3 Comets (base asset only)
  comet("base", "0xb125E6687d4313864e53df431d5425969c15Eb2F", "USDC", 6),
  comet("base", "0x46e6b214b524310239732D51387075E0e70970bf", "WETH", 18),
  comet("arbitrum", "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf", "USDC", 6),
  comet("arbitrum", "0x6f7D514bbD4aFf3BcD1140B7344b32f063dEe486", "WETH", 18),
  comet("ethereum", "0xc3d688B66703497DAA19211EEdff47f25384cdc3", "USDC", 6),
  comet("ethereum", "0xA17581A9E3356d9A858b789D68B4d866e593aE94", "WETH", 18),
  comet("optimism", "0x2e44e174f7D53F0212823acC11C01A11d58c5bCB", "USDC", 6),
  comet("optimism", "0xE36A30D249f7761327fd973001A32010b521b6Fd", "WETH", 18),
  // Moonwell mTokens (8-decimal receipts; recipient must be the account)
  mtoken("base", "0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22", "USDC", BASE_MOONWELL),
  mtoken("base", "0x628ff693426583D9a7FB391E54366292F509D457", "WETH", BASE_MOONWELL, {
    router: "0x70778cfcFC475c7eA0f24cC625Baf6EaE475D0c9",
    payout: "0x1382cFf3CeE10D283DccA55A30496187759e4cAf",
  }),
  mtoken("optimism", "0x8E08617b0d66359D73Aa11E11017834C29155525", "USDC", OPTIMISM_MOONWELL),
  mtoken("optimism", "0xb4104C02BBf4E9be85AAa41a62974E4e28D59A33", "WETH", OPTIMISM_MOONWELL, {
    router: "0xc4Ab8C031717d7ecCCD653BE898e0f92410E11dC",
    payout: "0xa962F2974A846b30366251f4634384C1e42aeF16",
  }),
  // Morpho ERC-4626 vaults (curated by (network, address); never resolved by name or symbol)
  vault("base", "steakhouse-prime-usdc", "Steakhouse Prime USDC", "0xbeef0e0834849aCC03f0089F01f4F1Eeb06873C9", "USDC", "vault-v2"),
  vault("base", "gauntlet-usdc-prime", "Gauntlet USDC Prime", "0x050cE30b927Da55177A4914EC73480238BAD56f0", "USDC", "vault-v2"),
  vault("base", "gauntlet-usdc-prime-v1", "Gauntlet USDC Prime (V1)", "0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61", "USDC", "metamorpho-v1.0"),
  vault("base", "spark-usdc", "Spark USDC Vault", "0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A", "USDC", "metamorpho-v1.1"),
  vault("base", "moonwell-flagship-eth", "Moonwell Flagship ETH", "0xa0E430870c4604CcfC7B38Ca7845B1FF653D0ff1", "WETH", "metamorpho-v1.0"),
  vault("base", "steakhouse-prime-eth", "Steakhouse Prime ETH", "0xbeef00f0A818894a2Cf111644A5098421611100E", "WETH", "vault-v2"),
  vault("arbitrum", "steakhouse-high-yield-usdc", "Steakhouse High Yield USDC", "0x5c0C306Aaa9F877de636f4d5822cA9F2E81563BA", "USDC", "metamorpho-v1.1"),
  vault("arbitrum", "bitget-steakhouse-usdc", "Bitget x Steakhouse USDC", "0xbeeff1D5dE8F79ff37a151681100B039661da518", "USDC", "vault-v2"),
  vault("ethereum", "steakhouse-prime-usdc", "Steakhouse Prime USDC", "0xbeef088055857739C12CD3765F20b7679Def0f51", "USDC", "vault-v2"),
  vault("ethereum", "gauntlet-usdc-prime", "Gauntlet USDC Prime", "0x8c106EEDAd96553e64287A5A6839c3Cc78afA3D0", "USDC", "vault-v2"),
  // Jupiter Lend Earn (jlToken mint = receipt). jlWSOL is listed for discovery until SOL wrapping is supported.
  jlToken("USDC", "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D", 6),
  jlToken("USDT", "Cmn4v2wipYV41dkakDvCgFJpxhtaaKt11NyWV8pjSE8A", 6),
  jlToken("SOL", "2uQsyo1fXXQkDtcpXnLofWy88PxcvnfH2L8FPSE62FVU", 9, []),
  // Kamino main market reserves (pinned by reserve address: the market also lists decoy USDC reserves)
  kaminoReserve("USDC", "D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59", "Bgq7trRgVMeq33yt235zM2onQ4bRDBsY5EWiTetF4qw6"),
  kaminoReserve("SOL", "d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q", "GafNuUXj9rxGLn4y79dPu6MHSuPWeJR6UtTWuexpGh3U"),
  kaminoReserve("USDT", "H3t6qZ1JkguCNTi9uzVKqQ7dvt2cum4XiXWom6Gn5e5S"),
  kaminoReserve("PYUSD", "2gc9Dm1eB6UgVYFBUN9bWks6Kes9PbWSaPaa9DqyvEiN"),
] satisfies readonly YieldVenue[]);

const VENUE_BY_ID = new Map<string, YieldVenue>(YIELD_VENUES.map((venue) => [venue.id, venue]));

export function getYieldVenue(id: string): YieldVenue | null {
  return VENUE_BY_ID.get(id) ?? null;
}

export function yieldVenuesFor(network: NetworkKey, protocol?: ProtocolId): YieldVenue[] {
  return YIELD_VENUES.filter((venue) => venue.network === network && (!protocol || venue.protocol === protocol));
}

function sameVenueAddress(network: NetworkKey, a: string, b: string): boolean {
  return network.startsWith("solana") ? a === b : a.toLowerCase() === b.toLowerCase();
}

/**
 * Finds a venue on `network` by id, slug, target address or receipt token
 * (case-insensitive on EVM). Never matches across networks.
 */
export function findYieldVenue(network: NetworkKey, reference: string, protocol?: ProtocolId): YieldVenue | null {
  const wanted = reference.trim();
  if (!wanted) return null;
  const candidates = yieldVenuesFor(network, protocol);
  return (
    candidates.find((venue) => venue.id === wanted) ??
    candidates.find((venue) => venue.slug === wanted.toLowerCase()) ??
    candidates.find((venue) => venue.kind !== "kamino-reserve" && venue.kind !== "jupiter-lend" && sameVenueAddress(network, venue.target, wanted)) ??
    candidates.find((venue) => "receipt" in venue && sameVenueAddress(network, venue.receipt.address, wanted)) ??
    candidates.find((venue) => venue.kind === "kamino-reserve" && venue.reserve === wanted) ??
    null
  );
}

/* --------------------------------------------------------- venue contracts */

export type VenueContractRole =
  /** Relay: deposit target, ERC-20 router and approval proxy. */
  | "depository"
  | "erc20-router"
  | "approval-proxy"
  /** LI.FI: the diamond (call target and approval address) and the fee forwarder used in swapData. */
  | "diamond"
  | "fee-forwarder"
  /** deBridge DLN: order source (call target, spender) and destination contracts. */
  | "dln-source"
  | "dln-destination"
  /** Solana programs a venue's transactions invoke. */
  | "program"
  | "liquidity-program"
  | "farms-program"
  /** Name services. */
  | "registry"
  | "universal-resolver"
  | "resolver"
  | "name-program"
  | "tld-parent";

export interface VenueContract {
  readonly protocol: ProtocolId;
  readonly network: NetworkKey;
  readonly role: VenueContractRole;
  readonly address: string;
}

function everyEvm(protocol: ProtocolId, role: VenueContractRole, address: string): VenueContract[] {
  return EVM_PRODUCTION.map((network) => ({ protocol, network, role, address }));
}

export const VENUE_CONTRACTS: readonly VenueContract[] = Object.freeze([
  // Relay (GET /chains protocol.v2.depository and contracts.*; bytecode present on all five EVM networks)
  ...everyEvm("relay", "depository", "0x4cD00E387622C35bDDB9b4c962C136462338BC31"),
  ...everyEvm("relay", "erc20-router", "0xb92fe925DC43a0ECdE6c8b1a2709c170Ec4fFf4f"),
  ...everyEvm("relay", "approval-proxy", "0xCcC88a9d1B4ED6b0EABA998850414b24f1c315bE"),
  { protocol: "relay", network: "solana", role: "depository", address: "99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2" },
  // LI.FI (same diamond on these five networks; Unichain differs, so it is pinned per network)
  ...everyEvm("lifi", "diamond", "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE"),
  ...everyEvm("lifi", "fee-forwarder", "0xCE40449B773a3E6E5e769ADb4e567179d4828cbd"),
  // deBridge DLN
  ...everyEvm("debridge-dln", "dln-source", "0xeF4fB24aD0916217251F553c0596F8Edc630EB66"),
  ...everyEvm("debridge-dln", "dln-destination", "0xE7351Fd770A37282b91D153Ee690B63579D6dd7f"),
  { protocol: "debridge-dln", network: "solana", role: "dln-source", address: "src5qyZHqTqecJV4aY6Cb6zDZLMDzrDKKezs22MPHr4" },
  { protocol: "debridge-dln", network: "solana", role: "dln-destination", address: "dst5MGcFPoBeREFAA5E3tU5ij8m5uVYwkzkSAbsLbNo" },
  // Solana lending programs
  { protocol: "jupiter-lend", network: "solana", role: "program", address: JUPITER_LEND_PROGRAM },
  { protocol: "jupiter-lend", network: "solana", role: "liquidity-program", address: JUPITER_LIQUIDITY_PROGRAM },
  { protocol: "kamino", network: "solana", role: "program", address: KAMINO_PROGRAM },
  { protocol: "kamino", network: "solana", role: "farms-program", address: "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr" },
  // Name services
  { protocol: "ens", network: "ethereum", role: "registry", address: "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e" },
  { protocol: "ens", network: "ethereum", role: "universal-resolver", address: "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe" },
  { protocol: "basenames", network: "base", role: "registry", address: "0xB94704422c2a1E396835A571837Aa5AE53285a95" },
  { protocol: "basenames", network: "base", role: "resolver", address: "0xC6d566A56A1aFf6508b41f6c90ff131615583BCD" },
  { protocol: "basenames", network: "base", role: "resolver", address: "0x426fA03fB86E510d0Dd9F70335Cf102a98b10875" },
  { protocol: "sns", network: "solana", role: "name-program", address: "namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX" },
  { protocol: "sns", network: "solana", role: "tld-parent", address: "58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx" },
] satisfies readonly VenueContract[]);

/** Pinned addresses of `protocol` on `network`, optionally for one role. */
export function venueContracts(protocol: ProtocolId, network: NetworkKey, role?: VenueContractRole): string[] {
  return VENUE_CONTRACTS
    .filter((entry) => entry.protocol === protocol && entry.network === network && (!role || entry.role === role))
    .map((entry) => entry.address);
}

/** True when `address` is a pinned contract of `protocol` on `network` (EVM: case-insensitive). */
export function isVenueContract(protocol: ProtocolId, network: NetworkKey, address: string, role?: VenueContractRole): boolean {
  return venueContracts(protocol, network, role).some((pinned) => sameVenueAddress(network, pinned, address));
}
