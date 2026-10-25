/**
 * Prediction-market service behind /v1/predictions: market search and
 * lists, a market's books and price history, quotes, prepare (unsigned
 * approvals and the EIP-712 order for the user's own wallet), the venue
 * sign-in, the relay of a signed order, open orders and cancels, positions,
 * and redemption of resolved shares.
 *
 * Guards fail closed before anything is built: a venue Kletia did not add,
 * a rule book that does not allow prediction markets or the venue, a stake
 * above the rule book's cap, a market that is closed or not taking orders,
 * an outcome the market does not list, an unreadable fee schedule, an
 * empty or stale book, an order below the venue's minimum, a wallet that is
 * not the account's verified Polymarket Safe or Deposit Wallet (or, with none
 * named, an account that is not a plain wallet), and too little pUSD (or
 * shares). The relay sends only an order prepare built (Kletia's ticket) and
 * the account signed, reads the wallet's ownership on Polygon again, and
 * never works around the venue's location rules. Kletia never signs.
 */
import {
  effectivePredictions,
  findOutcome,
  getPredictionVenue,
  parseAccountId,
  polymarketExchange,
  polymarketOrderAmounts,
  POLYMARKET_POLYGON,
  predictionStakeUsd,
  priceOnTick,
  PREDICTION_LIMITS,
  PREDICTION_VENUES,
  quotePredictionOrder,
  validatePredictionRequest,
  type PolymarketOrderDraft,
  type PolymarketWallet,
  type PolymarketWalletAction,
  type PredictionBook,
  type PredictionMarket,
  type PredictionOutcome,
  type PredictionPolicyView,
  type PredictionPosition,
  type PredictionPrepared,
  type PredictionPricePoint,
  type PredictionQuote,
  type PredictionRequest,
  type PredictionStep,
  type PredictionTypedData,
  type PredictionVenue,
  type PredictionVenueId,
} from "@kletia/core";
import { getAddress, type Hex } from "viem";
import { PlatformError } from "../errors.js";
import {
  approveCall,
  ctfPayoutDenominator,
  erc20Allowance,
  erc20Balance,
  isPlainWallet,
  operatorApproved,
  operatorCall,
  operatorDisclosure,
  redeemCtfCall,
  redeemV2Call,
  shareBalance,
  transferCall,
  wrapCall,
  type WalletCall,
} from "./chain.js";
import { predictionsIo, type PredictionsIo } from "./io.js";
import {
  listGammaEvents,
  polymarketUrls,
  readClobBook,
  readGammaMarket,
  readGammaMarketByCondition,
  readGeoblock,
  readHistory,
  readPositions,
  searchGamma,
  tradable,
  type MarketSort,
  type PredictionCategory,
  PREDICTION_CATEGORIES,
} from "./polymarket.js";
import { openSession, sealSession } from "./session.js";
import {
  clobAuthTypedData,
  clobL2Headers,
  orderHash,
  orderSalt,
  orderTicket,
  readOrderDraft,
  signedTypedData,
  verifyClobAuth,
  verifySignedOrder,
  ZERO_BYTES32,
  type ClobCredentials,
} from "./signing.js";
import {
  cachedPolymarketWallets,
  holderTransaction,
  polymarketWalletsOf,
  safeNonce,
  safeTransactionHash,
  tradingHolder,
  validContractSignature,
  walletLine,
  type PolymarketWalletsView,
  type TradingHolder,
} from "./wallets.js";

/** What an unauthenticated caller (the desk) may do: the project defaults. */
export const DEFAULT_PREDICTIONS_POLICY: PredictionPolicyView = effectivePredictions([]);

const P = POLYMARKET_POLYGON;
const LIST_CACHE_MS = 15_000;
const LIST_LIMIT = 24;
const PROVIDER = "Polymarket";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const usd = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const micros = (value: number) => BigInt(Math.round(value * 1e6));

/* -------------------------------------------------------------- guards */

function guardVenue(venueId: PredictionVenueId, policy: PredictionPolicyView): PredictionVenue {
  const venue = getPredictionVenue(venueId);
  if (!venue || !venue.enabled) throw new PlatformError("PREDICTION_VENUE_DISABLED", venue?.disabledReason ?? "Kletia builds nothing for this venue.", 422);
  if (!policy.enabled) throw new PlatformError("PREDICTION_POLICY_DENIED", policy.reason ?? "This key's rule book does not allow prediction markets.", 403);
  if (!policy.venues.includes(venueId)) throw new PlatformError("PREDICTION_POLICY_DENIED", `This key's rule book does not allow ${venue.name}.`, 403);
  return venue;
}

function guardStake(stakeUsd: number, policy: PredictionPolicyView): void {
  if (stakeUsd > policy.maxStakeUsd) {
    throw new PlatformError("PREDICTION_STAKE_TOO_HIGH", `${usd(stakeUsd)} USD is above the ${usd(policy.maxStakeUsd)} USD cap per order (predictions.maxStakeUsd).`, 422);
  }
}

function invalid(issues: readonly { path: string; message: string }[]): PlatformError {
  return new PlatformError("INVALID_REQUEST", "The prediction order is invalid.", 400, [...issues]);
}

/** The account's trading holder: itself (a plain wallet) or its verified Polymarket Safe or Deposit Wallet. */
function holderOf(io: PredictionsIo, account: string, wallet: string | undefined): Promise<TradingHolder> {
  return tradingHolder(io, account, wallet, (address) => isPlainWallet(io, address));
}

/** The Polygon address of a CAIP-10 account (eip155:137:0x…). */
export function polygonAccount(accountId: unknown): string {
  const parsed = typeof accountId === "string" ? parseAccountId(accountId) : null;
  if (!parsed || parsed.chain.key !== "polygon") throw new PlatformError("ACCOUNT_INVALID", "account must be a CAIP-10 id on Polygon: eip155:137:0x….", 400, [{ path: "account", message: "Polygon account required." }]);
  return getAddress(parsed.address);
}

/* ------------------------------------------------------------- markets */

export interface PredictionMarketsView {
  readonly venues: readonly PredictionVenue[];
  readonly markets: readonly PredictionMarket[];
  readonly query: string | null;
  readonly category: PredictionCategory | null;
  readonly sort: MarketSort;
  readonly categories: readonly string[];
}

export interface MarketsQuery {
  readonly q?: string | null;
  readonly category?: string | null;
  readonly sort?: string | null;
}

const listCache = new Map<string, { readonly at: number; readonly io: PredictionsIo; readonly value: PredictionMarketsView }>();

function sortMarkets(markets: readonly PredictionMarket[], sort: MarketSort): PredictionMarket[] {
  const unique = [...new Map(markets.map((market) => [market.id, market])).values()];
  return unique.sort((a, b) => (sort === "ending" ? Date.parse(a.endDate ?? "9999") - Date.parse(b.endDate ?? "9999") : b.volume24hUsd - a.volume24hUsd));
}

