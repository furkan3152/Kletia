/**
 * OpenAPI fragments of native protocol orders (tag *Orders*): Jupiter
 * Trigger and Recurring on Solana, CoW Protocol limit and TWAP orders on
 * Ethereum, Arbitrum and Base. Merged by openapi.ts.
 */
import { MAX_ORDER_OWNERS, ORDER_LIMITS, ORDER_NETWORKS, PREPARATION_ID_PATTERN } from "../../orders/index.js";
import { arrayOf, bool, errors, idempotencyKeyParameter, int, jsonBody, nullable, obj, ok, ref, str, type JsonObject } from "../openapiKit.js";
import { ORDER_BUILDS_PER_MINUTE_PER_IP, ORDER_LISTS_PER_MINUTE_PER_IP } from "./handlers.js";

const TAGS = ["Orders"];
const NETWORK = str({ enum: [...ORDER_NETWORKS] });
const PROTOCOL = str({ enum: ["jupiter-trigger", "jupiter-recurring", "cow-protocol"] });
const MECHANISM = str({ enum: ["limit", "recurring", "twap"] });
const TIME = str({ format: "date-time" });
const NULLABLE_TIME = { type: ["string", "null"], format: "date-time" };
const ORDER_ID = str({ description: "`<protocol>:<network>:<native id>`: the Jupiter order account, the CoW order uid, or `twap-<ComposableCoW hash>`.", examples: ["cow-protocol:base:0xe51b…82e4"] });
const ID_PARAM: JsonObject = { name: "id", in: "path", required: true, schema: ORDER_ID };
const LIMIT_NOTE = `At most ${ORDER_BUILDS_PER_MINUTE_PER_IP} quotes, preparations and cancels per minute from one address.`;

