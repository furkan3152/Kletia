/**
 * The desk's History view (/app/history, Portfolio section): every on-chain
 * transaction of the signed-in wallet's tracked set, newest first, with
 * filters (network, type, asset, Kletia only) and "Load older" paging. Each
 * row opens to its legs with the value at the time, the fee, the protocol,
 * the explorer link and, for a Kletia step, its receipt. Accounts the API
 * could not read are listed, never shown as empty history.
 */
import "./history.css";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ExternalLink } from "lucide-react";
import { CHAINS, NETWORK_KEYS, type DataLane, type DataTransaction, type DataTxCoverage, type DataTxKind, type NetworkKey } from "@kletia/core";

import { Button } from "../../site/ui/Button";
import { DESK_COPY } from "../content/copy";
import { ViewEmpty, ViewHeader, ViewLoading, ViewNote } from "../shell/ViewParts";
import { VIEW_FIELD } from "../shell/viewStyles";
import { historyApi } from "./historyClient";
import { coverageNotes, EMPTY_FILTERS, filterQuery, historyNotConfigured, historyRow, KIND_LABELS, KIND_OPTIONS, legValue, type HistoryFilters } from "./historyModel";
import { TrackingGate } from "./TrackingGate";
import { errorText } from "./useTracking";

const copy = DESK_COPY.history;

const LINK =
  "inline-flex min-h-11 items-center gap-1 text-xs font-black uppercase tracking-wider text-[var(--kl-accent-text)] underline underline-offset-4 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[var(--kl-focus)]";