export function readMarketsQuery(input: MarketsQuery): { readonly q: string | null; readonly category: PredictionCategory | null; readonly sort: MarketSort } {
  const q = input.q?.trim() || null;
  if (q !== null && (q.length > PREDICTION_LIMITS.maxQueryLength || /[\p{Cc}\p{Cf}]/u.test(q))) throw invalid([{ path: "q", message: `At most ${PREDICTION_LIMITS.maxQueryLength} printable characters.` }]);
  const category = input.category?.trim() || null;
  if (category !== null && !(PREDICTION_CATEGORIES as readonly string[]).includes(category)) throw invalid([{ path: "category", message: `Use one of ${PREDICTION_CATEGORIES.join(", ")}.` }]);
  const sort = input.sort?.trim() || "volume";
  if (sort !== "volume" && sort !== "ending") throw invalid([{ path: "sort", message: "Use volume or ending." }]);
  return { q, category: category as PredictionCategory | null, sort };
}

/** True once the market's end date is in the past (an unreadable date is not "ended"). */
export function endedBy(market: Pick<PredictionMarket, "endDate">, nowMs: number): boolean {
  const end = market.endDate ? Date.parse(market.endDate) : Number.NaN;
  return Number.isFinite(end) && end <= nowMs;
}

/** Open markets: a search, a category, or the busiest (sort volume) / soonest-ending (sort ending). */
export async function listPredictionMarkets(input: MarketsQuery, io: PredictionsIo = predictionsIo()): Promise<PredictionMarketsView> {
  const { q, category, sort } = readMarketsQuery(input);
  const key = JSON.stringify([q?.toLowerCase(), category, sort]);
  const cached = listCache.get(key);
  if (cached && cached.io === io && io.now() - cached.at < LIST_CACHE_MS) return cached.value;
  const read = q ? await searchGamma(io, q) : await listGammaEvents(io, { ...(category ? { category } : {}), sort, limit: 10 });
  // A market whose end date has passed is waiting for its result, not open: it is left out even while Polymarket still lists it.
  const open = read.filter((market) => tradable(market) && !endedBy(market, io.now()));
  const markets = sortMarkets(open.filter((market) => !category || !q || market.category?.toLowerCase() === category), sort).slice(0, LIST_LIMIT);
  const value: PredictionMarketsView = { venues: PREDICTION_VENUES, markets, query: q, category, sort, categories: PREDICTION_CATEGORIES };
  if (listCache.size > 200) listCache.clear();
  listCache.set(key, { at: io.now(), io, value });
  return value;
}

/** Forgets cached lists (tests). */
export function resetPredictionsCache(): void {
  listCache.clear();
}

export interface OutcomeView extends PredictionOutcome {
  readonly book: PredictionBook | null;
  readonly history: readonly PredictionPricePoint[];
  /** Why the book could not be read, when it could not. */
  readonly unavailable: string | null;
}

export interface PredictionMarketView {
  readonly market: PredictionMarket;
  readonly outcomes: readonly OutcomeView[];
  readonly restrictionNote: string;
  readonly termsUrl: string;
}

/** One market (by Gamma id, or by condition id as positions carry it) with each outcome's book and a week of prices. */
export async function getPredictionMarket(marketId: string, io: PredictionsIo = predictionsIo()): Promise<PredictionMarketView> {
  const byCondition = /^0x[0-9a-fA-F]{64}$/u.test(marketId) ? await readGammaMarketByCondition(io, marketId.toLowerCase()) : null;
  if (byCondition === null && marketId.startsWith("0x")) throw new PlatformError("PREDICTION_MARKET_NOT_FOUND", "No Polymarket market Kletia can read has this condition id.", 404);
  const market = byCondition ?? (await readGammaMarket(io, marketId));
  const outcomes = await Promise.all(market.outcomes.map(async (outcome): Promise<OutcomeView> => {
    const [book, history] = await Promise.allSettled([tradable(market) ? readClobBook(io, outcome.tokenId) : Promise.resolve(null), readHistory(io, outcome.tokenId)]);
    return {
      ...outcome,
      book: book.status === "fulfilled" ? book.value : null,
      history: history.status === "fulfilled" ? history.value : [],
      unavailable: book.status === "rejected" ? (book.reason instanceof PlatformError ? book.reason.message : "The order book could not be read.") : null,
    };
  }));
  const venue = getPredictionVenue("polymarket") as PredictionVenue;
  return { market, outcomes, restrictionNote: venue.restrictionNote, termsUrl: venue.termsUrl };
}

/* ------------------------------------------------- search for sentences */

const STOP_WORDS = new Set(["the", "a", "an", "of", "on", "in", "for", "will", "be", "to", "is", "at", "by", "as", "that", "this", "market", "markets", "does", "do", "who", "what", "which", "win", "wins", "happen"]);

function words(text: string): string[] {
  return text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/gu, "").split(/[^a-z0-9]+/u).filter((word) => word.length > 0);
}

function matches(word: string, tokens: readonly string[]): boolean {
  return tokens.some((token) => token === word || (word.length >= 4 && token.startsWith(word)) || (token.length >= 4 && word.startsWith(token)));
}

export interface MarketCandidates {
  /** Open markets the words match (all of them, after stop words); when none matches every word, every open search result. */
  readonly markets: readonly PredictionMarket[];
  /** True when the markets matched every word of the query. */
  readonly exact: boolean;
}

/**
 * Markets a sentence's words name (the hand-off reader): Polymarket's search,
 * open markets only, narrowed to those whose event, question or name holds
 * every significant word. The caller asks the person to pick when more than
 * one remains: a market is never guessed.
 */
export async function findPredictionMarkets(query: string, io: PredictionsIo = predictionsIo()): Promise<MarketCandidates> {
  const open = sortMarkets((await searchGamma(io, query)).filter(tradable), "volume");
  const wanted = words(query).filter((word) => !STOP_WORDS.has(word));
  const exact = wanted.length === 0 ? [] : open.filter((market) => {
    const tokens = words(`${market.eventTitle ?? ""} ${market.question} ${market.groupTitle ?? ""}`);
    return wanted.every((word) => matches(word, tokens));
  });
  return exact.length > 0 ? { markets: exact, exact: true } : { markets: open, exact: false };
}

/* --------------------------------------------------------------- quote */

interface Guarded {
  readonly request: PredictionRequest;
  readonly market: PredictionMarket;
  readonly outcome: PredictionOutcome;
  readonly book: PredictionBook;
  readonly quote: PredictionQuote;
}

