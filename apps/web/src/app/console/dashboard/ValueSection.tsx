/**
 * The Dashboard's value over time and PnL estimates for the signed-in
 * wallet's tracked set (`/v1/data/snapshots`, `/v1/data/pnl`): a range
 * switch (24h, 7d, 30d, all), one line chart with its first and last value
 * and the change as text, and FIFO PnL per asset. Behind the tracking
 * opt-in; fewer than two readings say so instead of drawing a flat line.
 */
import { useEffect, useState } from "react";
import { DATA_SNAPSHOT_RANGES, type DataLane, type DataPnl, type DataSnapshotRange, type DataSnapshotSeries } from "@kletia/core";

import { DESK_COPY } from "../content/copy";
import { pnlRows, signedUsd, usd, valueChart } from "../history/historyModel";
import { historyApi } from "../history/historyClient";
import { TrackingGate } from "../history/TrackingGate";
import { errorText } from "../history/useTracking";
import { ViewLoading, ViewNote } from "../shell/ViewParts";

const copy = DESK_COPY.dashboard;

function shortTime(at: string, range: DataSnapshotRange): string {
  const date = new Date(at);
  return range === "24h" || range === "7d"
    ? date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function ValueChart({ series }: { readonly series: DataSnapshotSeries }) {
  const chart = valueChart(series.points);
  if (!chart) return <p className="text-sm text-muted">{series.reason ?? copy.chartEmpty}</p>;
  const tone = series.change === null ? "flat" : series.change.usd > 0 ? "up" : series.change.usd < 0 ? "down" : "flat";
  const label = copy.chartLabel(shortTime(chart.first.at, series.range), shortTime(chart.last.at, series.range));
  return (
    <figure className="kdb-chart kdb-value">
      <figcaption className="kdb-value-head">
        <span className="kdb-kpi-value font-code">{usd(chart.last.usd)}</span>
        <span className="font-code text-sm" data-tone={tone}>
          {copy.change}: {series.change ? `${signedUsd(series.change.usd)}${series.change.pct === null ? "" : ` (${(series.change.pct * 100).toFixed(2)}%)`}` : copy.unknown}
        </span>
      </figcaption>
      <svg className="kdb-value-svg" viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label={`${label}: ${usd(chart.first.usd)} to ${usd(chart.last.usd)}`}>
        <path className="kdb-value-area" d={chart.area} />
        <path className="kdb-value-line" d={chart.path} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="kdb-value-axis text-xs text-muted">
        <span>{shortTime(chart.first.at, series.range)}</span>
        <span>
          {usd(chart.min)} – {usd(chart.max)}
        </span>
        <span>{shortTime(chart.last.at, series.range)}</span>
      </div>
      {chart.incomplete > 0 ? <p className="mt-2 text-xs text-muted">{copy.chartIncomplete(chart.incomplete)}</p> : null}
    </figure>
  );
}

function PnlTable({ pnl }: { readonly pnl: DataPnl }) {
  const rows = pnlRows(pnl);
  return (
    <div className="flex flex-col gap-2">
      <dl className="kdb-kpis">
        <div className="kdb-kpi" data-tone={pnl.totals.realizedUsd > 0 ? "up" : pnl.totals.realizedUsd < 0 ? "down" : undefined}>
          <dt className="text-xs font-black uppercase tracking-[0.14em] text-muted">{copy.realizedTotal}</dt>
          <dd className="kdb-kpi-value font-code">{signedUsd(pnl.totals.realizedUsd)}</dd>
        </div>
        <div className="kdb-kpi" data-tone={pnl.totals.unrealizedUsd > 0 ? "up" : pnl.totals.unrealizedUsd < 0 ? "down" : undefined}>
          <dt className="text-xs font-black uppercase tracking-[0.14em] text-muted">{copy.unrealizedTotal}</dt>
          <dd className="kdb-kpi-value font-code">{signedUsd(pnl.totals.unrealizedUsd)}</dd>
        </div>
      </dl>
      {pnl.totals.complete ? null : <p className="text-xs text-muted">{copy.pnlIncomplete}</p>}
      {rows.length === 0 ? (
        <p className="text-sm text-muted">{copy.pnlEmpty}</p>
      ) : (
        <div className="kdb-table-wrap">
          <table className="kdb-table">
            <thead>
              <tr>
                <th scope="col">{copy.pnlColumns.asset}</th>
                <th scope="col" className="kdb-num">{copy.pnlColumns.open}</th>
                <th scope="col" className="kdb-num">{copy.pnlColumns.cost}</th>
                <th scope="col" className="kdb-num">{copy.pnlColumns.realized}</th>
                <th scope="col" className="kdb-num">{copy.pnlColumns.unrealized}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} data-tone={row.tone}>
                  <th scope="row">
                    {row.symbol}
                    {row.note ? <span className="block text-xs font-normal text-muted">{row.note}</span> : null}
                  </th>
                  <td className="kdb-num font-code">{row.open}</td>
                  <td className="kdb-num font-code">{row.cost}</td>
                  <td className="kdb-num font-code">{row.realized}</td>
                  <td className="kdb-num font-code">{row.unrealized}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TrackedValue({ token }: { readonly token: string }) {
  const [range, setRange] = useState<DataSnapshotRange>("7d");
  const [series, setSeries] = useState<DataSnapshotSeries | null>(null);
  const [pnl, setPnl] = useState<DataPnl | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    historyApi.snapshots(token, range, controller.signal).then(setSeries, (failure: unknown) => {
      if (!controller.signal.aborted) setError(errorText(failure));
    });
    return () => controller.abort();
  }, [token, range]);

  useEffect(() => {
    const controller = new AbortController();
    historyApi.pnl(token, "all", controller.signal).then(setPnl, (failure: unknown) => {
      if (!controller.signal.aborted) setError(errorText(failure));
    });
    return () => controller.abort();
  }, [token]);

  return (
    <>
      <div className="flex flex-col gap-2">
        <div role="group" aria-label={copy.rangeLabel} className="kdb-ranges">
          {DATA_SNAPSHOT_RANGES.map((option) => (
            <button key={option} type="button" className="kdb-range" aria-pressed={option === range} onClick={() => setRange(option)}>
              {copy.ranges[option]}
            </button>
          ))}
        </div>
        {series && series.range === range ? <ValueChart series={series} /> : <ViewLoading>{copy.loading}</ViewLoading>}
      </div>
      {error ? <ViewNote role="alert" tone="danger">{error}</ViewNote> : null}
      <section aria-labelledby="kdb-pnl" className="flex flex-col gap-2">
        <h3 id="kdb-pnl" className="kdb-subtitle">{copy.pnl}</h3>
        <p className="text-xs text-muted">{copy.pnlNote}</p>
        {pnl ? <PnlTable pnl={pnl} /> : <ViewLoading>{copy.loading}</ViewLoading>}
      </section>
    </>
  );
}

export function ValueSection({ lane }: { readonly lane: DataLane }) {
  return (
    <section aria-labelledby="kdb-value" className="flex flex-col gap-3">
      <h3 id="kdb-value" className="kdb-subtitle">{copy.value}</h3>
      <TrackingGate lane={lane} compact>{({ token }) => <TrackedValue token={token} />}</TrackingGate>
    </section>
  );
}
