/**
 * The Webhooks page's pure parts: delivery rows, the URL pre-check, event
 * selection, scope labels and what a key may do. The API stays the authority
 * on every rule mirrored here (it checks the URL again, with DNS, at
 * registration and at every delivery); the pre-check only saves a round trip
 * and explains a refusal before it happens.
 *
 * Only `@kletia/core` and the status table are imported, so the node tests
 * load this file directly.
 */
import { AGENT_EVENT_TYPES, CONTRACT_EVENT_TYPES, KEY_EVENT_TYPES, LINK_EVENT_TYPES, POLICY_EVENT_TYPES, RECEIPT_EVENT_TYPE } from "@kletia/core";

import { toneFor, type StatusEntry } from "../../../site/ui/statusTones.ts";

/* -------------------------------------------------------------- deliveries */

/** First attempt plus the dispatcher's three retries (1 s, 5 s, 25 s): `WEBHOOK_RETRY_DELAYS_MS` in the API. */
export const WEBHOOK_MAX_ATTEMPTS = 4;

/** At most this many endpoints per key (`MAX_WEBHOOKS_PER_KEY` in the API). */
export const WEBHOOK_LIMIT_PER_KEY = 10;

/** A delivery as `GET /v1/webhooks/{id}/deliveries` returns it (the SDK's `WebhookDelivery`). */
export interface DeliveryInput {
  readonly id: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly intentId?: string;
  readonly attempt: number;
  readonly status: string;
  readonly httpStatus?: number;
  readonly durationMs?: number;
  readonly error?: string;
  readonly nextRetryAt?: string;
  readonly test?: boolean;
  readonly at: string;
}

export interface DeliveryRow {
  readonly id: string;
  /** `14:08:53` (UTC), the table's time column. */
  readonly time: string;
  /** `14 Oct 2026, 14:08:53 UTC`, for the row's title and the expanded facts. */
  readonly stamp: string;
  readonly event: string;
  readonly eventId: string;
  /** `1 of 4`; a test event is sent once (`1 of 1`). */
  readonly attempt: string;
  readonly status: StatusEntry;
  /** `405`, or `–` when the endpoint never answered. */
  readonly http: string;
  /** `175 ms`, or `–`. */
  readonly duration: string;
  /** `14:08:54 UTC`, or `–` when nothing is scheduled. */
  readonly nextRetry: string;
  readonly intentId: string | null;
  /** What went wrong, in words; null for a delivered event. */
  readonly problem: string | null;
  readonly test: boolean;
  readonly failed: boolean;
}

