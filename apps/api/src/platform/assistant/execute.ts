/**
 * Runs an `AssistantQuery` against the data port and computes the answer in
 * code: the facts (every number with its source and reading time), a table
 * or chart when it helps, follow-up questions, and the deterministic answer
 * text, written only from the facts' printed values. Unknown or partial data
 * is said, never filled in.
 */
import {
  getProtocol,
  LENDING_HEALTH_THRESHOLDS,
  type AssistantChart,
  type AssistantFact,
  type AssistantFactUnit,
  type AssistantQuery,
  type AssistantStatus,
  type AssistantTable,
  type DataFailure,
  type DataHolding,
  type DataPosition,
  type DataSource,
  type DataWalletSet,
} from "@kletia/core";
import type { AssistantDataPort, AssistantPnlRow, AssistantTransaction } from "./dataPort.js";
import { addDecimals, dateOf, networkName, pct, signedUsd, usd } from "./format.js";

export interface ExecContext {
  readonly set: DataWalletSet;
  readonly port: AssistantDataPort;
  /** Replaces addresses in read failures ("EVM wallet 1 on Base"). */
  readonly labelOf: (subject: string) => string;
}

export interface ExecResult {
  readonly status: AssistantStatus;
  readonly text: string;
  readonly facts: readonly AssistantFact[];
  readonly table?: AssistantTable;
  readonly chart?: AssistantChart;
  readonly followUps: readonly string[];
  readonly gaps: readonly string[];
}

/** Symbols as printed: anything that is not a plain ticker (a hostile token name) is never repeated. */
export function safeSymbol(symbol: string): string {
  return /^[A-Za-z0-9.$_+-]{1,16}$/u.test(symbol) ? symbol : "an unlisted token";
}

class FactList {
  readonly list: AssistantFact[] = [];
  add(label: string, value: string, number: number | null, unit: AssistantFactUnit, source: DataSource | "chain", asOf: string | null): AssistantFact {
    const fact = { id: `f${this.list.length + 1}`, label, value, number, unit, source, asOf };
    this.list.push(fact);
    return fact;
  }
}

const protocolName = (id: string | null) => (id ? getProtocol(id)?.name ?? id : "");
const where = (query: AssistantQuery) => (query.filter.networks?.length ? ` on ${query.filter.networks.map(networkName).join(" and ")}` : "");
/** " in October 2026", " this week (since 19 Oct 2026)", "" for all time. */
const windowText = (query: AssistantQuery) => {
  const window = query.window;
  if (!window || window.name === "all") return "";
  return /^(?:today|yesterday|this week|last week)\b/u.test(window.label) ? ` ${window.label}` : ` in ${window.label}`;
};

function matchesSymbol(query: AssistantQuery, symbol: string): boolean {
  return !query.filter.assets?.length || query.filter.assets.some((asset) => asset.toLowerCase() === symbol.toLowerCase());
}

function matchesNetwork(query: AssistantQuery, network: string): boolean {
  return !query.filter.networks?.length || (query.filter.networks as readonly string[]).includes(network);
}

function failureGaps(failures: readonly DataFailure[], ctx: ExecContext): string[] {
  return failures.slice(0, 4).map((failure) => `${ctx.labelOf(failure.subject)} could not be read (${failure.code}).`);
}

function result(status: AssistantStatus, text: string, facts: FactList, extra: Partial<Omit<ExecResult, "status" | "text" | "facts">> = {}): ExecResult {
  return { status, text, facts: facts.list, followUps: extra.followUps ?? [], gaps: extra.gaps ?? [], ...(extra.table ? { table: extra.table } : {}), ...(extra.chart ? { chart: extra.chart } : {}) };
}

/* ------------------------------------------------------------ portfolio */

