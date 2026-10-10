/**
 * Pure formatting helpers shared by the developer portal panels (contracts,
 * Rule Book, links, receipts). No relative imports, so the node tests load
 * this file directly.
 */

/** The string when it is an absolute https URL (user-controlled links never get any other scheme). */
export function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Host of an https URL, for display ("acme.example"). */
export function hostOf(value: unknown): string | null {
  const url = httpsUrl(value);
  return url ? new URL(url).host : null;
}

const USD_WHOLE = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 });
const USD_CENTS = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "1250.5" → "$1,250.50", "2000" → "$2,000"; null, empty or non-numeric → "—". */
export function formatUsd(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return "—";
  const cents = Math.round(number * 100);
  return cents % 100 === 0 ? USD_WHOLE.format(cents / 100) : USD_CENTS.format(cents / 100);
}

/** Share of a cap used, clamped to [0, 1]; null when there is no cap. */
export function usageRatio(used: string | number | null | undefined, cap: string | number | null | undefined): number | null {
  const capNumber = cap === null || cap === undefined || cap === "" ? NaN : Number(cap);
  if (!Number.isFinite(capNumber) || capNumber <= 0) return null;
  const usedNumber = Number(used ?? 0);
  if (!Number.isFinite(usedNumber) || usedNumber <= 0) return 0;
  return Math.min(1, usedNumber / capNumber);
}

/** "2026-10-09T09:59:43.742Z" → "Oct 9, 2026, 09:59" in local time; invalid → the input; empty → "—". */
export function formatWhen(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Seconds as words: 90 → "1 min 30 s", 3600 → "1 hour", 86400 → "1 day", 604800 → "7 days". */
export function durationText(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0 s";
  const s = Math.round(seconds);
  if (s % 86_400 === 0) return `${s / 86_400} ${s === 86_400 ? "day" : "days"}`;
  if (s % 3_600 === 0) return `${s / 3_600} ${s === 3_600 ? "hour" : "hours"}`;
  if (s >= 86_400) {
    const days = Math.floor(s / 86_400);
    const hours = Math.floor((s % 86_400) / 3_600);
    return hours ? `${days} d ${hours} h` : `${days} d`;
  }
  if (s >= 3_600) {
    const hours = Math.floor(s / 3_600);
    const minutes = Math.floor((s % 3_600) / 60);
    return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
  }
  if (s >= 60) {
    const minutes = Math.floor(s / 60);
    const rest = s % 60;
    return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
  }
  return `${s} s`;
}

/**
 * Time until an instant: { text: "in 14 min 3 s", past: false }; once
 * reached { text: "now", past: true }. Invalid dates: null.
 */
export function timeUntil(value: string | null | undefined, now: number): { readonly text: string; readonly past: boolean; readonly seconds: number } | null {
  if (!value) return null;
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  const seconds = Math.ceil((at - now) / 1000);
  if (seconds <= 0) return { text: "now", past: true, seconds: 0 };
  return { text: `in ${durationText(seconds)}`, past: false, seconds };
}

/** `ct_5f1c2a9b7e3d4c6a8b0e1f23` → `ct_5f1c…1f23`. */
export function shortId(id: string, head = 4, tail = 4): string {
  const cut = id.indexOf("_");
  const prefix = cut >= 0 ? id.slice(0, cut + 1) : "";
  const body = id.slice(prefix.length);
  return body.length <= head + tail + 1 ? id : `${prefix}${body.slice(0, head)}…${body.slice(-tail)}`;
}

/** `0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A` → `0x3304…566A`. */
export function shortAddress(address: string): string {
  if (address.startsWith("0x") && address.length > 12) return `${address.slice(0, 6)}…${address.slice(-4)}`;
  return address.length > 14 ? `${address.slice(0, 5)}…${address.slice(-5)}` : address;
}

/** Lines of a textarea: trimmed, empties and duplicates dropped, also split on commas when `commas`. */
export function splitLines(text: string, options: { readonly commas?: boolean } = {}): string[] {
  const parts = text.split(options.commas ? /[\n,]/u : /\n/u).map((part) => part.trim());
  return [...new Set(parts.filter((part) => part.length > 0))];
}

/** Decimal number text with up to `decimals` fraction digits ("", "10", "0.5"). */
export function isDecimalText(value: string, decimals = 18): boolean {
  return new RegExp(`^(?:0|[1-9]\\d{0,29})(?:\\.\\d{1,${decimals}})?$`, "u").test(value);
}

/** Plural helper: (1, "use") → "1 use", (3, "use") → "3 uses". */
export function countText(count: number, noun: string, plural = `${noun}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? noun : plural}`;
}