function validDate(value: string | null | undefined): Date | null {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const pad = (value: number) => String(value).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `14:08:53` in UTC; invalid → `–`. */
export function utcClock(value: string | null | undefined): string {
  const date = validDate(value);
  if (!date) return "–";
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

/** `14 Oct 2026, 13:57 UTC`; `seconds` adds `:05`; invalid → `–`. */
export function utcStamp(value: string | null | undefined, options: { readonly seconds?: boolean } = {}): string {
  const date = validDate(value);
  if (!date) return "–";
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}${options.seconds ? `:${pad(date.getUTCSeconds())}` : ""}`;
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${time} UTC`;
}

/** Why an attempt failed, in words (the API's `error` codes). */
export function deliveryProblem(error: string | null | undefined, httpStatus?: number): string {
  switch (error) {
    case "http_status":
      return typeof httpStatus === "number" ? `Your endpoint answered HTTP ${httpStatus}; only 2xx counts as delivered.` : "Your endpoint answered with a status other than 2xx.";
    case "timeout":
      return "Your endpoint did not answer within 5 seconds.";
    case "connection_failed":
      return "Kletia could not connect to your endpoint.";
    case "redirect":
      return "Your endpoint answered with a redirect; deliveries never follow redirects.";
    case "forbidden_address":
      return "The host resolved to an address that is not public, so nothing was sent.";
    case "queue_full":
      return "Too many deliveries were waiting for this key, so this one was dropped.";
    case "paused":
      return "The endpoint is paused after repeated failures, so this one was dropped.";
    default:
      return error ? `Delivery failed (${error}).` : "Delivery failed.";
  }
}

/**
 * One row of the deliveries table. A failed attempt with a retry scheduled
 * is "Retrying" (warning, next retry in UTC); a failed attempt with nothing
 * scheduled is "Gave up" (danger): the dispatcher stopped after it. A test
 * event is sent once and never retried, so its failure is plainly "Failed".
 */
export function deliveryRowModel(delivery: DeliveryInput, maxAttempts = WEBHOOK_MAX_ATTEMPTS): DeliveryRow {
  const test = delivery.test === true;
  const attempt = Number.isInteger(delivery.attempt) && delivery.attempt > 0 ? delivery.attempt : 1;
  const retry = delivery.status === "failed" ? validDate(delivery.nextRetryAt) : null;
  let status: StatusEntry;
  if (delivery.status === "succeeded" || delivery.status === "delivered") status = toneFor("webhook-delivery", "delivered");
  else if (delivery.status === "failed" && retry) status = toneFor("webhook-delivery", "retrying");
  else if (delivery.status === "failed" && test) status = { ...toneFor("webhook-delivery", "failed"), label: "Failed" };
  else if (delivery.status === "failed") status = toneFor("webhook-delivery", "failed");
  else status = toneFor("webhook-delivery", delivery.status);
  const failed = status.tone === "danger" || status.tone === "warning";
  return {
    id: delivery.id,
    time: utcClock(delivery.at),
    stamp: utcStamp(delivery.at, { seconds: true }),
    event: delivery.eventType,
    eventId: delivery.eventId,
    attempt: `${attempt} of ${test ? 1 : Math.max(attempt, maxAttempts)}`,
    status,
    http: typeof delivery.httpStatus === "number" ? String(delivery.httpStatus) : "–",
    duration: typeof delivery.durationMs === "number" && Number.isFinite(delivery.durationMs) ? `${Math.round(delivery.durationMs)} ms` : "–",
    nextRetry: retry ? `${utcClock(retry.toISOString())} UTC` : "–",
    intentId: delivery.intentId ?? null,
    problem: failed ? deliveryProblem(delivery.error, delivery.httpStatus) : null,
    test,
    failed,
  };
}

export type DeliveryFilter = "all" | "failed";

/** The table's filter: every attempt, or only the ones that did not deliver. */
export function filterDeliveries(rows: readonly DeliveryRow[], filter: DeliveryFilter): readonly DeliveryRow[] {
  return filter === "failed" ? rows.filter((row) => row.failed) : rows;
}

/** The list's "Last delivery" cell: `✕ 405 · 14:08 UTC`, or null with no delivery read. */
export function lastDeliverySummary(deliveries: readonly DeliveryInput[] | null | undefined): { readonly status: StatusEntry; readonly text: string } | null {
  const latest = deliveries?.[0];
  if (!latest) return null;
  const row = deliveryRowModel(latest);
  const code = row.http !== "–" ? `${row.http} · ` : "";
  return { status: row.status, text: `${code}${row.time.slice(0, 5)} UTC` };
}

/* ------------------------------------------------------------ URL pre-check */

export type UrlCheck = { readonly ok: true; readonly url: string } | { readonly ok: false; readonly message: string };

const MAX_URL_LENGTH = 2_048;
const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata", "metadata.google.internal", "instance-data", "kubernetes", "kubernetes.default"]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa", ".lan", ".intranet", ".corp", ".private"];

/** IPv4 ranges the API refuses (netguard.ts), as [first octets, prefix]. */
const BLOCKED_V4: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
  ["168.63.129.16", 32],
];

