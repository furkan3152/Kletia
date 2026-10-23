/**
 * Perpetual futures (perps) model, venue-neutral: venues and their pinned
 * deployments, markets, positions, the request a client sends, quote math
 * (liquidation price, fees, funding) and the venue scorer behind
 * `planPerpsIntent`. Pure and dependency-free: the API reads live markets and
 * builds unsigned payloads; the desk renders the same numbers.
 *
 * Conventions:
 * - USD amounts in requests are decimal strings; prices, rates and estimates
 *   in responses are numbers (display values, never signed).
 * - Funding and borrowing rates are fractions per hour of position size;
 *   positive means the side pays.
 * - A liquidation price is an estimate from the venue's maintenance margin;
 *   null means the position cannot be liquidated by price alone (e.g. a long
 *   whose collateral covers the whole size).
 *
 * Addresses (read back on-chain on 2026-10-23, see docs/platform/perps.md):
 * - GMX v2 (Arbitrum One): gmx-synthetics deployments/arbitrum/*.json, as
 *   shipped in @gmx-io/sdk 2.4.0 `configs/contracts.js`.
 * - Hyperliquid Bridge2 (Arbitrum One): Hyperliquid docs "Bridge2"
 *   (arbiscan 0x2df1…3df7, source hyperliquid-dex/contracts Bridge2.sol).
 * - Drift v2 (Solana): program id from the v2.156.0 IDL (`metadata.address`).
 */
import type { NetworkKey } from "./chains.js";
import type { TransactionRequest } from "./intent.js";
import type { ValidationIssue } from "./validation.js";

export type PerpsVenueId = "gmx-v2" | "drift-v2" | "hyperliquid";
export type PerpsSide = "long" | "short";
/** cancel withdraws a resting Hyperliquid order (`orderId`); the others change a position. */
export type PerpsAction = "open" | "increase" | "decrease" | "close" | "cancel";
/** How the user's wallet authorizes the venue: an EVM or Solana transaction, or EIP-712 typed data relayed to the venue. */
export type PerpsSigning = "evm-transaction" | "solana-transaction" | "eip712";

export const PERPS_VENUE_IDS: readonly PerpsVenueId[] = Object.freeze(["gmx-v2", "hyperliquid", "drift-v2"]);
export const PERPS_SIDES: readonly PerpsSide[] = Object.freeze(["long", "short"]);
export const PERPS_ACTIONS: readonly PerpsAction[] = Object.freeze(["open", "increase", "decrease", "close", "cancel"]);

export const PERPS_LIMITS = Object.freeze({
  /** Leverage cap when no rule book sets `perps.maxLeverage`. */
  defaultMaxLeverage: 20,
  /** Highest `perps.maxLeverage` a rule book may set. */
  policyMaxLeverage: 50,
  minSlippageBps: 1,
  maxSlippageBps: 500,
  defaultSlippageBps: 50,
  /** Largest request accepted (USD of position size). */
  maxSizeUsd: 1_000_000,
  /** Market data older than this is refused (fail closed). */
  maxPriceAgeSeconds: 120,
});

export interface PerpsVenue {
  readonly id: PerpsVenueId;
  readonly name: string;
  readonly network: NetworkKey;
  readonly signing: PerpsSigning;
  /** Collateral assets Kletia builds for (symbols on `network`). */
  readonly collateral: readonly string[];
  /** The venue's own leverage ceiling (markets may set a lower one). */
  readonly maxLeverage: number;
  /** Smallest collateral the venue accepts for a new position, USD. */
  readonly minCollateralUsd: number;
  /** Smallest order the venue accepts, USD of size. */
  readonly minSizeUsd: number;
  /** False while Kletia refuses to prepare for the venue; `disabledReason` says why. */
  readonly enabled: boolean;
  readonly disabledReason: string | null;
  readonly website: string;
}

