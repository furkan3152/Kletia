/**
 * Prediction markets, venue-neutral: venues and their pinned deployments,
 * markets, outcomes, order books, the request a client sends, price and
 * probability math, payout and max-loss math, the exact order
 * amounts a Polymarket order signs, and request validation. Pure and
 * dependency-free: the API reads live markets and builds unsigned payloads;
 * the desk renders the same numbers.
 *
 * Conventions:
 * - An outcome share pays 1 USD (1 pUSD on Polymarket) when its outcome
 *   wins and 0 when it loses. Its price (0 to 1) is the market's implied
 *   probability, never a guarantee.
 * - USD amounts in requests are decimal strings; prices, sizes and estimates
 *   in responses are numbers (display values, never signed). Signed order
 *   amounts are integer strings of 6-decimal base units.
 *
 * Sources (read on 2026-10-24, see docs/platform/predictions.md):
 * - Polymarket contract addresses: docs.polymarket.com/resources/contracts,
 *   matching `MATIC_CONTRACTS` of @polymarket/clob-client-v2 1.2.0
 *   (`dist/config.js`); each exchange's ERC-5267 `eip712Domain()` read back
 *   on Polygon returns the domain pinned here.
 * - Order struct, signing domains, tick-size rounding and fee formula:
 *   docs.polymarket.com/trading/place-orders, /trading/fees and
 *   /market-data/market-details; the SDK's `ctfExchangeV2TypedData.js`,
 *   `roundingConfig.js`, `getMarketOrderRawAmounts.js` and `fees/index.js`.
 * - Polymarket account wallets (Safe, Proxy, Deposit Wallet): docs.polymarket.com
 *   /trading/wallets-auth and /resources/contracts ("Wallet Factory
 *   Contracts"); the derivation inputs of @polymarket/client 0.14.0
 *   (`walletDerivation`) and @polymarket/builder-relayer-client 0.0.10
 *   (`SAFE_INIT_CODE_HASH`, `PROXY_INIT_CODE_HASH`, `deriveSafe`,
 *   `deriveProxyWallet`, `deriveBeaconDepositWallet`); signature types of
 *   @polymarket/clob-client-v2 1.2.0 (`SignatureTypeV2`).
 * - Limitless Exchange (Base): docs.limitless.exchange/developers/authentication.
 */
import type { NetworkKey } from "./chains.js";
import type { TransactionRequest } from "./intent.js";
import type { ValidationIssue } from "./validation.js";

export type PredictionVenueId = "polymarket" | "limitless";
export type PredictionSide = "buy" | "sell";
/** market: fill now against the book (FAK, the unfilled rest is cancelled); limit: rest on the book at a price (GTC). */
export type PredictionOrderType = "market" | "limit";

export const PREDICTION_VENUE_IDS: readonly PredictionVenueId[] = Object.freeze(["polymarket", "limitless"]);
export const PREDICTION_SIDES: readonly PredictionSide[] = Object.freeze(["buy", "sell"]);
export const PREDICTION_ORDER_TYPES: readonly PredictionOrderType[] = Object.freeze(["market", "limit"]);

export const PREDICTION_LIMITS = Object.freeze({
  /** Largest stake of one order when no rule book sets `predictions.maxStakeUsd`. */
  defaultMaxStakeUsd: 10_000,
  /** Highest `predictions.maxStakeUsd` a rule book may set. */
  policyMaxStakeUsd: 1_000_000,
  /** Smallest stake Kletia builds (the venue's minimum share count usually asks for more). */
  minStakeUsd: 1,
  minSlippageBps: 10,
  maxSlippageBps: 2_000,
  defaultSlippageBps: 200,
  /** An order book older than this is refused (fail closed). */
  maxBookAgeSeconds: 60,
  /** Seconds a prepared order stays valid. */
  prepareTtlSeconds: 120,
  /** Seconds a sealed venue session (Polymarket L2 credentials) lives. */
  sessionTtlSeconds: 8 * 3600,
  /** Characters of a market search. */
  maxQueryLength: 120,
});

export interface PredictionVenue {
  readonly id: PredictionVenueId;
  readonly name: string;
  readonly network: NetworkKey;
  /** Collateral the venue settles in (symbol on `network`). */
  readonly collateral: string;
  /** False while Kletia builds nothing for the venue; `disabledReason` says why. */
  readonly enabled: boolean;
  readonly disabledReason: string | null;
  /** Account kinds Kletia trades for (Polymarket: the user's Safe or Deposit Wallet, or a plain wallet). */
  readonly accounts: string;
  readonly website: string;
  /** The venue's own terms, linked wherever Kletia offers a trade. */
  readonly termsUrl: string;
  /** What the venue says about restricted places, shown beside every ticket. */
  readonly restrictionNote: string;
}

export const PREDICTION_VENUES: readonly PredictionVenue[] = Object.freeze([
  {
    id: "polymarket",
    name: "Polymarket",
    network: "polygon",
    collateral: "pUSD",
    enabled: true,
    disabledReason: null,
    accounts: "Your Polymarket wallet, found from your EVM wallet: a Safe (browser-wallet accounts) or a Deposit Wallet (accounts since May 2026) trades with your wallet signing; a Proxy wallet (email and Google accounts) is read only. A plain wallet (EOA) trades when Polymarket allows it.",
    website: "https://polymarket.com",
    termsUrl: "https://polymarket.com/tos",
    restrictionNote:
      "Polymarket restricts trading in some places (its list includes the United States, the United Kingdom, France, Germany and others; some are close-only). It checks the location itself and refuses orders from restricted places. Kletia shows that answer and never works around it.",
  },
  {
    id: "limitless",
    name: "Limitless Exchange",
    network: "base",
    collateral: "USDC",
    enabled: false,
    disabledReason:
      "Not added. Limitless orders are relayed only with a per-user scoped API token whose secret is issued once after a Privy sign-in on limitless.exchange; Kletia would have to hold that secret, and markets run on three exchange generations per type that Kletia has not verified.",
    accounts: "None (not added).",
    website: "https://limitless.exchange",
    termsUrl: "https://docs.limitless.exchange/user-guide/terms-of-service",
    restrictionNote: "Not added.",
  },
] satisfies readonly PredictionVenue[]);