async function guardedQuote(body: unknown, policy: PredictionPolicyView, io: PredictionsIo): Promise<Guarded> {
  const checked = validatePredictionRequest(body);
  if (!checked.ok) throw invalid(checked.issues);
  const request = checked.value;
  guardVenue(request.venue, policy);
  guardStake(predictionStakeUsd(request), policy);
  const market = await readGammaMarket(io, request.marketId);
  if (!tradable(market)) throw new PlatformError("PREDICTION_MARKET_CLOSED", `"${market.question}" is ${market.resolved ? "resolved" : market.closed ? "closed" : "not taking orders"}.`, 422);
  const outcome = findOutcome(market.outcomes, request.outcome);
  if (!outcome) throw new PlatformError("PREDICTION_OUTCOME_UNKNOWN", `"${market.question}" lists ${market.outcomes.map((entry) => entry.label).join(" and ")}, not "${request.outcome}".`, 422);
  if (!market.fees) throw new PlatformError("PREDICTION_PRICE_UNAVAILABLE", "Polymarket lists fees for this market but no fee schedule Kletia can read, so nothing is built.", 503);
  const book = await readClobBook(io, outcome.tokenId);
  if (io.now() / 1000 - book.observedAt > PREDICTION_LIMITS.maxBookAgeSeconds) throw new PlatformError("PREDICTION_PRICE_UNAVAILABLE", "Polymarket's order book is stale, so Kletia neither quotes nor builds.", 503);
  if (book.negRisk !== market.negRisk) throw new PlatformError("PREDICTION_PRICE_UNAVAILABLE", "The market and its order book disagree on the exchange, so nothing is built.", 503);
  if (request.limitPrice !== undefined && priceOnTick(Number(request.limitPrice), book.tickSize, "down") !== String(Number(request.limitPrice))) {
    throw invalid([{ path: "limitPrice", message: `Use a multiple of the market's tick size ${book.tickSize}.` }]);
  }
  const quote = quotePredictionOrder({ ...market, minOrderSize: book.minOrderSize }, outcome, book, {
    side: request.side,
    orderType: request.orderType,
    ...(request.amountUsd !== undefined ? { amountUsd: Number(request.amountUsd) } : {}),
    ...(request.shares !== undefined ? { shares: Number(request.shares) } : {}),
    ...(request.limitPrice !== undefined ? { limitPrice: Number(request.limitPrice) } : {}),
    slippageBps: request.slippageBps ?? PREDICTION_LIMITS.defaultSlippageBps,
    tickSize: book.tickSize,
  });
  if (!quote) throw new PlatformError("PREDICTION_PRICE_UNAVAILABLE", `Nobody is ${request.side === "buy" ? "selling" : "buying"} "${outcome.label}" on this market right now; place a limit order instead.`, 503);
  guardStake(quote.maxLossUsd, policy);
  const warnings = [
    ...quote.warnings,
    ...(market.matchDelaySeconds > 0 ? [`This market waits ${market.matchDelaySeconds} s before matching an order that takes liquidity.`] : []),
  ];
  return { request, market, outcome, book, quote: { ...quote, warnings } };
}

export interface PredictionQuoteView {
  readonly request: PredictionRequest;
  readonly market: Pick<PredictionMarket, "id" | "question" | "endDate" | "url" | "negRisk" | "version">;
  readonly quote: PredictionQuote;
}

export async function quotePrediction(body: unknown, policy: PredictionPolicyView, io: PredictionsIo = predictionsIo()): Promise<PredictionQuoteView> {
  const { request, market, quote } = await guardedQuote(body, policy, io);
  return { request, market: { id: market.id, question: market.question, endDate: market.endDate, url: market.url, negRisk: market.negRisk, version: market.version }, quote };
}

/* ------------------------------------------------------------- prepare */

/** maker, signer and signatureType of the holder's orders (@polymarket/clob-client-v2 createMarketOrder / createOrder). */
function orderRoles(holder: TradingHolder): Pick<PolymarketOrderDraft, "maker" | "signer" | "signatureType"> {
  if (holder.kind === "safe") return { maker: holder.address, signer: holder.owner, signatureType: 2 };
  if (holder.kind === "deposit") return { maker: holder.address, signer: holder.address, signatureType: 3 };
  return { maker: holder.owner, signer: holder.owner, signatureType: 0 };
}

function orderDraft(holder: TradingHolder, guarded: Guarded, nowMs: number): PolymarketOrderDraft {
  const { request, market, outcome, book, quote } = guarded;
  const buy = request.side === "buy";
  const price = request.orderType === "limit" ? (request.limitPrice as string) : priceOnTick(quote.worstPrice, book.tickSize, buy ? "up" : "down");
  const amount = buy && request.orderType === "market" ? (quote.spendCapUsd ?? 0).toFixed(2) : quote.shares.toFixed(2);
  const amounts = price === null ? null : polymarketOrderAmounts({ side: request.side, orderType: request.orderType, amount, price: String(price), tickSize: book.tickSize });
  if (!amounts) throw new PlatformError("PREDICTION_PRICE_UNAVAILABLE", "The order amounts could not be put on the market's price grid, so nothing is built.", 503);
  const shares = Number(buy ? amounts.takerAmount : amounts.makerAmount) / 1e6;
  if (shares < book.minOrderSize) {
    throw new PlatformError("PREDICTION_ORDER_TOO_SMALL", `This order ${buy ? "buys" : "sells"} ${shares} shares; the market's smallest order is ${book.minOrderSize}.`, 422);
  }
  const exchange = polymarketExchange(market.version, book.negRisk);
  return {
    salt: orderSalt(),
    ...orderRoles(holder),
    tokenId: outcome.tokenId,
    makerAmount: amounts.makerAmount.toString(),
    takerAmount: amounts.takerAmount.toString(),
    side: buy ? 0 : 1,
    timestamp: String(nowMs),
    metadata: ZERO_BYTES32,
    builder: ZERO_BYTES32,
    expiration: "0",
    orderType: request.orderType === "market" ? "FAK" : "GTC",
    exchange: exchange.address,
    domainVersion: exchange.domainVersion,
  };
}

/** A transaction step before it is bound to the holder (sent directly, or run through its Safe). */
interface CallStep {
  readonly id: string;
  readonly title: string;
  readonly call: WalletCall;
  readonly disclosure?: string;
}

const holderName = (holder: TradingHolder) => (holder.kind === "account" ? "This wallet" : walletLine(holder));