export const PERPS_VENUES: readonly PerpsVenue[] = Object.freeze([
  {
    id: "gmx-v2",
    name: "GMX v2",
    network: "arbitrum",
    signing: "evm-transaction",
    collateral: ["USDC"],
    maxLeverage: 100,
    // DataStore MIN_COLLATERAL_USD is 1 USD; GMX's own interface asks for 2 USD (execution fee and fees on top).
    minCollateralUsd: 2,
    minSizeUsd: 10,
    enabled: true,
    disabledReason: null,
    website: "https://gmx.io",
  },
  {
    id: "hyperliquid",
    name: "Hyperliquid",
    network: "arbitrum",
    signing: "eip712",
    collateral: ["USDC"],
    maxLeverage: 40,
    // Bridge2 credits deposits of 5 USDC or more; smaller deposits are lost (Hyperliquid docs, Bridge2).
    minCollateralUsd: 5,
    // Orders below 10 USD of notional are rejected by the exchange.
    minSizeUsd: 10,
    enabled: true,
    disabledReason: null,
    website: "https://hyperliquid.xyz",
  },
  {
    id: "drift-v2",
    name: "Drift v2",
    network: "solana",
    signing: "solana-transaction",
    collateral: ["USDC"],
    maxLeverage: 20,
    minCollateralUsd: 1,
    minSizeUsd: 1,
    enabled: false,
    disabledReason:
      "Drift v2 has been halted since the April 1, 2026 exploit (no fills on its markets since). The relaunch runs a different program with USDT settlement that Kletia has not verified, so Kletia reads positions but prepares nothing.",
    website: "https://www.drift.trade",
  },
] satisfies readonly PerpsVenue[]);

export function getPerpsVenue(id: string): PerpsVenue | null {
  return PERPS_VENUES.find((venue) => venue.id === id) ?? null;
}

/* ---------------------------------------------------------- deployments */

/** GMX v2 on Arbitrum One (gmx-synthetics deployments/arbitrum). */
export const GMX_V2_ARBITRUM = Object.freeze({
  chainId: 42161,
  exchangeRouter: "0x7dE39FF2e232A2203196788d37e234cF8F1b83f1",
  /** Spender of collateral approvals (`ExchangeRouter.router()`). */
  router: "0x7452c558d45f8afC8c83dAe62C3f8A5BE19c71f6",
  orderVault: "0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5",
  dataStore: "0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8",
  reader: "0xfA26cBb46e2614609406de08CA1Dc7f70a684184",
  referralStorage: "0xe6fab3F0c7199b0d34d7FbE83394fc0e0D06e99d",
  usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  /** Oracle keeper API of the GMX interface (prices and market info, 10 s cache). */
  api: "https://arbitrum-api.gmxinfra.io",
});

export interface GmxMarketPin {
  readonly symbol: string;
  readonly marketToken: string;
  readonly indexToken: string;
  readonly indexDecimals: number;
  readonly longToken: string;
  readonly shortToken: string;
}

