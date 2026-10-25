/**
 * The OpenAPI document and the served JSON.
 */
import {
  AUTOMATION_EVENT_TYPES,
  AGENT_EVENT_TYPES,
  CONTRACT_EVENT_TYPES,
  KEY_EVENT_TYPES,
  LINK_EVENT_TYPES,
  POLICY_EVENT_TYPES,
} from "@kletia/core";
import { REJECTION_CODES } from "../../index.js";
import { PLATFORM_API_VERSION } from "../health.js";
import { IDEMPOTENCY_LOCK_MS, IDEMPOTENCY_TTL_MS } from "../idempotency.js";
import { TIER_LIMITS } from "../limits.js";
import { ASSISTANT_TAG } from "../assistantOpenapi.js";
import { DATA_TAG } from "../dataOpenapi.js";
import { WEBHOOK_EVENT_TYPES } from "../webhooks.js";
import {
  errorResponse,
  int,
  type JsonObject,
  ref,
  REQUEST_ID_HEADER,
  str,
} from "./helpers.js";
import { schemas } from "./schemas.js";
import { paths } from "./platformPaths.js";

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
        `Tiers: public ${TIER_LIMITS.public}/min per IP, developer ${TIER_LIMITS.developer}/min per key, operator ${TIER_LIMITS.operator}/min per key. Errors are \`{ "error": { "code", "message", "issues"?, "hints"?, "details"?, "docs"? }, "requestId" }\` with codes from the catalog at GET /v1/errors; every response carries X-Request-Id. Keyed POSTs that create or change state accept \`Idempotency-Key\`. Agents can use the MCP server at /v1/mcp (read-only tools, plus keyed creation of intents and links; nothing is ever signed). Agent keys (\`kl_agt_\`) are bound by their rule book chain. Developer and agent keys are server keys: sent from a browser on another origin they get 403 SECRET_KEY_FROM_BROWSER.`,
      license: { name: "MIT", identifier: "MIT" },
      contact: { name: "Kletia", url: "https://kletiaai.xyz" },
    },
    servers: [
      { url: PRODUCTION_SERVER, description: "Production" },
      { url: "http://localhost:3001", description: "Local development" },
    ],
    security: [{}, { bearerAuth: [] }, { apiKeyHeader: [] }],
    tags: [
      { name: "System", description: "Health, the error catalog, the status badge and this document." },
      { name: "Registry", description: "Networks, protocols and assets, derived from the engine's live adapters." },
      { name: "Quotes", description: "Advisory route quotes; nothing is stored." },
      { name: "Portfolio", description: "Balances and venue positions of CAIP-10 accounts, one or up to 12 per request." },
      DATA_TAG,
      ASSISTANT_TAG,
      { name: "Intents", description: "Plan, prepare, submit, verify and cancel intents." },
      { name: "Events", description: "Server-Sent Events per intent, and the key's own event stream." },
      { name: "Receipts", description: "Signed, privacy-preserving receipts of finished intents, verifiable offline and re-checkable on-chain; shares, keys and the transparency log." },
      { name: "Webhooks", description: "Signed event deliveries to your HTTPS endpoints, test deliveries and delivery logs." },
      { name: "Keys", description: "Issue, list, rotate and revoke the API keys of your project." },
      { name: "Accounts", description: "Developer accounts: sign in with a wallet from the developer portal, list the projects it owns and issue, rotate and revoke their keys, also after every key was lost." },
      { name: "Usage", description: "Per-key request counts and rate-limit state." },
      { name: "Contracts", description: "Register your own EVM contracts and Solana Actions so your key's intents can call them: pinned, simulated, verified, never audited by Kletia." },
      { name: "Sessions", description: "Short-lived templates your backend creates so the embed can run your fixed actions for a visitor's wallet (with a publishable key: from a stored flow)." },
      { name: "Projects", description: "Project settings (brand, allowed origins, defaults, stored flows), the domain proof, publishable keys for browsers, the logo and the publishable profile." },
      { name: "Rule Book", description: "Rule books of keys and of the project (tighten now, loosen later), the simulator, the hash-chained decision log, spend windows and approvals." },
      { name: "Orders", description: "Native protocol orders that execute without the user online after one signature: Jupiter limit and DCA orders on Solana, CoW Protocol limit and TWAP orders on Ethereum, Arbitrum and Base. Kletia builds what the wallet signs and relays only the owner's checked signature." },
      { name: "Sub-agents", description: "Main agents request sub-agents inside their own rule book; the project owner (wallet signature) or a project key approves; the requester claims the key once. The agent tree with caps and use, revoke and pause." },
      { name: "Links", description: "Intent links: public pages whose destination the publisher fixes and whose funding the visitor chooses; quotes, intents, counters, share cards." },
      { name: "Automations", description: "Rules that watch a schedule, a price, a balance, venue APYs or incoming transfers and plan an intent for the owner to sign (or hand it to a native order provider); runs and the inbox." },
      { name: "Blinks", description: "Solana Actions for eligible links (actions.json is served by the web origin)." },
      { name: "MCP", description: "Model Context Protocol server for agents: read-only tools, plus keyed creation of intents and links for a human to sign." },
      { name: "Perps", description: "Perpetual futures on GMX v2, Hyperliquid and Drift v2: markets, positions, quotes with liquidation estimates, unsigned payloads for the user's wallet, and the relay of user-signed Hyperliquid actions." },
      { name: "Predictions", description: "Prediction markets on Polymarket (Polygon): market search, order books and implied probabilities, quotes with max loss and payout, unsigned approvals and EIP-712 orders for the user's own wallet, the order-book sign-in, the relay of user-signed orders, positions and redemption." },
    ],
    paths: paths(),
    webhooks: {
      intentEvent: {
        post: {
          operationId: "receiveIntentEvent",
          summary: "Intent event delivery",
          description:
            "Sent for intents created with your API key to each matching webhook. Respond 2xx within 5 seconds; redirects are not followed. Failed deliveries are retried up to 3 times (after 1 s, 5 s and 25 s). Each key's deliveries are queued separately (at most 200 waiting; the oldest is dropped beyond that) and a webhook receives one delivery at a time. A webhook whose last 5 attempts failed is paused for 30 s, doubling up to 5 minutes while it keeps failing; its deliveries wait meanwhile. With Postgres the queue is durable: retries survive restarts, so an event can arrive more than once (deduplicate by Kletia-Event-Id). `intent.receipt_issued` is sent once a receipt is issued (after every reference is finalized; ids and digest only); webhooks created before it existed do not receive it unless re-created.",
          parameters: [
            { name: "Kletia-Signature", in: "header", required: true, schema: str({ pattern: "^t=[0-9]+,v1=[0-9a-f]{64}$" }) },
            { name: "Kletia-Event-Id", in: "header", required: true, schema: ref("EventId") },
            { name: "Kletia-Event-Type", in: "header", required: true, schema: str({ enum: WEBHOOK_EVENT_TYPES.filter((type) => type.startsWith("intent.")) }) },
            { name: "Kletia-Webhook-Id", in: "header", required: true, schema: str() },
            { name: "Kletia-Delivery-Attempt", in: "header", required: true, schema: str({ pattern: "^[1-4]$" }) },
          ],
          requestBody: { required: true, content: { "application/json": { schema: ref("KletiaEvent") } } },
          responses: { "200": { description: "Any 2xx acknowledges the delivery." } },
        },
      },
      contractEvent: {
        post: {
          operationId: "receiveContractEvent",
          summary: "Contract registration event delivery",
          description:
            "Sent to the webhooks of the registration's own key that subscribe to the type: contract.registered (a registration or a new revision; on mainnet it activates after the delay), contract.activated, contract.suspended (pins changed, outcome mismatch, program changed, domain no longer verified, operator) and contract.reactivated. Same signing, retries and queueing as intent events. Webhooks created before these types existed do not receive them unless re-created.",
          parameters: [
            { name: "Kletia-Signature", in: "header", required: true, schema: str({ pattern: "^t=[0-9]+,v1=[0-9a-f]{64}$" }) },
            { name: "Kletia-Event-Id", in: "header", required: true, schema: ref("EventId") },
            { name: "Kletia-Event-Type", in: "header", required: true, schema: str({ enum: [...CONTRACT_EVENT_TYPES] }) },
            { name: "Kletia-Webhook-Id", in: "header", required: true, schema: str() },
            { name: "Kletia-Delivery-Attempt", in: "header", required: true, schema: str({ pattern: "^[1-4]$" }) },
          ],
          requestBody: { required: true, content: { "application/json": { schema: ref("ContractEvent") } } },
          responses: { "200": { description: "Any 2xx acknowledges the delivery." } },
        },
      },
      linkEvent: {
        post: {
          operationId: "receiveLinkEvent",
          summary: "Intent link event delivery",
          description:
            "Sent to the webhooks of the link's owning key that subscribe to the type (and to `scope: \"subtree\"` webhooks of its ancestors): link.created, link.activated, link.updated (tightened, domain verified or not, blink approval), link.paused (by the publisher, or itself when a pinned name or contract changed), link.suspended, link.exhausted, link.expired, link.deleted. Same signing, retries and queueing as intent events.",
          parameters: [
            { name: "Kletia-Signature", in: "header", required: true, schema: str({ pattern: "^t=[0-9]+,v1=[0-9a-f]{64}$" }) },
            { name: "Kletia-Event-Id", in: "header", required: true, schema: ref("EventId") },
            { name: "Kletia-Event-Type", in: "header", required: true, schema: str({ enum: [...LINK_EVENT_TYPES] }) },
            { name: "Kletia-Webhook-Id", in: "header", required: true, schema: str() },
            { name: "Kletia-Delivery-Attempt", in: "header", required: true, schema: str({ pattern: "^[1-4]$" }) },
          ],
          requestBody: { required: true, content: { "application/json": { schema: ref("LinkEvent") } } },
          responses: { "200": { description: "Any 2xx acknowledges the delivery." } },
        },
      },
      automationEvent: {
        post: {
          operationId: "receiveAutomationEvent",
          summary: "Automation event delivery",
          description:
            "Sent to the webhooks of the automation's owning key that subscribe to the type (and to `scope: \"subtree\"` webhooks of its ancestors): automation.created, automation.updated (paused, resumed, label or limits changed, completed, expired), automation.deleted, automation.fired (a run planned an intent: `needs_signature`, or `prepared` by a native order provider), automation.skipped (a limit, `reason`) and automation.failed (`reason`: the error code). Wallet-owned automations send none. Same signing, retries and queueing as intent events.",
          parameters: [
            { name: "Kletia-Signature", in: "header", required: true, schema: str({ pattern: "^t=[0-9]+,v1=[0-9a-f]{64}$" }) },
            { name: "Kletia-Event-Id", in: "header", required: true, schema: ref("EventId") },
            { name: "Kletia-Event-Type", in: "header", required: true, schema: str({ enum: [...AUTOMATION_EVENT_TYPES] }) },
            { name: "Kletia-Webhook-Id", in: "header", required: true, schema: str() },
            { name: "Kletia-Delivery-Attempt", in: "header", required: true, schema: str({ pattern: "^[1-4]$" }) },
          ],
          requestBody: { required: true, content: { "application/json": { schema: ref("AutomationEvent") } } },
          responses: { "200": { description: "Any 2xx acknowledges the delivery." } },
        },
      },
      policyEvent: {
        post: {
          operationId: "receivePolicyEvent",
          summary: "Rule Book and key event delivery",
          description:
            "Sent to the subject key's webhooks, to `scope: \"subtree\"` webhooks of its ancestors and to `scope: \"subtree\"` webhooks of the project's project keys: policy.violation, policy.approval_requested, policy.approval_decided, policy.amendment_pending, policy.amended, policy.spend_threshold (80 % and 95 % of a window), key.created, key.revoked (with the cascade) and the sub-agent events agent.subagent_requested, agent.subagent_approved, agent.subagent_denied and agent.subagent_revoked (subject: the parent key).",
          parameters: [
            { name: "Kletia-Signature", in: "header", required: true, schema: str({ pattern: "^t=[0-9]+,v1=[0-9a-f]{64}$" }) },
            { name: "Kletia-Event-Id", in: "header", required: true, schema: ref("EventId") },
            { name: "Kletia-Event-Type", in: "header", required: true, schema: str({ enum: [...POLICY_EVENT_TYPES, ...KEY_EVENT_TYPES, ...AGENT_EVENT_TYPES] }) },
            { name: "Kletia-Webhook-Id", in: "header", required: true, schema: str() },
            { name: "Kletia-Delivery-Attempt", in: "header", required: true, schema: str({ pattern: "^[1-4]$" }) },
          ],
          requestBody: { required: true, content: { "application/json": { schema: { oneOf: [ref("PolicyEvent"), ref("KeyEvent"), ref("AgentEvent")] } } } },
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
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "kl_dev_<32 base62>", description: "Developer, agent or operator API key; or a publishable key (kl_pub_, browsers: only the operations the Projects tag lists, from the project's allowed origins)." },
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
        BadRequest: errorResponse("Invalid input (INVALID_REQUEST, INVALID_JSON, MESSAGE_SECRET_REFUSED, THREAD_INVALID, THREAD_REQUIRES_API_KEY, POLICY_INVALID, LINK_DEFINITION_INVALID, REFERENCES_INVALID, REFERENCE_INVALID, REFERENCE_COUNT_MISMATCH, IDEMPOTENCY_KEY_INVALID, IDEMPOTENCY_KEY_REQUIRES_API_KEY, IDEMPOTENCY_NOT_SUPPORTED, ...)."),
        Unauthorized: errorResponse("Missing or invalid API key (API_KEY_REQUIRED, INVALID_API_KEY, INVALID_AUTHORIZATION)."),
        Forbidden: errorResponse("Not allowed (SECRET_KEY_FROM_BROWSER for a kl_dev_ or kl_agt_ key sent with a foreign Origin, KEY_SECRET_ROTATED, MCP_ORIGIN_FORBIDDEN, SESSION_ORIGIN_FORBIDDEN, POLICY_VIOLATION, POLICY_SPEND_LIMIT, POLICY_SCHEDULE_CLOSED, POLICY_OWNER_REVOKED, POLICY_APPROVAL_REQUIRED, POLICY_APPROVAL_REJECTED, AGENT_KEY_FORBIDDEN, APPROVAL_SIGNATURE_INVALID, APPROVER_NOT_ALLOWED; Rule Book refusals carry error.policy)."),
        NotFound: errorResponse("Unknown resource or route (AUTOMATION_NOT_FOUND, INTENT_NOT_FOUND, STEP_NOT_FOUND, WEBHOOK_NOT_FOUND, KEY_NOT_FOUND, CONTRACT_NOT_FOUND, SESSION_NOT_FOUND, PREVIEW_NOT_FOUND, RECEIPT_NOT_FOUND, RECEIPT_SHARE_NOT_FOUND, RECEIPT_LOG_NOT_FOUND, POLICY_NOT_FOUND, APPROVAL_NOT_FOUND, LINK_NOT_FOUND, THREAD_NOT_FOUND, NOT_FOUND)."),
        Conflict: errorResponse("State conflict (QUESTION_NOT_OPEN, THREAD_CONFLICT, THREAD_CLOSED, STEP_NOT_READY, STEP_NOT_AWAITING_SIGNATURE, QUOTE_MOVED, INTENT_CONFLICT, INTENT_NOT_CANCELLABLE, INTENT_IN_FLIGHT (Retry-After), WEBHOOK_EXISTS, KEY_NOT_MANAGEABLE, KEY_LIMIT_REACHED, IDEMPOTENCY_REQUEST_IN_PROGRESS, CONTRACT_EXISTS, CONTRACT_LIMIT_REACHED, CONTRACT_PENDING, CONTRACT_SUSPENDED, CONTRACT_CHANGED, SESSION_USED, PREVIEW_CHANGED, RECEIPT_NOT_READY, RECEIPT_NOT_APPLICABLE, RECEIPT_SHARE_LIMIT, RECEIPT_ANCHOR_EXISTS, POLICY_CONFLICT, POLICY_AMENDMENT_PENDING, POLICY_APPROVAL_STALE, AGENT_KEY_LIMIT_REACHED, KEY_DEPTH_EXCEEDED, APPROVAL_DECIDED, LINK_LIMIT_REACHED, LINK_PENDING, LINK_PAUSED, LINK_SUSPENDED, LINK_EXHAUSTED, LINK_ACCOUNT_LIMIT, LINK_RECIPIENT_CHANGED, LINK_CONTRACT_CHANGED, ...)."),
        Gone: errorResponse("Expired (INTENT_EXPIRED, DEADLINE_PASSED, SESSION_EXPIRED, RECEIPT_SHARE_EXPIRED, RECEIPT_DISCLOSURES_WITHDRAWN, POLICY_APPROVAL_EXPIRED, LINK_EXPIRED)."),
        PayloadTooLarge: errorResponse("Request body larger than 64 KB."),
        UnsupportedMediaType: errorResponse("Request body is not application/json."),
        Unprocessable: errorResponse(`Understood but not executable (INTENT_UNSUPPORTED, ROUTE_UNSUPPORTED, CAPITAL_LANE_MIXED, SELF_TRANSFER, FEE_LIMIT_EXCEEDED, INSUFFICIENT_BALANCE, WEBHOOK_URL_FORBIDDEN, IDEMPOTENCY_KEY_REUSED, CONTRACT_UNKNOWN, CONTRACT_DENIED, CONTRACT_FUNCTION_FORBIDDEN, CONTRACT_NOT_DEPLOYED, SIMULATION_ASSET_CHANGE_REFUSED, ACTION_TRANSACTION_REJECTED, RECEIPT_ANCHOR_INVALID, LINK_POLICY_CONFLICT, LINK_IMMUTABLE_FIELD, LINK_INPUT_OUT_OF_BOUNDS, LINK_SOURCE_NOT_ALLOWED, LINK_ACCOUNTS_REQUIRED, LINK_PUBLISHER_MISMATCH, LINK_NOT_BLINK_ELIGIBLE, SESSION_EXPIRES_BEFORE_ACTIVATION, SOURCE_REQUIRED, SOURCE_UNREACHABLE, GAS_TOPUP_UNAVAILABLE, ANSWER_INVALID, EDIT_UNSUPPORTED, ${[...REJECTION_CODES].join(", ")}, ...).`),
        TooManyRequests: {
          ...errorResponse("Rate limit exceeded (RATE_LIMITED, also for too many unrecognised API keys from one IP; TOO_MANY_STREAMS)."),
          headers: { "X-Request-Id": REQUEST_ID_HEADER, "Retry-After": { $ref: "#/components/headers/Retry-After" } },
        },
        InternalError: errorResponse("Unexpected error (INTERNAL_ERROR, LINK_PLAN_OUT_OF_BOUNDS)."),
        BadGateway: errorResponse("An upstream provider or RPC failed (PROVIDER_UNAVAILABLE, RPC_UNAVAILABLE, ACTION_ENDPOINT_UNAVAILABLE, LINK_DELIVERY_UNQUOTABLE)."),
        Unavailable: errorResponse("Storage or a feature is unavailable (STORE_UNAVAILABLE, also when a presented API key cannot be verified; WEBHOOKS_NOT_CONFIGURED, CONTRACTS_DISABLED, SIMULATION_UNAVAILABLE, RECEIPTS_DISABLED, POLICY_PRICE_UNAVAILABLE, LINKS_DISABLED, LINK_PAGE_UNAVAILABLE)."),
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

const PRODUCTION_SERVER = "https://api.kletiaai.xyz";
/** KLETIA_API_ORIGIN as a bare origin (HTTPS, or localhost HTTP outside production); null when unset or invalid. */
function deploymentOrigin(): string | null {
  const raw = process.env.KLETIA_API_ORIGIN?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    const scheme = url.protocol === "https:" || (url.protocol === "http:" && local && process.env.NODE_ENV !== "production");
    return scheme && url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
}

let served: { readonly origin: string | null; readonly json: string } | null = null;

/**
 * The document GET /v1/openapi.json serves: the exported document, plus this
 * deployment's own origin as the first server when KLETIA_API_ORIGIN names one
 * other than production (validated like the blink hrefs: HTTPS, or localhost
 * HTTP outside production). Generated clients then default to the deployment
 * that served them. The exported file (docs/platform/openapi.json) never
 * changes with the environment.
 */
export function servedOpenApiJson(): string {
  const origin = deploymentOrigin();
  const own = origin === PRODUCTION_SERVER ? null : origin;
  if (served?.origin === own) return served.json;
  let json = openApiJson();
  if (own) {
    const document = JSON.parse(json) as { servers: { url: string; description: string }[] };
    document.servers = [{ url: own, description: "This deployment" }, ...document.servers.filter((server) => server.url !== own)];
    json = JSON.stringify(document);
  }
  served = { origin: own, json };
  return json;
}