async function summary(ctx: ExecContext): Promise<ExecResult> {
  const read = await ctx.port.summary(ctx.set);
  const facts = new FactList();
  const gaps = failureGaps(read.failures, ctx);
  const net = read.totals.net;
  if (net.usd === null) return result("unknown", `The value of your wallets could not be read right now${net.reason ? `: ${net.reason}` : "."}`, facts, { gaps });
  const total = facts.add("Net value", usd(net.usd), net.usd, "usd", net.source, net.asOf);
  const wallet = read.totals.wallet.usd !== null ? facts.add("In wallets", usd(read.totals.wallet.usd), read.totals.wallet.usd, "usd", read.totals.wallet.source, read.totals.wallet.asOf) : null;
  const positions = read.totals.positions.usd ? facts.add("In positions", usd(read.totals.positions.usd), read.totals.positions.usd, "usd", read.totals.positions.source, read.totals.positions.asOf) : null;
  const debt = read.totals.debt.usd ? facts.add("Debt", usd(read.totals.debt.usd), read.totals.debt.usd, "usd", read.totals.debt.source, read.totals.debt.asOf) : null;
  const networks = new Set(read.holdings.map((holding) => holding.network)).size;
  const networkFact = facts.add("Networks with funds", String(networks), networks, "count", "adapter", read.asOf);
  const change = read.change24h.usd !== null ? facts.add("Change over 24 hours (estimate)", signedUsd(read.change24h.usd), read.change24h.usd, "usd", "snapshot", read.change24h.since) : null;
  const parts = [wallet ? `${wallet.value} in wallets` : null, positions ? `${positions.value} in positions` : null, debt ? `${debt.value} owed` : null].filter(Boolean);
  const text = [
    `Your wallets are worth ${total.value} across ${networkFact.value} network${networks === 1 ? "" : "s"}${parts.length ? `: ${parts.join(", ")}` : ""}.`,
    change ? `That is ${change.value} against a reading about 24 hours ago (an estimate).` : "",
    read.totals.complete ? "" : "Some balances could not be priced or read, so the total covers the known part only.",
  ].filter(Boolean).join(" ");
  const top = [...read.holdings].sort((a, b) => (b.value.usd ?? -1) - (a.value.usd ?? -1)).slice(0, 6);
  return result(read.totals.complete ? "answered" : "partial", text, facts, {
    gaps,
    table: holdingsTable(top),
    chart: { kind: "bar", label: "Value by asset", unit: "usd", points: read.allocation.byAsset.slice(0, 6).map((slice) => ({ label: safeSymbol(slice.label), value: slice.usd })) },
    followUps: ["What's my biggest position?", "How is my portfolio split by network?", "Which of my assets lost the most this month?"],
  });
}

function holdingsTable(holdings: readonly DataHolding[]): AssistantTable {
  return {
    columns: [{ key: "asset", label: "Asset" }, { key: "network", label: "Network" }, { key: "amount", label: "Amount", numeric: true }, { key: "value", label: "Value", numeric: true }],
    rows: holdings.map((holding) => ({ asset: safeSymbol(holding.symbol), network: networkName(holding.network), amount: holding.formatted, value: holding.value.usd === null ? "unpriced" : usd(holding.value.usd) })),
  };
}

/** Wallet holdings and venue positions (not debts, not staking tokens counted twice) as ranked rows. */
interface Ranked {
  readonly label: string;
  readonly symbol: string;
  readonly usd: number;
  readonly source: DataSource;
  readonly asOf: string | null;
}

