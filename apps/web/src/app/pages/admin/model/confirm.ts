/**
 * Step-up confirmations (admin design A.7): every state-changing admin call
 * except logout carries a signature, by the wallet that holds the session,
 * over a server-built message that binds the SHA-256 of the request. The
 * panel hashes the request the same way: canonical JSON (object keys sorted
 * at every depth, no whitespace). The network profile and a record's status
 * hash the body without `confirmation`; every other write hashes
 * `adminRoutePayload(method, path, body)`. Pure.
 */
import { adminRoutePayload, sha256Hex } from "@kletia/core";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/** Hex SHA-256 of the canonical JSON of a request body (without its `confirmation`). */
export function payloadSha256(body: Readonly<Record<string, unknown>>): string {
  const rest: Record<string, unknown> = { ...body };
  delete rest.confirmation;
  return sha256Hex(canonicalJson(rest));
}

/** Hex SHA-256 of a route-bound confirmation: method, path under /api/admin as sent, body without `confirmation`. */
export function routePayloadSha256(method: string, path: string, body: Readonly<Record<string, unknown>>): string {
  return sha256Hex(canonicalJson(adminRoutePayload(method, path, body)));
}

/** The one line every write shows before the wallet asks for the confirmation signature. */
export const STEP_UP_NOTE = "Your wallet will first ask you to sign a confirmation for this change (a message, not a transaction: no gas).";

export const CONFIRM_ACTIONS = {
  profile: "network-profile.update",
  recordStatus: "deployment.status",
} as const;
