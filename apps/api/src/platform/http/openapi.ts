/**
 * Hand-written OpenAPI 3.1 document for Platform API v1. Enumerations
 * (networks, CAIP-2 ids, protocols, action kinds) are generated from
 * @kletia/core so they never drift from the registries; shapes mirror the
 * handlers in router.ts and the types in @kletia/core.
 */
import { CHAINS, INTENT_SPEC_VERSION, NETWORK_KEYS, PROTOCOLS } from "@kletia/core";
import { REJECTION_CODES } from "../index.js";
import { ACTION_KINDS } from "./catalog.js";
import { EVENT_ID_PATTERN, INTENT_ID_PATTERN, MAX_REFERENCE_LENGTH, MAX_REFERENCES, STEP_ID_PATTERN, WEBHOOK_ID_PATTERN } from "./context.js";
import { PLATFORM_API_VERSION } from "./health.js";
import { KEY_ISSUANCE_LIMIT_PER_HOUR, TIER_LIMITS } from "./limits.js";
import { SSE_HEARTBEAT_MS, SSE_MAX_DURATION_MS, SSE_RETRY_MS } from "./sse.js";
import { MAX_WEBHOOKS_PER_KEY, WEBHOOK_EVENT_TYPES } from "./webhooks.js";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const ref = (name: string): JsonObject => ({ $ref: `#/components/schemas/${name}` });
const arrayOf = (items: JsonObject, extra: JsonObject = {}): JsonObject => ({ type: "array", items, ...extra });
const str = (extra: JsonObject = {}): JsonObject => ({ type: "string", ...extra });
const int = (extra: JsonObject = {}): JsonObject => ({ type: "integer", ...extra });
const num = (extra: JsonObject = {}): JsonObject => ({ type: "number", ...extra });
const bool = (extra: JsonObject = {}): JsonObject => ({ type: "boolean", ...extra });
const obj = (properties: JsonObject, required: readonly string[] = [], extra: JsonObject = {}): JsonObject => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required: [...required] } : {}),
  ...extra,
});

const INTENT_STATUSES = ["planned", "executing", "settling", "completed", "partially_completed", "failed", "expired", "cancelled", "indeterminate"];
const STEP_STATUSES = ["pending", "ready", "awaiting_signature", "submitted", "confirmed", "settling", "settled", "failed", "skipped", "indeterminate"];
const ACCOUNT_EXAMPLE = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