async function holdings(query: AssistantQuery, ctx: ExecContext): Promise<ExecResult> {
  const read = await ctx.port.summary(ctx.set);
  const facts = new FactList();
  const gaps = failureGaps(read.failures, ctx);
  const partial = read.failures.length > 0 ? "partial" : "answered";
  const matched = read.holdings.filter((holding) => matchesSymbol(query, holding.symbol) && matchesNetwork(query, holding.network));
  if (query.aggregate === "top" || query.aggregate === "bottom") {
    const ranked: Ranked[] = [
      ...matched.filter((holding) => holding.value.usd !== null).map((holding) => ({ label: `${safeSymbol(holding.symbol)} on ${networkName(holding.network)}`, symbol: holding.symbol, usd: holding.value.usd as number, source: holding.value.source, asOf: holding.value.asOf })),
      ...read.positions
        .filter((position) => position.kind !== "borrow" && !position.inWallet && position.value.usd !== null && matchesSymbol(query, position.symbol) && matchesNetwork(query, position.network))
        .map((position) => ({ label: `${position.name} (${protocolName(position.protocol)} on ${networkName(position.network)})`, symbol: position.symbol, usd: position.value.usd as number, source: position.value.source, asOf: position.value.asOf })),
    ].sort((a, b) => (query.aggregate === "top" ? b.usd - a.usd : a.usd - b.usd));
    if (ranked.length === 0) return result(read.failures.length ? "unknown" : "answered", `No priced holdings or positions were found${where(query)}.`, facts, { gaps });
    const picked = ranked.slice(0, query.limit ?? 1);
    const shown = picked.map((row) => facts.add(row.label, usd(row.usd), row.usd, "usd", row.source, row.asOf));
    const word = query.aggregate === "top" ? "biggest" : "smallest";
    const text = shown.length === 1
      ? `Your ${word} position is ${shown[0]!.label}, worth ${shown[0]!.value}.`
      : `Your ${word} positions: ${shown.map((fact) => `${fact.label} (${fact.value})`).join(", ")}.`;
    return result(partial, text, facts, { gaps, followUps: ["Show my holdings", "How is my portfolio split by asset?"] });
  }
  if (query.aggregate === "total" && query.filter.assets?.length) {
    const lines: string[] = [];
    for (const symbol of query.filter.assets) {
      const rows = matched.filter((holding) => holding.symbol.toLowerCase() === symbol.toLowerCase());
      if (rows.length === 0) {
        const none = facts.add(`${safeSymbol(symbol)} held${where(query)}`, `0 ${safeSymbol(symbol)}`, 0, "amount", "adapter", read.asOf);
        lines.push(`You hold no ${safeSymbol(symbol)}${where(query)} (${none.value}).`);
        continue;
      }
      const amount = facts.add(`${safeSymbol(rows[0]!.symbol)} held${where(query)}`, `${addDecimals(rows.map((row) => row.formatted))} ${safeSymbol(rows[0]!.symbol)}`, Number(addDecimals(rows.map((row) => row.formatted))), "amount", "adapter", read.asOf);
      const priced = rows.every((row) => row.value.usd !== null);
      const value = priced ? facts.add(`${safeSymbol(rows[0]!.symbol)} value`, usd(rows.reduce((sum, row) => sum + (row.value.usd as number), 0)), rows.reduce((sum, row) => sum + (row.value.usd as number), 0), "usd", rows[0]!.value.source, rows[0]!.value.asOf) : null;
      const networks = [...new Set(rows.map((row) => networkName(row.network)))];
      const on = networks.length > 1 || !query.filter.networks?.length ? facts.add(`${safeSymbol(rows[0]!.symbol)} held on`, networks.join(", "), null, "text", "adapter", read.asOf) : null;
      lines.push(`You hold ${amount.value}${value ? ` worth ${value.value}` : " (not priced)"}${on ? ` on ${on.value}` : ""}.`);
    }
    return result(partial, lines.join(" "), facts, { gaps, table: holdingsTable(matched), followUps: ["What's my biggest position?", "Show my portfolio"] });
  }
  if (matched.length === 0) return result(read.failures.length ? "unknown" : "answered", `No holdings were found${where(query)}.`, facts, { gaps });
  const priced = matched.filter((holding) => holding.value.usd !== null);
  const total = facts.add(`Wallet value${where(query)}`, usd(priced.reduce((sum, holding) => sum + (holding.value.usd as number), 0)), priced.reduce((sum, holding) => sum + (holding.value.usd as number), 0), "usd", priced[0]?.value.source ?? "unpriced", priced[0]?.value.asOf ?? null);
  const count = facts.add("Assets held", String(matched.length), matched.length, "count", "adapter", read.asOf);
  const sorted = [...matched].sort((a, b) => (b.value.usd ?? -1) - (a.value.usd ?? -1));
  return result(partial, `You hold ${count.value} asset${matched.length === 1 ? "" : "s"}${where(query)} worth ${total.value}${priced.length < matched.length ? " (some are not priced)" : ""}.`, facts, {
    gaps,
    table: holdingsTable(sorted.slice(0, 12)),
    followUps: ["What's my biggest position?", "Show my positions"],
  });
}

function positionMatches(query: AssistantQuery, position: DataPosition): boolean {
  return matchesSymbol(query, position.symbol) && matchesNetwork(query, position.network) && (!query.filter.protocols?.length || (position.protocol !== null && query.filter.protocols.includes(position.protocol)));
}

