/**
 * Portfolio requests that want action, turned into ordinary desk sentences
 * from the real holdings (docs/platform/assistant.md "Action requests"):
 *
 * - rebalance to target weights on one network ("rebalance my portfolio to
 *   60/40 ETH/USDC"): swaps from the overweight assets into the underweight
 *   ones, amounts computed from the wallet's priced holdings;
 * - sell the worst (or best) performer: the asset's PnL row, then a swap of
 *   all of it to USDC on each network that holds it;
 * - move idle stables to the best yield: each stablecoin holding into the
 *   best executable venue for it on its network;
 * - close everything risky: every volatile wallet holding swapped to USDC.
 *
 * Nothing is planned here: each sentence goes through the reader, the plan
 * and the confirm exactly as if the person had typed it, and the amounts are
 * rounded down so they never exceed what is held.
 */
import {
  ASSISTANT_LIMITS,
  findAssetBySymbol,
  type AssistantAction,
  type AssistantFact,
  type DataHolding,
  type NetworkKey,
} from "@kletia/core";
import type { AssistantDataPort } from "./dataPort.js";
import { safeSymbol, type ExecContext, type ExecResult } from "./execute.js";
import { floorAmount, networkName, networkWord, pct, signedUsd, usd } from "./format.js";
import { entitiesOf, normalizeQuestion, SYMBOLS } from "./parse.js";
import { resolveWindow } from "./windows.js";

export interface ActionResult extends ExecResult {
  readonly action?: AssistantAction;
  readonly assumptions: readonly string[];
}

/** Moves smaller than this (USD, or this share of the value) are not worth a transaction. */
const MIN_MOVE_USD = 1;
const MIN_MOVE_SHARE = 0.005;
/** Volatile holdings worth less than this are left out of "close everything risky": the network fee kept would eat most of them. */
const MIN_SELL_USD = 10;

class Facts {
  readonly list: AssistantFact[] = [];
  add(label: string, value: string, number: number | null, unit: AssistantFact["unit"], source: AssistantFact["source"], asOf: string | null): AssistantFact {
    const fact = { id: `f${this.list.length + 1}`, label, value, number, unit, source, asOf };
    this.list.push(fact);
    return fact;
  }
}

function done(status: ExecResult["status"], text: string, facts: Facts, extra: Partial<Omit<ActionResult, "status" | "text" | "facts">> = {}): ActionResult {
  return { status, text, facts: facts.list, followUps: extra.followUps ?? [], gaps: extra.gaps ?? [], assumptions: extra.assumptions ?? [], ...(extra.table ? { table: extra.table } : {}), ...(extra.action ? { action: extra.action } : {}) };
}

const isStable = (holding: Pick<DataHolding, "network" | "symbol">) => findAssetBySymbol(holding.network, holding.symbol)?.category === "stablecoin";
const tradable = (network: NetworkKey, symbol: string) => {
  const asset = findAssetBySymbol(network, symbol);
  return asset !== null && asset.transferOnly !== true;
};

/* ------------------------------------------------------------ rebalance */

/** Target weights said in the sentence ("60/40 eth/usdc", "60% eth 40% usdc", "60/40 between eth and usdc"). */
export function targetWeights(sentence: string): { readonly symbol: string; readonly share: number }[] | null {
  const symbol = (word: string) => SYMBOLS.get(word) ?? null;
  const pairs: [string, string][] = [];
  let m = /(\d{1,3})\s*%?\s*\/\s*(\d{1,3})\s*%?(?:\s*\/\s*(\d{1,3})\s*%?)?\s+(?:between\s+|in\s+|of\s+)?([a-z0-9.]+)(?:\s*\/\s*|\s+and\s+)([a-z0-9.]+)(?:(?:\s*\/\s*|\s+and\s+)([a-z0-9.]+))?/u.exec(sentence);
  if (m) {
    const weights = [m[1], m[2], m[3]].filter(Boolean) as string[];
    const words = [m[4], m[5], m[6]].filter(Boolean) as string[];
    if (weights.length !== words.length) return null;
    weights.forEach((weight, index) => pairs.push([weight, words[index] as string]));
  } else {
    for (m of sentence.matchAll(/(\d{1,3})\s*(?:%|percent)?\s+(?:in\s+)?([a-z][a-z0-9.]*)/gu)) pairs.push([m[1] as string, m[2] as string]);
  }
  const out = pairs.map(([weight, word]) => ({ symbol: symbol(word), share: Number(weight) / 100 }));
  if (out.length < 2 || out.length > 3 || out.some((entry) => entry.symbol === null || entry.share <= 0)) return null;
  if (Math.abs(out.reduce((sum, entry) => sum + entry.share, 0) - 1) > 1e-9) return null;
  if (new Set(out.map((entry) => entry.symbol)).size !== out.length) return null;
  return out as { symbol: string; share: number }[];
}

