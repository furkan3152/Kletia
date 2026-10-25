/**
 * Catalog (chains, protocols, assets, quotes, portfolios) and platform
 * (health, webhooks, keys, usage, badges, MCP) schemas.
 */
import {
  JOURNEY_VALUE_SOURCES,
  MAX_MAX_SECONDS,
  MIN_MAX_SECONDS,
  PROTOCOLS,
} from "@kletia/core";
import { PROTOCOL_SURFACES } from "../catalog.js";
import {
  MAX_REFERENCE_LENGTH,
  MAX_REFERENCES,
  WEBHOOK_ID_PATTERN,
} from "../context.js";
import { DELIVERY_ERRORS } from "../deliveries.js";
import {
  API_KEY_ID_PATTERN,
  DEFAULT_ROTATION_GRACE_SECONDS,
  MAX_ROTATION_GRACE_SECONDS,
} from "../keys.js";
import { WEBHOOK_EVENT_TYPES } from "../webhooks.js";
import {
  arrayOf,
  bool,
  int,
  type JsonObject,
  num,
  obj,
  ref,
  str,
} from "./helpers.js";

/** Chains, networks, protocols, assets, quotes and portfolios. */
export function catalogSchemas(): JsonObject {
  return {
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
            customContracts: obj(
              {
                kind: str({ enum: ["call", "action"] }),
                protocol: ref("ProtocolId"),
                enabled: bool({ description: "False while the deployment disables custom contracts or no adapter executes them." }),
              },
              ["kind", "protocol", "enabled"],
              { description: "How this network takes integrator contracts: EVM `call` steps, Solana `action` steps (registrations: POST /v1/contracts)." },
            ),
          },
          ["actions", "protocols", "executableProtocols", "routes", "assetCount", "customContracts"],
        ),
      ],
    },
    Protocol: obj(
      {
        id: ref("ProtocolId"),
        name: str(),
        category: str({ enum: [...new Set(["dex-aggregator", "dex", "bridge", "intent-network", "lending", "liquid-staking", "yield", "naming", "payments", "security", "data", "token-program", "custom", ...PROTOCOLS.map((protocol) => protocol.category)])] }),
        networks: arrayOf(ref("NetworkKey")),
        capabilities: arrayOf(str({ enum: ["execute", "quote", "discover"] })),
        website: str({ format: "uri" }),
        summary: str(),
        crossChain: bool(),
        executable: bool({ description: "True when the engine has an execution adapter for this protocol." }),
        execution: str({ enum: ["console", "service"], description: "Registry field: executed only by the Kletia console's tools (`console`) or a separate Kletia service (`service`); absent for the platform." }),
        surface: str({
          enum: [...PROTOCOL_SURFACES],
          description: "Where it executes: `platform` (Platform API v1 plans and executes it), `console` (only the Kletia console's network engines and tools), `service` (a separate Kletia service, such as x402 payments).",
        }),
        routedVia: arrayOf(ref("ProtocolId"), {
          description: "Protocols every transaction of this one also uses (Raydium, Orca and Meteora run through the Jupiter program): `constraints.avoidProtocols` and Rule Book protocol rules apply to them too.",
        }),
      },
      ["id", "name", "category", "networks", "capabilities", "website", "summary", "executable", "surface", "routedVia"],
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
        usd: { type: ["number", "null"], description: "Advisory USD value; null when unpriced (never 0 for unknown)." },
        verified: bool(),
        isNative: bool(),
        priceSource: str({
          enum: [...JOURNEY_VALUE_SOURCES],
          description: "Where `usd` comes from: `usd-par` (USD stablecoins), `jupiter`, `chainlink`, `pyth`; `unpriced` when no price is known, `testnet` for testnet assets (usd null).",
        }),
        pricedAt: { type: ["string", "null"], format: "date-time", description: "Time of the price reading; null when unpriced." },
      },
      ["asset", "symbol", "name", "decimals", "amount", "formatted", "usd", "verified", "isNative", "priceSource", "pricedAt"],
    ),
    Portfolio: obj(
      {
        account: ref("AccountId"),
        network: ref("NetworkKey"),
        holdings: arrayOf(ref("PortfolioHolding")),
        totalUsd: num({ description: "Sum of the priced holdings (positions not included)." }),
        unpricedCount: int({ minimum: 0 }),
        observedAt: str({ format: "date-time" }),
        positions: arrayOf(ref("VenuePosition"), { description: "With `positions=true`: lending, savings and vault positions of the account on its network." }),
        positionsUnavailable: arrayOf(obj({ venue: str(), code: str(), message: str() }, ["venue", "code", "message"]), {
          description: "With `positions=true`: venues whose position could not be read (unknown, never an empty position).",
        }),
      },
      ["account", "network", "holdings", "totalUsd", "unpricedCount", "observedAt"],
    ),
    PortfolioList: obj(
      {
        portfolios: arrayOf(ref("Portfolio"), { description: "Successful reads in request order (duplicates removed)." }),
        failures: arrayOf(obj({ account: ref("AccountId"), code: str(), message: str() }, ["account", "code", "message"]), {
          description: "Accounts that could not be read; the request still answers 200.",
        }),
        observedAt: str({ format: "date-time" }),
      },
      ["portfolios", "failures", "observedAt"],
    ),
  };
}

