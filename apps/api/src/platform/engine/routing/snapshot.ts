/**
 * The plan record's view of route choices (design B.2, B.5, D.1; I9): one
 * `interpretation.routes[]` entry per auctioned step, carrying the score of
 * the chosen route, the other venues compared (scored, or why they were
 * excluded) and the snapshot of every score input, so "the same plan" is
 * checkable over it. Explanations are Kletia's own templates, never a
 * model's. Also `interpretation.providersContacted`: every provider that
 * received a quote request for the plan, and whether it saw the person's
 * account.
 *
 * Minimums are worded by how they are enforced (D1): "guaranteed minimum
 * (enforced on-chain)" for on-chain floors, "quoted minimum" for a
 * provider's promise.
 */
import {
  getProtocol,
  type IntentStep,
  type ProtocolId,
  type ProviderContact,
  type RouteChoice,
  type RouteShape,
  type RouteSnapshot,
} from "@kletia/core";
import type { AuctionResult, QuoteContact, VenueQuote } from "../auction.js";
import { exclusionReason } from "../auction.js";

/** At most this many compared entries per route (D.1). */
const MAX_COMPARED = 6;
const MAX_REASON = 200;

/** The snapshot as recorded: the core fields plus the fill rates, prices and mode the score used (I9). */
export interface RecordedSnapshot extends RouteSnapshot {
  readonly fillRates: Readonly<Record<string, number>>;
  readonly prices: Readonly<Record<string, number>>;
  readonly mode: "usd" | "units";
}

function venueName(protocol: ProtocolId): string {
  return getProtocol(protocol)?.name ?? protocol;
}

/** The route shape of an auctioned step. */
export function shapeOf(step: Pick<IntentStep, "kind" | "network" | "protocol" | "input" | "minimumOutput"> & { readonly settlement?: IntentStep["settlement"] }): RouteShape {
  if (step.protocol === "wrap") return "wrap";
  const destination = step.settlement?.destinationNetwork;
  if (step.kind === "bridge" && destination && destination !== step.network) {
    const same = step.input?.symbol !== undefined && step.minimumOutput?.symbol !== undefined && step.input.symbol.toUpperCase() === step.minimumOutput.symbol.toUpperCase();
    return same ? "bridge" : "one-shot";
  }
  return "single";
}

function minimumWords(quote: VenueQuote): string {
  return quote.planned.floor === "onchain" ? "guaranteed minimum (enforced on-chain)" : "quoted minimum";
}

function money(value: number): string {
  return `$${Math.abs(value).toFixed(2)}`;
}

function seconds(value: number): string {
  return value >= 120 ? `${Math.round(value / 60)} min` : `${value} s`;
}

/** Kletia's template for why the winner won (<= 200 characters). */
export function routeReason(winner: VenueQuote, runnerUp: VenueQuote | undefined, mode: "usd" | "units"): string {
  const name = venueName(winner.protocol);
  const minimum = `${winner.planned.minimumOutput.formatted} ${winner.planned.minimumOutput.symbol} ${minimumWords(winner)}`;
  if (!runnerUp || runnerUp.excluded !== undefined || mode === "units") {
    return `${name}: ${minimum}; about ${seconds(winner.planned.estimatedSeconds)}.`.slice(0, MAX_REASON);
  }
  const delta = winner.value - runnerUp.value;
  const time = `about ${seconds(winner.planned.estimatedSeconds)} instead of ${seconds(runnerUp.planned.estimatedSeconds)}`;
  const comparison = delta >= 0.005
    ? `Delivers about ${money(delta)} more than ${venueName(runnerUp.protocol)} after costs`
    : `Ties ${venueName(runnerUp.protocol)} on value after costs`;
  return `${name}: ${comparison}; ${time}; ${minimum}.`.slice(0, MAX_REASON);
}

/** One `interpretation.routes[]` entry for an auctioned step. */
export function routeChoice(step: IntentStep, auction: AuctionResult): RouteChoice {
  const winner = auction.winner;
  const runnerUp = auction.losers.find((quote) => quote.excluded === undefined && !quote.estimate);
  const compared = [
    ...auction.losers.map((quote) => ({
      label: venueName(quote.protocol),
      ...(quote.excluded === undefined ? { score: quote.score } : { excluded: exclusionReason(quote) ?? "not eligible" }),
    })),
    ...auction.failures.map((failure) => ({
      label: venueName(failure.protocol),
      excluded: failure.cut ? "did not answer in time" : failure.skipped ? "failing right now (skipped)" : failure.error.code === "PROVIDER_RATE_LIMITED" ? "rate limited" : `could not quote (${failure.error.code})`,
    })),
  ].slice(0, MAX_COMPARED);
  const snapshot: RecordedSnapshot = {
    quotes: auction.snapshot.quotes.map(({ estimate: _estimate, ...quote }) => quote),
    cutByDeadline: auction.snapshot.cutByDeadline,
    breakerSkipped: auction.snapshot.breakerSkipped,
    haircutsBps: auction.snapshot.haircutsBps,
    gas: auction.snapshot.gas,
    fillRates: auction.snapshot.fillRates,
    prices: auction.snapshot.prices,
    mode: auction.snapshot.mode,
  };
  return {
    steps: [step.id],
    shape: shapeOf(step),
    venues: [winner.protocol],
    score: winner.score,
    reason: routeReason(winner, runnerUp, auction.snapshot.mode),
    compared,
    alternatives: [],
    snapshot,
  };
}

/**
 * The provider that sees a quote request of a venue, and whether the request
 * carries the account: API-routed venues send it (Raydium, Orca and Meteora
 * through Jupiter's API); CCTP's fee API does not; venues quoted on-chain
 * (DEX quoters, lending and staking reads) contact no provider.
 */
const PROVIDER_OF: Readonly<Partial<Record<ProtocolId, { readonly provider: ProtocolId; readonly account: boolean }>>> = Object.freeze({
  relay: { provider: "relay", account: true },
  lifi: { provider: "lifi", account: true },
  "debridge-dln": { provider: "debridge-dln", account: true },
  across: { provider: "across", account: true },
  "cctp-v2": { provider: "cctp-v2", account: false },
  jupiter: { provider: "jupiter", account: true },
  raydium: { provider: "jupiter", account: true },
  orca: { provider: "jupiter", account: true },
  meteora: { provider: "jupiter", account: true },
  "jupiter-lend": { provider: "jupiter-lend", account: true },
  kamino: { provider: "kamino", account: true },
});

/** `interpretation.providersContacted` from every quote request of a plan (deduplicated, in first-contact order). */
export function providersContacted(contacts: readonly QuoteContact[]): ProviderContact[] {
  const seen = new Map<ProtocolId, boolean>();
  for (const contact of contacts) {
    const entry = PROVIDER_OF[contact.protocol];
    if (!entry) continue;
    const saw = entry.account && contact.sawAccount;
    seen.set(entry.provider, (seen.get(entry.provider) ?? false) || saw);
  }
  return [...seen.entries()].map(([provider, sawAccount]) => ({ provider, sawAccount }));
}
