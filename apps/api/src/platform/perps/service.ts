/**
 * Perps service behind /v1/perps: market listing, positions, quotes, the
 * venue scorer (`planPerpsIntent`) and prepare, which returns unsigned
 * transactions or typed data for the user's own wallet. Guards fail closed:
 * a disabled venue, a rule book that does not allow perps or the venue, a
 * leverage above the rule book's or the venue's cap, collateral below the
 * venue's minimum, or a missing or stale price refuse before anything is
 * built. Kletia never signs; Hyperliquid actions the user signed are relayed
 * by `submitPerps` after the signature is checked against the account.
 */
import {
  effectivePerps,
  getPerpsVenue,
  GMX_V2_MARKETS,
  DRIFT_V2_SOLANA,
  HYPERLIQUID_MAINNET,
  parseAccountId,
  perpsAcceptablePrice,
  perpsQuote,
  perpsRequestAmounts,
  scorePerpsVenues,
  validatePerpsRequest,
  PERPS_LIMITS,
  PERPS_VENUES,
  type NetworkKey,
  type PerpsMarket,
  type PerpsPolicyView,
  type PerpsPosition,
  type PerpsPrepared,
  type PerpsQuote,
  type PerpsRequest,
  type PerpsSide,
  type PerpsStep,
  type PerpsVenue,
  type PerpsVenueChoice,
  type PerpsVenueId,
} from "@kletia/core";
import { parseUnits } from "viem";
import { PlatformError } from "../errors.js";
import { buildSolanaTransaction } from "../engine/chains/solana.js";
import { readDriftMarkets, readDriftPositions, driftTradeInstructions } from "./drift.js";
import {
  gmxAllowance,
  gmxApproveTransaction,
  gmxEthUsd,
  gmxExecutionFee,
  gmxOrderTransaction,
  gmxPositionView,
  gmxUsdToPrice,
  readGmxMarkets,
  readGmxRawPositions,
} from "./gmx.js";
import {
  hyperliquidCancelAction,
  hyperliquidDepositTransaction,
  hyperliquidLeverageAction,
  hyperliquidOrderAction,
  hyperliquidPrice,
  hyperliquidSize,
  hyperliquidTypedData,
  readHyperliquidAccount,
  readHyperliquidAssets,
  readHyperliquidPositions,
  relayHyperliquidAction,
  wireDecimal,
  type HyperliquidRelayResult,
} from "./hyperliquid.js";
import { perpsIo, type PerpsIo } from "./io.js";
import type { MsgpackValue } from "./msgpack.js";

/** Seconds a prepared payload stays valid (prices and nonces move). */
export const PERPS_PREPARE_TTL_SECONDS = 60;
/** Market listings are reused for this long (the venues' own APIs cache 10 s). */
const MARKETS_CACHE_MS = 10_000;

/** What an unauthenticated caller (the desk) may do: the project defaults. */
export const DEFAULT_PERPS_POLICY: PerpsPolicyView = effectivePerps([]);

const VENUE_SYMBOLS: Readonly<Record<PerpsVenueId, readonly string[]>> = {
  "gmx-v2": GMX_V2_MARKETS.map((pin) => pin.symbol),
  hyperliquid: HYPERLIQUID_MAINNET.markets,
  "drift-v2": Object.keys(DRIFT_V2_SOLANA.perpMarkets),
};

export interface PerpsUnavailable {
  readonly venue: PerpsVenueId;
  readonly code: string;
  readonly message: string;
}

export interface PerpsMarketsView {
  readonly venues: readonly PerpsVenue[];
  readonly markets: readonly PerpsMarket[];
  /** Venues whose data could not be read (their markets are left out, never guessed). */
  readonly unavailable: readonly PerpsUnavailable[];
}

function unavailable(venue: PerpsVenueId, error: unknown): PerpsUnavailable {
  const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "PROVIDER_UNAVAILABLE";
  return { venue, code, message: error instanceof PlatformError ? error.message : `${getPerpsVenue(venue)?.name ?? venue} could not be read.` };
}

function readVenueMarkets(io: PerpsIo, venue: PerpsVenueId): Promise<PerpsMarket[]> {
  if (venue === "gmx-v2") return readGmxMarkets(io);
  if (venue === "hyperliquid") return readHyperliquidAssets(io).then((assets) => assets.map((asset) => asset.market));
  return readDriftMarkets(io, PERPS_LIMITS.maxPriceAgeSeconds);
}

