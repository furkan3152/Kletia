/**
 * Revenue and claims (admin design E): totals, the testnet exclusion,
 * unpriced tokens and amounts as text. The API sends its own totals; the panel
 * recomputes them from the rows so a mismatch never hides a row. Pure.
 */
import type { AdminEvmNetwork, AdminFeeRow, AdminTokenAmount } from "./types.ts";

/** Testnet value is shown but never added to USD totals. */
export const TESTNET_NETWORKS: readonly AdminEvmNetwork[] = ["arc", "arbitrum-sepolia"];

export function isTestnetNetwork(network: AdminEvmNetwork): boolean {
  return TESTNET_NETWORKS.includes(network);
}

/** A row is testnet value when the API says so or its network is a testnet. */
export function isTestnetRow(row: Pick<AdminFeeRow, "network"> & { readonly testnet?: boolean }): boolean {
  return row.testnet === true || isTestnetNetwork(row.network);
}

/** Base units → decimal text, trimmed ("1234.5"), with grouping on the integer part ("1,234.5"). */
export function formatUnits(amount: string, decimals: number, maxFraction = 6): string {
  if (!/^-?\d+$/u.test(amount)) return amount;
  const negative = amount.startsWith("-");
  const digits = (negative ? amount.slice(1) : amount).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals) || "0";
  let fraction = decimals > 0 ? digits.slice(digits.length - decimals) : "";
  fraction = fraction.slice(0, maxFraction).replace(/0+$/u, "");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  return `${negative ? "-" : ""}${grouped}${fraction ? `.${fraction}` : ""}`;
}

export function formatTokenAmount(item: AdminTokenAmount): string {
  return `${formatUnits(item.amount, item.decimals)} ${item.symbol}`;
}

export function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "unpriced";
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export interface FeeTotals {
  readonly pushedUsd: number;
  readonly accruedUsd: number;
  readonly unpricedTokens: number;
  readonly testnetRows: number;
}

export function feeTotals(rows: readonly AdminFeeRow[]): FeeTotals {
  let pushedUsd = 0;
  let accruedUsd = 0;
  let unpricedTokens = 0;
  let testnetRows = 0;
  for (const row of rows) {
    if (isTestnetRow(row)) {
      if (row.amounts.length > 0) testnetRows += 1;
      continue;
    }
    for (const amount of row.amounts) {
      if (amount.amount === "0") continue;
      if (amount.usd === null) {
        unpricedTokens += 1;
        continue;
      }
      if (row.kind === "pushed") pushedUsd += amount.usd;
      else if (row.kind === "accrued") accruedUsd += amount.usd;
    }
  }
  return { pushedUsd: round2(pushedUsd), accruedUsd: round2(accruedUsd), unpricedTokens, testnetRows };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export const FEE_KIND_LABELS: Readonly<Record<AdminFeeRow["kind"], string>> = {
  pushed: "Paid to treasury per transaction",
  accrued: "Accrued in the contract",
  "treasury-holding": "Held by the treasury",
  "lp-only": "Stays in the pool",
  "owner-funded": "Funded by the owner",
  none: "Nothing to claim",
};

/** Whether the claim button is live, and the sentence when it is not. */
export function claimState(row: AdminFeeRow): { readonly available: boolean; readonly reason: string | null } {
  if (!row.claim) return { available: false, reason: row.kind === "pushed" ? "Fees go to the treasury in each transaction." : null };
  if (row.claim.blockedReason) return { available: false, reason: row.claim.blockedReason };
  const empty = row.amounts.every((amount) => amount.amount === "0");
  if (empty) return { available: false, reason: "Nothing to withdraw." };
  return { available: true, reason: null };
}

/** "Scanning, 12,000 blocks left." while a fee scan is behind the head; null for rows without a scan. */
export function scanText(row: Pick<AdminFeeRow, "scannedThroughBlock" | "blocksLeft">): string | null {
  if (!row.scannedThroughBlock) return null;
  const left = row.blocksLeft && /^\d+$/u.test(row.blocksLeft) ? BigInt(row.blocksLeft) : 0n;
  return left > 0n
    ? `Scanning, ${formatUnits(left.toString(), 0)} blocks left.`
    : `Scanned through block ${/^\d+$/u.test(row.scannedThroughBlock) ? formatUnits(row.scannedThroughBlock, 0) : row.scannedThroughBlock}.`;
}
