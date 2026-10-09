/**
 * Offline fallback for the explorer, mirrored from docs/platform/api-v1.md and
 * GET /v1/openapi.json. Used only while the live document is loading or when
 * the API is unreachable; the live document always wins.
 */
import type { JsonSchema } from "./schema";
import { CURATED_BODIES, type ExplorerOperation, type ExplorerParam, type HttpMethod } from "./operations";

const JSON_ONLY = ["application/json"] as const;
const STANDARD_HEADERS = ["X-Request-Id", "RateLimit", "RateLimit-Policy"] as const;

const str = (extra: JsonSchema = {}): JsonSchema => ({ type: "string", ...extra });
const path = (name: string, schema: JsonSchema = str()): ExplorerParam => ({ name, in: "path", required: true, schema });
const query = (name: string, schema: JsonSchema, description?: string): ExplorerParam => ({
  name,
  in: "query",
  required: false,
  schema,
  ...(description ? { description } : {}),
});

const INTENT_ID = path("id", str({ pattern: "^int_[0-9a-f]{32}$" }));
const STEP_ID = path("stepId", str({ maxLength: 64 }));
const WEBHOOK_ID = path("id", str({ pattern: "^wh_[0-9a-f]{24}$" }));
const KEY_ID = path("id", str({ pattern: "^key_[0-9a-f]{24}$" }));
const LIMIT = query("limit", { type: "integer", minimum: 1, maximum: 100, default: 20 });

interface Spec {
  readonly id: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly tag: string;
  readonly summary: string;
  readonly auth?: "public" | "key";
  readonly params?: readonly ExplorerParam[];
  readonly idempotent?: boolean;
  /** Required top-level body properties (the schema is otherwise open). */
  readonly body?: { readonly required: readonly string[]; readonly optional?: boolean };
  readonly produces?: readonly string[];
  readonly headers?: readonly string[];
}

function build(spec: Spec): ExplorerOperation {
  const body = spec.body
    ? {
        required: spec.body.optional !== true,
        schema: { type: "object", required: spec.body.required } satisfies JsonSchema,
        examples: CURATED_BODIES[spec.id] ?? [{ label: "Empty", value: {} }],
      }
    : null;
  return {
    id: spec.id,
    method: spec.method,
    path: spec.path,
    tag: spec.tag,
    summary: spec.summary,
    auth: spec.auth ?? "public",
    params: spec.params ?? [],
    idempotent: spec.idempotent ?? false,
    body,
    produces: spec.produces ?? JSON_ONLY,
    responseHeaders: spec.headers ?? (spec.idempotent ? [...STANDARD_HEADERS, "Idempotent-Replayed"] : STANDARD_HEADERS),
  };
}

