/**
 * The desk's Dashboard view (/app/dashboard) as pure functions: what the
 * KPI row says, the allocation bars, the positions and yields tables and the
 * CSV file, all from `GET /v1/data/portfolio` and `/v1/data/markets/yields`.
 * Unknown values stay unknown: a null USD value renders "Unknown" with its
 * reason, never "$0". No React here: node --test loads it.
 */
import {
  CHAINS,
  dataHoldingsCsv,
  dataPositionsCsv,
  type DataAllocationSlice,
  type DataPortfolio,
  type DataPosition,
  type DataUsdValue,
  type DataYieldRow,
  type LendingHealth,
} from "@kletia/core";

export type DashboardLane = "production" | "testnet";

/** The wallet query of the connected wallets, or null when none is connected. */
export function dashboardWallets(evm: string | null, solana: string | null, lane: DashboardLane): { evm?: string; solana?: string; lane: DashboardLane } | null {
  if (!evm && !solana) return null;
  return { ...(evm ? { evm } : {}), ...(solana ? { solana } : {}), lane };
}

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

export function formatDashboardUsd(usd: number): string {
  return USD.format(usd);
}

/** "$1,234.50", or "Unknown" (the reason goes to the title / note). */
export function usdText(value: Pick<DataUsdValue, "usd">): string {
  return value.usd === null ? "Unknown" : formatDashboardUsd(value.usd);
}

export function percentText(fraction: number | null, digits = 2): string {
  return fraction === null || !Number.isFinite(fraction) ? "Unknown" : `${(fraction * 100).toFixed(digits)}%`;
}

export interface Kpi {
  readonly id: "net" | "change" | "positions" | "health";
  readonly label: string;
  readonly value: string;
  /** Tone of the value: `warning` for a health warning, `down` / `up` for a change. */
  readonly tone: "plain" | "up" | "down" | "warning";
  /** Why it is unknown or partial, or what it is measured against. */
  readonly note: string | null;
}

/** Health rows that need attention (warning or critical), worst first. */
export function healthWarnings(health: readonly LendingHealth[]): LendingHealth[] {
  const rank = { critical: 0, warning: 1 } as const;
  return health
    .filter((row): row is LendingHealth & { status: "critical" | "warning" } => row.status === "critical" || row.status === "warning")
    .sort((a, b) => rank[a.status] - rank[b.status] || (a.healthFactor ?? 0) - (b.healthFactor ?? 0));
}

/** The KPI row: total value, 24-hour change, number of positions, health warnings. */
export function dashboardKpis(portfolio: DataPortfolio): Kpi[] {
  const { net } = portfolio.totals;
  const change = portfolio.change24h;
  const warnings = healthWarnings(portfolio.health);
  const counted = portfolio.positions.filter((position) => position.kind !== "borrow").length;
  const debts = portfolio.positions.filter((position) => position.kind === "borrow").length;
  return [
    {
      id: "net",
      label: "Total value",
      value: usdText(net),
      tone: "plain",
      note: net.reason ?? null,
    },
    {
      id: "change",
      label: "24 h change (estimate)",
      value: change.usd === null ? "Unknown" : `${change.usd >= 0 ? "+" : "-"}${formatDashboardUsd(Math.abs(change.usd))}${change.pct === null ? "" : ` (${change.pct >= 0 ? "+" : ""}${(change.pct * 100).toFixed(2)}%)`}`,
      tone: change.usd === null || change.usd === 0 ? "plain" : change.usd > 0 ? "up" : "down",
      note: change.usd === null ? (change.reason ?? null) : "Against this API's reading a day ago; deposits and withdrawals count too.",
    },
    {
      id: "positions",
      label: "Positions",
      value: String(counted),
      tone: "plain",
      note: debts > 0 ? `${debts} loan${debts === 1 ? "" : "s"} too` : null,
    },
    {
      id: "health",
      label: "Health warnings",
      value: String(warnings.length),
      tone: warnings.length > 0 ? "warning" : "plain",
      note: warnings[0]
        ? `${CHAINS[warnings[0].network].shortName} ${warnings[0].protocol}: health factor ${warnings[0].healthFactor === null ? "unknown" : warnings[0].healthFactor.toFixed(2)}`
        : null,
    },
  ];
}