/** Collateral steps of a buy: pUSD to cover `need` (wrapping USDC.e when short), and exact allowances, all of the holder. */
async function buySteps(io: PredictionsIo, holder: TradingHolder, market: PredictionMarket, exchange: string, need: bigint): Promise<CallStep[]> {
  const steps: CallStep[] = [];
  const at = holder.address;
  const [pusd, usdce] = await Promise.all([erc20Balance(io, P.pusd, at), erc20Balance(io, P.usdce, at)]);
  if (pusd < need) {
    const short = need - pusd;
    if (usdce < short) {
      const hint = holder.kind === "account" ? "" : " Deposit pUSD or USDC.e into it first (Deposit, in the Predict view).";
      throw new PlatformError("PREDICTION_BALANCE_TOO_LOW", `The order can cost up to ${Number(need) / 1e6} pUSD; ${holderName(holder)} holds ${Number(pusd) / 1e6} pUSD and ${Number(usdce) / 1e6} USDC.e on Polygon.${hint}`, 422);
    }
    if ((await erc20Allowance(io, P.usdce, at, P.collateralOnramp)) < short) {
      steps.push({ id: "approve-usdce", title: "Approve USDC.e for wrapping", call: approveCall("USDC.e", P.collateralOnramp, short) });
    }
    steps.push({ id: "wrap", title: "Wrap USDC.e into pUSD", call: wrapCall(at, short) });
  }
  const spenders = market.version === "v1" && market.negRisk ? [exchange, P.negRiskAdapter] : [exchange];
  for (const spender of spenders) {
    if ((await erc20Allowance(io, P.pusd, at, spender)) < need) {
      steps.push({ id: `approve-pusd-${spender === exchange ? "exchange" : "adapter"}`, title: "Approve pUSD for this order", call: approveCall("pUSD", spender, need) });
    }
  }
  // CTF negative-risk orders: the CLOB also checks the Neg Risk Adapter's operator approval (docs "Contracts").
  if (market.version === "v1" && market.negRisk) steps.push(...(await operatorSteps(io, at, P.conditionalTokens, [P.negRiskAdapter])));
  return steps;
}

async function operatorSteps(io: PredictionsIo, holder: string, ledger: string, operators: readonly string[]): Promise<CallStep[]> {
  const steps: CallStep[] = [];
  for (const operator of operators) {
    if (await operatorApproved(io, ledger, holder, operator)) continue;
    steps.push({ id: `operator-${steps.length}`, title: "Allow the exchange to move your shares", call: operatorCall(ledger, operator), disclosure: operatorDisclosure(ledger, operator) });
  }
  return steps;
}

/** Steps of a sell: the holder must hold the shares, and the exchange be an operator of their ledger. */
async function sellSteps(io: PredictionsIo, holder: TradingHolder, market: PredictionMarket, order: PolymarketOrderDraft): Promise<CallStep[]> {
  const ledger = market.version === "v2" ? P.positionManager : P.conditionalTokens;
  const held = await shareBalance(io, ledger, holder.address, order.tokenId);
  if (held === 0n) throw new PlatformError("PREDICTION_POSITION_NOT_FOUND", `${holderName(holder)} holds no shares of that outcome.`, 422);
  if (held < BigInt(order.makerAmount)) throw new PlatformError("PREDICTION_BALANCE_TOO_LOW", `${holderName(holder)} holds ${Number(held) / 1e6} shares of that outcome; the order sells ${Number(order.makerAmount) / 1e6}.`, 422);
  const operators = market.version === "v1" && market.negRisk ? [order.exchange, P.negRiskAdapter] : [order.exchange];
  return operatorSteps(io, holder.address, ledger, operators);
}

/**
 * Binds call steps to the holder: the account sends them, or its Safe runs
 * them (`execTransaction`, each with its SafeTx hash at the Safe's nonce,
 * one after another). A Deposit Wallet refuses any
 * (PREDICTION_WALLET_SETUP_REQUIRED: its transactions run through
 * Polymarket's relayer only).
 */
async function transactionSteps(io: PredictionsIo, holder: TradingHolder, calls: readonly CallStep[]): Promise<PredictionStep[]> {
  if (calls.length === 0) return [];
  const first = holder.kind === "safe" ? await safeNonce(io, holder.address) : 0n;
  return calls.map((entry, index): PredictionStep => {
    const nonce = first + BigInt(index);
    return {
      kind: "transaction",
      id: entry.id,
      title: entry.title,
      transaction: holderTransaction(holder, entry.call),
      ...(entry.disclosure ? { disclosure: entry.disclosure } : {}),
      ...(holder.kind === "safe" ? { safeTx: { safe: holder.address, nonce: nonce.toString(), hash: safeTransactionHash(holder.address, entry.call, nonce) } } : {}),
    };
  });
}

const walletSummary = (holder: TradingHolder): PredictionPrepared["wallet"] => (holder.kind === "account" ? null : { address: holder.address, kind: holder.kind, owner: holder.owner });

function signInStep(account: string, nowMs: number): PredictionStep {
  return { kind: "typed-data", id: "sign-in", title: "Sign in to Polymarket's order book (no funds move)", purpose: "clob-auth", typedData: clobAuthTypedData(account, Math.floor(nowMs / 1000)) };
}

export async function preparePrediction(body: unknown, policy: PredictionPolicyView, io: PredictionsIo = predictionsIo()): Promise<PredictionPrepared> {
  const guarded = await guardedQuote(body, policy, io);
  const { request, market, quote } = guarded;
  if (request.account === undefined) throw invalid([{ path: "account", message: "prepare needs the Polygon account (eip155:137:0x…)." }]);
  const account = polygonAccount(request.account);
  const holder = await holderOf(io, account, request.wallet);
  const now = io.now();
  const order = orderDraft(holder, guarded, now);
  const calls = request.side === "buy"
    ? await buySteps(io, holder, market, order.exchange, micros(quote.maxLossUsd))
    : await sellSteps(io, holder, market, order);
  const steps = await transactionSteps(io, holder, calls);
  if (request.hasSession !== true) steps.push(signInStep(account, now));
  const from = holder.kind === "account" ? "" : ` from ${walletLine(holder)}`;
  steps.push({ kind: "typed-data", id: "order", title: `${request.side === "buy" ? "Buy" : "Sell"} ${quote.outcome} on "${market.question}"${from}`, purpose: "order", typedData: signedTypedData(order) });
  const expiresAt = Math.floor(now / 1000) + PREDICTION_LIMITS.prepareTtlSeconds;
  const ticket = orderTicket(order, expiresAt);
  if (ticket === null) throw new PlatformError("PREDICTION_SESSION_UNAVAILABLE", "This server cannot issue relay tickets (KLETIA_PLATFORM_SECRET is not configured), so it prepares no order.", 503);
  const warnings = [
    ...quote.warnings,
    "You can lose the whole stake: a share pays 1 pUSD only if its outcome wins, 0 if it loses. Prices are the market's odds, not guarantees.",
    ...(steps.some((step) => step.kind === "transaction" && step.disclosure) ? ["One step is an operator approval for all your shares on that ledger; read its note before signing."] : []),
  ];
  return { venue: "polymarket", network: "polygon", account: `eip155:137:${account}`, wallet: walletSummary(holder), quote, steps, order, orderHash: orderHash(order), ticket, expiresAt, warnings };
}

/* ------------------------------------------------------------- session */

function credentialsOf(body: unknown): ClobCredentials | null {
  if (!isRecord(body)) return null;
  const { apiKey, secret, passphrase } = body;
  return typeof apiKey === "string" && typeof secret === "string" && typeof passphrase === "string" && apiKey && secret && passphrase ? { apiKey, secret, passphrase } : null;
}