export function getPredictionVenue(id: string): PredictionVenue | null {
  return PREDICTION_VENUES.find((venue) => venue.id === id) ?? null;
}

/* ---------------------------------------------------------- deployments */

/** Polymarket on Polygon PoS (chain 137): docs.polymarket.com/resources/contracts, @polymarket/clob-client-v2 1.2.0 config. */
export const POLYMARKET_POLYGON = Object.freeze({
  chainId: 137,
  /** pUSD (CollateralToken proxy): the collateral of every order, 6 decimals. */
  pusd: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
  /** USDC.e on Polygon: the only asset CollateralOnramp wraps into pUSD (docs "Polymarket USD"). */
  usdce: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  collateralOnramp: "0x93070a847efEf7F70739046A929D47a521F5B8ee",
  /** ConditionalTokens (CTF): the ERC-1155 ledger of v1 outcome shares. */
  conditionalTokens: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
  /** CTF Exchange V2 (v1 markets, neg_risk false), EIP-712 domain version "2". */
  ctfExchange: "0xE111180000d2663C0091e4f400237545B87B996B",
  /** Neg Risk CTF Exchange V2 (v1 markets, neg_risk true), domain version "2". */
  negRiskCtfExchange: "0xe2222d279d744050d28e00520010520000310F59",
  /** Neg Risk Adapter: the CLOB checks pUSD and CTF approvals for it on v1 negative-risk orders. */
  negRiskAdapter: "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296",
  /** ExchangeV3 (Protocol V2 markets), domain version "3". */
  exchangeV3: "0xe3333700cA9d93003F00f0F71f8515005F6c00Aa",
  /** PositionManager: the ERC-1155 ledger of Protocol V2 positions. */
  positionManager: "0x006F54F7f9A22e0000CC2AB60031000000ae9fEF",
  /** Router: Protocol V2 split, merge and redeem. */
  router: "0x12121212006e4CD160D18e3f00711DA5c3372600",
  /** Redeems v1 CTF positions into pUSD (standard and negative-risk markets). */
  ctfCollateralAdapter: "0xAdA100Db00Ca00073811820692005400218FcE1f",
  negRiskCtfCollateralAdapter: "0xadA2005600Dec949baf300f4C6120000bDB6eAab",
  gammaApi: "https://gamma-api.polymarket.com",
  clobApi: "https://clob.polymarket.com",
  dataApi: "https://data-api.polymarket.com",
  /** Answers for the requesting IP only (docs "Geographic Restrictions"). */
  geoblockApi: "https://polymarket.com/api/geoblock",
});

/**
 * Polymarket's account-wallet factories on Polygon (docs "Contracts", Wallet
 * Factory Contracts). Each wallet's address is a CREATE2 address of its
 * owner's EOA, so it can be derived and then checked on-chain:
 * - Safe: Gnosis Safe 1.3.0 proxy from the Safe factory, salt
 *   keccak256(abi.encode(owner)), init code hash `safeInitCodeHash`;
 * - Proxy: EIP-1167 clone of `proxyImplementation` from the proxy factory,
 *   salt keccak256(abi.encodePacked(owner)), init code hash `proxyInitCodeHash`;
 * - Deposit Wallet: ERC-1967 beacon proxy (since June 29, 2026) or UUPS proxy
 *   (before) from the Deposit Wallet factory, salt keccak256(abi.encode(factory, bytes32(owner))).
 */
export const POLYMARKET_WALLET_FACTORIES = Object.freeze({
  safeFactory: "0xaacFeEa03eb1561C4e67d661e40682Bd20E3541b",
  safeInitCodeHash: "0x2bce2127ff07fb632d16c8347c4ebf501f4841168bed00d9e6ef715ddb6fcecf",
  proxyFactory: "0xaB45c5A4B0c941a2F231C04C3f49182e1A254052",
  proxyImplementation: "0x44e999d5c2F66Ef0861317f9A4805AC2e90aEB4f",
  proxyInitCodeHash: "0xd21df8dc65880a8606f09fe0ce3df9b8869287ab0b058be05aa9e8af6330a00b",
  depositWalletFactory: "0x00000000000Fb5C9ADea0298D729A0CB3823Cc07",
  depositWalletBeacon: "0x7A18EDfe055488A3128f01F563e5B479D92ffc3a",
  depositWalletImplementation: "0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB",
  /** Public profile lookup: an EOA or wallet address answers with the account's wallet (`proxyWallet`). */
  profileApi: "https://gamma-api.polymarket.com/public-profile",
});

/** A Polymarket account wallet: safe (MetaMask-style signers, legacy), proxy (Magic email/Google, legacy), deposit (every account since May 4, 2026). */
export type PolymarketWalletKind = "safe" | "proxy" | "deposit";

/** The order `signatureType` per account kind (@polymarket/clob-client-v2 SignatureTypeV2). */
export const POLYMARKET_SIGNATURE_TYPES = Object.freeze({ eoa: 0, proxy: 1, safe: 2, deposit: 3 } as const);

/** Signature types Kletia builds orders for: 0 plain wallet, 2 Safe (signer = owner EOA), 3 Deposit Wallet (ERC-1271, POLY_1271). */
export type PolymarketOrderSignatureType = 0 | 2 | 3;

/** Wallet actions Kletia builds for a Polymarket wallet (POST /v1/predictions/wallet). */
export type PolymarketWalletAction = "deposit" | "withdraw" | "wrap";

