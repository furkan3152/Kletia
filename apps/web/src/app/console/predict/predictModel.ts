/**
 * The Predict view as pure functions (no React, no wallet): market rows with
 * implied probabilities, book depth, the ticket and the request it sends,
 * the checks the API repeats, quote rows (max loss, payout, fees), the
 * user's Polymarket wallets (which one trades, its balances and moves),
 * position and open-order rows, the location note, and the signing run's
 * step states. Node tests load it directly.
 */
import {
  PREDICTION_LIMITS,
  type PolymarketWallet,
  type PolymarketWalletAction,
  type PredictionBook,
  type PredictionMarket,
  type PredictionOrderType,
  type PredictionPosition,
  type PredictionQuote,
  type PredictionRequest,
  type PredictionSide,
  type PredictionStep,
} from "@kletia/core";

/** Polygon PoS as a CAIP-2 id (Polymarket's network). */
export const POLYGON_CAIP2 = "eip155:137";

export const PREDICT_CATEGORIES: readonly { readonly id: string; readonly label: string }[] = Object.freeze([
  { id: "", label: "Top" },
  { id: "politics", label: "Politics" },
  { id: "sports", label: "Sports" },
  { id: "crypto", label: "Crypto" },
  { id: "economy", label: "Economy" },
  { id: "finance", label: "Finance" },
  { id: "tech", label: "Tech" },
  { id: "geopolitics", label: "Geopolitics" },
]);

/* ------------------------------------------------------------ formats */

/** A price as an implied probability: "4.3%", "<0.1%", ">99.9%". */
export function formatProbability(price: number | null | undefined): string {
  if (typeof price !== "number" || !Number.isFinite(price)) return "-";
  if (price > 0 && price < 0.001) return "<0.1%";
  if (price < 1 && price > 0.999) return ">99.9%";
  const pct = price * 100;
  return `${pct.toLocaleString("en-US", { maximumFractionDigits: pct < 10 ? 1 : 0 })}%`;
}

/** A share price in cents: "4.3¢". */
export function formatCents(price: number | null | undefined): string {
  if (typeof price !== "number" || !Number.isFinite(price)) return "-";
  return `${(price * 100).toLocaleString("en-US", { maximumFractionDigits: 1 })}¢`;
}

export function formatUsd(value: number): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Volume in compact dollars: "$1.2M", "$48K", "$950". */
export function formatVolume(value: number): string {
  if (!(value > 0)) return "$0";
  return `$${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value)}`;
}

