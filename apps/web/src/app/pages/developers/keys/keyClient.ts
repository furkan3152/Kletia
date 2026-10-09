/**
 * A Kletia client bound to the key held in memory. It is created per call
 * and never cached, so the key is not retained anywhere once the page lets
 * go of it. Retries are off: the portal shows every answer as it came.
 */
import { KletiaClient } from "@kletia/sdk";

import { PLATFORM_ORIGIN } from "../../../../shared/platform/kletiaClient";

export function keyedClient(apiKey: string): KletiaClient {
  return new KletiaClient({
    baseUrl: PLATFORM_ORIGIN,
    timeoutMs: 15_000,
    maxRetries: 0,
    ...(apiKey ? { apiKey } : {}),
  });
}

/** `2026-10-09T09:59:43.742Z` → `Oct 9, 2026, 09:59` (local time). */
export function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export const GRACE_OPTIONS: readonly { readonly value: string; readonly label: string }[] = [
  { value: "0", label: "End the old secret now" },
  { value: "3600", label: "Old secret works 1 hour" },
  { value: "86400", label: "Old secret works 24 hours (default)" },
  { value: "604800", label: "Old secret works 7 days" },
];
