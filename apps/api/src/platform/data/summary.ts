/**
 * One compact object about a wallet set for an assistant
 * (`GET /v1/data/summary`): totals, the largest allocation slices and
 * positions, risk flags, activity counts of the newest history and the PnL
 * estimates, each from the same reads as the full endpoints, with every
 * source named. Nothing here is advice; values that are unknown stay null.
 */
import type { DataCoverageExtras, DataPnl, DataPortfolio, DataRiskFlag, DataSummary, DataTransaction, DataTxKind } from "@kletia/core";
import type { HistoryRead } from "./pnl.js";

const DAY_MS = 86_400_000;
/** Below this distance between mark and liquidation price, a perp is flagged (critical below half of it). */
const PERP_LIQUIDATION_DISTANCE = 0.1;
const CONCENTRATION_SHARE = 0.8;

function perpRisks(extras: Pick<DataCoverageExtras, "perps"> | null): DataRiskFlag[] {
  return (extras?.perps.rows ?? []).flatMap((position): DataRiskFlag[] => {
    if (position.liquidationPrice === null || position.markPrice === null || position.markPrice <= 0) return [];
    const distance = Math.abs(position.markPrice - position.liquidationPrice) / position.markPrice;
    if (distance >= PERP_LIQUIDATION_DISTANCE) return [];
    return [{
      flag: "PERP_NEAR_LIQUIDATION",
      severity: distance < PERP_LIQUIDATION_DISTANCE / 2 ? "critical" : "warning",
      subject: `${position.venue}:${position.symbol}:${position.side}`,
      message: `${position.symbol} ${position.side} is ${(distance * 100).toFixed(1)}% from its liquidation price.`,
    }];
  });
}

export function riskFlags(portfolio: DataPortfolio, extras: Pick<DataCoverageExtras, "perps"> | null, history: Pick<HistoryRead, "coverage"> | null): DataRiskFlag[] {
  const flags: DataRiskFlag[] = [];
  for (const row of portfolio.health) {
    const subject = `${row.network}:${row.protocol}:${row.market}`;
    if (row.status === "critical" && row.healthFactor === null) flags.push({ flag: "LIQUIDATABLE", severity: "critical", subject, message: row.reason ?? "The account can be liquidated now." });
    else if (row.status === "critical" || row.status === "warning") {
      flags.push({ flag: "LOW_HEALTH", severity: row.status, subject, message: `Health factor ${row.healthFactor ?? "unknown"} on ${row.protocol}.` });
    }
  }
  flags.push(...perpRisks(extras));
  const top = portfolio.allocation.byAsset[0];
  if (top && portfolio.allocation.byAsset.length > 1 && top.share >= CONCENTRATION_SHARE) {
    flags.push({ flag: "CONCENTRATION", severity: "info", subject: top.key, message: `${top.label} is ${(top.share * 100).toFixed(0)}% of the priced value.` });
  }
  if (portfolio.totals.unpriced > 0) flags.push({ flag: "UNPRICED", severity: "info", subject: "portfolio", message: `${portfolio.totals.unpriced} holding(s) or position(s) have no price and are not in the totals.` });
  if (portfolio.failures.length > 0) flags.push({ flag: "UNREAD", severity: "warning", subject: "portfolio", message: `${portfolio.failures.length} account(s), venue(s) or market(s) could not be read.` });
  const gaps = history?.coverage.filter((entry) => entry.status !== "ok") ?? [];
  if (gaps.length > 0) flags.push({ flag: "HISTORY_INCOMPLETE", severity: "info", subject: "history", message: `${gaps.length} account(s) have no or partial history (${[...new Set(gaps.map((entry) => entry.status))].join(", ")}).` });
  return flags;
}

function activityOf(transactions: readonly DataTransaction[], complete: boolean, now: number): DataSummary["activity"] {
  const within = (days: number) => transactions.filter((tx) => now - Date.parse(tx.time) <= days * DAY_MS);
  const byKind: Partial<Record<DataTxKind, number>> = {};
  for (const tx of within(30)) byKind[tx.kind] = (byKind[tx.kind] ?? 0) + 1;
  return { last24h: within(1).length, last7d: within(7).length, last30d: within(30).length, byKind, complete };
}

export function buildSummary(input: {
  readonly portfolio: DataPortfolio;
  readonly extras: Pick<DataCoverageExtras, "perps"> | null;
  readonly history: HistoryRead | null;
  readonly pnl: DataPnl | null;
  readonly now?: number;
}): DataSummary {
  const { portfolio, extras, history, pnl } = input;
  const now = input.now ?? Date.now();
  const perps = extras?.perps.rows ?? [];
  const unrealizedPerps = perps.every((position) => position.unrealizedPnlUsd !== null)
    ? Math.round(perps.reduce((sum, position) => sum + (position.unrealizedPnlUsd ?? 0), 0) * 100) / 100
    : null;
  const sources = new Set<string>([
    ...portfolio.holdings.map((holding) => holding.value.source),
    ...portfolio.positions.map((position) => position.value.source),
    ...portfolio.health.map((row) => row.source),
    ...(extras && extras.perps.reason === null ? ["perps"] : []),
    ...(history?.coverage.flatMap((entry) => (entry.provider ? [entry.provider] : [])) ?? []),
    ...(history?.transactions.flatMap((tx) => tx.legs.flatMap((leg) => (leg.priceSource ? [leg.priceSource] : []))) ?? []),
    ...(pnl ? ["fifo"] : []),
    ...(portfolio.change24h.usd !== null ? ["snapshot"] : []),
  ]);
  return {
    wallets: portfolio.wallets,
    totals: {
      netUsd: portfolio.totals.net.usd,
      walletUsd: portfolio.totals.wallet.usd,
      positionsUsd: portfolio.totals.positions.usd,
      debtUsd: portfolio.totals.debt.usd,
      complete: portfolio.totals.complete,
    },
    change24h: portfolio.change24h,
    allocation: { byNetwork: portfolio.allocation.byNetwork.slice(0, 5), byAsset: portfolio.allocation.byAsset.slice(0, 5) },
    topPositions: [...portfolio.positions]
      .sort((a, b) => (b.value.usd ?? -1) - (a.value.usd ?? -1))
      .slice(0, 5)
      .map((position) => ({ name: position.name, network: position.network, kind: position.kind, usd: position.value.usd })),
    perps: { open: perps.length, unrealizedPnlUsd: perps.length === 0 ? 0 : unrealizedPerps },
    risks: riskFlags(portfolio, extras, history),
    activity: activityOf(history?.transactions ?? [], history?.complete ?? false, now),
    pnl: pnl
      ? {
          realizedUsd: pnl.totals.complete ? pnl.totals.realizedUsd : null,
          unrealizedUsd: pnl.totals.complete ? pnl.totals.unrealizedUsd : null,
          estimate: true,
          ...(pnl.totals.complete ? {} : { reason: "Part of the history or a price at the time is missing: see GET /v1/data/pnl for the known parts per asset." }),
        }
      : { realizedUsd: null, unrealizedUsd: null, estimate: true, reason: "The history could not be read." },
    sources: [...sources].sort(),
    asOf: new Date(now).toISOString(),
  };
}
