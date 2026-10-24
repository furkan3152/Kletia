/**
 * Runs an `AssistantQuery` against the data port and computes the answer in
 * code: the facts (every number with its source and reading time), a table
 * or chart when it helps, follow-up questions, and the deterministic answer
 * text, written only from the facts' printed values. Unknown or partial data
 * is said, never filled in.
 */
import {
  CHAINS,
  getProtocol,
  LENDING_HEALTH_THRESHOLDS,
  type AssistantChart,
  type AssistantFact,
  type AssistantFactUnit,
  type AssistantLink,
  type AssistantQuery,
  type AssistantStatus,
  type AssistantTable,
  type DataFailure,
  type DataHolding,
  type DataPosition,
  type DataSource,
  type DataWalletSet,
} from "@kletia/core";
import { coverageGaps, type AssistantDataPort, type AssistantPnl, type AssistantPnlRow, type AssistantTransaction, type AssistantTransactions } from "./dataPort.js";
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
  add(label: string, value: string, number: number | null, unit: AssistantFactUnit, source: DataSource | "chain", asOf: string | null, link?: AssistantLink): AssistantFact {
    const fact = { id: `f${this.list.length + 1}`, label, value, number, unit, source, asOf, ...(link ? { link } : {}) };
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

const DIRECTION: Readonly<Record<"out" | "in", readonly string[]>> = { out: ["send", "bridge-out"], in: ["receive", "bridge-in"] };

function txMatches(query: AssistantQuery, tx: AssistantTransaction): boolean {
  const { kinds, assets, networks, destinations, protocols, direction } = query.filter;
  const symbols = [...tx.sent, ...tx.received].map((legs) => legs.symbol.toLowerCase());
  return (!kinds?.length || kinds.includes(tx.kind))
    && (!assets?.length || assets.some((asset) => symbols.includes(asset.toLowerCase())))
    && (!networks?.length || networks.includes(tx.network))
    && (!destinations?.length || (tx.destination !== null && destinations.includes(tx.destination)))
    && (!protocols?.length || (tx.protocol !== null && protocols.includes(tx.protocol)))
    && (!direction || (tx.kind !== "transfer" && tx.kind !== "bridge") || DIRECTION[direction].includes(tx.detail));
}

const KIND_NOUN: Readonly<Record<string, string>> = {
  swap: "swap", bridge: "bridge", transfer: "transfer", deposit: "deposit", withdraw: "withdrawal", stake: "stake", unstake: "unstake", borrow: "borrow", repay: "repayment", claim: "claim",
  perp: "perps transaction", order: "order transaction", prediction: "prediction-market transaction", approve: "approval", failed: "failed transaction", other: "transaction",
};

function txNoun(query: AssistantQuery, count: number): string {
  const kinds = query.filter.kinds ?? [];
  const noun = kinds.length === 1 ? (KIND_NOUN[kinds[0] as string] as string) : "transaction";
  const plural = count === 1 ? noun : `${noun}${noun.endsWith("h") ? "es" : "s"}`;
  const to = query.filter.destinations?.length ? ` to ${query.filter.destinations.map(networkName).join(" or ")}` : "";
  const venue = query.filter.protocols?.length ? ` on ${query.filter.protocols.map(protocolName).join(" or ")}` : "";
  return `${plural}${to}${venue}${where(query)}`;
}

function legsText(legs: AssistantTransaction["sent"]): string {
  return legs.map((leg) => `${leg.amount ?? "an unknown amount of"} ${safeSymbol(leg.symbol)}`).join(" + ");
}

const txLink = (tx: AssistantTransaction): AssistantLink => ({ kind: "transaction", id: tx.id });

function txTable(transactions: readonly AssistantTransaction[]): AssistantTable {
  const rows = transactions.slice(0, 12);
  return {
    columns: [{ key: "date", label: "Date" }, { key: "kind", label: "Kind" }, { key: "network", label: "Network" }, { key: "sent", label: "Sent", numeric: true }, { key: "received", label: "Received", numeric: true }, { key: "fee", label: "Fee", numeric: true }],
    rows: rows.map((tx) => ({
      date: dateOf(tx.at),
      kind: tx.status === "failed" ? "failed" : tx.detail,
      network: networkName(tx.network),
      sent: legsText(tx.sent),
      received: legsText(tx.received),
      fee: tx.fee?.usd == null ? "" : usd(tx.fee.usd),
    })),
    links: rows.map(txLink),
  };
}

/** Gap lines of a history read: unread accounts (with the variables to set), a cut window, bridges whose destination the chain does not show. */
function historyGaps(page: AssistantTransactions, query: AssistantQuery, ctx: ExecContext): string[] {
  const gaps = coverageGaps(page.unread, ctx.labelOf);
  if (page.truncated) gaps.push("Only the newest transactions of this period were read; older ones are not counted.");
  const destinations = query.filter.destinations ?? [];
  if (destinations.length > 0) {
    // The chain shows where a bridge arrived, not where a departure went: departures without an arrival in these wallets may have gone there too.
    const departures = page.transactions.filter((tx) => tx.detail === "bridge-out" && txMatches({ ...query, filter: { ...query.filter, destinations: [] } }, tx)).length;
    const arrivals = page.transactions.filter((tx) => tx.detail === "bridge-in").length;
    const unmatched = departures - arrivals;
    if (unmatched > 0) gaps.push(`${unmatched} bridge departure${unmatched === 1 ? "" : "s"} in this period ${unmatched === 1 ? "has" : "have"} no arrival in your wallets, and the chain does not show where ${unmatched === 1 ? "it" : "they"} went; only arrivals are counted.`);
    for (const network of destinations) {
      const vm = CHAINS[network].vm === "svm" ? ctx.set.solana : ctx.set.evm;
      if (vm.length === 0) gaps.push(`No ${CHAINS[network].vm === "svm" ? "Solana" : "EVM"} wallet is in this set, so arrivals on ${networkName(network)} cannot be seen.`);
    }
  }
  return gaps;
}

async function readTransactions(query: AssistantQuery, ctx: ExecContext) {
  const page = await ctx.port.transactions(ctx.set, { from: query.window?.from ?? null, ...(query.window ? { to: query.window.to } : {}) });
  const failed = query.filter.kinds?.includes("failed") ?? false;
  const matched = page.transactions.filter((tx) => (failed || tx.status !== "failed") && txMatches(query, tx));
  return { page, matched, gaps: historyGaps(page, query, ctx) };
}

const complete = (page: AssistantTransactions, gaps: readonly string[]) => page.complete && gaps.length === 0;

async function transactions(query: AssistantQuery, ctx: ExecContext): Promise<ExecResult> {
  const { page, matched, gaps } = await readTransactions(query, ctx);
  const facts = new FactList();
  if (page.coverage === "none") return result("unknown", `Your transaction history is not available, so this cannot be answered: ${page.reason ?? "it could not be read."}`, facts, { gaps, followUps: ["Show my portfolio"] });
  const whole = complete(page, gaps);
  const status: AssistantStatus = whole ? "answered" : "partial";
  const period = windowText(query);
  const count = facts.add(`${txNoun(query, 2)}${period}`.replace(/^./u, (c) => c.toUpperCase()), String(matched.length), matched.length, "count", "chain", page.asOf);
  const caveat = whole ? "" : " Some history was not read (see the gaps), so there may be more.";
  if (matched.length === 0) {
    const text = query.aggregate === "exists" ? `No: no ${txNoun(query, 2)} were found${period}.${caveat}` : `No ${txNoun(query, 2)} were found${period}.${caveat}`;
    return result(status, text, facts, { gaps, followUps: ["Show my transactions this month", "Show my portfolio"] });
  }
  const latest = matched[0] as AssistantTransaction;
  const latestDate = facts.add("Most recent", dateOf(latest.at), null, "date", latest.source, latest.at, txLink(latest));
  const table = txTable(matched);
  if (query.aggregate === "total") {
    // Arrivals carry what was delivered; everything else what the wallet sent.
    const arrivals = (query.filter.destinations?.length ?? 0) > 0;
    const legs = (tx: AssistantTransaction) => (arrivals && tx.detail === "bridge-in" ? tx.received : tx.sent);
    const priced = matched.filter((tx) => legs(tx).length > 0 && legs(tx).every((leg) => leg.usd !== null));
    const total = Math.round(priced.reduce((sum, tx) => sum + legs(tx).reduce((part, leg) => part + (leg.usd as number), 0), 0) * 100) / 100;
    const verb = arrivals ? "Value delivered" : "Value sent";
    const value = facts.add(`${verb} in ${txNoun(query, 2)}${period}`, usd(total), total, "usd", "chain", page.asOf);
    const unpriced = matched.length - priced.length;
    return result(unpriced > 0 ? "partial" : status, `${arrivals ? "You moved" : "You sent"} ${value.value} in ${count.value} ${txNoun(query, matched.length)}${period}${unpriced ? ` (${unpriced} without a price at the time are not counted)` : ""}.${caveat}`, facts, { gaps, table });
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
  const { page, gaps } = await readTransactions(query, ctx);
  const facts = new FactList();
  if (page.coverage === "none") return result("unknown", `Your transaction history is not available, so the fees you paid cannot be added up: ${page.reason ?? "it could not be read."}`, facts, { gaps });
  // A reverted transaction still paid its fee: it counts under the kind asked only when no kind was named.
  const paying = page.transactions.filter((tx) => tx.fee !== null && (txMatches(query, tx) || (tx.status === "failed" && !query.filter.kinds?.length && txMatches({ ...query, filter: { ...query.filter, kinds: [] } }, tx))));
  const known = paying.filter((tx) => tx.fee?.usd != null);
  const sum = Math.round(known.reduce((total, tx) => total + (tx.fee?.usd as number), 0) * 100) / 100;
  const period = windowText(query);
  const kinds = query.filter.kinds?.length ? ` on ${txNoun(query, 2)}` : where(query);
  const paid = facts.add(`Fees paid${kinds}${period}`, usd(sum), sum, "usd", "chain", page.asOf);
  const count = facts.add("Transactions counted", String(known.length), known.length, "count", "chain", page.asOf);
  const reverted = known.filter((tx) => tx.status === "failed").length;
  const failedFact = reverted > 0 && !query.filter.kinds?.includes("failed") ? facts.add("Of them reverted", String(reverted), reverted, "count", "chain", page.asOf) : null;
  const missing = paying.length - known.length;
  const why = paying.find((tx) => tx.fee?.usd == null)?.fee?.reason;
  if (missing > 0) gaps.push(`${missing} transaction${missing === 1 ? " has" : "s have"} no fee price and ${missing === 1 ? "is" : "are"} not counted${why ? ` (${why.replace(/\.$/u, "")})` : ""}.`);
  for (const reason of new Set(known.map((tx) => tx.fee?.reason).filter((entry): entry is string => Boolean(entry)))) gaps.push(reason);
  const caveat = complete(page, gaps) ? "" : " Some fees were not read (see the gaps), so the total may be higher.";
  return result(missing > 0 || !complete(page, gaps) ? "partial" : "answered", `You paid ${paid.value} in fees${kinds}${period}, over ${count.value} transaction${known.length === 1 ? "" : "s"}${failedFact ? ` (${failedFact.value} of them reverted)` : ""}.${caveat}`, facts, {
    gaps,
    table: txTable(known),
    followUps: ["Show my transactions this month", "Which of my assets lost the most this month?"],
  });
}

/* ------------------------------------------------------------ results */

/** The span a PnL read covers: the window asked, or the data API's wider period (said, never passed off as the window). */
function pnlSpan(query: AssistantQuery, read: AssistantPnl): { readonly text: string; readonly gaps: string[] } {
  if (read.exact || !read.covered) return { text: windowText(query), gaps: [] };
  const asked = query.window ? query.window.label : "the period asked";
  return { text: ` over ${read.covered}`, gaps: [`Results are computed over ${read.covered}, the nearest period the history service offers, not exactly ${asked}.`] };
}

function pnlGaps(read: AssistantPnl, ctx: ExecContext): string[] {
  return [...coverageGaps(read.unread, ctx.labelOf), ...(read.reason ? [read.reason] : []), ...(read.unread.length === 0 && !read.complete && read.rows.length > 0 ? ["Some costs or prices are unknown, or older history was not read: the totals cover the known part."] : [])];
}

async function pnl(query: AssistantQuery, ctx: ExecContext): Promise<ExecResult> {
  const read = await ctx.port.pnl(ctx.set, { from: query.window?.from ?? null, ...(query.window ? { to: query.window.to } : {}), by: "asset" });
  const facts = new FactList();
  const span = pnlSpan(query, read);
  const gaps = [...span.gaps, ...pnlGaps(read, ctx)];
  const period = span.text;
  const partial = gaps.length > 0 || !read.complete;
  if (query.aggregate === "total" || !query.by) {
    if (read.total.usd === null) return result("unknown", `How your portfolio did${period} is not known yet: ${read.total.reason ?? "it could not be read."}`, facts, { gaps: gaps.filter((gap) => gap !== read.total.reason) });
    const total = facts.add(`Result${period} (estimate)`, signedUsd(read.total.usd), read.total.usd, "usd", read.total.source, read.total.asOf);
    const realized = read.realizedUsd !== null ? facts.add(`Realized${period}`, signedUsd(read.realizedUsd), read.realizedUsd, "usd", "snapshot", read.asOf) : null;
    const unrealized = read.unrealizedUsd !== null ? facts.add("Unrealized on what you still hold", signedUsd(read.unrealizedUsd), read.unrealizedUsd, "usd", "snapshot", read.asOf) : null;
    const value = read.valueChange?.usd != null ? facts.add(`Value change of your tracked wallets${period}`, signedUsd(read.valueChange.usd), read.valueChange.usd, "usd", "snapshot", read.valueChange.asOf) : null;
    const parts = [realized ? `${realized.value} realized` : null, unrealized ? `${unrealized.value} unrealized` : null].filter(Boolean).join(", ");
    return result(partial ? "partial" : "answered", `Your result${period} is ${total.value}${parts ? ` (${parts})` : ""}, a FIFO estimate from your transaction history and today's prices, not tax-grade.${value ? ` Your tracked wallets' value changed by ${value.value} over the same span, deposits and withdrawals included.` : ""}`, facts, { gaps, followUps: ["Which of my assets lost the most this month?", "What's my perps PnL?"] });
  }
  const rows = read.rows.filter((row) => row.change.usd !== null && matchesSymbol(query, row.symbol ?? "") && (row.network === null || matchesNetwork(query, row.network)));
  if (rows.length === 0) return result("unknown", `Which assets gained or lost${period} is not known yet: ${read.reason ?? "no result with a known cost and price was found."}`, facts, { gaps });
  const sorted = [...rows].sort((a, b) => (query.aggregate === "top" ? (b.change.usd as number) - (a.change.usd as number) : (a.change.usd as number) - (b.change.usd as number)));
  const picked = query.aggregate === "list" ? sorted.slice(0, 12) : sorted.slice(0, query.limit ?? 1);
  const shown = picked.map((row) => [row, facts.add(`${pnlLabel(row)} result${period}`, signedUsd(row.change.usd as number), row.change.usd, "usd", row.change.source, row.change.asOf)] as const);
  const pctFacts = picked.filter((row) => row.pct !== null).map((row) => facts.add(`${pnlLabel(row)} unrealized in percent`, pct(row.pct as number, true), row.pct, "fraction", row.change.source, row.change.asOf));
  const table: AssistantTable = {
    columns: [{ key: "asset", label: "Asset" }, { key: "realized", label: "Realized", numeric: true }, { key: "unrealized", label: "Unrealized", numeric: true }, { key: "change", label: "Result", numeric: true }],
    rows: sorted.slice(0, 12).map((row) => ({ asset: pnlLabel(row), realized: row.realizedUsd === null ? "" : signedUsd(row.realizedUsd), unrealized: row.unrealizedUsd === null ? "" : signedUsd(row.unrealizedUsd), change: signedUsd(row.change.usd as number) })),
  };
  const chart: AssistantChart = { kind: "bar", label: `Result by asset${period}`, unit: "usd", points: sorted.slice(0, 8).map((row) => ({ label: pnlLabel(row), value: row.change.usd as number })) };
  const [first] = shown;
  const note = "Results are realized plus unrealized FIFO estimates from your history, not tax-grade.";
  const text = query.aggregate === "list"
    ? `Result by asset${period}: ${shown.map(([row, fact]) => `${pnlLabel(row)} ${fact.value}`).join(", ")}. ${note}`
    : `${query.aggregate === "bottom" ? (((first![0].change.usd as number) < 0) ? "Your biggest loss" : "Your weakest asset") : "Your best performer"}${period} was ${pnlLabel(first![0])}: ${first![1].value}${pctFacts[0] ? ` (${pctFacts[0].value} unrealized)` : ""}. ${note}`;
  return result(partial ? "partial" : "answered", text, facts, { gaps, table, chart, followUps: query.aggregate === "bottom" ? ["Sell my worst performer", "Show my portfolio"] : ["Show my portfolio"] });
}

function pnlLabel(row: AssistantPnlRow): string {
  const symbol = row.symbol ? safeSymbol(row.symbol) : safeSymbol(row.label);
  return row.network ? `${symbol} on ${networkName(row.network)}` : symbol;
}

const EARN_KIND: Readonly<Record<string, readonly string[]>> = { stake: ["staking"], deposit: ["supply", "vault"] };

async function earnings(query: AssistantQuery, ctx: ExecContext): Promise<ExecResult> {
  const read = await ctx.port.pnl(ctx.set, { from: query.window?.from ?? null, ...(query.window ? { to: query.window.to } : {}), by: "position" });
  const facts = new FactList();
  const gaps = pnlGaps(read, ctx);
  const kinds = (query.filter.kinds ?? []).flatMap((kind) => EARN_KIND[kind] ?? []);
  const rows = read.rows.filter((row) => row.earned !== null
    && (kinds.length === 0 || (row.kind !== null && kinds.includes(row.kind)))
    && (!query.filter.protocols?.length || (row.protocol !== null && query.filter.protocols.includes(row.protocol)))
    && matchesSymbol(query, row.symbol ?? "") && (row.network === null || matchesNetwork(query, row.network)));
  const period = windowText(query);
  const what = kinds.includes("staking") ? "staking" : kinds.length ? "lending and vaults" : query.filter.protocols?.length ? query.filter.protocols.map(protocolName).join(" and ") : "your positions";
  const known = rows.filter((row) => row.earned?.usd !== null);
  if (known.length === 0) return result("unknown", `What you earned from ${what}${period} is not known yet: ${read.reason ?? "no reading of it was found."}`, facts, { gaps, followUps: ["Show my positions", "Show my pnl by asset"] });
  const sum = known.reduce((total, row) => total + (row.earned?.usd as number), 0);
  const total = facts.add(`Earned from ${what}${period}`, usd(sum), sum, "usd", known[0]!.earned!.source, known[0]!.earned!.asOf);
  for (const row of known.slice(0, 6)) facts.add(`Earned: ${pnlLabel(row)}${row.protocol ? ` (${protocolName(row.protocol)})` : ""}`, usd(row.earned!.usd as number), row.earned!.usd, "usd", row.earned!.source, row.earned!.asOf);
  const missing = rows.length - known.length;
  return result(missing > 0 || gaps.length > 0 ? "partial" : "answered", `You earned ${total.value} from ${what}${period}.`, facts, {
    gaps,
    table: { columns: [{ key: "position", label: "Position" }, { key: "earned", label: "Earned", numeric: true }], rows: known.slice(0, 12).map((row) => ({ position: pnlLabel(row), earned: usd(row.earned!.usd as number) })) },
    followUps: ["Show my positions", "Move my idle stables to the best yield"],
  });
}

/* ------------------------------------------------------------ extras */

/** A venue's text (a market title, an automation label) as shown in a table: printable, one line, bounded; never in the answer text. */
export function safeText(text: string, max = 80): string {
  const clean = text
    .replace(/[\p{C}]/gu, " ")
    .replace(/\b0x[0-9a-fA-F]{40}\b|\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/gu, "[address]")
    .replace(/\s+/gu, " ")
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

async function extrasOf(ctx: ExecContext) {
  const read = await ctx.port.positions(ctx.set, { extras: true });
  return { read, extras: read.extras ?? null };
}

function sectionGaps(reason: string | null | undefined, ctx: ExecContext): string[] {
  return reason ? [ctx.labelOf(reason)] : [];
}

async function perps(query: AssistantQuery, ctx: ExecContext): Promise<ExecResult> {
  const { extras } = await extrasOf(ctx);
  const facts = new FactList();
  if (!extras) return result("unknown", "Your perps positions could not be read right now.", facts);
  const gaps = sectionGaps(extras.perps.reason, ctx);
  const rows = extras.perps.rows.filter((row) => matchesSymbol(query, row.symbol) && matchesNetwork(query, row.network) && (!query.filter.protocols?.length || (query.filter.protocols as readonly string[]).includes(row.venue)));
  const status: AssistantStatus = gaps.length > 0 ? "partial" : "answered";
  const venue = query.filter.protocols?.length ? ` on ${query.filter.protocols.map(protocolName).join(" or ")}` : "";
  if (rows.length === 0) return result(status, `No open perps positions were found${venue}.${gaps.length ? " Some venues could not be read (see the gaps)." : ""}`, facts, { gaps, followUps: ["What's my exposure?"] });
  const ordered = query.aggregate === "top" ? [...rows].sort((a, b) => b.sizeUsd - a.sizeUsd).slice(0, query.limit ?? 1) : rows.slice(0, 12);
  const count = facts.add(`Open perps positions${venue}`, String(rows.length), rows.length, "count", "adapter", extras.perps.asOf);
  const known = rows.filter((row) => row.unrealizedPnlUsd !== null);
  const pnlSum = Math.round(known.reduce((sum, row) => sum + (row.unrealizedPnlUsd as number), 0) * 100) / 100;
  const pnlFact = known.length > 0 ? facts.add("Unrealized PnL at the mark", signedUsd(pnlSum), pnlSum, "usd", "adapter", extras.perps.asOf) : null;
  const shown = ordered.map((row) => facts.add(`${safeSymbol(row.symbol)} ${row.side} (${protocolName(row.venue)})`, usd(row.sizeUsd), row.sizeUsd, "usd", "adapter", extras.perps.asOf));
  if (known.length < rows.length) gaps.push(`${rows.length - known.length} position${rows.length - known.length === 1 ? " has" : "s have"} no mark price, so ${rows.length - known.length === 1 ? "its" : "their"} PnL is not counted.`);
  gaps.push("Closed positions, funding and fees are not included: this is the open positions' price PnL at the mark.");
  const lead = query.aggregate === "total"
    ? `Your open perps positions${venue} show ${pnlFact?.value ?? "no known"} unrealized PnL at the mark, across ${count.value} position${rows.length === 1 ? "" : "s"}.`
    : query.aggregate === "top"
      ? `Your biggest perps position${venue} is ${shown.map((fact) => `${fact.label} at ${fact.value}`).join("; ")}, of ${count.value} open.`
      : `You have ${count.value} open perps position${rows.length === 1 ? "" : "s"}${venue}: ${shown.map((fact) => `${fact.label} ${fact.value}`).join("; ")}.${pnlFact ? ` Unrealized PnL at the mark: ${pnlFact.value}.` : ""}`;
  // A PnL question is only partly answered: closed positions, funding and fees are not read.
  const partial = known.length < rows.length || status === "partial" || query.aggregate === "total";
  return result(partial ? "partial" : "answered", lead, facts, {
    gaps,
    table: {
      columns: [{ key: "market", label: "Market" }, { key: "side", label: "Side" }, { key: "size", label: "Size", numeric: true }, { key: "leverage", label: "Leverage", numeric: true }, { key: "liquidation", label: "Liquidation", numeric: true }, { key: "pnl", label: "PnL", numeric: true }],
      rows: ordered.map((row) => ({
        market: `${safeSymbol(row.symbol)} (${protocolName(row.venue)})`,
        side: row.side,
        size: usd(row.sizeUsd),
        leverage: row.leverage === null ? "" : `${row.leverage.toFixed(1)}x`,
        liquidation: row.liquidationPrice === null ? "" : usd(row.liquidationPrice),
        pnl: row.unrealizedPnlUsd === null ? "" : signedUsd(row.unrealizedPnlUsd),
      })),
    },
    followUps: ["What's my exposure?", "Show my open orders"],
  });
}

async function orders(query: AssistantQuery, ctx: ExecContext): Promise<ExecResult> {
  const { extras } = await extrasOf(ctx);
  const facts = new FactList();
  if (!extras) return result("unknown", "Your open orders could not be read right now.", facts);
  const gaps = sectionGaps(extras.orders.reason, ctx);
  const rows = extras.orders.rows.filter((row) => matchesNetwork(query, row.network) && (!query.filter.assets?.length || matchesSymbol(query, row.sell.symbol) || (row.buy !== null && matchesSymbol(query, row.buy.symbol))));
  const status: AssistantStatus = gaps.length > 0 ? "partial" : "answered";
  if (rows.length === 0) return result(status, `No open orders were found${where(query)}.${gaps.length ? " Some order venues could not be read (see the gaps)." : ""}`, facts, { gaps, followUps: ["Show my automations"] });
  const count = facts.add(`Open orders${where(query)}`, String(rows.length), rows.length, "count", "adapter", extras.orders.asOf);
  const shown = rows.slice(0, 6).map((row) => facts.add(`Sell ${safeSymbol(row.sell.symbol)}${row.buy ? ` for ${safeSymbol(row.buy.symbol)}` : ""} (${protocolName(row.protocol)} on ${networkName(row.network)})`, `${row.sell.amount} ${safeSymbol(row.sell.symbol)}`, Number(row.sell.amount), "amount", "adapter", extras.orders.asOf));
  return result(status, query.aggregate === "count" ? `You have ${count.value} open order${rows.length === 1 ? "" : "s"}${where(query)}.` : `You have ${count.value} open order${rows.length === 1 ? "" : "s"}${where(query)}: ${shown.map((fact) => `${fact.label}: ${fact.value}`).join("; ")}.`, facts, {
    gaps,
    table: {
      columns: [{ key: "sell", label: "Sell", numeric: true }, { key: "buy", label: "For", numeric: true }, { key: "venue", label: "Venue" }, { key: "created", label: "Placed" }],
      rows: rows.slice(0, 12).map((row) => ({ sell: `${row.sell.amount} ${safeSymbol(row.sell.symbol)}`, buy: row.buy ? `${row.buy.amount} ${safeSymbol(row.buy.symbol)}` : "", venue: `${protocolName(row.protocol)} (${networkName(row.network)})`, created: row.createdAt ? dateOf(row.createdAt) : "" })),
    },
    followUps: ["What's my exposure?", "Show my automations"],
  });
}

async function automations(query: AssistantQuery, ctx: ExecContext): Promise<ExecResult> {
  const { extras } = await extrasOf(ctx);
  const facts = new FactList();
  if (!extras) return result("unknown", "Your automations could not be read right now.", facts);
  const section = extras.automations;
  const gaps = sectionGaps(section.reason, ctx);
  if (section.rows.length === 0) return result(section.asOf === null ? "unknown" : gaps.length ? "partial" : "answered", `No automations were found.${gaps.length ? " They could not all be read (see the gaps)." : ""}`, facts, { gaps });
  const count = facts.add("Automations", String(section.rows.length), section.rows.length, "count", "kletia", section.asOf);
  const active = section.rows.filter((row) => row.status === "active").length;
  const activeFact = facts.add("Active", String(active), active, "count", "kletia", section.asOf);
  const spent = Math.round(section.rows.reduce((sum, row) => sum + (Number(row.spentUsd) || 0), 0) * 100) / 100;
  const spentFact = facts.add("Spent by automations", usd(spent), spent, "usd", "kletia", section.asOf);
  return result(gaps.length ? "partial" : "answered", `You have ${count.value} automation${section.rows.length === 1 ? "" : "s"}, ${activeFact.value} active; together they have spent ${spentFact.value}.`, facts, {
    gaps,
    table: {
      columns: [{ key: "automation", label: "Automation" }, { key: "status", label: "Status" }, { key: "runs", label: "Runs", numeric: true }, { key: "spent", label: "Spent", numeric: true }, { key: "next", label: "Next run" }],
      rows: section.rows.slice(0, 12).map((row) => ({ automation: safeText(row.label ?? row.trigger, 60), status: row.status, runs: String(row.runs), spent: usd(Number(row.spentUsd) || 0), next: row.nextRunAt ? dateOf(row.nextRunAt) : "" })),
    },
    followUps: query.aggregate === "count" ? ["Show my automations"] : ["Show my open orders"],
  });
}

async function predictions(query: AssistantQuery, ctx: ExecContext): Promise<ExecResult> {
  const { extras } = await extrasOf(ctx);
  const facts = new FactList();
  if (!extras) return result("unknown", "Your prediction-market positions could not be read right now.", facts);
  const section = extras.predictions;
  const gaps = sectionGaps(section.reason, ctx);
  if (ctx.set.evm.length === 0) return result("answered", "Prediction markets (Polymarket) are read for EVM wallets, and none is in this set.", facts, { gaps });
  if (section.asOf === null) return result("unknown", "Your prediction-market positions could not be read right now.", facts, { gaps });
  const rows = section.rows;
  if (rows.length === 0) return result(gaps.length ? "partial" : "answered", "No Polymarket positions were found in your wallets. Shares bought through a Polymarket account wallet are held by that wallet's address, which the Predict view reads.", facts, { gaps, followUps: ["Show my transactions this month"] });
  const round = (value: number) => Math.round(value * 100) / 100;
  const cost = round(rows.reduce((sum, row) => sum + row.costUsd, 0));
  const value = round(rows.reduce((sum, row) => sum + row.valueUsd, 0));
  const result_ = round(rows.reduce((sum, row) => sum + row.pnlUsd, 0));
  const count = facts.add("Polymarket positions", String(rows.length), rows.length, "count", "adapter", section.asOf);
  const costFact = facts.add("Staked (cost)", usd(cost), cost, "usd", "adapter", section.asOf);
  const valueFact = facts.add("Worth at current prices", usd(value), value, "usd", "adapter", section.asOf);
  const pnlFact = facts.add("Result so far", signedUsd(result_), result_, "usd", "adapter", section.asOf);
  const redeemable = rows.filter((row) => row.redeemable).length;
  const redeemFact = redeemable > 0 ? facts.add("Resolved, ready to redeem", String(redeemable), redeemable, "count", "adapter", section.asOf) : null;
  const sorted = [...rows].sort((a, b) => b.costUsd - a.costUsd);
  return result(gaps.length ? "partial" : "answered", `You hold ${count.value} Polymarket position${rows.length === 1 ? "" : "s"}: ${costFact.value} staked, worth ${valueFact.value} at current prices (${pnlFact.value}).${redeemFact ? ` ${redeemFact.value} ${redeemable === 1 ? "has" : "have"} resolved and can be redeemed in the Predict view.` : ""} Each market is in the table.`, facts, {
    gaps,
    table: {
      columns: [{ key: "market", label: "Market" }, { key: "outcome", label: "Outcome" }, { key: "cost", label: "Cost", numeric: true }, { key: "value", label: "Value", numeric: true }, { key: "pnl", label: "PnL", numeric: true }],
      rows: sorted.slice(0, 12).map((row) => ({ market: safeText(row.title), outcome: safeText(row.outcome, 24), cost: usd(row.costUsd), value: usd(row.valueUsd), pnl: signedUsd(round(row.pnlUsd)) })),
    },
    followUps: [query.aggregate === "total" ? "What did I bet on Polymarket?" : "What's my exposure?", "Show my transactions this month"],
  });
}

async function exposure(query: AssistantQuery, ctx: ExecContext): Promise<ExecResult> {
  const [summaryRead, { extras }] = await Promise.all([ctx.port.summary(ctx.set), extrasOf(ctx)]);
  const facts = new FactList();
  const gaps = [...failureGaps(summaryRead.failures, ctx), ...sectionGaps(extras?.perps.reason, ctx), ...sectionGaps(extras?.predictions.reason, ctx)];
  if (!extras) gaps.push("Perps and prediction positions could not be read right now.");
  const spotUsd = Math.round(((summaryRead.totals.wallet.usd ?? 0) + (summaryRead.totals.positions.usd ?? 0)) * 100) / 100;
  const spot = facts.add("Spot holdings and positions", usd(spotUsd), spotUsd, "usd", "kletia", summaryRead.asOf);
  const top = summaryRead.allocation.byAsset.slice(0, 3).map((slice) => facts.add(`Share: ${safeSymbol(slice.label)}`, pct(slice.share), slice.share, "fraction", "adapter", summaryRead.asOf));
  const perpRows = (extras?.perps.rows ?? []).filter((row) => matchesSymbol(query, row.symbol));
  const longUsd = Math.round(perpRows.filter((row) => row.side === "long").reduce((sum, row) => sum + row.sizeUsd, 0) * 100) / 100;
  const shortUsd = Math.round(perpRows.filter((row) => row.side === "short").reduce((sum, row) => sum + row.sizeUsd, 0) * 100) / 100;
  const long = perpRows.length > 0 ? facts.add("Perps long (notional)", usd(longUsd), longUsd, "usd", "adapter", extras?.perps.asOf ?? null) : null;
  const short = perpRows.length > 0 ? facts.add("Perps short (notional)", usd(shortUsd), shortUsd, "usd", "adapter", extras?.perps.asOf ?? null) : null;
  const bets = extras?.predictions.rows ?? [];
  const betUsd = Math.round(bets.reduce((sum, row) => sum + row.valueUsd, 0) * 100) / 100;
  const bet = bets.length > 0 ? facts.add("Prediction positions at current prices", usd(betUsd), betUsd, "usd", "adapter", extras?.predictions.asOf ?? null) : null;
  const text = [
    `Spot: ${spot.value} in your wallets and venue positions${top.length ? ` (largest: ${top.map((fact) => `${fact.label.replace("Share: ", "")} ${fact.value}`).join(", ")})` : ""}.`,
    long && short ? `Perps: ${long.value} long and ${short.value} short.` : "No open perps positions.",
    bet ? `Prediction markets: ${bet.value} at current prices.` : "",
  ].filter(Boolean).join(" ");
  const bySymbol = new Map<string, number>();
  for (const slice of summaryRead.allocation.byAsset) bySymbol.set(safeSymbol(slice.label), (bySymbol.get(safeSymbol(slice.label)) ?? 0) + slice.usd);
  for (const row of perpRows) bySymbol.set(safeSymbol(row.symbol), (bySymbol.get(safeSymbol(row.symbol)) ?? 0) + (row.side === "long" ? row.sizeUsd : -row.sizeUsd));
  const points = [...bySymbol.entries()].map(([label, value]) => ({ label, value: Math.round(value * 100) / 100 })).sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, 8);
  return result(gaps.length > 0 || !summaryRead.totals.complete ? "partial" : "answered", text, facts, {
    gaps,
    chart: { kind: "bar", label: "Net exposure by asset (spot plus perps; shorts negative)", unit: "usd", points },
    followUps: ["What's my perps PnL?", "What did I bet on Polymarket?"],
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
  // Each rate leads to the same deposit sentence as the dashboard's "Move here".
  const shown = rows.map((row) => facts.add(`${row.name} on ${networkName(row.network)} (supply APY)`, pct(row.apy as number), row.apy, "fraction", row.source, row.asOf, row.depositText ? { kind: "deposit", sentence: row.depositText } : undefined));
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
    case "perps":
      return perps(query, ctx);
    case "orders":
      return orders(query, ctx);
    case "automations":
      return automations(query, ctx);
    case "predictions":
      return predictions(query, ctx);
    case "exposure":
      return exposure(query, ctx);
  }
}
