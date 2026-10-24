/**
 * The desk's History view and the Dashboard's value chart as pure
 * functions: transaction rows (title, amounts, value at the time, protocol,
 * explorer and receipt links), the filter query, coverage notes, the value
 * series as an SVG path and the PnL rows. Unknown values stay unknown, never
 * $0. Also the hand-off from the assistant's answer card: the transaction
 * it named opens in History (its network filtered, its row open). No React
 * here: node --test loads it.
 */
import {
  CHAINS,
  DATA_TX_KINDS,
  type DataPnl,
  type DataSnapshotPoint,
  type DataTransaction,
  type DataTxCoverage,
  type DataTxKind,
  type DataTxLeg,
  type DataTxQuery,
  type NetworkKey,
  NETWORK_KEYS,
} from "@kletia/core";

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const SIGNED_USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2, signDisplay: "exceptZero" });

export const KIND_LABELS: Readonly<Record<DataTxKind, string>> = Object.freeze({
  send: "Sent",
  receive: "Received",
  swap: "Swap",
  "bridge-out": "Bridged out",
  "bridge-in": "Bridged in",
  deposit: "Deposit",
  withdraw: "Withdrawal",
  stake: "Stake",
  unstake: "Unstake",
  borrow: "Borrow",
  repay: "Repay",
  approve: "Approval",
  perp: "Perps",
  order: "Order",
  prediction: "Prediction",
  "contract-call": "Contract call",
  failed: "Failed",
  unknown: "Unknown",
});

/** Kinds the filter offers, in the order of DATA_TX_KINDS. */
export const KIND_OPTIONS: readonly DataTxKind[] = DATA_TX_KINDS;

export interface HistoryFilters {
  readonly network: NetworkKey | "";
  readonly kind: DataTxKind | "";
  /** Symbol or token address typed by the user. */
  readonly asset: string;
  readonly kletiaOnly: boolean;
}

export const EMPTY_FILTERS: HistoryFilters = Object.freeze({ network: "", kind: "", asset: "", kletiaOnly: false });

/* ------------------------------------------------------------ focus */

let pendingFocus: string | null = null;

/** The network of a data API transaction id (`<network>:<hash>`), or null for anything else. */
export function focusNetwork(id: string): NetworkKey | null {
  const network = id.slice(0, id.indexOf(":"));
  return id.indexOf(":") > 0 && /^[0-9A-Za-z]{20,100}$/u.test(id.slice(network.length + 1)) && (NETWORK_KEYS as readonly string[]).includes(network) ? (network as NetworkKey) : null;
}

/** Asks the History view to open a transaction (the answer card's "Open in History"); ignored when the id is not one. */
export function requestHistoryFocus(id: string): void {
  pendingFocus = focusNetwork(id) ? id : null;
}

/** The transaction History should open (read on mount; a render may read it twice). */
export function peekHistoryFocus(): string | null {
  return pendingFocus;
}

/** Done with a focus once History has shown it: the next visit opens nothing. */
export function clearHistoryFocus(id: string | null): void {
  if (id !== null && pendingFocus === id) pendingFocus = null;
}

/** Filters that list a focused transaction's network, so its row is among the first read. */
export function focusFilters(id: string | null): HistoryFilters {
  const network = id ? focusNetwork(id) : null;
  return network ? { ...EMPTY_FILTERS, network } : EMPTY_FILTERS;
}

/** The read query of the filters (blank fields left out). */
export function filterQuery(filters: HistoryFilters, cursor?: string | null): DataTxQuery {
  const asset = filters.asset.trim();
  return {
    ...(filters.network ? { network: filters.network } : {}),
    ...(filters.kind ? { kind: filters.kind } : {}),
    ...(asset ? { asset: asset.slice(0, 64) } : {}),
    ...(filters.kletiaOnly ? { kletiaOnly: true } : {}),
    ...(cursor ? { cursor } : {}),
    limit: 50,
  };
}

/** "1.5 ETH", trimmed to 6 significant decimals; "Unknown amount" when the decimals were unknown. */
export function amountText(leg: Pick<DataTxLeg, "amount" | "asset">): string {
  if (leg.amount === null) return `Unknown amount of ${leg.asset.symbol}`;
  const [whole = "0", fraction = ""] = leg.amount.split(".");
  const kept = fraction.slice(0, 6).replace(/0+$/u, "");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  return `${kept ? `${grouped}.${kept}` : grouped}${fraction.length > 6 && kept ? "…" : ""} ${leg.asset.symbol}`;
}

export function legLine(leg: DataTxLeg): string {
  const sign = leg.direction === "in" ? "+" : "−";
  return `${sign}${amountText(leg)}`;
}

/** "$412.50 at the time", or the reason it is unknown. */
export function legValue(leg: Pick<DataTxLeg, "usdAtTime" | "reason">): { readonly text: string; readonly known: boolean } {
  return leg.usdAtTime === null ? { text: leg.reason ?? "No price at the time", known: false } : { text: usd(leg.usdAtTime), known: true };
}