/** The CLOB's L2 credentials for a verified sign-in: derived when they exist, created otherwise. */
async function deriveCredentials(io: PredictionsIo, headers: Record<string, string>): Promise<ClobCredentials> {
  const base = polymarketUrls().clob;
  const derived = await io.request(PROVIDER, `${base}/auth/derive-api-key`, { headers });
  const found = derived.status === 200 ? credentialsOf(derived.body) : null;
  if (found) return found;
  const created = await io.request(PROVIDER, `${base}/auth/api-key`, { method: "POST", headers });
  const made = created.status === 200 ? credentialsOf(created.body) : null;
  if (made) return made;
  throw relayRefusal(created, "Polymarket did not issue order-book credentials for this wallet");
}

export interface PredictionSessionView {
  readonly account: string;
  /** Without `auth`: what to sign. */
  readonly typedData?: PredictionTypedData;
  /** With `auth`: the sealed session (send it with every relay; it lives 8 hours and moves no funds). */
  readonly session?: string;
  readonly expiresAt?: number;
}

/** POST /v1/predictions/session: { account } returns the sign-in to sign; { account, auth } returns the sealed session. */
export async function predictionSession(body: unknown, policy: PredictionPolicyView, io: PredictionsIo = predictionsIo()): Promise<PredictionSessionView> {
  if (!isRecord(body)) throw invalid([{ path: "", message: "Send { account, auth? }." }]);
  guardVenue("polymarket", policy);
  const account = polygonAccount(body.account);
  const now = io.now();
  if (body.auth === undefined) return { account: `eip155:137:${account}`, typedData: clobAuthTypedData(account, Math.floor(now / 1000)) };
  const headers = await verifyClobAuth(account, body.auth, now);
  const sealed = sealSession(account, await deriveCredentials(io, headers), now);
  return { account: `eip155:137:${account}`, ...sealed };
}

/* -------------------------------------------------------------- relay */

const GEO_WORDS = /\b(?:region|restricted|geoblock|geo-block|jurisdiction|country|close[- ]only)\b/iu;

function venueMessage(response: { readonly body: unknown }): string {
  const body = response.body;
  const text = isRecord(body) ? (body.errorMsg ?? body.error ?? body.message) : body;
  return typeof text === "string" && text.trim() ? text.trim().slice(0, 200) : "no reason given";
}

function relayRefusal(response: { readonly status: number; readonly body: unknown }, what: string): PlatformError {
  const message = venueMessage(response);
  if (response.status === 403 || GEO_WORDS.test(message)) {
    return new PlatformError("PREDICTION_GEOBLOCKED", `Polymarket refused this order for its location rules: ${message}. Kletia does not work around that.`, 403);
  }
  return new PlatformError("PREDICTION_RELAY_REJECTED", `${what}: ${message}.`, 422);
}

export interface PredictionSubmitResult {
  readonly status: "accepted";
  readonly orderId: string;
  /** The CLOB's status: live (resting), matched, delayed, unmatched. */
  readonly orderStatus: string;
  readonly makingAmount: string | null;
  readonly takingAmount: string | null;
  readonly transactionsHashes: readonly string[];
  /** A new session when the request signed in (keep it for the next relay). */
  readonly session?: string;
  readonly sessionExpiresAt?: number;
}

/** Refreshes the CLOB's cached balance and allowance after approvals (best effort: the order answer is authoritative). */
async function refreshAllowance(io: PredictionsIo, credentials: ClobCredentials, account: string, order: PolymarketOrderDraft, nowMs: number): Promise<void> {
  const params = order.side === 0
    ? new URLSearchParams({ asset_type: "COLLATERAL", signature_type: String(order.signatureType) })
    : new URLSearchParams({ asset_type: order.domainVersion === "3" ? "CONDITIONAL-V2" : "CONDITIONAL", token_id: order.tokenId, signature_type: String(order.signatureType) });
  const path = "/balance-allowance/update";
  await io.request(PROVIDER, `${polymarketUrls().clob}${path}?${params}`, { headers: clobL2Headers(credentials, account, Math.floor(nowMs / 1000), "GET", path) }).catch(() => undefined);
}

async function credentialsFor(body: Record<string, unknown>, account: string, io: PredictionsIo, now: number): Promise<{ readonly credentials: ClobCredentials; readonly fresh?: { readonly session: string; readonly expiresAt: number } }> {
  if (body.auth !== undefined) {
    const credentials = await deriveCredentials(io, await verifyClobAuth(account, body.auth, now));
    return { credentials, fresh: sealSession(account, credentials, now) };
  }
  return { credentials: openSession(account, body.session, now) };
}

/**
 * A wallet order's on-chain guard, read fresh: the maker must be the
 * account's Safe (signatureType 2) or Deposit Wallet (3), deployed, derived
 * from the account and naming it as owner; a Deposit Wallet must also accept
 * the packed signature itself (ERC-1271 `isValidSignature`, as the exchange
 * checks it). Anything unread refuses (fail closed).
 */
async function guardWalletOrder(io: PredictionsIo, account: string, order: PolymarketOrderDraft, hash: Hex, signature: Hex): Promise<void> {
  if (order.signatureType === 0) return;
  const holder = await holderOf(io, account, order.maker);
  const expected = order.signatureType === 2 ? "safe" : "deposit";
  const refuse = (message: string) => new PlatformError("PREDICTION_SIGNATURE_INVALID", message, 400, [{ path: "order", message }]);
  if (holder.kind !== expected) throw refuse(`The order's maker is the account's ${holder.kind === "account" ? "own address" : `${holder.kind} wallet`}, not the ${expected === "safe" ? "Safe" : "Deposit Wallet"} its signature type names.`);
  if (expected === "deposit" && !(await validContractSignature(io, order.maker, hash, signature))) {
    throw refuse("The Deposit Wallet does not accept this signature (ERC-1271), so the exchange would refuse it.");
  }
}

/**
 * Relays an order the account signed: the ticket proves prepare built it,
 * the signature must recover to the account, the rule book is read again,
 * and a buy is not sent while Polymarket reports this server's location as
 * restricted. The venue's refusal is returned as it says it.
 */