let marketsCache: { readonly io: PerpsIo; readonly at: number; readonly value: PerpsMarketsView } | null = null;

export async function listPerpsMarkets(io: PerpsIo = perpsIo()): Promise<PerpsMarketsView> {
  if (marketsCache && marketsCache.io === io && io.now() - marketsCache.at < MARKETS_CACHE_MS) return marketsCache.value;
  const settled = await Promise.allSettled(PERPS_VENUES.map((venue) => readVenueMarkets(io, venue.id)));
  const value: PerpsMarketsView = {
    venues: PERPS_VENUES,
    markets: settled.flatMap((result) => (result.status === "fulfilled" ? result.value : [])),
    unavailable: settled.flatMap((result, index) => (result.status === "rejected" ? [unavailable(PERPS_VENUES[index]!.id, result.reason)] : [])),
  };
  marketsCache = { io, at: io.now(), value };
  return value;
}

/** Forgets cached market listings (tests). */
export function resetPerpsCache(): void {
  marketsCache = null;
}

/* ------------------------------------------------------------ positions */

export interface PerpsPositionsView {
  readonly account: string;
  readonly positions: readonly PerpsPosition[];
  readonly unavailable: readonly PerpsUnavailable[];
  /** GMX positions outside the USDC markets Kletia lists (not shown, never guessed). */
  readonly unsupported: number;
}

function parseAccount(accountId: string): NonNullable<ReturnType<typeof parseAccountId>> {
  const parsed = parseAccountId(accountId);
  if (!parsed) throw new PlatformError("ACCOUNT_INVALID", "account must be a CAIP-10 id such as eip155:42161:0x… or solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:<address>.", 400);
  return parsed;
}

async function gmxPositions(io: PerpsIo, address: string): Promise<{ positions: PerpsPosition[]; unsupported: number }> {
  const [raw, markets] = await Promise.all([readGmxRawPositions(io, address), readGmxMarkets(io).catch(() => [] as PerpsMarket[])]);
  return { positions: raw.positions.map((position) => gmxPositionView(position, markets.find((market) => market.marketId === position.pin.marketToken) ?? null)), unsupported: raw.unsupported };
}

/** Open positions of an account on every venue of its VM (EVM: GMX and Hyperliquid; Solana: Drift). */
export async function readPerpsPositions(accountId: string, io: PerpsIo = perpsIo()): Promise<PerpsPositionsView> {
  const account = parseAccount(accountId);
  const reads: [PerpsVenueId, Promise<{ positions: PerpsPosition[]; unsupported: number }>][] =
    account.chain.vm === "evm"
      ? [
          ["gmx-v2", gmxPositions(io, account.address)],
          ["hyperliquid", readHyperliquidPositions(io, account.address).then((positions) => ({ positions, unsupported: 0 }))],
        ]
      : account.chain.key === "solana"
        ? [["drift-v2", readDriftPositions(io, account.address, PERPS_LIMITS.maxPriceAgeSeconds).then((positions) => ({ positions, unsupported: 0 }))]]
        : [];
  const settled = await Promise.allSettled(reads.map(([, read]) => read));
  return {
    account: account.id,
    positions: settled.flatMap((result) => (result.status === "fulfilled" ? result.value.positions : [])),
    unavailable: settled.flatMap((result, index) => (result.status === "rejected" ? [unavailable(reads[index]![0], result.reason)] : [])),
    unsupported: settled.reduce((total, result) => total + (result.status === "fulfilled" ? result.value.unsupported : 0), 0),
  };
}

/* --------------------------------------------------------------- guards */

const opening = (request: PerpsRequest) => request.action === "open" || request.action === "increase";

function assertVenueAllowed(venue: PerpsVenue, policy: PerpsPolicyView): void {
  if (!venue.enabled) throw new PlatformError("PERPS_VENUE_DISABLED", venue.disabledReason ?? `${venue.name} is disabled.`, 422);
  if (!policy.enabled) throw new PlatformError("PERPS_POLICY_DENIED", policy.reason ?? "The rule book does not allow perps.", 403);
  if (!policy.venues.includes(venue.id)) throw new PlatformError("PERPS_POLICY_DENIED", `The rule book does not allow ${venue.name}.`, 403);
}