function shortAddress(address: string): string {
  return address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

export interface HistoryRow {
  readonly key: string;
  readonly kind: DataTxKind;
  readonly title: string;
  /** "Base · Oct 20, 10:00" */
  readonly meta: string;
  /** The main legs, one line each ("+250 USDC", "−0.1 ETH"). */
  readonly legs: readonly string[];
  readonly failed: boolean;
  readonly protocol: string | null;
  readonly counterparty: string | null;
  readonly fee: string | null;
  readonly explorerUrl: string;
  readonly explorerName: string;
  /** `/r/<receiptId>` when the transaction was a step of a Kletia intent with a receipt. */
  readonly receiptPath: string | null;
  readonly kletia: boolean;
}

function title(tx: DataTransaction): string {
  const label = KIND_LABELS[tx.kind];
  if (tx.protocol) return `${label} · ${tx.protocol.label}`;
  if ((tx.kind === "send" || tx.kind === "receive") && tx.counterparty) return `${label} ${tx.kind === "send" ? "to" : "from"} ${shortAddress(tx.counterparty)}`;
  return label;
}

export function historyRow(tx: DataTransaction, locale?: string): HistoryRow {
  const when = new Date(tx.time).toLocaleString(locale ?? "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const fee = tx.fee
    ? `${amountText({ amount: tx.fee.amount, asset: tx.fee.asset })}${tx.fee.usd === null ? "" : ` (${usd(tx.fee.usd)})`}`
    : null;
  return {
    key: `${tx.account}|${tx.id}`,
    kind: tx.kind,
    title: title(tx),
    meta: `${CHAINS[tx.network].shortName} · ${when}`,
    legs: tx.legs.map(legLine),
    failed: tx.status === "failed",
    protocol: tx.protocol?.label ?? null,
    counterparty: tx.counterparty,
    fee,
    explorerUrl: tx.explorerUrl,
    explorerName: CHAINS[tx.network].explorer.name,
    receiptPath: tx.kletiaReceiptId ? `/r/${encodeURIComponent(tx.kletiaReceiptId)}` : null,
    kletia: tx.kletiaIntentId !== null,
  };
}

/** Accounts whose history is missing or partial, as notes (grouped by reason). */
export function coverageNotes(coverage: readonly DataTxCoverage[]): string[] {
  const notes = new Map<string, NetworkKey[]>();
  for (const entry of coverage) {
    if (entry.status === "ok" && !entry.reason) continue;
    const reason = entry.reason ?? entry.status;
    const networks = notes.get(reason) ?? [];
    if (!networks.includes(entry.network)) networks.push(entry.network);
    notes.set(reason, networks);
  }
  return [...notes.entries()].map(([reason, networks]) => `${networks.map((network) => CHAINS[network].shortName).join(", ")}: ${reason}`);
}

/** True when no account could be read because no provider is configured (the API's not-configured state). */
export function historyNotConfigured(coverage: readonly DataTxCoverage[]): boolean {
  return coverage.length > 0 && coverage.every((entry) => entry.status === "not-configured" || entry.status === "unsupported");
}

/* ------------------------------------------------------------- chart */

export interface ValueChart {
  /** SVG path in a 100 x 40 box (y grows downwards). */
  readonly path: string;
  readonly area: string;
  readonly min: number;
  readonly max: number;
  readonly first: DataSnapshotPoint;
  readonly last: DataSnapshotPoint;
  readonly incomplete: number;
}

/** The series as a line (two or more points), scaled to its own min and max. */
export function valueChart(points: readonly DataSnapshotPoint[]): ValueChart | null {
  if (points.length < 2) return null;
  const values = points.map((point) => point.usd);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const start = Date.parse(points[0]!.at);
  const width = Date.parse(points[points.length - 1]!.at) - start || 1;
  const xy = points.map((point) => [((Date.parse(point.at) - start) / width) * 100, 38 - ((point.usd - min) / span) * 36] as const);
  const path = xy.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`).join(" ");
  return {
    path,
    area: `${path} L100 40 L0 40 Z`,
    min,
    max,
    first: points[0]!,
    last: points[points.length - 1]!,
    incomplete: points.filter((point) => !point.complete).length,
  };
}

export function signedUsd(usd: number | null): string {
  return usd === null ? "Unknown" : SIGNED_USD.format(usd);
}

/** "$1,234.50"; a positive amount under a cent reads "<$0.01", never "$0.00". */
export function usd(value: number | null): string {
  if (value === null) return "Unknown";
  return value > 0 && value < 0.005 ? "<$0.01" : USD.format(value);
}

/* --------------------------------------------------------------- pnl */

export interface PnlRow {
  readonly key: string;
  readonly symbol: string;
  readonly open: string;
  readonly cost: string;
  readonly realized: string;
  readonly unrealized: string;
  readonly tone: "up" | "down" | "flat" | "unknown";
  readonly note: string | null;
}

/** The assets with something open or realized, largest value first (the API's order). */
export function pnlRows(pnl: DataPnl): PnlRow[] {
  return pnl.assets
    .filter((asset) => asset.openQuantity > 0 || (asset.realizedUsd ?? 1) !== 0)
    .map((asset) => {
      const total = asset.unrealizedUsd === null && asset.realizedUsd === null ? null : (asset.unrealizedUsd ?? 0) + (asset.realizedUsd ?? 0);
      return {
        key: asset.key,
        symbol: asset.symbol,
        open: asset.openQuantity === 0 ? "0" : String(asset.openQuantity),
        cost: usd(asset.costBasisUsd),
        realized: signedUsd(asset.realizedUsd),
        unrealized: signedUsd(asset.unrealizedUsd),
        tone: total === null ? "unknown" : total > 0 ? "up" : total < 0 ? "down" : "flat",
        note: asset.reason ?? null,
      };
    });
}