async function positions(query: AssistantQuery, ctx: ExecContext): Promise<ExecResult> {
  const read = await ctx.port.positions(ctx.set);
  const facts = new FactList();
  const gaps = failureGaps(read.failures, ctx);
  const rows = read.positions.filter((position) => positionMatches(query, position));
  const venue = query.filter.protocols?.length ? ` in ${query.filter.protocols.map(protocolName).join(" or ")}` : "";
  if (rows.length === 0) return result(read.failures.length ? "partial" : "answered", `No open positions were found${venue}${where(query)}.`, facts, { gaps });
  const count = facts.add(`Open positions${venue}${where(query)}`, String(rows.length), rows.length, "count", "adapter", read.asOf);
  const shown: AssistantFact[] = [];
  for (const position of rows.slice(0, 12)) {
    const label = `${position.kind === "borrow" ? "Debt: " : ""}${position.name} (${protocolName(position.protocol)} on ${networkName(position.network)})`;
    shown.push(facts.add(label, position.value.usd === null ? "not priced" : usd(position.value.usd), position.value.usd, position.value.usd === null ? "text" : "usd", position.value.source, position.value.asOf));
  }
  return result(read.failures.length ? "partial" : "answered", `You have ${count.value} open position${rows.length === 1 ? "" : "s"}${venue}${where(query)}: ${shown.map((fact) => `${fact.label} ${fact.value}`).join("; ")}.`, facts, {
    gaps,
    table: {
      columns: [{ key: "position", label: "Position" }, { key: "kind", label: "Kind" }, { key: "amount", label: "Amount", numeric: true }, { key: "value", label: "Value", numeric: true }, { key: "apy", label: "APY", numeric: true }],
      rows: rows.slice(0, 12).map((position) => ({
        position: `${position.name} (${networkName(position.network)})`,
        kind: position.kind,
        amount: position.amount ?? "",
        value: position.value.usd === null ? "not priced" : usd(position.value.usd),
        apy: position.apy === null ? "" : pct(position.apy),
      })),
    },
    followUps: ["How is my loan doing?", "What did I earn from staking?"],
  });
}

async function health(query: AssistantQuery, ctx: ExecContext): Promise<ExecResult> {
  const read = await ctx.port.positions(ctx.set);
  const facts = new FactList();
  const gaps = failureGaps(read.failures, ctx);
  const venue = query.filter.protocols?.length ? `${query.filter.protocols.map(protocolName).join(" or ")} ` : "";
  const readings = read.health.filter((entry) => matchesNetwork(query, entry.network) && (!query.filter.protocols?.length || query.filter.protocols.includes(entry.protocol)));
  const loans = readings.filter((entry) => entry.status !== "no-debt");
  if (loans.length === 0) {
    return result(read.failures.length ? "partial" : "answered", `No open ${venue}loan was found${where(query)} in your wallets.`, facts, { gaps, followUps: ["Show my positions"] });
  }
  const lines: string[] = [];
  for (const loan of loans.slice(0, 6)) {
    const place = `${protocolName(loan.protocol)} on ${networkName(loan.network)}`;
    const debt = read.positions.find((position) => position.kind === "borrow" && position.network === loan.network && position.protocol === loan.protocol);
    const owed = debt?.value.usd != null ? facts.add(`Debt (${place})`, usd(debt.value.usd), debt.value.usd, "usd", debt.value.source, debt.value.asOf) : null;
    if (loan.healthFactor === null) {
      lines.push(`The health of your ${protocolName(loan.protocol)} loan on ${networkName(loan.network)} could not be read${loan.reason ? ` (${loan.reason})` : ""}${owed ? `; you owe ${owed.value}` : ""}.`);
      continue;
    }
    const factor = facts.add(`Health factor (${place})`, loan.healthFactor.toFixed(2), Number(loan.healthFactor.toFixed(2)), "ratio", loan.source, loan.asOf);
    const state = loan.status === "critical" ? "critical: close to liquidation" : loan.status === "warning" ? `below ${LENDING_HEALTH_THRESHOLDS.warning}, worth watching` : "healthy";
    lines.push(`Your ${protocolName(loan.protocol)} loan on ${networkName(loan.network)} has a health factor of ${factor.value} (${state}; it is liquidated below 1)${owed ? ` and you owe ${owed.value}` : ""}.`);
  }
  const unknown = loans.some((loan) => loan.healthFactor === null);
  return result(unknown || read.failures.length ? "partial" : "answered", lines.join(" "), facts, { gaps, followUps: ["Show my positions", "What's my net worth?"] });
}

/* ------------------------------------------------------------ activity */

function txMatches(query: AssistantQuery, tx: AssistantTransaction): boolean {
  const { kinds, assets, networks, destinations, protocols } = query.filter;
  const symbols = [...tx.sent, ...tx.received].map((legs) => legs.symbol.toLowerCase());
  return (!kinds?.length || kinds.includes(tx.kind))
    && (!assets?.length || assets.some((asset) => symbols.includes(asset.toLowerCase())))
    && (!networks?.length || networks.includes(tx.network))
    && (!destinations?.length || (tx.destination !== null && destinations.includes(tx.destination)))
    && (!protocols?.length || (tx.protocol !== null && protocols.includes(tx.protocol)));
}