export interface Bar {
  readonly key: string;
  readonly label: string;
  readonly usd: number;
  /** Bar length as a fraction of the largest slice (0..1). */
  readonly length: number;
  readonly share: number;
}

/** At most `limit` bars, the rest folded into "Other" (never a new colour). */
export function allocationBars(slices: readonly DataAllocationSlice[], limit = 6): Bar[] {
  const head = slices.slice(0, limit);
  const rest = slices.slice(limit);
  const folded = rest.length > 0
    ? [...head, { key: "other", label: `Other (${rest.length})`, usd: rest.reduce((sum, slice) => sum + slice.usd, 0), share: rest.reduce((sum, slice) => sum + slice.share, 0) }]
    : head;
  const largest = Math.max(0, ...folded.map((slice) => slice.usd));
  return folded.map((slice) => ({ key: slice.key, label: slice.label, usd: slice.usd, share: slice.share, length: largest > 0 ? slice.usd / largest : 0 }));
}

const KIND_LABEL: Readonly<Record<DataPosition["kind"], string>> = { supply: "Lending", vault: "Vault", borrow: "Loan", staking: "Staking" };

export interface PositionRow {
  readonly key: string;
  readonly name: string;
  readonly network: string;
  readonly kind: string;
  readonly amount: string;
  readonly value: string;
  readonly apy: string;
  /** Why the value is unknown, or a note ("in your wallet"). */
  readonly note: string | null;
  readonly debt: boolean;
}

export function positionRows(positions: readonly DataPosition[]): PositionRow[] {
  return [...positions]
    .sort((a, b) => (b.value.usd ?? -1) - (a.value.usd ?? -1))
    .map((position) => ({
      key: `${position.account}|${position.id}`,
      name: position.name,
      network: CHAINS[position.network].shortName,
      kind: KIND_LABEL[position.kind],
      amount: position.amount === null ? "Unknown" : `${position.amount} ${position.symbol}`,
      value: position.kind === "borrow" && position.value.usd !== null ? `-${formatDashboardUsd(position.value.usd)}` : usdText(position.value),
      apy: position.apy === null ? "Unknown" : percentText(position.apy),
      note: position.value.reason ?? (position.inWallet ? "Held in your wallet" : null),
      debt: position.kind === "borrow",
    }));
}

export interface YieldTableRow {
  readonly key: string;
  readonly name: string;
  readonly network: string;
  readonly asset: string;
  readonly apy: string;
  readonly note: string | null;
  /** The sentence "Move here" hands to the composer; null when Kletia cannot deposit there. */
  readonly moveText: string | null;
}

/** Yields of the assets the wallet holds first (then the rest), best APY first within each group. */
export function yieldRows(yields: readonly DataYieldRow[], held: ReadonlySet<string>, limit = 12): YieldTableRow[] {
  const ranked = [...yields].sort((a, b) => Number(held.has(b.asset.toUpperCase())) - Number(held.has(a.asset.toUpperCase())));
  return ranked.slice(0, limit).map((row) => ({
    key: row.venue,
    name: row.name,
    network: CHAINS[row.network].shortName,
    asset: row.asset,
    apy: percentText(row.apy),
    note: row.reason ?? (row.apyBasis === "share-price" ? "Realised share-price growth" : null),
    moveText: row.executable ? row.depositText : null,
  }));
}

/** Upper-cased symbols the wallet holds with a known value. */
export function heldSymbols(portfolio: Pick<DataPortfolio, "holdings">): Set<string> {
  return new Set(portfolio.holdings.filter((holding) => holding.value.usd !== null && holding.value.usd > 0).map((holding) => holding.symbol.toUpperCase()));
}

/** `kletia-<dataset>-<yyyy-mm-dd>.csv` of a reading. */
export function csvFileName(dataset: "holdings" | "positions", asOf: string): string {
  return `kletia-${dataset}-${asOf.slice(0, 10)}.csv`;
}

/** The CSV of a dataset (core's builders: same columns and escaping as `GET /v1/data/export`). */
export function dashboardCsv(dataset: "holdings" | "positions", portfolio: Pick<DataPortfolio, "holdings" | "positions">): string {
  return dataset === "holdings" ? dataHoldingsCsv(portfolio) : dataPositionsCsv(portfolio);
}
