import { CHAINS, getProtocol, isNetworkKey, type AssetAmount, type IntentGraph, type NetworkKey } from "@kletia/core";

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Dollars to the cent, as the fare prints them (`formatUsdAbs` of the
 * widget): "$0.01", and "<$0.01" for a non-zero amount that rounds to zero,
 * so a review's total fees and the fare's cost never disagree in precision.
 */
export function formatUsd(value: number | undefined | null): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value > 0 && value < 0.005) return "<$0.01";
  return usd.format(value);
}

export function formatSeconds(value: number | undefined | null): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  if (value < 90) return `~${Math.max(1, Math.round(value))} s`;
  if (value < 3600) return `~${Math.round(value / 60)} min`;
  return `~${(value / 3600).toFixed(1)} h`;
}

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/u;
/** Significant digits kept after the point (and at most this many decimals for amounts of 1 or more). */
const SIGNIFICANT = 6;
const MAX_DECIMALS_ABOVE_ONE = 4;

/**
 * A token amount rounded for display: "0.002097274691133383" -> "0.00209727",
 * "1328.765384188" -> "1328.7653". Amounts Kletia receives or guarantees
 * round down (never more than the plan says); amounts you pay round up
 * (never less). Anything that is not a plain decimal is returned as is.
 */
export function displayDecimal(formatted: string, direction: "down" | "up" = "down"): string {
  const match = DECIMAL.exec(formatted.trim());
  if (!match) return formatted;
  const [, sign = "", whole = "0", fraction = ""] = match;
  const leadingZeros = whole === "0" || /^0+$/u.test(whole) ? (/^0*/u.exec(fraction)?.[0].length ?? 0) : 0;
  const keep = whole.replace(/^0+/u, "") === "" ? Math.min(fraction.length, leadingZeros + SIGNIFICANT) : Math.min(fraction.length, MAX_DECIMALS_ABOVE_ONE);
  if (keep >= fraction.length) return formatted;
  const dropped = fraction.slice(keep);
  let digits = BigInt(`${whole}${fraction.slice(0, keep)}`);
  // "up" for a negative number moves away from zero too: the absolute value is what is printed.
  if (direction === "up" && /[1-9]/u.test(dropped)) digits += 1n;
  const text = digits.toString().padStart(keep + 1, "0");
  const intPart = text.slice(0, text.length - keep) || "0";
  const fracPart = keep > 0 ? text.slice(text.length - keep).replace(/0+$/u, "") : "";
  return `${sign}${intPart}${fracPart ? `.${fracPart}` : ""}`;
}

/** "0.00209727 ETH": a rounded amount (see `displayDecimal`); the exact one belongs in a title. */
export function formatAmount(amount: AssetAmount | undefined, direction: "down" | "up" = "down"): string | null {
  if (!amount) return null;
  return `${displayDecimal(amount.formatted, direction)} ${amount.symbol}`;
}

/** `eip155:8453:0xabc…1234` → `0xabc…1234` (full id belongs in a title attribute). */
export function shortAccount(accountId: string): string {
  const address = accountId.slice(accountId.lastIndexOf(":") + 1);
  if (address.length <= 14) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function networkName(network: string): string {
  return isNetworkKey(network) ? CHAINS[network].name : network;
}

export function networkColor(network: string): string {
  return isNetworkKey(network) ? CHAINS[network].color : "#94A3B8";
}

/** Text colour that stays readable on a network colour. */
export function onNetworkColor(network: string): string {
  const color = networkColor(network).replace("#", "");
  const r = Number.parseInt(color.slice(0, 2), 16);
  const g = Number.parseInt(color.slice(2, 4), 16);
  const b = Number.parseInt(color.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? "#0B1120" : "#FFFFFF";
}

export function protocolName(id: string): string {
  return getProtocol(id)?.name ?? id;
}

/** Networks in order of first appearance across the steps. */
export function laneOrder(intent: IntentGraph): NetworkKey[] {
  const seen: NetworkKey[] = [];
  for (const step of [...intent.steps].sort((a, b) => a.index - b.index)) {
    if (!seen.includes(step.network)) seen.push(step.network);
  }
  return seen;
}

/** Edges from the graph, falling back to `dependsOn` when the API omitted them. */
export function graphEdges(intent: IntentGraph): { from: string; to: string; kind: "funds" | "orders" }[] {
  if (intent.edges.length > 0) return intent.edges.map((edge) => ({ ...edge }));
  return intent.steps.flatMap((step) =>
    step.dependsOn.map((dependency) => ({ from: dependency, to: step.id, kind: "funds" as const })),
  );
}

export const STATUS_TONE: Record<string, "neutral" | "blue" | "yellow" | "green" | "red" | "purple"> = {
  planned: "blue",
  executing: "yellow",
  settling: "purple",
  completed: "green",
  partially_completed: "yellow",
  failed: "red",
  expired: "neutral",
  cancelled: "neutral",
  indeterminate: "yellow",
  pending: "neutral",
  ready: "blue",
  awaiting_signature: "yellow",
  submitted: "purple",
  confirmed: "purple",
  settled: "green",
  skipped: "neutral",
};

export function humanize(value: string): string {
  return value.replace(/_/gu, " ");
}