/** The market of the request, or why there is none (unknown symbol vs. no fresh price). */
function marketFor(venue: PerpsVenue, request: PerpsRequest, markets: readonly PerpsMarket[]): PerpsMarket {
  if (!VENUE_SYMBOLS[venue.id].includes(request.symbol)) {
    throw new PlatformError("PERPS_MARKET_UNSUPPORTED", `Kletia lists no ${venue.name} ${request.symbol} market (${VENUE_SYMBOLS[venue.id].join(", ")}).`, 422);
  }
  const market = markets.find((entry) => entry.venue === venue.id && entry.symbol === request.symbol);
  if (!market) throw new PlatformError("PERPS_PRICE_UNAVAILABLE", `No fresh ${venue.name} ${request.symbol} price, so Kletia will not quote or build.`, 503);
  return market;
}

/** Leverage, collateral and size checks of an order that adds exposure. */
function assertOpenable(venue: PerpsVenue, market: PerpsMarket, request: PerpsRequest, policy: PerpsPolicyView, leverage: number): void {
  if (!market.open) throw new PlatformError("PERPS_MARKET_UNSUPPORTED", `${venue.name}'s ${market.symbol} market takes no new positions.`, 422);
  const asset = request.collateral?.asset ?? "";
  if (!venue.collateral.includes(asset)) throw new PlatformError("PERPS_MARKET_UNSUPPORTED", `${venue.name} collateral is ${venue.collateral.join(" or ")} here, not ${asset}.`, 422);
  if (leverage > policy.maxLeverage) throw new PlatformError("PERPS_LEVERAGE_TOO_HIGH", `${leverage.toFixed(2)}x is above the rule book's ${policy.maxLeverage}x cap.`, 422);
  const cap = Math.min(venue.maxLeverage, market.maxLeverage);
  if (leverage > cap) throw new PlatformError("PERPS_LEVERAGE_TOO_HIGH", `${leverage.toFixed(2)}x is above ${venue.name}'s ${cap}x cap for ${market.symbol}.`, 422);
  const amounts = perpsRequestAmounts(request);
  const minimum = Math.max(venue.minCollateralUsd, market.minCollateralUsd);
  if (request.action === "open" && amounts.collateralUsd < minimum) {
    throw new PlatformError("PERPS_COLLATERAL_TOO_LOW", `${venue.name} needs at least ${minimum} USD of collateral.`, 422);
  }
  if (amounts.sizeUsd < Math.max(venue.minSizeUsd, market.minSizeUsd)) {
    throw new PlatformError("AMOUNT_TOO_SMALL", `${venue.name} orders need at least ${Math.max(venue.minSizeUsd, market.minSizeUsd)} USD of size.`, 422);
  }
}

function validated(input: unknown): PerpsRequest {
  const result = validatePerpsRequest(input);
  if (!result.ok) throw new PlatformError("INVALID_REQUEST", "The perps request is invalid.", 400, result.issues);
  return result.value;
}

/* ---------------------------------------------------------------- quote */

export interface PerpsQuoteView {
  readonly request: PerpsRequest;
  /** The venue the quote is for: the requested one, or the cheapest eligible venue. */
  readonly best: PerpsVenueChoice | null;
  /** Every venue, eligible ones cheapest first, then the others with the reason. */
  readonly choices: readonly PerpsVenueChoice[];
}

function quoteAt(venue: PerpsVenue, market: PerpsMarket, request: PerpsRequest, policy: PerpsPolicyView): PerpsQuote {
  const amounts = perpsRequestAmounts(request);
  if (opening(request)) assertOpenable(venue, market, request, policy, amounts.leverage);
  return perpsQuote(market, { action: request.action, side: request.side, sizeUsd: amounts.sizeUsd, collateralUsd: amounts.collateralUsd, slippageBps: request.slippageBps ?? PERPS_LIMITS.defaultSlippageBps });
}

