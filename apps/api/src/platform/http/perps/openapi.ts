/**
 * OpenAPI fragments of /v1/perps (tag *Perps*): markets, positions, quotes,
 * prepare and the Hyperliquid relay. Enums and limits come from @kletia/core
 * `perps.ts`. Merged by openapi.ts.
 */
import { PERPS_ACTIONS, PERPS_LIMITS, PERPS_SIDES, PERPS_VENUE_IDS } from "@kletia/core";
import { arrayOf, bool, errors, int, jsonBody, nullable, num, obj, ok, ref, str, type JsonObject } from "../openapiKit.js";

const TAGS = ["Perps"];
const VENUE = str({ enum: [...PERPS_VENUE_IDS] });
const SIDE = str({ enum: [...PERPS_SIDES] });
const USD = str({ pattern: "^\\d{1,9}(\\.\\d{1,6})?$", examples: ["100"] });
const SIDE_RATES = obj({ long: num(), short: num() }, ["long", "short"]);
const NOT_SIGNED = "Kletia never signs: the answer is for the user's own wallet.";

export function perpsSchemas(): JsonObject {
  return {
    PerpsVenue: obj(
      {
        id: VENUE,
        name: str(),
        network: str(),
        signing: str({ enum: ["evm-transaction", "solana-transaction", "eip712"] }),
        collateral: arrayOf(str()),
        maxLeverage: num(),
        minCollateralUsd: num(),
        minSizeUsd: num(),
        enabled: bool({ description: "False: Kletia reads the venue but prepares nothing (disabledReason says why)." }),
        disabledReason: nullable(str()),
        website: str(),
      },
      ["id", "name", "network", "signing", "collateral", "maxLeverage", "minCollateralUsd", "minSizeUsd", "enabled", "disabledReason", "website"],
    ),
    PerpsMarket: obj(
      {
        venue: VENUE,
        symbol: str({ examples: ["ETH"] }),
        marketId: str({ description: "GMX market token, Hyperliquid coin or Drift market index." }),
        network: str(),
        markPrice: num(),
        fundingRate1h: { ...SIDE_RATES, description: "Funding (plus GMX borrowing) per hour as a fraction of size; positive: the side pays." },
        openInterestUsd: nullable(SIDE_RATES),
        maxLeverage: num(),
        maintenanceMarginRate: num(),
        takerFeeRate: num(),
        impactPer10kUsd: num(),
        minSizeUsd: num(),
        minCollateralUsd: num(),
        observedAt: int({ description: "Unix seconds of the price." }),
        open: bool({ description: "False when the market takes no new positions." }),
      },
      ["venue", "symbol", "marketId", "network", "markPrice", "fundingRate1h", "openInterestUsd", "maxLeverage", "maintenanceMarginRate", "takerFeeRate", "impactPer10kUsd", "minSizeUsd", "minCollateralUsd", "observedAt", "open"],
    ),
    PerpsUnavailable: obj({ venue: VENUE, code: str(), message: str() }, ["venue", "code", "message"]),
    PerpsMarketsResponse: obj(
      { venues: arrayOf(ref("PerpsVenue")), markets: arrayOf(ref("PerpsMarket")), unavailable: arrayOf(ref("PerpsUnavailable")) },
      ["venues", "markets", "unavailable"],
    ),
    PerpsPosition: obj(
      {
        venue: VENUE,
        symbol: str(),
        marketId: str(),
        network: str(),
        side: SIDE,
        sizeUsd: num(),
        sizeBase: num(),
        collateralUsd: nullable(num()),
        entryPrice: num(),
        markPrice: nullable(num()),
        leverage: nullable(num()),
        liquidationPrice: nullable(num({ description: "Estimate from the maintenance margin (Hyperliquid: the venue's own)." })),
        unrealizedPnlUsd: nullable(num({ description: "Price PnL at the mark, before closing fees and unsettled funding." })),
      },
      ["venue", "symbol", "marketId", "network", "side", "sizeUsd", "sizeBase", "collateralUsd", "entryPrice", "markPrice", "leverage", "liquidationPrice", "unrealizedPnlUsd"],
    ),
    PerpsPositionsResponse: obj(
      {
        account: str(),
        positions: arrayOf(ref("PerpsPosition")),
        unavailable: arrayOf(ref("PerpsUnavailable")),
        unsupported: int({ description: "GMX positions outside the USDC markets Kletia lists (not shown)." }),
      },
      ["account", "positions", "unavailable", "unsupported"],
    ),
    PerpsRequest: obj(
      {
        action: str({ enum: [...PERPS_ACTIONS], default: "open" }),
        symbol: str({ examples: ["ETH"] }),
        side: SIDE,
        venue: VENUE,
        sizeUsd: USD,
        collateral: obj({ asset: str({ examples: ["USDC"] }), amount: USD }, ["asset", "amount"]),
        leverage: num({ minimum: 1, maximum: 100 }),
        slippageBps: int({ minimum: PERPS_LIMITS.minSlippageBps, maximum: PERPS_LIMITS.maxSlippageBps, default: PERPS_LIMITS.defaultSlippageBps }),
        account: str({ description: "CAIP-10 account on the venue's network (prepare)." }),
        orderId: int({ minimum: 0, description: "cancel: the Hyperliquid order id." }),
      },
      ["symbol", "side"],
      { additionalProperties: false },
    ),
    PerpsQuote: obj(
      {
        venue: VENUE,
        symbol: str(),
        side: SIDE,
        action: str({ enum: [...PERPS_ACTIONS] }),
        sizeUsd: num(),
        collateralUsd: num(),
        leverage: num(),
        markPrice: num(),
        entryPrice: num(),
        acceptablePrice: num({ description: "Worst fill the payload accepts; the venue refuses a worse one." }),
        liquidationPrice: nullable(num()),
        fees: obj({ openUsd: num(), closeUsd: num(), executionUsd: nullable(num()) }, ["openUsd", "closeUsd", "executionUsd"]),
        funding1hUsd: num(),
        warnings: arrayOf(str()),
      },
      ["venue", "symbol", "side", "action", "sizeUsd", "collateralUsd", "leverage", "markPrice", "entryPrice", "acceptablePrice", "liquidationPrice", "fees", "funding1hUsd", "warnings"],
    ),
    PerpsVenueChoice: obj(
      { venue: VENUE, eligible: bool(), reason: nullable(str()), costUsd: nullable(num()), quote: nullable(ref("PerpsQuote")) },
      ["venue", "eligible", "reason", "costUsd", "quote"],
    ),
    PerpsQuoteResponse: obj(
      { request: ref("PerpsRequest"), best: nullable(ref("PerpsVenueChoice")), choices: arrayOf(ref("PerpsVenueChoice")) },
      ["request", "best", "choices"],
    ),
    PerpsStep: obj(
      {
        kind: str({ enum: ["transaction", "typed-data"] }),
        id: str(),
        title: str(),
        transaction: obj({}, [], { description: "kind transaction: an EVM or Solana transaction request for the wallet." }),
        settleSeconds: int({ description: "Seconds the venue needs after this transaction before the next step can succeed." }),
        typedData: obj({ domain: obj({}), types: obj({}), primaryType: str(), message: obj({}) }, ["domain", "types", "primaryType", "message"]),
        relay: obj({ venue: VENUE, action: obj({}), nonce: int() }, ["venue", "action", "nonce"]),
      },
      ["kind", "id", "title"],
    ),
    PerpsPrepared: obj(
      {
        venue: VENUE,
        network: str(),
        account: str(),
        quote: nullable(ref("PerpsQuote")),
        steps: arrayOf(ref("PerpsStep")),
        expiresAt: int(),
        warnings: arrayOf(str()),
      },
      ["venue", "network", "account", "quote", "steps", "expiresAt", "warnings"],
    ),
    PerpsPrepareResponse: obj({ prepared: ref("PerpsPrepared") }, ["prepared"]),
    PerpsSubmitRequest: obj(
      {
        venue: str({ enum: ["hyperliquid"] }),
        account: str({ description: "eip155:42161:0x… of the signer." }),
        action: obj({}, [], { description: "relay.action of the prepared step, unchanged." }),
        nonce: int({ description: "relay.nonce of the prepared step." }),
        signature: str({ pattern: "^0x[0-9a-fA-F]{130}$" }),
      },
      ["venue", "account", "action", "nonce", "signature"],
    ),
    PerpsSubmitResponse: obj({ status: str({ enum: ["ok"] }), response: obj({}, [], { description: "The exchange's answer (order statuses)." }) }, ["status", "response"]),
  };
}

