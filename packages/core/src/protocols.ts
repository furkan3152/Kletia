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
 * 2026-10-09; see docs/networks/*.md for the evidence. The later additions
 * (DEX deployments, SparkLend, Spark Savings, Fluid, Yearn V3, Lido, Rocket
 * Pool, ether.fi, Raydium, Orca, Meteora, Across, CCTP V2 and Pyth) were read
 * back on 2026-10-14: docs/networks/evidence/protocols-2026-10-14.json.
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
  | "solana-actions"
  | "velodrome"
  | "sparklend"
  | "spark-savings"
  | "fluid"
  | "yearn-v3"
  | "lido"
  | "rocket-pool"
  | "etherfi"
  | "raydium"
  | "orca"
  | "meteora"
  | "chainlink"
  | "pyth";

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
  /**
   * Executed outside Platform API v1: "console" (the legacy console routes)
   * or "service" (the API's own paid routes). Such entries never count as
   * executable through the intent engine.
   */
  readonly execution?: "console" | "service";
  /**
   * Protocols whose programs or APIs every transaction of this protocol also
   * uses (Raydium, Orca and Meteora swaps run through the Jupiter program).
   * Rule Books and avoidProtocols apply to the whole chain: see
   * `protocolDependencies`.
   */
  readonly routedVia?: readonly ProtocolId[];
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
    execution: "console",
  },
  {
    id: "uniswap-v3",
    name: "Uniswap V3",
    category: "dex",
    networks: EVM_PRODUCTION,
    capabilities: ["execute", "quote"],
    website: "https://uniswap.org",
    summary: "Concentrated-liquidity AMM: exact-in swaps quoted by the pinned QuoterV2 and sent through the pinned SwapRouter02 with an on-chain minimum output.",
    kinds: ["swap"],
  },
  {
    id: "aerodrome",
    name: "Aerodrome",
    category: "dex",
    networks: ["base"],
    capabilities: ["execute", "quote", "discover"],
    website: "https://aerodrome.finance",
    summary: "Base liquidity hub: Slipstream pools quoted on-chain and swapped through pinned routers with an on-chain minimum output.",
    kinds: ["swap"],
  },
  {
    id: "velodrome",
    name: "Velodrome",
    category: "dex",
    networks: ["optimism"],
    capabilities: ["execute", "quote", "discover"],
    website: "https://velodrome.finance",
    summary: "OP Mainnet liquidity hub: Slipstream pools quoted on-chain and swapped through pinned routers with an on-chain minimum output.",
    kinds: ["swap"],
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
    id: "sparklend",
    name: "SparkLend",
    category: "lending",
    networks: ["ethereum"],
    capabilities: ["execute", "discover"],
    website: "https://spark.fi",
    summary: "Sky-backed money market (Aave V3 fork): supply and withdraw pinned reserves; outcomes proven by Pool Supply/Withdraw events.",
    kinds: ["deposit", "withdraw"],
  },
  {
    id: "spark-savings",
    name: "Spark Savings",
    category: "yield",
    networks: ["ethereum", "base", "arbitrum", "optimism"],
    capabilities: ["execute", "discover"],
    website: "https://spark.fi",
    summary: "Savings vaults at the Sky Savings Rate: sUSDC on four networks, spUSDC and spETH on Ethereum; implementation-pinned ERC-4626.",
    kinds: ["deposit", "withdraw"],
  },
  {
    id: "fluid",
    name: "Fluid Lending",
    category: "lending",
    networks: ["ethereum", "base", "arbitrum", "polygon"],
    capabilities: ["execute", "discover"],
    website: "https://fluid.io",
    summary: "fToken deposits and withdrawals with on-chain share and asset floors; fTokens proven by the Fluid LendingFactory.",
    kinds: ["deposit", "withdraw"],
  },
  {
    id: "yearn-v3",
    name: "Yearn V3",
    category: "yield",
    networks: ["ethereum"],
    capabilities: ["execute", "discover"],
    website: "https://yearn.fi",
    summary: "Registry-endorsed V3 vaults (clones of the 3.0.2 vault); every exit passes an explicit loss limit.",
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
    execution: "console",
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
    execution: "service",
  },
  {
    id: "across",
    name: "Across",
    category: "bridge",
    networks: EVM_PRODUCTION,
    capabilities: ["execute", "quote"],
    website: "https://across.to",
    summary: "Intent bridge: Kletia encodes the SpokePool deposit (exact output, fill deadline); fills are proven on the destination network.",
    crossChain: true,
    kinds: ["bridge"],
  },
  {
    id: "cctp-v2",
    name: "Circle CCTP V2",
    category: "bridge",
    networks: [...EVM_PRODUCTION, "arc", "arbitrum-sepolia", "solana", "solana-devnet"],
    capabilities: ["execute", "quote"],
    website: "https://www.circle.com/cross-chain-transfer-protocol",
    summary: "Native USDC burn-and-mint (Fast Transfer) with Circle's Forwarding Service minting on the destination; the fee is capped on-chain by maxFee.",
    crossChain: true,
    kinds: ["bridge"],
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
    id: "raydium",
    name: "Raydium",
    category: "dex",
    networks: ["solana"],
    capabilities: ["execute", "quote"],
    website: "https://raydium.io",
    summary: "Swaps on one owner-checked Raydium AMM, CLMM or CPMM pool when named (\"via raydium\"), routed through the Jupiter program; every instruction is validated.",
    kinds: ["swap"],
    routedVia: ["jupiter"],
  },
  {
    id: "orca",
    name: "Orca",
    category: "dex",
    networks: ["solana"],
    capabilities: ["execute", "quote"],
    website: "https://www.orca.so",
    summary: "Swaps on one owner-checked Orca Whirlpool when named (\"via orca\"), routed through the Jupiter program; every instruction is validated.",
    kinds: ["swap"],
    routedVia: ["jupiter"],
  },
  {
    id: "meteora",
    name: "Meteora",
    category: "dex",
    networks: ["solana"],
    capabilities: ["execute", "quote"],
    website: "https://www.meteora.ag",
    summary: "Swaps on one owner-checked Meteora DLMM or DAMM v2 pool when named (\"via meteora\"), routed through the Jupiter program; every instruction is validated.",
    kinds: ["swap"],
    routedVia: ["jupiter"],
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
    id: "lido",
    name: "Lido",
    category: "liquid-staking",
    networks: ["ethereum"],
    capabilities: ["execute", "quote"],
    website: "https://lido.fi",
    summary: "Stake ETH for wstETH in one transaction; pause state and stake limit are read before every plan.",
    kinds: ["stake"],
  },
  {
    id: "rocket-pool",
    name: "Rocket Pool",
    category: "liquid-staking",
    networks: ["ethereum"],
    capabilities: ["execute", "quote"],
    website: "https://rocketpool.net",
    summary: "Stake ETH for rETH through the deposit pool resolved from RocketStorage; fee, minimum and capacity are checked.",
    kinds: ["stake"],
  },
  {
    id: "etherfi",
    name: "ether.fi",
    category: "liquid-staking",
    networks: ["ethereum"],
    capabilities: ["execute", "quote"],
    website: "https://ether.fi",
    summary: "Stake ETH for weETH (restaked ETH, slashing risk) through the pinned DepositAdapter.",
    kinds: ["stake"],
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
    execution: "console",
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
    execution: "console",
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
    id: "chainlink",
    name: "Chainlink",
    category: "data",
    networks: EVM_PRODUCTION,
    capabilities: ["discover"],
    website: "https://chain.link",
    summary: "Price feeds read on-chain for Rule Book USD limits and swap guards (heartbeat- and sequencer-checked).",
  },
  {
    id: "pyth",
    name: "Pyth",
    category: "data",
    networks: ["solana"],
    capabilities: ["discover"],
    website: "https://pyth.network",
    summary: "Solana push price feeds (owner-, feed-id- and freshness-checked) as a second source for SOL and Solana LST prices.",
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

/**
 * `protocol` followed by every protocol it is routed through (`routedVia`,
 * transitively, each once). A Rule Book deny of any of them denies the step;
 * an allow list must allow all of them; avoidProtocols drops the adapter.
 */
export function protocolDependencies(id: ProtocolId): readonly ProtocolId[] {
  const out: ProtocolId[] = [];
  const visit = (current: ProtocolId): void => {
    if (out.includes(current)) return;
    out.push(current);
    for (const next of getProtocol(current)?.routedVia ?? []) visit(next);
  };
  visit(id);
  return out;
}

/** True when the registry lists `kind` as executable through `protocol`. */
export function protocolExecutesKind(protocol: ProtocolId, kind: IntentActionKind): boolean {
  const descriptor = getProtocol(protocol);
  return descriptor !== null && descriptor.capabilities.includes("execute") && (descriptor.kinds ?? []).includes(kind);
}

/* ------------------------------------------------------------ yield venues */

export type YieldVenueKind =
  | "aave-reserve"
  | "comet"
  | "erc4626"
  | "ctoken"
  | "jupiter-lend"
  | "kamino-reserve"
  | "fluid-ftoken"
  | "spark-vault"
  | "yearn-vault";
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

/** Aave V3 reserves and Aave V3 forks (SparkLend): same Pool interface, protocol tells them apart. */
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

/** Morpho vaults only; other ERC-4626 families have their own kinds with their own provenance checks. */
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

export interface FluidFTokenVenue extends YieldVenueBase {
  readonly kind: "fluid-ftoken";
  /** The fToken (target = spender = share token). */
  readonly spender: string;
  /** fToken shares, decimals = asset decimals. */
  readonly receipt: ReceiptToken;
  /** getData().lendingFactory_ must equal it and its allTokens() must list the fToken. */
  readonly lendingFactory: string;
  /** getData().liquidity_ must equal it. */
  readonly liquidity: string;
}

export type SparkVaultGeneration = "susdc-v1" | "spark-vault-v2";

export interface SparkVaultVenue extends YieldVenueBase {
  readonly kind: "spark-vault";
  /** The vault (target = spender = share token). */
  readonly spender: string;
  readonly receipt: ReceiptToken;
  readonly generation: SparkVaultGeneration;
  /** EIP-1967 implementation slot must equal it. */
  readonly implementation: string;
  /** susdc-v1: psm() must equal it. */
  readonly psm?: string;
  /** spark-vault-v2: getRoleMember(DEFAULT_ADMIN_ROLE, 0) must equal it. */
  readonly admin?: string;
}

export interface YearnVaultVenue extends YieldVenueBase {
  readonly kind: "yearn-vault";
  /** The vault (target = spender = share token). */
  readonly spender: string;
  readonly receipt: ReceiptToken;
  /** At least one registry must endorse the vault. */
  readonly registries: readonly string[];
  /** apiVersion() must equal it ("3.0.2"). */
  readonly apiVersion: string;
  /** EIP-1167 clone target the vault's code must point to. */
  readonly implementation: string;
}

export type YieldVenue =
  | AaveReserveVenue
  | CometVenue
  | Erc4626Venue
  | CTokenVenue
  | JupiterLendVenue
  | KaminoReserveVenue
  | FluidFTokenVenue
  | SparkVaultVenue
  | YearnVaultVenue;

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
  return aaveFamily("aave-v3", "Aave V3", network, pool, dataProvider, asset, aToken, decimals);
}