const KIND_NOUN: Readonly<Record<string, string>> = {
  swap: "swap", bridge: "bridge", transfer: "transfer", deposit: "deposit", withdraw: "withdrawal", stake: "stake", unstake: "unstake", borrow: "borrow", repay: "repayment", claim: "claim", other: "transaction",
};

function txNoun(query: AssistantQuery, count: number): string {
  const kinds = query.filter.kinds ?? [];
  const noun = kinds.length === 1 ? (KIND_NOUN[kinds[0] as string] as string) : "transaction";
  const plural = count === 1 ? noun : `${noun}${noun.endsWith("h") ? "es" : "s"}`;
  const to = query.filter.destinations?.length ? ` to ${query.filter.destinations.map(networkName).join(" or ")}` : "";
  return `${plural}${to}${where(query)}`;
}

function legsText(legs: AssistantTransaction["sent"]): string {
  return legs.map((leg) => `${leg.amount} ${safeSymbol(leg.symbol)}`).join(" + ");
}

function txTable(transactions: readonly AssistantTransaction[]): AssistantTable {
  return {
    columns: [{ key: "date", label: "Date" }, { key: "kind", label: "Kind" }, { key: "network", label: "Network" }, { key: "sent", label: "Sent", numeric: true }, { key: "received", label: "Received", numeric: true }, { key: "fee", label: "Fee", numeric: true }],
    rows: transactions.slice(0, 12).map((tx) => ({
      date: dateOf(tx.at),
      kind: tx.kind,
      network: tx.destination ? `${networkName(tx.network)} → ${networkName(tx.destination)}` : networkName(tx.network),
      sent: legsText(tx.sent),
      received: legsText(tx.received),
      fee: tx.fee.usd === null ? "" : usd(tx.fee.usd),
    })),
  };
}

async function readTransactions(query: AssistantQuery, ctx: ExecContext) {
  const page = await ctx.port.transactions(ctx.set, { from: query.window?.from ?? null, ...(query.window ? { to: query.window.to } : {}) });
  const matched = page.transactions.filter((tx) => tx.status !== "failed" && txMatches(query, tx));
  return { page, matched };
}

async function transactions(query: AssistantQuery, ctx: ExecContext): Promise<ExecResult> {
  const { page, matched } = await readTransactions(query, ctx);
  const facts = new FactList();
  const gaps = page.reason ? [page.reason] : [];
  if (page.coverage === "none") return result("unknown", "Your transaction history is not available yet, so this cannot be answered.", facts, { gaps, followUps: ["Show my portfolio"] });
  const status: AssistantStatus = page.complete ? "answered" : "partial";
  const period = windowText(query);
  const count = facts.add(`${txNoun(query, 2)}${period}`.replace(/^./u, (c) => c.toUpperCase()), String(matched.length), matched.length, "count", page.coverage === "chain" ? "chain" : "kletia", page.asOf);
  const caveat = page.complete ? "" : ` This counts only the history Kletia can read: ${page.reason ?? "it may be incomplete."}`;
  if (matched.length === 0) {
    const text = query.aggregate === "exists" ? `No: no ${txNoun(query, 2)} were found${period}.${caveat}` : `No ${txNoun(query, 2)} were found${period}.${caveat}`;
    return result(status, text, facts, { gaps, followUps: ["Show my transactions this month", "Show my portfolio"] });
  }
  const latest = matched[0] as AssistantTransaction;
  const latestDate = facts.add("Most recent", dateOf(latest.at), null, "date", latest.source, latest.at);
  const table = txTable(matched);
  if (query.aggregate === "total") {
    const priced = matched.filter((tx) => tx.sent.every((leg) => leg.usd !== null));
    const sum = priced.reduce((total, tx) => total + tx.sent.reduce((part, leg) => part + (leg.usd as number), 0), 0);
    const value = facts.add(`Value sent in ${txNoun(query, 2)}${period}`, usd(sum), sum, "usd", latest.source, page.asOf);
    const unpriced = matched.length - priced.length;
    return result(unpriced > 0 ? "partial" : status, `You sent ${value.value} in ${count.value} ${txNoun(query, matched.length)}${period}${unpriced ? ` (${unpriced} without a price are not counted)` : ""}.${caveat}`, facts, { gaps, table });
  }
  if (query.aggregate === "top") {
    const sent = facts.add("Sent", legsText(latest.sent) || "nothing", null, "text", latest.source, latest.at);
    const received = facts.add("Received", legsText(latest.received) || "nothing", null, "text", latest.source, latest.at);
    return result(status, `Your most recent ${txNoun(query, 1)} was on ${latestDate.value}: ${sent.value} sent, ${received.value} received.${caveat}`, facts, { gaps, table: txTable([latest]) });
  }
  const lead = query.aggregate === "exists" ? "Yes: " : "";
  return result(status, `${lead}${count.value} ${txNoun(query, matched.length)}${period}, the most recent on ${latestDate.value}.${caveat}`, facts, {
    gaps,
    table,
    followUps: ["How much did I spend on fees this month?", "Show my portfolio"],
  });
}