export function formatShares(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** "Ends Jan 1, 2027", or "No end date". */
export function formatEnds(endDate: string | null, nowMs: number): string {
  if (!endDate) return "No end date";
  const at = Date.parse(endDate);
  if (Number.isNaN(at)) return "No end date";
  const date = new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  return at < nowMs ? `Ended ${date}` : `Ends ${date}`;
}

/* ------------------------------------------------------------- markets */

export interface MarketRow {
  readonly id: string;
  readonly title: string;
  /** The event, when the market is one option of a multi-market event. */
  readonly context: string | null;
  readonly leading: { readonly label: string; readonly probability: string } | null;
  readonly volume: string;
  readonly ends: string;
}

export function marketRows(markets: readonly PredictionMarket[], nowMs: number): MarketRow[] {
  return markets.map((market) => {
    const first = market.outcomes[0];
    return {
      id: market.id,
      title: market.groupTitle && market.eventTitle ? `${market.eventTitle}: ${market.groupTitle}` : market.question,
      context: market.groupTitle && market.eventTitle ? market.question : market.eventTitle && market.eventTitle !== market.question ? market.eventTitle : null,
      leading: first ? { label: first.label, probability: formatProbability(first.price) } : null,
      volume: formatVolume(market.volume24hUsd),
      ends: formatEnds(market.endDate, nowMs),
    };
  });
}

export interface DepthRow {
  readonly price: string;
  readonly shares: string;
  /** Share of the deepest level shown (0 to 1), for the depth bar. */
  readonly depth: number;
}

/** The top levels of each side, best first, with a relative depth bar. */
export function bookDepth(book: Pick<PredictionBook, "bids" | "asks">, levels = 5): { readonly bids: DepthRow[]; readonly asks: DepthRow[]; readonly spread: string } {
  const bids = book.bids.slice(0, levels);
  const asks = book.asks.slice(0, levels);
  const deepest = Math.max(1, ...bids.map((level) => level.size), ...asks.map((level) => level.size));
  const row = (level: { readonly price: number; readonly size: number }): DepthRow => ({ price: formatCents(level.price), shares: formatShares(level.size), depth: level.size / deepest });
  const spread = bids[0] && asks[0] ? formatCents(asks[0].price - bids[0].price) : "-";
  return { bids: bids.map(row), asks: asks.map(row), spread };
}

/* --------------------------------------------------------------- ticket */

export interface PredictTicket {
  readonly marketId: string | null;
  readonly outcome: string | null;
  readonly side: PredictionSide;
  readonly orderType: PredictionOrderType;
  /** buy: USD (fees included); sell: shares. As typed. */
  readonly amount: string;
  /** limit: price per share in cents, as typed ("42"). */
  readonly limitCents: string;
  readonly slippageBps: number;
}

export const DEFAULT_TICKET: PredictTicket = Object.freeze({
  marketId: null,
  outcome: null,
  side: "buy",
  orderType: "market",
  amount: "",
  limitCents: "",
  slippageBps: PREDICTION_LIMITS.defaultSlippageBps,
});

const AMOUNT_INPUT = /^\d{1,7}(?:\.\d{1,2})?$/u;
const CENTS_INPUT = /^\d{1,2}(?:\.\d{1,2})?$/u;

/** The amount the user typed ("20", "20.5"), or null. */
export function ticketAmount(text: string): string | null {
  const trimmed = text.trim().replace(/^\$/u, "").replace(/\.$/u, "");
  return AMOUNT_INPUT.test(trimmed) && Number(trimmed) > 0 ? trimmed : null;
}

/** A limit price typed in cents ("42" -> "0.42"), or null outside 0 to 100 cents. */
export function limitPrice(cents: string): string | null {
  const trimmed = cents.trim().replace(/¢$/u, "");
  if (!CENTS_INPUT.test(trimmed) || !(Number(trimmed) > 0) || !(Number(trimmed) < 100)) return null;
  return String(Number((Number(trimmed) / 100).toFixed(4)));
}

/** What keeps the ticket from quoting (empty: it can quote). The API checks the same and more. */
export function ticketProblems(ticket: PredictTicket, market: Pick<PredictionMarket, "acceptingOrders" | "closed" | "outcomes"> | null, maxStakeUsd: number = PREDICTION_LIMITS.defaultMaxStakeUsd): string[] {
  const problems: string[] = [];
  if (!market || !ticket.marketId) return ["Pick a market."];
  if (market.closed || !market.acceptingOrders) problems.push("This market is not taking orders.");
  if (!ticket.outcome || !market.outcomes.some((outcome) => outcome.label === ticket.outcome)) problems.push("Pick an outcome.");
  const amount = ticketAmount(ticket.amount);
  if (amount === null) problems.push(ticket.side === "buy" ? "Enter how many dollars to spend." : "Enter how many shares to sell.");
  else if (ticket.side === "buy" && Number(amount) < PREDICTION_LIMITS.minStakeUsd) problems.push(`Spend at least ${PREDICTION_LIMITS.minStakeUsd} USD.`);
  else if (ticket.side === "buy" && Number(amount) > maxStakeUsd) problems.push(`The cap is ${formatUsd(maxStakeUsd)} per order.`);
  if (ticket.orderType === "limit" && limitPrice(ticket.limitCents) === null) problems.push("Enter a limit price between 0 and 100 cents.");
  return problems;
}

/** The body of POST /v1/predictions/quote and /prepare for the ticket; `wallet`: the Polymarket wallet that trades. */
export function ticketRequest(ticket: PredictTicket, account: string | null, hasSession = false, wallet: string | null = null): PredictionRequest {
  const amount = ticketAmount(ticket.amount) ?? "0";
  const limit = ticket.orderType === "limit" ? limitPrice(ticket.limitCents) : null;
  return {
    venue: "polymarket",
    marketId: ticket.marketId ?? "",
    outcome: ticket.outcome ?? "",
    side: ticket.side,
    orderType: ticket.orderType,
    ...(ticket.side === "buy" ? { amountUsd: amount } : { shares: amount }),
    ...(limit ? { limitPrice: limit } : {}),
    ...(ticket.orderType === "market" ? { slippageBps: ticket.slippageBps } : {}),
    ...(account ? { account, hasSession, ...(wallet ? { wallet } : {}) } : {}),
  };
}

export interface QuoteRow {
  readonly label: string;
  readonly value: string;
  readonly tone?: "warn";
}

/** What the person reads before signing: odds, prices, shares, the most they can lose, payout and fees. */
export function quoteRows(quote: PredictionQuote): QuoteRow[] {
  const buy = quote.side === "buy";
  return [
    { label: "Implied probability now", value: formatProbability(quote.impliedProbability) },
    { label: buy ? "Average price" : "Average price received", value: formatCents(quote.avgPrice) },
    { label: buy ? "Worst price accepted" : "Lowest price accepted", value: formatCents(quote.worstPrice) },
    { label: buy ? "Shares you get" : "Shares you sell", value: formatShares(quote.shares) },
    ...(buy
      ? [
          { label: "Most you can lose", value: formatUsd(quote.maxLossUsd), tone: "warn" as const },
          { label: `Payout if ${quote.outcome} wins`, value: formatUsd(quote.payoutIfWinUsd) },
          { label: "Profit if it wins", value: formatUsd(quote.profitIfWinUsd) },
        ]
      : [
          { label: "You receive (after fees)", value: formatUsd(quote.profitIfWinUsd) },
          { label: `You give up if ${quote.outcome} wins`, value: formatUsd(quote.payoutIfWinUsd), tone: "warn" as const },
        ]),
    { label: "Fees (estimate)", value: quote.feeUsd > 0 ? formatUsd(quote.feeUsd) : "None on this market" },
  ];
}

/* ------------------------------------------------------------ positions */

export interface PositionRow {
  readonly key: string;
  readonly title: string;
  readonly outcome: string;
  readonly shares: string;
  readonly value: string;
  readonly price: string;
  readonly pnl: string;
  readonly pnlTone: "gain" | "loss" | "flat";
  readonly redeemable: boolean;
  readonly conditionId: string;
  readonly tokenId: string;
}

/** Position rows; `filter` keeps those whose title holds every word (a sell hand-off's words). */
export function positionRows(positions: readonly PredictionPosition[], filter: string | null = null): PositionRow[] {
  const words = (filter ?? "").toLowerCase().split(/[^a-z0-9]+/u).filter((word) => word.length > 1);
  return positions
    .filter((position) => words.every((word) => position.title.toLowerCase().includes(word)))
    .map((position) => ({
      key: `${position.conditionId}:${position.tokenId}`,
      title: position.title,
      outcome: position.outcome,
      shares: formatShares(position.shares),
      value: formatUsd(position.valueUsd),
      price: formatCents(position.currentPrice),
      pnl: `${position.pnlUsd > 0 ? "+" : ""}${formatUsd(position.pnlUsd)}`,
      pnlTone: position.pnlUsd > 0 ? "gain" : position.pnlUsd < 0 ? "loss" : "flat",
      redeemable: position.redeemable,
      conditionId: position.conditionId,
      tokenId: position.tokenId,
    }));
}

/* --------------------------------------------------- Polymarket wallets */

export const WALLET_KIND_LABELS: Readonly<Record<PolymarketWallet["kind"], string>> = Object.freeze({ safe: "Safe", deposit: "Deposit Wallet", proxy: "Proxy wallet" });

/** "0x1234…ab12". */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/** Who trades, as the ticket says it: "Your Polymarket wallet 0x…ab12, owned by 0x…cd34". */
export function walletLine(wallet: Pick<PolymarketWallet, "address" | "owner">): string {
  return `Your Polymarket wallet ${shortAddress(wallet.address)}, owned by ${shortAddress(wallet.owner)}`;
}

export interface WalletRow {
  readonly address: string;
  readonly kind: string;
  readonly line: string;
  readonly balance: string;
  readonly tradable: boolean;
  readonly onProfile: boolean;
  readonly note: string | null;
  readonly actions: readonly PolymarketWalletAction[];
}

function usdOf(value: string): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : value;
}