function schemas(): JsonObject {
  return {
    NetworkKey: str({ enum: [...NETWORK_KEYS], description: "Kletia network key." }),
    CaipChainId: str({ enum: NETWORK_KEYS.map((key) => CHAINS[key].id), description: "CAIP-2 chain id." }),
    AccountId: str({
      description: "CAIP-10 account id: `<CAIP-2>:<address>`.",
      pattern: "^(eip155|solana):[-_a-zA-Z0-9]{1,32}:[A-Za-z0-9]{32,44}$",
      examples: [ACCOUNT_EXAMPLE, "eip155:8453:0x4f183e308f24c81c05303821AD025812fBFd807D"],
    }),
    AssetId: str({
      description: "CAIP-19 asset id. Natives use `slip44`, ERC-20s `erc20`, SPL mints `token`.",
      pattern: "^(eip155|solana):[-_a-zA-Z0-9]{1,32}/(slip44|erc20|token):[A-Za-z0-9]+$",
      examples: ["eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/slip44:501"],
    }),
    BaseUnits: str({ pattern: "^(0|[1-9][0-9]*)$", description: "Integer amount in base units, as a string." }),
    DecimalAmount: str({ pattern: "^(0|[1-9][0-9]*)(\\.[0-9]+)?$", description: "Decimal amount in human units, as a string." }),
    ProtocolId: str({ enum: PROTOCOLS.map((protocol) => protocol.id) }),
    IntentActionKind: str({ enum: [...ACTION_KINDS] }),
    IntentStatus: str({ enum: INTENT_STATUSES }),
    StepStatus: str({ enum: STEP_STATUSES }),
    IntentId: str({ pattern: INTENT_ID_PATTERN.source }),
    StepId: str({ pattern: STEP_ID_PATTERN.source }),
    EventId: str({ pattern: EVENT_ID_PATTERN.source }),

    Error: obj(
      {
        error: obj(
          {
            code: str({ pattern: "^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$", description: "Stable UPPER_SNAKE_CASE code.", examples: ["INTENT_UNSUPPORTED"] }),
            message: str(),
            issues: arrayOf(obj({ path: str(), message: str() }, ["path", "message"])),
            hints: arrayOf(str(), { description: "Optional guidance, e.g. example phrases on INTENT_UNSUPPORTED." }),
          },
          ["code", "message"],
        ),
        requestId: str({ format: "uuid" }),
      },
      ["error", "requestId"],
    ),

    IntentActionSpec: obj(
      {
        kind: ref("IntentActionKind"),
        network: ref("NetworkKey"),
        from: str({ maxLength: 128, description: "Input asset: symbol on `network`, address/mint or CAIP-19 id." }),
        to: str({ maxLength: 128, description: "Output asset (on `toNetwork` for bridges)." }),
        amount: str({ pattern: "^(max|(0|[1-9][0-9]*)(\\.[0-9]+)?)$", description: "Decimal amount of `from`, or `max` (on a dependent step: the guaranteed output of the previous step)." }),
        toNetwork: ref("NetworkKey"),
        recipient: str({ maxLength: 128, description: "Address or CAIP-10 account. Defaults to the acting account." }),
        protocol: ref("ProtocolId"),
        params: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] } },
      },
      ["kind", "network"],
    ),
    IntentConstraints: obj({
      maxSlippageBps: int({ minimum: 1, maximum: 1000, default: 50 }),
      deadline: int({ minimum: 1, description: "Unix seconds after which the plan must not be executed." }),
      maxFeeUsd: num({ minimum: 0 }),
      preferProtocols: arrayOf(ref("ProtocolId")),
      avoidProtocols: arrayOf(ref("ProtocolId")),
      allowTestnets: bool(),
    }),
    IntentRequest: {
      ...obj(
        {
          text: str({ minLength: 1, maxLength: 1000, examples: ["bridge 25 USDC from base to solana then swap half to JitoSOL"] }),
          actions: arrayOf(ref("IntentActionSpec"), { minItems: 1, maxItems: 8 }),
          accounts: arrayOf(ref("AccountId"), { minItems: 1, maxItems: 6 }),
          defaultNetwork: ref("NetworkKey"),
          constraints: ref("IntentConstraints"),
          metadata: { type: "object", maxProperties: 20, propertyNames: { maxLength: 40 }, additionalProperties: str({ maxLength: 500 }) },
          clientReference: str({ pattern: "^[A-Za-z0-9_.:-]{1,80}$", description: "Idempotency key (honoured for callers with an API key)." }),
        },
        ["accounts"],
      ),
      anyOf: [{ required: ["text"] }, { required: ["actions"] }],
    },

    AssetAmount: obj(
      {
        asset: ref("AssetId"),
        symbol: str(),
        decimals: int({ minimum: 0, maximum: 36 }),
        amount: ref("BaseUnits"),
        formatted: ref("DecimalAmount"),
        usd: num(),
      },
      ["asset", "symbol", "decimals", "amount", "formatted"],
    ),
    StepEvidence: obj(
      {
        kind: str({ enum: ["transaction", "receipt", "settlement", "quote", "balance", "note"] }),
        network: ref("NetworkKey"),
        reference: str(),
        url: str({ format: "uri" }),
        observedAt: str({ format: "date-time" }),
        detail: str(),
      },
      ["kind", "network", "observedAt"],
    ),
    StepSettlement: obj(
      {
        kind: str({ enum: ["same-network", "cross-network"] }),
        destinationNetwork: ref("NetworkKey"),
        trackingId: str({ description: "Settlement-network reference (e.g. Relay request id)." }),
        expectedSeconds: int({ minimum: 0 }),
      },
      ["kind"],
    ),
    PreparedStepRecord: obj(
      {
        quoteBinding: str({ description: "SHA-256 binding of the prepared transactions." }),
        preparedAt: str({ format: "date-time" }),
        expiresAt: int({ description: "Unix seconds." }),
        transactions: arrayOf(
          obj(
            {
              vm: str({ enum: ["evm", "svm"] }),
              network: ref("NetworkKey"),
              to: str({ description: "EVM call target; for Solana steps, the program invoked." }),
              feePayer: str({ description: "Solana fee payer." }),
              description: str(),
            },
            ["vm", "network", "description"],
          ),
        ),
      },
      ["quoteBinding", "preparedAt", "expiresAt", "transactions"],
    ),
    IntentStep: obj(
      {
        id: ref("StepId"),
        index: int({ minimum: 0 }),
        kind: ref("IntentActionKind"),
        title: str(),
        network: ref("NetworkKey"),
        chain: ref("CaipChainId"),
        account: ref("AccountId"),
        protocol: ref("ProtocolId"),
        mode: str({ enum: ["wallet", "settlement", "read"] }),
        input: ref("AssetAmount"),
        expectedOutput: ref("AssetAmount"),
        minimumOutput: ref("AssetAmount"),
        recipient: ref("AccountId"),
        dependsOn: arrayOf(str()),
        settlement: ref("StepSettlement"),
        feesUsd: num(),
        estimatedSeconds: int({ minimum: 0 }),
        status: ref("StepStatus"),
        evidence: arrayOf(ref("StepEvidence")),
        quoteRef: str({ description: "Opaque adapter quote handle." }),
        warnings: arrayOf(str()),
        prepared: ref("PreparedStepRecord"),
        references: arrayOf(str(), { description: "Submitted transaction hashes / signatures, in order." }),
        actualOutput: ref("AssetAmount"),
        failure: obj({ code: str(), message: str() }, ["code", "message"]),
      },
      ["id", "index", "kind", "title", "network", "chain", "account", "protocol", "mode", "dependsOn", "status", "evidence"],
    ),
    IntentEdge: obj({ from: str(), to: str(), kind: str({ enum: ["funds", "orders"] }) }, ["from", "to", "kind"]),
    IntentSummary: obj(
      {
        title: str(),
        networks: arrayOf(ref("NetworkKey")),
        inputs: arrayOf(ref("AssetAmount")),
        outputs: arrayOf(ref("AssetAmount")),
        totalFeesUsd: num(),
        estimatedSeconds: int({ minimum: 0 }),
        signaturesRequired: int({ minimum: 0 }),
        crossNetwork: bool(),
      },
      ["title", "networks", "inputs", "outputs", "signaturesRequired", "crossNetwork"],
    ),
    IntentGraph: obj(
      {
        spec: str({ const: INTENT_SPEC_VERSION }),
        id: ref("IntentId"),
        createdAt: str({ format: "date-time" }),
        updatedAt: str({ format: "date-time" }),
        expiresAt: str({ format: "date-time" }),
        status: ref("IntentStatus"),
        request: ref("IntentRequest"),
        interpretation: obj(
          {
            source: str({ enum: ["structured", "grammar", "assistant"] }),
            normalizedText: str(),
            confidence: num({ minimum: 0, maximum: 1 }),
            optimizations: arrayOf(str()),
          },
          ["source", "confidence"],
        ),
        steps: arrayOf(ref("IntentStep")),
        edges: arrayOf(ref("IntentEdge")),
        summary: ref("IntentSummary"),
        warnings: arrayOf(str()),
        metadata: { type: "object", additionalProperties: str() },
      },
      ["spec", "id", "createdAt", "updatedAt", "expiresAt", "status", "request", "interpretation", "steps", "edges", "summary", "warnings"],
    ),

    EvmTransactionRequest: obj(
      {
        vm: str({ const: "evm" }),
        network: ref("NetworkKey"),
        chainId: int(),
        from: str({ pattern: "^0x[0-9a-fA-F]{40}$" }),
        to: str({ pattern: "^0x[0-9a-fA-F]{40}$" }),
        data: str({ pattern: "^0x([0-9a-fA-F]{2})*$" }),
        value: ref("BaseUnits"),
        gas: ref("BaseUnits"),
        description: str(),
      },
      ["vm", "network", "chainId", "from", "to", "data", "value", "description"],
      { description: "Send with eth_sendTransaction { from, to, data, value } from `from`." },
    ),
    SolanaTransactionRequest: obj(
      {
        vm: str({ const: "svm" }),
        network: ref("NetworkKey"),
        feePayer: str(),
        transaction: str({ contentEncoding: "base64", description: "Serialized, unsigned v0 transaction." }),
        encoding: str({ const: "base64" }),
        lastValidBlockHeight: int(),
        description: str(),
      },
      ["vm", "network", "feePayer", "transaction", "encoding", "description"],
      { description: "Sign and send with the wallet that owns `feePayer` (solana:signAndSendTransaction)." },
    ),
    TransactionRequest: {
      oneOf: [ref("EvmTransactionRequest"), ref("SolanaTransactionRequest")],
      discriminator: {
        propertyName: "vm",
        mapping: { evm: "#/components/schemas/EvmTransactionRequest", svm: "#/components/schemas/SolanaTransactionRequest" },
      },
    },
    StepExecutionPayload: obj(
      {
        vm: str({ enum: ["evm", "svm"] }),
        transactions: arrayOf(ref("TransactionRequest"), { minItems: 1 }),
        expiresAt: int({ description: "Unix seconds; prepare again after this." }),
        quoteBinding: str(),
      },
      ["vm", "transactions", "expiresAt", "quoteBinding"],
    ),

    IntentCreatedEvent: obj(
      {
        id: ref("EventId"),
        type: str({ const: "intent.created" }),
        at: str({ format: "date-time" }),
        data: obj(
          { intentId: ref("IntentId"), summary: ref("IntentSummary"), metadata: { type: "object", additionalProperties: str() } },
          ["intentId", "summary"],
        ),
      },
      ["id", "type", "at", "data"],
    ),
    IntentStatusChangedEvent: obj(
      {
        id: ref("EventId"),
        type: str({ const: "intent.status_changed" }),
        at: str({ format: "date-time" }),
        data: obj({ intentId: ref("IntentId"), status: ref("IntentStatus"), previous: ref("IntentStatus") }, ["intentId", "status", "previous"]),
      },
      ["id", "type", "at", "data"],
    ),
    IntentStepUpdatedEvent: obj(
      {
        id: ref("EventId"),
        type: str({ const: "intent.step_updated" }),
        at: str({ format: "date-time" }),
        data: obj(
          {
            intentId: ref("IntentId"),
            stepId: str(),
            network: ref("NetworkKey"),
            status: ref("StepStatus"),
            evidence: ref("StepEvidence"),
          },
          ["intentId", "stepId", "network", "status"],
        ),
      },
      ["id", "type", "at", "data"],
    ),
    KletiaEvent: {
      oneOf: [ref("IntentCreatedEvent"), ref("IntentStatusChangedEvent"), ref("IntentStepUpdatedEvent")],
      discriminator: {
        propertyName: "type",
        mapping: {
          "intent.created": "#/components/schemas/IntentCreatedEvent",
          "intent.status_changed": "#/components/schemas/IntentStatusChangedEvent",
          "intent.step_updated": "#/components/schemas/IntentStepUpdatedEvent",
        },
      },
    },

    Chain: obj(
      {
        key: ref("NetworkKey"),
        id: ref("CaipChainId"),
        namespace: str({ enum: ["eip155", "solana"] }),
        reference: str(),
        vm: str({ enum: ["evm", "svm"] }),
        name: str(),
        shortName: str(),
        environment: str({ enum: ["mainnet", "testnet"] }),
        lane: str({ enum: ["production", "beta", "testnet"] }),
        nativeAsset: obj({ symbol: str(), name: str(), decimals: int() }, ["symbol", "name", "decimals"]),
        explorer: obj({ name: str(), tx: str(), address: str() }, ["name", "tx", "address"]),
        color: str(),
        evmChainId: int(),
        walletChain: str(),
        settlement: obj({ cctpDomain: int(), relayChainId: int(), debridgeChainId: int(), acrossChainId: int() }),
        counterpart: ref("NetworkKey"),
      },
      ["key", "id", "namespace", "reference", "vm", "name", "shortName", "environment", "lane", "nativeAsset", "explorer", "color", "settlement"],
    ),
    NetworkCapabilities: {
      allOf: [
        ref("Chain"),
        obj(
          {
            actions: arrayOf(ref("IntentActionKind"), { description: "Action kinds executable with this network as the source." }),
            protocols: arrayOf(ref("ProtocolId"), { description: "Registry protocols present on this network." }),
            executableProtocols: arrayOf(ref("ProtocolId")),
            routes: arrayOf(
              obj({ kind: ref("IntentActionKind"), protocol: ref("ProtocolId"), toNetworks: arrayOf(ref("NetworkKey")) }, ["kind", "protocol", "toNetworks"]),
            ),
            assetCount: int({ minimum: 0 }),
          },
          ["actions", "protocols", "executableProtocols", "routes", "assetCount"],
        ),
      ],
    },
    Protocol: obj(
      {
        id: ref("ProtocolId"),
        name: str(),
        category: str({ enum: ["dex-aggregator", "dex", "bridge", "intent-network", "lending", "liquid-staking", "yield", "naming", "payments", "security", "data", "token-program"] }),
        networks: arrayOf(ref("NetworkKey")),
        capabilities: arrayOf(str({ enum: ["execute", "quote", "discover"] })),
        website: str({ format: "uri" }),
        summary: str(),
        crossChain: bool(),
        executable: bool({ description: "True when the engine has an execution adapter for this protocol." }),
      },
      ["id", "name", "category", "networks", "capabilities", "website", "summary", "executable"],
    ),
    Asset: obj(
      {
        id: ref("AssetId"),
        network: ref("NetworkKey"),
        symbol: str(),
        name: str(),
        decimals: int(),
        address: { type: ["string", "null"], description: "ERC-20 contract or SPL mint; null for the native asset." },
        category: str({ enum: ["native", "stablecoin", "wrapped", "liquid-staking", "governance", "meme", "btc"] }),
        tokenProgram: str({ enum: ["spl-token", "token-2022"] }),
        group: str({ enum: ["USDC", "USDT", "ETH", "BTC", "EURC", "SOL"] }),
      },
      ["id", "network", "symbol", "name", "decimals", "address", "category"],
    ),

    QuoteRequest: {
      oneOf: [
        obj(
          {
            network: ref("NetworkKey"),
            from: str({ maxLength: 128, description: "Input asset on `network`: symbol, address/mint or CAIP-19 id." }),
            to: str({ maxLength: 128, description: "Output asset on `toNetwork`." }),
            toNetwork: ref("NetworkKey"),
            amount: ref("DecimalAmount"),
            account: str({ maxLength: 128, description: "Sender address or CAIP-10 account (placeholder when omitted)." }),
            recipient: str({ maxLength: 128 }),
            slippageBps: int({ minimum: 1, maximum: 1000 }),
          },
          ["network", "from", "to", "amount"],
          { title: "Flat" },
        ),
        obj(
          {
            from: obj(
              {
                network: ref("NetworkKey"),
                asset: str({ maxLength: 128 }),
                amount: ref("DecimalAmount"),
                account: str({ maxLength: 128, description: "Sender address or CAIP-10 account (overrides top-level `account`)." }),
              },
              ["network", "asset", "amount"],
            ),
            to: obj(
              {
                network: { ...ref("NetworkKey"), description: "Defaults to `from.network`." },
                asset: str({ maxLength: 128 }),
                recipient: str({ maxLength: 128, description: "Recipient address or CAIP-10 account (overrides top-level `recipient`)." }),
              },
              ["asset"],
            ),
            account: str({ maxLength: 128 }),
            recipient: str({ maxLength: 128 }),
            slippageBps: int({ minimum: 1, maximum: 1000 }),
          },
          ["from", "to"],
          { title: "Nested (SDK)" },
        ),
      ],
    },
    QuoteRoute: obj(
      {
        protocol: ref("ProtocolId"),
        label: str(),
        network: ref("NetworkKey"),
        toNetwork: ref("NetworkKey"),
        input: ref("AssetAmount"),
        output: ref("AssetAmount"),
        minimumOutput: ref("AssetAmount"),
        feesUsd: num(),
        estimatedSeconds: int({ minimum: 0 }),
        transactionCount: int({ minimum: 0 }),
        settlement: ref("StepSettlement"),
        warnings: arrayOf(str()),
        quoteId: str(),
      },
      ["protocol", "label", "network", "toNetwork", "input", "output", "minimumOutput", "estimatedSeconds", "transactionCount", "settlement", "warnings"],
    ),
    QuoteResponse: obj(
      {
        routes: arrayOf(ref("QuoteRoute")),
        best: { oneOf: [ref("QuoteRoute"), { type: "null" }] },
        quotedAt: str({ format: "date-time" }),
        unavailable: arrayOf(obj({ protocol: ref("ProtocolId"), code: str(), message: str() }, ["protocol", "code", "message"])),
      },
      ["routes", "best", "quotedAt", "unavailable"],
    ),
    PortfolioHolding: obj(
      {
        asset: ref("AssetId"),
        symbol: str(),
        name: str(),
        decimals: int(),
        amount: ref("BaseUnits"),
        formatted: ref("DecimalAmount"),
        usd: { type: ["number", "null"] },
        verified: bool(),
        isNative: bool(),
      },
      ["asset", "symbol", "name", "decimals", "amount", "formatted", "usd", "verified", "isNative"],
    ),
    Portfolio: obj(
      {
        account: ref("AccountId"),
        network: ref("NetworkKey"),
        holdings: arrayOf(ref("PortfolioHolding")),
        totalUsd: num(),
        unpricedCount: int({ minimum: 0 }),
        observedAt: str({ format: "date-time" }),
      },
      ["account", "network", "holdings", "totalUsd", "unpricedCount", "observedAt"],
    ),
    Health: obj(
      {
        status: str({ enum: ["ok", "degraded", "down"] }),
        api: str({ const: "v1" }),
        version: str(),
        time: str({ format: "date-time" }),
        uptimeSeconds: int({ minimum: 0 }),
        networks: arrayOf(
          obj(
            {
              network: ref("NetworkKey"),
              chain: ref("CaipChainId"),
              name: str(),
              environment: str({ enum: ["mainnet", "testnet"] }),
              ok: bool(),
              latencyMs: int({ minimum: 0 }),
              height: str({ description: "Latest block (EVM) or slot (Solana)." }),
              detail: str(),
            },
            ["network", "chain", "name", "environment", "ok", "latencyMs"],
          ),
        ),
        storage: obj({ intents: str(), apiKeys: str(), webhooks: str() }, ["intents", "apiKeys", "webhooks"]),
        webhooks: obj(
          {
            status: str({ enum: ["enabled", "needs_configuration"] }),
            sealing: str({
              enum: ["configured", "development_fallback", "missing"],
              description: "`development_fallback` (a published key) is only used by development processes with in-memory stores.",
            }),
            dispatcher: {
              oneOf: [
                obj(
                  {
                    running: bool(),
                    queued: int(),
                    inFlight: int(),
                    scheduledRetries: int(),
                    delivered: int(),
                    failed: int(),
                    dropped: int(),
                    pausedWebhooks: int({ description: "Webhooks paused after consecutive delivery failures." }),
                  },
                  ["running", "queued", "inFlight", "scheduledRetries", "delivered", "failed", "dropped", "pausedWebhooks"],
                ),
                { type: "null" },
              ],
            },
          },
          ["status", "dispatcher"],
        ),
      },
      ["status", "api", "version", "time", "uptimeSeconds", "networks", "storage", "webhooks"],
    ),

    Webhook: obj(
      {
        id: str({ pattern: "^wh_[0-9a-f]{24}$" }),
        url: str({ format: "uri" }),
        events: arrayOf(str({ enum: [...WEBHOOK_EVENT_TYPES] })),
        createdAt: str({ format: "date-time" }),
        secret: str({ pattern: "^whsec_[0-9A-Za-z]{32}$", description: "Signing secret. Returned only by POST /v1/webhooks." }),
      },
      ["id", "url", "events", "createdAt"],
    ),
    WebhookCreateRequest: obj(
      {
        url: str({ format: "uri", pattern: "^https://", maxLength: 2048, description: "Public HTTPS endpoint (private, loopback and link-local targets are refused)." }),
        events: arrayOf(str({ enum: [...WEBHOOK_EVENT_TYPES] }), { minItems: 1, uniqueItems: true, description: "Defaults to every intent event." }),
      },
      ["url"],
    ),
    ApiKeyCreateRequest: obj({ name: str({ minLength: 1, maxLength: 64 }) }, ["name"]),
    ApiKey: obj(
      {
        id: str({ pattern: "^key_[0-9a-f]{24}$" }),
        name: str(),
        tier: str({ enum: ["developer", "operator"] }),
        createdAt: str({ format: "date-time" }),
        key: str({ pattern: "^kl_dev_[0-9A-Za-z]{32}$", description: "The raw key. Shown once; only its SHA-256 hash is stored." }),
      },
      ["id", "name", "tier", "createdAt", "key"],
    ),
    SubmitRequest: obj(
      {
        references: arrayOf(str({ maxLength: MAX_REFERENCE_LENGTH }), {
          minItems: 1,
          maxItems: MAX_REFERENCES,
          description: "One transaction hash (EVM) or signature (Solana) per prepared transaction, in order.",
        }),
      },
      ["references"],
    ),

    IntentResponse: obj({ intent: ref("IntentGraph") }, ["intent"]),
    IntentListResponse: obj({ intents: arrayOf(ref("IntentGraph")) }, ["intents"]),
    PreparedStepResponse: obj({ payload: ref("StepExecutionPayload"), intent: ref("IntentGraph") }, ["payload", "intent"]),
    NetworksResponse: obj({ networks: arrayOf(ref("NetworkCapabilities")) }, ["networks"]),
    ProtocolsResponse: obj({ protocols: arrayOf(ref("Protocol")) }, ["protocols"]),
    AssetsResponse: obj({ assets: arrayOf(ref("Asset")) }, ["assets"]),
    WebhookResponse: obj({ webhook: ref("Webhook") }, ["webhook"]),
    WebhookListResponse: obj({ webhooks: arrayOf(ref("Webhook")) }, ["webhooks"]),
    ApiKeyResponse: obj({ key: ref("ApiKey") }, ["key"]),
  };
}