/** Health, webhooks, API keys, usage, badges, MCP JSON-RPC and submissions. */
export function platformSchemas(): JsonObject {
  return {
    Health: obj(
      {
        status: str({ enum: ["ok", "degraded", "down"] }),
        api: str({ const: "v1" }),
        version: str(),
        build: obj(
          {
            commit: { type: ["string", "null"], pattern: "^[0-9a-f]{7,64}$", description: "Git commit this deployment runs (RENDER_GIT_COMMIT on Render, otherwise KLETIA_BUILD_COMMIT); null when unknown." },
            source: { type: ["string", "null"], enum: ["render", "env", null], description: "Where the commit came from." },
          },
          ["commit", "source"],
        ),
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
        storage: obj({ intents: str(), apiKeys: str(), webhooks: str(), contracts: str(), sessions: str() }, ["intents", "apiKeys", "webhooks", "contracts", "sessions"]),
        policies: obj(
          {
            enabled: bool({ description: "False when the deployment switched enforcement off: rule books are stored but not enforced." }),
            stores: obj({ ruleBooks: str(), spend: str(), decisions: str(), approvals: str() }, ["ruleBooks", "spend", "decisions", "approvals"]),
          },
          ["enabled", "stores"],
        ),
        links: obj({ enabled: bool(), blinks: bool(), store: str() }, ["enabled", "blinks", "store"]),
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
                    storage: str({
                      enum: ["memory", "postgres"],
                      description:
                        "Where deliveries wait. With `postgres` (the durable queue), `queued` and `scheduledRetries` are the last snapshot of the shared queue and the other counters describe the answering process.",
                    }),
                    queued: int(),
                    inFlight: int(),
                    scheduledRetries: int(),
                    delivered: int(),
                    failed: int(),
                    dropped: int(),
                    pausedWebhooks: int({ description: "Webhooks paused after consecutive delivery failures." }),
                  },
                  ["running", "storage", "queued", "inFlight", "scheduledRetries", "delivered", "failed", "dropped", "pausedWebhooks"],
                ),
                { type: "null" },
              ],
            },
          },
          ["status", "dispatcher"],
        ),
        contracts: obj(
          {
            enabled: bool({ description: "False when the deployment's kill switch disables custom contracts." }),
            simulation: {
              type: ["object", "null"],
              additionalProperties: str({ enum: ["ok", "unavailable"] }),
              description: "Per network: whether a configured endpoint can simulate now (custom contract steps are never prepared unsimulated). Null when not probed.",
            },
          },
          ["enabled", "simulation"],
        ),
        receipts: obj(
          {
            signer: str({ enum: ["configured", "development", "missing", "disabled"], description: "`missing`: receipts queue until a signing key is configured; `disabled`: the kill switch is on." }),
            store: str({ enum: ["memory", "postgres", "unavailable"] }),
            queue: { type: ["integer", "null"], minimum: 0, description: "Intents waiting for a receipt (finality, retries, a missing key)." },
            oldestPendingSeconds: { type: ["integer", "null"], minimum: 0 },
            lastBatch: { oneOf: [obj({ seq: int({ minimum: 1 }), anchored: bool() }, ["seq", "anchored"]), { type: "null" }] },
          },
          ["signer", "store", "queue", "oldestPendingSeconds", "lastBatch"],
        ),
        preview: obj({ store: str({ enum: ["memory", "postgres", "custom"] }) }, ["store"]),
      },
      ["status", "api", "version", "build", "time", "uptimeSeconds", "networks", "storage", "policies", "links", "webhooks", "contracts", "receipts", "preview"],
    ),

    Webhook: obj(
      {
        id: str({ pattern: "^wh_[0-9a-f]{24}$" }),
        url: str({ format: "uri" }),
        events: arrayOf(str({ enum: [...WEBHOOK_EVENT_TYPES] })),
        createdAt: str({ format: "date-time" }),
        scope: str({ enum: ["self", "subtree"], description: "`subtree`: also events of the owner's descendant agent keys (and, on project keys, project-wide Rule Book events)." }),
        secret: str({ pattern: "^whsec_[0-9A-Za-z]{32}$", description: "Signing secret. Returned only by POST /v1/webhooks." }),
      },
      ["id", "url", "events", "createdAt", "scope"],
    ),
    WebhookCreateRequest: obj(
      {
        url: str({ format: "uri", pattern: "^https://", maxLength: 2048, description: "Public HTTPS endpoint (private, loopback and link-local targets are refused)." }),
        events: arrayOf(str({ enum: [...WEBHOOK_EVENT_TYPES] }), {
          minItems: 1,
          uniqueItems: true,
          description: "Defaults to every event type that exists when the webhook is created (intent events of the key's intents, contract events of its registrations, link events of its links, Rule Book and key events of the key).",
        }),
        scope: str({ enum: ["self", "subtree"], default: "self", description: "`subtree`: also deliver the events of every descendant agent key (and, on a project key, the project's Rule Book events)." }),
      },
      ["url"],
    ),
    ApiKeyCreateRequest: obj(
      {
        name: str({ minLength: 1, maxLength: 64 }),
        sandbox: bool({ default: false, description: "Issue a sandbox key: a key-level rule book `{ networks: { lanes: [\"testnet\"] } }` is written with it, so it plans on Arbitrum Sepolia, Arc Testnet and Solana Devnet only (403 POLICY_VIOLATION networks.lanes elsewhere)." }),
      },
      ["name"],
    ),
    ApiKey: obj(
      {
        id: str({ pattern: API_KEY_ID_PATTERN.source }),
        name: str(),
        tier: str({ enum: ["developer", "operator"] }),
        createdAt: str({ format: "date-time" }),
        key: str({ pattern: "^kl_dev_[0-9A-Za-z]{32}$", description: "The raw key. Shown once; only its SHA-256 hash is stored." }),
        lane: { ...ref("KeyLane"), description: "Issuance response: the lanes the key's rule books allow (`testnet` for a sandbox key)." },
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
        kind: str({ enum: ["project", "agent", "publishable"], description: "`agent`: a kl_agt_ key issued under another key (POST /v1/keys/{id}/children); `publishable`: a kl_pub_ browser key under a project key (POST /v1/projects/current/publishable-keys)." }),
        parentId: { type: ["string", "null"], description: "Parent of an agent or publishable key." },
        depth: int({ minimum: 0, description: "Levels below the project key (0 for project keys)." }),
        expiresAt: { type: ["string", "null"], format: "date-time", description: "When the key stops authenticating (always set on agent keys)." },
        policyVersion: { type: ["integer", "null"], description: "Active rule book version (null: none; an agent key without one is an observer)." },
        descendants: int({ minimum: 0, description: "Active agent keys below this key." }),
        lane: ref("KeyLane"),
        last4: { type: ["string", "null"], description: "Last four characters of the current secret (null for keys issued before they were recorded)." },
        createdAt: str({ format: "date-time" }),
        lastUsedAt: { type: ["string", "null"], format: "date-time", description: "Updated at most once a minute." },
        rotatedAt: { type: ["string", "null"], format: "date-time" },
        previousExpiresAt: { type: ["string", "null"], format: "date-time", description: "End of the open grace window of the previous secret." },
        revokedAt: { type: ["string", "null"], format: "date-time" },
        current: bool({ description: "The key that made this request." }),
      },
      ["id", "name", "tier", "kind", "parentId", "depth", "last4", "createdAt", "lastUsedAt", "rotatedAt", "previousExpiresAt", "revokedAt", "expiresAt", "policyVersion", "descendants", "lane", "current"],
    ),
    KeyLane: str({
      enum: ["testnet", "production", "any"],
      description: "Lanes the key's active rule book chain (project, ancestors, the key) allows through `networks.lanes` and `networks.allow`: `testnet` (a sandbox key), `production`, or `any`.",
    }),
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
          description:
            "Failure class (error text and payloads are never stored). `redirect`: a 3xx answer, which is never followed. Dropped before sending: `queue_full` (a queue bound was hit), `payload_unreadable` (a queued body no longer opens, for example after the platform secret changed) and `deferred_too_long` (the delivery could not be attempted for about two hours because key, webhook or intent storage kept failing).",
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
        contracts: obj(
          {
            registered: int({ minimum: 0 }),
            suspended: int({ minimum: 0 }),
            preparedToday: int({ minimum: 0, description: "Priced custom contract steps prepared today (UTC)." }),
            notionalTodayUsd: num({ minimum: 0, description: "Their notional, counted against the key's daily cap." }),
          },
          ["registered", "suspended", "preparedToday", "notionalTodayUsd"],
          { description: "The key's contract registrations and today's custom contract activity." },
        ),
        receipts: obj(
          { issued: int({ minimum: 0 }), pending: int({ minimum: 0 }), sharesActive: int({ minimum: 0 }) },
          ["issued", "pending", "sharesActive"],
          { description: "Receipts of the key's intents issued in the window, intents waiting for one, and active shares." },
        ),
        subtree: obj(
          {
            keys: arrayOf(
              obj(
                {
                  keyId: str(),
                  name: str(),
                  kind: str({ enum: ["project", "agent", "publishable"] }),
                  parentId: { type: ["string", "null"] },
                  revokedAt: { type: ["string", "null"], format: "date-time" },
                  requests: int({ minimum: 0 }),
                  intents: obj({ created: int({ minimum: 0 }), byStatus: { type: "object", additionalProperties: int({ minimum: 0 }) } }, ["created", "byStatus"]),
                  notional: obj({ dayUsd: str(), weekUsd: str() }, ["dayUsd", "weekUsd"], { description: "Rolling 24 h / 7 d USD counted against caps." }),
                },
                ["keyId", "name", "kind", "parentId", "revokedAt", "requests", "intents", "notional"],
              ),
              { description: "Newest keys first, at most 100." },
            ),
            truncated: bool(),
          },
          ["keys", "truncated"],
          { description: "With scope=subtree only." },
        ),
      },
      ["keyId", "tier", "window", "since", "generatedAt", "rateLimit", "totals", "byRoute", "series", "intents", "contracts", "receipts"],
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
  };
}