/** One row per verified wallet: what it is, who owns it, its pUSD and USDC.e, whether Kletia trades it. */
export function walletRows(wallets: readonly PolymarketWallet[]): WalletRow[] {
  return wallets.map((wallet) => ({
    address: wallet.address,
    kind: WALLET_KIND_LABELS[wallet.kind],
    line: walletLine(wallet),
    balance: wallet.balances ? `${usdOf(wallet.balances.pusd)} pUSD · ${usdOf(wallet.balances.usdce)} USDC.e` : "Balance unavailable",
    tradable: wallet.tradable,
    onProfile: wallet.onProfile,
    note: wallet.note,
    actions: wallet.actions,
  }));
}

/**
 * The wallet the desk trades from: the one the person picked while it is
 * still listed, else the one Polymarket's profile names, else the first
 * tradable one, else the first; null when none was found (the account
 * itself then trades, if it is a plain wallet).
 */
export function pickWallet(wallets: readonly PolymarketWallet[], picked: string | null): PolymarketWallet | null {
  const chosen = picked ? wallets.find((wallet) => wallet.address.toLowerCase() === picked.toLowerCase()) : undefined;
  return chosen ?? wallets.find((wallet) => wallet.onProfile) ?? wallets.find((wallet) => wallet.tradable) ?? wallets[0] ?? null;
}