const REQUEST_ID_HEADER: JsonObject = { $ref: "#/components/headers/X-Request-Id" };

function ok(schema: string, description: string, extraHeaders: JsonObject = {}): JsonObject {
  return {
    description,
    headers: {
      "X-Request-Id": REQUEST_ID_HEADER,
      RateLimit: { $ref: "#/components/headers/RateLimit" },
      "RateLimit-Policy": { $ref: "#/components/headers/RateLimit-Policy" },
      ...extraHeaders,
    },
    content: { "application/json": { schema: ref(schema) } },
  };
}

const ERROR_RESPONSES: Readonly<Record<string, string>> = {
  "400": "BadRequest",
  "401": "Unauthorized",
  "404": "NotFound",
  "405": "MethodNotAllowed",
  "409": "Conflict",
  "410": "Gone",
  "413": "PayloadTooLarge",
  "415": "UnsupportedMediaType",
  "422": "Unprocessable",
  "429": "TooManyRequests",
  "500": "InternalError",
  "502": "BadGateway",
  "503": "Unavailable",
  "504": "GatewayTimeout",
};

/**
 * Error responses of one operation. Every operation may be called with a key
 * (authentication is optional everywhere), so 401 for a key that fails and 503
 * when key verification is unavailable are always possible.
 */
