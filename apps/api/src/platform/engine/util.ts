import { createHash, randomUUID } from "node:crypto";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 32 lowercase hex characters derived from a random UUID. */
export function randomHex32(): string {
  return randomUUID().replace(/-/gu, "");
}

export function newIntentId(): string {
  return `int_${randomHex32()}`;
}

export function newEventId(): string {
  return `evt_${randomHex32()}`;
}

export const INTENT_ID_PATTERN = /^int_[0-9a-f]{32}$/u;
export const STEP_ID_PATTERN = /^s[1-9]\d{0,2}$/u;

/** Deterministic JSON: object keys sorted, undefined dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") return JSON.stringify(value.toString());
    if (value === undefined) return "null";
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** ISO timestamp strictly later than `previous` (keeps optimistic concurrency tokens unique). */
export function nextTimestamp(previous?: string, now: number = Date.now()): string {
  const prior = previous ? Date.parse(previous) : Number.NaN;
  const value = Number.isFinite(prior) && prior >= now ? prior + 1 : now;
  return new Date(value).toISOString();
}

export function base64UrlEncode(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

export function base64UrlDecode(text: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,4096}$/u.test(text)) return null;
  try {
    return Buffer.from(text, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

/** floor(amount * bps / 10000) on base-unit strings. */
export function portionOf(units: string, bps: number): string {
  return ((BigInt(units) * BigInt(bps)) / 10_000n).toString();
}

export function roundUsd(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = { status: "fulfilled", value: await task(items[index] as T) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}
