/**
 * Step-up confirmations (admin design A.7): writes that change future
 * defaults (a network profile, a record's status) carry a signature over a
 * server-built message that binds the SHA-256 of the request body. The panel
 * hashes the body the same way: canonical JSON (object keys sorted at every
 * depth, no whitespace) of the body without `confirmation`. Pure.
 */
import { sha256Hex } from "@kletia/core";

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

export const CONFIRM_ACTIONS = {
  profile: "network-profile.update",
  recordStatus: "deployment.status",
} as const;