async function fees(query: AssistantQuery, ctx: ExecContext): Promise<ExecResult> {
  const { page, matched } = await readTransactions(query, ctx);
  const facts = new FactList();
  const gaps = page.reason ? [page.reason] : [];
  if (page.coverage === "none") return result("unknown", "Your transaction history is not available yet, so the fees you paid cannot be added up.", facts, { gaps });
  const known = matched.filter((tx) => tx.fee.usd !== null);
  const sum = known.reduce((total, tx) => total + (tx.fee.usd as number), 0);
  const period = windowText(query);
  const kinds = query.filter.kinds?.length ? ` on ${txNoun(query, 2)}` : where(query);
  const paid = facts.add(`Fees paid${kinds}${period}`, usd(sum), sum, "usd", known[0]?.fee.source ?? (page.coverage === "chain" ? "chain" : "kletia"), page.asOf);
  const count = facts.add("Transactions counted", String(known.length), known.length, "count", page.coverage === "chain" ? "chain" : "kletia", page.asOf);
  const missing = matched.length - known.length;
  if (missing > 0) gaps.push(`${missing} transaction${missing === 1 ? " has" : "s have"} no fee reading and ${missing === 1 ? "is" : "are"} not counted.`);
  const caveat = page.complete ? "" : ` Only the history Kletia can read is counted: ${page.reason ?? "it may be incomplete."}`;
  return result(missing > 0 || !page.complete ? "partial" : "answered", `You paid ${paid.value} in fees${kinds}${period}, over ${count.value} transaction${known.length === 1 ? "" : "s"}.${caveat}`, facts, {
    gaps,
    table: txTable(known),
    followUps: ["Show my transactions this month", "Which of my assets lost the most this month?"],
  });
}

/* ------------------------------------------------------------ results */

async function pnl(query: AssistantQuery, ctx: ExecContext): Promise<ExecResult> {
  const read = await ctx.port.pnl(ctx.set, { from: query.window?.from ?? null, ...(query.window ? { to: query.window.to } : {}), by: "asset" });
  const facts = new FactList();
  const gaps = read.reason ? [read.reason] : [];
  const period = windowText(query);
  if (query.aggregate === "total" || !query.by) {
    if (read.total.usd === null) return result("unknown", `How your portfolio changed${period} is not known yet${read.total.reason ? `: ${read.total.reason}` : "."}`, facts, { gaps });
    const change = facts.add(`Value change${period} (estimate)`, signedUsd(read.total.usd), read.total.usd, "usd", read.total.source, read.total.asOf);
    return result("answered", `Your portfolio changed by ${change.value}${period}. This is an estimate from Kletia's readings and prices, not realised profit or loss.`, facts, { gaps, followUps: ["Which of my assets lost the most this month?"] });
  }
  const rows = read.rows.filter((row) => row.change.usd !== null && matchesSymbol(query, row.symbol ?? "") && (row.network === null || matchesNetwork(query, row.network)));
  if (rows.length === 0) return result("unknown", `Which assets gained or lost${period} is not known yet${read.reason ? `: ${read.reason}` : "."}`, facts, { gaps });
  const sorted = [...rows].sort((a, b) => (query.aggregate === "top" ? (b.change.usd as number) - (a.change.usd as number) : (a.change.usd as number) - (b.change.usd as number)));
  const picked = query.aggregate === "list" ? sorted.slice(0, 12) : sorted.slice(0, query.limit ?? 1);
  const shown = picked.map((row) => [row, facts.add(`${pnlLabel(row)} change${period}`, signedUsd(row.change.usd as number), row.change.usd, "usd", row.change.source, row.change.asOf)] as const);
  const pctFacts = picked.filter((row) => row.pct !== null).map((row) => facts.add(`${pnlLabel(row)} change in percent`, pct(row.pct as number, true), row.pct, "fraction", row.change.source, row.change.asOf));
  const table: AssistantTable = {
    columns: [{ key: "asset", label: "Asset" }, { key: "change", label: "Change", numeric: true }, { key: "pct", label: "%", numeric: true }],
    rows: sorted.slice(0, 12).map((row) => ({ asset: pnlLabel(row), change: signedUsd(row.change.usd as number), pct: row.pct === null ? "" : pct(row.pct, true) })),
  };
  const chart: AssistantChart = { kind: "bar", label: `Change by asset${period}`, unit: "usd", points: sorted.slice(0, 8).map((row) => ({ label: pnlLabel(row), value: row.change.usd as number })) };
  const [first] = shown;
  const text = query.aggregate === "list"
    ? `Change by asset${period}: ${shown.map(([row, fact]) => `${pnlLabel(row)} ${fact.value}`).join(", ")}. These are estimates, not realised profit or loss.`
    : `${query.aggregate === "bottom" ? (((first![0].change.usd as number) < 0) ? "Your biggest loser" : "Your weakest asset") : "Your best performer"}${period} was ${pnlLabel(first![0])}: ${first![1].value}${pctFacts[0] ? ` (${pctFacts[0].value})` : ""}. This is an estimate, not realised profit or loss.`;
  return result(read.reason ? "partial" : "answered", text, facts, { gaps, table, chart, followUps: query.aggregate === "bottom" ? ["Sell my worst performer", "Show my portfolio"] : ["Show my portfolio"] });
}

