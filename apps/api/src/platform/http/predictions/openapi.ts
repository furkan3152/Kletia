/**
 * OpenAPI fragments of /v1/predictions (tag *Predictions*): markets, one
 * market, the account's Polymarket wallets, positions, quote, prepare, the
 * venue sign-in, the relay, open orders, cancel, redeem and wallet moves. Enums and limits come from @kletia/core
 * `predictions.ts`. Merged by openapi.ts.
 */
import { PREDICTION_LIMITS, PREDICTION_ORDER_TYPES, PREDICTION_SIDES, PREDICTION_VENUE_IDS } from "@kletia/core";
import { arrayOf, bool, errors, int, jsonBody, nullable, num, obj, ok, ref, str, type JsonObject } from "../openapiKit.js";
import { PREDICTION_CATEGORIES } from "../../predictions/polymarket.js";

const TAGS = ["Predictions"];
const VENUE = str({ enum: [...PREDICTION_VENUE_IDS] });
const SIDE = str({ enum: [...PREDICTION_SIDES] });
const ACCOUNT = str({ maxLength: 200, description: "CAIP-10 account on Polygon.", examples: ["eip155:137:0x4f183e308f24c81c05303821AD025812fBFd807D"] });
const SESSION = str({ maxLength: 2200, description: "The sealed venue session from POST /v1/predictions/session (opaque; lives 8 hours; places and cancels orders, moves no funds)." });
const SIGNATURE = str({ pattern: "^0x[0-9a-fA-F]{130}$" });
const RISK = "You can lose the whole stake: a share pays 1 pUSD if its outcome wins and 0 if it loses; prices are the market's odds, not guarantees.";
const NOT_SIGNED = "Kletia never signs: the answer is for the user's own wallet.";

const WALLET_ADDRESS = str({ pattern: "^0x[0-9a-fA-F]{40}$", description: "The account's Polymarket wallet (GET /v1/predictions/wallets)." });
const WALLET_KIND = str({ enum: ["safe", "proxy", "deposit"], description: "safe: Gnosis Safe of a browser-wallet account; deposit: Deposit Wallet (accounts since May 4, 2026); proxy: email or Google account (read only)." });
const TYPED_DATA = obj({ domain: obj({}), types: obj({}), primaryType: str(), message: obj({}) }, ["domain", "types", "primaryType", "message"]);