/** Quote of a request at its venue, or across every venue (scored) when it names none. */
export async function quotePerps(input: unknown, policy: PerpsPolicyView = DEFAULT_PERPS_POLICY, io: PerpsIo = perpsIo(), network?: NetworkKey): Promise<PerpsQuoteView> {
  const request = validated(input);
  if (request.action === "cancel") throw new PlatformError("INVALID_REQUEST", "cancel has nothing to quote; prepare it directly.", 400, [{ path: "action", message: "Quote open, increase, decrease or close." }]);
  if (request.sizeUsd === undefined && !opening(request)) {
    throw new PlatformError("INVALID_REQUEST", "Quoting a decrease or close needs sizeUsd (prepare reads the position itself).", 400, [{ path: "sizeUsd", message: "Required here." }]);
  }
  const { markets } = await listPerpsMarkets(io);
  const amounts = perpsRequestAmounts(request);
  const choices = scorePerpsVenues(
    { ...amounts, action: request.action, symbol: request.symbol, side: request.side, slippageBps: request.slippageBps ?? PERPS_LIMITS.defaultSlippageBps, allowedVenues: policy.enabled ? policy.venues : [], maxLeverage: policy.maxLeverage, ...(network ? { network } : {}) },
    markets,
  );
  if (request.venue) {
    const venue = getPerpsVenue(request.venue)!;
    assertVenueAllowed(venue, policy);
    const quote = quoteAt(venue, marketFor(venue, request, markets), request, policy);
    return { request, best: { venue: venue.id, eligible: true, reason: null, costUsd: choices.find((choice) => choice.venue === venue.id)?.costUsd ?? null, quote }, choices };
  }
  return { request, best: choices.find((choice) => choice.eligible) ?? null, choices };
}

/* ---------------------------------------------------------- reader entry */

/** What the sentence reader extracts ("long ETH 5x with 100 USDC", "short SOL $200 at 3x on Drift", "close my ETH long"). */
export interface PerpsIntentInput {
  readonly market: string;
  readonly side: PerpsSide;
  readonly action?: "open" | "increase" | "decrease" | "close";
  readonly sizeUsd?: string;
  /** USDC amount put up as collateral. */
  readonly collateral?: string;
  readonly leverage?: number;
  readonly venue?: PerpsVenueId;
  readonly network?: NetworkKey;
  readonly account?: string;
}

export interface PerpsIntentPlan {
  /** The request to prepare: venue chosen (cheapest eligible unless named), collateral derived when only size and leverage were given. */
  readonly request: PerpsRequest;
  readonly quote: PerpsQuote | null;
  readonly choices: readonly PerpsVenueChoice[];
}

/**
 * Typed entry point for the sentence reader: turns the extracted slots into a
 * scored, guarded request. Throws PERPS_MARKET_UNSUPPORTED (with each venue's
 * reason in `details.choices`) when no venue can take it. A close or decrease
 * names no size or collateral: the position is read at prepare.
 */
export async function planPerpsIntent(input: PerpsIntentInput, policy: PerpsPolicyView = DEFAULT_PERPS_POLICY, io: PerpsIo = perpsIo()): Promise<PerpsIntentPlan> {
  const action = input.action ?? "open";
  const collateral = input.collateral ?? (input.sizeUsd !== undefined && input.leverage ? (Number(input.sizeUsd) / input.leverage).toFixed(2) : undefined);
  const request = {
    action,
    symbol: input.market.toUpperCase(),
    side: input.side,
    ...(input.venue ? { venue: input.venue } : {}),
    ...(input.sizeUsd !== undefined ? { sizeUsd: input.sizeUsd } : {}),
    ...(collateral !== undefined && (action === "open" || action === "increase") ? { collateral: { asset: "USDC", amount: collateral } } : {}),
    ...(input.leverage !== undefined ? { leverage: input.leverage } : {}),
    ...(input.account ? { account: input.account } : {}),
  };
  if (action === "close" || (action === "decrease" && input.sizeUsd === undefined)) {
    return { request: validated(request), quote: null, choices: [] };
  }
  const view = await quotePerps(request, policy, io, input.network);
  if (!view.best?.quote) {
    throw new PlatformError("PERPS_MARKET_UNSUPPORTED", `No venue can take this ${request.symbol} ${request.side}.`, 422, undefined, undefined, {
      choices: view.choices.map((choice) => ({ venue: choice.venue, reason: choice.reason })),
    });
  }
  return { request: { ...view.request, venue: view.best.venue }, quote: view.best.quote, choices: view.choices };
}

/* -------------------------------------------------------------- prepare */

const ceilCents = (value: number) => Math.ceil(value * 100 - 1e-9) / 100;
const usdcUnits = (usd: number) => parseUnits(ceilCents(usd).toFixed(2), 6);

