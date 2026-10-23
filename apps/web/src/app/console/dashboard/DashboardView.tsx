/**
 * The desk's Dashboard view (/app/dashboard): one read-only page of the
 * connected wallets on every network of the lane. A KPI row (total value,
 * 24-hour change, positions, health warnings), allocation by network, asset
 * and protocol, the positions table with loan health, the best rates with
 * "Move here" (puts a deposit sentence in the composer; nothing is sent), the
 * browser's activity and a CSV export. Loaded lazily by DeskApp; its styles
 * live in dashboard.css so they never reach the entry stylesheet.
 *
 * Unknown values are shown as "Unknown" with their reason, never as $0.
 */
import "./dashboard.css";

import { RefreshCw } from "lucide-react";
import { CHAINS, type DataAllocationSlice, type DataFailure, type LendingHealth } from "@kletia/core";

import { ActivityFeed } from "../../../shared/sync/ActivityFeed";
import { DESK_COPY } from "../content/copy";
import { useDeskActions } from "../shell/deskContext";
import { clockOf } from "../tasks/taskModel";
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

const copy = DESK_COPY.dashboard;

const LINK =
  "inline-flex min-h-11 items-center text-xs font-black uppercase tracking-wider text-[var(--kl-accent-text)] underline underline-offset-4 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[var(--kl-focus)]";

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** Horizontal bars of one allocation: label and value as text, the bar itself decorative. */
function AllocationChart({ title, slices }: { readonly title: string; readonly slices: readonly DataAllocationSlice[] }) {
  const bars = allocationBars(slices);
  return (
    <figure className="kdb-chart">
      <figcaption className="kdb-chart-title">{title}</figcaption>
      {bars.length === 0 ? (
        <p className="text-sm text-muted">{copy.allocationEmpty}</p>
      ) : (
        <ol className="kdb-bars">
          {bars.map((bar) => {
            const label = `${bar.label}: ${formatDashboardUsd(bar.usd)} (${percentText(bar.share, 1)})`;
            return (
              <li key={bar.key} className="kdb-bar" title={label}>
                <span className="kdb-bar-label">{bar.label}</span>
                <svg className="kdb-bar-track" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true" focusable="false">
                  <rect className="kdb-bar-fill" x="0" y="0" width={Math.max(1, bar.length * 100)} height="8" rx="2" />
                </svg>
                <span className="kdb-bar-value">
                  {formatDashboardUsd(bar.usd)} <span className="text-muted">{percentText(bar.share, 1)}</span>
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
    <div className="kdb-card">
      <h3 className="kdb-subtitle">{copy.healthTitle}</h3>
      <ul className="flex flex-col gap-1 text-sm">
        {rows.map((row) => (
          <li key={`${row.account}|${row.market}`} className="kdb-health" data-status={row.status}>
            <span className="font-bold">{CHAINS[row.network].shortName} {row.protocol}</span>{" "}
            <span className="font-code">{row.healthFactor === null ? copy.unknown : row.healthFactor.toFixed(2)}</span>{" "}
            <span className="kdb-status">{copy.healthStatus[row.status]}</span>
            {row.reason ? <span className="block text-xs text-muted">{row.reason}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Unread({ failures }: { readonly failures: readonly DataFailure[] }) {
  if (failures.length === 0) return null;
  return (
    <details className="kdb-card text-sm">
      <summary className="cursor-pointer font-bold">{`${copy.unreadTitle} (${failures.length})`}</summary>
      <ul className="mt-2 flex flex-col gap-1 text-xs">
        {failures.map((failure) => (
          <li key={`${failure.subject}|${failure.code}`} className="break-words">
            <span className="font-code">{failure.subject}</span>: {failure.message}
          </li>
        ))}
      </ul>
    </details>
  );
}

export default function DashboardView({ lane }: { readonly lane: DashboardLane }) {
  const actions = useDeskActions();
  const evm = actions.accounts.evm?.address ?? null;
  const solana = actions.accounts.solana?.address ?? null;
  const { portfolio, yields, loading, error, refresh } = useDashboardData(evm, solana, lane);
  const connected = Boolean(evm || solana);

  const moveHere = (sentence: string) => {
    actions.fill(sentence);
    actions.openView("desk");
  };

  return (
    <section aria-labelledby="desk-dashboard-heading" className="kdb flex flex-col gap-6 pb-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="desk-dashboard-heading" className="font-display text-2xl font-bold">
          {copy.title}
        </h2>
        {connected ? (
          <button
            type="button"
            onClick={refresh}
            aria-label={copy.refresh}
            disabled={loading}
            className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 border-2 border-control bg-surface px-2 text-xs font-bold text-fg focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[var(--kl-focus)] disabled:opacity-60"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin motion-reduce:animate-none" : ""}`} aria-hidden="true" />
            {portfolio ? <span>{copy.readAt(clockOf(portfolio.asOf))}</span> : null}
          </button>
        ) : null}
      </div>
      <p className="text-sm">{copy.intro}</p>

      {!connected ? <p className="border-2 border-dashed border-control p-3 text-sm font-semibold">{copy.connect}</p> : null}
      {connected && error ? (
        <p role="alert" className="kdb-card text-sm font-bold">
          {copy.unavailable} {error}{" "}
          <button type="button" className={LINK} onClick={refresh}>{copy.retry}</button>
        </p>
      ) : null}
      {connected && loading && !portfolio ? <p className="text-sm font-bold" aria-live="polite">{copy.loading}</p> : null}

      {connected && portfolio ? (
        <>
          <dl aria-label={copy.kpiLabel} className="kdb-kpis">
            {dashboardKpis(portfolio).map((kpi) => (
              <div key={kpi.id} className="kdb-kpi" data-tone={kpi.tone}>
                <dt className="text-xs font-black uppercase tracking-[0.14em] text-muted">{kpi.label}</dt>
                <dd className="kdb-kpi-value font-code">{kpi.value}</dd>
                {kpi.note ? <dd className="text-xs text-muted">{kpi.note}</dd> : null}
              </div>
            ))}
          </dl>
          {portfolio.totals.complete ? null : <p className="text-xs text-muted">{copy.partial}</p>}

          <section aria-labelledby="kdb-allocation" className="flex flex-col gap-3">
            <h3 id="kdb-allocation" className="kdb-subtitle">{copy.allocation}</h3>
            <div className="kdb-charts">
              <AllocationChart title={copy.byNetwork} slices={portfolio.allocation.byNetwork} />
              <AllocationChart title={copy.byAsset} slices={portfolio.allocation.byAsset} />
              <AllocationChart title={copy.byProtocol} slices={portfolio.allocation.byProtocol} />
            </div>
          </section>

          <section aria-labelledby="kdb-positions" className="flex flex-col gap-3">
            <h3 id="kdb-positions" className="kdb-subtitle">{copy.positions}</h3>
            {portfolio.positions.length === 0 ? (
              <p className="text-sm text-muted">{copy.positionsEmpty}</p>
            ) : (
              <div className="kdb-table-wrap">
                <table className="kdb-table">
                  <thead>
                    <tr>
                      <th scope="col">{copy.columns.position}</th>
                      <th scope="col">{copy.columns.network}</th>
                      <th scope="col">{copy.columns.kind}</th>
                      <th scope="col">{copy.columns.amount}</th>
                      <th scope="col" className="kdb-num">{copy.columns.value}</th>
                      <th scope="col" className="kdb-num">{copy.columns.apy}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {positionRows(portfolio.positions).map((row) => (
                      <tr key={row.key} data-debt={row.debt ? "" : undefined}>
                        <th scope="row">
                          {row.name}
                          {row.note ? <span className="block text-xs font-normal text-muted">{row.note}</span> : null}
                        </th>
                        <td>{row.network}</td>
                        <td>{row.kind}</td>
                        <td className="font-code">{row.amount}</td>
                        <td className="kdb-num font-code">{row.value}</td>
                        <td className="kdb-num font-code">{row.apy}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <HealthList rows={portfolio.health} />
          </section>
        </>
      ) : null}

      <section aria-labelledby="kdb-yields" className="flex flex-col gap-3">
        <h3 id="kdb-yields" className="kdb-subtitle">{copy.yields}</h3>
        <p className="text-xs text-muted">{copy.yieldsNote}</p>
        {yields && yields.yields.length > 0 ? (
          <div className="kdb-table-wrap">
            <table className="kdb-table">
              <thead>
                <tr>
                  <th scope="col">{copy.columns.venue}</th>
                  <th scope="col">{copy.columns.network}</th>
                  <th scope="col">{copy.columns.asset}</th>
                  <th scope="col" className="kdb-num">{copy.columns.apy}</th>
                  <th scope="col"><span className="sr-only">{copy.moveHere}</span></th>
                </tr>
              </thead>
              <tbody>
                {yieldRows(yields.yields, portfolio ? heldSymbols(portfolio) : new Set()).map(({ moveText, ...row }) => (
                  <tr key={row.key}>
                    <th scope="row">
                      {row.name}
                      {row.note ? <span className="block text-xs font-normal text-muted">{row.note}</span> : null}
                    </th>
                    <td>{row.network}</td>
                    <td>{row.asset}</td>
                    <td className="kdb-num font-code">{row.apy}</td>
                    <td>
                      {moveText ? (
                        <button type="button" className={LINK} aria-label={copy.moveHereLabel(row.name)} onClick={() => moveHere(moveText)}>
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
          <p className="text-sm text-muted">{loading ? copy.loading : copy.yieldsEmpty}</p>
        )}
      </section>

      <section aria-labelledby="kdb-activity" className="flex flex-col gap-3">
        <h3 id="kdb-activity" className="kdb-subtitle">{copy.activity}</h3>
        <p className="text-xs text-muted">{copy.activityNote}</p>
        <ActivityFeed compact limit={10} title={copy.activity} emptyHint={DESK_COPY.activity.empty} />
      </section>

      {connected && portfolio ? (
        <section aria-labelledby="kdb-export" className="flex flex-col gap-2">
          <h3 id="kdb-export" className="kdb-subtitle">{copy.exportTitle}</h3>
          <div className="flex flex-wrap gap-x-4">
            <button type="button" className={LINK} onClick={() => download(csvFileName("holdings", portfolio.asOf), dashboardCsv("holdings", portfolio))}>
              {copy.exportHoldings}
            </button>
            <button type="button" className={LINK} onClick={() => download(csvFileName("positions", portfolio.asOf), dashboardCsv("positions", portfolio))}>
              {copy.exportPositions}
            </button>
          </div>
          <Unread failures={portfolio.failures} />
        </section>
      ) : null}
    </section>
  );
}