export function predictionSchemas(): JsonObject {
  return {
    PredictionVenue: obj(
      {
        id: VENUE,
        name: str(),
        network: str(),
        collateral: str(),
        enabled: bool({ description: "False: Kletia builds nothing for the venue (disabledReason says why)." }),
        disabledReason: nullable(str()),
        accounts: str({ description: "Account kinds Kletia trades for." }),
        website: str(),
        termsUrl: str(),
        restrictionNote: str({ description: "What the venue says about restricted places; shown beside every ticket." }),
      },
      ["id", "name", "network", "collateral", "enabled", "disabledReason", "accounts", "website", "termsUrl", "restrictionNote"],
    ),
    PredictionOutcome: obj({ label: str(), tokenId: str({ description: "The id the venue trades (CTF token id, or Protocol V2 position id), decimal." }), price: nullable(num()) }, ["label", "tokenId", "price"]),
    PredictionMarket: obj(
      {
        venue: VENUE,
        id: str({ description: "Gamma market id." }),
        slug: str(),
        question: str(),
        eventId: nullable(str()),
        eventTitle: nullable(str()),
        groupTitle: nullable(str()),
        category: nullable(str()),
        image: nullable(str()),
        endDate: nullable(str()),
        active: bool(),
        closed: bool(),
        acceptingOrders: bool(),
        version: str({ enum: ["v1", "v2"], description: "v1 trades ConditionalTokens ids on CTF Exchange V2; v2 PositionManager ids on ExchangeV3." }),
        conditionId: str(),
        negRisk: bool(),
        tickSize: str(),
        minOrderSize: num(),
        outcomes: arrayOf(ref("PredictionOutcome")),
        volumeUsd: num(),
        volume24hUsd: num(),
        liquidityUsd: num(),
        fees: nullable(obj({ rate: num(), exponent: num(), takerOnly: bool() }, ["rate", "exponent", "takerOnly"], { description: "fee = shares · rate · (p(1 − p))^exponent, taker only." })),
        matchDelaySeconds: num(),
        resolved: bool(),
        url: str(),
        description: nullable(str()),
      },
      ["venue", "id", "slug", "question", "eventId", "eventTitle", "groupTitle", "category", "image", "endDate", "active", "closed", "acceptingOrders", "version", "conditionId", "negRisk", "tickSize", "minOrderSize", "outcomes", "volumeUsd", "volume24hUsd", "liquidityUsd", "fees", "matchDelaySeconds", "resolved", "url", "description"],
    ),
    PredictionMarketsResponse: obj(
      {
        venues: arrayOf(ref("PredictionVenue")),
        markets: arrayOf(ref("PredictionMarket")),
        query: nullable(str()),
        category: nullable(str({ enum: [...PREDICTION_CATEGORIES] })),
        sort: str({ enum: ["volume", "ending"] }),
        categories: arrayOf(str()),
      },
      ["venues", "markets", "query", "category", "sort", "categories"],
    ),
    PredictionBook: obj(
      {
        tokenId: str(),
        bids: arrayOf(obj({ price: num(), size: num() }, ["price", "size"]), { description: "Best (highest) first." }),
        asks: arrayOf(obj({ price: num(), size: num() }, ["price", "size"]), { description: "Best (lowest) first." }),
        tickSize: str(),
        minOrderSize: num(),
        negRisk: bool(),
        lastTradePrice: nullable(num()),
        observedAt: int({ description: "Unix seconds." }),
      },
      ["tokenId", "bids", "asks", "tickSize", "minOrderSize", "negRisk", "lastTradePrice", "observedAt"],
    ),
    PredictionMarketResponse: obj(
      {
        market: ref("PredictionMarket"),
        outcomes: arrayOf(obj({
          label: str(), tokenId: str(), price: nullable(num()), book: nullable(ref("PredictionBook")),
          history: arrayOf(obj({ t: int(), p: num() }, ["t", "p"]), { description: "A week of prices, six-hour points." }),
          unavailable: nullable(str()),
        }, ["label", "tokenId", "price", "book", "history", "unavailable"])),
        restrictionNote: str(),
        termsUrl: str(),
      },
      ["market", "outcomes", "restrictionNote", "termsUrl"],
    ),
    PredictionPosition: obj(
      {
        venue: VENUE, holder: str(), conditionId: str(), tokenId: str(), title: str(), slug: nullable(str()), eventSlug: nullable(str()), outcome: str(), outcomeIndex: int(),
        shares: num(), avgPrice: num(), currentPrice: num(), valueUsd: num(), costUsd: num(), pnlUsd: num(),
        redeemable: bool({ description: "Resolved: redeem it (a losing outcome redeems for 0)." }), negRisk: bool(), endDate: nullable(str()),
      },
      ["venue", "holder", "conditionId", "tokenId", "title", "slug", "eventSlug", "outcome", "outcomeIndex", "shares", "avgPrice", "currentPrice", "valueUsd", "costUsd", "pnlUsd", "redeemable", "negRisk", "endDate"],
    ),
    PredictionPositionsResponse: obj(
      {
        holder: str(), positions: arrayOf(ref("PredictionPosition")), truncated: bool(),
        tradable: bool({ description: "Whether Kletia trades for the holder: a plain wallet, or the account's Safe or Deposit Wallet (with `wallet`). False for a Proxy wallet or another smart wallet: read only." }),
        wallet: nullable(ref("PolymarketWallet")),
      },
      ["holder", "positions", "truncated", "tradable", "wallet"],
    ),
    PolymarketWallet: obj(
      {
        address: str(), kind: WALLET_KIND, owner: str({ description: "The EVM wallet (EOA) that owns it and signs for it." }),
        signatureType: int({ enum: [1, 2, 3] }), tradable: bool(),
        verifiedBy: str({ description: "What was read on Polygon to accept it as the owner's." }),
        onProfile: bool({ description: "Polymarket's public profile of the owner names this wallet." }),
        balances: nullable(obj({ pusd: str(), usdce: str() }, ["pusd", "usdce"])),
        actions: arrayOf(str({ enum: ["deposit", "withdraw", "wrap"] })),
        note: nullable(str()),
      },
      ["address", "kind", "owner", "signatureType", "tradable", "verifiedBy", "onProfile", "balances", "actions", "note"],
    ),
    PolymarketWalletsResponse: obj(
      {
        account: str(), owner: str(), plainWallet: bool({ description: "The account itself has no code (it can trade for itself where Polymarket allows it)." }),
        wallets: arrayOf(ref("PolymarketWallet")),
        profile: obj({ status: str({ enum: ["listed", "unverified", "none", "unavailable"] }), wallet: nullable(str()) }, ["status", "wallet"]),
        notes: arrayOf(str()),
      },
      ["account", "owner", "plainWallet", "wallets", "profile", "notes"],
    ),
    PredictionWalletActionRequest: obj(
      {
        account: ACCOUNT, wallet: WALLET_ADDRESS,
        action: str({ enum: ["deposit", "withdraw", "wrap"], description: "deposit: account to wallet (any kind); withdraw: Safe to its owner; wrap: the Safe's USDC.e into pUSD." }),
        amountUsd: str({ pattern: "^\\d{1,9}(\\.\\d{1,6})?$" }),
        asset: str({ enum: ["pUSD", "USDC.e"], description: "Default pUSD (wrap: USDC.e)." }),
      },
      ["account", "wallet", "action", "amountUsd"],
    ),
    PredictionWalletActionResponse: obj(
      {
        prepared: obj(
          { venue: VENUE, network: str(), account: str(), wallet: obj({ address: str(), kind: WALLET_KIND, owner: str() }, ["address", "kind", "owner"]), action: str(), steps: arrayOf(ref("PredictionStep")), note: str() },
          ["venue", "network", "account", "wallet", "action", "steps", "note"],
        ),
      },
      ["prepared"],
    ),
    PredictionRequest: obj(
      {
        venue: VENUE,
        marketId: str({ examples: ["666861"] }),
        outcome: str({ examples: ["Yes"] }),
        side: SIDE,
        orderType: str({ enum: [...PREDICTION_ORDER_TYPES], default: "market", description: "market: fill now (FAK, the rest is cancelled); limit: rest on the book (GTC)." }),
        amountUsd: str({ pattern: "^\\d{1,7}(\\.\\d{1,2})?$", description: "buy: USD to spend, fees included." }),
        shares: str({ pattern: "^\\d{1,9}(\\.\\d{1,2})?$" }),
        limitPrice: str({ pattern: "^0?\\.\\d{1,4}$" }),
        slippageBps: int({ minimum: PREDICTION_LIMITS.minSlippageBps, maximum: PREDICTION_LIMITS.maxSlippageBps, default: PREDICTION_LIMITS.defaultSlippageBps }),
        account: ACCOUNT,
        hasSession: bool({ description: "prepare: true when the caller holds a venue session (no sign-in step is added)." }),
        wallet: { ...WALLET_ADDRESS, description: "prepare: trade from the account's Polymarket Safe (signatureType 2) or Deposit Wallet (3); omitted, the account trades for itself (signatureType 0)." },
      },
      ["marketId", "outcome", "side"],
      { additionalProperties: false },
    ),
    PredictionQuote: obj(
      {
        venue: VENUE, marketId: str(), question: str(), outcome: str(), tokenId: str(), side: SIDE, orderType: str({ enum: [...PREDICTION_ORDER_TYPES] }),
        impliedProbability: nullable(num({ description: "Best price on the side the order takes (0 to 1)." })),
        avgPrice: num(), worstPrice: num({ description: "Worst price the signed order accepts." }), shares: num(),
        notionalUsd: num(), spendCapUsd: nullable(num({ description: "buy: the most the signed order may spend before fees." })), feeUsd: num(),
        maxLossUsd: num({ description: "buy: the most it can cost, fees included (never above the stake)." }),
        payoutIfWinUsd: num(), profitIfWinUsd: num(), fillable: num(), warnings: arrayOf(str()),
      },
      ["venue", "marketId", "question", "outcome", "tokenId", "side", "orderType", "impliedProbability", "avgPrice", "worstPrice", "shares", "notionalUsd", "spendCapUsd", "feeUsd", "maxLossUsd", "payoutIfWinUsd", "profitIfWinUsd", "fillable", "warnings"],
    ),
    PredictionQuoteResponse: obj(
      { request: ref("PredictionRequest"), market: obj({ id: str(), question: str(), endDate: nullable(str()), url: str(), negRisk: bool(), version: str() }, ["id", "question", "endDate", "url", "negRisk", "version"]), quote: ref("PredictionQuote") },
      ["request", "market", "quote"],
    ),
    PredictionOrder: obj(
      {
        salt: str(), maker: str(), signer: str(), tokenId: str(), makerAmount: str(), takerAmount: str(), side: int({ enum: [0, 1] }), signatureType: int({ enum: [0, 2, 3], description: "0 plain wallet; 2 Safe (maker = Safe, signer = account); 3 Deposit Wallet (maker = signer = wallet, ERC-1271)." }),
        timestamp: str(), metadata: str(), builder: str(), expiration: str(), orderType: str({ enum: ["FAK", "GTC"] }), exchange: str(), domainVersion: str({ enum: ["2", "3"] }),
      },
      ["salt", "maker", "signer", "tokenId", "makerAmount", "takerAmount", "side", "signatureType", "timestamp", "metadata", "builder", "expiration", "orderType", "exchange", "domainVersion"],
      { description: "The order as prepared; send it back unchanged." },
    ),
    PredictionStep: obj(
      {
        kind: str({ enum: ["transaction", "typed-data"] }),
        id: str(),
        title: str(),
        transaction: obj({}, [], { description: "kind transaction: an EVM transaction on Polygon for the wallet." }),
        disclosure: str({ description: "What an operator approval allows (it has no amount)." }),
        safeTx: obj({ safe: str(), nonce: str(), hash: str() }, ["safe", "nonce", "hash"], { description: "A call run by the account's Safe (execTransaction sent by the account): the EIP-712 SafeTx hash at the Safe's nonce." }),
        purpose: str({ enum: ["clob-auth", "order"] }),
        typedData: TYPED_DATA,
      },
      ["kind", "id", "title"],
    ),
    PredictionPrepared: obj(
      {
        venue: VENUE, network: str(), account: str(),
        wallet: nullable(obj({ address: str(), kind: WALLET_KIND, owner: str() }, ["address", "kind", "owner"], { description: "The Polymarket wallet that trades (maker)." })),
        quote: ref("PredictionQuote"), steps: arrayOf(ref("PredictionStep")), order: ref("PredictionOrder"),
        orderHash: str(), ticket: str(), expiresAt: int(), warnings: arrayOf(str()),
      },
      ["venue", "network", "account", "wallet", "quote", "steps", "order", "orderHash", "ticket", "expiresAt", "warnings"],
    ),
    PredictionPrepareResponse: obj({ prepared: ref("PredictionPrepared") }, ["prepared"]),
    PredictionSessionRequest: obj(
      { account: ACCOUNT, auth: obj({ timestamp: int(), signature: SIGNATURE }, ["timestamp", "signature"], { description: "The signed sign-in (ClobAuth) of the account." }) },
      ["account"],
    ),
    PredictionSessionResponse: obj({ account: str(), typedData: TYPED_DATA, session: SESSION, expiresAt: int() }, ["account"]),
    PredictionSubmitRequest: obj(
      { venue: VENUE, account: ACCOUNT, order: ref("PredictionOrder"), ticket: str(), signature: SIGNATURE, session: SESSION, auth: obj({ timestamp: int(), signature: SIGNATURE }, ["timestamp", "signature"]) },
      ["account", "order", "ticket", "signature"],
    ),
    PredictionSubmitResponse: obj(
      {
        status: str({ enum: ["accepted"] }), orderId: str(), orderStatus: str({ description: "live (resting), matched, delayed or unmatched." }),
        makingAmount: nullable(str()), takingAmount: nullable(str()), transactionsHashes: arrayOf(str()), session: SESSION, sessionExpiresAt: int(),
      },
      ["status", "orderId", "orderStatus", "makingAmount", "takingAmount", "transactionsHashes"],
    ),
    PredictionOrdersRequest: obj({ account: ACCOUNT, session: SESSION, wallet: { ...WALLET_ADDRESS, description: "Only the orders this Polymarket wallet makes." } }, ["account", "session"]),
    PredictionOrdersResponse: obj(
      {
        account: str(),
        orders: arrayOf(obj({
          id: str(), status: str(), conditionId: nullable(str()), tokenId: nullable(str()), outcome: nullable(str()), side: nullable(SIDE), price: nullable(num()),
          shares: nullable(num()), filledShares: nullable(num()), orderType: nullable(str()), createdAt: nullable(int()), maker: nullable(str()),
        }, ["id", "status", "conditionId", "tokenId", "outcome", "side", "price", "shares", "filledShares", "orderType", "createdAt", "maker"])),
      },
      ["account", "orders"],
    ),
    PredictionCancelRequest: obj({ account: ACCOUNT, session: SESSION, orderId: str({ pattern: "^0x[0-9a-fA-F]{64}$" }) }, ["account", "session", "orderId"]),
    PredictionCancelResponse: obj({ orderId: str(), canceled: bool(), reason: nullable(str()) }, ["orderId", "canceled", "reason"]),
    PredictionRedeemRequest: obj({ account: ACCOUNT, conditionId: str({ pattern: "^0x[0-9a-fA-F]{64}$" }), wallet: { ...WALLET_ADDRESS, description: "Redeem the shares the account's Safe holds." } }, ["account", "conditionId"]),
    PredictionRedeemResponse: obj(
      {
        prepared: obj(
          {
            venue: VENUE, network: str(), account: str(), wallet: nullable(obj({ address: str(), kind: WALLET_KIND, owner: str() }, ["address", "kind", "owner"])),
            market: obj({ id: str(), question: str(), version: str(), negRisk: bool() }, ["id", "question", "version", "negRisk"]), steps: arrayOf(ref("PredictionStep")), note: str(),
          },
          ["venue", "network", "account", "wallet", "market", "steps", "note"],
        ),
      },
      ["prepared"],
    ),
  };
}