async function prepareGmx(request: PerpsRequest, address: string, venue: PerpsVenue, policy: PerpsPolicyView, io: PerpsIo): Promise<Omit<PerpsPrepared, "expiresAt">> {
  const market = marketFor(venue, request, await readGmxMarkets(io));
  const pin = GMX_V2_MARKETS.find((entry) => entry.symbol === market.symbol)!;
  const slippageBps = request.slippageBps ?? PERPS_LIMITS.defaultSlippageBps;
  const isLong = request.side === "long";
  const increase = opening(request);
  const [executionFee, ethUsd] = await Promise.all([gmxExecutionFee(io, increase), gmxEthUsd(io)]);
  const executionUsd = Math.round((Number(executionFee) / 1e18) * ethUsd * 100) / 100;
  const steps: PerpsStep[] = [];
  let quote: PerpsQuote;
  let sizeDeltaUsd: bigint;
  let collateralDelta: bigint;
  if (increase) {
    const base = quoteAt(venue, market, request, policy);
    quote = { ...base, fees: { ...base.fees, executionUsd } };
    const amounts = perpsRequestAmounts(request);
    sizeDeltaUsd = parseUnits(amounts.sizeUsd.toFixed(6), 30);
    collateralDelta = parseUnits(request.collateral!.amount, 6);
    if ((await gmxAllowance(io, address)) < collateralDelta) steps.push({ kind: "transaction", id: "approve", title: "Approve USDC for GMX", transaction: gmxApproveTransaction(address, collateralDelta) });
  } else {
    const { positions } = await readGmxRawPositions(io, address);
    const position = positions.find((entry) => entry.pin.symbol === market.symbol && entry.isLong === isLong);
    if (!position) throw new PlatformError("PERPS_POSITION_NOT_FOUND", `No GMX ${market.symbol} ${request.side} with USDC collateral for this account.`, 422);
    const requested = request.action === "close" || request.sizeUsd === undefined ? position.sizeInUsd : parseUnits(request.sizeUsd, 30);
    sizeDeltaUsd = requested >= position.sizeInUsd ? position.sizeInUsd : requested;
    // A partial decrease takes collateral out in proportion, so the leverage stays; a full close returns all of it.
    collateralDelta = sizeDeltaUsd === position.sizeInUsd ? 0n : (position.collateralAmount * sizeDeltaUsd) / position.sizeInUsd;
    const sizeUsd = Number(sizeDeltaUsd / 10n ** 24n) / 1e6;
    quote = perpsQuote(market, { action: request.action, side: request.side, sizeUsd, collateralUsd: Number(position.collateralAmount) / 1e6, slippageBps, executionUsd });
  }
  steps.push({
    kind: "transaction",
    id: "order",
    title: `${increase ? "Open" : request.action === "close" ? "Close" : "Reduce"} the GMX ${market.symbol} ${request.side}`,
    transaction: gmxOrderTransaction({ account: address, pin, isLong, increase, sizeDeltaUsd, collateralDelta, acceptablePrice: gmxUsdToPrice(quote.acceptablePrice, pin.indexDecimals), executionFee }),
  });
  return {
    venue: "gmx-v2",
    network: "arbitrum",
    account: address,
    quote,
    steps,
    warnings: [
      ...quote.warnings,
      "GMX keepers execute the order a few seconds after it lands, at the oracle price; if the price is past the acceptable price, the order is cancelled and the collateral returned.",
      `The ${executionUsd} USD execution fee is paid in ETH; GMX refunds what the keeper does not use.`,
    ],
  };
}