export function perpsPaths(): JsonObject {
  return {
    "/v1/perps/markets": {
      get: {
        operationId: "listPerpsMarkets",
        tags: TAGS,
        summary: "Perps venues and their markets",
        description: `Venues (GMX v2, Hyperliquid, Drift v2) and their markets with mark price, funding and open interest, read live and cached 10 s. A venue that cannot be read, or whose price is older than ${PERPS_LIMITS.maxPriceAgeSeconds} s, lists no markets (\`unavailable\` says why); prices are never guessed.`,
        responses: { "200": ok("PerpsMarketsResponse", "Venues and markets."), ...errors() },
      },
    },
    "/v1/perps/positions": {
      get: {
        operationId: "listPerpsPositions",
        tags: TAGS,
        summary: "Open perps positions of an account",
        description: "EVM accounts: GMX v2 (USDC markets) and Hyperliquid; Solana accounts: Drift v2. PnL is price PnL at the mark before closing fees and unsettled funding.",
        parameters: [{ name: "account", in: "query", required: true, schema: str({ maxLength: 200, examples: ["eip155:42161:0x4f183e308f24c81c05303821AD025812fBFd807D"] }) }],
        responses: { "200": ok("PerpsPositionsResponse", "Positions."), ...errors() },
      },
    },
    "/v1/perps/quote": {
      post: {
        operationId: "quotePerps",
        tags: TAGS,
        summary: "Quote a perps order (best venue when none is named)",
        description: `Entry and acceptable price, estimated liquidation price, fees and one hour of funding. Without \`venue\`, every venue is scored by fees, a day of funding and price impact (cheapest eligible first, the others with the reason). Refusals: 422 PERPS_LEVERAGE_TOO_HIGH, PERPS_COLLATERAL_TOO_LOW, PERPS_MARKET_UNSUPPORTED, PERPS_VENUE_DISABLED; 403 PERPS_POLICY_DENIED; 503 PERPS_PRICE_UNAVAILABLE.`,
        requestBody: jsonBody("PerpsRequest"),
        responses: { "200": ok("PerpsQuoteResponse", "The quote and the scored venues."), ...errors("403", "413", "415", "422") },
      },
    },
    "/v1/perps/prepare": {
      post: {
        operationId: "preparePerps",
        tags: TAGS,
        summary: "Unsigned steps for a perps order",
        description: `${NOT_SIGNED} GMX: an exact USDC approval when needed and one ExchangeRouter multicall (sendWnt, sendTokens, createOrder) whose value is the execution fee. Hyperliquid: a Bridge2 USDC deposit when the account lacks margin, then EIP-712 L1 actions (updateLeverage, order, cancel) to sign and send back to POST /v1/perps/submit. Drift v2 is disabled. Valid 60 s. Refusals as for quote, plus 422 PERPS_POSITION_NOT_FOUND and 400 ACCOUNT_INVALID.`,
        requestBody: jsonBody("PerpsRequest"),
        responses: { "200": ok("PerpsPrepareResponse", "The steps, in order."), ...errors("403", "413", "415", "422") },
      },
    },
    "/v1/perps/submit": {
      post: {
        operationId: "submitPerps",
        tags: TAGS,
        summary: "Relay a Hyperliquid action the account signed",
        description: "Rebuilds the action from its fields, checks the nonce is recent and that the signature recovers to the account (400 PERPS_SIGNATURE_INVALID otherwise), then forwards it to Hyperliquid's /exchange. 422 PERPS_RELAY_REJECTED carries the exchange's reason.",
        requestBody: jsonBody("PerpsSubmitRequest"),
        responses: { "200": ok("PerpsSubmitResponse", "The exchange accepted the action."), ...errors("403", "413", "415", "422", "502") },
      },
    },
  };
}
