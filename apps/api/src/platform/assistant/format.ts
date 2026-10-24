/**
 * How the assistant prints numbers, and the decimal arithmetic it needs to
 * add token amounts without floating-point drift. A printed value is the one
 * the facts carry, so a worded answer can be checked against it.
 */
import { CHAINS, type NetworkKey } from "@kletia/core";

/** "$1,234.56", "-$12.30"; amounts under a cent print as "$0.00". */
export function usd(value: number): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A signed USD change: "+$12.30", "-$4.00". */
export function signedUsd(value: number): string {
  return value > 0 ? `+${usd(value)}` : usd(value);
}

/** A fraction as a percentage with one decimal: 0.1234 -> "12.3%". */
export function pct(fraction: number, signed = false): string {
  const text = `${(fraction * 100).toFixed(1)}%`;
  return signed && fraction > 0 ? `+${text}` : text;
}

export function networkName(network: NetworkKey): string {
  return CHAINS[network].name;
}

/** The word the sentence reader takes for a network ("arbitrum", "solana devnet"). */
export function networkWord(network: NetworkKey): string {
  return network === "arbitrum-sepolia" ? "arbitrum sepolia" : network === "solana-devnet" ? "solana devnet" : network;
}

function split(value: string): [bigint, number] {
  const trimmed = value.trim();
  if (!/^-?\d+(?:\.\d+)?$/u.test(trimmed)) return [0n, 0];
  const negative = trimmed.startsWith("-");
  const [whole = "0", fraction = ""] = trimmed.replace("-", "").split(".");
  const units = BigInt(`${whole}${fraction}`);
  return [negative ? -units : units, fraction.length];
}

/** Exact sum of decimal strings ("0.05" + "0.01" = "0.06"), trailing zeros dropped. */
export function addDecimals(values: readonly string[]): string {
  const parts = values.map(split);
  const scale = Math.max(0, ...parts.map(([, digits]) => digits));
  const total = parts.reduce((sum, [units, digits]) => sum + units * 10n ** BigInt(scale - digits), 0n);
  const negative = total < 0n;
  const digits = (negative ? -total : total).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/u, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/**
 * A token amount for a sentence, rounded down so it never exceeds what is
 * held: at most `digits` decimals and 6 significant digits.
 */
export function floorAmount(value: number, digits = 6): string | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const magnitude = Math.floor(Math.log10(value));
  const decimals = Math.max(0, Math.min(digits, 5 - magnitude));
  const factor = 10 ** decimals;
  const floored = Math.floor(value * factor) / factor;
  if (floored <= 0) return null;
  return floored.toFixed(decimals).replace(/(\.\d*?)0+$/u, "$1").replace(/\.$/u, "");
}

/** "24 Oct 2026": the date of an ISO time (UTC). */
export function dateOf(iso: string): string {
  const date = new Date(iso);
  return `${date.getUTCDate()} ${date.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${date.getUTCFullYear()}`;
}