async function prepareHyperliquid(request: PerpsRequest, address: string, venue: PerpsVenue, policy: PerpsPolicyView, io: PerpsIo): Promise<Omit<PerpsPrepared, "expiresAt">> {
  const assets = await readHyperliquidAssets(io);
  const market = marketFor(venue, request, assets.map((asset) => asset.market));
  const asset = assets.find((entry) => entry.symbol === market.symbol)!;
  const nonce = io.now();
  const typed = (id: string, title: string, action: Record<string, MsgpackValue>, at: number): PerpsStep => ({
    kind: "typed-data",
    id,
    title,
    typedData: hyperliquidTypedData(action, at),
    relay: { venue: "hyperliquid", action, nonce: at },
  });
  const signNote = "Hyperliquid orders are EIP-712 messages for chain id 1337; wallets that only sign for the active network (MetaMask) refuse them.";
  if (request.action === "cancel") {
    return { venue: "hyperliquid", network: "arbitrum", account: address, quote: null, steps: [typed("cancel", `Cancel Hyperliquid order ${request.orderId}`, hyperliquidCancelAction(asset.asset, request.orderId!), nonce)], warnings: [signNote] };
  }
  const slippageBps = request.slippageBps ?? PERPS_LIMITS.defaultSlippageBps;
  const account = await readHyperliquidAccount(io, address, asset.symbol);
  const isBuy = (request.side === "long") === opening(request);
  const steps: PerpsStep[] = [];
  const warnings: string[] = [signNote];
  let quote: PerpsQuote;
  let size: string;
  if (opening(request)) {
    const amounts = perpsRequestAmounts(request);
    // Hyperliquid takes integer leverage: round up, so the margin locked never exceeds the collateral given.
    const leverage = Math.max(1, Math.ceil(amounts.leverage - 1e-9));
    assertOpenable(venue, market, request, policy, leverage);
    size = hyperliquidSize(amounts.sizeUsd / market.markPrice, asset.szDecimals);
    const notional = Number(size) * market.markPrice;
    if (!(notional >= venue.minSizeUsd)) throw new PlatformError("AMOUNT_TOO_SMALL", `Hyperliquid orders need at least ${venue.minSizeUsd} USD of size.`, 422);
    quote = perpsQuote(market, { action: request.action, side: request.side, sizeUsd: notional, collateralUsd: notional / leverage, slippageBps });
    const needed = notional / leverage + quote.fees.openUsd;
    if (account.withdrawable < needed) {
      const deposit = Math.max(HYPERLIQUID_MAINNET.minDepositUsdc, ceilCents(needed - account.withdrawable));
      steps.push({ kind: "transaction", id: "deposit", title: `Deposit ${deposit} USDC to Hyperliquid`, transaction: hyperliquidDepositTransaction(address, usdcUnits(deposit)), settleSeconds: 60 });
      warnings.push("Hyperliquid credits the deposit in about a minute; sign the order once it shows up.");
    }
    if (account.szi === null) steps.push(typed("leverage", `Set ${asset.symbol} to ${leverage}x isolated`, hyperliquidLeverageAction(asset.asset, leverage), nonce));
    else warnings.push(`You already hold ${asset.symbol} on Hyperliquid: the order adds to it at that position's margin mode and leverage.`);
  } else {
    const held = account.szi === null ? 0 : Number(account.szi);
    if (held === 0 || (held > 0) !== (request.side === "long")) throw new PlatformError("PERPS_POSITION_NOT_FOUND", `No Hyperliquid ${asset.symbol} ${request.side} for this account.`, 422);
    const heldSize = wireDecimal(Math.abs(held).toString());
    size = request.action === "close" || request.sizeUsd === undefined ? heldSize : hyperliquidSize(Math.min(Number(request.sizeUsd) / market.markPrice, Math.abs(held)), asset.szDecimals);
    if (Number(size) === 0) throw new PlatformError("AMOUNT_TOO_SMALL", `The size rounds to zero at ${asset.symbol}'s ${asset.szDecimals} size decimals.`, 422);
    quote = perpsQuote(market, { action: request.action, side: request.side, sizeUsd: Number(size) * market.markPrice, collateralUsd: 0, slippageBps });
  }
  const limit = perpsAcceptablePrice(request.side, opening(request), market.markPrice, slippageBps);
  const order = hyperliquidOrderAction({ asset: asset.asset, isBuy, price: hyperliquidPrice(limit, asset.szDecimals, !isBuy), size, reduceOnly: !opening(request) });
  steps.push(typed("order", `${opening(request) ? "Open" : request.action === "close" ? "Close" : "Reduce"} the Hyperliquid ${asset.symbol} ${request.side} (${size} ${asset.symbol})`, order, nonce + 1));
  return { venue: "hyperliquid", network: "arbitrum", account: address, quote, steps, warnings: [...quote.warnings, ...warnings] };
}

