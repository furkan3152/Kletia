/**
 * The desk's Perps view (/app/perps), in the Card machine language: the instrument on the left
 * (market picker, live mark, the price tape this browser read with the entry and liquidation levels
 * of the quote, then positions and venue markets) and one ticket on the right (Long/Short, USDC
 * collateral, the leverage fader, the venue as cartridges, slippage, three facts and one computed
 * risk sentence, one key). Orders are built by /v1/perps and signed step by step in the user's
 * wallet (usePerpsRun). One column on phones; nothing scrolls sideways.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { IntentHandoff, PerpsPosition, PerpsVenueId } from "@kletia/core";

import { toPlatformError, type PlatformError } from "../../../shared/platform/kletiaClient";
import { useWallets } from "../../../shared/wallet/useWallets";
import { Cartridges, Fader, Field, Key, Segmented, networkIcon, type CartridgeOption } from "../../kit";
import { ApiErrorPanel } from "../../site/ui/ApiErrorPanel";
import { Button } from "../../site/ui/Button";
import { useDeskActions } from "../shell/deskContext";
import { ViewEmpty, ViewFacts, ViewHeader, ViewLoading, ViewNote } from "../shell/ViewParts";
import { InstrumentHead, PriceTape, SideSwitch, SigningStrip, Ticket, TradeLayout, type StripState } from "../trade/TradeParts";
import { addTapePoint, tapeSince, type TapeLevel, type TapePoint } from "../trade/tapeModel";
import { perpsApi, type PerpsMarketsResponse, type PerpsPositionsResponse, type PerpsQuoteResponse } from "./perpsApi";
import { PERPS_COPY } from "./perpsCopy";
import {
  DEFAULT_TICKET,
  formatCompactUsd,
  formatPrice,
  formatRate,
  formatUsd,
  leverageCap,
  leverageDetents,
  liquidationMove,
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
  type StepState,
} from "./perpsModel";
import { usePerpsRun } from "./usePerpsRun";
import { perpsPrefill } from "../handoff/handoffModel";
import { HandoffNote } from "../handoff/HandoffNote";
import { useHandoff } from "../handoff/useHandoff";

const copy = PERPS_COPY;
const SLIPPAGE_OPTIONS = [30, 50, 100] as const;
/** How often the open view reads the venues' mark prices again (the tape), while the tab is visible. */
const TAPE_EVERY_S = 20;
const TAPE_KEY = "kletia-perps-tape";

type Tapes = Readonly<Record<string, readonly TapePoint[]>>;

function readTapes(): Tapes {
  try {
    const raw = sessionStorage.getItem(TAPE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as Tapes) : {};
  } catch {
    return {};
  }
}

function writeTapes(tapes: Tapes): void {
  try {
    sessionStorage.setItem(TAPE_KEY, JSON.stringify(tapes));
  } catch {
    /* private mode: the tape lives for this view only */
  }
}

function stepWord(state: StepState | undefined): string {
  switch (state) {
    case "signing":
      return copy.steps.signing;
    case "confirming":
      return copy.steps.confirming;
    case "relaying":
      return copy.steps.relaying;
    case "done":
      return copy.steps.done;
    case "failed":
      return copy.steps.failed;
    default:
      return "";
  }
}

