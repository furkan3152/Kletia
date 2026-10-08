/**
 * Exact decimal <-> base-unit conversion. Amounts cross every boundary as
 * strings so no layer silently rounds through a float.
 */

const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/u;
const BASE_UNIT_PATTERN = /^(?:0|[1-9]\d*)$/u;

export function isDecimalAmount(value: unknown): value is string {
  return typeof value === "string" && DECIMAL_PATTERN.test(value);
}

export function isBaseUnitAmount(value: unknown): value is string {
  return typeof value === "string" && BASE_UNIT_PATTERN.test(value);
}

/** "1.5" with 6 decimals -> "1500000". Throws on excess precision. */
export function toBaseUnits(amount: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error("decimals must be an integer between 0 and 36.");
  }
  const trimmed = amount.trim();
  if (!isDecimalAmount(trimmed)) throw new Error(`Invalid decimal amount: ${amount}`);
  const [whole = "0", fraction = ""] = trimmed.split(".");
  const significantFraction = fraction.replace(/0+$/u, "");
  if (significantFraction.length > decimals) {
    throw new Error(`Amount ${amount} exceeds ${decimals} decimal places.`);
  }
  const units = BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt((significantFraction || "0").padEnd(decimals, "0") || "0");
  return units.toString();
}

/** "1500000" with 6 decimals -> "1.5". */
export function fromBaseUnits(units: string | bigint, decimals: number): string {
  const value = typeof units === "bigint" ? units : BigInt(units);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(decimals, "0").replace(/0+$/u, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** Human formatting with a bounded number of fractional digits. */
export function formatAmount(amount: string, maxFractionDigits = 6): string {
  if (!isDecimalAmount(amount)) return amount;
  const [whole = "0", fraction = ""] = amount.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  const clipped = fraction.slice(0, maxFractionDigits).replace(/0+$/u, "");
  return clipped ? `${grouped}.${clipped}` : grouped;
}

/** Applies a basis-point haircut to a base-unit amount (rounding down). */
export function applySlippage(units: string, slippageBps: number): string {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new Error("slippageBps must be an integer between 0 and 10000.");
  }
  return ((BigInt(units) * BigInt(10_000 - slippageBps)) / 10_000n).toString();
}