export function orderSchemas(): JsonObject {
  return {
    OrderRequest: obj(
      {
        kind: str({ enum: ["limit", "dca"] }),
        owner: str({ description: "The wallet that signs: an EVM or Solana address, or a CAIP-10 account." }),
        sell: str({ description: "Symbol, address or mint of the asset sold." }),
        buy: str({ description: "Symbol, address or mint of the asset bought." }),
        amount: str({ pattern: "^(?:0|[1-9]\\d*)(?:\\.\\d+)?$", description: "Decimal amount of the `amountIn` side; for DCA the total sold." }),
        amountIn: str({ enum: ["sell", "buy"], default: "sell", description: "Limit orders only: `buy` counts the amount in the asset bought (\"buy 1000 JUP at 0.8\")." }),
        price: str({ description: "Limit (required): counter-asset units per one unit of the `amountIn` asset. DCA on CoW: the least bought per one sold (else 10% below the quote at preparation); not accepted for Jupiter Recurring." }),
        period: { oneOf: [str({ enum: ["minute", "hour", "day", "week", "month"] }), int({ minimum: ORDER_LIMITS.minPeriodSeconds, maximum: ORDER_LIMITS.maxPeriodSeconds })], description: "DCA: time between parts (a name or seconds)." },
        count: int({ minimum: ORDER_LIMITS.minCount, maximum: ORDER_LIMITS.maxCount, description: "DCA: number of parts." }),
        network: { ...NETWORK, description: "Inferred from the assets when only one order network lists both (else 422 ORDER_NETWORK_REQUIRED with error.details.candidates)." },
        expiresAt: { oneOf: [TIME, int()], description: "Limit only: ISO time or unix seconds, within one year. CoW orders default to 30 days; Jupiter orders without it never expire." },
      },
      ["kind", "owner", "sell", "buy", "amount"],
    ),
    OrderPlan: obj(
      {
        kind: str({ enum: ["limit", "dca"] }),
        protocol: PROTOCOL,
        mechanism: MECHANISM,
        network: NETWORK,
        sell: str(),
        buy: str(),
        amount: str(),
        amountIn: str({ enum: ["sell", "buy"] }),
        price: nullable(str()),
        periodSeconds: nullable(int()),
        count: nullable(int()),
        expiresAt: nullable(int({ description: "Unix seconds." })),
      },
      ["kind", "protocol", "mechanism", "network", "sell", "buy", "amount", "amountIn", "price", "periodSeconds", "count", "expiresAt"],
    ),
    OrderAmount: obj(
      { asset: str({ description: "CAIP-19 id." }), symbol: str(), decimals: int(), amount: str({ description: "Base units." }), formatted: str() },
      ["asset", "symbol", "decimals", "amount", "formatted"],
    ),
    OrderQuote: obj(
      {
        protocol: PROTOCOL,
        mechanism: MECHANISM,
        network: NETWORK,
        sell: ref("OrderAmount"),
        buy: { oneOf: [ref("OrderAmount"), { type: "null" }], description: "Limit: least received. DCA: the protection floor, or null." },
        market: { oneOf: [ref("OrderAmount"), { type: "null" }], description: "What the market gives now for the same order (or one part); null when no quote was available." },
        limitVsMarketPct: { type: ["number", "null"], description: "How much better than the market the limit is, in percent (positive: waits for the price to move)." },
        schedule: nullable(obj({ parts: int(), periodSeconds: int(), perPart: ref("OrderAmount"), endsAt: TIME }, ["parts", "periodSeconds", "perPart", "endsAt"])),
        expiresAt: NULLABLE_TIME,
        fees: str(),
        custody: str({ description: "Where the funds are until the order fills. Kletia never holds them." }),
        warnings: arrayOf(str()),
      },
      ["protocol", "mechanism", "network", "sell", "buy", "market", "limitVsMarketPct", "schedule", "expiresAt", "fees", "custody", "warnings"],
    ),
    OrderQuoteResponse: obj({ plan: ref("OrderPlan"), quote: ref("OrderQuote") }, ["plan", "quote"]),
    OrderSignRequest: {
      oneOf: [
        obj(
          { kind: str({ const: "solana-transaction" }), network: str({ const: "solana" }), transaction: str({ description: "Unsigned base64 wire transaction." }), encoding: str({ const: "base64" }), messageHash: str({ description: "sha256 (hex) of the message bytes; the signed transaction must carry exactly this message." }), description: str() },
          ["kind", "network", "transaction", "encoding", "messageHash", "description"],
        ),
        obj(
          { kind: str({ const: "evm-transaction" }), network: NETWORK, chainId: int(), to: str(), data: str(), value: str({ const: "0" }), description: str() },
          ["kind", "network", "chainId", "to", "data", "value", "description"],
        ),
        obj(
          { kind: str({ const: "eip712" }), network: NETWORK, chainId: int(), typedData: obj({ domain: obj({}), types: obj({}), primaryType: str(), message: obj({}) }, ["domain", "types", "primaryType", "message"]), digest: str({ description: "The EIP-712 digest the signature must belong to." }), description: str() },
          ["kind", "network", "chainId", "typedData", "digest", "description"],
        ),
        obj(
          { kind: str({ const: "safe-transaction" }), network: NETWORK, chainId: int(), safe: str(), to: str(), data: str(), value: str({ const: "0" }), operation: int({ const: 0 }), description: str() },
          ["kind", "network", "chainId", "safe", "to", "data", "value", "operation", "description"],
        ),
      ],
    },
    OrderPreparation: obj(
      {
        id: str({ pattern: PREPARATION_ID_PATTERN.source }),
        protocol: PROTOCOL,
        action: str({ enum: ["create", "cancel"] }),
        network: NETWORK,
        owner: str(),
        orderId: nullable(ORDER_ID),
        steps: arrayOf(ref("OrderSignRequest"), { description: "In order. Transactions the wallet or Safe sends itself; the last `solana-transaction` or `eip712` step comes back through POST /v1/orders/submit." }),
        submit: str({ enum: ["kletia", "wallet"], description: "`wallet`: the wallet or Safe executes every step, nothing is submitted to Kletia." }),
        expiresAt: TIME,
        warnings: arrayOf(str()),
      },
      ["id", "protocol", "action", "network", "owner", "orderId", "steps", "submit", "expiresAt", "warnings"],
    ),
    OrderPrepareResponse: obj({ plan: ref("OrderPlan"), preparation: ref("OrderPreparation") }, ["plan", "preparation"]),
    OrderPreparationResponse: obj({ preparation: ref("OrderPreparation") }, ["preparation"]),
    OrderSubmitRequest: obj(
      {
        preparationId: str({ pattern: PREPARATION_ID_PATTERN.source }),
        signedTransaction: str({ description: "Solana: the base64 wire transaction the wallet signed." }),
        signature: str({ pattern: "^0x[0-9a-fA-F]+$", description: "EIP-712: the 0x signature the wallet returned." }),
      },
      ["preparationId"],
    ),
    OrderSubmitted: obj(
      {
        id: nullable(ORDER_ID),
        preparationId: str(),
        protocol: PROTOCOL,
        network: NETWORK,
        action: str({ enum: ["create", "cancel"] }),
        status: str({ enum: ["submitted", "cancelled"] }),
        reference: str({ description: "Solana transaction signature, or the CoW order uid." }),
      },
      ["id", "preparationId", "protocol", "network", "action", "status", "reference"],
    ),
    OrderSubmitResponse: obj({ order: ref("OrderSubmitted") }, ["order"]),
    NativeOrder: obj(
      {
        id: ORDER_ID,
        protocol: PROTOCOL,
        mechanism: MECHANISM,
        network: NETWORK,
        owner: str(),
        status: str({ enum: ["open", "filled", "cancelled", "expired", "unknown"], description: "`unknown`: a state Kletia does not recognise; never shown as open or filled." }),
        sell: ref("OrderAmount"),
        buy: { oneOf: [ref("OrderAmount"), { type: "null" }] },
        sold: ref("OrderAmount"),
        bought: ref("OrderAmount"),
        createdAt: NULLABLE_TIME,
        expiresAt: NULLABLE_TIME,
        schedule: nullable(obj({ perPart: ref("OrderAmount"), periodSeconds: int() }, ["perPart", "periodSeconds"])),
        transactions: arrayOf(str()),
        cancellable: bool(),
      },
      ["id", "protocol", "mechanism", "network", "owner", "status", "sell", "buy", "sold", "bought", "createdAt", "expiresAt", "schedule", "transactions", "cancellable"],
    ),
    NativeOrderResponse: obj({ order: ref("NativeOrder") }, ["order"]),
    NativeOrderList: obj(
      {
        orders: arrayOf(ref("NativeOrder")),
        failures: arrayOf(obj({ protocol: PROTOCOL, network: NETWORK, owner: str(), code: str(), message: str() }, ["protocol", "network", "owner", "code", "message"]), {
          description: "Protocols that could not be read: their orders are unknown, not absent.",
        }),
      },
      ["orders", "failures"],
    ),
    OrderCancelRequest: obj({ owner: str({ description: "The wallet that owns the order." }) }, ["owner"]),
  };
}