function ipv4Number(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function publicIpv4(address: string): boolean {
  const value = ipv4Number(address);
  if (value === null) return false;
  return !BLOCKED_V4.some(([network, prefix]) => {
    const base = ipv4Number(network)!;
    const size = 2 ** (32 - prefix);
    return value >= base && value < base + size;
  });
}

/** Global unicast IPv6 only (2000::/3), without the documentation, 6to4 and IETF ranges the API refuses. */
function publicIpv6(address: string): boolean {
  const lower = address.toLowerCase();
  const first = lower.split(":")[0] ?? "";
  if (!/^[0-9a-f]{1,4}$/u.test(first)) return false;
  const head = parseInt(first, 16);
  if (head < 0x2000 || head > 0x3fff) return false;
  const second = parseInt(lower.split(":")[1] || "0", 16);
  if (head === 0x2002) return false;
  if (head === 0x3fff && second < 0x1000) return false;
  if (head === 0x2001 && (second < 0x0200 || second === 0x0db8)) return false;
  return true;
}

/**
 * The API's static checks on a webhook URL, before anything is sent: an
 * absolute https URL of at most 2,048 characters, no `user:password@`, no
 * fragment, port 443 or 1024-65535, and a public host (a dotted DNS name
 * that is not local, or a public IP address). DNS is the API's to check.
 */
export function checkWebhookUrl(raw: string): UrlCheck {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { ok: false, message: "Enter the https:// URL of your endpoint." };
  if (text.length > MAX_URL_LENGTH) return { ok: false, message: `The URL is longer than ${MAX_URL_LENGTH.toLocaleString("en-US")} characters.` };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, message: "That is not an absolute URL. Start it with https://." };
  }
  if (url.protocol !== "https:") return { ok: false, message: "Webhook URLs must use HTTPS." };
  if (url.username || url.password) return { ok: false, message: "Remove the user:password@ part: webhook URLs carry no credentials (deliveries are signed instead)." };
  if (url.hash) return { ok: false, message: "Remove the #fragment: it is never sent to a server." };
  if (url.port && url.port !== "443" && Number(url.port) < 1024) return { ok: false, message: "Use port 443 or a port from 1024 to 65535." };
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (!bare) return { ok: false, message: "The URL has no host." };
  if (ipv4Number(bare) !== null) {
    return publicIpv4(bare) ? { ok: true, url: url.toString() } : { ok: false, message: "Webhook URLs must point to a public internet address, not a private, local or reserved one." };
  }
  if (bare.includes(":")) {
    return publicIpv6(bare) ? { ok: true, url: url.toString() } : { ok: false, message: "Webhook URLs must point to a public internet address, not a private, local or reserved one." };
  }
  if (BLOCKED_HOSTNAMES.has(bare) || BLOCKED_SUFFIXES.some((suffix) => bare.endsWith(suffix)) || !bare.includes(".")) {
    return { ok: false, message: "Webhook URLs must use a public DNS name (localhost and local or internal names are refused)." };
  }
  return { ok: true, url: url.toString() };
}

/* ---------------------------------------------------------------- events */

export interface EventGroup {
  readonly id: "intent" | "contract" | "link" | "policy" | "key" | "agent";
  readonly label: string;
  readonly detail: string;
  readonly types: readonly string[];
}

/** Every event type a webhook can subscribe to, grouped as the Events page lists them (API order). */
export const WEBHOOK_EVENT_GROUPS: readonly EventGroup[] = [
  {
    id: "intent",
    label: "Intents",
    detail: "Created, status and step changes, and the signed receipt.",
    types: ["intent.created", "intent.status_changed", "intent.step_updated", RECEIPT_EVENT_TYPE],
  },
  { id: "contract", label: "Contracts", detail: "Registered, activated, suspended and reactivated.", types: [...CONTRACT_EVENT_TYPES] },
  { id: "link", label: "Intent links", detail: "Created, activated, updated, paused, used up, expired and withdrawn.", types: [...LINK_EVENT_TYPES] },
  { id: "policy", label: "Rule Book", detail: "Violations, approvals, amendments and spend thresholds.", types: [...POLICY_EVENT_TYPES] },
  { id: "key", label: "Keys", detail: "Agent keys created and revoked.", types: [...KEY_EVENT_TYPES] },
  { id: "agent", label: "Sub-agents", detail: "Sub-agents requested, approved, denied and revoked.", types: [...AGENT_EVENT_TYPES] },
];

export const WEBHOOK_EVENT_TYPES: readonly string[] = WEBHOOK_EVENT_GROUPS.flatMap((group) => group.types);

export type EventMode = "all" | "choose";

export type EventsChoice = { readonly ok: true; readonly events: readonly string[] | undefined } | { readonly ok: false; readonly message: string };

/**
 * The `events` field of `POST /v1/webhooks`: left out for "every current
 * type" (the API then subscribes to the types that exist now, and later
 * types never start arriving unasked), or the chosen types in API order.
 */
export function buildEvents(mode: EventMode, selected: Iterable<string>): EventsChoice {
  if (mode === "all") return { ok: true, events: undefined };
  const chosen = new Set(selected);
  const events = WEBHOOK_EVENT_TYPES.filter((type) => chosen.has(type));
  if (events.length === 0) return { ok: false, message: "Choose at least one event type, or subscribe to every current type." };
  return { ok: true, events };
}

