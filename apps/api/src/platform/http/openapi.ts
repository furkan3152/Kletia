/**
 * Hand-written OpenAPI 3.1 document for Platform API v1. Enumerations
 * (networks, CAIP-2 ids, protocols, action kinds) are generated from
 * @kletia/core so they never drift from the registries; shapes mirror the
 * handlers in router.ts and the types in @kletia/core.
 */
import { CHAINS, ERROR_CATEGORIES, INTENT_SPEC_VERSION, MAX_MAX_SECONDS, MIN_MAX_SECONDS, NETWORK_KEYS, PROTOCOLS } from "@kletia/core";
import { REJECTION_CODES } from "../index.js";
import { ACTION_KINDS } from "./catalog.js";
import { EVENT_ID_PATTERN, INTENT_ID_PATTERN, MAX_REFERENCE_LENGTH, MAX_REFERENCES, STEP_ID_PATTERN, WEBHOOK_ID_PATTERN } from "./context.js";
import { DELIVERY_ERRORS, MAX_DELIVERIES_PER_WEBHOOK, MEMORY_DELIVERIES_PER_WEBHOOK, TEST_DELIVERIES_PER_MINUTE } from "./deliveries.js";
import { PLATFORM_API_VERSION } from "./health.js";
import { IDEMPOTENCY_LOCK_MS, IDEMPOTENCY_TTL_MS } from "./idempotency.js";
import { API_KEY_ID_PATTERN, DEFAULT_ROTATION_GRACE_SECONDS, MAX_ACTIVE_KEYS_PER_PROJECT, MAX_ROTATION_GRACE_SECONDS } from "./keys.js";
import { KEY_ISSUANCE_LIMIT_PER_HOUR, TIER_LIMITS } from "./limits.js";
import { HANDOFF_MAX_TEXT } from "./mcp/handoff.js";
import { KLETIA_TOOLS } from "./mcp/tools.js";
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
            code: str({
              pattern: "^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$",
              description: "Stable UPPER_SNAKE_CASE code from the error catalog (GET /v1/errors). Provider failures name the provider (`RELAY_UNAVAILABLE`) and resolve to a catalog family entry.",
              examples: ["INTENT_UNSUPPORTED"],
            }),
            message: str(),
            issues: arrayOf(obj({ path: str(), message: str() }, ["path", "message"])),
            hints: arrayOf(str(), { description: "Optional guidance, e.g. example phrases on INTENT_UNSUPPORTED." }),
            docs: str({ format: "uri", description: "Documentation of the code: `https://kletiaai.xyz/developers#error-<CODE>`." }),
          },
          ["code", "message"],
        ),
        requestId: str({ format: "uuid" }),
      },
      ["error", "requestId"],
    ),
    ErrorCatalogEntry: obj(
      {
        code: str({ pattern: "^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$" }),
        status: { type: ["integer", "null"], description: "HTTP status when returned as an API error; null when the code only appears as `step.failure.code`." },
        otherStatuses: arrayOf(int(), { description: "Statuses the code is also returned with on another path." }),
        category: str({ enum: [...ERROR_CATEGORIES] }),
        retryable: bool({ description: "True when repeating the same request later can succeed without changing it." }),
        step: bool({ description: "Also reported as `step.failure.code`." }),
        title: str(),
        remedy: str(),
        docs: str({ format: "uri" }),
      },
      ["code", "status", "category", "retryable", "title", "remedy", "docs"],
    ),
    ErrorCatalogResponse: obj(
      {
        errors: arrayOf(ref("ErrorCatalogEntry")),
        families: arrayOf(obj({ pattern: str({ examples: ["<PROVIDER>_UNAVAILABLE"] }), code: str() }, ["pattern", "code"]), {
          description: "Dynamic provider codes and the catalog entry describing them.",
        }),
      },
      ["errors", "families"],
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
      maxSeconds: int({
        minimum: MIN_MAX_SECONDS,
        maximum: MAX_MAX_SECONDS,
        default: 600,
        description: "Longest settlement estimate a cross-network step may take; slower venue quotes lose the bridge auction.",
      }),
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
        recipientName: str({ description: "Name the recipient was resolved from (ENS, Basenames, SNS); resolved again before every prepare." }),
        venue: str({ description: "Registry venue id (e.g. base:aave-v3:usdc) a deposit or withdraw executes against." }),
        dependsOn: arrayOf(str()),
        settlement: ref("StepSettlement"),
        feesUsd: num(),
        extraCosts: arrayOf(ref("AssetAmount"), { description: "Value paid on top of the input, such as a bridge's fixed native fee." }),
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
    WebhookTestEvent: obj(
      {
        id: ref("EventId"),
        type: str({ const: "webhook.test" }),
        at: str({ format: "date-time" }),
        data: obj({ webhookId: str({ pattern: WEBHOOK_ID_PATTERN.source }) }, ["webhookId"]),
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
            maxSeconds: int({ minimum: MIN_MAX_SECONDS, maximum: MAX_MAX_SECONDS, default: 600, description: "Longest acceptable settlement estimate; slower routes are not eligible as best." }),
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
            maxSeconds: int({ minimum: MIN_MAX_SECONDS, maximum: MAX_MAX_SECONDS, default: 600, description: "Longest acceptable settlement estimate; slower routes are not eligible as best." }),
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
        netMinimumOutput: { ...ref("AssetAmount"), description: "Guaranteed output net of extra costs; absent when those costs cannot be priced." },
        feesUsd: num(),
        extraCosts: arrayOf(ref("AssetAmount"), { description: "Value paid on top of the input (e.g. a fixed native fee)." }),
        estimatedSeconds: int({ minimum: 0 }),
        transactionCount: int({ minimum: 0 }),
        settlement: ref("StepSettlement"),
        warnings: arrayOf(str()),
        quoteId: str(),
        eligible: bool({ description: "False when the route cannot be chosen as best (too slow, unpriced extra costs, another asset)." }),
      },
      ["protocol", "label", "network", "toNetwork", "input", "output", "minimumOutput", "estimatedSeconds", "transactionCount", "settlement", "warnings", "eligible"],
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
        id: str({ pattern: API_KEY_ID_PATTERN.source }),
        name: str(),
        tier: str({ enum: ["developer", "operator"] }),
        createdAt: str({ format: "date-time" }),
        key: str({ pattern: "^kl_dev_[0-9A-Za-z]{32}$", description: "The raw key. Shown once; only its SHA-256 hash is stored." }),
      },
      ["id", "name", "tier", "createdAt", "key"],
    ),
    RotatedApiKey: {
      allOf: [
        ref("ApiKey"),
        obj(
          {
            rotatedAt: str({ format: "date-time" }),
            previousExpiresAt: { type: ["string", "null"], format: "date-time", description: "When the previous secret stops authenticating; null when it already has (graceSeconds 0)." },
          },
          ["rotatedAt", "previousExpiresAt"],
        ),
      ],
    },
    ApiKeyRotateRequest: obj({
      graceSeconds: int({
        minimum: 0,
        maximum: MAX_ROTATION_GRACE_SECONDS,
        default: DEFAULT_ROTATION_GRACE_SECONDS,
        description: "How long the previous secret keeps authenticating (it can never manage keys). 0 revokes it immediately.",
      }),
    }),
    ApiKeyView: obj(
      {
        id: str({ pattern: API_KEY_ID_PATTERN.source }),
        name: str(),
        tier: str({ enum: ["developer"] }),
        last4: { type: ["string", "null"], description: "Last four characters of the current secret (null for keys issued before they were recorded)." },
        createdAt: str({ format: "date-time" }),
        lastUsedAt: { type: ["string", "null"], format: "date-time", description: "Updated at most once a minute." },
        rotatedAt: { type: ["string", "null"], format: "date-time" },
        previousExpiresAt: { type: ["string", "null"], format: "date-time", description: "End of the open grace window of the previous secret." },
        revokedAt: { type: ["string", "null"], format: "date-time" },
        current: bool({ description: "The key that made this request." }),
      },
      ["id", "name", "tier", "last4", "createdAt", "lastUsedAt", "rotatedAt", "previousExpiresAt", "revokedAt", "current"],
    ),
    WebhookDelivery: obj(
      {
        id: str({ pattern: "^whd_[0-9a-f]{24}$" }),
        webhookId: str({ pattern: WEBHOOK_ID_PATTERN.source }),
        eventId: ref("EventId"),
        eventType: str({ enum: [...WEBHOOK_EVENT_TYPES, "webhook.test"] }),
        intentId: ref("IntentId"),
        attempt: int({ minimum: 1, maximum: 4 }),
        status: str({ enum: ["succeeded", "failed", "dropped"] }),
        httpStatus: int({ description: "Status the endpoint answered with." }),
        durationMs: int({ minimum: 0 }),
        error: str({
          enum: [...DELIVERY_ERRORS],
          description: "Failure class (error text and payloads are never stored). `redirect`: a 3xx answer, which is never followed; `queue_full`: dropped before sending.",
        }),
        nextRetryAt: str({ format: "date-time", description: "When a failed attempt is retried." }),
        test: bool({ description: "A POST /v1/webhooks/{id}/test delivery." }),
        at: str({ format: "date-time" }),
      },
      ["id", "webhookId", "eventId", "eventType", "attempt", "status", "at"],
    ),
    UsageReport: obj(
      {
        keyId: str(),
        tier: str({ enum: ["developer", "operator"] }),
        window: str({ enum: ["24h", "7d"] }),
        since: str({ format: "date-time", description: "Start of the first hour in the window." }),
        generatedAt: str({ format: "date-time" }),
        rateLimit: obj(
          {
            limit: int(),
            remaining: int({ minimum: 0 }),
            resetAt: { type: ["string", "null"], format: "date-time" },
            windowSeconds: int(),
          },
          ["limit", "remaining", "resetAt", "windowSeconds"],
          { description: "The current 1-minute window as seen by the answering instance." },
        ),
        totals: obj(
          { requests: int({ minimum: 0 }), byStatusClass: { type: "object", additionalProperties: int({ minimum: 0 }), examples: [{ "2xx": 120, "4xx": 3 }] } },
          ["requests", "byStatusClass"],
        ),
        byRoute: arrayOf(
          obj(
            {
              route: str({ examples: ["POST /intents"] }),
              requests: int({ minimum: 0 }),
              byStatusClass: { type: "object", additionalProperties: int({ minimum: 0 }) },
            },
            ["route", "requests", "byStatusClass"],
          ),
        ),
        series: arrayOf(obj({ hour: str({ format: "date-time" }), requests: int({ minimum: 0 }) }, ["hour", "requests"]), {
          description: "One entry per hour of the window, oldest first.",
        }),
        intents: obj(
          { created: int({ minimum: 0 }), byStatus: { type: "object", additionalProperties: int({ minimum: 0 }) } },
          ["created", "byStatus"],
          { description: "Intents the key created in the window, by current status." },
        ),
      },
      ["keyId", "tier", "window", "since", "generatedAt", "rateLimit", "totals", "byRoute", "series", "intents"],
    ),
    ShieldsBadge: obj(
      {
        schemaVersion: int({ const: 1 }),
        label: str(),
        message: str({ enum: ["operational", "degraded", "down"] }),
        color: str(),
        cacheSeconds: int(),
      },
      ["schemaVersion", "label", "message", "color"],
    ),
    JsonRpcRequest: obj(
      {
        jsonrpc: str({ const: "2.0" }),
        id: { type: ["string", "integer"] },
        method: str({ examples: ["server/discover", "tools/list", "tools/call", "initialize"] }),
        params: { type: "object" },
      },
      ["jsonrpc", "method"],
      { description: "One MCP JSON-RPC message (batches are refused)." },
    ),
    JsonRpcResponse: obj(
      {
        jsonrpc: str({ const: "2.0" }),
        id: { type: ["string", "integer", "null"] },
        result: { type: "object" },
        error: obj({ code: int(), message: str(), data: {} }, ["code", "message"]),
      },
      ["jsonrpc"],
    ),
    JsonRpcErrorResponse: obj(
      {
        jsonrpc: str({ const: "2.0" }),
        id: { type: ["string", "integer", "null"] },
        error: obj({ code: int({ examples: [-32600] }), message: str(), data: {} }, ["code", "message"]),
      },
      ["jsonrpc", "error", "id"],
      { description: "A JSON-RPC error sent with a non-2xx status by the MCP server: the code is a JSON-RPC integer and there is no `requestId` (read the X-Request-Id header)." },
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
    LendingMetrics: obj(
      {
        venue: str({ description: "Registry venue id, e.g. base:aave-v3:usdc (use as params.venue)." }),
        protocol: ref("ProtocolId"),
        network: ref("NetworkKey"),
        name: str(),
        asset: str({ description: "Underlying asset symbol." }),
        supplyApy: { type: ["number", "null"], description: "Variable supply APY as a fraction (0.045 = 4.5%); advisory, null when unreadable." },
        apySource: str({ enum: ["rate", "share-price", "unavailable"], description: "`rate`: the current on-chain supply rate; `share-price`: realised share-price growth over apyWindowSeconds." }),
        apyWindowSeconds: int({ minimum: 0 }),
        totalSupplied: { oneOf: [ref("AssetAmount"), { type: "null" }], description: "Underlying supplied to the venue (TVL)." },
        exitLiquidity: { oneOf: [ref("AssetAmount"), { type: "null" }], description: "Underlying that can leave the venue now." },
        utilization: { type: ["number", "null"], minimum: 0, maximum: 1 },
        observedAt: str({ format: "date-time" }),
        warnings: arrayOf(str()),
      },
      ["venue", "protocol", "network", "name", "asset", "supplyApy", "apySource", "totalSupplied", "exitLiquidity", "utilization", "observedAt", "warnings"],
    ),
    VenuesResponse: obj(
      {
        venues: arrayOf(ref("LendingMetrics")),
        unavailable: arrayOf(obj({ venue: str(), code: str(), message: str() }, ["venue", "code", "message"]), {
          description: "Venues whose on-chain reads failed or no longer match the registry.",
        }),
      },
      ["venues", "unavailable"],
    ),
    WebhookResponse: obj({ webhook: ref("Webhook") }, ["webhook"]),
    WebhookListResponse: obj({ webhooks: arrayOf(ref("Webhook")) }, ["webhooks"]),
    WebhookDeliveryResponse: obj({ delivery: ref("WebhookDelivery") }, ["delivery"]),
    WebhookDeliveryListResponse: obj({ deliveries: arrayOf(ref("WebhookDelivery"), { description: "Newest first." }) }, ["deliveries"]),
    ApiKeyResponse: obj({ key: ref("ApiKey") }, ["key"]),
    RotatedApiKeyResponse: obj({ key: ref("RotatedApiKey") }, ["key"]),
    ApiKeyListResponse: obj({ keys: arrayOf(ref("ApiKeyView"), { description: "The project's keys, newest first (at most 50)." }) }, ["keys"]),
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
  "403": "Forbidden",
  "404": "NotFound",
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
const idempotencyKeyParam: JsonObject = { $ref: "#/components/parameters/IdempotencyKey" };
const webhookIdParam: JsonObject = { name: "id", in: "path", required: true, schema: str({ pattern: WEBHOOK_ID_PATTERN.source }) };
const keyIdParam: JsonObject = { name: "id", in: "path", required: true, schema: str({ pattern: API_KEY_ID_PATTERN.source }) };
const REPLAYED_HEADER: JsonObject = { "Idempotent-Replayed": { $ref: "#/components/headers/Idempotent-Replayed" } };
const IDEMPOTENCY_NOTE =
  " Honours `Idempotency-Key` (with an API key): a retry with the same key and request replays the stored response with `Idempotent-Replayed: true`.";

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
    "/v1/venues": {
      get: {
        operationId: "listVenues",
        tags: ["Registry"],
        summary: "EVM lending venues with rates, size and exit liquidity",
        description:
          "Every executable EVM lending venue in the registry (Aave V3, Compound V3, Morpho vaults, Moonwell), read on-chain and cached for 60 seconds. Values are advisory: plan and prepare re-read what they gate on. Solana venues (Jupiter Lend, Kamino) report their rate in plan notes.",
        parameters: [
          { name: "network", in: "query", required: false, description: "Network key, CAIP-2 id or EVM chain id.", schema: str({ maxLength: 128 }) },
          { name: "protocol", in: "query", required: false, description: "Lending protocol id, e.g. aave-v3, compound-v3, morpho, moonwell.", schema: str({ maxLength: 40 }) },
        ],
        responses: { "200": ok("VenuesResponse", "Venues."), ...errors() },
      },
    },
    "/v1/quotes": {
      post: {
        operationId: "quoteRoutes",
        tags: ["Quotes"],
        summary: "Best routes for one asset movement (same- or cross-network)",
        description: "Quotes are advisory and never persisted. Routes are ranked like the planner's bridge auction (guaranteed output net of priced extra costs, then time within `maxSeconds`, then transaction count); `best` is the first eligible route.",
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
          "Natural-language `text` is compiled by a deterministic grammar; unsupported wording returns 422 INTENT_UNSUPPORTED with example phrases in `error.hints`. With `dryRun=true` the plan is quoted but not stored (200; Idempotency-Key is ignored). A repeated `clientReference` from the same API key returns the original intent (200)." +
          IDEMPOTENCY_NOTE,
        parameters: [{ name: "dryRun", in: "query", required: false, schema: str({ enum: ["true", "false", "1", "0"] }) }, idempotencyKeyParam],
        requestBody: jsonBody("IntentRequest"),
        responses: {
          "201": ok("IntentResponse", "Intent planned and stored.", REPLAYED_HEADER),
          "200": ok("IntentResponse", "Dry run, or idempotent replay of an existing intent.", REPLAYED_HEADER),
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
          "Every transaction is sent (EVM) or fee-paid (Solana) by the step account. Sign and send them in order, then submit the references. A payload expires at `payload.expiresAt`; prepare again to re-quote. Never retried automatically: an `Idempotency-Key` header is refused with 400 IDEMPOTENCY_NOT_SUPPORTED.",
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
          `A reference advances the step only after Kletia observes it on-chain from the bound account. Same-network steps become \`settled\`; cross-network steps become \`settling\` until the settlement network reports the destination fill. References that are provably not this step's transactions are refused with 422 (${[...REJECTION_CODES].join(", ")}) and leave the step unchanged. References not yet visible on-chain are stored (\`submitted\`) and re-verified by refresh and the settlement poller; until one of them produces on-chain evidence, new references (e.g. after a wallet speed-up) replace them.${IDEMPOTENCY_NOTE}`,
        parameters: [intentIdParam, stepIdParam, idempotencyKeyParam],
        requestBody: jsonBody("SubmitRequest"),
        responses: { "200": ok("IntentResponse", "Updated intent.", REPLAYED_HEADER), ...errors("404", "409", "413", "415", "422", "502") },
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
        description: IDEMPOTENCY_NOTE.trim(),
        parameters: [intentIdParam, idempotencyKeyParam],
        responses: { "200": ok("IntentResponse", "Cancelled intent.", REPLAYED_HEADER), ...errors("404", "409", "422") },
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
        description: `At most ${MAX_WEBHOOKS_PER_KEY} webhooks per key. Deliveries are signed with \`Kletia-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>\`; verify with verifyWebhookSignature from @kletia/core.${IDEMPOTENCY_NOTE} The stored response (with the secret) is encrypted at rest.`,
        security: KEY_REQUIRED,
        parameters: [idempotencyKeyParam],
        requestBody: jsonBody("WebhookCreateRequest"),
        responses: { "201": ok("WebhookResponse", "Webhook with its signing secret.", REPLAYED_HEADER), ...errors("409", "413", "415", "422") },
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
        summary: "Delete a webhook (and its delivery log)",
        security: KEY_REQUIRED,
        parameters: [webhookIdParam],
        responses: { "204": { description: "Deleted.", headers: { "X-Request-Id": REQUEST_ID_HEADER } }, ...errors("404") },
      },
    },
    "/v1/webhooks/{id}/test": {
      post: {
        operationId: "testWebhook",
        tags: ["Webhooks"],
        summary: "Send a signed webhook.test event now",
        description: `Makes one synchronous delivery attempt of a \`webhook.test\` event (see the webhookTest webhook) with the same signing, network rules, 5 s timeout and no-redirect policy as real deliveries, records it in the delivery log and returns the outcome. Always 200 when the attempt was made, whatever the endpoint answered. Test deliveries never pause a webhook. At most ${TEST_DELIVERIES_PER_MINUTE} per minute per webhook.`,
        security: KEY_REQUIRED,
        parameters: [webhookIdParam],
        responses: { "200": ok("WebhookDeliveryResponse", "The delivery attempt."), ...errors("404") },
      },
    },
    "/v1/webhooks/{id}/deliveries": {
      get: {
        operationId: "listWebhookDeliveries",
        tags: ["Webhooks"],
        summary: "Delivery log of a webhook",
        description: `Every attempt, drop and test delivery, newest first. Payloads and error text are never stored. Kept for 7 days (at most ${MAX_DELIVERIES_PER_WEBHOOK} per webhook; ${MEMORY_DELIVERIES_PER_WEBHOOK} with in-memory storage).`,
        security: KEY_REQUIRED,
        parameters: [webhookIdParam, { name: "limit", in: "query", required: false, schema: int({ minimum: 1, maximum: 100, default: 20 }) }],
        responses: { "200": ok("WebhookDeliveryListResponse", "Deliveries, newest first."), ...errors("404") },
      },
    },
    "/v1/keys": {
      post: {
        operationId: "createApiKey",
        tags: ["Keys"],
        summary: "Issue a developer key",
        description: `The key is shown once and stored only as a SHA-256 hash. Without a key this starts a new project; with a developer key the new key joins the caller's project (at most ${MAX_ACTIVE_KEYS_PER_PROJECT} active keys, else 409 KEY_LIMIT_REACHED). Limited to ${KEY_ISSUANCE_LIMIT_PER_HOUR} keys per hour per IP.${IDEMPOTENCY_NOTE} The stored response is encrypted at rest.`,
        parameters: [idempotencyKeyParam],
        requestBody: jsonBody("ApiKeyCreateRequest"),
        responses: { "201": ok("ApiKeyResponse", "The new key.", REPLAYED_HEADER), ...errors("403", "409", "413", "415", "422") },
      },
      get: {
        operationId: "listApiKeys",
        tags: ["Keys"],
        summary: "List the keys of the caller's project",
        description: "Never returns secrets, only `last4`. Operator keys cannot be listed (409 KEY_NOT_MANAGEABLE); a secret inside its rotation grace window cannot manage keys (403 KEY_SECRET_ROTATED).",
        security: KEY_REQUIRED,
        responses: { "200": ok("ApiKeyListResponse", "The project's keys."), ...errors("403", "409") },
      },
    },
    "/v1/keys/{id}/rotate": {
      post: {
        operationId: "rotateApiKey",
        tags: ["Keys"],
        summary: "Replace a key's secret (same id)",
        description: `Issues a new secret for an active key of the caller's project. The key id is unchanged, so intents, webhooks and usage stay attached. The previous secret keeps authenticating for \`graceSeconds\` (default ${DEFAULT_ROTATION_GRACE_SECONDS / 3600} h, at most ${MAX_ROTATION_GRACE_SECONDS / 86_400} days, 0 = stop now) but cannot manage keys; rotating again ends an earlier grace window. Other instances notice within 15 s.${IDEMPOTENCY_NOTE} The stored response is encrypted at rest and replayed only to the current secret or to the secret that made the request (a key that rotated itself can retry with its old secret during the grace window); any other rotated-out secret gets 403 KEY_SECRET_ROTATED.`,
        security: KEY_REQUIRED,
        parameters: [keyIdParam, idempotencyKeyParam],
        requestBody: { ...jsonBody("ApiKeyRotateRequest", false) },
        responses: { "200": ok("RotatedApiKeyResponse", "The key with its new secret.", REPLAYED_HEADER), ...errors("403", "404", "409", "413", "415", "422") },
      },
    },
    "/v1/keys/{id}": {
      delete: {
        operationId: "revokeApiKey",
        tags: ["Keys"],
        summary: "Revoke a key of the caller's project",
        description: "Idempotent. The key stops authenticating at once on the answering instance and within 15 s everywhere. A key may revoke itself. Its webhooks and their delivery logs are deleted and its intents' events are no longer delivered; repeating the call finishes a cleanup that failed (503).",
        security: KEY_REQUIRED,
        parameters: [keyIdParam],
        responses: { "204": { description: "Revoked.", headers: { "X-Request-Id": REQUEST_ID_HEADER } }, ...errors("403", "404", "409") },
      },
    },
    "/v1/usage": {
      get: {
        operationId: "getUsage",
        tags: ["Usage"],
        summary: "Requests, status classes and intents of the caller's key",
        description: "Counts every request made with the key, by hour, route and status class (flushed every 30 s), plus the live rate-limit window of the answering instance and the intents the key created in the window.",
        security: KEY_REQUIRED,
        parameters: [{ name: "window", in: "query", required: false, schema: str({ enum: ["24h", "7d"], default: "24h" }) }],
        responses: { "200": ok("UsageReport", "Usage report."), ...errors() },
      },
    },
    "/v1/errors": {
      get: {
        operationId: "listErrors",
        tags: ["System"],
        summary: "Error catalog",
        description: "Every error code the API returns, and every step failure code, with its status, category, retryability and remedy. Cacheable for 5 minutes.",
        responses: { "200": ok("ErrorCatalogResponse", "The catalog, sorted by code."), ...errors() },
      },
    },
    "/v1/status/badge": {
      get: {
        operationId: "getStatusBadge",
        tags: ["System"],
        summary: "API status badge",
        description: "operational / degraded / down from the health report. SVG by default; `format=shields` returns a shields.io endpoint document for `https://img.shields.io/endpoint?url=<encoded URL>`. Cacheable for 60 seconds.",
        parameters: [{ name: "format", in: "query", required: false, schema: str({ enum: ["svg", "shields"], default: "svg" }) }],
        responses: {
          "200": {
            description: "Badge.",
            headers: { "X-Request-Id": REQUEST_ID_HEADER },
            content: { "image/svg+xml": { schema: str() }, "application/json": { schema: ref("ShieldsBadge") } },
          },
          ...errors(),
        },
      },
    },
    "/v1/mcp": {
      post: {
        operationId: "mcp",
        tags: ["MCP"],
        summary: "Model Context Protocol server (Streamable HTTP)",
        description: `MCP revision 2026-07-28, plus stateless serving of 2025-era clients that open with \`initialize\`. Send one JSON-RPC message per request with \`Accept: application/json, text/event-stream\`; batches are refused and GET answers 405 (no server-initiated stream). Tools, all read-only: ${KLETIA_TOOLS.map((tool) => `\`${tool.name}\``).join(", ")}. No tool prepares, signs or submits a transaction; \`create_signing_link\` returns a Studio link (text up to ${HANDOFF_MAX_TEXT} characters) for the user to sign with their own wallet. An API key maps to the MCP auth info (\`clientId\` = key id). Requests with an \`Origin\` header must come from an HTTPS origin (or localhost in development), else 403 MCP_ORIGIN_FORBIDDEN. Add it to Claude Code with \`claude mcp add --transport http kletia https://api.kletiaai.xyz/v1/mcp\`.`,
        requestBody: jsonBody("JsonRpcRequest"),
        responses: {
          "200": {
            description: "JSON-RPC response (application/json), or an event stream for 2025-era requests.",
            headers: { "X-Request-Id": REQUEST_ID_HEADER },
            content: { "application/json": { schema: ref("JsonRpcResponse") }, "text/event-stream": { schema: str() } },
          },
          "202": { description: "Notification accepted.", headers: { "X-Request-Id": REQUEST_ID_HEADER } },
          // The router's guards (401, 403, 413, 415, 429, 503) answer with the platform error envelope; the MCP server with JSON-RPC errors.
          ...errors("403", "413", "415"),
          "400": mcpErrorResponse(
            "A JSON-RPC error for a batch, a body that is not one JSON-RPC message, an unsupported protocol revision or MCP headers that disagree with the body; the platform error envelope (INVALID_JSON) for a body that is not JSON.",
            true,
          ),
          "404": mcpErrorResponse("A JSON-RPC error (-32601) for an unknown method on the 2026-07-28 revision."),
          "406": mcpErrorResponse("A JSON-RPC error when Accept does not list both application/json and text/event-stream."),
          "500": mcpErrorResponse("A JSON-RPC error (-32603) when the MCP server fails; the platform error envelope (INTERNAL_ERROR) for a failure before it.", true),
        },
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

/** An error of POST /v1/mcp: a JSON-RPC error body, or (`orPlatform`) also the platform envelope from the router. */
function mcpErrorResponse(description: string, orPlatform = false): JsonObject {
  return {
    description,
    headers: { "X-Request-Id": REQUEST_ID_HEADER },
    content: { "application/json": { schema: orPlatform ? { oneOf: [ref("JsonRpcErrorResponse"), ref("Error")] } : ref("JsonRpcErrorResponse") } },
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
        `Tiers: public ${TIER_LIMITS.public}/min per IP, developer ${TIER_LIMITS.developer}/min per key, operator ${TIER_LIMITS.operator}/min per key. Errors are \`{ "error": { "code", "message", "issues"?, "hints"?, "docs"? }, "requestId" }\` with codes from the catalog at GET /v1/errors; every response carries X-Request-Id. Keyed POSTs that create or change state accept \`Idempotency-Key\`. Agents can use the read-only MCP server at /v1/mcp.`,
      license: { name: "MIT", identifier: "MIT" },
      contact: { name: "Kletia", url: "https://kletiaai.xyz" },
    },
    servers: [
      { url: "https://api.kletiaai.xyz", description: "Production" },
      { url: "http://localhost:3001", description: "Local development" },
    ],
    security: [{}, { bearerAuth: [] }, { apiKeyHeader: [] }],
    tags: [
      { name: "System", description: "Health, the error catalog, the status badge and this document." },
      { name: "Registry", description: "Networks, protocols and assets, derived from the engine's live adapters." },
      { name: "Quotes", description: "Advisory route quotes; nothing is stored." },
      { name: "Portfolio", description: "Balances of one CAIP-10 account." },
      { name: "Intents", description: "Plan, prepare, submit, verify and cancel intents." },
      { name: "Events", description: "Server-Sent Events per intent." },
      { name: "Webhooks", description: "Signed event deliveries to your HTTPS endpoints, test deliveries and delivery logs." },
      { name: "Keys", description: "Issue, list, rotate and revoke the API keys of your project." },
      { name: "Usage", description: "Per-key request counts and rate-limit state." },
      { name: "MCP", description: "Read-only Model Context Protocol server for agents." },
    ],
    paths: paths(),
    webhooks: {
      intentEvent: {
        post: {
          operationId: "receiveIntentEvent",
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
      webhookTest: {
        post: {
          operationId: "receiveWebhookTest",
          summary: "Test delivery",
          description: "Sent once by POST /v1/webhooks/{id}/test, signed like every delivery. Never retried. Acknowledge with any 2xx.",
          parameters: [
            { name: "Kletia-Signature", in: "header", required: true, schema: str({ pattern: "^t=[0-9]+,v1=[0-9a-f]{64}$" }) },
            { name: "Kletia-Event-Id", in: "header", required: true, schema: ref("EventId") },
            { name: "Kletia-Event-Type", in: "header", required: true, schema: str({ const: "webhook.test" }) },
            { name: "Kletia-Webhook-Id", in: "header", required: true, schema: str() },
            { name: "Kletia-Delivery-Attempt", in: "header", required: true, schema: str({ const: "1" }) },
          ],
          requestBody: { required: true, content: { "application/json": { schema: ref("WebhookTestEvent") } } },
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
        IdempotencyKey: {
          name: "Idempotency-Key",
          in: "header",
          required: false,
          description: `Makes a retry safe: the first response with this key (per API key) is stored for ${IDEMPOTENCY_TTL_MS / 3_600_000} hours and replayed for the same request. The same key with a different request → 422 IDEMPOTENCY_KEY_REUSED; while the first request runs → 409 IDEMPOTENCY_REQUEST_IN_PROGRESS (Retry-After: 1; an abandoned reservation is taken over after ${IDEMPOTENCY_LOCK_MS / 1000} s). 5xx, 429 and retryable errors are never stored. Requires an API key (400 IDEMPOTENCY_KEY_REQUIRES_API_KEY).`,
          schema: str({ pattern: "^\"?[A-Za-z0-9_.:-]{1,128}\"?$", examples: ["7f6c1d0e-3b8a-4c2e-9a51-0d2f5b8e6a14"] }),
        },
      },
      headers: {
        "X-Request-Id": { description: "Request id (echoes a valid incoming UUID).", schema: str({ format: "uuid" }) },
        RateLimit: { description: "IETF draft-8 rate limit state.", schema: str() },
        "RateLimit-Policy": { description: "IETF draft-8 rate limit policy.", schema: str() },
        "Retry-After": { description: "Seconds until a retry may succeed.", schema: int() },
        "Idempotent-Replayed": { description: "`true` when the response replays an earlier request (Idempotency-Key or clientReference).", schema: str({ const: "true" }) },
      },
      responses: {
        BadRequest: errorResponse("Invalid input (INVALID_REQUEST, INVALID_JSON, REFERENCES_INVALID, REFERENCE_INVALID, REFERENCE_COUNT_MISMATCH, IDEMPOTENCY_KEY_INVALID, IDEMPOTENCY_KEY_REQUIRES_API_KEY, IDEMPOTENCY_NOT_SUPPORTED, ...)."),
        Unauthorized: errorResponse("Missing or invalid API key (API_KEY_REQUIRED, INVALID_API_KEY, INVALID_AUTHORIZATION)."),
        Forbidden: errorResponse("Not allowed (KEY_SECRET_ROTATED, MCP_ORIGIN_FORBIDDEN)."),
        NotFound: errorResponse("Unknown resource or route (INTENT_NOT_FOUND, STEP_NOT_FOUND, WEBHOOK_NOT_FOUND, KEY_NOT_FOUND, NOT_FOUND)."),
        Conflict: errorResponse("State conflict (STEP_NOT_READY, STEP_NOT_AWAITING_SIGNATURE, QUOTE_MOVED, INTENT_CONFLICT, INTENT_NOT_CANCELLABLE, WEBHOOK_EXISTS, KEY_NOT_MANAGEABLE, KEY_LIMIT_REACHED, IDEMPOTENCY_REQUEST_IN_PROGRESS, ...)."),
        Gone: errorResponse("Expired (INTENT_EXPIRED, DEADLINE_PASSED)."),
        PayloadTooLarge: errorResponse("Request body larger than 64 KB."),
        UnsupportedMediaType: errorResponse("Request body is not application/json."),
        Unprocessable: errorResponse(`Understood but not executable (INTENT_UNSUPPORTED, ROUTE_UNSUPPORTED, CAPITAL_LANE_MIXED, SELF_TRANSFER, FEE_LIMIT_EXCEEDED, INSUFFICIENT_BALANCE, WEBHOOK_URL_FORBIDDEN, IDEMPOTENCY_KEY_REUSED, ${[...REJECTION_CODES].join(", ")}, ...).`),
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
