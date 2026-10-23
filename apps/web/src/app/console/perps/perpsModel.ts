/**
 * The Perps view as pure functions (no React, no wallet): the ticket and the
 * request it sends, the client-side checks the API repeats, the market table
 * grouped by symbol, position rows with PnL and liquidation distance, the
 * account each venue signs with, and the signing run's step states. Node
 * tests load it directly.
 */
import {
  PERPS_LIMITS,
  type PerpsMarket,
  type PerpsPosition,
  type PerpsRequest,
  type PerpsSide,
  type PerpsStep,
  type PerpsVenue,
  type PerpsVenueId,
} from "@kletia/core";

/** Arbitrum One and Solana mainnet as CAIP-2 ids (the venues' networks). */
const CAIP2: Readonly<Record<string, string>> = Object.freeze({ arbitrum: "eip155:42161", solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" });

export interface PerpsTicket {
  readonly symbol: string;
  readonly side: PerpsSide;
  /** "best": the scorer picks (quote), then the ticket pins its choice for prepare. */
  readonly venue: PerpsVenueId | "best";
  /** USDC, as typed. */
  readonly collateral: string;
  readonly leverage: number;
  readonly slippageBps: number;
}

export const DEFAULT_TICKET: PerpsTicket = Object.freeze({ symbol: "ETH", side: "long", venue: "best", collateral: "", leverage: 2, slippageBps: PERPS_LIMITS.defaultSlippageBps });

const USD_INPUT = /^\d{1,9}(?:\.\d{1,6})?$/u;

/** The decimal the user typed, normalised ("1,5" is refused, "100." becomes "100"), or null. */
export function collateralAmount(text: string): string | null {
  const trimmed = text.trim().replace(/\.$/u, "");
  return USD_INPUT.test(trimmed) && Number(trimmed) > 0 ? trimmed : null;
}

/** Position size the ticket asks for, in USD. */
export function ticketSizeUsd(ticket: PerpsTicket): number {
  const amount = collateralAmount(ticket.collateral);
  return amount === null ? 0 : Math.round(Number(amount) * ticket.leverage * 100) / 100;
}

/** The body of POST /v1/perps/quote and /prepare for the ticket (venue pinned for prepare). */
export function ticketRequest(ticket: PerpsTicket, venue: PerpsVenueId | null, account: string | null): PerpsRequest {
  return {
    action: "open",
    symbol: ticket.symbol,
    side: ticket.side,
    ...(venue ? { venue } : {}),
    collateral: { asset: "USDC", amount: collateralAmount(ticket.collateral) ?? "0" },
    leverage: ticket.leverage,
    slippageBps: ticket.slippageBps,
    ...(account ? { account } : {}),
  };
}

/** Highest leverage the slider offers: the venue's (and its market's) cap, never above the default rule book cap. */
export function leverageCap(venues: readonly PerpsVenue[], markets: readonly PerpsMarket[], ticket: Pick<PerpsTicket, "symbol" | "venue">): number {
  const caps = venues
    .filter((venue) => venue.enabled && (ticket.venue === "best" || venue.id === ticket.venue))
    .flatMap((venue) => markets.filter((market) => market.venue === venue.id && market.symbol === ticket.symbol).map((market) => Math.min(venue.maxLeverage, market.maxLeverage)));
  return Math.max(1, Math.min(PERPS_LIMITS.defaultMaxLeverage, ...(caps.length > 0 ? [Math.max(...caps)] : [1])));
}

/** What keeps the ticket from quoting (empty: it can quote). The API checks the same and more. */
export function ticketProblems(ticket: PerpsTicket, venues: readonly PerpsVenue[], markets: readonly PerpsMarket[]): string[] {
  const problems: string[] = [];
  const amount = collateralAmount(ticket.collateral);
  if (amount === null) problems.push("Enter the USDC collateral.");
  const venue = ticket.venue === "best" ? null : venues.find((entry) => entry.id === ticket.venue) ?? null;
  if (venue && !venue.enabled) return [...problems, `${venue.name} is read-only in Kletia.`];
  const cap = leverageCap(venues, markets, ticket);
  if (ticket.leverage > cap) problems.push(`Leverage is above the ${cap}x cap here.`);
  if (venue && amount !== null && Number(amount) < venue.minCollateralUsd) problems.push(`${venue.name} needs at least ${venue.minCollateralUsd} USDC of collateral.`);
  if (venue && amount !== null && ticketSizeUsd(ticket) < venue.minSizeUsd) problems.push(`${venue.name} needs a position of at least ${venue.minSizeUsd} USD.`);
  return problems;
}

/** The CAIP-10 account a venue signs with, from the connected wallets (null: connect one). */
export function perpsAccountFor(venue: Pick<PerpsVenue, "network">, wallets: { readonly evm: string | null; readonly solana: string | null }): string | null {
  const address = venue.network === "solana" ? wallets.solana : wallets.evm;
  return address ? `${CAIP2[venue.network]}:${address}` : null;
}

/* -------------------------------------------------------------- markets */

export interface MarketRow {
  readonly key: string;
  readonly symbol: string;
  readonly venue: PerpsVenueId;
  readonly venueName: string;
  readonly mark: string;
  readonly funding: string;
  /** "pays" when longs pay, "earns" when they receive. */
  readonly fundingTone: "pays" | "earns" | "flat";
  readonly openInterest: string;
  readonly open: boolean;
}

export function formatPrice(price: number): string {
  if (!Number.isFinite(price)) return "-";
  const digits = price >= 1000 ? 2 : price >= 1 ? 4 : 6;
  return `$${price.toLocaleString("en-US", { minimumFractionDigits: Math.min(2, digits), maximumFractionDigits: digits })}`;
}

export function formatUsd(value: number): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Signed USD for PnL ("+$12.30", "-$4.00"). */
export function formatPnl(value: number): string {
  return value > 0 ? `+${formatUsd(value)}` : formatUsd(value);
}

/** A fraction per hour as a signed percentage ("+0.0013%"). */
export function formatRate(rate: number): string {
  const pct = rate * 100;
  return `${pct > 0 ? "+" : ""}${pct.toFixed(4)}%`;
}

export function formatCompactUsd(value: number): string {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return formatUsd(value);
}

/** One row per market and venue, by symbol, then cheapest funding for longs first. */
export function marketRows(markets: readonly PerpsMarket[], venues: readonly PerpsVenue[]): MarketRow[] {
  return [...markets]
    .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.fundingRate1h.long - b.fundingRate1h.long)
    .map((market) => ({
      key: `${market.venue}:${market.marketId}`,
      symbol: market.symbol,
      venue: market.venue,
      venueName: venues.find((venue) => venue.id === market.venue)?.name ?? market.venue,
      mark: formatPrice(market.markPrice),
      funding: formatRate(market.fundingRate1h.long),
      fundingTone: market.fundingRate1h.long > 0 ? "pays" : market.fundingRate1h.long < 0 ? "earns" : "flat",
      openInterest: market.openInterestUsd ? formatCompactUsd(market.openInterestUsd.long + market.openInterestUsd.short) : "-",
      open: market.open,
    }));
}

/** Symbols the ticket offers: those with at least one venue price. */
export function tradableSymbols(markets: readonly PerpsMarket[]): string[] {
  return [...new Set(markets.filter((market) => market.open).map((market) => market.symbol))].sort();
}

/* ------------------------------------------------------------ positions */

export interface PositionRow {
  readonly key: string;
  readonly venue: PerpsVenueId;
  readonly venueName: string;
  readonly symbol: string;
  readonly side: PerpsSide;
  readonly size: string;
  readonly entry: string;
  readonly mark: string;
  readonly liquidation: string;
  /** How far the mark is from liquidation, as a percentage of the mark; null when unknown. */
  readonly liquidationDistancePct: number | null;
  /** Below 5%: the row warns. */
  readonly nearLiquidation: boolean;
  readonly pnl: string;
  readonly pnlTone: "gain" | "loss" | "flat" | "unknown";
  /** Kletia can build a close for this venue (enabled venues only). */
  readonly closable: boolean;
}

export function positionRows(positions: readonly PerpsPosition[], venues: readonly PerpsVenue[]): PositionRow[] {
  return positions.map((position) => {
    const venue = venues.find((entry) => entry.id === position.venue);
    const distance = position.liquidationPrice !== null && position.markPrice !== null && position.markPrice > 0
      ? (Math.abs(position.markPrice - position.liquidationPrice) / position.markPrice) * 100
      : null;
    const pnl = position.unrealizedPnlUsd;
    return {
      key: `${position.venue}:${position.marketId}:${position.side}`,
      venue: position.venue,
      venueName: venue?.name ?? position.venue,
      symbol: position.symbol,
      side: position.side,
      size: `${formatUsd(position.sizeUsd)} (${position.sizeBase.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${position.symbol})`,
      entry: formatPrice(position.entryPrice),
      mark: position.markPrice === null ? "-" : formatPrice(position.markPrice),
      liquidation: position.liquidationPrice === null ? "-" : formatPrice(position.liquidationPrice),
      liquidationDistancePct: distance,
      nearLiquidation: distance !== null && distance < 5,
      pnl: pnl === null ? "-" : formatPnl(pnl),
      pnlTone: pnl === null ? "unknown" : pnl > 0 ? "gain" : pnl < 0 ? "loss" : "flat",
      closable: venue?.enabled === true,
    };
  });
}

/** Close or halve a position (the API reads the exact size itself on close). */
export function positionRequest(position: Pick<PerpsPosition, "venue" | "symbol" | "side" | "sizeUsd">, action: "close" | "reduce", account: string): PerpsRequest {
  return {
    action: action === "close" ? "close" : "decrease",
    symbol: position.symbol,
    side: position.side,
    venue: position.venue,
    ...(action === "reduce" ? { sizeUsd: (Math.floor((position.sizeUsd / 2) * 100) / 100).toFixed(2) } : {}),
    account,
  };
}

/* ---------------------------------------------------------- signing run */

export type StepState = "waiting" | "signing" | "confirming" | "relaying" | "settling" | "done" | "failed";

export interface RunState {
  readonly steps: readonly PerpsStep[];
  readonly states: readonly StepState[];
  readonly error: string | null;
}

export function startRun(steps: readonly PerpsStep[]): RunState {
  return { steps, states: steps.map(() => "waiting"), error: null };
}

/** The next step to act on, or -1 when every step is done (or one failed). */
export function nextStep(run: RunState): number {
  if (run.states.includes("failed")) return -1;
  return run.states.findIndex((state) => state !== "done");
}

export function withStepState(run: RunState, index: number, state: StepState, error: string | null = null): RunState {
  return { ...run, states: run.states.map((current, at) => (at === index ? state : current)), error: state === "failed" ? error : run.error };
}

/** True when the prepared steps are past their validity (prices and nonces moved). */
export function preparedExpired(expiresAt: number, nowMs: number): boolean {
  return nowMs / 1000 >= expiresAt;
}