function TransactionItem({ tx }: { readonly tx: DataTransaction }) {
  const row = historyRow(tx);
  return (
    <li className="khs-item" data-kind={row.kind}>
      <details>
        <summary className="khs-summary">
          <span className="khs-title">
            <span className="font-bold">{row.title}</span>
            {row.kletia ? <span className="khs-badge">{copy.kletiaBadge}</span> : null}
            {row.failed ? <span className="khs-badge" data-tone="danger">{copy.failed}</span> : null}
            <span className="block text-xs text-muted">{row.meta}</span>
          </span>
          <span className="khs-legs font-code">
            {row.legs.slice(0, 2).map((line) => (
              <span key={line} className="block" data-direction={line.startsWith("+") ? "in" : "out"}>{line}</span>
            ))}
            {row.legs.length > 2 ? <span className="block text-xs text-muted">+{row.legs.length - 2}</span> : null}
          </span>
        </summary>
        <div className="khs-detail">
          <dl className="khs-facts">
            <div>
              <dt>{copy.legs}</dt>
              <dd>
                {tx.legs.length === 0 ? <span className="text-muted">{copy.noLegs}</span> : (
                  <ul className="flex flex-col gap-1">
                    {tx.legs.map((leg, index) => {
                      const value = legValue(leg);
                      return (
                        <li key={`${leg.asset.address ?? "native"}|${index}`} className="break-words">
                          <span className="font-code">{row.legs[index]}</span>{" "}
                          <span className={value.known ? "" : "text-muted"}>({value.known ? `${copy.valueAt}: ${value.text}` : value.text})</span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </dd>
            </div>
            {row.fee ? (
              <div>
                <dt>{copy.fee}</dt>
                <dd className="font-code">{row.fee}{tx.fee?.reason ? <span className="block font-sans text-xs text-muted">{tx.fee.reason}</span> : null}</dd>
              </div>
            ) : null}
            {row.protocol ? (
              <div>
                <dt>{copy.protocol}</dt>
                <dd>{row.protocol}</dd>
              </div>
            ) : null}
            {row.counterparty ? (
              <div>
                <dt>{copy.counterparty}</dt>
                <dd className="break-all font-code text-xs">{row.counterparty}</dd>
              </div>
            ) : null}
          </dl>
          <div className="flex flex-wrap gap-x-4">
            <a className={LINK} href={row.explorerUrl} target="_blank" rel="noreferrer noopener">
              {copy.explorer(row.explorerName)} <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
            {row.receiptPath ? <a className={LINK} href={row.receiptPath}>{copy.receipt}</a> : null}
          </div>
        </div>
      </details>
    </li>
  );
}

interface Listing {
  readonly key: string;
  readonly transactions: readonly DataTransaction[];
  readonly cursor: string | null;
  readonly coverage: readonly DataTxCoverage[];
}

function HistoryList({ token, lane }: { readonly token: string; readonly lane: DataLane }) {
  const [draft, setDraft] = useState<HistoryFilters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<HistoryFilters>(EMPTY_FILTERS);
  /** The last read: its filters and round (`key`), the listing, or why it failed. */
  const [reading, setReading] = useState<{ readonly key: string; readonly listing: Listing | null; readonly error: string | null } | null>(null);
  const [paging, setPaging] = useState(false);
  const [round, setRound] = useState(0);
  const key = JSON.stringify(filters);
  const readKey = `${key}|${round}`;

  useEffect(() => {
    const controller = new AbortController();
    historyApi.transactions(token, filterQuery(filters), controller.signal).then(
      (page) => setReading({ key: readKey, listing: { key, transactions: page.transactions, cursor: page.cursor, coverage: page.coverage }, error: null }),
      (failure: unknown) => {
        if (!controller.signal.aborted) setReading({ key: readKey, listing: null, error: errorText(failure) });
      },
    );
    return () => controller.abort();
  }, [token, filters, key, readKey]);

  const listing = reading?.key === readKey ? reading.listing : null;
  const loading = reading?.key !== readKey;
  const error = reading?.key === readKey ? reading.error : null;

  const older = useCallback(async () => {
    if (!listing?.cursor) return;
    setPaging(true);
    try {
      const page = await historyApi.transactions(token, filterQuery(filters, listing.cursor));
      setReading({ key: readKey, listing: { ...listing, transactions: [...listing.transactions, ...page.transactions], cursor: page.cursor, coverage: page.coverage }, error: null });
    } catch (failure) {
      setReading({ key: readKey, listing, error: errorText(failure) });
    } finally {
      setPaging(false);
    }
  }, [listing, token, filters, readKey]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFilters(draft);
  };

  const current = listing && listing.key === key ? listing : null;
  const notes = current ? coverageNotes(current.coverage) : [];
  const networks = NETWORK_KEYS.filter((network) => (CHAINS[network].lane === "testnet" ? "testnet" : "production") === lane);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <form className="khs-filters" onSubmit={submit} aria-label={copy.filters}>
        <label className="khs-field">
          <span>{copy.network}</span>
          <select className={VIEW_FIELD} value={draft.network} onChange={(event) => setDraft({ ...draft, network: event.target.value as NetworkKey | "" })}>
            <option value="">{copy.any}</option>
            {networks.map((network) => <option key={network} value={network}>{CHAINS[network].shortName}</option>)}
          </select>
        </label>
        <label className="khs-field">
          <span>{copy.kind}</span>
          <select className={VIEW_FIELD} value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as DataTxKind | "" })}>
            <option value="">{copy.any}</option>
            {KIND_OPTIONS.map((kind) => <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>)}
          </select>
        </label>
        <label className="khs-field">
          <span>{copy.asset}</span>
          <input className={VIEW_FIELD} value={draft.asset} placeholder={copy.assetPlaceholder} maxLength={64} onChange={(event) => setDraft({ ...draft, asset: event.target.value })} />
        </label>
        <label className="khs-check">
          <input type="checkbox" checked={draft.kletiaOnly} onChange={(event) => setDraft({ ...draft, kletiaOnly: event.target.checked })} />
          <span>{copy.kletiaOnly}</span>
        </label>
        <Button type="submit" size="sm" variant="secondary">{copy.apply}</Button>
      </form>

      {error ? (
        <ViewNote role="alert" tone="danger">
          {copy.unavailable} {error}{" "}
          <button type="button" className={LINK} onClick={() => setRound((value) => value + 1)}>{copy.retry}</button>
        </ViewNote>
      ) : null}
      {current && historyNotConfigured(current.coverage) ? <ViewNote tone="info">{copy.notConfigured}</ViewNote> : null}
      {notes.length > 0 && !(current && historyNotConfigured(current.coverage)) ? (
        <details className="khs-card text-sm">
          <summary className="cursor-pointer font-bold">{`${copy.coverageTitle} (${notes.length})`}</summary>
          <ul className="mt-2 flex flex-col gap-1 text-xs">
            {notes.map((note) => <li key={note} className="break-words">{note}</li>)}
          </ul>
        </details>
      ) : null}
      {loading && !current ? <ViewLoading>{copy.loading}</ViewLoading> : null}
      {current && current.transactions.length === 0 && !historyNotConfigured(current.coverage) ? <ViewEmpty>{copy.empty}</ViewEmpty> : null}
      {current && current.transactions.length > 0 ? (
        <ol className="khs-list">
          {current.transactions.map((tx) => <TransactionItem key={`${tx.account}|${tx.id}`} tx={tx} />)}
        </ol>
      ) : null}
      {current?.cursor ? (
        <div>
          <Button size="sm" variant="secondary" loading={paging} onClick={() => void older()}>{copy.older}</Button>
        </div>
      ) : null}
    </div>
  );
}

export default function HistoryView({ lane }: { readonly lane: DataLane }) {
  return (
    <section aria-labelledby="desk-history-heading" className="khs flex min-w-0 flex-col gap-5 pb-8">
      <ViewHeader id="desk-history-heading" title={copy.title} intro={copy.intro} />
      <TrackingGate lane={lane}>{({ token, tracking }) => <HistoryList token={token} lane={tracking.lane} />}</TrackingGate>
    </section>
  );
}
