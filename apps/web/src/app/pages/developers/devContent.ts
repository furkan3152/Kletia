/**
 * Static developer-portal content mirrored from docs/platform/api-v1.md.
 */

/** One row of the authentication table on the Keys page (portal design 4.4.2). */
export interface AuthTier {
  readonly tier: string;
  /** The request header, or "none". */
  readonly header: string;
  readonly limit: string;
  readonly can: string;
  /** Whether the credential may sit in browser code. */
  readonly browser: "yes" | "no";
}

export const AUTH_TIERS: readonly AuthTier[] = [
  {
    tier: "Public",
    header: "none",
    limit: "30 requests/min per IP",
    can: "Registries, quotes, intents, sessions and receipts.",
    browser: "yes",
  },
  {
    tier: "Publishable",
    header: "Authorization: Bearer kl_pub_…",
    limit: "120 requests/min per key, and the IP limit",
    can: "The public tier plus intents owned by the key and sessions from stored flows, from your allowed origins only. Never contracts by itself.",
    browser: "yes",
  },
  {
    tier: "Developer",
    header: "Authorization: Bearer kl_dev_…",
    limit: "300 requests/min per key",
    can: "Adds intent listing, webhooks, usage, Idempotency-Key, keys, project settings, contracts and links.",
    browser: "no",
  },
  {
    tier: "Agent",
    header: "Authorization: Bearer kl_agt_…",
    limit: "300 requests/min per key",
    can: "Bound by a rule book; always expires; never manages project keys or settings and never approves.",
    browser: "no",
  },
];

/** Operator keys are configuration, not a tier anyone issues (the note under the table). */
export const OPERATOR_TIER_NOTE =
  "Operator keys (1200 requests/min per key) are deployment configuration in KLETIA_OPERATOR_API_KEYS, for first-party and partner backends, not self-service.";

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
    type: "intent.receipt_issued",
    description: "A signed receipt was issued once every transaction of the intent was final.",
    fields: "intentId, receiptId, sequence, status, terminal, digest, kid, supersedes",
  },
  {
    type: "webhook.test",
    description: "Sent only by POST /v1/webhooks/{id}/test, to check an endpoint.",
    fields: "webhookId",
  },
];

/** Event families beyond intents, routed to the owning key's webhooks (and `scope: "subtree"` webhooks of its ancestors). */
export const EVENT_FAMILIES: readonly { title: string; types: readonly string[]; fields: string; note: string }[] = [
  {
    title: "Rule Book",
    types: ["policy.violation", "policy.approval_requested", "policy.approval_decided", "policy.amendment_pending", "policy.amended", "policy.spend_threshold"],
    fields: "projectId, keyId, decisionId, and the rules, approval, version or window concerned",
    note: "An approval request carries the https approval link for a human.",
  },
  {
    title: "Keys",
    types: ["key.created", "key.revoked"],
    fields: "projectId, keyId, kind, parentId, expiresAt; a revocation lists its cascade",
    note: "Revoking a key revokes its whole subtree in one event.",
  },
  {
    title: "Custom contracts",
    types: ["contract.registered", "contract.activated", "contract.suspended", "contract.reactivated"],
    fields: "contractId, ownerKeyId, network, target, revision, reason?",
    note: "Registered fires before activation, so a stolen key cannot add a contract silently.",
  },
  {
    title: "Intent links",
    types: ["link.created", "link.activated", "link.updated", "link.paused", "link.suspended", "link.exhausted", "link.expired", "link.deleted"],
    fields: "linkId, ownerKeyId, revision, reason?",
    note: "Intent events of link visitors carry metadata.linkId.",
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
