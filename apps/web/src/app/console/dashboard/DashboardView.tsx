/**
 * The desk's Dashboard view (/app/dashboard, Portfolio), in the Card machine language: net worth on
 * an odometer with the 24-hour change, the allocation bar, the value over time and PnL estimates of
 * the tracked set (ValueSection.tsx), the binder of settled cards from this browser (filters, share
 * export as a 1080 x 1350 PNG) beside the recent activity, then positions with loan health, the
 * best rates with "Move here" (puts a deposit sentence in the composer; nothing is sent) and a CSV
 * export. Loaded lazily by DeskApp; its styles live in dashboard.css so they never reach the entry
 * stylesheet.
 *
 * Unknown values are shown as "Unknown" with their reason, never as $0.
 */
import "./dashboard.css";

import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { CHAINS, type DataAllocationSlice, type DataFailure, type LendingHealth } from "@kletia/core";

import { ActivityFeed } from "../../../shared/sync/ActivityFeed";
import { Icon, MiniCard, Odometer, Segmented } from "../../kit";
import { DESK_COPY } from "../content/copy";
import { useDeskActions } from "../shell/deskContext";
import { ViewEmpty, ViewHeader, ViewLoading, ViewNote } from "../shell/ViewParts";
import { getDeskStore, useDeskStore } from "../state/deskStore";
import { clockOf } from "../tasks/taskModel";
import { BINDER_FILTERS, binderCounts, binderEntries, filterBinder, type BinderEntry, type BinderFilter } from "./binderModel";
import {
  allocationBars,
  csvFileName,
  dashboardCsv,
  dashboardKpis,
  formatDashboardUsd,
  heldSymbols,
  percentText,
  positionRows,
  yieldRows,
  type DashboardLane,
} from "./dashboardModel";
import { useDashboardData } from "./useDashboardData";
import { ValueSection } from "./ValueSection";

const copy = DESK_COPY.dashboard;
/** Binder words (Card machine): the settled cards of this browser. */
const BINDER = {
  title: "Binder",
  count: (count: number) => `${count} card${count === 1 ? "" : "s"}`,
  filters: "Show cards",
  empty: "No settled cards yet. Every plan you sign and settle from the desk is filed here as a card.",
  emptyFilter: "No card of this kind yet.",
  note: "Cards from this browser's desk. Foils are earned by facts: cross-chain cards are holo.",
  open: (serial: string) => `Open card ${serial} on the desk`,
  share: (serial: string) => `Save card ${serial} as an image`,
  shareLabel: "Share",
  openLabel: "Open",
  netWorth: "Net worth",
  recent: "Recent",
} as const;

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** One stacked bar of the allocation (network): proportional segments, the labels as text under them. */
function AllocationBar({ slices }: { readonly slices: readonly DataAllocationSlice[] }) {
  const bars = allocationBars(slices);
  if (bars.length === 0) return <p className="kv-muted">{copy.allocationEmpty}</p>;
  return (
    <ol className="kdb-abar" aria-label={copy.byNetwork}>
      {bars.map((bar, index) => (
        <li key={bar.key} style={{ flexGrow: Math.max(bar.share, 0.04) }} data-at={index} title={`${bar.label}: ${formatDashboardUsd(bar.usd)} (${percentText(bar.share, 1)})`}>
          <span className="kdb-abar-seg" aria-hidden="true" />
          <small>
            <b>{bar.label}</b> {percentText(bar.share, 0)}
          </small>
        </li>
      ))}
    </ol>
  );
}