export interface WalletMove {
  readonly action: PolymarketWalletAction;
  readonly asset: "pUSD" | "USDC.e";
  /** As typed. */
  readonly amount: string;
}

const MOVE_INPUT = /^\d{1,9}(?:\.\d{1,6})?$/u;

/** What keeps a wallet move from being prepared (empty: it can be). */
export function moveProblems(move: WalletMove, wallet: Pick<PolymarketWallet, "actions"> | null): string[] {
  const problems: string[] = [];
  if (!wallet) return ["Pick your Polymarket wallet."];
  if (!wallet.actions.includes(move.action)) problems.push("Kletia does not build this move for this wallet; do it on polymarket.com.");
  if (move.action === "wrap" && move.asset !== "USDC.e") problems.push("Wrapping turns USDC.e into pUSD.");
  const amount = move.amount.trim();
  if (!MOVE_INPUT.test(amount) || !(Number(amount) > 0)) problems.push("Enter a positive amount (up to 6 decimals).");
  return problems;
}

export interface OpenOrderRow {
  readonly id: string;
  readonly side: string;
  readonly outcome: string;
  readonly price: string;
  readonly filled: string;
  readonly status: string;
}

/** Open orders as rows: side and outcome, limit price, filled of total shares. */
export function openOrderRows(orders: readonly { readonly id: string; readonly status: string; readonly outcome: string | null; readonly side: "buy" | "sell" | null; readonly price: number | null; readonly shares: number | null; readonly filledShares: number | null }[]): OpenOrderRow[] {
  return orders.map((order) => ({
    id: order.id,
    side: order.side === "sell" ? "Sell" : order.side === "buy" ? "Buy" : "-",
    outcome: order.outcome ?? "-",
    price: formatCents(order.price),
    filled: `${formatShares(order.filledShares ?? 0)} of ${order.shares === null ? "-" : formatShares(order.shares)}`,
    status: order.status.toLowerCase(),
  }));
}

/* -------------------------------------------------------------- location */

/** The location note: what Polymarket answered for this browser (null: it could not be checked). */
export function locationNote(answer: { readonly blocked: boolean; readonly country: string | null; readonly region: string | null } | null): { readonly tone: "info" | "warning"; readonly text: string; readonly canBuy: boolean } {
  if (answer === null) return { tone: "warning", text: "Polymarket's location check did not answer, so buying stays off. Selling and redeeming still work.", canBuy: false };
  const where = [answer.country, answer.region].filter(Boolean).join("-") || "your location";
  if (answer.blocked) return { tone: "warning", text: `Polymarket reports ${where} as restricted for new orders. Kletia does not work around that: buying is off; closing positions may still work.`, canBuy: false };
  return { tone: "info", text: `Polymarket's location check passed for this browser (${where}). Its terms still apply to you.`, canBuy: true };
}

/* ---------------------------------------------------------- signing run */

export type StepState = "waiting" | "signing" | "confirming" | "relaying" | "done" | "failed";

export interface RunState {
  readonly steps: readonly PredictionStep[];
  readonly states: readonly StepState[];
  readonly error: string | null;
  /** The venue's answer to the relayed order. */
  readonly result: string | null;
}

export function startRun(steps: readonly PredictionStep[]): RunState {
  return { steps, states: steps.map(() => "waiting"), error: null, result: null };
}

/** The next step to act on, or -1 when every step is done (or one failed). */
export function nextStep(run: RunState): number {
  if (run.states.includes("failed")) return -1;
  return run.states.findIndex((state) => state !== "done");
}

export function withStepState(run: RunState, index: number, state: StepState, error: string | null = null): RunState {
  return { ...run, states: run.states.map((current, at) => (at === index ? state : current)), error: state === "failed" ? error : run.error };
}

/** What the order's answer means for the person ("matched" filled now; "live" rests on the book). */
export function orderStatusLine(status: string): string {
  switch (status) {
    case "matched":
      return "Filled: the shares are on their way to your wallet.";
    case "live":
      return "Placed: the order rests on the book until someone takes it or you cancel it.";
    case "delayed":
      return "Accepted: this market waits a few seconds before matching.";
    case "unmatched":
      return "Accepted, but nothing matched; the unfilled part was cancelled.";
    default:
      return `Polymarket answered: ${status}.`;
  }
}