const SPECS: readonly Spec[] = [
  { id: "getHealth", method: "GET", path: "/v1/health", tag: "System", summary: "API and per-network RPC health" },
  { id: "listNetworks", method: "GET", path: "/v1/networks", tag: "Registry", summary: "Chain registry plus per-network capabilities" },
  { id: "listProtocols", method: "GET", path: "/v1/protocols", tag: "Registry", summary: "Protocol registry" },
  {
    id: "listAssets",
    method: "GET",
    path: "/v1/assets",
    tag: "Registry",
    summary: "Canonical asset registry",
    params: [query("network", str({ maxLength: 128 }))],
  },
  {
    id: "listVenues",
    method: "GET",
    path: "/v1/venues",
    tag: "Registry",
    summary: "EVM lending venues with rates, size and exit liquidity",
    params: [
      query("network", str({ maxLength: 128 }), "Network key, CAIP-2 id or EVM chain id."),
      query("protocol", str({ maxLength: 40 }), "Lending protocol id, e.g. aave-v3, compound-v3, morpho, moonwell."),
    ],
  },
  { id: "quoteRoutes", method: "POST", path: "/v1/quotes", tag: "Quotes", summary: "Best routes for one asset movement", body: { required: [] } },
  {
    id: "getPortfolio",
    method: "GET",
    path: "/v1/portfolio/{accountId}",
    tag: "Portfolio",
    summary: "Balances for one CAIP-10 account",
    params: [path("accountId")],
  },
  {
    id: "createIntent",
    method: "POST",
    path: "/v1/intents",
    tag: "Intents",
    summary: "Plan an intent into an IntentGraph",
    params: [query("dryRun", str({ enum: ["true", "false", "1", "0"] }))],
    idempotent: true,
    body: { required: ["accounts"] },
  },
  { id: "listIntents", method: "GET", path: "/v1/intents", tag: "Intents", summary: "List intents created with the caller's key", auth: "key", params: [LIMIT] },
  { id: "getIntent", method: "GET", path: "/v1/intents/{id}", tag: "Intents", summary: "Read an intent", params: [INTENT_ID] },
  {
    id: "prepareStep",
    method: "POST",
    path: "/v1/intents/{id}/steps/{stepId}/prepare",
    tag: "Intents",
    summary: "Build wallet-ready transactions for a ready step",
    params: [INTENT_ID, STEP_ID],
  },
  {
    id: "submitStep",
    method: "POST",
    path: "/v1/intents/{id}/steps/{stepId}/submit",
    tag: "Intents",
    summary: "Submit transaction hashes or signatures for verification",
    params: [INTENT_ID, STEP_ID],
    idempotent: true,
    body: { required: ["references"] },
  },
  { id: "refreshIntent", method: "POST", path: "/v1/intents/{id}/refresh", tag: "Intents", summary: "Re-read settlement state now", params: [INTENT_ID] },
  {
    id: "cancelIntent",
    method: "POST",
    path: "/v1/intents/{id}/cancel",
    tag: "Intents",
    summary: "Cancel an intent with no submitted steps",
    params: [INTENT_ID],
    idempotent: true,
  },
  {
    id: "streamIntentEvents",
    method: "GET",
    path: "/v1/intents/{id}/events",
    tag: "Events",
    summary: "Server-Sent Events stream of intent events",
    params: [INTENT_ID, { name: "Last-Event-ID", in: "header", required: false, schema: str() }, query("since", str())],
    produces: ["text/event-stream"],
    headers: ["X-Request-Id"],
  },
  {
    id: "createWebhook",
    method: "POST",
    path: "/v1/webhooks",
    tag: "Webhooks",
    summary: "Register a webhook (secret returned once)",
    auth: "key",
    idempotent: true,
    body: { required: ["url"] },
  },
  { id: "listWebhooks", method: "GET", path: "/v1/webhooks", tag: "Webhooks", summary: "List webhooks", auth: "key" },
  {
    id: "deleteWebhook",
    method: "DELETE",
    path: "/v1/webhooks/{id}",
    tag: "Webhooks",
    summary: "Delete a webhook and its delivery log",
    auth: "key",
    params: [WEBHOOK_ID],
    produces: [],
    headers: ["X-Request-Id"],
  },
  {
    id: "testWebhook",
    method: "POST",
    path: "/v1/webhooks/{id}/test",
    tag: "Webhooks",
    summary: "Send a signed webhook.test event now",
    auth: "key",
    params: [WEBHOOK_ID],
  },
  {
    id: "listWebhookDeliveries",
    method: "GET",
    path: "/v1/webhooks/{id}/deliveries",
    tag: "Webhooks",
    summary: "Delivery log, newest first",
    auth: "key",
    params: [WEBHOOK_ID, LIMIT],
  },
  {
    id: "createApiKey",
    method: "POST",
    path: "/v1/keys",
    tag: "Keys",
    summary: "Issue a developer key (with a key: a sibling in the same project)",
    idempotent: true,
    body: { required: ["name"] },
  },
  { id: "listApiKeys", method: "GET", path: "/v1/keys", tag: "Keys", summary: "List the keys of the caller's project", auth: "key" },
  {
    id: "rotateApiKey",
    method: "POST",
    path: "/v1/keys/{id}/rotate",
    tag: "Keys",
    summary: "New secret for a key, same id, with a grace window",
    auth: "key",
    params: [KEY_ID],
    idempotent: true,
    body: { required: [], optional: true },
  },
  {
    id: "revokeApiKey",
    method: "DELETE",
    path: "/v1/keys/{id}",
    tag: "Keys",
    summary: "Revoke a key",
    auth: "key",
    params: [KEY_ID],
    produces: [],
    headers: ["X-Request-Id"],
  },
  {
    id: "getUsage",
    method: "GET",
    path: "/v1/usage",
    tag: "Usage",
    summary: "Requests, rate-limit window and intents of the caller's key",
    auth: "key",
    params: [query("window", str({ enum: ["24h", "7d"], default: "24h" }))],
  },
  { id: "listErrors", method: "GET", path: "/v1/errors", tag: "System", summary: "Error catalog" },
  {
    id: "getStatusBadge",
    method: "GET",
    path: "/v1/status/badge",
    tag: "System",
    summary: "Status badge (SVG, or a shields.io endpoint document)",
    params: [query("format", str({ enum: ["svg", "shields"], default: "svg" }))],
    produces: ["image/svg+xml", "application/json"],
    headers: ["X-Request-Id"],
  },
  {
    id: "mcp",
    method: "POST",
    path: "/v1/mcp",
    tag: "MCP",
    summary: "Model Context Protocol server (Streamable HTTP)",
    body: { required: ["jsonrpc", "method"] },
    produces: ["application/json", "text/event-stream"],
    headers: ["X-Request-Id"],
  },
  { id: "getOpenApi", method: "GET", path: "/v1/openapi.json", tag: "System", summary: "OpenAPI document", headers: ["X-Request-Id"] },
];

/** Every Platform API v1 operation, for offline use. */
export const STATIC_OPERATIONS: readonly ExplorerOperation[] = SPECS.map(build);