/** One Polymarket wallet of an EVM wallet, found by derivation and checked on Polygon. */
export interface PolymarketWallet {
  readonly address: string;
  readonly kind: PolymarketWalletKind;
  /** The EVM wallet (EOA) that owns it and signs for it. */
  readonly owner: string;
  readonly signatureType: 1 | 2 | 3;
  /** True when Kletia builds orders for it (Safe, Deposit Wallet); a Proxy wallet is read only. */
  readonly tradable: boolean;
  /** What was read on Polygon to accept it as the owner's (never a guess). */
  readonly verifiedBy: string;
  /** True when Polymarket's public profile of the owner names this wallet (the one polymarket.com shows). */
  readonly onProfile: boolean;
  /** pUSD and USDC.e held by the wallet (decimal strings), or null when they could not be read. */
  readonly balances: { readonly pusd: string; readonly usdce: string } | null;
  /** Wallet actions Kletia builds for it. */
  readonly actions: readonly PolymarketWalletAction[];
  /** Why it is read only, or what it needs first; null when nothing. */
  readonly note: string | null;
}

/** Market protocol generation (Gamma `version`): v1 trades CTF token ids, v2 PositionManager position ids. */
export type PolymarketVersion = "v1" | "v2";

export const POLYMARKET_EXCHANGE_NAME = "Polymarket CTF Exchange";

/** The exchange an order signs for: v2 markets ExchangeV3 (domain "3"); v1 markets CTF Exchange V2 or its neg-risk twin (domain "2"). */
export function polymarketExchange(version: PolymarketVersion, negRisk: boolean): { readonly address: string; readonly domainVersion: "2" | "3" } {
  if (version === "v2") return { address: POLYMARKET_POLYGON.exchangeV3, domainVersion: "3" };
  return { address: negRisk ? POLYMARKET_POLYGON.negRiskCtfExchange : POLYMARKET_POLYGON.ctfExchange, domainVersion: "2" };
}

/** The signed Order struct of CTF Exchange V2 and ExchangeV3 (same fields; `expiration` and `orderType` travel unsigned). */
export const POLYMARKET_ORDER_TYPES = Object.freeze({
  Order: Object.freeze([
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "signatureType", type: "uint8" },
    { name: "timestamp", type: "uint256" },
    { name: "metadata", type: "bytes32" },
    { name: "builder", type: "bytes32" },
  ]),
});

/** L1 authentication message (ClobAuthDomain v1): the wallet attests it controls the address; the CLOB answers with L2 credentials. */
export const POLYMARKET_CLOB_AUTH = Object.freeze({
  domain: Object.freeze({ name: "ClobAuthDomain", version: "1", chainId: 137 }),
  types: Object.freeze({
    ClobAuth: Object.freeze([
      { name: "address", type: "address" },
      { name: "timestamp", type: "string" },
      { name: "nonce", type: "uint256" },
      { name: "message", type: "string" },
    ]),
  }),
  message: "This message attests that I control the given wallet",
});

export const BYTES32_ZERO = "0x0000000000000000000000000000000000000000000000000000000000000000";

/* ------------------------------------------------------------- models */

export interface PredictionOutcome {
  readonly label: string;
  /** The id the venue trades (Polymarket: CTF token id for v1, position id for v2), decimal string. */
  readonly tokenId: string;
  /** Last price the venue lists (0 to 1), or null; the book decides quotes. */
  readonly price: number | null;
}

/** Fee schedule: fee = shares · rate · (p · (1 − p))^exponent, charged to the taker. */
export interface PredictionFeeSchedule {
  readonly rate: number;
  readonly exponent: number;
  readonly takerOnly: boolean;
}

export interface PredictionMarket {
  readonly venue: PredictionVenueId;
  /** The venue's market id (Gamma market id). */
  readonly id: string;
  readonly slug: string;
  readonly question: string;
  readonly eventId: string | null;
  readonly eventTitle: string | null;
  /** The market's name inside a multi-market event ("Xi Jinping"), or null. */
  readonly groupTitle: string | null;
  readonly category: string | null;
  readonly image: string | null;
  /** ISO time after which the market can resolve, or null. */
  readonly endDate: string | null;
  readonly active: boolean;
  readonly closed: boolean;
  readonly acceptingOrders: boolean;
  readonly version: PolymarketVersion;
  readonly conditionId: string;
  readonly negRisk: boolean;
  readonly tickSize: string;
  /** Smallest order in shares. */
  readonly minOrderSize: number;
  readonly outcomes: readonly PredictionOutcome[];
  readonly volumeUsd: number;
  readonly volume24hUsd: number;
  readonly liquidityUsd: number;
  /** null when the venue lists no schedule for a market that charges fees: Kletia then builds nothing (fail closed). */
  readonly fees: PredictionFeeSchedule | null;
  /** Seconds a marketable order waits before matching (sports markets), 0 when none. */
  readonly matchDelaySeconds: number;
  readonly resolved: boolean;
  readonly url: string;
  readonly description: string | null;
}

export interface PredictionBookLevel {
  readonly price: number;
  readonly size: number;
}

/** One outcome's order book, best levels first. */
export interface PredictionBook {
  readonly tokenId: string;
  readonly bids: readonly PredictionBookLevel[];
  readonly asks: readonly PredictionBookLevel[];
  readonly tickSize: string;
  readonly minOrderSize: number;
  readonly negRisk: boolean;
  readonly lastTradePrice: number | null;
  /** Unix seconds of the book. */
  readonly observedAt: number;
}

export interface PredictionPricePoint {
  /** Unix seconds. */
  readonly t: number;
  readonly p: number;
}

export interface PredictionPosition {
  readonly venue: PredictionVenueId;
  /** The address that holds the shares (an EOA, or a Polymarket Deposit, Proxy or Safe wallet). */
  readonly holder: string;
  readonly conditionId: string;
  readonly tokenId: string;
  readonly title: string;
  readonly slug: string | null;
  readonly eventSlug: string | null;
  readonly outcome: string;
  readonly outcomeIndex: number;
  readonly shares: number;
  readonly avgPrice: number;
  readonly currentPrice: number;
  readonly valueUsd: number;
  readonly costUsd: number;
  readonly pnlUsd: number;
  /** The market resolved and the shares can be redeemed (a losing outcome redeems for 0). */
  readonly redeemable: boolean;
  readonly negRisk: boolean;
  readonly endDate: string | null;
}