function aaveFamily(
  protocol: "aave-v3" | "sparklend",
  label: string,
  network: NetworkKey,
  pool: string,
  dataProvider: string,
  asset: string,
  aToken: string,
  decimals: number,
): AaveReserveVenue {
  const slug = asset.toLowerCase();
  return {
    id: `${network}:${protocol}:${slug}`, slug, protocol, network, kind: "aave-reserve", name: `${label} ${asset}`,
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

function sparkVault(
  network: NetworkKey,
  slug: string,
  name: string,
  address: string,
  asset: string,
  decimals: number,
  generation: SparkVaultGeneration,
  implementation: string,
  pins: { readonly psm?: string; readonly admin?: string },
): SparkVaultVenue {
  return {
    id: `${network}:spark-savings:${slug}`, slug, protocol: "spark-savings", network, kind: "spark-vault", name,
    asset, target: address, spender: address, receipt: { address, decimals }, generation, implementation, ...pins, actions: BOTH,
  };
}

/** Fluid's LendingFactory and Liquidity share one address on every network Kletia uses. */
const FLUID_LENDING_FACTORY = "0x54B91A0D94cb471F37f949c60F7Fa7935b551D03";
const FLUID_LIQUIDITY = "0x52Aa899454998Be5b000Ad077a46Bbe360F4e497";

function fToken(network: NetworkKey, asset: string, address: string, decimals: number): FluidFTokenVenue {
  const slug = asset.toLowerCase();
  return {
    id: `${network}:fluid:${slug}`, slug, protocol: "fluid", network, kind: "fluid-ftoken", name: `Fluid ${asset}`,
    asset, target: address, spender: address, receipt: { address, decimals },
    lendingFactory: FLUID_LENDING_FACTORY, liquidity: FLUID_LIQUIDITY, actions: BOTH,
  };
}

/** Yearn V3: the current and legacy registries, and the 3.0.2 vault every endorsed vault clones. */
const YEARN_REGISTRIES = Object.freeze(["0xd40ecF29e001c76Dcc4cC0D9cd50520CE845B038", "0xff31A1B020c868F6eA3f61Eb953344920EeCA3af"]);
const YEARN_VAULT_ORIGINAL = "0x1ab62413e0cf2eBEb73da7D40C70E7202ae14467";

function yearnVault(network: NetworkKey, slug: string, name: string, address: string, asset: string, decimals: number): YearnVaultVenue {
  return {
    id: `${network}:yearn-v3:${slug}`, slug, protocol: "yearn-v3", network, kind: "yearn-vault", name,
    asset, target: address, spender: address, receipt: { address, decimals },
    registries: YEARN_REGISTRIES, apiVersion: "3.0.2", implementation: YEARN_VAULT_ORIGINAL, actions: BOTH,
  };
}

const SPARKLEND_POOL = "0xC13e21B648A5Ee794902342038FF3aDAB66BE987";
const SPARKLEND_DATA = "0xFc21d6d146E6086B8359705C8b28512a983db0cb";
const SPARK_VAULT_V2_IMPLEMENTATION = "0x1b992302652A92611DCd5090D1Cb388C6377f455";
const SPARK_VAULT_V2_ADMIN = "0x3300f198988e4C9C63F75dF86De36421f06af8c4";

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
  // SparkLend reserves (Aave V3 fork: same venue kind, protocol "sparklend")
  aaveFamily("sparklend", "SparkLend", "ethereum", SPARKLEND_POOL, SPARKLEND_DATA, "USDC", "0x377C3bd93f2a2984E1E7bE6A5C22c525eD4A4815", 6),
  aaveFamily("sparklend", "SparkLend", "ethereum", SPARKLEND_POOL, SPARKLEND_DATA, "WETH", "0x59cD1C87501baa753d0B5B5Ab5D8416A45cD71DB", 18),
  // Spark Savings (sUSDC first: Ethereum's default USDC savings venue)
  sparkVault("ethereum", "usdc", "Spark Savings USDC (sUSDC)", "0xBc65ad17c5C0a2A4D159fa5a503f4992c7B545FE", "USDC", 18, "susdc-v1", "0xf943Cb8D5f06f2bBF352878ebEF3Ec5C537A20bA", { psm: "0xA188EEC8F81263234dA3622A406892F3D630f98c" }),
  sparkVault("ethereum", "spusdc", "Spark Savings USDC (spUSDC)", "0x28B3a8fb53B741A8Fd78c0fb9A6B2393d896a43d", "USDC", 6, "spark-vault-v2", SPARK_VAULT_V2_IMPLEMENTATION, { admin: SPARK_VAULT_V2_ADMIN }),
  sparkVault("ethereum", "speth", "Spark Savings ETH (spETH)", "0xfE6eb3b609a7C8352A241f7F3A21CEA4e9209B8f", "WETH", 18, "spark-vault-v2", SPARK_VAULT_V2_IMPLEMENTATION, { admin: SPARK_VAULT_V2_ADMIN }),
  sparkVault("base", "usdc", "Spark Savings USDC (sUSDC)", "0x3128a0F7f0ea68E7B7c9B00AFa7E41045828e858", "USDC", 18, "susdc-v1", "0x6ACC02ddd82206a44ff4EC13977E63d1a29C7723", { psm: "0x1601843c5E9bC251A3272907010AFa41Fa18347E" }),
  sparkVault("arbitrum", "usdc", "Spark Savings USDC (sUSDC)", "0x940098b108fB7D0a7E374f6eDED7760787464609", "USDC", 18, "susdc-v1", "0xdC8DF20bE448E41FdE88E2478d6Bc4d3C9A092d6", { psm: "0x2B05F8e1cACC6974fD79A673a341Fe1f58d27266" }),
  sparkVault("optimism", "usdc", "Spark Savings USDC (sUSDC)", "0xCF9326e24EBfFBEF22ce1050007A43A3c0B6DB55", "USDC", 18, "susdc-v1", "0x3a1d3A9B0eD182d7B17aa61393D46a4f4EE0CEA5", { psm: "0xe0F9978b907853F354d79188A3dEfbD41978af62" }),
  // Fluid fTokens (proven by the LendingFactory)
  fToken("ethereum", "USDC", "0x9Fb7b4477576Fe5B32be4C1843aFB1e55F251B33", 6),
  fToken("ethereum", "WETH", "0x90551c1795392094FE6D29B758EcCD233cFAa260", 18),
  fToken("arbitrum", "USDC", "0x1A996cb54bb95462040408C06122D45D6Cdb6096", 6),
  fToken("arbitrum", "WETH", "0x45Df0656F8aDf017590009d2f1898eeca4F0a205", 18),
  fToken("base", "USDC", "0xf42f5795D9ac7e9D757dB633D693cD548Cfd9169", 6),
  fToken("base", "WETH", "0x9272D6153133175175Bc276512B2336BE3931CE9", 18),
  fToken("polygon", "USDC", "0x571d456b578fDC34E26E6D636736ED7c0CDB9d89", 6),
  fToken("polygon", "WETH", "0xD3154535E4D0e179583ad694859E4e876EB12d24", 18),
  // Yearn V3 vaults (registry-endorsed clones of the 3.0.2 vault)
  yearnVault("ethereum", "usdc-1", "Yearn V3 USDC-1", "0xBe53A109B494E5c9f97b9Cd39Fe969BE68BF6204", "USDC", 6),
  yearnVault("ethereum", "weth-1", "Yearn V3 WETH-1", "0xc56413869c6CDf96496f2b1eF801fEDBdFA7dDB0", "WETH", 18),
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
  | "tld-parent"
  /** DEX deployments (generated from DEX_DEPLOYMENTS). */
  | "pool-factory"
  | "swap-router"
  | "quoter"
  | "factory-registry"
  /** Lending and savings. */
  | "addresses-provider"
  | "psm"
  | "lending-factory"
  | "liquidity"
  | "vault-original"
  /** EVM liquid staking. */
  | "deposit-target"
  | "lst-token"
  | "underlying-token"
  | "locator"
  | "storage"
  | "liquidity-pool"
  /** Bridges. */
  | "spoke-pool"
  | "spoke-program"
  | "token-messenger"
  | "message-transmitter"
  | "token-minter"
  | "token-messenger-minter"
  /** Data: Pyth's push-oracle receiver. */
  | "receiver";

export interface VenueContract {
  readonly protocol: ProtocolId;
  readonly network: NetworkKey;
  readonly role: VenueContractRole;
  readonly address: string;
  /**
   * Venue label, unique across VENUE_CONTRACTS when set. Solana DEX programs
   * carry their Jupiter route label ("Raydium CLMM", "Whirlpool"), so a
   * Jupiter route plan maps back to exactly one named venue.
   */
  readonly label?: string;
}

function everyEvm(protocol: ProtocolId, role: VenueContractRole, address: string): VenueContract[] {
  return EVM_PRODUCTION.map((network) => ({ protocol, network, role, address }));
}

/* --------------------------------------------------------- DEX deployments */

export type DexDialect = "uniswap-v3" | "slipstream" | "solidly-v2";

export interface DexDeployment {
  /** `${network}:${protocol}:${slug}`. */
  readonly id: string;
  readonly protocol: Extract<ProtocolId, "uniswap-v3" | "aerodrome" | "velodrome">;
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
}

const UNISWAP_FEE_TIERS: readonly number[] = Object.freeze([100, 500, 3000, 10000]);
const SLIPSTREAM_TICK_SPACINGS: readonly number[] = Object.freeze([1, 50, 100, 200, 2000]);
const WRAPPED_NATIVE: Readonly<Partial<Record<NetworkKey, string>>> = Object.freeze({
  ethereum: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  arbitrum: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  optimism: "0x4200000000000000000000000000000000000006",
  polygon: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
  base: "0x4200000000000000000000000000000000000006",
});

function uniswapV3(network: NetworkKey, factory: string, router: string, quoter: string): DexDeployment {
  return {
    id: `${network}:uniswap-v3:v3`, protocol: "uniswap-v3", network, dialect: "uniswap-v3", factory, router, quoter,
    wrappedNative: WRAPPED_NATIVE[network] as string, feeTiers: UNISWAP_FEE_TIERS,
  };
}

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
  }
  return rows;
}