/** Group checkbox state: all, some or none of its types are chosen. */
export function groupState(group: EventGroup, selected: ReadonlySet<string>): "all" | "some" | "none" {
  const count = group.types.filter((type) => selected.has(type)).length;
  return count === 0 ? "none" : count === group.types.length ? "all" : "some";
}

/** The selection with a whole group switched on or off. */
export function toggleGroup(group: EventGroup, selected: ReadonlySet<string>, on: boolean): Set<string> {
  const next = new Set(selected);
  for (const type of group.types) {
    if (on) next.add(type);
    else next.delete(type);
  }
  return next;
}

/** `3 types` / `every type` / the one type: the list's events cell. */
export function eventsSummary(events: readonly string[]): string {
  if (events.length === 0) return "–";
  if (events.length === 1) return events[0]!;
  const all = WEBHOOK_EVENT_TYPES.every((type) => events.includes(type));
  return all ? `Every type (${events.length})` : `${events.length} types`;
}

/* ----------------------------------------------------------- scope and key */

export type WebhookScope = "self" | "subtree";

export function scopeLabel(scope: string | null | undefined): string {
  return scope === "subtree" ? "This key and its agent keys" : "This key";
}

export interface WebhookPermissions {
  readonly read: boolean;
  readonly create: boolean;
  readonly test: boolean;
  readonly remove: boolean;
  /** What the loaded key may do here, in one sentence. */
  readonly summary: string;
}

/**
 * What a key may do on the Webhooks page, as the API enforces it: developer
 * keys manage their endpoints; an agent key reads its own endpoints and
 * delivery logs, and adds, tests and deletes them only when its rule book
 * chain grants `permissions.webhooks` (`AGENT_KEY_FORBIDDEN` otherwise).
 * `grant` is that permission as read from the chain, or null while unknown
 * (then the page offers reading only; the API stays the authority).
 */
export function webhookPermissions(kind: "developer" | "agent" | null, grant: boolean | null = null): WebhookPermissions {
  if (kind === "developer") {
    return { read: true, create: true, test: true, remove: true, summary: "This developer key can add, test and delete its endpoints and read their deliveries." };
  }
  if (kind === "agent" && grant === true) {
    return {
      read: true,
      create: true,
      test: true,
      remove: true,
      summary: "This agent key's rule book grants permissions.webhooks: it can add, test and delete its own endpoints and read their deliveries.",
    };
  }
  if (kind === "agent") {
    return {
      read: true,
      create: false,
      test: false,
      remove: false,
      summary:
        grant === false
          ? "This agent key can read its own endpoints and their deliveries. Its rule book does not grant permissions.webhooks, so adding, testing and deleting endpoints takes a developer key (kl_dev_) or that permission."
          : "This agent key can read its own endpoints and their deliveries. It adds, tests and deletes them only when its rule book grants permissions.webhooks.",
    };
  }
  return { read: false, create: false, test: false, remove: false, summary: "Load a key to see its endpoints." };
}

/** Webhook ids as the API issues them (`wh_` and 24 hex characters). */
export const WEBHOOK_ID = /^wh_[0-9a-f]{24}$/u;

/* ---------------------------------------------------- not configured (503) */

/**
 * True for the API's `503 WEBHOOKS_NOT_CONFIGURED`: the deployment has no
 * platform secret to seal endpoint secrets with, so no endpoint can be
 * listed, added or tested there. The pages then explain it and hide
 * "Add endpoint" instead of showing a generic error.
 */
export function webhooksNotConfigured(error: { readonly code: string } | null | undefined): boolean {
  return error?.code === "WEBHOOKS_NOT_CONFIGURED";
}

/** What the Webhooks pages say on such a deployment. */
export const WEBHOOKS_NOT_CONFIGURED_COPY = Object.freeze({
  title: "Webhooks are not configured on this deployment",
  body: "Its operator has not set the platform secret Kletia seals each endpoint's signing secret with, so endpoints cannot be added here yet. Your keys and intents work as usual.",
  alternative: "To see events now, follow an intent over Server-Sent Events: GET /v1/events with your key, or kletia listen from the CLI.",
  operator: "Running this deployment? Set KLETIA_PLATFORM_SECRET (32 or more random characters, never changed afterwards) and restart the API.",
});
