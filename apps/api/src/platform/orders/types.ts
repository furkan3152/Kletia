/**
 * Native protocol orders: automation that the protocol itself executes after
 * one user signature (Jupiter Trigger and Recurring on Solana, CoW Protocol
 * on Ethereum, Arbitrum and Base). Kletia only builds what the wallet signs
 * and relays the user's own signature; it never signs, holds keys or funds.
 *
 * `NativeOrderProvider` is the stable contract other packages (automation
 * rules) build on; import it from `platform/orders/index.ts`.
 */
import type { NetworkKey } from "@kletia/core";
import type { ResolvedAsset } from "../engine/assets.js";

export type NativeOrderProtocol = "jupiter-trigger" | "jupiter-recurring" | "cow-protocol";
export type NativeOrderKind = "limit" | "dca";
/** How the protocol runs a plan: a limit order, Jupiter's recurring DCA, or a CoW TWAP. */
export type NativeOrderMechanism = "limit" | "recurring" | "twap";
export type OrderNetwork = Extract<NetworkKey, "solana" | "ethereum" | "arbitrum" | "base">;
export const ORDER_NETWORKS: readonly OrderNetwork[] = Object.freeze(["solana", "ethereum", "arbitrum", "base"]);

/** Which side `amount` counts: the asset sold (default) or the asset bought (limit buys). */
export type OrderAmountSide = "sell" | "buy";

/** A checked order intent (planNativeOrder), before any asset lookup or network read. */
export interface NativeOrderPlan {
  readonly kind: NativeOrderKind;
  readonly protocol: NativeOrderProtocol;
  readonly mechanism: NativeOrderMechanism;
  readonly network: OrderNetwork;
  /** Asset symbols, addresses or mints as given. */
  readonly sell: string;
  readonly buy: string;
  /** Positive decimal amount of the `amountIn` side; for DCA the total sold. */
  readonly amount: string;
  readonly amountIn: OrderAmountSide;
  /** Limit: units of the counter asset per one unit of the `amountIn` asset. DCA: optional price protection. */
  readonly price: string | null;
  /** DCA: seconds between parts. */
  readonly periodSeconds: number | null;
  /** DCA: number of parts. */
  readonly count: number | null;
  /** Limit: unix seconds after which the order stops filling; null for none (Jupiter) or the default (CoW). */
  readonly expiresAt: number | null;
}

/** A plan with resolved assets, base-unit amounts and the owner, as providers receive it. */
export interface NativeOrderRequest {
  readonly plan: NativeOrderPlan;
  readonly owner: string;
  readonly sell: ResolvedAsset;
  readonly buy: ResolvedAsset;
  /** Total base units sold (limit: exact or maximum for a CoW buy order; DCA: the whole deposit). */
  readonly sellAmount: bigint;
  /** Limit: base units bought at least (exact for a CoW buy order). DCA: the protection floor for the whole order, or null. */
  readonly buyAmount: bigint | null;
}

export interface OrderAmount {
  readonly asset: string;
  readonly symbol: string;
  readonly decimals: number;
  /** Base units. */
  readonly amount: string;
  readonly formatted: string;
}

export interface NativeOrderQuote {
  readonly protocol: NativeOrderProtocol;
  readonly mechanism: NativeOrderMechanism;
  readonly network: OrderNetwork;
  readonly sell: OrderAmount;
  /** Limit: least received. DCA: the protection floor, or null without one. */
  readonly buy: OrderAmount | null;
  /** What the market pays now for the same sell amount (null when no quote was available). */
  readonly market: OrderAmount | null;
  /** Limit price versus the market, in percent (positive: above the market for the seller). */
  readonly limitVsMarketPct: number | null;
  readonly schedule: { readonly parts: number; readonly periodSeconds: number; readonly perPart: OrderAmount; readonly endsAt: string } | null;
  readonly expiresAt: string | null;
  readonly fees: string;
  readonly custody: string;
  readonly warnings: readonly string[];
}

/** One thing the wallet does. Only `solana-transaction` and `eip712` come back through POST /v1/orders/submit. */
export type OrderSignRequest =
  | {
      readonly kind: "solana-transaction";
      readonly network: "solana";
      readonly transaction: string;
      readonly encoding: "base64";
      /** sha256 (hex) of the message bytes: the signed transaction must carry exactly this message. */
      readonly messageHash: string;
      readonly description: string;
    }
  | {
      readonly kind: "evm-transaction";
      readonly network: OrderNetwork;
      readonly chainId: number;
      readonly to: string;
      readonly data: string;
      readonly value: "0";
      readonly description: string;
    }
  | {
      readonly kind: "eip712";
      readonly network: OrderNetwork;
      readonly chainId: number;
      readonly typedData: Eip712Payload;
      /** The EIP-712 digest the signature must recover to the owner (or satisfy ERC-1271). */
      readonly digest: string;
      readonly description: string;
    }
  | {
      readonly kind: "safe-transaction";
      readonly network: OrderNetwork;
      readonly chainId: number;
      readonly safe: string;
      readonly to: string;
      readonly data: string;
      readonly value: "0";
      readonly operation: 0;
      readonly description: string;
    };

