/**
 * Fixed-point decimal strings for the clarify layer (18 fractional digits,
 * BigInt): balance shortcuts ("All · 2.49 SOL"), portions and comparisons
 * are computed deterministically, never with floats. `engine/util.ts`
 * portionOf works on base units only; these work on the decimal strings the
 * thread and the copy carry.
 */
const SCALE = 18;
const ONE = 10n ** BigInt(SCALE);

/** True for a non-negative decimal string ("12", "0.5", "120.40"). */
export function isDecimal(value: string | undefined): value is string {
  return value !== undefined && /^\d+(?:\.\d+)?$/u.test(value.trim());
}

export function parseDecimal(value: string): bigint {
  const text = value.trim();
  if (!isDecimal(text)) throw new Error("not a decimal string");
  const [whole = "0", fraction = ""] = text.split(".");
  const padded = (fraction + "0".repeat(SCALE)).slice(0, SCALE);
  return BigInt(whole) * ONE + BigInt(padded || "0");
}

/** Formats with at most `decimals` fractional digits (truncated, never rounded up), trailing zeros removed. */
export function formatDecimal(value: bigint, decimals = SCALE): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / ONE;
  const fraction = (abs % ONE).toString().padStart(SCALE, "0").slice(0, Math.max(0, Math.min(SCALE, decimals))).replace(/0+$/u, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** A decimal string re-formatted to at most `decimals` places ("120.40" with 6 -> "120.4"). */
export function tidy(value: string, decimals = SCALE): string {
  return formatDecimal(parseDecimal(value), decimals);
}

export function sub(a: string, b: string): bigint {
  return parseDecimal(a) - parseDecimal(b);
}

/** `value` times `bps` / 10,000, truncated. */
export function portion(value: string, bps: number): bigint {
  return (parseDecimal(value) * BigInt(bps)) / 10_000n;
}

export function cmp(a: string, b: string): number {
  const left = parseDecimal(a);
  const right = parseDecimal(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isPositive(value: string | undefined): boolean {
  return isDecimal(value) && parseDecimal(value) > 0n;
}

/** `a` + `b` as a decimal string ("10" + "5" -> "15"): arithmetic the person wrote ("10 + 5"). */
export function add(a: string, b: string): string {
  return formatDecimal(parseDecimal(a) + parseDecimal(b));
}

/**
 * `a` x `b` as a decimal string ("2" x "50" -> "100"), or null when the exact
 * product needs more than 18 fractional digits (never rounded).
 */
export function multiply(a: string, b: string): string | null {
  const raw = parseDecimal(a) * parseDecimal(b);
  if (raw % ONE !== 0n) return null;
  return formatDecimal(raw / ONE);
}
