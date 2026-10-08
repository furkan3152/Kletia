import { formatAmount, isDecimalAmount } from "@kletia/core";

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const compactUsdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 2,
});

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "Unpriced";
  if (value > 0 && value < 0.01) return "< $0.01";
  return usdFormatter.format(value);
}

export function formatCompactUsd(value: number): string {
  return Number.isFinite(value) ? compactUsdFormatter.format(value) : "n/a";
}

/** A fraction (0.0523) as a percentage string ("5.23%"). */
export function formatFractionPercent(value: number, digits = 2): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : "n/a";
}

/** A percentage value (1.23) as a signed string ("+1.23%"). */
export function formatSignedPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
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