/** A prediction order as clients send it (POST /v1/predictions/quote and /prepare). */
export interface PredictionRequest {
  readonly venue: PredictionVenueId;
  readonly marketId: string;
  /** Outcome label as the market lists it ("Yes", "No", a team). */
  readonly outcome: string;
  readonly side: PredictionSide;
  readonly orderType: PredictionOrderType;
  /** buy: USD to spend, fees included (decimal string). */
  readonly amountUsd?: string;
  /** sell (and limit buy): shares, decimal string. */
  readonly shares?: string;
  /** limit: price per share (0 to 1), on the market's tick grid. */
  readonly limitPrice?: string;
  /** market: how far past the walked book price the order may fill. */
  readonly slippageBps?: number;
  /** CAIP-10 account on Polygon (prepare). */
  readonly account?: string;
  /** prepare: the caller already holds a venue session (no sign-in step is added). */
  readonly hasSession?: boolean;
  /** The account's Polymarket wallet (Safe or Deposit Wallet) that holds the funds and the shares; omitted: the account itself. */
  readonly wallet?: string;
}

export interface PredictionQuote {
  readonly venue: PredictionVenueId;
  readonly marketId: string;
  readonly question: string;
  readonly outcome: string;
  readonly tokenId: string;
  readonly side: PredictionSide;
  readonly orderType: PredictionOrderType;
  /** Best price on the side the order takes (buy: best ask; sell: best bid), the implied probability now. */
  readonly impliedProbability: number | null;
  /** Average fill price expected (market) or the limit price. */
  readonly avgPrice: number;
  /** Worst price the signed order accepts (the venue refuses a worse fill). */
  readonly worstPrice: number;
  /** Shares bought or sold. */
  readonly shares: number;
  /** buy: collateral the fills are expected to cost before fees; sell: collateral they are expected to bring before fees. */
  readonly notionalUsd: number;
  /** buy: the most collateral the signed order may spend before fees (its makerAmount); sell: null. */
  readonly spendCapUsd: number | null;
  /** Expected taker fee of the fills (a buy pays it on top, a sell from the proceeds). */
  readonly feeUsd: number;
  /** buy: the most the order can cost, fees included: never above the stake asked; sell: 0. */
  readonly maxLossUsd: number;
  /** buy: what the shares pay if the outcome wins (1 USD each). sell: what they would have paid. */
  readonly payoutIfWinUsd: number;
  /** buy: payout minus everything spent. sell: proceeds after fees. */
  readonly profitIfWinUsd: number;
  /** Share of the requested amount the book covers now (market orders; 1 for limit orders). */
  readonly fillable: number;
  readonly warnings: readonly string[];
}

/** EIP-712 typed data as `eth_signTypedData_v4` / viem `signTypedData` take it (EIP712Domain left out). */
export interface PredictionTypedData {
  readonly domain: { readonly name: string; readonly version: string; readonly chainId: number; readonly verifyingContract?: string };
  readonly types: Readonly<Record<string, readonly { readonly name: string; readonly type: string }[]>>;
  readonly primaryType: string;
  /** Field values; a nested struct (a Deposit Wallet order's `contents`) is an object of its fields. */
  readonly message: Readonly<Record<string, string | number | Readonly<Record<string, string | number>>>>;
}

/** The order fields a Polymarket order signs, plus what travels with it unsigned. */
export interface PolymarketOrderDraft {
  readonly salt: string;
  readonly maker: string;
  readonly signer: string;
  readonly tokenId: string;
  readonly makerAmount: string;
  readonly takerAmount: string;
  /** 0 buy, 1 sell. */
  readonly side: 0 | 1;
  /** 0: plain wallet (maker = signer); 2: Safe (maker = Safe, signer = its owner); 3: Deposit Wallet (maker = signer = the wallet, ERC-1271). */
  readonly signatureType: PolymarketOrderSignatureType;
  /** Unix milliseconds. */
  readonly timestamp: string;
  readonly metadata: string;
  readonly builder: string;
  /** Unsigned: "0" for market (FAK) and GTC orders. */
  readonly expiration: string;
  readonly orderType: "FAK" | "GTC";
  readonly exchange: string;
  readonly domainVersion: "2" | "3";
}

/** One thing the wallet does, in order: send a transaction, or sign typed data that Kletia relays to the venue. */
export type PredictionStep =
  | {
      readonly kind: "transaction";
      readonly id: string;
      readonly title: string;
      readonly transaction: TransactionRequest;
      /** What the approval allows, said plainly (operator approvals cover every share on that ledger). */
      readonly disclosure?: string;
      /** A call run by the user's Polymarket Safe: the Safe, its nonce when prepared, and the EIP-712 SafeTx hash the Safe executes. */
      readonly safeTx?: { readonly safe: string; readonly nonce: string; readonly hash: string };
    }
  | {
      readonly kind: "typed-data";
      readonly id: string;
      readonly title: string;
      /** clob-auth: proves the wallet to the venue's order book (no funds move); order: the order itself (a Deposit Wallet order is signed wrapped, ERC-7739 TypedDataSign). */
      readonly purpose: "clob-auth" | "order";
      readonly typedData: PredictionTypedData;
    };