async function rebalance(sentence: string, ctx: ExecContext): Promise<ActionResult> {
  const facts = new Facts();
  const weights = targetWeights(sentence);
  if (!weights) {
    return done("needs-model", 'Say the target weights and assets, for example "rebalance my portfolio to 60/40 ETH/USDC on Base".', facts, { followUps: ["Rebalance my portfolio to 60/40 ETH/USDC on Base", "How is my portfolio split by asset?"] });
  }
  const read = await ctx.port.summary(ctx.set);
  const wallet = read.holdings.filter((holding) => weights.some((weight) => weight.symbol.toLowerCase() === holding.symbol.toLowerCase()));
  if (wallet.some((holding) => holding.value.usd === null)) return done("unknown", "Some of these holdings have no price right now, so the weights cannot be computed.", facts);
  const said = entitiesOf(sentence).networks[0];
  const assumptions: string[] = [];
  const byNetwork = new Map<NetworkKey, number>();
  for (const holding of wallet) byNetwork.set(holding.network, (byNetwork.get(holding.network) ?? 0) + (holding.value.usd as number));
  const network = said ?? [...byNetwork.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!network) return done("answered", `You hold none of ${weights.map((weight) => safeSymbol(weight.symbol)).join(" or ")} in your wallets, so there is nothing to rebalance.`, facts);
  if (!said) assumptions.push(`On ${networkName(network)}, where you hold the most of these assets.`);
  const unlisted = weights.filter((weight) => !tradable(network, weight.symbol));
  if (unlisted.length > 0) return done("refused", `${unlisted.map((weight) => safeSymbol(weight.symbol)).join(" and ")} cannot be swapped on ${networkName(network)}, so this rebalance cannot be planned there.`, facts);
  const rows = weights.map((weight) => {
    const held = wallet.filter((holding) => holding.network === network && holding.symbol.toLowerCase() === weight.symbol.toLowerCase());
    const amount = held.reduce((sum, holding) => sum + Number(holding.formatted), 0);
    const value = held.reduce((sum, holding) => sum + (holding.value.usd as number), 0);
    return { ...weight, amount, value, price: amount > 0 ? value / amount : null, holding: held[0] ?? null };
  });
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  if (total < MIN_MOVE_USD) return done("answered", `You hold less than ${usd(MIN_MOVE_USD)} of these assets on ${networkName(network)}, so there is nothing to rebalance.`, facts);
  const totalFact = facts.add(`Value of ${rows.map((row) => safeSymbol(row.symbol)).join(" and ")} on ${networkName(network)}`, usd(total), total, "usd", rows[0]?.holding?.value.source ?? "adapter", read.asOf);
  for (const row of rows) facts.add(`${safeSymbol(row.symbol)} now`, `${pct(row.value / total)} (${usd(row.value)})`, row.value / total, "fraction", row.holding?.value.source ?? "adapter", row.holding?.value.asOf ?? read.asOf);
  for (const row of rows) facts.add(`${safeSymbol(row.symbol)} target`, pct(row.share), row.share, "fraction", "kletia", read.asOf);
  const over = rows.map((row) => ({ row, usd: row.value - row.share * total })).filter((entry) => entry.usd > 0).sort((a, b) => b.usd - a.usd);
  const under = rows.map((row) => ({ row, usd: row.share * total - row.value })).filter((entry) => entry.usd > 0).sort((a, b) => b.usd - a.usd);
  const sentences: string[] = [];
  const moves: string[] = [];
  const threshold = Math.max(MIN_MOVE_USD, MIN_MOVE_SHARE * total);
  for (const seller of over) {
    for (const buyer of under) {
      const move = Math.min(seller.usd, buyer.usd);
      if (move < threshold || seller.row.price === null) continue;
      const amount = floorAmount(Math.min(move / seller.row.price, seller.row.amount));
      if (!amount) continue;
      seller.usd -= move;
      buyer.usd -= move;
      const fact = facts.add(`Swap ${safeSymbol(seller.row.symbol)} to ${safeSymbol(buyer.row.symbol)}`, `${amount} ${safeSymbol(seller.row.symbol)} (about ${usd(move)})`, move, "usd", "kletia", read.asOf);
      moves.push(`swap ${fact.value.replace(/ \(about/u, ` to ${safeSymbol(buyer.row.symbol)} (about`)}`);
      sentences.push(`swap ${amount} ${seller.row.symbol} to ${buyer.row.symbol} on ${networkWord(network)}`);
    }
  }
  if (sentences.length === 0) {
    const within = facts.add("Smallest move worth a transaction", usd(threshold), threshold, "usd", "kletia", read.asOf);
    return done("answered", `Your ${rows.map((row) => safeSymbol(row.symbol)).join("/")} split on ${networkName(network)} (${totalFact.value}) is already within ${within.value} of the target.`, facts, { assumptions });
  }
  return done("answered", `To reach ${rows.map((row) => `${pct(row.share)} ${safeSymbol(row.symbol)}`).join(" / ")} on ${networkName(network)} (${totalFact.value} in these assets): ${moves.join("; ")}. Each swap is planned and shown for you to confirm before anything is signed.`, facts, {
    assumptions,
    action: { goal: "rebalance", summary: `Rebalance to ${rows.map((row) => `${pct(row.share)} ${safeSymbol(row.symbol)}`).join(" / ")} on ${networkName(network)}`, sentences: sentences.slice(0, ASSISTANT_LIMITS.sentences) },
  });
}

/* ------------------------------------------------------------ sell a performer */

async function sellPerformer(sentence: string, ctx: ExecContext, now: number): Promise<ActionResult> {
  const facts = new Facts();
  const best = /\b(?:best|strongest|top|winners?)\b/u.test(sentence);
  const said = entitiesOf(sentence).window;
  const window = resolveWindow(said ?? { name: "last_days", days: 30, assumed: true }, now);
  const read = await ctx.port.pnl(ctx.set, { from: window.from, to: window.to, by: "asset" });
  // The history service's periods are fixed: a wider one is said, never passed off as the window asked.
  const span = read.exact || !read.covered ? window.label : read.covered;
  const assumptions = [...(said ? [] : [`Performance over ${window.label}.`]), ...(span !== window.label ? [`Results are computed over ${span}, the nearest period the history service offers.`] : [])];
  const rows = read.rows.filter((row) => row.symbol !== null && row.change.usd !== null && !(row.network ? isStable({ network: row.network, symbol: row.symbol }) : /^(?:usd|dai|pyusd|eurc)/iu.test(row.symbol)));
  if (rows.length === 0) return done("unknown", `Which asset performed ${best ? "best" : "worst"} over ${span} is not known yet${read.reason ? `: ${read.reason}` : "."} Nothing was planned.`, facts, { assumptions, gaps: read.reason ? [read.reason] : [] });
  // Ranked in dollars: a percentage exists only for some rows (nothing realized), and mixing the two would rank units, not results.
  const score = (row: (typeof rows)[number]) => row.change.usd as number;
  const pick = [...rows].sort((a, b) => (best ? score(b) - score(a) : score(a) - score(b)))[0] as (typeof rows)[number];
  const symbol = pick.symbol as string;
  const change = facts.add(`${safeSymbol(symbol)} change over ${span}`, `${signedUsd(pick.change.usd as number)}${pick.pct !== null ? ` (${pct(pick.pct, true)})` : ""}`, pick.change.usd, "usd", pick.change.source, pick.change.asOf);
  const summary = await ctx.port.summary(ctx.set);
  const target = facts.add("Swapped to", "USDC", null, "text", "kletia", summary.asOf);
  const all = summary.holdings.filter((holding) => holding.symbol.toLowerCase() === symbol.toLowerCase() && tradable(holding.network, holding.symbol) && tradable(holding.network, "USDC"));
  // As for risky holdings: a swap of a few dollars would mostly pay the network fee.
  const held = all.filter((holding) => (holding.value.usd ?? 0) >= MIN_SELL_USD);
  if (held.length < all.length) assumptions.push(`Holdings worth less than ${usd(MIN_SELL_USD)} are left out.`);
  if (held.length === 0) return done("answered", `Your ${best ? "best" : "worst"} performer over ${span} was ${safeSymbol(symbol)} (${change.value}), but ${all.length > 0 ? "what is left in your wallets is too small to swap" : "none of it is in your wallets now where it can be swapped"}. Nothing was planned.`, facts, { assumptions });
  for (const holding of held) facts.add(`${safeSymbol(symbol)} on ${networkName(holding.network)}`, `${holding.formatted} ${safeSymbol(symbol)}${holding.value.usd !== null ? ` (${usd(holding.value.usd)})` : ""}`, Number(holding.formatted), "amount", holding.value.source, holding.value.asOf);
  const sentences = held.map((holding) => `swap all my ${symbol} on ${networkWord(holding.network)} to USDC`);
  return done("answered", `Your ${best ? "best" : "worst"} performer over ${span} was ${safeSymbol(symbol)} (${change.value}). Selling it means swapping it to ${target.value} on ${held.map((holding) => networkName(holding.network)).join(" and ")}; Kletia keeps enough for network fees and shows each swap for you to confirm.`, facts, {
    assumptions,
    action: { goal: "sell", summary: `Sell ${safeSymbol(symbol)} for USDC`, sentences: sentences.slice(0, ASSISTANT_LIMITS.sentences) },
  });
}

/* ------------------------------------------------------------ idle stables */

async function idleStables(ctx: ExecContext, port: AssistantDataPort): Promise<ActionResult> {
  const facts = new Facts();
  const read = await port.summary(ctx.set);
  const stables = read.holdings.filter((holding) => isStable(holding) && tradable(holding.network, holding.symbol) && (holding.value.usd ?? 0) >= MIN_MOVE_USD);
  if (stables.length === 0) return done("answered", `No idle stablecoins worth at least ${usd(MIN_MOVE_USD)} were found in your wallets.`, facts, { gaps: read.failures.length ? ["Some accounts could not be read."] : [] });
  const sentences: string[] = [];
  const gaps: string[] = [];
  const lines: string[] = [];
  for (const holding of stables.sort((a, b) => (b.value.usd as number) - (a.value.usd as number)).slice(0, ASSISTANT_LIMITS.sentences)) {
    const symbol = safeSymbol(holding.symbol);
    const rates = await port.yields({ lane: ctx.set.lane, network: holding.network, asset: holding.symbol });
    const venue = rates.yields.filter((row) => row.executable && row.apy !== null).sort((a, b) => (b.apy as number) - (a.apy as number))[0];
    if (!venue) {
      gaps.push(`No ${symbol} venue Kletia can deposit into on ${networkName(holding.network)} has a readable rate.`);
      continue;
    }
    const amount = facts.add(`Idle ${symbol} on ${networkName(holding.network)}`, `${holding.formatted} ${symbol} (${usd(holding.value.usd as number)})`, Number(holding.formatted), "amount", holding.value.source, holding.value.asOf);
    const apy = facts.add(`${venue.name} on ${networkName(venue.network)} (supply APY)`, pct(venue.apy as number), venue.apy, "fraction", venue.source, venue.asOf);
    lines.push(`${amount.value} into ${venue.name} at ${apy.value}`);
    sentences.push(`deposit ${holding.formatted} ${holding.symbol} into ${venue.name} on ${networkWord(holding.network)}`);
  }
  if (sentences.length === 0) return done("unknown", "No rate for your stablecoins could be read right now, so nothing was planned.", facts, { gaps });
  return done(gaps.length ? "partial" : "answered", `Best rates Kletia reads for your idle stablecoins: ${lines.join("; ")}. Rates change; each deposit is planned and shown for you to confirm.`, facts, {
    gaps,
    action: { goal: "best-yield", summary: "Move idle stablecoins to the best yield", sentences },
  });
}

/* ------------------------------------------------------------ risky */

async function closeRisky(ctx: ExecContext): Promise<ActionResult> {
  const facts = new Facts();
  const read = await ctx.port.summary(ctx.set);
  const risky = read.holdings
    .filter((holding) => !isStable(holding) && tradable(holding.network, holding.symbol) && tradable(holding.network, "USDC") && (holding.value.usd ?? 0) >= MIN_SELL_USD)
    .sort((a, b) => (b.value.usd as number) - (a.value.usd as number));
  const gaps: string[] = [];
  for (const loan of read.health.filter((entry) => entry.status === "warning" || entry.status === "critical")) {
    gaps.push(`A loan on ${networkName(loan.network)} has a low health factor; Kletia does not plan repayments yet, so repay it at the venue.`);
  }
  const volatilePositions = read.positions.filter((position) => position.kind !== "borrow" && !position.inWallet && findAssetBySymbol(position.network, position.symbol)?.category !== "stablecoin");
  if (volatilePositions.length > 0) gaps.push(`${volatilePositions.length} venue position${volatilePositions.length === 1 ? " holds" : "s hold"} a volatile asset; withdraw ${volatilePositions.length === 1 ? "it" : "them"} first to sell.`);
  const assumptions = ["Risky means any asset that is not a stablecoin.", `Holdings worth less than ${usd(MIN_SELL_USD)} are left out.`];
  if (risky.length === 0) return done(gaps.length ? "partial" : "answered", `No volatile asset worth at least ${usd(MIN_SELL_USD)} was found in your wallets.`, facts, { gaps, assumptions });
  for (const holding of risky.slice(0, ASSISTANT_LIMITS.sentences)) {
    facts.add(`${safeSymbol(holding.symbol)} on ${networkName(holding.network)}`, `${holding.formatted} ${safeSymbol(holding.symbol)} (${usd(holding.value.usd as number)})`, holding.value.usd, "usd", holding.value.source, holding.value.asOf);
  }
  const total = risky.reduce((sum, holding) => sum + (holding.value.usd as number), 0);
  const totalFact = facts.add("Volatile assets in wallets", usd(total), total, "usd", risky[0]?.value.source ?? "adapter", read.asOf);
  const count = facts.add("Volatile holdings", String(risky.length), risky.length, "count", "adapter", read.asOf);
  const target = facts.add("Swapped to", "USDC", null, "text", "kletia", read.asOf);
  return done(gaps.length ? "partial" : "answered", `Risky here means volatile (not a stablecoin): ${totalFact.value} across ${count.value} holding${risky.length === 1 ? "" : "s"}. Each is swapped to ${target.value}; Kletia keeps enough for network fees and shows every swap for you to confirm.`, facts, {
    gaps,
    assumptions,
    action: { goal: "exit", summary: "Swap volatile assets to USDC", sentences: risky.slice(0, ASSISTANT_LIMITS.sentences).map((holding) => `swap all my ${holding.symbol} on ${networkWord(holding.network)} to USDC`) },
  });
}

/** The action a portfolio request asks for, computed from the data. */
export async function runAction(text: string, ctx: ExecContext, now: number): Promise<ActionResult> {
  const sentence = normalizeQuestion(text);
  if (/\brebalance\b/u.test(sentence)) return rebalance(sentence, ctx);
  if (/\b(?:performer|performing|loser|losers|winner|winners|losing)\b/u.test(sentence)) return sellPerformer(sentence, ctx, now);
  if (/\bidle\b/u.test(sentence)) return idleStables(ctx, ctx.port);
  return closeRisky(ctx);
}