export function predictionPaths(): JsonObject {
  return {
    "/v1/predictions/markets": {
      get: {
        operationId: "listPredictionMarkets",
        tags: TAGS,
        summary: "Open prediction markets: search, category, busiest or soonest ending",
        description: "Polymarket markets that are open and take orders (Gamma API, cached 15 s), with outcome prices as implied probabilities. Limitless Exchange is listed as a venue that is not added (disabledReason). Kalshi is not integrated: it needs KYC and holds funds in custodial accounts.",
        parameters: [
          { name: "q", in: "query", schema: str({ maxLength: PREDICTION_LIMITS.maxQueryLength }) },
          { name: "category", in: "query", schema: str({ enum: [...PREDICTION_CATEGORIES] }) },
          { name: "sort", in: "query", schema: str({ enum: ["volume", "ending"], default: "volume" }) },
        ],
        responses: { "200": ok("PredictionMarketsResponse", "Venues and markets."), ...errors("502") },
      },
    },
    "/v1/predictions/markets/{id}": {
      get: {
        operationId: "getPredictionMarket",
        tags: TAGS,
        summary: "One market with each outcome's order book and a week of prices",
        description: "By Gamma market id, or by the condition id positions carry.",
        parameters: [{ name: "id", in: "path", required: true, schema: str({ pattern: "^(?:\\d{1,20}|0x[0-9a-fA-F]{64})$" }) }],
        responses: { "200": ok("PredictionMarketResponse", "The market."), ...errors("404", "502") },
      },
    },
    "/v1/predictions/positions": {
      get: {
        operationId: "listPredictionPositions",
        tags: TAGS,
        summary: "Prediction positions of a Polygon holder",
        description: "By `account` (CAIP-10), `account` with `wallet` (the account's Polymarket wallet, verified as its own; 422 PREDICTION_WALLET_NOT_FOUND otherwise) or `holder` (any address, read only). Redeemable rows have resolved.",
        parameters: [
          { name: "account", in: "query", schema: str({ maxLength: 200 }) },
          { name: "wallet", in: "query", schema: str({ pattern: "^0x[0-9a-fA-F]{40}$" }) },
          { name: "holder", in: "query", schema: str({ pattern: "^0x[0-9a-fA-F]{40}$" }) },
        ],
        responses: { "200": ok("PredictionPositionsResponse", "Positions."), ...errors("422", "502") },
      },
    },
    "/v1/predictions/wallets": {
      get: {
        operationId: "listPolymarketWallets",
        tags: TAGS,
        summary: "The account's Polymarket wallets (Safe, Deposit Wallet, Proxy)",
        description: "Derives each wallet Polymarket's factories give the account (CREATE2) and keeps those with code on Polygon that name the account as owner (Safe getOwners(), Deposit Wallet owner(); a Proxy wallet's clone code). Polymarket's public profile marks the wallet polymarket.com shows; it never adds one. Each wallet has its pUSD and USDC.e balance, whether Kletia trades it, and the wallet moves it builds. 502 RPC_UNAVAILABLE when Polygon cannot be read (never reported as no wallet).",
        parameters: [{ name: "account", in: "query", required: true, schema: str({ maxLength: 200 }) }],
        responses: { "200": ok("PolymarketWalletsResponse", "The verified wallets."), ...errors("400", "502") },
      },
    },
    "/v1/predictions/quote": {
      post: {
        operationId: "quotePrediction",
        tags: TAGS,
        summary: "Quote a prediction order: implied probability, max loss, payout, fees",
        description: `${RISK} A market buy's amount is all-in (fees included). Refusals: 422 PREDICTION_MARKET_CLOSED, PREDICTION_OUTCOME_UNKNOWN, PREDICTION_STAKE_TOO_HIGH, PREDICTION_VENUE_DISABLED; 403 PREDICTION_POLICY_DENIED; 503 PREDICTION_PRICE_UNAVAILABLE.`,
        requestBody: jsonBody("PredictionRequest"),
        responses: { "200": ok("PredictionQuoteResponse", "The quote."), ...errors("403", "404", "413", "415", "422") },
      },
    },
    "/v1/predictions/prepare": {
      post: {
        operationId: "preparePrediction",
        tags: TAGS,
        summary: "Unsigned steps for a prediction order",
        description: `${NOT_SIGNED} Exact pUSD approvals (and a USDC.e wrap when pUSD is short), the ERC-1155 operator approval a sell or a negative-risk order needs (disclosed: it has no amount), the venue sign-in unless hasSession, and the EIP-712 order. With \`wallet\`, the account's Polymarket Safe trades (signatureType 2: maker = Safe, signer = account; its approvals and wrap run through the Safe's execTransaction, sent by the account) or its Deposit Wallet (signatureType 3: the account signs the ERC-7739 TypedDataSign wrapper; its approvals run through Polymarket's relayer, so a missing one is 422 PREDICTION_WALLET_SETUP_REQUIRED). Valid ${PREDICTION_LIMITS.prepareTtlSeconds} s. Refusals as for quote, plus 422 PREDICTION_ACCOUNT_UNSUPPORTED (a Proxy wallet, or a smart account without \`wallet\`), PREDICTION_WALLET_NOT_FOUND, PREDICTION_BALANCE_TOO_LOW, PREDICTION_ORDER_TOO_SMALL, PREDICTION_POSITION_NOT_FOUND.`,
        requestBody: jsonBody("PredictionRequest"),
        responses: { "200": ok("PredictionPrepareResponse", "The steps, in order."), ...errors("403", "404", "413", "415", "422") },
      },
    },
    "/v1/predictions/session": {
      post: {
        operationId: "predictionSession",
        tags: TAGS,
        summary: "Sign in to Polymarket's order book",
        description: "{ account } returns the ClobAuth typed data to sign (no funds move); { account, auth } checks the signature, has the CLOB derive (or create) the account's API credentials, and returns them sealed for this account as `session`. Kletia stores nothing; the session lives 8 hours.",
        requestBody: jsonBody("PredictionSessionRequest"),
        responses: { "200": ok("PredictionSessionResponse", "What to sign, or the session."), ...errors("403", "413", "415", "422", "502") },
      },
    },
    "/v1/predictions/submit": {
      post: {
        operationId: "submitPrediction",
        tags: TAGS,
        summary: "Relay an order the account signed",
        description: "The ticket must match the order prepare built and the signature must recover to the account; a wallet order's maker must still be the account's Safe or Deposit Wallet on Polygon, and a Deposit Wallet must accept the packed signature (ERC-1271) (400 PREDICTION_SIGNATURE_INVALID otherwise); send `session`, or `auth` to sign in on the way. A buy is not sent while Polymarket reports the relay's location as restricted (403 PREDICTION_GEOBLOCKED); a venue refusal is 422 PREDICTION_RELAY_REJECTED with its reason.",
        requestBody: jsonBody("PredictionSubmitRequest"),
        responses: { "200": ok("PredictionSubmitResponse", "Polymarket accepted the order."), ...errors("403", "413", "415", "422", "502") },
      },
    },
    "/v1/predictions/orders": {
      post: {
        operationId: "listPredictionOrders",
        tags: TAGS,
        summary: "Open orders of the session's account",
        requestBody: jsonBody("PredictionOrdersRequest"),
        responses: { "200": ok("PredictionOrdersResponse", "Open orders."), ...errors("403", "413", "415", "422", "502") },
      },
    },
    "/v1/predictions/orders/cancel": {
      post: {
        operationId: "cancelPredictionOrder",
        tags: TAGS,
        summary: "Cancel a resting order",
        requestBody: jsonBody("PredictionCancelRequest"),
        responses: { "200": ok("PredictionCancelResponse", "The cancel result."), ...errors("403", "413", "415", "422", "502") },
      },
    },
    "/v1/predictions/redeem": {
      post: {
        operationId: "redeemPrediction",
        tags: TAGS,
        summary: "Unsigned redemption of resolved shares",
        description: `${NOT_SIGNED} v1 markets: the collateral adapter's redeemPositions (both outcomes, paid in pUSD) after its operator approval; v2 markets: Router.redeem per outcome held. 422 PREDICTION_NOT_RESOLVED before the market resolves.`,
        requestBody: jsonBody("PredictionRedeemRequest"),
        responses: { "200": ok("PredictionRedeemResponse", "The steps."), ...errors("403", "404", "413", "415", "422") },
      },
    },
    "/v1/predictions/wallet": {
      post: {
        operationId: "preparePolymarketWalletAction",
        tags: TAGS,
        summary: "Unsigned moves between the account and its Polymarket wallet",
        description: `${NOT_SIGNED} deposit: a plain pUSD or USDC.e transfer from the account to its verified Polymarket wallet; withdraw: the Safe sends pUSD or USDC.e to its owner (the account) and nowhere else; wrap: the Safe wraps its USDC.e into pUSD (CollateralOnramp). Safe moves are execTransaction calls the account sends (it pays POL gas). A Deposit Wallet's own moves run through Polymarket's relayer (422 PREDICTION_WALLET_SETUP_REQUIRED).`,
        requestBody: jsonBody("PredictionWalletActionRequest"),
        responses: { "200": ok("PredictionWalletActionResponse", "The steps."), ...errors("400", "403", "413", "415", "422") },
      },
    },
  };
}