/** Answer of POST /v1/predictions/prepare: unsigned steps for the user's wallet, the quote they implement and the relay ticket. */
export interface PredictionPrepared {
  readonly venue: PredictionVenueId;
  readonly network: NetworkKey;
  readonly account: string;
  /** The Polymarket wallet that trades (maker), or null when the account trades for itself. */
  readonly wallet: Pick<PolymarketWallet, "address" | "kind" | "owner"> | null;
  readonly quote: PredictionQuote;
  readonly steps: readonly PredictionStep[];
  /** The order as prepared; send it back unchanged with the signature (POST /v1/predictions/submit). */
  readonly order: PolymarketOrderDraft;
  /** EIP-712 hash of the order typed data. */
  readonly orderHash: string;
  /** Kletia's MAC over the prepared order: the relay sends only what prepare built and checked. */
  readonly ticket: string;
  /** Unix seconds after which the order must be prepared again. */
  readonly expiresAt: number;
  readonly warnings: readonly string[];
}

/* -------------------------------------------------------------- math */

/** Implied probability (0 to 1) of an outcome priced at `price`; null outside (0, 1]. */
export function impliedProbability(price: number | null | undefined): number | null {
  return typeof price === "number" && Number.isFinite(price) && price > 0 && price <= 1 ? price : null;
}

/** Taker fee in USD of `shares` traded at `price` (docs "Fees"; rounded to 5 decimals, the venue's precision). */
export function predictionFeeUsd(shares: number, price: number, fees: PredictionFeeSchedule | null): number {
  if (!fees || fees.rate <= 0 || shares <= 0 || price <= 0 || price >= 1) return 0;
  const fee = shares * fees.rate * (price * (1 - price)) ** fees.exponent;
  return Math.round(fee * 100_000) / 100_000;
}

/** The price between `low` and `high` where the fee curve p(1−p) is highest (0.5 when it lies between them). */
function costliestFeePrice(low: number, high: number): number {
  if (low <= 0.5 && high >= 0.5) return 0.5;
  return Math.abs(low - 0.5) < Math.abs(high - 0.5) ? low : high;
}

/** Largest fee per share `rate · (p(1−p))^e` for a fill anywhere between two prices. */
function maxFeeFactor(fees: PredictionFeeSchedule | null, low: number, high: number): number {
  if (!fees || fees.rate <= 0) return 0;
  const price = costliestFeePrice(low, high);
  return fees.rate * (price * (1 - price)) ** fees.exponent;
}

export interface BookWalk {
  /** Shares filled. */
  readonly shares: number;
  /** Collateral of the fills (before fees). */
  readonly notional: number;
  /** Price of the last level reached. */
  readonly lastPrice: number;
  /** True when the book covers the whole amount. */
  readonly complete: boolean;
}

/**
 * Walks the book best level first. buy: spends `amount` USD on the asks;
 * sell: sells `amount` shares into the bids.
 */
export function walkBook(book: Pick<PredictionBook, "bids" | "asks">, side: PredictionSide, amount: number): BookWalk | null {
  const levels = side === "buy" ? book.asks : book.bids;
  if (levels.length === 0 || !(amount > 0)) return null;
  let left = amount;
  let shares = 0;
  let notional = 0;
  let lastPrice = levels[0]!.price;
  for (const level of levels) {
    if (left <= 1e-12) break;
    lastPrice = level.price;
    if (side === "buy") {
      const spend = Math.min(left, level.size * level.price);
      shares += spend / level.price;
      notional += spend;
      left -= spend;
    } else {
      const take = Math.min(left, level.size);
      shares += take;
      notional += take * level.price;
      left -= take;
    }
  }
  return { shares, notional, lastPrice, complete: left <= 1e-9 };
}

/* ----------------------------------------------------- order amounts */

/** Price, size and amount decimals per tick size (docs "Place Orders", the SDK's roundingConfig). */
export const POLYMARKET_ROUNDING: Readonly<Record<string, { readonly price: number; readonly size: number; readonly amount: number }>> = Object.freeze({
  "0.1": { price: 1, size: 2, amount: 3 },
  "0.01": { price: 2, size: 2, amount: 4 },
  "0.005": { price: 3, size: 2, amount: 5 },
  "0.0025": { price: 4, size: 2, amount: 6 },
  "0.001": { price: 3, size: 2, amount: 5 },
  "0.0001": { price: 4, size: 2, amount: 6 },
});

const UNIT_DECIMALS = 6;
const pow10 = (exponent: number): bigint => 10n ** BigInt(exponent);
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** Decimal string to integer units of 10^-decimals, rounded down; null for anything but a plain non-negative decimal. */
export function decimalUnits(value: string, decimals: number): bigint | null {
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(value.trim());
  if (!match) return null;
  const fraction = (match[2] ?? "").slice(0, decimals).padEnd(decimals, "0");
  return BigInt(match[1] as string) * pow10(decimals) + BigInt(fraction || "0");
}