export function orderPaths(): JsonObject {
  return {
    "/v1/orders/quote": {
      post: {
        operationId: "quoteOrder",
        tags: TAGS,
        summary: "Quote a native limit or DCA order",
        description: `Checks the order, picks the protocol (Solana: Jupiter Trigger for limit, Jupiter Recurring for DCA; Ethereum, Arbitrum, Base: CoW Protocol limit orders, TWAP for DCA) and compares it with the market. Nothing is stored. ${LIMIT_NOTE}`,
        requestBody: jsonBody("OrderRequest"),
        responses: { "200": ok("OrderQuoteResponse", "The plan and the quote."), ...errors("413", "415", "422", "502") },
      },
    },
    "/v1/orders/prepare": {
      post: {
        operationId: "prepareOrder",
        tags: TAGS,
        summary: "Prepare what the owner signs",
        description: `Jupiter: an unsigned transaction built by Jupiter and checked by Kletia (fee payer and sole signer, programs, compute budget). CoW limit: an approval of the GPv2VaultRelayer when the allowance is short, then the EIP-712 order. CoW TWAP: Safe transactions (only a Safe set up for ComposableCoW can create one; a plain account gets 422 ORDER_UNSUPPORTED with error.details.reason \`twap-requires-safe\`). Preparations live briefly on the instance that made them. ${LIMIT_NOTE}`,
        requestBody: jsonBody("OrderRequest"),
        responses: { "200": ok("OrderPrepareResponse", "The plan and the preparation."), ...errors("413", "415", "422", "502") },
      },
    },
    "/v1/orders/submit": {
      post: {
        operationId: "submitOrder",
        tags: TAGS,
        summary: "Relay the owner's signature",
        description: "Fail closed: a signed Solana transaction must carry byte for byte the prepared message (its sha256) and a valid signature of the owner, and nothing else is signed; an EIP-712 signature must recover to the owner over the prepared digest (ERC-1271 `isValidSignature` for contract owners). Otherwise 422 ORDER_SIGNATURE_MISMATCH and nothing is relayed. Then Kletia relays exactly that: Jupiter's `/execute`, or the CoW orderbook. Repeating the relayed submission returns the same result (Idempotent-Replayed); another signature for a used preparation is 409 ORDER_PREPARATION_USED.",
        parameters: [idempotencyKeyParameter],
        requestBody: jsonBody("OrderSubmitRequest"),
        responses: {
          "200": ok("OrderSubmitResponse", "Relayed (or the replayed result of the same submission).", { "Idempotent-Replayed": { $ref: "#/components/headers/Idempotent-Replayed" } }),
          ...errors("404", "409", "410", "413", "415", "422", "502"),
        },
      },
    },
    "/v1/orders": {
      get: {
        operationId: "listOrders",
        tags: TAGS,
        summary: "An owner's native orders",
        description: `Open and recent orders of up to ${MAX_ORDER_OWNERS} wallets on every protocol their family reaches (Solana: Jupiter; EVM: CoW on Ethereum, Arbitrum and Base), newest first. Jupiter reports its first page of open and of past orders; CoW the newest 20 per network. At most ${ORDER_LISTS_PER_MINUTE_PER_IP} lists per minute from one address.`,
        parameters: [
          { name: "owner", in: "query", required: true, description: "Comma-separated EVM or Solana addresses (or CAIP-10 accounts).", schema: str() },
          { name: "network", in: "query", required: false, schema: NETWORK },
        ],
        responses: { "200": ok("NativeOrderList", "Orders and the protocols that could not be read."), ...errors() },
      },
    },
    "/v1/orders/{id}": {
      get: {
        operationId: "getOrder",
        tags: TAGS,
        summary: "One native order",
        parameters: [ID_PARAM, { name: "owner", in: "query", required: true, schema: str() }],
        responses: { "200": ok("NativeOrderResponse", "The order."), ...errors("404", "502") },
      },
    },
    "/v1/orders/{id}/cancel": {
      post: {
        operationId: "cancelOrder",
        tags: TAGS,
        summary: "Prepare the cancellation of an open order",
        description: `Jupiter: an unsigned cancel transaction (submit it like a creation). CoW, plain account: an EIP-712 OrderCancellations message (no gas; best effort until settlement). CoW, contract owner: GPv2Settlement.invalidateOrder as a Safe transaction. TWAP: ComposableCoW.remove as a Safe transaction. Orders that are not open are 409 ORDER_NOT_CANCELLABLE. ${LIMIT_NOTE}`,
        parameters: [ID_PARAM],
        requestBody: jsonBody("OrderCancelRequest"),
        responses: { "200": ok("OrderPreparationResponse", "The cancellation to sign."), ...errors("404", "409", "413", "415", "422", "502") },
      },
    },
  };
}