export async function submitPrediction(body: unknown, policy: PredictionPolicyView, io: PredictionsIo = predictionsIo()): Promise<PredictionSubmitResult> {
  if (!isRecord(body)) throw invalid([{ path: "", message: "Send { venue, account, order, ticket, signature, session | auth }." }]);
  guardVenue(body.venue === undefined ? "polymarket" : (body.venue as PredictionVenueId), policy);
  const account = polygonAccount(body.account);
  const order = readOrderDraft(body.order);
  const now = io.now();
  const verified = await verifySignedOrder(order, body.ticket, body.signature, account, now);
  await guardWalletOrder(io, account, order, verified.orderHash, verified.signature);
  if (order.side === 0) guardStake(Number(order.makerAmount) / 1e6, policy);
  const { credentials, fresh } = await credentialsFor(body, account, io, now);
  if (order.side === 0) {
    const geo = await readGeoblock(io);
    if (geo.blocked) {
      const where = [geo.country, geo.region].filter(Boolean).join("-") || "unknown";
      throw new PlatformError("PREDICTION_GEOBLOCKED", `Polymarket reports the relay's location (${where}) as restricted for new orders, so Kletia does not send this buy. Closing positions may still work; Kletia does not route around the rule.`, 403);
    }
  }
  await refreshAllowance(io, credentials, account, order, now);
  const payload = JSON.stringify({
    deferExec: false,
    postOnly: false,
    order: {
      salt: Number(order.salt), maker: order.maker, signer: order.signer, tokenId: order.tokenId, makerAmount: order.makerAmount, takerAmount: order.takerAmount,
      side: order.side === 0 ? "BUY" : "SELL", signatureType: order.signatureType, timestamp: order.timestamp, expiration: order.expiration, metadata: order.metadata, builder: order.builder,
      signature: verified.signature,
    },
    owner: credentials.apiKey,
    orderType: order.orderType,
  });
  const path = "/order";
  const response = await io.request(PROVIDER, `${polymarketUrls().clob}${path}`, { method: "POST", body: payload, headers: clobL2Headers(credentials, account, Math.floor(now / 1000), "POST", path, payload) });
  const answer = isRecord(response.body) ? response.body : {};
  if (response.status !== 200 || answer.success !== true || typeof answer.orderID !== "string" || !answer.orderID) throw relayRefusal(response, "Polymarket refused the order");
  const hashes = Array.isArray(answer.transactionsHashes) ? answer.transactionsHashes.filter((hash): hash is string => typeof hash === "string") : [];
  return {
    status: "accepted",
    orderId: answer.orderID,
    orderStatus: typeof answer.status === "string" ? answer.status : "unknown",
    makingAmount: typeof answer.makingAmount === "string" && answer.makingAmount ? answer.makingAmount : null,
    takingAmount: typeof answer.takingAmount === "string" && answer.takingAmount ? answer.takingAmount : null,
    transactionsHashes: hashes,
    ...(fresh ? { session: fresh.session, sessionExpiresAt: fresh.expiresAt } : {}),
  };
}

/* -------------------------------------------------------------- orders */

export interface PredictionOpenOrder {
  readonly id: string;
  readonly status: string;
  readonly conditionId: string | null;
  readonly tokenId: string | null;
  readonly outcome: string | null;
  readonly side: "buy" | "sell" | null;
  readonly price: number | null;
  readonly shares: number | null;
  readonly filledShares: number | null;
  readonly orderType: string | null;
  /** Unix seconds. */
  readonly createdAt: number | null;
  /** The address the order trades for (the account, or its Polymarket wallet). */
  readonly maker: string | null;
}

const number = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

export function parseOpenOrders(raw: unknown): PredictionOpenOrder[] {
  const rows = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.data) ? raw.data : [];
  return rows.flatMap((row) => {
    if (!isRecord(row) || typeof row.id !== "string") return [];
    const side = typeof row.side === "string" ? row.side.toLowerCase() : null;
    return [{
      id: row.id,
      status: typeof row.status === "string" ? row.status : "unknown",
      conditionId: typeof row.market === "string" ? row.market : null,
      tokenId: typeof row.asset_id === "string" ? row.asset_id : null,
      outcome: typeof row.outcome === "string" ? row.outcome : null,
      side: side === "buy" || side === "sell" ? side : null,
      price: number(row.price),
      shares: number(row.original_size),
      filledShares: number(row.size_matched),
      orderType: typeof row.order_type === "string" ? row.order_type : null,
      createdAt: number(row.created_at),
      maker: typeof row.maker_address === "string" && /^0x[0-9a-fA-F]{40}$/u.test(row.maker_address) ? getAddress(row.maker_address) : null,
    }];
  });
}

/** An optional `wallet` field: an address, or undefined. */
function walletField(body: Record<string, unknown>): string | undefined {
  if (body.wallet === undefined) return undefined;
  if (typeof body.wallet !== "string" || !/^0x[0-9a-fA-F]{40}$/u.test(body.wallet)) throw invalid([{ path: "wallet", message: "Use your Polymarket wallet's address (0x…), as GET /v1/predictions/wallets lists it." }]);
  return getAddress(body.wallet);
}

/** POST /v1/predictions/orders: the account's open orders on the CLOB (needs the session); with `wallet`, those that wallet makes. */
export async function listPredictionOrders(body: unknown, policy: PredictionPolicyView, io: PredictionsIo = predictionsIo()): Promise<{ readonly account: string; readonly orders: readonly PredictionOpenOrder[] }> {
  if (!isRecord(body)) throw invalid([{ path: "", message: "Send { account, session }." }]);
  guardVenue("polymarket", policy);
  const account = polygonAccount(body.account);
  const now = io.now();
  const credentials = openSession(account, body.session, now);
  const path = "/data/orders";
  const response = await io.request(PROVIDER, `${polymarketUrls().clob}${path}`, { headers: clobL2Headers(credentials, account, Math.floor(now / 1000), "GET", path) });
  if (response.status !== 200) throw relayRefusal(response, "Polymarket did not list the orders");
  const wallet = walletField(body);
  const orders = parseOpenOrders(response.body).filter((order) => wallet === undefined || (order.maker !== null && order.maker.toLowerCase() === wallet.toLowerCase()));
  return { account: `eip155:137:${account}`, orders };
}

/** POST /v1/predictions/orders/cancel: cancels one resting order the session's account placed. */
export async function cancelPredictionOrder(body: unknown, policy: PredictionPolicyView, io: PredictionsIo = predictionsIo()): Promise<{ readonly orderId: string; readonly canceled: boolean; readonly reason: string | null }> {
  if (!isRecord(body)) throw invalid([{ path: "", message: "Send { account, session, orderId }." }]);
  guardVenue("polymarket", policy);
  const account = polygonAccount(body.account);
  const orderId = body.orderId;
  if (typeof orderId !== "string" || !/^0x[0-9a-fA-F]{64}$/u.test(orderId)) throw invalid([{ path: "orderId", message: "Use the order id (0x + 64 hex) from POST /v1/predictions/orders." }]);
  const now = io.now();
  const credentials = openSession(account, body.session, now);
  const path = "/order";
  const payload = JSON.stringify({ orderID: orderId });
  const response = await io.request(PROVIDER, `${polymarketUrls().clob}${path}`, { method: "DELETE", body: payload, headers: clobL2Headers(credentials, account, Math.floor(now / 1000), "DELETE", path, payload) });
  if (response.status !== 200 || !isRecord(response.body)) throw relayRefusal(response, "Polymarket did not cancel the order");
  const canceled = Array.isArray(response.body.canceled) && response.body.canceled.includes(orderId);
  const refused = isRecord(response.body.not_canceled) ? response.body.not_canceled[orderId] : undefined;
  return { orderId, canceled, reason: canceled ? null : typeof refused === "string" ? refused.slice(0, 200) : "Polymarket did not say." };
}