export interface Eip712Payload {
  readonly domain: { readonly name: string; readonly version: string; readonly chainId: number; readonly verifyingContract: string };
  readonly types: Readonly<Record<string, readonly { readonly name: string; readonly type: string }[]>>;
  readonly primaryType: string;
  readonly message: Readonly<Record<string, unknown>>;
}

/** How the provider relays the user's signature (kept server-side; never shown to clients). */
export type OrderRelay =
  | { readonly kind: "jupiter-execute"; readonly api: "trigger" | "recurring"; readonly requestId: string }
  | { readonly kind: "cow-create"; readonly order: Readonly<Record<string, unknown>>; readonly signingScheme: "eip712" | "eip1271" }
  | { readonly kind: "cow-cancel"; readonly uid: string }
  | { readonly kind: "none" };

/** What a provider prepares: the wallet's steps plus the private relay context. */
export interface PreparedOrderDraft {
  readonly protocol: NativeOrderProtocol;
  readonly action: "create" | "cancel";
  readonly network: OrderNetwork;
  readonly owner: string;
  /** Public order id when it is known before submission (Jupiter Trigger order account, CoW uid). */
  readonly orderId: string | null;
  readonly steps: readonly OrderSignRequest[];
  /** `kletia`: the last step comes back through POST /v1/orders/submit; `wallet`: the wallet or Safe sends everything. */
  readonly submit: "kletia" | "wallet";
  /** Seconds the preparation stays valid. */
  readonly ttlSeconds: number;
  readonly warnings: readonly string[];
  readonly relay: OrderRelay;
  /** EVM owners with code sign through ERC-1271 (checked with isValidSignature at submit). */
  readonly ownerIsContract?: boolean;
}

/** `unknown`: the protocol reported a state Kletia does not recognise (never shown as open or filled). */
export type NativeOrderStatus = "open" | "filled" | "cancelled" | "expired" | "unknown";

export interface NativeOrder {
  /** `<protocol>:<network>:<native id>`. */
  readonly id: string;
  readonly protocol: NativeOrderProtocol;
  readonly mechanism: NativeOrderMechanism;
  readonly network: OrderNetwork;
  readonly owner: string;
  readonly status: NativeOrderStatus;
  readonly sell: OrderAmount;
  /** Limit: least received; DCA: null unless protected. */
  readonly buy: OrderAmount | null;
  readonly sold: OrderAmount;
  readonly bought: OrderAmount;
  readonly createdAt: string | null;
  readonly expiresAt: string | null;
  /** DCA: parts and interval. */
  readonly schedule: { readonly perPart: OrderAmount; readonly periodSeconds: number } | null;
  /** Transaction signatures or hashes the protocol reports for the order. */
  readonly transactions: readonly string[];
  readonly cancellable: boolean;
}

/** The parts of an order id. */
export interface NativeOrderRef {
  readonly protocol: NativeOrderProtocol;
  readonly network: OrderNetwork;
  readonly nativeId: string;
}

export interface OrderSubmission {
  readonly signedTransaction?: string;
  readonly signature?: string;
}

export interface RelayResult {
  readonly orderId: string | null;
  /** Transaction signature (Solana) or order uid (CoW). */
  readonly reference: string;
  readonly status: "submitted" | "cancelled";
}

/**
 * One protocol's native orders. Providers are stateless: Kletia keeps the
 * prepared payload between `prepare`/`cancel` and `relay` and checks the
 * signed payload against it before `relay` is called.
 */
export interface NativeOrderProvider {
  readonly protocol: NativeOrderProtocol;
  readonly networks: readonly OrderNetwork[];
  readonly mechanisms: readonly NativeOrderMechanism[];
  quote(request: NativeOrderRequest): Promise<NativeOrderQuote>;
  prepare(request: NativeOrderRequest): Promise<PreparedOrderDraft>;
  /** The owner's orders on `network` (open and recent history). */
  list(owner: string, network: OrderNetwork): Promise<readonly NativeOrder[]>;
  status(ref: NativeOrderRef, owner: string): Promise<NativeOrder>;
  cancel(ref: NativeOrderRef, owner: string): Promise<PreparedOrderDraft>;
  /** Relays a checked submission (the guard already matched it to `draft`). */
  relay(draft: PreparedOrderDraft, submission: OrderSubmission): Promise<RelayResult>;
}
