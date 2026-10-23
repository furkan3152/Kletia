/**
 * The desk's Perps view (/app/perps): venue markets with mark price, funding
 * and open interest; an order ticket (long or short, USDC collateral,
 * leverage slider, venue picker defaulting to the best venue) that quotes
 * the estimated liquidation price and fees; and the connected wallets'
 * positions with close and reduce. Orders are built by /v1/perps and signed
 * step by step in the user's wallet (usePerpsRun). One column at every
 * width (markets, ticket, positions; the desk column is too narrow for two);
 * nothing scrolls sideways.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { IntentHandoff, PerpsPosition, PerpsVenueId } from "@kletia/core";

import { toPlatformError, type PlatformError } from "../../../shared/platform/kletiaClient";
import { useWallets } from "../../../shared/wallet/useWallets";
import { ApiErrorPanel } from "../../site/ui/ApiErrorPanel";
import { Button } from "../../site/ui/Button";
import { cx, LABEL, TEXT_MUTED } from "../../site/ui/styles";
import { useDeskActions } from "../shell/deskContext";
import { ViewEmpty, ViewHeader, ViewLoading, ViewNote } from "../shell/ViewParts";
import { PANEL_TITLE, VIEW_FIELD, VIEW_PANEL } from "../shell/viewStyles";
import { perpsApi, type PerpsMarketsResponse, type PerpsPositionsResponse, type PerpsQuoteResponse } from "./perpsApi";
import { PERPS_COPY } from "./perpsCopy";
import {
  DEFAULT_TICKET,
  formatPrice,
  formatRate,
  formatUsd,
  leverageCap,
  marketRows,
  nextStep,
  perpsAccountFor,
  positionRequest,
  positionRows,
  ticketProblems,
  ticketRequest,
  ticketSizeUsd,
  tradableSymbols,
  type PerpsTicket,
} from "./perpsModel";
import { usePerpsRun } from "./usePerpsRun";
import { perpsPrefill } from "../handoff/handoffModel";
import { HandoffNote } from "../handoff/HandoffNote";
import { useHandoff } from "../handoff/useHandoff";

const copy = PERPS_COPY;
const PANEL = VIEW_PANEL;
const FIELD = VIEW_FIELD;
const SLIPPAGE_OPTIONS = [30, 50, 100] as const;

/** Market rows: three values under the name on phones, one row with a header from 640 px. */
const MARKET_GRID = "grid grid-cols-3 items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(7rem,1.2fr)_repeat(3,minmax(0,1fr))_auto]";

/** One value of a market row; its label is visible on phones and read by screen readers everywhere. */
function MarketCell({ label, className, children }: { readonly label: string; readonly className?: string; readonly children: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className={cx(LABEL, TEXT_MUTED, "sm:sr-only")}>{label}</span>
      <span className={cx("break-words font-code", className)}>{children}</span>
    </span>
  );
}

function Row({ label, value, tone }: { readonly label: string; readonly value: string; readonly tone?: "warn" }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 border-b-2 border-dashed border-[var(--kl-line)] py-1.5 text-sm last:border-b-0">
      <dt className={TEXT_MUTED}>{label}</dt>
      <dd className={cx("font-code font-bold", tone === "warn" && "text-danger")}>{value}</dd>
    </div>
  );
}