const ACROSS_SPOKE_POOLS: Readonly<Partial<Record<NetworkKey, string>>> = Object.freeze({
  ethereum: "0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5",
  base: "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64",
  arbitrum: "0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A",
  optimism: "0x6f26Bf09B1C792e3228e5467807a900A503c0281",
  polygon: "0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096",
});

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
  // ---- read back 2026-10-14
  // DEX deployments (Uniswap V3, Aerodrome and Velodrome Slipstream)
  ...dexContracts(DEX_DEPLOYMENTS),
  // SparkLend (Aave V3 fork)
  { protocol: "sparklend", network: "ethereum", role: "addresses-provider", address: "0x02C3eA4e34C0cBd694D2adFa2c690EECbC1793eE" },
  // Fluid (same LendingFactory and Liquidity on every network)
  ...(["ethereum", "base", "arbitrum", "polygon"] as const).flatMap((network): VenueContract[] => [
    { protocol: "fluid", network, role: "lending-factory", address: FLUID_LENDING_FACTORY },
    { protocol: "fluid", network, role: "liquidity", address: FLUID_LIQUIDITY },
  ]),
  // Yearn V3 registries (current, legacy) and the vault original every endorsed vault clones
  ...YEARN_REGISTRIES.map((address): VenueContract => ({ protocol: "yearn-v3", network: "ethereum", role: "registry", address })),
  { protocol: "yearn-v3", network: "ethereum", role: "vault-original", address: YEARN_VAULT_ORIGINAL },
  // EVM liquid staking (Ethereum)
  { protocol: "lido", network: "ethereum", role: "deposit-target", address: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0" },
  { protocol: "lido", network: "ethereum", role: "lst-token", address: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84" },
  { protocol: "lido", network: "ethereum", role: "locator", address: "0xC1d0b3DE6792Bf6b4b37EccdcC24e45978Cfd2Eb" },
  { protocol: "rocket-pool", network: "ethereum", role: "storage", address: "0x1d8f8f00cfa6758d7bE78336684788Fb0ee0Fa46" },
  { protocol: "rocket-pool", network: "ethereum", role: "deposit-target", address: "0xCE15294273CFb9D9b628F4D61636623decDF4fdC" },
  { protocol: "rocket-pool", network: "ethereum", role: "lst-token", address: "0xae78736Cd615f374D3085123A210448E74Fc6393" },
  { protocol: "etherfi", network: "ethereum", role: "deposit-target", address: "0xcfC6d9Bd7411962Bfe7145451A7EF71A24b6A7A2" },
  { protocol: "etherfi", network: "ethereum", role: "liquidity-pool", address: "0x308861A430be4cce5502d0A12724771Fc6DaF216" },
  { protocol: "etherfi", network: "ethereum", role: "lst-token", address: "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee" },
  { protocol: "etherfi", network: "ethereum", role: "underlying-token", address: "0x35fA164735182de50811E8e2E824cFb9B6118ac2" },
  // Solana DEX programs, keyed by their Jupiter route label (swaps run through the Jupiter program)
  { protocol: "raydium", network: "solana", role: "program", address: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", label: "Raydium" },
  { protocol: "raydium", network: "solana", role: "program", address: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", label: "Raydium CLMM" },
  { protocol: "raydium", network: "solana", role: "program", address: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", label: "Raydium CP" },
  { protocol: "orca", network: "solana", role: "program", address: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", label: "Whirlpool" },
  { protocol: "meteora", network: "solana", role: "program", address: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", label: "Meteora DLMM" },
  { protocol: "meteora", network: "solana", role: "program", address: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG", label: "Meteora DAMM v2" },
  // Across SpokePools. The Solana spoke program (DLv3Ngg…eAru, read back in the evidence file) is not
  // pinned until Across lists Solana in its networks: every row's network must be one its protocol lists.
  ...Object.entries(ACROSS_SPOKE_POOLS).map(([network, address]): VenueContract => ({
    protocol: "across", network: network as NetworkKey, role: "spoke-pool", address: address as string,
  })),
  // Circle CCTP V2 (same addresses on the five EVM networks)
  ...everyEvm("cctp-v2", "token-messenger", "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d"),
  ...everyEvm("cctp-v2", "message-transmitter", "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64"),
  ...everyEvm("cctp-v2", "token-minter", "0xfd78EE919681417d192449715b2594ab58f5D002"),
  { protocol: "cctp-v2", network: "solana", role: "token-messenger-minter", address: "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe" },
  { protocol: "cctp-v2", network: "solana", role: "message-transmitter", address: "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC" },
  // Pyth (Solana push oracle and its receiver)
  { protocol: "pyth", network: "solana", role: "program", address: "pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT" },
  { protocol: "pyth", network: "solana", role: "receiver", address: "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ" },
] satisfies readonly VenueContract[]);

/** The Solana DEX venue behind a Jupiter route label ("Raydium CLMM" -> raydium), or null. */
export function venueByLabel(label: string): VenueContract | null {
  return VENUE_CONTRACTS.find((entry) => entry.label === label) ?? null;
}

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