function stripState(state: StepState | undefined): StripState {
  if (state === "done") return "done";
  if (state === "failed") return "failed";
  if (state === "signing" || state === "confirming" || state === "relaying" || state === "settling") return "active";
  return "waiting";
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
  const [tapes, setTapes] = useState<Tapes>(readTapes);
  const [list, setList] = useState<"positions" | "markets">("markets");
  useHandoff("perps", useCallback((handoff: IntentHandoff) => {
    if (handoff.surface !== "perps") return;
    const prefill = perpsPrefill(handoff.input);
    setTicket(prefill.ticket);
    setQuote(null);
    if (prefill.position) setList("positions");
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
        // Every read is a point on the tape of each market (the reads this browser made, nothing back-filled).
        setTapes((current) => {
          const updated: Record<string, readonly TapePoint[]> = { ...current };
          for (const market of next.markets) {
            const key = `${market.venue}:${market.symbol}`;
            updated[key] = addTapePoint(current[key] ?? [], { t: market.observedAt * 1000 > Date.now() - 86_400_000 ? market.observedAt * 1000 : Date.now(), p: market.markPrice });
          }
          writeTapes(updated);
          return updated;
        });
      },
      (error: unknown) => {
        if (live) setMarketsError(toPlatformError(error));
      },
    );
    return () => {
      live = false;
    };
  }, [marketsRead]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") loadMarkets();
    }, TAPE_EVERY_S * 1000);
    return () => window.clearInterval(timer);
  }, [loadMarkets]);

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
  const shownList = positionList.length > 0 || list === "positions" ? list : "markets";

  // The instrument: the chosen venue's market, else the deepest open market for the symbol.
  const instrument = useMemo(() => {
    const forSymbol = markets.filter((market) => market.symbol === ticket.symbol);
    const pinned = chosenVenue ? forSymbol.find((market) => market.venue === chosenVenue) : undefined;
    const depth = (market: (typeof forSymbol)[number]) => (market.openInterestUsd ? market.openInterestUsd.long + market.openInterestUsd.short : 0);
    return pinned ?? [...forSymbol].sort((a, b) => depth(b) - depth(a))[0] ?? null;
  }, [chosenVenue, markets, ticket.symbol]);
  const instrumentVenue = instrument ? (venues.find((venue) => venue.id === instrument.venue) ?? null) : null;
  const tape = instrument ? (tapes[`${instrument.venue}:${instrument.symbol}`] ?? []) : [];

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
  const sizeUsd = ticketSizeUsd(ticket);
  const move = best ? liquidationMove(best.entryPrice, best.liquidationPrice) : null;
  const levels: TapeLevel[] = [];
  if (instrument) levels.push({ id: "mark", label: copy.tape.mark(formatPrice(instrument.markPrice)), price: instrument.markPrice, tone: "mark" });
  if (best) levels.push({ id: "entry", label: copy.tape.entry(formatPrice(best.entryPrice)), price: best.entryPrice, tone: "entry" });
  if (best?.liquidationPrice) levels.push({ id: "liq", label: copy.tape.liquidation(formatPrice(best.liquidationPrice)), price: best.liquidationPrice, tone: "liq" });

  const venueOptions: CartridgeOption<PerpsVenueId | "best">[] = [
    {
      id: "best",
      label: copy.ticket.bestVenue,
      icon: "star",
      detail: quote?.best && ticket.venue === "best" ? copy.ticket.venueBestNow(venues.find((venue) => venue.id === quote.best!.venue)?.name ?? "") : copy.ticket.venueBestDetail,
    },
    ...venues.map((venue) => ({
      id: venue.id,
      label: venue.name,
      icon: venue.id === "gmx-v2" ? ("gmx" as const) : venue.id === "hyperliquid" ? ("hl" as const) : networkIcon(venue.network),
      detail: venue.enabled ? copy.ticket.venueMax(String(venue.maxLeverage)) : copy.ticket.venueReadOnly,
      disabled: !venue.enabled,
      ...(venue.disabledReason ? { reason: venue.disabledReason } : {}),
    })),
  ];

  const instrumentPane = (
    <>
      <InstrumentHead
        title={
          <div className="kt-pick">
            <span className="kt-coin" aria-hidden="true">
              {ticket.symbol.slice(0, 3)}
            </span>
            <label className="kt-pick-sel">
              <span className="sr-only">{copy.tape.pickLabel}</span>
              <select value={ticket.symbol} onChange={(event) => update({ symbol: event.target.value })}>
                {(symbols.length > 0 ? symbols : [ticket.symbol]).map((symbol) => (
                  <option key={symbol} value={symbol}>
                    {`${symbol}-PERP`}
                  </option>
                ))}
              </select>
            </label>
          </div>
        }
        sub={instrument && instrumentVenue ? copy.tape.venueLine(instrumentVenue.name, formatRate(instrument.fundingRate1h.long), instrument.openInterestUsd ? formatCompactUsd(instrument.openInterestUsd.long + instrument.openInterestUsd.short) : "—") : null}
        value={instrument ? formatPrice(instrument.markPrice) : undefined}
      />
      <PriceTape
        points={tape}
        levels={levels}
        label={instrument && instrumentVenue ? copy.tape.label(instrument.symbol, instrumentVenue.name) : copy.tape.empty}
        empty={data ? copy.tape.empty : copy.markets.loading}
        caption={tape.length >= 2 ? copy.tape.caption(String(TAPE_EVERY_S), tapeSince(tape) ?? "") : instrument ? copy.tape.waiting : null}
      />
      {marketsError ? <ApiErrorPanel error={marketsError} onRetry={loadMarkets} /> : null}
    </>
  );

  const listsPane = (
    <>
      <section aria-label={copy.lists.label} className="kv-sec">
        <div className="kt-tabs">
          <Segmented
            value={shownList}
            onChange={setList}
            ariaLabel={copy.lists.label}
            options={[
              { id: "positions", label: copy.lists.positions(String(positionList.length)) },
              { id: "markets", label: copy.lists.markets },
            ]}
          />
          <Button variant="ghost" size="sm" onClick={loadMarkets}>
            {copy.markets.refresh}
          </Button>
        </div>

        {shownList === "markets" ? (
          <div role="region" aria-labelledby="perps-markets">
            <h3 id="perps-markets" className="sr-only">
              {copy.markets.heading}
            </h3>
            {!data && !marketsError ? <ViewLoading>{copy.markets.loading}</ViewLoading> : null}
            {data && rows.length === 0 ? <ViewEmpty>{copy.markets.empty}</ViewEmpty> : null}
            {rows.length > 0 ? (
              <div aria-hidden="true" className="kt-mrow" data-head="">
                <span>{copy.markets.market}</span>
                <span>{copy.markets.mark}</span>
                <span>{copy.markets.fundingShort}</span>
                <span>{copy.markets.openInterest}</span>
                <span />
              </div>
            ) : null}
            <ul className="kt-list" style={{ gap: 0 }}>
              {rows.map((row) => (
                <li key={row.key} className="kt-mrow" data-on={row.symbol === ticket.symbol && (ticket.venue === row.venue || (ticket.venue === "best" && instrument?.venue === row.venue)) ? "" : undefined}>
                  <span>
                    <b>{row.symbol}</b> <span className="kv-muted">{row.venueName}</span>
                  </span>
                  <span className="kt-cell">
                    <span className="kt-cell-l">{copy.markets.mark}</span>
                    <span className="kt-cell-v">{row.mark}</span>
                  </span>
                  <span className="kt-cell">
                    <span className="kt-cell-l">{copy.markets.fundingShort}</span>
                    <span className={`kt-cell-v ${row.fundingTone === "pays" ? "kt-pays" : row.fundingTone === "earns" ? "kt-earns" : ""}`}>{row.funding}</span>
                  </span>
                  <span className="kt-cell">
                    <span className="kt-cell-l">{copy.markets.openInterest}</span>
                    <span className="kt-cell-v">{row.openInterest}</span>
                  </span>
                  <Button variant="secondary" size="sm" disabled={!row.open} aria-label={copy.markets.choose(row.symbol, row.venueName)} onClick={() => update({ symbol: row.symbol, venue: row.venue })}>
                    {copy.markets.trade}
                  </Button>
                </li>
              ))}
            </ul>
            {(data?.unavailable ?? []).map((entry) => (
              <ViewNote key={entry.venue}>{copy.markets.unavailable(venues.find((venue) => venue.id === entry.venue)?.name ?? entry.venue, entry.message)}</ViewNote>
            ))}
            {venues.filter((venue) => !venue.enabled).map((venue) => (
              <ViewNote key={venue.id}>
                {copy.markets.disabled(venue.name)} {venue.disabledReason}
              </ViewNote>
            ))}
          </div>
        ) : (
          <div role="region" aria-labelledby="perps-positions">
            <h3 id="perps-positions" className="sr-only">
              {copy.positions.heading}
            </h3>
            {!evm && !solana ? <ViewEmpty>{copy.positions.connect}</ViewEmpty> : null}
            {(evm || solana) && positionList.length === 0 ? <ViewEmpty>{copy.positions.none}</ViewEmpty> : null}
            <ul className="kt-list">
              {positionRows(positionList, venues).map((row, index) => (
                <li key={row.key} className="kt-pos" data-near={row.nearLiquidation ? "" : undefined}>
                  <p className="kt-pos-h">
                    <b>
                      {row.symbol} {row.side === "long" ? copy.ticket.long : copy.ticket.short}
                    </b>
                    <span className="kv-muted">{row.venueName}</span>
                  </p>
                  <ViewFacts
                    rows={[
                      { label: copy.positions.size, value: row.size },
                      { label: copy.positions.entry, value: row.entry },
                      { label: copy.positions.mark, value: row.mark },
                      { label: copy.positions.liquidation, value: row.liquidationDistancePct === null ? row.liquidation : copy.positions.away(row.liquidation, row.liquidationDistancePct.toFixed(1)), tone: row.nearLiquidation ? "warn" : undefined },
                      { label: copy.positions.pnl, value: row.pnl, tone: row.pnlTone === "loss" ? "warn" : undefined },
                    ]}
                  />
                  {row.closable ? (
                    <div className="kt-pos-act">
                      <Button size="sm" variant="secondary" disabled={pending !== null || run.busy} onClick={() => managePosition(positionList[index]!, "close")}>
                        {copy.positions.close}
                      </Button>
                      <Button size="sm" variant="ghost" disabled={pending !== null || run.busy} onClick={() => managePosition(positionList[index]!, "reduce")}>
                        {copy.positions.reduce}
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
            {positions.flatMap((entry) => entry.unavailable).map((entry) => (
              <ViewNote key={entry.venue}>{copy.positions.unavailable(venues.find((venue) => venue.id === entry.venue)?.name ?? entry.venue)}</ViewNote>
            ))}
            {positions.some((entry) => entry.unsupported > 0) ? <p className="kv-muted">{copy.positions.unsupported(String(positions.reduce((sum, entry) => sum + entry.unsupported, 0)))}</p> : null}
            {positionList.length > 0 ? <p className="kv-muted" style={{ fontSize: 12.5 }}>{copy.positions.pnlNote}</p> : null}
          </div>
        )}
      </section>

      <aside aria-labelledby="perps-risk">
        <ViewNote tone="warning">
          <h3 id="perps-risk">{copy.risk.heading}</h3>
          <ul>
            {copy.risk.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </ViewNote>
      </aside>
    </>
  );

  const ticketPane = (
    <Ticket id="perps-ticket" title={copy.ticket.heading}>
      <SideSwitch
        label={copy.ticket.sideLabel}
        value={ticket.side}
        onChange={(side) => update({ side })}
        options={[
          { id: "long", label: copy.ticket.long, tone: "go" },
          { id: "short", label: copy.ticket.short, tone: "stop" },
        ]}
      />
      <Field
        label={copy.ticket.collateralLabel}
        unit={copy.ticket.collateralAsset}
        hint={copy.ticket.collateralHint}
        inputMode="decimal"
        autoComplete="off"
        placeholder="100"
        value={ticket.collateral}
        onChange={(event) => update({ collateral: event.target.value })}
      />
      <Fader
        label={copy.ticket.leverageLabel(String(Math.min(ticket.leverage, cap)))}
        value={ticket.leverage}
        min={1}
        max={cap}
        detents={leverageDetents(cap)}
        format={(value) => `${value}x`}
        hint={copy.ticket.sizeHint(formatUsd(sizeUsd))}
        onChange={(leverage) => update({ leverage })}
      />
      <Cartridges label={copy.ticket.venueLabel} value={ticket.venue} onChange={(venue) => update({ venue })} options={venueOptions} />
      <div className="k-field">
        <p className="k-field-label" id="perps-slippage">
          {copy.ticket.slippageLabel}
        </p>
        <Segmented
          fill
          ariaLabel={copy.ticket.slippageLabel}
          value={String(ticket.slippageBps)}
          onChange={(value) => update({ slippageBps: Number(value) })}
          options={SLIPPAGE_OPTIONS.map((bps) => ({ id: String(bps), label: `${(bps / 100).toFixed(1)}%` }))}
        />
      </div>
      {problems.length > 0 ? (
        <ul className="kt-problems">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}
      {!best ? (
        <Button variant="secondary" loading={pending === "quote"} disabled={problems.length > 0 || pending !== null} onClick={() => void getQuote()}>
          {copy.ticket.quote}
        </Button>
      ) : null}

      {best ? (
        <>
          <ViewFacts
            live
            rows={[
              { label: copy.ticket.sizeLabel, value: copy.ticket.sizeAt(formatUsd(best.sizeUsd), String(best.leverage)) },
              { label: copy.ticket.liquidation, value: best.liquidationPrice === null ? copy.ticket.noLiquidation : formatPrice(best.liquidationPrice), tone: "warn" },
              { label: copy.ticket.fees, value: `${formatUsd(best.fees.openUsd)} + ${formatUsd(best.fees.closeUsd)}` },
            ]}
          />
          <p className="kt-risk">
            {move !== null && best.liquidationPrice !== null
              ? copy.ticket.riskSentence(ticket.symbol, ticket.side, (move * 100).toFixed(1), formatPrice(best.liquidationPrice), ticket.collateral.trim())
              : copy.ticket.riskNoLiquidation(ticket.collateral.trim())}
          </p>
          <details className="kt-more">
            <summary>{copy.ticket.moreNumbers}</summary>
            <ViewFacts
              rows={[
                { label: copy.ticket.entry, value: formatPrice(best.entryPrice) },
                { label: copy.ticket.acceptable, value: formatPrice(best.acceptablePrice) },
                ...(best.fees.executionUsd !== null ? [{ label: copy.ticket.execution, value: formatUsd(best.fees.executionUsd) }] : []),
                { label: copy.ticket.funding, value: `${formatUsd(best.funding1hUsd)} (${formatRate(best.funding1hUsd / Math.max(best.sizeUsd, 1))})` },
              ]}
            />
          </details>
        </>
      ) : null}
      {best?.warnings.map((warning) => (
        <ViewNote key={warning} tone="warning">
          {warning}
        </ViewNote>
      ))}
      {quote ? (
        <details className="kt-more">
          <summary>{copy.ticket.whyVenue}</summary>
          <ul>
            {quote.choices.map((choice) => {
              const name = venues.find((venue) => venue.id === choice.venue)?.name ?? choice.venue;
              return <li key={choice.venue}>{choice.eligible ? copy.ticket.choiceCost(name, formatUsd(choice.costUsd ?? 0)) : copy.ticket.notEligible(name, choice.reason ?? "")}</li>;
            })}
          </ul>
        </details>
      ) : null}
      {best && venueInfo && !account ? (
        <div className="kv-field">
          <p className="kt-risk">{copy.ticket.walletNeeded(venueInfo.network === "solana" ? "Solana" : "EVM")}</p>
          <Button variant="secondary" onClick={() => actions.openWallet(venueInfo.network === "solana" ? "solana" : "eip155")}>
            {copy.ticket.connect}
          </Button>
        </div>
      ) : null}
      {best && chosenVenue && account && !run.run ? (
        <Key tone="lime" disabled={pending !== null} aria-busy={pending === "prepare" || undefined} onClick={() => void prepare(ticketRequest(ticket, chosenVenue, account))}>
          {copy.ticket.review}
        </Key>
      ) : null}
      {best && !run.run ? (
        <Button variant="ghost" size="sm" loading={pending === "quote"} disabled={problems.length > 0 || pending !== null} onClick={() => void getQuote()}>
          {copy.ticket.quote}
        </Button>
      ) : null}
      {requestError ? <ApiErrorPanel error={requestError} /> : null}

      {run.run ? (
        <SigningStrip
          id="perps-steps"
          title={copy.steps.heading}
          steps={run.run.steps.map((entry, index) => ({ id: entry.id, title: entry.title, state: stripState(run.run!.states[index]), word: stepWord(run.run!.states[index]) }))}
        >
          {run.prepared?.warnings.map((warning) => (
            <ViewNote key={warning} tone="warning">
              {warning}
            </ViewNote>
          ))}
          {run.settleLeft > 0 ? <p className="kt-risk">{copy.steps.settle(String(run.settleLeft))}</p> : null}
          {run.run.error ? (
            <ViewNote role="alert" tone="danger">
              {run.run.error}
            </ViewNote>
          ) : null}
          {step >= 0 ? (
            <Button loading={run.busy} disabled={run.settleLeft > 0} onClick={() => void run.advance()}>
              {step === 0 && run.run.states[0] === "waiting" ? copy.steps.start : copy.steps.continue}
            </Button>
          ) : run.run.error ? null : (
            <p role="status" className="kt-risk">
              <b>{copy.steps.finished}</b>
            </p>
          )}
          <Button variant="ghost" size="sm" disabled={run.busy} onClick={run.reset}>
            {copy.steps.cancel}
          </Button>
        </SigningStrip>
      ) : null}
    </Ticket>
  );

  return (
    <section aria-labelledby="perps-heading" className="flex min-w-0 flex-col gap-6 pb-8">
      <ViewHeader id="perps-heading" title={copy.heading} intro={copy.intro} />
      <HandoffNote text={handoffNote} />
      <TradeLayout main={instrumentPane} ticket={ticketPane} rest={listsPane} />
    </section>
  );
}

export default PerpsView;
