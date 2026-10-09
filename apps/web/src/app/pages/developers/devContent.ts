/**
 * Static developer-portal content mirrored from docs/platform/api-v1.md.
 */

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
    capabilities: "Read registries, quotes, create and run intents. Safe from browsers.",
    accent: "#CBD5E1",
  },
  {
    name: "Developer",
    how: "Authorization: Bearer kl_dev_…",
    limit: "300 requests/min per key",
    capabilities: "Adds intent listing, webhooks, usage, Idempotency-Key and key management. Server-side only.",
    accent: "#FFD60A",
  },
  {
    name: "Operator",
    how: "Key configured in KLETIA_OPERATOR_API_KEYS",
    limit: "1200 requests/min per key",
    capabilities: "Everything above, for first-party and partner backends. Configuration, not self-service.",
    accent: "#1A1A1A",
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
  {
    type: "webhook.test",
    description: "Sent only by POST /v1/webhooks/{id}/test, to check an endpoint.",
    fields: "webhookId",
  },
];

/** Headers every webhook delivery carries. */
export const DELIVERY_HEADERS: readonly { name: string; description: string }[] = [
  { name: "Kletia-Signature", description: "t=<unix>,v1=<hex HMAC-SHA256(secret, \"<t>.<raw body>\")>" },
  { name: "Kletia-Event-Id", description: "The event id: de-duplicate by it." },
  { name: "Kletia-Event-Type", description: "The event type, e.g. intent.step_updated." },
  { name: "Kletia-Webhook-Id", description: "The webhook that matched." },
  { name: "Kletia-Delivery-Attempt", description: "1 for the first attempt, up to 4." },
];

export interface TocItem {
  readonly id: string;
  readonly label: string;
  /** Short label for the mobile section bar. */
  readonly short: string;
}

export const TOC: readonly TocItem[] = [
  { id: "quickstart", label: "Quickstart", short: "Start" },
  { id: "keys", label: "Keys & auth", short: "Keys" },
  { id: "explorer", label: "API explorer", short: "Explorer" },
  { id: "recipes", label: "Recipes", short: "Recipes" },
  { id: "events", label: "Events & webhooks", short: "Events" },
  { id: "venues", label: "Venues & auction", short: "Venues" },
  { id: "errors", label: "Errors", short: "Errors" },
  { id: "agents", label: "Agents", short: "Agents" },
];