/** USDC-backed GMX v2 markets Kletia builds for (Reader.getMarket read back on 2026-10-23). */
export const GMX_V2_MARKETS: readonly GmxMarketPin[] = Object.freeze([
  { symbol: "ETH", marketToken: "0x70d95587d40A2caf56bd97485aB3Eec10Bee6336", indexToken: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", indexDecimals: 18, longToken: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", shortToken: GMX_V2_ARBITRUM.usdc },
  { symbol: "BTC", marketToken: "0x47c031236e19d024b42f8AE6780E44A573170703", indexToken: "0x47904963fc8b2340414262125aF798B9655E58Cd", indexDecimals: 8, longToken: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", shortToken: GMX_V2_ARBITRUM.usdc },
  { symbol: "SOL", marketToken: "0x09400D9DB990D5ed3f35D7be61DfAEB900Af03C9", indexToken: "0x2bcC6D6CdBbDC0a4071e48bb3B969b06B3330c07", indexDecimals: 9, longToken: "0x2bcC6D6CdBbDC0a4071e48bb3B969b06B3330c07", shortToken: GMX_V2_ARBITRUM.usdc },
]);

/** Hyperliquid mainnet: Bridge2 on Arbitrum One and the public API. */
export const HYPERLIQUID_MAINNET = Object.freeze({
  bridge: "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7",
  usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  minDepositUsdc: 5,
  api: "https://api.hyperliquid.xyz",
  /** Markets Kletia lists (asset ids come from `meta`, never from this list). */
  markets: Object.freeze(["BTC", "ETH", "SOL"]),
});

/** Drift v2 on Solana mainnet. */
export const DRIFT_V2_SOLANA = Object.freeze({
  program: "dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH",
  usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  /** Spot market 0 is USDC; perp market indexes of the markets Kletia lists. */
  usdcSpotMarket: 0,
  perpMarkets: Object.freeze({ SOL: 0, BTC: 1, ETH: 2 } as Readonly<Record<string, number>>),
});

/* ------------------------------------------------------------- models */

export interface PerpsMarket {
  readonly venue: PerpsVenueId;
  /** Base asset symbol ("ETH"). */
  readonly symbol: string;
  /** The venue's market id (GMX market token, Hyperliquid coin, Drift market index). */
  readonly marketId: string;
  readonly network: NetworkKey;
  readonly markPrice: number;
  /** Funding (plus borrowing, where the venue charges it) per hour; positive: the side pays. */
  readonly fundingRate1h: { readonly long: number; readonly short: number };
  /** Open interest in USD; null when the venue does not report it. */
  readonly openInterestUsd: { readonly long: number; readonly short: number } | null;
  readonly maxLeverage: number;
  /** Maintenance margin as a fraction of position size. */
  readonly maintenanceMarginRate: number;
  /** Fee per side (open or close) as a fraction of size. */
  readonly takerFeeRate: number;
  /** Rough price impact per 10,000 USD of size, as a fraction (0 when the venue fills at the oracle price). */
  readonly impactPer10kUsd: number;
  readonly minSizeUsd: number;
  readonly minCollateralUsd: number;
  /** Unix seconds of the price. */
  readonly observedAt: number;
  /** False when the market takes no new positions (halted, reduce-only). */
  readonly open: boolean;
}

export interface PerpsPosition {
  readonly venue: PerpsVenueId;
  readonly symbol: string;
  readonly marketId: string;
  readonly network: NetworkKey;
  readonly side: PerpsSide;
  readonly sizeUsd: number;
  readonly sizeBase: number;
  /** Collateral behind this position; null on cross-margined venues that hold none per position (Drift). */
  readonly collateralUsd: number | null;
  readonly entryPrice: number;
  readonly markPrice: number | null;
  readonly leverage: number | null;
  readonly liquidationPrice: number | null;
  /** Price PnL at the mark, before closing fees and unsettled funding; null without a mark. */
  readonly unrealizedPnlUsd: number | null;
}

export interface PerpsCollateral {
  readonly asset: string;
  /** Decimal string of the asset. */
  readonly amount: string;
}

/** A perps request as clients send it (POST /v1/perps/quote and /prepare). */
export interface PerpsRequest {
  readonly action: PerpsAction;
  readonly symbol: string;
  readonly side: PerpsSide;
  /** Omitted: the scorer picks the best venue (quote only; prepare needs one). */
  readonly venue?: PerpsVenueId;
  /** Position size change in USD (open, increase, decrease). */
  readonly sizeUsd?: string;
  /** Collateral added (open, increase). */
  readonly collateral?: PerpsCollateral;
  readonly leverage?: number;
  readonly slippageBps?: number;
  /** CAIP-10 account on the venue's network. */
  readonly account?: string;
  /** cancel: the venue's order id. */
  readonly orderId?: number;
}

export interface PerpsFees {
  readonly openUsd: number;
  /** Estimated fee to close the whole position later. */
  readonly closeUsd: number;
  /** Network or keeper execution cost, when known (GMX execution fee, gas). */
  readonly executionUsd: number | null;
}

export interface PerpsQuote {
  readonly venue: PerpsVenueId;
  readonly symbol: string;
  readonly side: PerpsSide;
  readonly action: PerpsAction;
  readonly sizeUsd: number;
  readonly collateralUsd: number;
  readonly leverage: number;
  readonly markPrice: number;
  /** Expected fill price including the impact estimate. */
  readonly entryPrice: number;
  /** Worst fill the payload accepts (slippage bound); the venue refuses a worse fill. */
  readonly acceptablePrice: number;
  readonly liquidationPrice: number | null;
  readonly fees: PerpsFees;
  /** Funding (and borrowing) cost of holding the position for one hour; negative: received. */
  readonly funding1hUsd: number;
  readonly warnings: readonly string[];
}

/** EIP-712 typed data as `eth_signTypedData_v4` / viem `signTypedData` take it (EIP712Domain left out). */
export interface PerpsTypedData {
  readonly domain: { readonly name: string; readonly version: string; readonly chainId: number; readonly verifyingContract: string };
  readonly types: Readonly<Record<string, readonly { readonly name: string; readonly type: string }[]>>;
  readonly primaryType: string;
  readonly message: Readonly<Record<string, string>>;
}

/** Hyperliquid L1 action types Kletia builds and relays. */
export type HyperliquidActionType = "order" | "cancel" | "updateLeverage";

/** One thing the wallet does, in order: send a transaction, or sign typed data that Kletia relays to the venue. */
export type PerpsStep =
  | {
      readonly kind: "transaction";
      readonly id: string;
      readonly title: string;
      readonly transaction: TransactionRequest;
      /** Seconds the venue needs after this transaction lands before the next step can succeed (e.g. a bridge credit). */
      readonly settleSeconds?: number;
    }
  | {
      readonly kind: "typed-data";
      readonly id: string;
      readonly title: string;
      readonly typedData: PerpsTypedData;
      /** What POST /v1/perps/submit relays with the signature (Kletia never signs it). */
      readonly relay: { readonly venue: "hyperliquid"; readonly action: Readonly<Record<string, unknown>>; readonly nonce: number };
    };

/** Answer of POST /v1/perps/prepare: unsigned steps for the user's wallet, and the quote they implement. */
export interface PerpsPrepared {
  readonly venue: PerpsVenueId;
  readonly network: NetworkKey;
  readonly account: string;
  /** null for cancel. */
  readonly quote: PerpsQuote | null;
  readonly steps: readonly PerpsStep[];
  /** Unix seconds after which the steps must be prepared again (prices and nonces move). */
  readonly expiresAt: number;
  readonly warnings: readonly string[];
}

/* -------------------------------------------------------------- math */

/**
 * Estimated liquidation price: equity `collateral + side·Q·(P − entry)` meets
 * the maintenance requirement `mmr·Q·P`, with `Q = size / entry` (the
 * Hyperliquid documentation's formula, which GMX and Drift share up to fees).
 */
export function perpsLiquidationPrice(input: {
  readonly side: PerpsSide;
  readonly entryPrice: number;
  readonly sizeUsd: number;
  readonly collateralUsd: number;
  readonly maintenanceMarginRate: number;
}): number | null {
  const { side, entryPrice, sizeUsd, collateralUsd, maintenanceMarginRate: mmr } = input;
  if (!(entryPrice > 0) || !(sizeUsd > 0) || !(mmr >= 0) || mmr >= 1) return null;
  const quantity = sizeUsd / entryPrice;
  const price = side === "long" ? (entryPrice - collateralUsd / quantity) / (1 - mmr) : (entryPrice + collateralUsd / quantity) / (1 + mmr);
  return Number.isFinite(price) && price > 0 ? price : null;
}

/** Price PnL of a position at `markPrice` (before fees and funding). */
export function perpsPnlUsd(side: PerpsSide, sizeBase: number, entryPrice: number, markPrice: number): number {
  return (side === "long" ? 1 : -1) * sizeBase * (markPrice - entryPrice);
}

/** `price` moved against the order by `bps` (a long buys at most this much, a short sells at least). */
export function perpsAcceptablePrice(side: PerpsSide, opening: boolean, price: number, bps: number): number {
  const buying = (side === "long") === opening;
  return price * (buying ? 1 + bps / 10_000 : 1 - bps / 10_000);
}

const roundCents = (value: number): number => Math.round(value * 100) / 100;

export interface PerpsQuoteInput {
  readonly action: PerpsAction;
  readonly side: PerpsSide;
  readonly sizeUsd: number;
  readonly collateralUsd: number;
  readonly slippageBps: number;
  readonly executionUsd?: number | null;
}

/** Quote of one request at one market (pure; the API adds the venue's execution cost). */
export function perpsQuote(market: PerpsMarket, input: PerpsQuoteInput): PerpsQuote {
  const { action, side, sizeUsd, collateralUsd, slippageBps } = input;
  const opening = action === "open" || action === "increase";
  const impact = market.impactPer10kUsd * (sizeUsd / 10_000);
  const entryPrice = perpsAcceptablePrice(side, opening, market.markPrice, impact * 10_000);
  const openUsd = roundCents(sizeUsd * market.takerFeeRate);
  const leverage = collateralUsd > 0 ? sizeUsd / collateralUsd : 0;
  const warnings: string[] = [];
  const liquidationPrice = opening
    ? perpsLiquidationPrice({ side, entryPrice, sizeUsd, collateralUsd: Math.max(0, collateralUsd - openUsd), maintenanceMarginRate: market.maintenanceMarginRate })
    : null;
  if (opening && leverage >= 10) warnings.push(`At ${leverage.toFixed(1)}x, a ${(100 / leverage).toFixed(1)}% move against you wipes out the collateral before fees.`);
  if (liquidationPrice !== null) {
    const distance = Math.abs(liquidationPrice - entryPrice) / entryPrice;
    if (distance < 0.05) warnings.push(`The estimated liquidation price is only ${(distance * 100).toFixed(1)}% from the entry.`);
  }
  const rate = side === "long" ? market.fundingRate1h.long : market.fundingRate1h.short;
  return {
    venue: market.venue,
    symbol: market.symbol,
    side,
    action,
    sizeUsd: roundCents(sizeUsd),
    collateralUsd: roundCents(collateralUsd),
    leverage: Math.round(leverage * 100) / 100,
    markPrice: market.markPrice,
    entryPrice,
    acceptablePrice: perpsAcceptablePrice(side, opening, market.markPrice, slippageBps),
    liquidationPrice,
    fees: { openUsd, closeUsd: roundCents(sizeUsd * market.takerFeeRate), executionUsd: input.executionUsd ?? null },
    funding1hUsd: Math.round(sizeUsd * rate * 10_000) / 10_000,
    warnings,
  };
}

/* ------------------------------------------------------------- scorer */

export interface PerpsVenueChoice {
  readonly venue: PerpsVenueId;
  readonly eligible: boolean;
  /** Why the venue cannot take the request (eligible false). */
  readonly reason: string | null;
  /** Fees, one day of funding and the impact estimate, in USD; null when ineligible. */
  readonly costUsd: number | null;
  readonly quote: PerpsQuote | null;
}

export interface PerpsScoreRequest {
  readonly action: PerpsAction;
  readonly symbol: string;
  readonly side: PerpsSide;
  readonly sizeUsd: number;
  readonly collateralUsd: number;
  readonly leverage: number;
  readonly slippageBps: number;
  /** Venues the caller's rule book allows (null: all). */
  readonly allowedVenues?: readonly PerpsVenueId[] | null;
  /** Leverage cap of the rule book (or the default). */
  readonly maxLeverage?: number;
  /** Only venues on this network. */
  readonly network?: NetworkKey;
}

/** Hours of funding the scorer charges for (a day: perps are rarely held for minutes). */
export const PERPS_SCORE_FUNDING_HOURS = 24;

/** Ranks venues for a request: eligible venues by cost (cheapest first), then the ineligible ones with their reason. */
export function scorePerpsVenues(request: PerpsScoreRequest, markets: readonly PerpsMarket[]): PerpsVenueChoice[] {
  const choices = PERPS_VENUES.map((venue): PerpsVenueChoice => {
    const refuse = (reason: string): PerpsVenueChoice => ({ venue: venue.id, eligible: false, reason, costUsd: null, quote: null });
    if (!venue.enabled) return refuse(venue.disabledReason ?? `${venue.name} is disabled.`);
    if (request.allowedVenues && !request.allowedVenues.includes(venue.id)) return refuse("The rule book does not allow this venue.");
    if (request.network && venue.network !== request.network) return refuse(`${venue.name} runs on ${venue.network}.`);
    const market = markets.find((entry) => entry.venue === venue.id && entry.symbol === request.symbol);
    if (!market) return refuse(`${venue.name} has no ${request.symbol} market Kletia lists, or its price is unavailable.`);
    if (!market.open) return refuse(`${venue.name}'s ${request.symbol} market takes no new positions.`);
    const cap = Math.min(market.maxLeverage, venue.maxLeverage, request.maxLeverage ?? Number.POSITIVE_INFINITY);
    if (request.leverage > cap) return refuse(`${request.leverage}x is above the ${cap}x cap here.`);
    if (request.action === "open" && request.sizeUsd < market.minSizeUsd) return refuse(`${venue.name} needs at least ${market.minSizeUsd} USD of size.`);
    if (request.action === "open" && request.collateralUsd < market.minCollateralUsd) return refuse(`${venue.name} needs at least ${market.minCollateralUsd} USD of collateral.`);
    const quote = perpsQuote(market, request);
    const impactUsd = Math.abs(quote.entryPrice - quote.markPrice) / quote.markPrice * request.sizeUsd;
    const costUsd = quote.fees.openUsd + quote.fees.closeUsd + (quote.fees.executionUsd ?? 0) + impactUsd + quote.funding1hUsd * PERPS_SCORE_FUNDING_HOURS;
    return { venue: venue.id, eligible: true, reason: null, costUsd: Math.round(costUsd * 100) / 100, quote };
  });
  return [
    ...choices.filter((choice) => choice.eligible).sort((a, b) => (a.costUsd ?? 0) - (b.costUsd ?? 0)),
    ...choices.filter((choice) => !choice.eligible),
  ];
}

/* --------------------------------------------------------- validation */

const USD_PATTERN = /^\d{1,9}(?:\.\d{1,6})?$/u;
const SYMBOL_PATTERN = /^[A-Z0-9]{1,12}$/u;

export type PerpsRequestValidation =
  | { readonly ok: true; readonly value: PerpsRequest; readonly issues: readonly [] }
  | { readonly ok: false; readonly value: null; readonly issues: readonly ValidationIssue[] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Validates a perps request. open and increase need collateral and either a
 * size or a leverage; decrease needs a size; close needs neither (it closes
 * the whole position).
 */
export function validatePerpsRequest(input: unknown): PerpsRequestValidation {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, value: null, issues: [{ path: "", message: "Send a JSON object." }] };
  for (const key of Object.keys(input)) {
    if (!["action", "symbol", "side", "venue", "sizeUsd", "collateral", "leverage", "slippageBps", "account", "orderId"].includes(key)) issues.push({ path: key, message: "Unknown field." });
  }
  const action = input.action ?? "open";
  if (!(PERPS_ACTIONS as readonly unknown[]).includes(action)) issues.push({ path: "action", message: `Use one of ${PERPS_ACTIONS.join(", ")}.` });
  const symbol = typeof input.symbol === "string" ? input.symbol.trim().toUpperCase() : "";
  if (!SYMBOL_PATTERN.test(symbol)) issues.push({ path: "symbol", message: "Use a market symbol such as ETH, BTC or SOL." });
  if (!(PERPS_SIDES as readonly unknown[]).includes(input.side)) issues.push({ path: "side", message: "Use long or short." });
  if (input.venue !== undefined && !(PERPS_VENUE_IDS as readonly unknown[]).includes(input.venue)) issues.push({ path: "venue", message: `Use one of ${PERPS_VENUE_IDS.join(", ")}.` });
  const sizeUsd = input.sizeUsd;
  if (sizeUsd !== undefined && (typeof sizeUsd !== "string" || !USD_PATTERN.test(sizeUsd) || Number(sizeUsd) <= 0 || Number(sizeUsd) > PERPS_LIMITS.maxSizeUsd)) {
    issues.push({ path: "sizeUsd", message: `Use a positive decimal string of at most ${PERPS_LIMITS.maxSizeUsd} USD.` });
  }
  let collateral: PerpsCollateral | undefined;
  if (input.collateral !== undefined) {
    const raw = input.collateral;
    if (!isRecord(raw) || typeof raw.asset !== "string" || typeof raw.amount !== "string" || !USD_PATTERN.test(raw.amount) || Number(raw.amount) <= 0) {
      issues.push({ path: "collateral", message: "Use { asset, amount } with a positive decimal amount." });
    } else collateral = { asset: raw.asset.trim().toUpperCase(), amount: raw.amount };
  }
  const leverage = input.leverage;
  if (leverage !== undefined && (typeof leverage !== "number" || !Number.isFinite(leverage) || leverage < 1 || leverage > 100)) {
    issues.push({ path: "leverage", message: "Use a number from 1 to 100." });
  }
  const slippageBps = input.slippageBps;
  if (slippageBps !== undefined && (!Number.isInteger(slippageBps) || (slippageBps as number) < PERPS_LIMITS.minSlippageBps || (slippageBps as number) > PERPS_LIMITS.maxSlippageBps)) {
    issues.push({ path: "slippageBps", message: `Use an integer from ${PERPS_LIMITS.minSlippageBps} to ${PERPS_LIMITS.maxSlippageBps}.` });
  }
  if (input.account !== undefined && (typeof input.account !== "string" || input.account.length > 200)) issues.push({ path: "account", message: "Use a CAIP-10 account id." });
  if (input.orderId !== undefined && (!Number.isSafeInteger(input.orderId) || (input.orderId as number) < 0)) issues.push({ path: "orderId", message: "Use the venue's numeric order id." });
  if (issues.length === 0) {
    if ((action === "open" || action === "increase") && !collateral) issues.push({ path: "collateral", message: `${action} needs collateral.` });
    if ((action === "open" || action === "increase") && sizeUsd === undefined && leverage === undefined) issues.push({ path: "sizeUsd", message: "Give a size or a leverage." });
    if (action === "decrease" && sizeUsd === undefined) issues.push({ path: "sizeUsd", message: "decrease needs the size to remove." });
    if (action === "cancel" && (input.orderId === undefined || input.venue !== "hyperliquid")) issues.push({ path: "orderId", message: "cancel needs venue hyperliquid and the orderId." });
  }
  if (issues.length > 0) return { ok: false, value: null, issues };
  const value: PerpsRequest = {
    action: action as PerpsAction,
    symbol,
    side: input.side as PerpsSide,
    ...(input.venue !== undefined ? { venue: input.venue as PerpsVenueId } : {}),
    ...(sizeUsd !== undefined ? { sizeUsd: sizeUsd as string } : {}),
    ...(collateral ? { collateral } : {}),
    ...(leverage !== undefined ? { leverage: leverage as number } : {}),
    ...(slippageBps !== undefined ? { slippageBps: slippageBps as number } : {}),
    ...(input.account !== undefined ? { account: input.account as string } : {}),
    ...(input.orderId !== undefined ? { orderId: input.orderId as number } : {}),
  };
  return { ok: true, value, issues: [] };
}

/** Size and collateral (USD) a request asks for, from whichever two of size, collateral and leverage it gives. */
export function perpsRequestAmounts(request: Pick<PerpsRequest, "sizeUsd" | "collateral" | "leverage">): { readonly sizeUsd: number; readonly collateralUsd: number; readonly leverage: number } {
  const collateralUsd = request.collateral ? Number(request.collateral.amount) : 0;
  const sizeUsd = request.sizeUsd !== undefined ? Number(request.sizeUsd) : collateralUsd * (request.leverage ?? 1);
  return { sizeUsd, collateralUsd, leverage: collateralUsd > 0 ? sizeUsd / collateralUsd : 0 };
}
