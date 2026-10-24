/**
 * The desk's Predict view (/app/predict, a sub-tab of Trade): Polymarket
 * market search and categories; a market page with each outcome's implied
 * probability, a week of prices, the order book's depth and the resolution
 * rules; the user's own Polymarket wallet found from the connected EVM
 * wallet (PredictWallet: which one trades, balances, deposit / withdraw /
 * wrap); a buy/sell ticket that quotes max loss, payout and fees and says
 * which wallet trades; that wallet's open orders (PredictOrders) and its
 * positions with sell and redeem. Orders are built by
 * /v1/predictions and signed step by step in the user's wallet
 * (usePredictRun). Polymarket's location check runs from this browser;
 * buying stays off when it says restricted. One column at every width;
 * nothing scrolls sideways.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { IntentHandoff, PredictionMarket, PredictionStep } from "@kletia/core";

import { toPlatformError, type PlatformError } from "../../../shared/platform/kletiaClient";
import { useWallets } from "../../../shared/wallet/useWallets";
import { ApiErrorPanel } from "../../site/ui/ApiErrorPanel";
import { Button } from "../../site/ui/Button";
import { cx, LABEL, TEXT_MUTED } from "../../site/ui/styles";
import { useDeskActions } from "../shell/deskContext";
import { ViewEmpty, ViewHeader, ViewLoading, ViewNote } from "../shell/ViewParts";
import { PANEL_TITLE, VIEW_FIELD, VIEW_PANEL } from "../shell/viewStyles";
import { HandoffNote } from "../handoff/HandoffNote";
import { predictPrefill } from "../handoff/handoffModel";
import { useHandoff } from "../handoff/useHandoff";
import { checkGeoblock, predictApi, type GeoblockAnswer, type PolymarketWalletsResponse, type PredictionMarketResponse, type PredictionMarketsResponse, type PredictionPositionsResponse, type PredictionQuoteResponse } from "./predictApi";
import { PREDICT_COPY } from "./predictCopy";
import {
  bookDepth,
  DEFAULT_TICKET,
  formatEnds,
  formatProbability,
  formatVolume,
  locationNote,
  marketRows,
  nextStep,
  pickWallet,
  POLYGON_CAIP2,
  positionRows,
  PREDICT_CATEGORIES,
  quoteRows,
  ticketProblems,
  ticketRequest,
  walletLine,
  type PredictTicket,
  type WalletMove,
} from "./predictModel";
import { PredictOrders } from "./PredictOrders";
import { PredictWallet } from "./PredictWallet";
import { heldSession, usePredictRun } from "./usePredictRun";

/** One read's answer, with what it answers and when it arrived. */
interface Answer<For, Data> {
  readonly for: For;
  readonly data: Data | null;
  readonly error: PlatformError | null;
  readonly at: number;
}

const copy = PREDICT_COPY;
const SLIPPAGE_OPTIONS = [100, 200, 500] as const;
/** Markets listed before "Show all" (a phone column stays short). */
const FIRST_ROWS = 12;

function Row({ label, value, tone }: { readonly label: string; readonly value: string; readonly tone?: "warn" | undefined }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 border-b-2 border-dashed border-[var(--kl-line)] py-1.5 text-sm last:border-b-0">
      <dt className={TEXT_MUTED}>{label}</dt>
      <dd className={cx("font-code font-bold", tone === "warn" && "text-danger")}>{value}</dd>
    </div>
  );
}

