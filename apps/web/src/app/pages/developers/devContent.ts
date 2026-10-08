/**
 * Static developer-portal content mirrored from docs/platform/api-v1.md. The
 * endpoint list is the fallback for the live OpenAPI reference.
 */

export type HttpMethod = "GET" | "POST" | "DELETE" | "PUT" | "PATCH";

export interface EndpointSummary {
  readonly method: HttpMethod;
  readonly path: string;
  readonly summary: string;
  readonly auth: "public" | "key";
}

export const STATIC_ENDPOINTS: readonly EndpointSummary[] = [
  { method: "GET", path: "/v1/health", summary: "API and per-network RPC health", auth: "public" },
  { method: "GET", path: "/v1/networks", summary: "Chain registry plus per-network capabilities", auth: "public" },
  { method: "GET", path: "/v1/protocols", summary: "Protocol registry", auth: "public" },
  { method: "GET", path: "/v1/assets?network=", summary: "Canonical asset registry", auth: "public" },
  { method: "POST", path: "/v1/quotes", summary: "Best routes for one asset movement (same- or cross-network)", auth: "public" },
  { method: "GET", path: "/v1/portfolio/{accountId}", summary: "Balances for one CAIP-10 account", auth: "public" },
  { method: "POST", path: "/v1/intents", summary: "Plan an intent into an IntentGraph (?dryRun=true to skip persistence)", auth: "public" },
  { method: "GET", path: "/v1/intents", summary: "List intents created with the caller's key", auth: "key" },
  { method: "GET", path: "/v1/intents/{id}", summary: "Read an intent", auth: "public" },
  { method: "POST", path: "/v1/intents/{id}/steps/{stepId}/prepare", summary: "Build wallet-ready transactions for a ready step", auth: "public" },
  { method: "POST", path: "/v1/intents/{id}/steps/{stepId}/submit", summary: "Submit transaction hashes / signatures for verification", auth: "public" },
  { method: "POST", path: "/v1/intents/{id}/refresh", summary: "Re-read settlement state now", auth: "public" },
  { method: "POST", path: "/v1/intents/{id}/cancel", summary: "Cancel an intent with no submitted steps", auth: "public" },
  { method: "GET", path: "/v1/intents/{id}/events", summary: "Server-Sent Events stream of intent events", auth: "public" },
  { method: "POST", path: "/v1/webhooks", summary: "Register a webhook (secret returned once)", auth: "key" },
  { method: "GET", path: "/v1/webhooks", summary: "List webhooks", auth: "key" },
  { method: "DELETE", path: "/v1/webhooks/{id}", summary: "Delete a webhook", auth: "key" },
  { method: "POST", path: "/v1/keys", summary: "Issue a developer key", auth: "public" },
  { method: "GET", path: "/v1/openapi.json", summary: "OpenAPI document", auth: "public" },
];

export interface AuthTier {
  readonly name: string;
  readonly how: string;
  readonly limit: string;
  readonly capabilities: string;
  readonly accent: string;
}

export const AUTH_TIERS: readonly AuthTier[] = [
  {
    name: "Public",
    how: "No key",
    limit: "30 requests/min per IP",
    capabilities: "Read registries, quotes, create and run intents.",
    accent: "#14F195",
  },
  {
    name: "Developer",
    how: "Authorization: Bearer kl_dev_…",
    limit: "300 requests/min per key",
    capabilities: "Everything above, plus intent listing and webhooks.",
    accent: "#FFD60A",
  },
  {
    name: "Operator",
    how: "Key configured in KLETIA_OPERATOR_API_KEYS",
    limit: "1200 requests/min per key",
    capabilities: "Everything above, for first-party and partner backends.",
    accent: "#0052FF",
  },
];

export const EVENT_TYPES: readonly { type: string; description: string; fields: string }[] = [
  { type: "intent.created", description: "An intent was planned and persisted.", fields: "intentId, summary, metadata?" },
  {
    type: "intent.status_changed",
    description: "The intent moved between planned, executing, settling and a terminal state.",
    fields: "intentId, status, previous",
  },
  {
    type: "intent.step_updated",
    description: "A step changed status, usually with fresh on-chain or settlement evidence.",
    fields: "intentId, stepId, network, status, evidence?",
  },
];

export const TOC: readonly { id: string; label: string }[] = [
  { id: "quickstart", label: "Quickstart" },
  { id: "auth", label: "Authentication" },
  { id: "keys", label: "Developer key" },
  { id: "explorer", label: "API explorer" },
  { id: "reference", label: "Endpoint reference" },
  { id: "events", label: "Events & webhooks" },
  { id: "embed", label: "Widget & embed" },
  { id: "agents", label: "Agents" },
];