function errors(...statuses: string[]): JsonObject {
  const out: JsonObject = {};
  for (const status of ["400", "401", "429", "500", "503", ...statuses]) {
    const name = ERROR_RESPONSES[status];
    if (name) out[status] = { $ref: `#/components/responses/${name}` };
  }
  return out;
}

function jsonBody(schema: string, required = true): JsonObject {
  return { required, content: { "application/json": { schema: ref(schema) } } };
}

const KEY_REQUIRED: Json = [{ bearerAuth: [] }, { apiKeyHeader: [] }];
const intentIdParam: JsonObject = { $ref: "#/components/parameters/IntentId" };
const stepIdParam: JsonObject = { $ref: "#/components/parameters/StepId" };

function paths(): JsonObject {
  return {
    "/v1/health": {
      get: {
        operationId: "getHealth",
        tags: ["System"],
        summary: "API and per-network RPC health",
        description: "Never fails: degraded networks are reported with ok=false. Results are cached for 10 seconds.",
        responses: { "200": ok("Health", "Health report."), ...errors() },
      },
    },
    "/v1/networks": {
      get: {
        operationId: "listNetworks",
        tags: ["Registry"],
        summary: "Chain registry plus per-network capabilities",
        description: "Capabilities are derived from the engine's execution adapters. Cacheable for 60 seconds.",
        responses: { "200": ok("NetworksResponse", "Networks."), ...errors() },
      },
    },
    "/v1/protocols": {
      get: {
        operationId: "listProtocols",
        tags: ["Registry"],
        summary: "Protocol registry",
        responses: { "200": ok("ProtocolsResponse", "Protocols."), ...errors() },
      },
    },
    "/v1/assets": {
      get: {
        operationId: "listAssets",
        tags: ["Registry"],
        summary: "Canonical asset registry",
        parameters: [
          { name: "network", in: "query", required: false, description: "Network key, CAIP-2 id or EVM chain id.", schema: str({ maxLength: 128 }) },
        ],
        responses: { "200": ok("AssetsResponse", "Assets."), ...errors() },
      },
    },
    "/v1/quotes": {
      post: {
        operationId: "quoteRoutes",
        tags: ["Quotes"],
        summary: "Best routes for one asset movement (same- or cross-network)",
        description: "Quotes are advisory and never persisted. `best` is the route with the highest guaranteed output.",
        requestBody: jsonBody("QuoteRequest"),
        responses: { "200": ok("QuoteResponse", "Routes."), ...errors("413", "415", "422", "502", "504") },
      },
    },
    "/v1/portfolio/{accountId}": {
      get: {
        operationId: "getPortfolio",
        tags: ["Portfolio"],
        summary: "Balances for one CAIP-10 account",
        parameters: [{ name: "accountId", in: "path", required: true, schema: ref("AccountId") }],
        responses: { "200": ok("Portfolio", "Portfolio."), ...errors("422", "502", "504") },
      },
    },
    "/v1/intents": {
      post: {
        operationId: "createIntent",
        tags: ["Intents"],
        summary: "Plan an intent into an IntentGraph",
        description:
          "Natural-language `text` is compiled by a deterministic grammar; unsupported wording returns 422 INTENT_UNSUPPORTED with example phrases in `error.hints`. With `dryRun=true` the plan is quoted but not stored (200). A repeated `clientReference` from the same API key returns the original intent (200).",
        parameters: [{ name: "dryRun", in: "query", required: false, schema: str({ enum: ["true", "false", "1", "0"] }) }],
        requestBody: jsonBody("IntentRequest"),
        responses: {
          "201": ok("IntentResponse", "Intent planned and stored."),
          "200": ok("IntentResponse", "Dry run, or idempotent replay of an existing intent."),
          ...errors("409", "413", "415", "422", "502", "504"),
        },
      },
      get: {
        operationId: "listIntents",
        tags: ["Intents"],
        summary: "List intents created with the caller's key",
        security: KEY_REQUIRED,
        parameters: [{ name: "limit", in: "query", required: false, schema: int({ minimum: 1, maximum: 100, default: 20 }) }],
        responses: { "200": ok("IntentListResponse", "Most recent first."), ...errors() },
      },
    },
    "/v1/intents/{id}": {
      get: {
        operationId: "getIntent",
        tags: ["Intents"],
        summary: "Read an intent",
        parameters: [intentIdParam],
        responses: { "200": ok("IntentResponse", "Intent."), ...errors("404") },
      },
    },
    "/v1/intents/{id}/steps/{stepId}/prepare": {
      post: {
        operationId: "prepareStep",
        tags: ["Intents"],
        summary: "Build wallet-ready transactions for a ready step",
        description:
          "Every transaction is sent (EVM) or fee-paid (Solana) by the step account. Sign and send them in order, then submit the references. A payload expires at `payload.expiresAt`; prepare again to re-quote.",
        parameters: [intentIdParam, stepIdParam],
        responses: { "200": ok("PreparedStepResponse", "Payload and updated intent."), ...errors("404", "409", "410", "422", "502", "504") },
      },
    },
    "/v1/intents/{id}/steps/{stepId}/submit": {
      post: {
        operationId: "submitStep",
        tags: ["Intents"],
        summary: "Submit transaction hashes / signatures for on-chain verification",
        description:
          `A reference advances the step only after Kletia observes it on-chain from the bound account. Same-network steps become \`settled\`; cross-network steps become \`settling\` until the settlement network reports the destination fill. References that are provably not this step's transactions are refused with 422 (${[...REJECTION_CODES].join(", ")}) and leave the step unchanged. References not yet visible on-chain are stored (\`submitted\`) and re-verified by refresh and the settlement poller; until one of them produces on-chain evidence, new references (e.g. after a wallet speed-up) replace them.`,
        parameters: [intentIdParam, stepIdParam],
        requestBody: jsonBody("SubmitRequest"),
        responses: { "200": ok("IntentResponse", "Updated intent."), ...errors("404", "409", "413", "415", "422", "502") },
      },
    },
    "/v1/intents/{id}/refresh": {
      post: {
        operationId: "refreshIntent",
        tags: ["Intents"],
        summary: "Re-read verification and settlement state now",
        parameters: [intentIdParam],
        responses: { "200": ok("IntentResponse", "Updated intent."), ...errors("404") },
      },
    },
    "/v1/intents/{id}/cancel": {
      post: {
        operationId: "cancelIntent",
        tags: ["Intents"],
        summary: "Cancel an intent with no submitted steps",
        parameters: [intentIdParam],
        responses: { "200": ok("IntentResponse", "Cancelled intent."), ...errors("404", "409") },
      },
    },
    "/v1/intents/{id}/events": {
      get: {
        operationId: "streamIntentEvents",
        tags: ["Events"],
        summary: "Server-Sent Events stream of intent events",
        description: `Starts with \`retry: ${SSE_RETRY_MS}\`, replays buffered events after \`Last-Event-ID\` (or \`?since=\`; the whole buffer when absent, or when the id is no longer buffered, so de-duplicate by event id), then streams live events. Each frame is \`id: <event id>\`, \`event: <type>\`, \`data: <KletiaEvent JSON>\`. A comment heartbeat is sent every ${SSE_HEARTBEAT_MS / 1000} s and the stream ends after ${SSE_MAX_DURATION_MS / 60_000} minutes.`,
        parameters: [
          intentIdParam,
          { name: "Last-Event-ID", in: "header", required: false, schema: ref("EventId") },
          { name: "since", in: "query", required: false, schema: ref("EventId") },
        ],
        responses: {
          "200": {
            description: "Event stream. Every `data` line is a KletiaEvent (see components.schemas.KletiaEvent).",
            headers: { "X-Request-Id": REQUEST_ID_HEADER },
            content: {
              "text/event-stream": {
                schema: str(),
                example: 'retry: 3000\n\nid: evt_0123456789abcdef0123456789abcdef\nevent: intent.created\ndata: {"id":"evt_0123456789abcdef0123456789abcdef","type":"intent.created","at":"2026-10-08T12:00:00.000Z","data":{"intentId":"int_0123456789abcdef0123456789abcdef","summary":{}}}\n\n',
              },
            },
          },
          ...errors("404"),
        },
      },
    },
    "/v1/webhooks": {
      post: {
        operationId: "createWebhook",
        tags: ["Webhooks"],
        summary: "Register a webhook (secret returned once)",
        description: `At most ${MAX_WEBHOOKS_PER_KEY} webhooks per key. Deliveries are signed with \`Kletia-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>\`; verify with verifyWebhookSignature from @kletia/core.`,
        security: KEY_REQUIRED,
        requestBody: jsonBody("WebhookCreateRequest"),
        responses: { "201": ok("WebhookResponse", "Webhook with its signing secret."), ...errors("409", "413", "415", "422") },
      },
      get: {
        operationId: "listWebhooks",
        tags: ["Webhooks"],
        summary: "List webhooks",
        security: KEY_REQUIRED,
        responses: { "200": ok("WebhookListResponse", "Webhooks (without secrets)."), ...errors() },
      },
    },
    "/v1/webhooks/{id}": {
      delete: {
        operationId: "deleteWebhook",
        tags: ["Webhooks"],
        summary: "Delete a webhook",
        security: KEY_REQUIRED,
        parameters: [{ name: "id", in: "path", required: true, schema: str({ pattern: WEBHOOK_ID_PATTERN.source }) }],
        responses: { "204": { description: "Deleted.", headers: { "X-Request-Id": REQUEST_ID_HEADER } }, ...errors("404") },
      },
    },
    "/v1/keys": {
      post: {
        operationId: "createApiKey",
        tags: ["Keys"],
        summary: "Issue a developer key",
        description: `The key is shown once and stored only as a SHA-256 hash. Limited to ${KEY_ISSUANCE_LIMIT_PER_HOUR} keys per hour per IP.`,
        requestBody: jsonBody("ApiKeyCreateRequest"),
        responses: { "201": ok("ApiKeyResponse", "The new key."), ...errors("413", "415") },
      },
    },
    "/v1/openapi.json": {
      get: {
        operationId: "getOpenApi",
        tags: ["System"],
        summary: "This OpenAPI document",
        responses: {
          "200": { description: "OpenAPI 3.1 document.", headers: { "X-Request-Id": REQUEST_ID_HEADER }, content: { "application/json": { schema: { type: "object" } } } },
          ...errors(),
        },
      },
    },
  };
}