export function PerpsView() {
  const wallets = useWallets();
  const actions = useDeskActions();
  const [data, setData] = useState<PerpsMarketsResponse | null>(null);
  const [marketsError, setMarketsError] = useState<PlatformError | null>(null);
  const [positions, setPositions] = useState<PerpsPositionsResponse[]>([]);
  const [ticket, setTicket] = useState<PerpsTicket>(DEFAULT_TICKET);
  const [quote, setQuote] = useState<PerpsQuoteResponse | null>(null);
  const [requestError, setRequestError] = useState<PlatformError | null>(null);
  const [pending, setPending] = useState<"quote" | "prepare" | null>(null);
  const [handoffNote, setHandoffNote] = useState<string | null>(null);
  useHandoff("perps", useCallback((handoff: IntentHandoff) => {
    if (handoff.surface !== "perps") return;
    const prefill = perpsPrefill(handoff.input);
    setTicket(prefill.ticket);
    setQuote(null);
    setHandoffNote(prefill.position ? `${handoff.summary}: use Close or Reduce on that position below.` : `${handoff.summary}: check the ticket, then quote and sign.`);
  }, []));

  const [marketsRead, setMarketsRead] = useState(0);
  const loadMarkets = useCallback(() => setMarketsRead((count) => count + 1), []);
  useEffect(() => {
    let live = true;
    perpsApi.markets().then(
      (next) => {
        if (!live) return;
        setData(next);
        setMarketsError(null);
      },
      (error: unknown) => {
        if (live) setMarketsError(toPlatformError(error));
      },
    );
    return () => {
      live = false;
    };
  }, [marketsRead]);

  const evm = wallets.evm?.address ?? null;
  const solana = wallets.solana?.address ?? null;
  const loadPositions = useCallback(() => {
    const accounts = [evm ? `eip155:42161:${evm}` : null, solana ? `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${solana}` : null].filter((entry): entry is string => entry !== null);
    Promise.allSettled(accounts.map((account) => perpsApi.positions(account))).then((results) =>
      setPositions(results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))),
    );
  }, [evm, solana]);
  useEffect(loadPositions, [loadPositions]);

  const run = usePerpsRun(loadPositions);
  const venues = useMemo(() => data?.venues ?? [], [data]);
  const markets = useMemo(() => data?.markets ?? [], [data]);
  const symbols = tradableSymbols(markets);
  const cap = leverageCap(venues, markets, ticket);
  const problems = data ? ticketProblems(ticket, venues, markets) : [];
  const chosenVenue = ticket.venue === "best" ? (quote?.best?.venue ?? null) : ticket.venue;
  const venueInfo = venues.find((venue) => venue.id === chosenVenue) ?? null;
  const account = venueInfo ? perpsAccountFor(venueInfo, { evm, solana }) : null;
  const rows = useMemo(() => marketRows(markets, venues), [markets, venues]);
  const positionList = useMemo(() => positions.flatMap((entry) => entry.positions), [positions]);

  const update = (patch: Partial<PerpsTicket>) => {
    setTicket((current) => ({ ...current, ...patch }));
    setQuote(null);
    setRequestError(null);
    run.reset();
  };

  const getQuote = async () => {
    setPending("quote");
    setRequestError(null);
    try {
      setQuote(await perpsApi.quote(ticketRequest(ticket, ticket.venue === "best" ? null : ticket.venue, null)));
    } catch (error) {
      setRequestError(toPlatformError(error));
    } finally {
      setPending(null);
    }
  };

  const prepare = async (request: Parameters<typeof perpsApi.prepare>[0]) => {
    setPending("prepare");
    setRequestError(null);
    try {
      run.begin(await perpsApi.prepare(request));
    } catch (error) {
      setRequestError(toPlatformError(error));
    } finally {
      setPending(null);
    }
  };

  const managePosition = (position: PerpsPosition, kind: "close" | "reduce") => {
    const venue = venues.find((entry) => entry.id === position.venue);
    const owner = venue ? perpsAccountFor(venue, { evm, solana }) : null;
    if (owner) void prepare(positionRequest(position, kind, owner));
  };

  const best = quote?.best?.quote ?? null;
  const step = run.run ? nextStep(run.run) : -1;

  return (
    <section aria-labelledby="perps-heading" className="flex min-w-0 flex-col gap-4 pb-8">
      <ViewHeader id="perps-heading" title={copy.heading} intro={copy.intro} />
      <HandoffNote text={handoffNote} />

      <aside aria-labelledby="perps-risk">
        <ViewNote tone="warning">
          <h3 id="perps-risk" className={cx(LABEL, "mb-2")}>{copy.risk.heading}</h3>
          <ul className="list-disc space-y-1 pl-5">
            {copy.risk.lines.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </ViewNote>
      </aside>

      <div className="flex min-w-0 flex-col gap-4">
        <section aria-labelledby="perps-markets" className={PANEL}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="perps-markets" className={PANEL_TITLE}>{copy.markets.heading}</h3>
            <Button variant="secondary" size="sm" onClick={loadMarkets}>{copy.markets.refresh}</Button>
          </div>
          {marketsError ? <ApiErrorPanel error={marketsError} onRetry={loadMarkets} /> : null}
          {!data && !marketsError ? <ViewLoading>{copy.markets.loading}</ViewLoading> : null}
          {data && rows.length === 0 ? <ViewEmpty>{copy.markets.empty}</ViewEmpty> : null}
          {rows.length > 0 ? (
            <div aria-hidden="true" className={cx(MARKET_GRID, "hidden border-b-2 border-[var(--kl-line)] pb-1 sm:grid", LABEL, TEXT_MUTED)}>
              <span>{copy.markets.market}</span>
              <span>{copy.markets.mark}</span>
              <span>{copy.markets.fundingShort}</span>
              <span>{copy.markets.openInterest}</span>
              <span />
            </div>
          ) : null}
          <ul className="flex flex-col">
            {rows.map((row) => (
              <li key={row.key} className={cx(MARKET_GRID, "border-b-2 border-[var(--kl-line)] py-2 text-sm last:border-b-0")}>
                <span className="col-span-3 font-bold sm:col-span-1">{row.symbol} <span className={cx("font-normal", TEXT_MUTED)}>{row.venueName}</span></span>
                <MarketCell label={copy.markets.mark}>{row.mark}</MarketCell>
                <MarketCell label={copy.markets.fundingShort} className={row.fundingTone === "pays" ? "text-danger" : row.fundingTone === "earns" ? "text-success" : ""}>
                  {row.funding}
                </MarketCell>
                <MarketCell label={copy.markets.openInterest}>{row.openInterest}</MarketCell>
                <Button variant="secondary" size="sm" className="col-span-3 sm:col-span-1" disabled={!row.open} aria-label={copy.markets.choose(row.symbol, row.venueName)} onClick={() => update({ symbol: row.symbol, venue: row.venue })}>
                  {copy.markets.trade}
                </Button>
              </li>
            ))}
          </ul>
          {(data?.unavailable ?? []).map((entry) => (
            <ViewNote key={entry.venue}>{copy.markets.unavailable(venues.find((venue) => venue.id === entry.venue)?.name ?? entry.venue, entry.message)}</ViewNote>
          ))}
          {venues.filter((venue) => !venue.enabled).map((venue) => (
            <ViewNote key={venue.id}>{copy.markets.disabled(venue.name)} {venue.disabledReason}</ViewNote>
          ))}
        </section>

        <section aria-labelledby="perps-ticket" className={PANEL}>
          <h3 id="perps-ticket" className={PANEL_TITLE}>{copy.ticket.heading}</h3>
          <fieldset className="flex gap-2">
            <legend className={cx(LABEL, "mb-1")}>{copy.ticket.sideLabel}</legend>
            {(["long", "short"] as const).map((side) => (
              <Button key={side} className="flex-1" variant={ticket.side === side ? "primary" : "secondary"} aria-pressed={ticket.side === side} onClick={() => update({ side })}>
                {side === "long" ? copy.ticket.long : copy.ticket.short}
              </Button>
            ))}
          </fieldset>
          <label className="flex flex-col gap-1">
            <span className={LABEL}>{copy.ticket.marketLabel}</span>
            <select className={FIELD} value={ticket.symbol} onChange={(event) => update({ symbol: event.target.value })}>
              {(symbols.length > 0 ? symbols : [ticket.symbol]).map((symbol) => <option key={symbol} value={symbol}>{symbol}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className={LABEL}>{copy.ticket.venueLabel}</span>
            <select className={FIELD} value={ticket.venue} onChange={(event) => update({ venue: event.target.value as PerpsVenueId | "best" })}>
              <option value="best">{quote?.best && ticket.venue === "best" ? copy.ticket.bestVenueNamed(venues.find((venue) => venue.id === quote.best!.venue)?.name ?? "") : copy.ticket.bestVenue}</option>
              {venues.map((venue) => <option key={venue.id} value={venue.id} disabled={!venue.enabled}>{venue.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className={LABEL}>{copy.ticket.collateralLabel} ({copy.ticket.collateralAsset})</span>
            <input className={FIELD} inputMode="decimal" autoComplete="off" placeholder="100" value={ticket.collateral} onChange={(event) => update({ collateral: event.target.value })} aria-describedby="perps-collateral-hint" />
            <span id="perps-collateral-hint" className={cx("text-xs", TEXT_MUTED)}>{copy.ticket.collateralHint}</span>
          </label>
          <label className="flex flex-col gap-1">
            <span className={LABEL}>{copy.ticket.leverageLabel(String(ticket.leverage))}</span>
            <input type="range" min={1} max={cap} step={1} value={Math.min(ticket.leverage, cap)} onChange={(event) => update({ leverage: Number(event.target.value) })} className="min-h-11 w-full accent-[var(--kl-focus)]" />
            <span className={cx("text-xs", TEXT_MUTED)}>{copy.ticket.sizeLabel}: {formatUsd(ticketSizeUsd(ticket))}</span>
          </label>
          <label className="flex flex-col gap-1">
            <span className={LABEL}>{copy.ticket.slippageLabel}</span>
            <select className={FIELD} value={ticket.slippageBps} onChange={(event) => update({ slippageBps: Number(event.target.value) })}>
              {SLIPPAGE_OPTIONS.map((bps) => <option key={bps} value={bps}>{(bps / 100).toFixed(1)}%</option>)}
            </select>
          </label>
          {problems.length > 0 ? <ul className="list-disc pl-5 text-sm">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul> : null}
          <Button variant="secondary" loading={pending === "quote"} disabled={problems.length > 0 || pending !== null} onClick={() => void getQuote()}>{copy.ticket.quote}</Button>

          {best ? (
            <dl aria-live="polite">
              <Row label={copy.ticket.sizeLabel} value={copy.ticket.sizeAt(formatUsd(best.sizeUsd), String(best.leverage))} />
              <Row label={copy.ticket.entry} value={formatPrice(best.entryPrice)} />
              <Row label={copy.ticket.acceptable} value={formatPrice(best.acceptablePrice)} />
              <Row label={copy.ticket.liquidation} value={best.liquidationPrice === null ? copy.ticket.noLiquidation : formatPrice(best.liquidationPrice)} tone="warn" />
              <Row label={copy.ticket.fees} value={`${formatUsd(best.fees.openUsd)} + ${formatUsd(best.fees.closeUsd)}`} />
              {best.fees.executionUsd !== null ? <Row label={copy.ticket.execution} value={formatUsd(best.fees.executionUsd)} /> : null}
              <Row label={copy.ticket.funding} value={`${formatUsd(best.funding1hUsd)} (${formatRate(best.funding1hUsd / Math.max(best.sizeUsd, 1))})`} />
            </dl>
          ) : null}
          {best?.warnings.map((warning) => <ViewNote key={warning} tone="warning">{warning}</ViewNote>)}
          {quote ? (
            <details className="text-sm">
              <summary className="min-h-11 cursor-pointer py-2 font-bold">{copy.ticket.whyVenue}</summary>
              <ul className="space-y-1">
                {quote.choices.map((choice) => {
                  const name = venues.find((venue) => venue.id === choice.venue)?.name ?? choice.venue;
                  return <li key={choice.venue}>{choice.eligible ? copy.ticket.choiceCost(name, formatUsd(choice.costUsd ?? 0)) : copy.ticket.notEligible(name, choice.reason ?? "")}</li>;
                })}
              </ul>
            </details>
          ) : null}
          {best && venueInfo && !account ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm">{copy.ticket.walletNeeded(venueInfo.network === "solana" ? "Solana" : "EVM")}</p>
              <Button variant="secondary" onClick={() => actions.openWallet(venueInfo.network === "solana" ? "solana" : "eip155")}>{copy.ticket.connect}</Button>
            </div>
          ) : null}
          {best && chosenVenue && account && !run.run ? (
            <Button loading={pending === "prepare"} disabled={pending !== null} onClick={() => void prepare(ticketRequest(ticket, chosenVenue, account))}>{copy.ticket.review}</Button>
          ) : null}
          {requestError ? <ApiErrorPanel error={requestError} /> : null}

          {run.run ? (
            <section aria-labelledby="perps-steps" className="flex flex-col gap-2 border-t-[3px] border-[var(--kl-line)] pt-3">
              <h4 id="perps-steps" className={LABEL}>{copy.steps.heading}</h4>
              {run.prepared?.warnings.map((warning) => <ViewNote key={warning} tone="warning">{warning}</ViewNote>)}
              <ol className="flex flex-col gap-1 text-sm">
                {run.run.steps.map((entry, index) => {
                  const state = run.run!.states[index];
                  return (
                    <li key={entry.id} className="flex flex-wrap justify-between gap-2">
                      <span>{index + 1}. {entry.title}</span>
                      <span className="font-bold" role="status">
                        {state === "signing" ? copy.steps.signing : state === "confirming" ? copy.steps.confirming : state === "relaying" ? copy.steps.relaying : state === "done" ? copy.steps.done : state === "failed" ? copy.steps.failed : ""}
                      </span>
                    </li>
                  );
                })}
              </ol>
              {run.settleLeft > 0 ? <p className="text-sm">{copy.steps.settle(String(run.settleLeft))}</p> : null}
              {run.run.error ? <ViewNote role="alert" tone="danger">{run.run.error}</ViewNote> : null}
              {step >= 0 ? (
                <Button loading={run.busy} disabled={run.settleLeft > 0} onClick={() => void run.advance()}>{step === 0 && run.run.states[0] === "waiting" ? copy.steps.start : copy.steps.continue}</Button>
              ) : run.run.error ? null : <p role="status" className="text-sm font-bold">{copy.steps.finished}</p>}
              <Button variant="ghost" size="sm" disabled={run.busy} onClick={run.reset}>{copy.steps.cancel}</Button>
            </section>
          ) : null}
        </section>

        <section aria-labelledby="perps-positions" className={PANEL}>
          <h3 id="perps-positions" className={PANEL_TITLE}>{copy.positions.heading}</h3>
          {!evm && !solana ? <ViewEmpty>{copy.positions.connect}</ViewEmpty> : null}
          {(evm || solana) && positionList.length === 0 ? <ViewEmpty>{copy.positions.none}</ViewEmpty> : null}
          <ul className="flex flex-col gap-3">
            {positionRows(positionList, venues).map((row, index) => (
              <li key={row.key} className={cx("border-2 p-3", row.nearLiquidation ? "border-danger" : "border-[var(--kl-line)]")}>
                <p className="font-bold">{row.symbol} {row.side === "long" ? copy.ticket.long : copy.ticket.short} <span className={cx("font-normal", TEXT_MUTED)}>{row.venueName}</span></p>
                <dl className="mt-1">
                  <Row label={copy.positions.size} value={row.size} />
                  <Row label={copy.positions.entry} value={row.entry} />
                  <Row label={copy.positions.mark} value={row.mark} />
                  <Row label={copy.positions.liquidation} value={row.liquidationDistancePct === null ? row.liquidation : copy.positions.away(row.liquidation, row.liquidationDistancePct.toFixed(1))} {...(row.nearLiquidation ? { tone: "warn" as const } : {})} />
                  <Row label={copy.positions.pnl} value={row.pnl} {...(row.pnlTone === "loss" ? { tone: "warn" as const } : {})} />
                </dl>
                {row.closable ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" disabled={pending !== null || run.busy} onClick={() => managePosition(positionList[index]!, "close")}>{copy.positions.close}</Button>
                    <Button size="sm" variant="ghost" disabled={pending !== null || run.busy} onClick={() => managePosition(positionList[index]!, "reduce")}>{copy.positions.reduce}</Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          {positions.flatMap((entry) => entry.unavailable).map((entry) => (
            <ViewNote key={entry.venue}>{copy.positions.unavailable(venues.find((venue) => venue.id === entry.venue)?.name ?? entry.venue)}</ViewNote>
          ))}
          {positions.some((entry) => entry.unsupported > 0) ? <p className={cx("mt-2 text-sm", TEXT_MUTED)}>{copy.positions.unsupported(String(positions.reduce((sum, entry) => sum + entry.unsupported, 0)))}</p> : null}
          {positionList.length > 0 ? <p className={cx("mt-2 text-xs", TEXT_MUTED)}>{copy.positions.pnlNote}</p> : null}
        </section>
      </div>
    </section>
  );
}

export default PerpsView;