/* ----------------------------------------------------------- positions */

export interface PredictionPositionsView {
  readonly holder: string;
  readonly positions: readonly PredictionPosition[];
  readonly truncated: boolean;
  /** Whether Kletia can trade and redeem for the holder: a plain wallet, or the account's Safe or Deposit Wallet named with `wallet`. */
  readonly tradable: boolean;
  /** The Polymarket wallet read (with `wallet`), as discovery verified it. */
  readonly wallet: PolymarketWallet | null;
}

/**
 * Positions of a Polygon holder: the connected account, the account's
 * Polymarket wallet (`account` + `wallet`, verified as the account's), or
 * any address (`holder`, read only).
 */
export async function readPredictionPositions(query: { readonly account?: string | null; readonly holder?: string | null; readonly wallet?: string | null }, io: PredictionsIo = predictionsIo()): Promise<PredictionPositionsView> {
  if (query.account && query.wallet) {
    const account = polygonAccount(query.account);
    const wanted = query.wallet.toLowerCase();
    const wallet = (await cachedPolymarketWallets(account, io)).wallets.find((entry) => entry.address.toLowerCase() === wanted);
    if (!wallet) throw new PlatformError("PREDICTION_WALLET_NOT_FOUND", `${query.wallet} is not a Polymarket wallet Kletia could verify for ${account}.`, 422);
    const read = await readPositions(io, wallet.address);
    return { holder: wallet.address, positions: read.positions, truncated: read.truncated, tradable: wallet.tradable, wallet };
  }
  const holder = query.account ? polygonAccount(query.account) : query.holder && /^0x[0-9a-fA-F]{40}$/u.test(query.holder) ? getAddress(query.holder) : null;
  if (!holder) throw invalid([{ path: "account", message: "Send ?account=eip155:137:0x… (with &wallet=0x… for its Polymarket wallet) or ?holder=0x…." }]);
  const [read, plain] = await Promise.all([readPositions(io, holder), isPlainWallet(io, holder).catch(() => false)]);
  return { holder, positions: read.positions, truncated: read.truncated, tradable: plain, wallet: null };
}

/* ------------------------------------------------------------- wallets */

export interface PolymarketWalletsAnswer extends PolymarketWalletsView {
  readonly account: string;
  /** Whether the account itself is a plain wallet (it can trade for itself where Polymarket allows it). */
  readonly plainWallet: boolean;
}

/** GET /v1/predictions/wallets: the account's Polymarket wallets, derived and verified on Polygon, with balances. */
export async function listPolymarketWallets(accountId: unknown, io: PredictionsIo = predictionsIo()): Promise<PolymarketWalletsAnswer> {
  const account = polygonAccount(accountId);
  const [view, plainWallet] = await Promise.all([polymarketWalletsOf(account, io), isPlainWallet(io, account)]);
  return { account: `eip155:137:${account}`, plainWallet, ...view };
}

export interface PredictionWalletActionView {
  readonly venue: "polymarket";
  readonly network: "polygon";
  readonly account: string;
  readonly wallet: NonNullable<PredictionPrepared["wallet"]>;
  readonly action: PolymarketWalletAction;
  readonly steps: readonly PredictionStep[];
  readonly note: string;
}

const WALLET_ACTIONS: readonly PolymarketWalletAction[] = ["deposit", "withdraw", "wrap"];
const WALLET_ASSETS = ["pUSD", "USDC.e"] as const;
type WalletAsset = (typeof WALLET_ASSETS)[number];

interface WalletActionInput {
  readonly account: string;
  readonly wallet: string;
  readonly action: PolymarketWalletAction;
  readonly asset: WalletAsset;
  readonly amount: bigint;
}

function readWalletAction(body: unknown): WalletActionInput {
  if (!isRecord(body)) throw invalid([{ path: "", message: "Send { account, wallet, action, amountUsd, asset? }." }]);
  const account = polygonAccount(body.account);
  const wallet = walletField(body);
  if (wallet === undefined) throw invalid([{ path: "wallet", message: "Name the Polymarket wallet (GET /v1/predictions/wallets)." }]);
  const action = body.action as PolymarketWalletAction;
  if (!WALLET_ACTIONS.includes(action)) throw invalid([{ path: "action", message: `Use one of ${WALLET_ACTIONS.join(", ")}.` }]);
  const asset = (body.asset ?? (action === "wrap" ? "USDC.e" : "pUSD")) as WalletAsset;
  if (!WALLET_ASSETS.includes(asset) || (action === "wrap" && asset !== "USDC.e")) throw invalid([{ path: "asset", message: action === "wrap" ? "wrap turns USDC.e into pUSD." : "Use pUSD or USDC.e." }]);
  const amount = typeof body.amountUsd === "string" && /^\d{1,9}(?:\.\d{1,6})?$/u.test(body.amountUsd) ? micros(Number(body.amountUsd)) : 0n;
  if (amount <= 0n) throw invalid([{ path: "amountUsd", message: "Use a positive decimal amount (at most 6 decimals)." }]);
  return { account, wallet, action, asset, amount };
}

/** deposit: a plain transfer from the account to its verified Polymarket wallet (any kind). */
async function depositSteps(io: PredictionsIo, input: WalletActionInput): Promise<PredictionWalletActionView> {
  const target = (await polymarketWalletsOf(input.account, io)).wallets.find((entry) => entry.address.toLowerCase() === input.wallet.toLowerCase());
  if (!target) throw new PlatformError("PREDICTION_WALLET_NOT_FOUND", `${input.wallet} is not a Polymarket wallet Kletia could verify for ${input.account}.`, 422);
  const held = await erc20Balance(io, input.asset === "pUSD" ? P.pusd : P.usdce, input.account);
  if (held < input.amount) throw new PlatformError("PREDICTION_BALANCE_TOO_LOW", `Your wallet holds ${Number(held) / 1e6} ${input.asset} on Polygon; the deposit is ${Number(input.amount) / 1e6}.`, 422);
  const call = transferCall(input.asset, target.address, input.amount, walletLine({ address: target.address, owner: input.account }));
  const steps = await transactionSteps(io, { kind: "account", address: input.account, owner: input.account }, [{ id: "deposit", title: `Deposit ${input.asset} into your Polymarket wallet`, call }]);
  return {
    venue: "polymarket", network: "polygon", account: `eip155:137:${input.account}`, wallet: { address: target.address, kind: target.kind, owner: target.owner }, action: "deposit", steps,
    note: "A plain transfer on Polygon from your wallet to your Polymarket wallet; polymarket.com shows it in your balance. You pay the POL gas.",
  };
}