async function prepareDrift(request: PerpsRequest, authority: string, venue: PerpsVenue, policy: PerpsPolicyView, io: PerpsIo): Promise<Omit<PerpsPrepared, "expiresAt">> {
  const market = marketFor(venue, request, await readDriftMarkets(io, PERPS_LIMITS.maxPriceAgeSeconds));
  const slippageBps = request.slippageBps ?? PERPS_LIMITS.defaultSlippageBps;
  const amounts = perpsRequestAmounts(request);
  const quote = opening(request) ? quoteAt(venue, market, request, policy) : perpsQuote(market, { action: request.action, side: request.side, sizeUsd: amounts.sizeUsd, collateralUsd: 0, slippageBps });
  const instructions = await driftTradeInstructions(io, {
    authority,
    symbol: market.symbol,
    side: request.side,
    reduce: !opening(request),
    baseAmount: request.action === "close" ? "all" : BigInt(Math.floor((amounts.sizeUsd / market.markPrice) * 1e9)),
    limitPrice: quote.acceptablePrice,
    depositUsdc: opening(request) ? parseUnits(request.collateral!.amount, 6) : 0n,
  });
  const built = await buildSolanaTransaction("solana", authority, instructions, 400_000);
  if (!built.simulation?.ok) throw new PlatformError("SIMULATION_FAILED", "The Drift transaction does not simulate, so Kletia will not hand it to the wallet.", 422);
  return {
    venue: "drift-v2",
    network: "solana",
    account: authority,
    quote,
    steps: [{ kind: "transaction", id: "order", title: `Drift ${request.action} ${market.symbol} ${request.side}`, transaction: { vm: "svm", network: "solana", feePayer: authority, transaction: built.transaction, encoding: "base64", lastValidBlockHeight: built.lastValidBlockHeight, description: `Drift ${request.action} ${market.symbol}` } }],
    warnings: quote.warnings,
  };
}

/** Unsigned steps for the user's wallet, after every guard. */
export async function preparePerps(input: unknown, policy: PerpsPolicyView = DEFAULT_PERPS_POLICY, io: PerpsIo = perpsIo()): Promise<PerpsPrepared> {
  const request = validated(input);
  if (!request.venue) throw new PlatformError("INVALID_REQUEST", "prepare needs a venue (quote without one to see the best).", 400, [{ path: "venue", message: "Required for prepare." }]);
  if (!request.account) throw new PlatformError("INVALID_REQUEST", "prepare needs the account that signs.", 400, [{ path: "account", message: "Required for prepare." }]);
  const venue = getPerpsVenue(request.venue)!;
  assertVenueAllowed(venue, policy);
  const account = parseAccount(request.account);
  if (account.chain.key !== venue.network) {
    throw new PlatformError("ACCOUNT_INVALID", `${venue.name} needs an account on ${venue.network} (eip155:42161:0x… for Arbitrum One, solana:… for Solana).`, 400);
  }
  const prepared =
    venue.id === "gmx-v2"
      ? await prepareGmx(request, account.address, venue, policy, io)
      : venue.id === "hyperliquid"
        ? await prepareHyperliquid(request, account.address, venue, policy, io)
        : await prepareDrift(request, account.address, venue, policy, io);
  return { ...prepared, account: account.id, expiresAt: Math.floor(io.now() / 1000) + PERPS_PREPARE_TTL_SECONDS };
}

/* --------------------------------------------------------------- submit */

/** Relays a Hyperliquid action the account signed (POST /v1/perps/submit). */
export async function submitPerps(input: unknown, policy: PerpsPolicyView = DEFAULT_PERPS_POLICY, io: PerpsIo = perpsIo()): Promise<HyperliquidRelayResult> {
  const body = typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  if (body.venue !== "hyperliquid") throw new PlatformError("INVALID_REQUEST", "Only Hyperliquid actions are relayed; other venues settle by the transactions the wallet sends.", 400, [{ path: "venue", message: "Use hyperliquid." }]);
  assertVenueAllowed(getPerpsVenue("hyperliquid")!, policy);
  const account = parseAccount(typeof body.account === "string" ? body.account : "");
  if (account.chain.vm !== "evm") throw new PlatformError("ACCOUNT_INVALID", "Hyperliquid accounts are EVM addresses (eip155:42161:0x…).", 400);
  return relayHyperliquidAction(io, { account: account.address, action: body.action, nonce: body.nonce, signature: body.signature });
}