/** Horizontal bars of one allocation: label and value as text, the bar itself decorative. */
function AllocationChart({ title, slices }: { readonly title: string; readonly slices: readonly DataAllocationSlice[] }) {
  const bars = allocationBars(slices);
  return (
    <figure className="kdb-chart">
      <figcaption className="kv-eng">{title}</figcaption>
      {bars.length === 0 ? (
        <p className="kv-muted">{copy.allocationEmpty}</p>
      ) : (
        <ol className="kdb-bars">
          {bars.map((bar) => {
            const label = `${bar.label}: ${formatDashboardUsd(bar.usd)} (${percentText(bar.share, 1)})`;
            return (
              <li key={bar.key} className="kdb-bar" title={label}>
                <span className="kdb-bar-label">{bar.label}</span>
                <span className="kdb-bar-track" aria-hidden="true">
                  <i style={{ width: `${Math.max(1, bar.length * 100)}%` }} />
                </span>
                <span className="kdb-bar-value">
                  {formatDashboardUsd(bar.usd)} <span className="kv-muted">{percentText(bar.share, 1)}</span>
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </figure>
  );
}

function HealthList({ rows }: { readonly rows: readonly LendingHealth[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="kv-panel">
      <h3 className="kv-eng">{copy.healthTitle}</h3>
      <ul className="kdb-health-list">
        {rows.map((row) => (
          <li key={`${row.account}|${row.market}`} className="kdb-health" data-status={row.status}>
            <span className="kdb-health-lamp" aria-hidden="true" />
            <span>
              <b>
                {CHAINS[row.network].shortName} {row.protocol}
              </b>{" "}
              <span className="kv-num">{row.healthFactor === null ? copy.unknown : row.healthFactor.toFixed(2)}</span> <span className="kdb-status">{copy.healthStatus[row.status]}</span>
              {row.reason ? <span className="kdb-reason">{row.reason}</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Unread({ failures }: { readonly failures: readonly DataFailure[] }) {
  if (failures.length === 0) return null;
  return (
    <details className="kv-more kdb-unread">
      <summary>{`${copy.unreadTitle} (${failures.length})`}</summary>
      <ul>
        {failures.map((failure) => (
          <li key={`${failure.subject}|${failure.code}`}>
            <span className="kv-num">{failure.subject}</span>: {failure.message}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** The binder: every settled card of this browser, filtered, each one openable and shareable. */
function Binder() {
  const actions = useDeskActions();
  const tasks = useDeskStore((state) => state.tasks);
  const entries = useMemo(() => binderEntries(tasks), [tasks]);
  const counts = binderCounts(entries);
  const [filter, setFilter] = useState<BinderFilter>("all");
  const shown = filterBinder(entries, filter);
  const [sharing, setSharing] = useState<string | null>(null);

  const open = (entry: BinderEntry) => {
    actions.openView("desk");
    getDeskStore().getState().focusTask(entry.id);
  };
  const share = async (entry: BinderEntry) => {
    setSharing(entry.id);
    try {
      const { downloadShareCard } = await import("./shareCard");
      await downloadShareCard(entry, document.documentElement.classList.contains("dark") ? "dark" : "light");
    } finally {
      setSharing(null);
    }
  };

  return (
    <section aria-labelledby="kdb-binder" className="kv-sec">
      <div className="kdb-binder-h">
        <h3 id="kdb-binder" className="kdb-h3">
          {BINDER.title} <span className="kv-muted">{BINDER.count(entries.length)}</span>
        </h3>
        {entries.length > 0 ? (
          <Segmented
            ariaLabel={BINDER.filters}
            value={filter}
            onChange={setFilter}
            options={BINDER_FILTERS.filter((entry) => entry.id === "all" || counts[entry.id] > 0).map((entry) => ({ id: entry.id, label: entry.label }))}
          />
        ) : null}
      </div>
      {entries.length === 0 ? (
        <div className="kdb-sleeve">
          <span className="kdb-sleeve-card" aria-hidden="true">
            <Icon name="binder" />
          </span>
          <p>{BINDER.empty}</p>
        </div>
      ) : shown.length === 0 ? (
        <ViewEmpty>{BINDER.emptyFilter}</ViewEmpty>
      ) : (
        <ul className="kdb-bgrid">
          {shown.map((entry) => (
            <li key={entry.id}>
              <MiniCard kind={entry.kind} serial={entry.serial} title={entry.title} sub={entry.sub} route={entry.route} date={entry.date} tag={entry.tag} foil={entry.foil}>
                <button type="button" className="kdb-cardkey" aria-label={BINDER.open(entry.serial)} onClick={() => open(entry)}>
                  {BINDER.openLabel}
                </button>
                <button type="button" className="kdb-cardkey" aria-label={BINDER.share(entry.serial)} aria-busy={sharing === entry.id || undefined} disabled={sharing !== null} onClick={() => void share(entry)}>
                  <Icon name="share" />
                  {BINDER.shareLabel}
                </button>
              </MiniCard>
            </li>
          ))}
        </ul>
      )}
      {entries.length > 0 ? <p className="kdb-foot">{BINDER.note}</p> : null}
    </section>
  );
}

export default function DashboardView({ lane }: { readonly lane: DashboardLane }) {
  const actions = useDeskActions();
  const evm = actions.accounts.evm?.address ?? null;
  const solana = actions.accounts.solana?.address ?? null;
  const { portfolio, yields, loading, error, refresh } = useDashboardData(evm, solana, lane);
  const connected = Boolean(evm || solana);
  const kpis = portfolio ? dashboardKpis(portfolio) : [];
  const net = kpis.find((kpi) => kpi.id === "net");
  const change = kpis.find((kpi) => kpi.id === "change");
  const others = kpis.filter((kpi) => kpi.id === "positions" || kpi.id === "health");

  const moveHere = (sentence: string) => {
    actions.fill(sentence);
    actions.openView("desk");
  };

  return (
    <section aria-labelledby="desk-dashboard-heading" className="kdb">
      <ViewHeader
        id="desk-dashboard-heading"
        title={copy.title}
        intro={copy.intro}
        action={
          connected ? (
            <button type="button" onClick={refresh} aria-label={copy.refresh} disabled={loading} className="k-key k-key--sm">
              <RefreshCw className={loading ? "kdb-spin" : undefined} aria-hidden="true" />
              {portfolio ? <span>{copy.readAt(clockOf(portfolio.asOf))}</span> : null}
            </button>
          ) : null
        }
      />

      {!connected ? <ViewEmpty>{copy.connect}</ViewEmpty> : null}
      {connected && error ? (
        <ViewNote role="alert" tone="danger">
          {copy.unavailable} {error}{" "}
          <button type="button" className="kv-link" onClick={refresh}>
            {copy.retry}
          </button>
        </ViewNote>
      ) : null}
      {connected && loading && !portfolio ? <ViewLoading>{copy.loading}</ViewLoading> : null}

      {connected && portfolio && net ? (
        <section aria-label={copy.kpiLabel} className="kdb-nw">
          <div className="kdb-nw-l">
            <p className="kv-eng">{BINDER.netWorth}</p>
            <p className="kdb-nw-v" aria-label={`${net.label}: ${net.value}`}>
              {net.value === "Unknown" ? net.value : <Odometer value={net.value} />}
            </p>
            {change ? (
              <p className="kdb-nw-d" data-tone={change.tone}>
                <span className="kv-num">{change.value}</span> <span className="kv-muted">{change.label}</span>
              </p>
            ) : null}
            {net.note ? <p className="kdb-foot">{net.note}</p> : null}
          </div>
          <dl className="kdb-readouts">
            {others.map((kpi) => (
              <div key={kpi.id} data-tone={kpi.tone}>
                <dt>{kpi.label}</dt>
                <dd className="kv-num">{kpi.value}</dd>
                {kpi.note ? <dd className="kdb-readout-note">{kpi.note}</dd> : null}
              </div>
            ))}
          </dl>
        </section>
      ) : null}
      {connected && portfolio && !portfolio.totals.complete ? <p className="kdb-foot">{copy.partial}</p> : null}
      {connected && portfolio ? <AllocationBar slices={portfolio.allocation.byNetwork} /> : null}

      <ValueSection lane={lane} />

      <div className="kdb-grid2">
        <Binder />
        <section aria-labelledby="kdb-activity" className="kv-sec">
          <div className="kv-sec-h">
            <h3 id="kdb-activity" className="kdb-h3">
              {BINDER.recent}
            </h3>
            <p>{copy.activityNote}</p>
          </div>
          <ActivityFeed compact limit={10} title={copy.activity} emptyHint={DESK_COPY.activity.empty} />
        </section>
      </div>

      {connected && portfolio ? (
        <section aria-labelledby="kdb-allocation" className="kv-sec">
          <div className="kv-sec-h">
            <h3 id="kdb-allocation" className="kdb-h3">
              {copy.allocation}
            </h3>
          </div>
          <div className="kdb-charts">
            <AllocationChart title={copy.byNetwork} slices={portfolio.allocation.byNetwork} />
            <AllocationChart title={copy.byAsset} slices={portfolio.allocation.byAsset} />
            <AllocationChart title={copy.byProtocol} slices={portfolio.allocation.byProtocol} />
          </div>
        </section>
      ) : null}

      {connected && portfolio ? (
        <section aria-labelledby="kdb-positions" className="kv-sec">
          <div className="kv-sec-h">
            <h3 id="kdb-positions" className="kdb-h3">
              {copy.positions}
            </h3>
          </div>
          {portfolio.positions.length === 0 ? (
            <p className="kv-muted">{copy.positionsEmpty}</p>
          ) : (
            <div className="kv-table-wrap">
              <table className="kv-table">
                <thead>
                  <tr>
                    <th scope="col">{copy.columns.position}</th>
                    <th scope="col">{copy.columns.network}</th>
                    <th scope="col">{copy.columns.kind}</th>
                    <th scope="col">{copy.columns.amount}</th>
                    <th scope="col" className="kv-r">
                      {copy.columns.value}
                    </th>
                    <th scope="col" className="kv-r">
                      {copy.columns.apy}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {positionRows(portfolio.positions).map((row) => (
                    <tr key={row.key} data-debt={row.debt ? "" : undefined}>
                      <th scope="row">
                        {row.name}
                        {row.note ? <span className="kdb-reason">{row.note}</span> : null}
                      </th>
                      <td>{row.network}</td>
                      <td>{row.kind}</td>
                      <td className="kv-num">{row.amount}</td>
                      <td className="kv-r kv-num">{row.value}</td>
                      <td className="kv-r kv-num">{row.apy}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <HealthList rows={portfolio.health} />
        </section>
      ) : null}

      <section aria-labelledby="kdb-yields" className="kv-sec">
        <div className="kv-sec-h">
          <h3 id="kdb-yields" className="kdb-h3">
            {copy.yields}
          </h3>
          <p>{copy.yieldsNote}</p>
        </div>
        {yields && yields.yields.length > 0 ? (
          <div className="kv-table-wrap">
            <table className="kv-table">
              <thead>
                <tr>
                  <th scope="col">{copy.columns.venue}</th>
                  <th scope="col">{copy.columns.network}</th>
                  <th scope="col">{copy.columns.asset}</th>
                  <th scope="col" className="kv-r">
                    {copy.columns.apy}
                  </th>
                  <th scope="col">
                    <span className="sr-only">{copy.moveHere}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {yieldRows(yields.yields, portfolio ? heldSymbols(portfolio) : new Set()).map(({ moveText, ...row }) => (
                  <tr key={row.key}>
                    <th scope="row">
                      {row.name}
                      {row.note ? <span className="kdb-reason">{row.note}</span> : null}
                    </th>
                    <td>{row.network}</td>
                    <td>{row.asset}</td>
                    <td className="kv-r kv-num">{row.apy}</td>
                    <td className="kv-r">
                      {moveText ? (
                        <button type="button" className="kv-link" aria-label={copy.moveHereLabel(row.name)} onClick={() => moveHere(moveText)}>
                          {copy.moveHere}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="kv-muted">{loading ? copy.loading : copy.yieldsEmpty}</p>
        )}
      </section>

      {connected && portfolio ? (
        <section aria-labelledby="kdb-export" className="kv-sec">
          <div className="kv-sec-h">
            <h3 id="kdb-export" className="kdb-h3">
              {copy.exportTitle}
            </h3>
          </div>
          <div className="kdb-export">
            <button type="button" className="k-key k-key--sm" onClick={() => download(csvFileName("holdings", portfolio.asOf), dashboardCsv("holdings", portfolio))}>
              {copy.exportHoldings}
            </button>
            <button type="button" className="k-key k-key--sm" onClick={() => download(csvFileName("positions", portfolio.asOf), dashboardCsv("positions", portfolio))}>
              {copy.exportPositions}
            </button>
          </div>
          <Unread failures={portfolio.failures} />
        </section>
      ) : null}
    </section>
  );
}