/**
 * POST /v1/predictions/wallet: unsigned moves between the account and its
 * Polymarket wallet. deposit: a plain pUSD or USDC.e transfer from the
 * account to the wallet (any verified kind); withdraw: the Safe sends pUSD
 * or USDC.e back to its owner (never anywhere else); wrap: the Safe wraps
 * its USDC.e into pUSD. Safe calls run through `execTransaction`, sent by
 * the owner; a Deposit Wallet's own moves are refused (relayer only).
 */
export async function prepareWalletAction(body: unknown, policy: PredictionPolicyView, io: PredictionsIo = predictionsIo()): Promise<PredictionWalletActionView> {
  guardVenue("polymarket", policy);
  const input = readWalletAction(body);
  if (input.action === "deposit") return depositSteps(io, input);
  const holder = await holderOf(io, input.account, input.wallet);
  if (holder.kind === "account") throw invalid([{ path: "wallet", message: "Name your Polymarket wallet, not the account itself." }]);
  if (holder.kind === "deposit") {
    throw new PlatformError("PREDICTION_WALLET_SETUP_REQUIRED", `${walletLine(holder)} is a Deposit Wallet: its own transactions (${input.action === "withdraw" ? "withdrawals" : "wrapping USDC.e"}) run only through Polymarket's relayer. Do it on polymarket.com with this EVM wallet.`, 422);
  }
  const held = await erc20Balance(io, input.asset === "pUSD" ? P.pusd : P.usdce, holder.address);
  if (held < input.amount) throw new PlatformError("PREDICTION_BALANCE_TOO_LOW", `${holderName(holder)} holds ${Number(held) / 1e6} ${input.asset}; the ${input.action} is ${Number(input.amount) / 1e6}.`, 422);
  const wrapApproval = input.action === "wrap" && (await erc20Allowance(io, P.usdce, holder.address, P.collateralOnramp)) < input.amount;
  const calls: CallStep[] = input.action === "withdraw"
    ? [{ id: "withdraw", title: `Withdraw ${input.asset} to your wallet`, call: transferCall(input.asset, holder.owner, input.amount, "your wallet") }]
    : [
        ...(wrapApproval ? [{ id: "approve-usdce", title: "Approve USDC.e for wrapping", call: approveCall("USDC.e", P.collateralOnramp, input.amount) }] : []),
        { id: "wrap", title: "Wrap USDC.e into pUSD", call: wrapCall(holder.address, input.amount) },
      ];
  const steps = await transactionSteps(io, holder, calls);
  const note = input.action === "withdraw"
    ? "Your Safe sends the tokens to its owner, your wallet, and nowhere else. You pay the POL gas."
    : "CollateralOnramp wraps USDC.e into pUSD 1:1 inside your Polymarket wallet. You pay the POL gas.";
  return { venue: "polymarket", network: "polygon", account: `eip155:137:${input.account}`, wallet: walletSummary(holder) as NonNullable<PredictionPrepared["wallet"]>, action: input.action, steps, note };
}

/* -------------------------------------------------------------- redeem */

export interface PredictionRedeemView {
  readonly venue: "polymarket";
  readonly network: "polygon";
  readonly account: string;
  /** The Polymarket wallet that redeems (its Safe), or null for the account itself. */
  readonly wallet: PredictionPrepared["wallet"];
  readonly market: Pick<PredictionMarket, "id" | "question" | "version" | "negRisk">;
  readonly steps: readonly PredictionStep[];
  readonly note: string;
}

/** Unsigned redemption of a resolved market's shares (both outcomes; a losing outcome pays 0). */
export async function prepareRedeem(body: unknown, policy: PredictionPolicyView, io: PredictionsIo = predictionsIo()): Promise<PredictionRedeemView> {
  if (!isRecord(body)) throw invalid([{ path: "", message: "Send { account, conditionId, wallet? }." }]);
  guardVenue("polymarket", policy);
  const account = polygonAccount(body.account);
  const wallet = walletField(body);
  const conditionId = typeof body.conditionId === "string" && /^0x[0-9a-fA-F]{64}$/u.test(body.conditionId) ? body.conditionId.toLowerCase() : null;
  if (!conditionId) throw invalid([{ path: "conditionId", message: "Use the market's condition id (0x + 64 hex), as positions list it." }]);
  const market = await readGammaMarketByCondition(io, conditionId);
  if (!market) throw new PlatformError("PREDICTION_MARKET_NOT_FOUND", "No Polymarket market Kletia can read has this condition id.", 404);
  const holder = await holderOf(io, account, wallet);
  const at = holder.address;
  const calls: CallStep[] = [];
  const summary = { id: market.id, question: market.question, version: market.version, negRisk: market.negRisk };
  if (market.version === "v1") {
    if ((await ctfPayoutDenominator(io, conditionId)) === 0n) throw new PlatformError("PREDICTION_NOT_RESOLVED", `"${market.question}" has not resolved on-chain yet.`, 422);
    const held = await Promise.all(market.outcomes.map((outcome) => shareBalance(io, P.conditionalTokens, at, outcome.tokenId)));
    if (held.every((amount) => amount === 0n)) throw new PlatformError("PREDICTION_POSITION_NOT_FOUND", "This wallet holds no shares of this market.", 422);
    const adapter = market.negRisk ? P.negRiskCtfCollateralAdapter : P.ctfCollateralAdapter;
    calls.push(...(await operatorSteps(io, at, P.conditionalTokens, [adapter])));
    calls.push({ id: "redeem", title: "Redeem resolved shares for pUSD", call: redeemCtfCall(conditionId, market.negRisk) });
  } else {
    if (!market.resolved) throw new PlatformError("PREDICTION_NOT_RESOLVED", `"${market.question}" has not resolved yet.`, 422);
    const held = await Promise.all(market.outcomes.map((outcome) => shareBalance(io, P.positionManager, at, outcome.tokenId)));
    if (held.every((amount) => amount === 0n)) throw new PlatformError("PREDICTION_POSITION_NOT_FOUND", "This wallet holds no shares of this market.", 422);
    calls.push(...(await operatorSteps(io, at, P.positionManager, [P.router])));
    market.outcomes.forEach((outcome, index) => {
      const amount = held[index] ?? 0n;
      if (amount > 0n) calls.push({ id: `redeem-${index}`, title: `Redeem ${outcome.label} shares for pUSD`, call: redeemV2Call(outcome.tokenId, amount) });
    });
  }
  const steps = await transactionSteps(io, holder, calls);
  return { venue: "polymarket", network: "polygon", account: `eip155:137:${account}`, wallet: walletSummary(holder), market: summary, steps, note: "Each winning share pays 1 pUSD, each losing share 0. Redemption has no deadline." };
}