/** A week of prices as a line; the numbers are in the text beside it (decorative). */
function Sparkline({ points }: { readonly points: readonly { readonly t: number; readonly p: number }[] }) {
  if (points.length < 2) return null;
  const first = points[0]!.t;
  const span = Math.max(1, points[points.length - 1]!.t - first);
  const path = points.map((point) => `${(((point.t - first) / span) * 100).toFixed(2)},${(40 - point.p * 40).toFixed(2)}`).join(" ");
  return (
    <svg aria-hidden="true" viewBox="0 0 100 40" preserveAspectRatio="none" className="h-12 w-full">
      <polyline points={path} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function DepthList({ title, rows, tone }: { readonly title: string; readonly rows: ReturnType<typeof bookDepth>["bids"]; readonly tone: "bid" | "ask" }) {
  return (
    <div className="min-w-0 flex-1">
      <p className={cx(LABEL, "mb-1 text-xs")}>{title}</p>
      {rows.length === 0 ? <p className={cx("text-sm", TEXT_MUTED)}>-</p> : null}
      <ul className="flex flex-col gap-0.5 text-sm">
        {rows.map((row) => (
          <li key={`${row.price}:${row.shares}`} className="relative flex justify-between gap-2 px-1 py-0.5 font-code">
            <span aria-hidden="true" className={cx("absolute inset-y-0 left-0 opacity-25", tone === "bid" ? "bg-success" : "bg-danger")} style={{ width: `${Math.round(row.depth * 100)}%` }} />
            <span className="relative">{row.price}</span>
            <span className="relative">{row.shares}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PredictView() {
  const wallets = useWallets();
  const actions = useDeskActions();
  const evm = wallets.evm?.address ?? null;
  const account = evm ? `${POLYGON_CAIP2}:${evm}` : null;
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<{ readonly q: string; readonly category: string; readonly sort: "volume" | "ending" }>({ q: "", category: "", sort: "volume" });
  // Answers are kept with the search or market they answer, so a newer one never shows an older answer.
  const [listRead, setListRead] = useState<Answer<typeof search, PredictionMarketsResponse> | null>(null);
  const [showAllFor, setShowAllFor] = useState<typeof search | null>(null);
  const [marketId, setMarketId] = useState<string | null>(null);
  const [detailRead, setDetailRead] = useState<Answer<string, PredictionMarketResponse> | null>(null);
  const [ticket, setTicket] = useState<PredictTicket>(DEFAULT_TICKET);
  const [quote, setQuote] = useState<PredictionQuoteResponse | null>(null);
  const [requestError, setRequestError] = useState<PlatformError | null>(null);
  const [pending, setPending] = useState<"quote" | "prepare" | "redeem" | "move" | null>(null);
  const [walletsRead, setWalletsRead] = useState<Answer<string, PolymarketWalletsResponse> | null>(null);
  const [pickedWallet, setPickedWallet] = useState<string | null>(null);
  const [positionsRead, setPositionsRead] = useState<{ readonly key: string; readonly data: PredictionPositionsResponse | null } | null>(null);
  const [positionFilter, setPositionFilter] = useState<string | null>(null);
  const [geo, setGeo] = useState<GeoblockAnswer | null | "checking">("checking");
  const [handoffNote, setHandoffNote] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void checkGeoblock(controller.signal).then((answer) => {
      if (!controller.signal.aborted) setGeo(answer);
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    predictApi.markets({ q: search.q, category: search.category, sort: search.sort }, controller.signal).then(
      (next) => setListRead({ for: search, data: next, error: null, at: Date.now() }),
      (error: unknown) => {
        if (!controller.signal.aborted) setListRead({ for: search, data: null, error: toPlatformError(error), at: Date.now() });
      },
    );
    return () => controller.abort();
  }, [search]);

  useEffect(() => {
    if (!marketId) return undefined;
    const controller = new AbortController();
    predictApi.market(marketId, controller.signal).then(
      (next) => {
        setDetailRead({ for: marketId, data: next, error: null, at: Date.now() });
        // A position opens its market by condition id; the ticket trades the market's own id.
        setTicket((current) => (current.marketId === marketId ? { ...current, marketId: next.market.id } : current));
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setDetailRead({ for: marketId, data: null, error: toPlatformError(error), at: Date.now() });
      },
    );
    return () => controller.abort();
  }, [marketId]);

  const loadWallets = useCallback(() => {
    if (!account) return;
    predictApi.wallets(account).then(
      (data) => setWalletsRead({ for: account, data, error: null, at: Date.now() }),
      (error: unknown) => setWalletsRead({ for: account, data: null, error: toPlatformError(error), at: Date.now() }),
    );
  }, [account]);
  useEffect(loadWallets, [loadWallets]);

  const walletsView = account !== null && walletsRead?.for === account ? walletsRead.data : null;
  const walletsError = account !== null && walletsRead?.for === account ? walletsRead.error : null;
  const wallet = walletsView ? pickWallet(walletsView.wallets, pickedWallet) : null;
  // Positions follow the wallet that trades: the Polymarket wallet once discovery answered, else the account itself.
  const holder = wallet?.address ?? null;
  const positionsKey = account && (walletsView || walletsError) ? `${account}:${holder ?? ""}` : null;

  const [positionsTick, setPositionsTick] = useState(0);
  useEffect(() => {
    if (!account || !positionsKey) return undefined;
    const controller = new AbortController();
    predictApi.positions(account, holder, controller.signal).then(
      (data) => setPositionsRead({ key: positionsKey, data }),
      () => {
        if (!controller.signal.aborted) setPositionsRead({ key: positionsKey, data: null });
      },
    );
    return () => controller.abort();
  }, [account, holder, positionsKey, positionsTick]);

  const refreshAll = useCallback(() => {
    setPositionsTick((tick) => tick + 1);
    loadWallets();
  }, [loadWallets]);
  const run = usePredictRun(refreshAll);

  const openMarket = useCallback((id: string, patch: Partial<PredictTicket> = {}) => {
    setMarketId(id);
    setTicket({ ...DEFAULT_TICKET, ...patch, marketId: id });
    setQuote(null);
    setRequestError(null);
  }, []);

  useHandoff("predictions", useCallback((handoff: IntentHandoff) => {
    if (handoff.surface !== "predictions") return;
    const prefill = predictPrefill(handoff.input);
    if (prefill.search !== null) {
      setQuery(prefill.search);
      setSearch((current) => ({ ...current, q: prefill.search ?? "" }));
    }
    if (prefill.ticket) openMarket(prefill.ticket.marketId ?? "", prefill.ticket);
    setPositionFilter(prefill.positionFilter);
    setHandoffNote(prefill.note(handoff.summary));
  }, [openMarket]));

  const list = listRead?.for === search ? listRead.data : null;
  const listError = listRead?.for === search ? listRead.error : null;
  const showAll = showAllFor === search;
  const detailFresh = marketId !== null && detailRead?.for === marketId ? detailRead : null;
  const detail = detailFresh?.data ?? null;
  const detailError = detailFresh?.error ?? null;
  const positions = positionsKey !== null && positionsRead?.key === positionsKey ? positionsRead.data : null;
  const tradesFrom = wallet ? walletLine(wallet) : evm ? copy.ticket.ownWallet(evm) : null;
  const canTrade = wallet ? wallet.tradable : positions?.tradable !== false;
  const market: PredictionMarket | null = detail?.market ?? null;
  const location = geo === "checking" ? null : locationNote(geo);
  const problems = ticketProblems(ticket, market);
  const buyingOff = ticket.side === "buy" && location !== null && !location.canBuy;
  const selectedOutcome = detail?.outcomes.find((outcome) => outcome.label === ticket.outcome) ?? detail?.outcomes[0] ?? null;
  const depth = selectedOutcome?.book ? bookDepth(selectedOutcome.book) : null;
  const rows = useMemo(() => marketRows(list?.markets ?? [], listRead?.at ?? 0), [list, listRead]);
  const held = useMemo(() => positionRows(positions?.positions ?? [], positionFilter), [positions, positionFilter]);
  const step = run.run ? nextStep(run.run) : -1;

  const update = (patch: Partial<PredictTicket>) => {
    setTicket((current) => ({ ...current, ...patch }));
    setQuote(null);
    setRequestError(null);
    run.reset();
  };

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    setSearch((current) => ({ ...current, q: query.trim() }));
  };

  const getQuote = async () => {
    setPending("quote");
    setRequestError(null);
    try {
      setQuote(await predictApi.quote(ticketRequest(ticket, null)));
    } catch (error) {
      setRequestError(toPlatformError(error));
    } finally {
      setPending(null);
    }
  };

  const prepare = async () => {
    if (!account) return;
    setPending("prepare");
    setRequestError(null);
    try {
      const prepared = await predictApi.prepare(ticketRequest(ticket, account, heldSession(account, Date.now()) !== null, wallet?.address ?? null));
      run.begin(account, prepared.steps, prepared, prepared.warnings);
    } catch (error) {
      setRequestError(toPlatformError(error));
    } finally {
      setPending(null);
    }
  };

  const redeem = async (conditionId: string) => {
    if (!account) return;
    setPending("redeem");
    setRequestError(null);
    try {
      const prepared = await predictApi.redeem(account, conditionId, holder);
      run.begin(account, prepared.steps, null, [prepared.note]);
    } catch (error) {
      setRequestError(toPlatformError(error));
    } finally {
      setPending(null);
    }
  };

  const moveFunds = async (move: WalletMove) => {
    if (!account || !wallet) return;
    setPending("move");
    setRequestError(null);
    try {
      const prepared = await predictApi.walletAction({ account, wallet: wallet.address, action: move.action, asset: move.asset, amountUsd: move.amount.trim() });
      run.begin(account, prepared.steps as readonly PredictionStep[], null, [prepared.note]);
    } catch (error) {
      setRequestError(toPlatformError(error));
    } finally {
      setPending(null);
    }
  };

  return (
    <section aria-labelledby="predict-heading" className="flex min-w-0 flex-col gap-4 pb-8">
      <ViewHeader id="predict-heading" title={copy.heading} intro={copy.intro} />
      <HandoffNote text={handoffNote} />

      <aside aria-labelledby="predict-risk" className="flex flex-col gap-2">
        <ViewNote tone="warning">
          <h3 id="predict-risk" className={cx(LABEL, "mb-2")}>{copy.risk.heading}</h3>
          <ul className="list-disc space-y-1 pl-5">
            {copy.risk.lines.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </ViewNote>
        <ViewNote tone={location?.tone ?? "neutral"} role="status">
          {location ? location.text : copy.location.checking}{" "}
          <a className="font-bold underline" href={list?.venues.find((venue) => venue.id === "polymarket")?.termsUrl ?? "https://polymarket.com/tos"} target="_blank" rel="noreferrer">{copy.location.terms}</a>
        </ViewNote>
      </aside>

      <PredictWallet
        account={account}
        view={walletsView}
        error={walletsError}
        selected={wallet}
        busy={pending === "move" || run.busy}
        onPick={setPickedWallet}
        onConnect={() => actions.openWallet("eip155")}
        onRetry={loadWallets}
        onMove={(move) => void moveFunds(move)}
      />
      {requestError && !market ? <ApiErrorPanel error={requestError} /> : null}

      <section aria-labelledby="predict-markets" className={VIEW_PANEL}>
        <h3 id="predict-markets" className={PANEL_TITLE}>{copy.search.heading}</h3>
        <form role="search" onSubmit={submitSearch} className="flex flex-col gap-2 sm:flex-row">
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="sr-only">{copy.search.label}</span>
            <input className={VIEW_FIELD} type="search" value={query} maxLength={120} placeholder={copy.search.placeholder} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <Button type="submit" variant="secondary">{copy.search.submit}</Button>
        </form>
        <div role="group" aria-label={copy.search.categories} className="flex flex-wrap gap-2">
          {PREDICT_CATEGORIES.map((category) => (
            <Button key={category.id || "top"} size="sm" variant={search.category === category.id && !search.q ? "primary" : "secondary"} aria-pressed={search.category === category.id && !search.q}
              onClick={() => { setQuery(""); setSearch((current) => ({ ...current, q: "", category: category.id })); }}>
              {category.label}
            </Button>
          ))}
        </div>
        <label className="flex flex-col gap-1 sm:max-w-xs">
          <span className={LABEL}>{copy.search.sort}</span>
          <select className={VIEW_FIELD} value={search.sort} onChange={(event) => setSearch((current) => ({ ...current, sort: event.target.value === "ending" ? "ending" : "volume" }))}>
            <option value="volume">{copy.search.sortVolume}</option>
            <option value="ending">{copy.search.sortEnding}</option>
          </select>
        </label>
        {listError ? <ApiErrorPanel error={listError} onRetry={() => setSearch((current) => ({ ...current }))} /> : null}
        {!list && !listError ? <ViewLoading>{copy.search.loading}</ViewLoading> : null}
        {list && rows.length === 0 ? <ViewEmpty>{copy.search.empty}</ViewEmpty> : null}
        <ul className="flex flex-col">
          {(showAll ? rows : rows.slice(0, FIRST_ROWS)).map((row) => (
            <li key={row.id} className="border-b-2 border-[var(--kl-line)] last:border-b-0">
              <button type="button" className="flex min-h-11 w-full min-w-0 flex-col gap-1 py-2 text-left focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 sm:flex-row sm:items-center sm:justify-between" aria-label={copy.search.open(row.title)} onClick={() => openMarket(row.id)}>
                <span className="min-w-0">
                  <span className="block break-words font-bold">{row.title}</span>
                  <span className={cx("block text-xs", TEXT_MUTED)}>{row.ends} · {copy.search.volume} {row.volume}</span>
                </span>
                {row.leading ? <span className="shrink-0 font-code text-sm font-bold">{row.leading.label} {row.leading.probability}</span> : null}
              </button>
            </li>
          ))}
        </ul>
        {!showAll && rows.length > FIRST_ROWS ? (
          <Button variant="ghost" size="sm" onClick={() => setShowAllFor(search)}>{copy.search.showAll(rows.length)}</Button>
        ) : null}
        {(list?.venues ?? []).filter((venue) => !venue.enabled).map((venue) => (
          <ViewNote key={venue.id}>{copy.search.notAdded(venue.name)} {venue.disabledReason}</ViewNote>
        ))}
      </section>

      {marketId ? (
        <section aria-labelledby="predict-market" className={VIEW_PANEL}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 id="predict-market" className={cx(PANEL_TITLE, "min-w-0 break-words")}>{market?.question ?? copy.market.loading}</h3>
            <Button variant="ghost" size="sm" onClick={() => { setMarketId(null); setTicket(DEFAULT_TICKET); setQuote(null); }}>{copy.market.back}</Button>
          </div>
          {detailError ? <ApiErrorPanel error={detailError} /> : null}
          {!detail && !detailError ? <ViewLoading>{copy.market.loading}</ViewLoading> : null}
          {market ? (
            <>
              <p className={cx("text-sm", TEXT_MUTED)}>
                {market.eventTitle && market.eventTitle !== market.question ? `${market.eventTitle} · ` : ""}{formatEnds(market.endDate, detailFresh?.at ?? 0)} · {copy.search.volume} {formatVolume(market.volume24hUsd)}
              </p>
              <ul className="grid gap-2 sm:grid-cols-2" aria-label={copy.market.outcomes}>
                {detail?.outcomes.map((outcome) => (
                  <li key={outcome.tokenId} className="flex min-w-0 flex-col gap-2 border-2 border-[var(--kl-line)] p-3">
                    <p className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-bold">{outcome.label}</span>
                      <span className="font-code text-2xl font-bold" aria-label={`${copy.market.probability} ${formatProbability(outcome.book?.asks[0]?.price ?? outcome.price)}`}>
                        {formatProbability(outcome.book?.asks[0]?.price ?? outcome.price)}
                      </span>
                    </p>
                    <Sparkline points={outcome.history} />
                    {outcome.history.length > 1 ? <p className={cx("text-xs", TEXT_MUTED)}>{copy.market.week}: {formatProbability(outcome.history[0]!.p)} → {formatProbability(outcome.history[outcome.history.length - 1]!.p)}</p> : null}
                    <Button size="sm" variant={ticket.outcome === outcome.label ? "primary" : "secondary"} aria-pressed={ticket.outcome === outcome.label} onClick={() => update({ outcome: outcome.label })}>
                      {copy.market.choose(outcome.label)}
                    </Button>
                  </li>
                ))}
              </ul>
              <section aria-labelledby="predict-book">
                <h4 id="predict-book" className={cx(LABEL, "mb-1")}>{copy.market.book}{selectedOutcome ? ` · ${selectedOutcome.label}` : ""}{depth ? ` · ${copy.market.spread(depth.spread)}` : ""}</h4>
                {depth ? (
                  <div className="flex gap-3">
                    <DepthList title={copy.market.bids} rows={depth.bids} tone="bid" />
                    <DepthList title={copy.market.asks} rows={depth.asks} tone="ask" />
                  </div>
                ) : <p className={cx("text-sm", TEXT_MUTED)}>{selectedOutcome?.unavailable ?? copy.market.noBook}</p>}
              </section>
              {market.description ? (
                <details className="text-sm">
                  <summary className="min-h-11 cursor-pointer py-2 font-bold">{copy.market.rules}</summary>
                  <p className="whitespace-pre-line break-words">{market.description}</p>
                </details>
              ) : null}
              <a className="text-sm font-bold underline" href={market.url} target="_blank" rel="noreferrer">{copy.market.onPolymarket}</a>
            </>
          ) : null}
        </section>
      ) : null}

      {market ? (
        <section aria-labelledby="predict-ticket" className={VIEW_PANEL}>
          <h3 id="predict-ticket" className={PANEL_TITLE}>{copy.ticket.heading}</h3>
          <fieldset className="flex gap-2">
            <legend className={cx(LABEL, "mb-1")}>{copy.ticket.sideLabel}</legend>
            {(["buy", "sell"] as const).map((side) => (
              <Button key={side} className="flex-1" variant={ticket.side === side ? "primary" : "secondary"} aria-pressed={ticket.side === side} onClick={() => update({ side })}>
                {side === "buy" ? copy.ticket.buy : copy.ticket.sell}
              </Button>
            ))}
          </fieldset>
          <label className="flex flex-col gap-1">
            <span className={LABEL}>{copy.ticket.outcomeLabel}</span>
            <select className={VIEW_FIELD} value={ticket.outcome ?? ""} onChange={(event) => update({ outcome: event.target.value || null })}>
              <option value="">-</option>
              {market.outcomes.map((outcome) => <option key={outcome.tokenId} value={outcome.label}>{outcome.label}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className={LABEL}>{copy.ticket.orderTypeLabel}</span>
            <select className={VIEW_FIELD} value={ticket.orderType} onChange={(event) => update({ orderType: event.target.value === "limit" ? "limit" : "market" })}>
              <option value="market">{copy.ticket.market}</option>
              <option value="limit">{copy.ticket.limit}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className={LABEL}>{ticket.side === "buy" ? copy.ticket.amountBuy : copy.ticket.amountSell}</span>
            <input className={VIEW_FIELD} inputMode="decimal" autoComplete="off" placeholder={ticket.side === "buy" ? "20" : "50"} value={ticket.amount} onChange={(event) => update({ amount: event.target.value })} />
          </label>
          {ticket.orderType === "limit" ? (
            <label className="flex flex-col gap-1">
              <span className={LABEL}>{copy.ticket.limitLabel}</span>
              <input className={VIEW_FIELD} inputMode="decimal" autoComplete="off" placeholder="42" value={ticket.limitCents} onChange={(event) => update({ limitCents: event.target.value })} />
            </label>
          ) : (
            <label className="flex flex-col gap-1">
              <span className={LABEL}>{copy.ticket.slippageLabel}</span>
              <select className={VIEW_FIELD} value={ticket.slippageBps} onChange={(event) => update({ slippageBps: Number(event.target.value) })}>
                {SLIPPAGE_OPTIONS.map((bps) => <option key={bps} value={bps}>{`${(bps / 100).toFixed(0)}% past the book`}</option>)}
              </select>
            </label>
          )}
          {problems.length > 0 ? <ul className="list-disc pl-5 text-sm">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul> : null}
          <Button variant="secondary" loading={pending === "quote"} disabled={problems.length > 0 || pending !== null} onClick={() => void getQuote()}>{copy.ticket.quote}</Button>
          {quote ? (
            <dl aria-live="polite">
              {quoteRows(quote.quote).map((row) => <Row key={row.label} label={row.label} value={row.value} tone={row.tone} />)}
            </dl>
          ) : null}
          {quote?.quote.warnings.map((warning) => <ViewNote key={warning} tone="warning">{warning}</ViewNote>)}
          {quote && !account ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm">{copy.ticket.walletNeeded}</p>
              <Button variant="secondary" onClick={() => actions.openWallet("eip155")}>{copy.ticket.connect}</Button>
            </div>
          ) : null}
          {quote && tradesFrom ? <p className="break-words text-sm"><span className="font-bold">{copy.ticket.tradesFrom}:</span> {tradesFrom}</p> : null}
          {quote && account && !canTrade ? <ViewNote tone="warning">{copy.ticket.smartWallet}</ViewNote> : null}
          {quote && buyingOff ? <ViewNote tone="warning">{copy.ticket.buyOff}</ViewNote> : null}
          {quote && account && !run.run && !buyingOff && canTrade ? (
            <Button loading={pending === "prepare"} disabled={pending !== null} onClick={() => void prepare()}>{copy.ticket.review}</Button>
          ) : null}
          {requestError ? <ApiErrorPanel error={requestError} /> : null}
        </section>
      ) : null}

      {run.run ? (
        <section aria-labelledby="predict-steps" className={VIEW_PANEL}>
          <h3 id="predict-steps" className={PANEL_TITLE}>{copy.steps.heading}</h3>
          {run.prepared?.warnings.map((warning) => <ViewNote key={warning} tone="warning">{warning}</ViewNote>)}
          <ol className="flex flex-col gap-2 text-sm">
            {run.run.steps.map((entry, index) => {
              const state = run.run!.states[index];
              return (
                <li key={entry.id} className="flex flex-col gap-1">
                  <span className="flex flex-wrap justify-between gap-2">
                    <span>{index + 1}. {entry.title}</span>
                    <span className="font-bold" role="status">
                      {state === "signing" ? copy.steps.signing : state === "confirming" ? copy.steps.confirming : state === "relaying" ? copy.steps.relaying : state === "done" ? copy.steps.done : state === "failed" ? copy.steps.failed : ""}
                    </span>
                  </span>
                  {entry.kind === "transaction" && entry.disclosure ? (
                    <details>
                      <summary className="min-h-11 cursor-pointer py-2 font-bold">{copy.steps.disclosure}</summary>
                      <p>{entry.disclosure}</p>
                    </details>
                  ) : null}
                </li>
              );
            })}
          </ol>
          {run.run.error ? <ViewNote role="alert" tone="danger">{run.run.error}</ViewNote> : null}
          {run.run.result ? <ViewNote role="status" tone="info">{run.run.result}</ViewNote> : null}
          {step >= 0 ? <Button loading={run.busy} onClick={() => void run.advance()}>{step === 0 && run.run.states[0] === "waiting" ? copy.steps.start : copy.steps.continue}</Button> : null}
          <Button variant="ghost" size="sm" disabled={run.busy} onClick={run.reset}>{copy.steps.cancel}</Button>
        </section>
      ) : null}

      {account && canTrade && (walletsView || walletsError) ? <PredictOrders account={account} wallet={holder} signIn={run.signIn} /> : null}

      <section aria-labelledby="predict-positions" className={VIEW_PANEL}>
        <h3 id="predict-positions" className={PANEL_TITLE}>{wallet ? copy.positions.headingOf(walletLine(wallet)) : copy.positions.heading}</h3>
        {!account ? <ViewEmpty action={<Button variant="secondary" size="sm" onClick={() => actions.openWallet("eip155")}>{copy.ticket.connect}</Button>}>{copy.positions.connect}</ViewEmpty> : null}
        {positionFilter ? (
          <p className="flex flex-wrap items-center gap-2 text-sm">
            {copy.positions.filtered(positionFilter)}
            <Button size="sm" variant="ghost" onClick={() => setPositionFilter(null)}>{copy.positions.showAll}</Button>
          </p>
        ) : null}
        {account && positions && held.length === 0 ? <ViewEmpty>{copy.positions.none}</ViewEmpty> : null}
        <ul className="flex flex-col gap-3">
          {held.map((row) => (
            <li key={row.key} className="border-2 border-[var(--kl-line)] p-3">
              <p className="break-words font-bold">{row.title} <span className={cx("font-normal", TEXT_MUTED)}>{row.outcome}{row.redeemable ? ` · ${copy.positions.resolved}` : ""}</span></p>
              <dl className="mt-1">
                <Row label={copy.positions.shares} value={row.shares} />
                <Row label={copy.positions.price} value={row.price} />
                <Row label={copy.positions.value} value={row.value} />
                <Row label={copy.positions.pnl} value={row.pnl} tone={row.pnlTone === "loss" ? "warn" : undefined} />
              </dl>
              <div className="mt-2 flex flex-wrap gap-2">
                {row.redeemable ? (
                  <Button size="sm" variant="secondary" loading={pending === "redeem"} disabled={pending !== null || run.busy || !canTrade} onClick={() => void redeem(row.conditionId)}>{copy.positions.redeem}</Button>
                ) : (
                  <Button size="sm" variant="secondary" disabled={pending !== null || run.busy} onClick={() => openMarket(row.conditionId, { side: "sell", outcome: row.outcome, amount: row.shares.replace(/,/gu, "") })}>{copy.positions.sell}</Button>
                )}
              </div>
            </li>
          ))}
        </ul>
        {positions?.truncated ? <p className={cx("text-xs", TEXT_MUTED)}>{copy.positions.truncated}</p> : null}
      </section>
    </section>
  );
}

export default PredictView;