function pnlLabel(row: AssistantPnlRow): string {
  const symbol = row.symbol ? safeSymbol(row.symbol) : safeSymbol(row.label);
  return row.network ? `${symbol} on ${networkName(row.network)}` : symbol;
}

const EARN_KIND: Readonly<Record<string, readonly string[]>> = { stake: ["staking"], deposit: ["supply", "vault"] };

async function earnings(query: AssistantQuery, ctx: ExecContext): Promise<ExecResult> {
  const read = await ctx.port.pnl(ctx.set, { from: query.window?.from ?? null, ...(query.window ? { to: query.window.to } : {}), by: "position" });
  const facts = new FactList();
  const gaps = read.reason ? [read.reason] : [];
  const kinds = (query.filter.kinds ?? []).flatMap((kind) => EARN_KIND[kind] ?? []);
  const rows = read.rows.filter((row) => row.earned !== null
    && (kinds.length === 0 || (row.kind !== null && kinds.includes(row.kind)))
    && (!query.filter.protocols?.length || (row.protocol !== null && query.filter.protocols.includes(row.protocol)))
    && matchesSymbol(query, row.symbol ?? "") && (row.network === null || matchesNetwork(query, row.network)));
  const period = windowText(query);
  const what = kinds.includes("staking") ? "staking" : kinds.length ? "lending and vaults" : query.filter.protocols?.length ? query.filter.protocols.map(protocolName).join(" and ") : "your positions";
  const known = rows.filter((row) => row.earned?.usd !== null);
  if (known.length === 0) return result("unknown", `What you earned from ${what}${period} is not known yet${read.reason ? `: ${read.reason}` : "."}`, facts, { gaps, followUps: ["Show my positions"] });
  const sum = known.reduce((total, row) => total + (row.earned?.usd as number), 0);
  const total = facts.add(`Earned from ${what}${period}`, usd(sum), sum, "usd", known[0]!.earned!.source, known[0]!.earned!.asOf);
  for (const row of known.slice(0, 6)) facts.add(`Earned: ${pnlLabel(row)}${row.protocol ? ` (${protocolName(row.protocol)})` : ""}`, usd(row.earned!.usd as number), row.earned!.usd, "usd", row.earned!.source, row.earned!.asOf);
  const missing = rows.length - known.length;
  return result(missing > 0 || read.reason ? "partial" : "answered", `You earned ${total.value} from ${what}${period}.`, facts, {
    gaps,
    table: { columns: [{ key: "position", label: "Position" }, { key: "earned", label: "Earned", numeric: true }], rows: known.slice(0, 12).map((row) => ({ position: pnlLabel(row), earned: usd(row.earned!.usd as number) })) },
    followUps: ["Show my positions", "Move my idle stables to the best yield"],
  });
}