function errorResponse(description: string): JsonObject {
  return {
    description,
    headers: { "X-Request-Id": REQUEST_ID_HEADER },
    content: { "application/json": { schema: ref("Error") } },
  };
}

export function buildOpenApiDocument(): JsonObject {
  return {
    openapi: "3.1.0",
    jsonSchemaDialect: "https://spec.openapis.org/oas/3.1/dialect/base",
    info: {
      title: "Kletia Platform API",
      version: PLATFORM_API_VERSION,
      summary: "Non-custodial, chain-agnostic intents for EVM networks and Solana.",
      description:
        "Plan cross-network intents into a DAG of network-bound steps, get unsigned wallet-ready transactions, and verify execution from on-chain evidence. Kletia never holds keys. Networks are CAIP-2 ids, accounts CAIP-10, assets CAIP-19, amounts base-unit strings.\n\n" +
        `Tiers: public ${TIER_LIMITS.public}/min per IP, developer ${TIER_LIMITS.developer}/min per key, operator ${TIER_LIMITS.operator}/min per key. Errors are \`{ "error": { "code", "message", "issues"?, "hints"? }, "requestId" }\`; every response carries X-Request-Id.`,
      license: { name: "MIT", identifier: "MIT" },
      contact: { name: "Kletia", url: "https://kletiaai.xyz" },
    },
    servers: [
      { url: "https://api.kletiaai.xyz", description: "Production" },
      { url: "http://localhost:3001", description: "Local development" },
    ],
    security: [{}, { bearerAuth: [] }, { apiKeyHeader: [] }],
    tags: [
      { name: "System" },
      { name: "Registry" },
      { name: "Quotes" },
      { name: "Portfolio" },
      { name: "Intents" },
      { name: "Events" },
      { name: "Webhooks" },
      { name: "Keys" },
    ],
    paths: paths(),
    webhooks: {
      intentEvent: {
        post: {
          summary: "Intent event delivery",
          description:
            "Sent for intents created with your API key to each matching webhook. Respond 2xx within 5 seconds; redirects are not followed. Failed deliveries are retried up to 3 times (after 1 s, 5 s and 25 s). Each key's deliveries are queued separately (at most 200 waiting; the oldest is dropped beyond that) and a webhook receives one delivery at a time. A webhook whose last 5 attempts failed is paused for 30 s, doubling up to 5 minutes while it keeps failing; its deliveries wait meanwhile.",
          parameters: [
            { name: "Kletia-Signature", in: "header", required: true, schema: str({ pattern: "^t=[0-9]+,v1=[0-9a-f]{64}$" }) },
            { name: "Kletia-Event-Id", in: "header", required: true, schema: ref("EventId") },
            { name: "Kletia-Event-Type", in: "header", required: true, schema: str({ enum: [...WEBHOOK_EVENT_TYPES] }) },
            { name: "Kletia-Webhook-Id", in: "header", required: true, schema: str() },
            { name: "Kletia-Delivery-Attempt", in: "header", required: true, schema: str({ pattern: "^[1-4]$" }) },
          ],
          requestBody: { required: true, content: { "application/json": { schema: ref("KletiaEvent") } } },
          responses: { "200": { description: "Any 2xx acknowledges the delivery." } },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "kl_dev_<32 base62>", description: "Developer or operator API key." },
        apiKeyHeader: { type: "apiKey", in: "header", name: "X-Kletia-Key", description: "Alternative to the Authorization header." },
      },
      parameters: {
        IntentId: { name: "id", in: "path", required: true, schema: ref("IntentId") },
        StepId: { name: "stepId", in: "path", required: true, schema: ref("StepId") },
      },
      headers: {
        "X-Request-Id": { description: "Request id (echoes a valid incoming UUID).", schema: str({ format: "uuid" }) },
        RateLimit: { description: "IETF draft-8 rate limit state.", schema: str() },
        "RateLimit-Policy": { description: "IETF draft-8 rate limit policy.", schema: str() },
        "Retry-After": { description: "Seconds until a retry may succeed.", schema: int() },
      },
      responses: {
        BadRequest: errorResponse("Invalid input (INVALID_REQUEST, INVALID_JSON, REFERENCES_INVALID, REFERENCE_INVALID, REFERENCE_COUNT_MISMATCH, ...)."),
        Unauthorized: errorResponse("Missing or invalid API key (API_KEY_REQUIRED, INVALID_API_KEY, INVALID_AUTHORIZATION)."),
        NotFound: errorResponse("Unknown resource or route (INTENT_NOT_FOUND, STEP_NOT_FOUND, WEBHOOK_NOT_FOUND, NOT_FOUND)."),
        MethodNotAllowed: errorResponse("Method not allowed on this path."),
        Conflict: errorResponse("State conflict (STEP_NOT_READY, STEP_NOT_AWAITING_SIGNATURE, QUOTE_MOVED, INTENT_CONFLICT, INTENT_NOT_CANCELLABLE, WEBHOOK_EXISTS, ...)."),
        Gone: errorResponse("Expired (INTENT_EXPIRED, DEADLINE_PASSED)."),
        PayloadTooLarge: errorResponse("Request body larger than 64 KB."),
        UnsupportedMediaType: errorResponse("Request body is not application/json."),
        Unprocessable: errorResponse(`Understood but not executable (INTENT_UNSUPPORTED, ROUTE_UNSUPPORTED, CAPITAL_LANE_MIXED, SELF_TRANSFER, FEE_LIMIT_EXCEEDED, INSUFFICIENT_BALANCE, WEBHOOK_URL_FORBIDDEN, ${[...REJECTION_CODES].join(", ")}, ...).`),
        TooManyRequests: {
          ...errorResponse("Rate limit exceeded (RATE_LIMITED, also for too many unrecognised API keys from one IP; TOO_MANY_STREAMS)."),
          headers: { "X-Request-Id": REQUEST_ID_HEADER, "Retry-After": { $ref: "#/components/headers/Retry-After" } },
        },
        InternalError: errorResponse("Unexpected error (INTERNAL_ERROR)."),
        BadGateway: errorResponse("An upstream provider or RPC failed (PROVIDER_UNAVAILABLE, RPC_UNAVAILABLE)."),
        Unavailable: errorResponse("Storage or a feature is unavailable (STORE_UNAVAILABLE, also when a presented API key cannot be verified; WEBHOOKS_NOT_CONFIGURED)."),
        GatewayTimeout: errorResponse("An upstream provider timed out (UPSTREAM_TIMEOUT, RPC_TIMEOUT)."),
      },
      schemas: schemas(),
    },
  };
}

let serialized: string | null = null;

/** The document as JSON (built once per process). */
export function openApiJson(): string {
  serialized ??= JSON.stringify(buildOpenApiDocument());
  return serialized;
}
