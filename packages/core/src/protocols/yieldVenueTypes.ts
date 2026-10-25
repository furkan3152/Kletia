/**
 * Yield venue types, one per venue family.
 */
import type { NetworkKey } from "../chains.js";
import type { ProtocolId } from "./types.js";

/* ------------------------------------------------------------ yield venues */

export type YieldVenueKind =
  | "aave-reserve"
  | "comet"
  | "erc4626"
  | "ctoken"
  | "jupiter-lend"
  | "kamino-reserve"
  | "save-reserve"
  | "fluid-ftoken"
  | "spark-vault"
  | "yearn-vault"
  | "savings-vault";
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
  /**
   * Executed only when a request names the venue (its slug, id or full name): never a default, never ranked into a
   * venue-less or protocol-only deposit (Kamino's JLP and Altcoins markets sit beside the Main market's reserves).
   */
  readonly namedOnly?: true;
}

/** True when Kletia executes `kind` at `venue`; a named-only venue only when the request named it (`named`). */
export function venueExecutes(venue: Pick<YieldVenueBase, "actions" | "namedOnly">, kind: YieldVenueAction, named = false): boolean {
  return venue.actions.includes(kind) && (venue.namedOnly !== true || named);
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

/** Save (ex-Solend) reserve: deposits mint the reserve's cToken (collateral mint) straight into the wallet. */
export interface SaveReserveVenue extends YieldVenueBase {
  readonly kind: "save-reserve";
  readonly market: string;
  readonly reserve: string;
  /** PDA([market], program): owner of the reserve's liquidity supply. */
  readonly marketAuthority: string;
  /** Reserve liquidity supply token account (reserve offset 75). */
  readonly supplyVault: string;
  /** The cToken (reserve collateral mint, offset 227; same decimals as the liquidity). */
  readonly receipt: ReceiptToken;
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

/** Savings tokens: Sky's sUSDS (UUPS proxy) and sDAI (immutable), Ethena's sUSDe (immutable, cooldown exits). */
export type SavingsVaultGeneration = "susds" | "sdai" | "susde";

/** A view call of the vault and the address it must return (provenance pins of a savings vault). */
export interface SavingsVaultPin {
  /** Zero-argument view returning an address ("pot", "silo"). */
  readonly call: string;
  readonly address: string;
}

export interface SavingsVaultVenue extends YieldVenueBase {
  readonly kind: "savings-vault";
  /** The vault (target = spender = share token). */
  readonly spender: string;
  readonly receipt: ReceiptToken;
  readonly generation: SavingsVaultGeneration;
  /** EIP-1967 implementation slot must equal it (upgradeable vaults); null: an immutable vault whose slot must be empty. */
  readonly implementation: string | null;
  /** Every pin's view call must return its address. */
  readonly pins: readonly SavingsVaultPin[];
}

export type YieldVenue =
  | AaveReserveVenue
  | CometVenue
  | Erc4626Venue
  | CTokenVenue
  | JupiterLendVenue
  | KaminoReserveVenue
  | SaveReserveVenue
  | FluidFTokenVenue
  | SparkVaultVenue
  | YearnVaultVenue
  | SavingsVaultVenue;
