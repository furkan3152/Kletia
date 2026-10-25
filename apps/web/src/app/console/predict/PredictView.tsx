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
import { Cartridges, Key, Segmented } from "../../kit";
import { ApiErrorPanel } from "../../site/ui/ApiErrorPanel";
import { Button } from "../../site/ui/Button";
import { useDeskActions } from "../shell/deskContext";
import { ViewEmpty, ViewFacts, ViewHeader, ViewLoading, ViewNote } from "../shell/ViewParts";
import { VIEW_FIELD, VIEW_LABEL } from "../shell/viewStyles";
import { InstrumentHead, PriceTape, SideSwitch, SigningStrip, Ticket, TradeLayout, type StripState } from "../trade/TradeParts";
import "./predict.css";
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

function stripState(state: string | undefined): StripState {
  if (state === "done") return "done";
  if (state === "failed") return "failed";
  if (state === "signing" || state === "confirming" || state === "relaying") return "active";
  return "waiting";
}

function DepthList({ title, rows, tone }: { readonly title: string; readonly rows: ReturnType<typeof bookDepth>["bids"]; readonly tone: "bid" | "ask" }) {
  return (
    <div className="kp-depth">
      <p className={VIEW_LABEL}>{title}</p>
      {rows.length === 0 ? <p className="kv-muted">-</p> : null}
      <ul>
        {rows.map((row) => (
          <li key={`${row.price}:${row.shares}`} data-tone={tone}>
            <span aria-hidden="true" className="kp-depth-bar" style={{ width: `${Math.round(row.depth * 100)}%` }} />
            <span>{row.price}</span>
            <span>{row.shares}</span>
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

  const outcomeHistory = selectedOutcome?.history ?? [];
  const nowPrice = selectedOutcome ? (selectedOutcome.book?.asks[0]?.price ?? selectedOutcome.price) : null;

  const searchPane = (
    <section aria-labelledby="predict-markets" className="kv-sec">
      <div className="kv-sec-h">
        <h3 id="predict-markets">{copy.search.heading}</h3>
      </div>
      <form role="search" onSubmit={submitSearch} className="kp-search">
        <label className="kv-field">
          <span className="sr-only">{copy.search.label}</span>
          <input className={VIEW_FIELD} type="search" value={query} maxLength={120} placeholder={copy.search.placeholder} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <Button type="submit" variant="secondary">{copy.search.submit}</Button>
      </form>
      <div role="group" aria-label={copy.search.categories} className="kp-cats">
        {PREDICT_CATEGORIES.map((category) => (
          <button
            key={category.id || "top"}
            type="button"
            className="k-chip"
            aria-pressed={search.category === category.id && !search.q}
            onClick={() => { setQuery(""); setSearch((current) => ({ ...current, q: "", category: category.id })); }}
          >
            {category.label}
          </button>
        ))}
      </div>
      <div className="kp-sort">
        <span className={VIEW_LABEL} id="predict-sort">{copy.search.sort}</span>
        <Segmented
          ariaLabel={copy.search.sort}
          value={search.sort}
          onChange={(sort) => setSearch((current) => ({ ...current, sort }))}
          options={[
            { id: "volume", label: copy.search.sortVolume },
            { id: "ending", label: copy.search.sortEnding },
          ]}
        />
      </div>
      {listError ? <ApiErrorPanel error={listError} onRetry={() => setSearch((current) => ({ ...current }))} /> : null}
      {!list && !listError ? <ViewLoading>{copy.search.loading}</ViewLoading> : null}
      {list && rows.length === 0 ? <ViewEmpty>{copy.search.empty}</ViewEmpty> : null}
      <ul className="kp-markets">
        {(showAll ? rows : rows.slice(0, FIRST_ROWS)).map((row) => (
          <li key={row.id}>
            <button type="button" className="kp-market" aria-current={row.id === marketId || undefined} aria-label={copy.search.open(row.title)} onClick={() => openMarket(row.id)}>
              <span className="kp-market-t">
                <b>{row.title}</b>
                <small>{row.ends} · {copy.search.volume} {row.volume}</small>
              </span>
              {row.leading ? (
                <span className="kp-market-p">
                  <span className="kv-num">{row.leading.probability}</span>
                  <small>{row.leading.label}</small>
                </span>
              ) : null}
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
  );

  const marketPane = marketId ? (
    <section aria-labelledby="predict-market" className="kt-main" style={{ gap: 20 }}>
      <InstrumentHead
        title={<h3 id="predict-market" className="kv-h2 kp-q">{market?.question ?? copy.market.loading}</h3>}
        sub={market ? `${market.eventTitle && market.eventTitle !== market.question ? `${market.eventTitle} · ` : ""}${formatEnds(market.endDate, detailFresh?.at ?? 0)} · ${copy.search.volume} ${formatVolume(market.volume24hUsd)}` : null}
        value={selectedOutcome && nowPrice !== null ? formatProbability(nowPrice) : undefined}
        change={selectedOutcome ? selectedOutcome.label : undefined}
      />
      <div>
        <Button variant="ghost" size="sm" onClick={() => { setMarketId(null); setTicket(DEFAULT_TICKET); setQuote(null); }}>{copy.market.back}</Button>
      </div>
      {detailError ? <ApiErrorPanel error={detailError} /> : null}
      {!detail && !detailError ? <ViewLoading>{copy.market.loading}</ViewLoading> : null}
      {market ? (
        <>
          <PriceTape
            points={outcomeHistory}
            levels={nowPrice !== null && selectedOutcome ? [{ id: "now", label: `${selectedOutcome.label} ${formatProbability(nowPrice)}`, price: nowPrice, tone: "mark" }] : []}
            label={selectedOutcome ? `${selectedOutcome.label}: ${copy.market.week}` : copy.market.week}
            empty={copy.market.noBook}
            caption={outcomeHistory.length > 1 ? `${copy.market.week}: ${formatProbability(outcomeHistory[0]!.p)} to ${formatProbability(outcomeHistory[outcomeHistory.length - 1]!.p)}` : null}
          />
          <ul className="kp-outcomes" aria-label={copy.market.outcomes}>
            {detail?.outcomes.map((outcome) => {
              const price = outcome.book?.asks[0]?.price ?? outcome.price;
              return (
                <li key={outcome.tokenId}>
                  <button type="button" className="kp-outcome" aria-pressed={ticket.outcome === outcome.label} onClick={() => update({ outcome: outcome.label })}>
                    <span className="kp-outcome-l">{copy.market.choose(outcome.label)}</span>
                    <span className="kv-num kp-outcome-p" aria-label={`${copy.market.probability} ${formatProbability(price)}`}>{formatProbability(price)}</span>
                    <span className="kp-outcome-bar" aria-hidden="true"><i style={{ width: `${Math.round(Math.min(1, Math.max(0, price ?? 0)) * 100)}%` }} /></span>
                  </button>
                </li>
              );
            })}
          </ul>
          {buyingOff && ticket.outcome ? <ViewNote tone="warning" role="status">{copy.market.buyOff(ticket.outcome)}</ViewNote> : null}
          <section aria-labelledby="predict-book" className="kv-sec">
            <h4 id="predict-book" className="kv-eng">{copy.market.book}{selectedOutcome ? ` · ${selectedOutcome.label}` : ""}{depth ? ` · ${copy.market.spread(depth.spread)}` : ""}</h4>
            {depth ? (
              <div className="kp-book">
                <DepthList title={copy.market.bids} rows={depth.bids} tone="bid" />
                <DepthList title={copy.market.asks} rows={depth.asks} tone="ask" />
              </div>
            ) : <p className="kv-muted">{selectedOutcome?.unavailable ?? copy.market.noBook}</p>}
          </section>
          {market.description ? (
            <details className="kt-more">
              <summary>{copy.market.rules}</summary>
              <p className="kv-intro" style={{ whiteSpace: "pre-line" }}>{market.description}</p>
            </details>
          ) : null}
          <a className="kv-link" href={market.url} target="_blank" rel="noreferrer">{copy.market.onPolymarket}</a>
        </>
      ) : null}
    </section>
  ) : null;

  const ticketPane = (
    <>
      <Ticket id="predict-ticket" title={copy.ticket.heading}>
        {!market ? (
          <p className="kt-risk">{marketId ? copy.market.loading : copy.ticket.pick}</p>
        ) : (
          <>
            <SideSwitch
              label={copy.ticket.sideLabel}
              value={ticket.side}
              onChange={(side) => update({ side })}
              options={[
                { id: "buy", label: copy.ticket.buy, tone: "go" },
                { id: "sell", label: copy.ticket.sell, tone: "stop" },
              ]}
            />
            <Cartridges
              label={copy.ticket.outcomeLabel}
              value={ticket.outcome ?? ""}
              onChange={(outcome) => update({ outcome: outcome || null })}
              options={market.outcomes.map((outcome) => {
                const price = detail?.outcomes.find((entry) => entry.label === outcome.label);
                return { id: outcome.label, label: outcome.label, ...(price ? { detail: formatProbability(price.book?.asks[0]?.price ?? price.price) } : {}) };
              })}
            />
            <div className="k-field">
              <p className="k-field-label">{copy.ticket.orderTypeLabel}</p>
              <Segmented
                fill
                ariaLabel={copy.ticket.orderTypeLabel}
                value={ticket.orderType}
                onChange={(orderType) => update({ orderType })}
                options={[
                  { id: "market", label: copy.ticket.market },
                  { id: "limit", label: copy.ticket.limit },
                ]}
              />
            </div>
            <label className="kv-field">
              <span className={VIEW_LABEL}>{ticket.side === "buy" ? copy.ticket.amountBuy : copy.ticket.amountSell}</span>
              <input className={VIEW_FIELD} inputMode="decimal" autoComplete="off" placeholder={ticket.side === "buy" ? "20" : "50"} value={ticket.amount} onChange={(event) => update({ amount: event.target.value })} />
            </label>
            {ticket.orderType === "limit" ? (
              <label className="kv-field">
                <span className={VIEW_LABEL}>{copy.ticket.limitLabel}</span>
                <input className={VIEW_FIELD} inputMode="decimal" autoComplete="off" placeholder="42" value={ticket.limitCents} onChange={(event) => update({ limitCents: event.target.value })} />
              </label>
            ) : (
              <div className="k-field">
                <p className="k-field-label">{copy.ticket.slippageLabel}</p>
                <Segmented
                  fill
                  ariaLabel={copy.ticket.slippageLabel}
                  value={String(ticket.slippageBps)}
                  onChange={(value) => update({ slippageBps: Number(value) })}
                  options={SLIPPAGE_OPTIONS.map((bps) => ({ id: String(bps), label: `${(bps / 100).toFixed(0)}% past the book` }))}
                />
              </div>
            )}
            {problems.length > 0 ? <ul className="kt-problems">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul> : null}
            <Button variant="secondary" loading={pending === "quote"} disabled={problems.length > 0 || pending !== null} onClick={() => void getQuote()}>{copy.ticket.quote}</Button>
            {quote ? <ViewFacts live rows={quoteRows(quote.quote).map((row) => ({ label: row.label, value: row.value, tone: row.tone }))} /> : null}
            {quote?.quote.warnings.map((warning) => <ViewNote key={warning} tone="warning">{warning}</ViewNote>)}
            {quote && !account ? (
              <div className="kv-field">
                <p className="kt-risk">{copy.ticket.walletNeeded}</p>
                <Button variant="secondary" onClick={() => actions.openWallet("eip155")}>{copy.ticket.connect}</Button>
              </div>
            ) : null}
            {quote && tradesFrom ? <p className="kt-risk" style={{ overflowWrap: "anywhere" }}><b>{copy.ticket.tradesFrom}:</b> {tradesFrom}</p> : null}
            {quote && account && !canTrade ? <ViewNote tone="warning">{copy.ticket.smartWallet}</ViewNote> : null}
            {quote && buyingOff ? <ViewNote tone="warning">{copy.ticket.buyOff}</ViewNote> : null}
            {quote && account && !run.run && !buyingOff && canTrade ? (
              <Key tone="lime" disabled={pending !== null} aria-busy={pending === "prepare" || undefined} onClick={() => void prepare()}>{copy.ticket.review}</Key>
            ) : null}
            {requestError ? <ApiErrorPanel error={requestError} /> : null}
          </>
        )}
        {run.run ? (
          <SigningStrip
            id="predict-steps"
            title={copy.steps.heading}
            steps={run.run.steps.map((entry, index) => {
              const state = run.run!.states[index];
              return {
                id: entry.id,
                title: entry.title,
                state: stripState(state),
                word: state === "signing" ? copy.steps.signing : state === "confirming" ? copy.steps.confirming : state === "relaying" ? copy.steps.relaying : state === "done" ? copy.steps.done : state === "failed" ? copy.steps.failed : "",
                extra:
                  entry.kind === "transaction" && entry.disclosure ? (
                    <details className="kt-more">
                      <summary>{copy.steps.disclosure}</summary>
                      <p>{entry.disclosure}</p>
                    </details>
                  ) : undefined,
              };
            })}
          >
            {run.prepared?.warnings.map((warning) => <ViewNote key={warning} tone="warning">{warning}</ViewNote>)}
            {run.run.error ? <ViewNote role="alert" tone="danger">{run.run.error}</ViewNote> : null}
            {run.run.result ? <ViewNote role="status" tone="info">{run.run.result}</ViewNote> : null}
            {step >= 0 ? <Button loading={run.busy} onClick={() => void run.advance()}>{step === 0 && run.run.states[0] === "waiting" ? copy.steps.start : copy.steps.continue}</Button> : null}
            <Button variant="ghost" size="sm" disabled={run.busy} onClick={run.reset}>{copy.steps.cancel}</Button>
          </SigningStrip>
        ) : null}
      </Ticket>
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
    </>
  );

  const restPane = (
    <>
      {marketId ? searchPane : null}
      {account && canTrade && (walletsView || walletsError) ? <PredictOrders account={account} wallet={holder} signIn={run.signIn} /> : null}
      <section aria-labelledby="predict-positions" className="kv-sec">
        <div className="kv-sec-h">
          <h3 id="predict-positions">{wallet ? copy.positions.headingOf(walletLine(wallet)) : copy.positions.heading}</h3>
        </div>
        {!account ? <ViewEmpty action={<Button variant="secondary" size="sm" onClick={() => actions.openWallet("eip155")}>{copy.ticket.connect}</Button>}>{copy.positions.connect}</ViewEmpty> : null}
        {positionFilter ? (
          <p className="kp-filter">
            {copy.positions.filtered(positionFilter)}
            <Button size="sm" variant="ghost" onClick={() => setPositionFilter(null)}>{copy.positions.showAll}</Button>
          </p>
        ) : null}
        {account && positions && held.length === 0 ? <ViewEmpty>{copy.positions.none}</ViewEmpty> : null}
        <ul className="kt-list">
          {held.map((row) => (
            <li key={row.key} className="kt-pos">
              <p className="kt-pos-h">
                <b>{row.title}</b>
                <span className="kv-muted">{row.outcome}{row.redeemable ? ` · ${copy.positions.resolved}` : ""}</span>
              </p>
              <ViewFacts
                rows={[
                  { label: copy.positions.shares, value: row.shares },
                  { label: copy.positions.price, value: row.price },
                  { label: copy.positions.value, value: row.value },
                  { label: copy.positions.pnl, value: row.pnl, tone: row.pnlTone === "loss" ? "warn" : undefined },
                ]}
              />
              <div className="kt-pos-act">
                {row.redeemable ? (
                  <Button size="sm" variant="secondary" loading={pending === "redeem"} disabled={pending !== null || run.busy || !canTrade} onClick={() => void redeem(row.conditionId)}>{copy.positions.redeem}</Button>
                ) : (
                  <Button size="sm" variant="secondary" disabled={pending !== null || run.busy} onClick={() => openMarket(row.conditionId, { side: "sell", outcome: row.outcome, amount: row.shares.replace(/,/gu, "") })}>{copy.positions.sell}</Button>
                )}
              </div>
            </li>
          ))}
        </ul>
        {positions?.truncated ? <p className="kv-muted">{copy.positions.truncated}</p> : null}
      </section>
      <aside aria-labelledby="predict-risk" className="kv-field" style={{ gap: 10 }}>
        <ViewNote tone="warning">
          <h3 id="predict-risk">{copy.risk.heading}</h3>
          <ul>
            {copy.risk.lines.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </ViewNote>
      </aside>
    </>
  );

  return (
    <section aria-labelledby="predict-heading" className="flex min-w-0 flex-col gap-6 pb-8">
      <ViewHeader id="predict-heading" title={copy.heading} intro={copy.intro} />
      <HandoffNote text={handoffNote} />
      <ViewNote tone={location?.tone ?? "neutral"} role="status">
        {location ? location.text : copy.location.checking}{" "}
        <a href={list?.venues.find((venue) => venue.id === "polymarket")?.termsUrl ?? "https://polymarket.com/tos"} target="_blank" rel="noreferrer">{copy.location.terms}</a>
      </ViewNote>
      <TradeLayout main={marketPane ?? searchPane} ticket={ticketPane} rest={restPane} />
    </section>
  );
}

export default PredictView;
