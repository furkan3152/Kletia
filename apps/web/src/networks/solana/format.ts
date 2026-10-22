import { formatAmount, isDecimalAmount } from "@kletia/core";

const compactUsdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 2,
});

export function formatCompactUsd(value: number): string {
  return Number.isFinite(value) ? compactUsdFormatter.format(value) : "n/a";
}

/** A fraction (0.0523) as a percentage string ("5.23%"). */
export function formatFractionPercent(value: number, digits = 2): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : "n/a";
}

export function formatTokenAmount(amount: string, maxFractionDigits = 6): string {
  return isDecimalAmount(amount) ? formatAmount(amount, maxFractionDigits) : amount;
}

/** Strict decimal input validation: positive, within `decimals` places. */
export function validateAmountInput(value: string, decimals: number): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "Enter an amount.";
  if (!isDecimalAmount(trimmed)) return "Use digits and an optional decimal point.";
  const [, fraction = ""] = trimmed.split(".");
  if (fraction.replace(/0+$/u, "").length > decimals) {
    return `Use at most ${decimals} decimal places.`;
  }
  if (/^0(?:\.0*)?$/u.test(trimmed)) return "Amount must be greater than zero.";
  return null;
}