async function allocation(query: AssistantQuery, ctx: ExecContext): Promise<ExecResult> {
  const read = await ctx.port.summary(ctx.set);
  const facts = new FactList();
  const by = query.by ?? "asset";
  const slices = (by === "network" ? read.allocation.byNetwork : by === "protocol" ? read.allocation.byProtocol : read.allocation.byAsset).slice(0, 8);
  if (slices.length === 0) return result(read.failures.length ? "unknown" : "answered", "Nothing priced was found in your wallets to split.", facts, { gaps: failureGaps(read.failures, ctx) });
  const label = (key: string, text: string) => (by === "asset" ? safeSymbol(text) : by === "network" ? text : protocolName(key) || text);
  const shown = slices.slice(0, 5).map((slice) => facts.add(`Share: ${label(slice.key, slice.label)}`, pct(slice.share), slice.share, "fraction", "adapter", read.asOf));
  return result(read.totals.complete ? "answered" : "partial", `By ${by}: ${shown.map((fact) => `${fact.label.replace("Share: ", "")} ${fact.value}`).join(", ")}.`, facts, {
    gaps: failureGaps(read.failures, ctx),
    chart: { kind: "bar", label: `Share by ${by}`, unit: "fraction", points: slices.map((slice) => ({ label: label(slice.key, slice.label), value: slice.share })) },
    table: { columns: [{ key: "slice", label: by === "asset" ? "Asset" : by === "network" ? "Network" : "Protocol" }, { key: "value", label: "Value", numeric: true }, { key: "share", label: "Share", numeric: true }], rows: slices.map((slice) => ({ slice: label(slice.key, slice.label), value: usd(slice.usd), share: pct(slice.share) })) },
    followUps: [by === "network" ? "How is my portfolio split by asset?" : "How is my portfolio split by network?", "Rebalance my portfolio to 60/40 ETH/USDC"],
  });
}

/* ------------------------------------------------------------ market */

async function prices(query: AssistantQuery, ctx: ExecContext): Promise<ExecResult> {
  const symbols = query.filter.assets ?? [];
  const read = await ctx.port.prices(symbols, ctx.set.lane);
  const facts = new FactList();
  const lines: string[] = [];
  for (const symbol of symbols) {
    const row = read.prices.find((entry) => entry.symbol.toLowerCase() === symbol.toLowerCase() && entry.value.usd !== null);
    if (!row) {
      lines.push(`No price for ${safeSymbol(symbol)} could be read.`);
      continue;
    }
    const fact = facts.add(`${safeSymbol(row.symbol)} price`, usd(row.value.usd as number), row.value.usd, "usd", row.value.source, row.value.asOf);
    lines.push(`${safeSymbol(row.symbol)} is ${fact.value} (${row.value.source}).`);
  }
  return result(facts.list.length === symbols.length ? "answered" : facts.list.length ? "partial" : "unknown", lines.join(" "), facts, { followUps: ["How much ETH do I have?"] });
}

async function yields(query: AssistantQuery, ctx: ExecContext): Promise<ExecResult> {
  const asset = query.filter.assets?.[0];
  const network = query.filter.networks?.[0];
  const read = await ctx.port.yields({ lane: ctx.set.lane, ...(asset ? { asset } : {}), ...(network ? { network } : {}) });
  const facts = new FactList();
  const rows = read.yields.filter((row) => row.apy !== null && row.executable).sort((a, b) => (b.apy as number) - (a.apy as number)).slice(0, Math.max(1, query.limit ?? 3));
  if (rows.length === 0) return result("unknown", `No ${asset ? `${safeSymbol(asset)} ` : ""}rate could be read right now${where(query)}.`, facts);
  const shown = rows.map((row) => facts.add(`${row.name} on ${networkName(row.network)} (supply APY)`, pct(row.apy as number), row.apy, "fraction", row.source, row.asOf));
  const text = `The best ${asset ? `${safeSymbol(asset)} ` : ""}rate${shown.length > 1 ? "s" : ""} Kletia reads${where(query)}: ${shown.map((fact) => `${fact.label.replace(" (supply APY)", "")} at ${fact.value}`).join(", ")}. Rates change; past rates do not promise future ones.`;
  return result("answered", text, facts, { followUps: ["Move my idle stables to the best yield", "What did I earn from staking?"] });
}

/** Runs a query. */
export function executeQuery(query: AssistantQuery, ctx: ExecContext): Promise<ExecResult> {
  switch (query.subject) {
    case "summary":
      return summary(ctx);
    case "holdings":
      return holdings(query, ctx);
    case "positions":
      return positions(query, ctx);
    case "health":
      return health(query, ctx);
    case "transactions":
      return transactions(query, ctx);
    case "fees":
      return fees(query, ctx);
    case "pnl":
      return pnl(query, ctx);
    case "earnings":
      return earnings(query, ctx);
    case "allocation":
      return allocation(query, ctx);
    case "prices":
      return prices(query, ctx);
    case "yields":
      return yields(query, ctx);
  }
}