/** Integer units back to a decimal string without trailing zeros. */
export function unitsDecimal(units: bigint, decimals: number): string {
  const sign = units < 0n ? "-" : "";
  const abs = units < 0n ? -units : units;
  const whole = abs / pow10(decimals);
  const fraction = (abs % pow10(decimals)).toString().padStart(decimals, "0").replace(/0+$/u, "");
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** A price on the tick grid: rounded down (sell bound) or up (buy bound) to a multiple of `tickSize`, as a decimal string. */
export function priceOnTick(price: number, tickSize: string, direction: "down" | "up"): string | null {
  const rounding = POLYMARKET_ROUNDING[tickSize];
  const tick = decimalUnits(tickSize, rounding?.price ?? 0);
  if (!rounding || !tick || tick <= 0n || !(price > 0) || !(price < 1)) return null;
  // Three guard digits absorb binary noise (0.29 · 100 = 28.999…): the price is read at 10^-(p+3), then cut to 10^-p.
  const fine = BigInt(Math.round(price * 10 ** (rounding.price + 3)));
  const raw = direction === "down" ? fine / 1000n : ceilDiv(fine, 1000n);
  const onGrid = direction === "down" ? (raw / tick) * tick : ceilDiv(raw, tick) * tick;
  const max = pow10(rounding.price) - tick;
  const clamped = onGrid < tick ? tick : onGrid > max ? max : onGrid;
  return unitsDecimal(clamped, rounding.price);
}

export interface PolymarketAmounts {
  /** 6-decimal base units the maker gives (buy: pUSD; sell: shares). */
  readonly makerAmount: bigint;
  /** 6-decimal base units the maker receives at least (buy: shares; sell: pUSD). */
  readonly takerAmount: bigint;
}

/**
 * The signed amounts of an order (docs "Place Orders"; the SDK's
 * getMarketOrderRawAmounts / getOrderRawAmounts), in exact integers:
 * - market buy: `amount` is USD (rounded down to the size decimals);
 *   shares = USD ÷ price, rounded up at amount+4 decimals, then down at the
 *   amount decimals (keeps the maximum price);
 * - market sell, limit buy and limit sell: `amount` is shares (rounded down
 *   to the size decimals); USD = shares × price, exact at the amount decimals.
 * `price` is a decimal string on the tick grid. Null when the tick size is
 * not one the venue lists or a value does not parse (fail closed).
 */
export function polymarketOrderAmounts(input: {
  readonly side: PredictionSide;
  readonly orderType: PredictionOrderType;
  readonly amount: string;
  readonly price: string;
  readonly tickSize: string;
}): PolymarketAmounts | null {
  const rounding = POLYMARKET_ROUNDING[input.tickSize];
  if (!rounding) return null;
  const price = decimalUnits(input.price, rounding.price);
  const amount = decimalUnits(input.amount, rounding.size);
  if (price === null || amount === null || price <= 0n || price >= pow10(rounding.price) || amount <= 0n) return null;
  const sizeToUnits = pow10(UNIT_DECIMALS - rounding.size);
  if (input.side === "buy" && input.orderType === "market") {
    // shares = (amount / 10^size) / (price / 10^p), held at 10^(amount+4) and rounded up, then down to 10^amount.
    const scale = rounding.amount + 4;
    const fine = ceilDiv(amount * pow10(rounding.price + scale), price * pow10(rounding.size));
    const shares = fine / pow10(4);
    return { makerAmount: amount * sizeToUnits, takerAmount: shares * pow10(UNIT_DECIMALS - rounding.amount) };
  }
  // shares × price is exact at size + price decimals (= the amount decimals for every listed tick size).
  const usd = amount * price * pow10(UNIT_DECIMALS - rounding.size - rounding.price);
  const shares = amount * sizeToUnits;
  return input.side === "buy" ? { makerAmount: usd, takerAmount: shares } : { makerAmount: shares, takerAmount: usd };
}

/* --------------------------------------------------------------- quote */

export interface PredictionQuoteInput {
  readonly side: PredictionSide;
  readonly orderType: PredictionOrderType;
  /** buy: USD to spend, fees included. */
  readonly amountUsd?: number;
  /** sell or limit buy: shares. */
  readonly shares?: number;
  readonly limitPrice?: number;
  readonly slippageBps: number;
  /** The book's tick size: a market order's worst price lands on the grid (up for a buy, down for a sell). */
  readonly tickSize?: string;
}

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;
const floorTo = (value: number, digits: number) => Math.floor(value * 10 ** digits + 1e-7) / 10 ** digits;

/** Shares and signed spend of a buy: the fills, the signed cap (cents) and the most the fees can add. */
interface BuyPlan {
  readonly shares: number;
  readonly notional: number;
  readonly avgPrice: number;
  readonly worstPrice: number;
  readonly spendCap: number;
  readonly maxFee: number;
  readonly fillable: number;
}

/**
 * A market buy of `stake` USD is all-in: the signed spend (cents, rounded
 * down) leaves room for the fee at the costliest price the order may fill
 * at, with the share count bounded by spend ÷ best ask.
 */
function marketBuyPlan(market: Pick<PredictionMarket, "fees">, book: Pick<PredictionBook, "bids" | "asks">, stake: number, slip: number, tickSize?: string): BuyPlan | null {
  const top = book.asks[0]?.price;
  const first = walkBook(book, "buy", stake);
  if (top === undefined || !first) return null;
  const raw = Math.min(0.999, first.lastPrice * (1 + slip));
  const worstPrice = tickSize ? Number(priceOnTick(raw, tickSize, "up") ?? Number.NaN) : raw;
  if (!Number.isFinite(worstPrice)) return null;
  const factor = maxFeeFactor(market.fees, top, worstPrice);
  const spendCap = floorTo(stake / (1 + factor / top), 2);
  const walk = walkBook(book, "buy", spendCap) ?? first;
  return {
    shares: walk.shares,
    notional: walk.notional,
    avgPrice: walk.shares > 0 ? walk.notional / walk.shares : top,
    worstPrice,
    spendCap,
    maxFee: (spendCap / top) * factor,
    fillable: walk.complete ? 1 : walk.notional / spendCap,
  };
}

/** A limit buy rests at `price`: `shares` (cut to 2 decimals), or as many as `amountUsd` pays for with the fee at that price. */
function limitBuyPlan(market: Pick<PredictionMarket, "fees">, price: number, shares: number | undefined, amountUsd: number | undefined): BuyPlan {
  const factor = maxFeeFactor(market.fees, price, price);
  const count = floorTo(shares ?? (amountUsd ?? 0) / (price + factor), 2);
  return { shares: count, notional: count * price, avgPrice: price, worstPrice: price, spendCap: count * price, maxFee: count * factor, fillable: 1 };
}

/**
 * Quote of one order against one outcome's book; the API signs the same
 * caps (`spendCapUsd`, `worstPrice`). Null when the book is empty on the
 * side a market order takes, or a limit price is outside (0, 1).
 */
export function quotePredictionOrder(
  market: Pick<PredictionMarket, "venue" | "id" | "question" | "fees" | "minOrderSize">,
  outcome: Pick<PredictionOutcome, "label" | "tokenId">,
  book: Pick<PredictionBook, "bids" | "asks">,
  input: PredictionQuoteInput,
): PredictionQuote | null {
  const warnings: string[] = [];
  const top = input.side === "buy" ? book.asks[0]?.price : book.bids[0]?.price;
  const base = {
    venue: market.venue, marketId: market.id, question: market.question, outcome: outcome.label, tokenId: outcome.tokenId,
    side: input.side, orderType: input.orderType, impliedProbability: impliedProbability(top ?? null),
  };
  const slip = input.slippageBps / 10_000;
  const limit = input.orderType === "limit";
  if (limit && !((input.limitPrice ?? 0) > 0 && (input.limitPrice ?? 1) < 1)) return null;
  let quote: Omit<PredictionQuote, keyof typeof base | "warnings">;
  if (input.side === "buy") {
    const plan = limit ? limitBuyPlan(market, input.limitPrice as number, input.shares, input.amountUsd) : marketBuyPlan(market, book, input.amountUsd ?? 0, slip, input.tickSize);
    if (!plan) return null;
    const feeUsd = predictionFeeUsd(plan.shares, costliestFeePrice(Math.min(plan.avgPrice, plan.worstPrice), Math.max(plan.avgPrice, plan.worstPrice)), market.fees);
    const maxLoss = Math.min(input.amountUsd ?? Number.POSITIVE_INFINITY, Math.ceil((plan.spendCap + plan.maxFee) * 100 - 1e-7) / 100);
    if (plan.fillable < 1) warnings.push(`The book covers only ${Math.floor(plan.fillable * 100)}% of this order now; the rest is cancelled, not left open.`);
    quote = {
      avgPrice: round(plan.avgPrice, 4), worstPrice: round(plan.worstPrice, 4), shares: round(plan.shares, 2), notionalUsd: round(plan.notional, 2),
      spendCapUsd: plan.spendCap, feeUsd: round(feeUsd, 4), maxLossUsd: maxLoss, payoutIfWinUsd: round(plan.shares, 2),
      profitIfWinUsd: round(plan.shares - plan.notional - feeUsd, 2), fillable: round(plan.fillable, 4),
    };
  } else {
    const shares = floorTo(input.shares ?? 0, 2);
    let notional: number;
    let avgPrice: number;
    let worstPrice: number;
    let fillable = 1;
    if (limit) {
      worstPrice = avgPrice = input.limitPrice as number;
      notional = shares * worstPrice;
    } else {
      const walk = walkBook(book, "sell", shares);
      if (!walk) return null;
      const raw = Math.max(0.001, walk.lastPrice * (1 - slip));
      worstPrice = input.tickSize ? Number(priceOnTick(raw, input.tickSize, "down") ?? Number.NaN) : raw;
      if (!Number.isFinite(worstPrice)) return null;
      notional = walk.notional;
      avgPrice = walk.shares > 0 ? walk.notional / walk.shares : (top as number);
      fillable = walk.complete ? 1 : walk.shares / shares;
      if (fillable < 1) warnings.push(`The book covers only ${Math.floor(fillable * 100)}% of this order now; the rest is cancelled, not left open.`);
    }
    const feeUsd = predictionFeeUsd(shares * fillable, costliestFeePrice(Math.min(avgPrice, worstPrice), Math.max(avgPrice, worstPrice)), market.fees);
    quote = {
      avgPrice: round(avgPrice, 4), worstPrice: round(worstPrice, 4), shares, notionalUsd: round(notional, 2), spendCapUsd: null, feeUsd: round(feeUsd, 4),
      maxLossUsd: 0, payoutIfWinUsd: shares, profitIfWinUsd: round(notional - feeUsd, 2), fillable: round(fillable, 4),
    };
  }
  if (limit) {
    const crosses = top !== undefined && (input.side === "buy" ? quote.worstPrice >= top : quote.worstPrice <= top);
    if (!crosses) warnings.push("The limit price is away from the book: the order rests until someone takes it, and may never fill.");
  }
  if (quote.shares < market.minOrderSize) warnings.push(`The venue's smallest order is ${market.minOrderSize} shares; this one is ${quote.shares}.`);
  if (base.impliedProbability !== null && (base.impliedProbability < 0.05 || base.impliedProbability > 0.95)) warnings.push("The price is near 0 or 1: small moves change the payout a lot, and thin books fill poorly.");
  return { ...base, ...quote, warnings };
}

/* --------------------------------------------------------- validation */

const USD_PATTERN = /^\d{1,7}(?:\.\d{1,2})?$/u;
const SHARES_PATTERN = /^\d{1,9}(?:\.\d{1,2})?$/u;
const PRICE_PATTERN = /^0?\.\d{1,4}$/u;
const MARKET_ID_PATTERN = /^[A-Za-z0-9-]{1,80}$/u;

export type PredictionRequestValidation =
  | { readonly ok: true; readonly value: PredictionRequest; readonly issues: readonly [] }
  | { readonly ok: false; readonly value: null; readonly issues: readonly ValidationIssue[] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const printable = (value: string, max: number) => value.length > 0 && value.length <= max && !/[\p{Cc}\p{Cf}]/u.test(value);

/**
 * Validates a prediction order. A buy gives `amountUsd` (market) or
 * `shares` or `amountUsd` with a `limitPrice` (limit); a sell gives `shares`.
 */
export function validatePredictionRequest(input: unknown): PredictionRequestValidation {
  const issues: ValidationIssue[] = [];
  if (!isRecord(input)) return { ok: false, value: null, issues: [{ path: "", message: "Send a JSON object." }] };
  for (const key of Object.keys(input)) {
    if (!["venue", "marketId", "outcome", "side", "orderType", "amountUsd", "shares", "limitPrice", "slippageBps", "account", "hasSession", "wallet"].includes(key)) issues.push({ path: key, message: "Unknown field." });
  }
  const venue = input.venue ?? "polymarket";
  if (!(PREDICTION_VENUE_IDS as readonly unknown[]).includes(venue)) issues.push({ path: "venue", message: `Use one of ${PREDICTION_VENUE_IDS.join(", ")}.` });
  if (typeof input.marketId !== "string" || !MARKET_ID_PATTERN.test(input.marketId)) issues.push({ path: "marketId", message: "Use the market id from GET /v1/predictions/markets." });
  if (typeof input.outcome !== "string" || !printable(input.outcome.trim(), 80)) issues.push({ path: "outcome", message: "Use an outcome label the market lists (Yes, No, ...)." });
  if (!(PREDICTION_SIDES as readonly unknown[]).includes(input.side)) issues.push({ path: "side", message: "Use buy or sell." });
  const orderType = input.orderType ?? "market";
  if (!(PREDICTION_ORDER_TYPES as readonly unknown[]).includes(orderType)) issues.push({ path: "orderType", message: "Use market or limit." });
  const amountUsd = input.amountUsd;
  if (amountUsd !== undefined && (typeof amountUsd !== "string" || !USD_PATTERN.test(amountUsd) || Number(amountUsd) < PREDICTION_LIMITS.minStakeUsd || Number(amountUsd) > PREDICTION_LIMITS.policyMaxStakeUsd)) {
    issues.push({ path: "amountUsd", message: `Use a decimal string from ${PREDICTION_LIMITS.minStakeUsd} to ${PREDICTION_LIMITS.policyMaxStakeUsd} USD (at most 2 decimals).` });
  }
  const shares = input.shares;
  if (shares !== undefined && (typeof shares !== "string" || !SHARES_PATTERN.test(shares) || Number(shares) <= 0)) issues.push({ path: "shares", message: "Use a positive decimal string of shares (at most 2 decimals)." });
  const limitPrice = input.limitPrice;
  if (limitPrice !== undefined && (typeof limitPrice !== "string" || !PRICE_PATTERN.test(limitPrice) || Number(limitPrice) <= 0 || Number(limitPrice) >= 1)) {
    issues.push({ path: "limitPrice", message: "Use a price between 0 and 1, such as 0.42." });
  }
  const slippageBps = input.slippageBps;
  if (slippageBps !== undefined && (!Number.isInteger(slippageBps) || (slippageBps as number) < PREDICTION_LIMITS.minSlippageBps || (slippageBps as number) > PREDICTION_LIMITS.maxSlippageBps)) {
    issues.push({ path: "slippageBps", message: `Use an integer from ${PREDICTION_LIMITS.minSlippageBps} to ${PREDICTION_LIMITS.maxSlippageBps}.` });
  }
  if (input.account !== undefined && (typeof input.account !== "string" || input.account.length > 200)) issues.push({ path: "account", message: "Use a CAIP-10 account id on Polygon (eip155:137:0x…)." });
  if (input.hasSession !== undefined && typeof input.hasSession !== "boolean") issues.push({ path: "hasSession", message: "Use true or false." });
  if (input.wallet !== undefined && (typeof input.wallet !== "string" || !/^0x[0-9a-fA-F]{40}$/u.test(input.wallet))) issues.push({ path: "wallet", message: "Use your Polymarket wallet's address (0x…), as GET /v1/predictions/wallets lists it." });
  if (issues.length === 0) {
    if (input.side === "buy" && orderType === "market" && amountUsd === undefined) issues.push({ path: "amountUsd", message: "A market buy needs amountUsd (fees included)." });
    if (input.side === "buy" && orderType === "market" && shares !== undefined) issues.push({ path: "shares", message: "A market buy spends amountUsd; give shares with a limit order." });
    if (input.side === "buy" && orderType === "limit" && (amountUsd === undefined) === (shares === undefined)) issues.push({ path: "shares", message: "A limit buy needs exactly one of amountUsd or shares." });
    if (input.side === "sell" && shares === undefined) issues.push({ path: "shares", message: "A sell needs shares." });
    if (input.side === "sell" && amountUsd !== undefined) issues.push({ path: "amountUsd", message: "A sell is sized in shares." });
    if (orderType === "limit" && limitPrice === undefined) issues.push({ path: "limitPrice", message: "A limit order needs limitPrice." });
    if (orderType === "market" && limitPrice !== undefined) issues.push({ path: "limitPrice", message: "A market order takes slippageBps, not limitPrice." });
  }
  if (issues.length > 0) return { ok: false, value: null, issues };
  const value: PredictionRequest = {
    venue: venue as PredictionVenueId,
    marketId: input.marketId as string,
    outcome: (input.outcome as string).trim(),
    side: input.side as PredictionSide,
    orderType: orderType as PredictionOrderType,
    ...(amountUsd !== undefined ? { amountUsd: amountUsd as string } : {}),
    ...(shares !== undefined ? { shares: shares as string } : {}),
    ...(limitPrice !== undefined ? { limitPrice: limitPrice as string } : {}),
    ...(slippageBps !== undefined ? { slippageBps: slippageBps as number } : {}),
    ...(input.account !== undefined ? { account: input.account as string } : {}),
    ...(input.hasSession !== undefined ? { hasSession: input.hasSession as boolean } : {}),
    ...(input.wallet !== undefined ? { wallet: input.wallet as string } : {}),
  };
  return { ok: true, value, issues: [] };
}

/** Stake (USD) an order puts at risk, for rule-book caps: a buy's amount or shares × limit price; a sell risks none. */
export function predictionStakeUsd(request: Pick<PredictionRequest, "side" | "amountUsd" | "shares" | "limitPrice">): number {
  if (request.side === "sell") return 0;
  if (request.amountUsd !== undefined) return Number(request.amountUsd);
  return Number(request.shares ?? "0") * Number(request.limitPrice ?? "0");
}

/** Outcome of `market` whose label matches `said` (case-insensitive), or null. */
export function findOutcome<T extends Pick<PredictionOutcome, "label">>(outcomes: readonly T[], said: string): T | null {
  const wanted = said.trim().toLowerCase();
  return outcomes.find((outcome) => outcome.label.trim().toLowerCase() === wanted) ?? null;
}
