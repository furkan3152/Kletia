/**
 * The Dashboard's value over time and PnL estimates for the signed-in
 * wallet's tracked set (`/v1/data/snapshots`, `/v1/data/pnl`): a range
 * switch (24h, 7d, 30d, all), one line chart with its first and last value
 * and the change as text, and FIFO PnL per asset. Behind the tracking
 * opt-in; fewer than two readings say so instead of drawing a flat line.
 */
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { DATA_SNAPSHOT_RANGES, type DataLane, type DataPnl, type DataSnapshotRange, type DataSnapshotSeries } from "@kletia/core";

import { DESK_COPY } from "../content/copy";
import { pnlRows, signedUsd, usd, valueChart } from "../history/historyModel";
import { historyApi } from "../history/historyClient";
import { TrackingGate } from "../history/TrackingGate";
import { errorText } from "../history/useTracking";
import { Segmented } from "../../kit";
import { ViewLoading, ViewNote } from "../shell/ViewParts";

const copy = DESK_COPY.dashboard;

function shortTime(at: string, range: DataSnapshotRange): string {
  const date = new Date(at);
  return range === "24h" || range === "7d"
    ? date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/**
 * The value line with a dot-matrix fill and a crosshair: pointer or arrow keys move it across the
 * readings and its tag reads the value and time there. First and last value, the range and the
 * change stay as text, so the figure is decorative for screen readers beyond its label.
 */
function ValueChart({ series }: { readonly series: DataSnapshotSeries }) {
  const chart = valueChart(series.points);
  const [at, setAt] = useState<number | null>(null);
  const plot = useRef<HTMLDivElement>(null);
  if (!chart) return <p className="kv-muted">{series.reason ?? copy.chartEmpty}</p>;
  const points = series.points;
  const tone = series.change === null ? "flat" : series.change.usd > 0 ? "up" : series.change.usd < 0 ? "down" : "flat";
  const label = copy.chartLabel(shortTime(chart.first.at, series.range), shortTime(chart.last.at, series.range));
  const start = Date.parse(points[0]!.at);
  const span = Date.parse(points[points.length - 1]!.at) - start || 1;
  const xOf = (index: number) => ((Date.parse(points[index]!.at) - start) / span) * 100;
  const yOf = (index: number) => ((38 - ((points[index]!.usd - chart.min) / (chart.max - chart.min || 1)) * 36) / 40) * 100;
  const nearest = (event: PointerEvent<HTMLDivElement>) => {
    const box = plot.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    const x = ((event.clientX - box.left) / box.width) * 100;
    let best = 0;
    for (let index = 1; index < points.length; index += 1) if (Math.abs(xOf(index) - x) < Math.abs(xOf(best) - x)) best = index;
    setAt(best);
  };
  return (
    <figure className="kdb-value">
      <figcaption className="kdb-value-head">
        <span className="kdb-value-now kv-num">{usd(chart.last.usd)}</span>
        <span className="kv-num" data-tone={tone}>
          {copy.change}: {series.change ? `${signedUsd(series.change.usd)}${series.change.pct === null ? "" : ` (${(series.change.pct * 100).toFixed(2)}%)`}` : copy.unknown}
        </span>
      </figcaption>
      <div
        ref={plot}
        className="kdb-value-plot"
        tabIndex={0}
        role="img"
        aria-label={`${label}: ${usd(chart.first.usd)} to ${usd(chart.last.usd)}`}
        onPointerMove={nearest}
        onPointerLeave={() => setAt(null)}
        onBlur={() => setAt(null)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          setAt((current) => Math.min(points.length - 1, Math.max(0, (current ?? points.length - 1) + (event.key === "ArrowRight" ? 1 : -1))));
        }}
      >
        <svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <defs>
            <pattern id="kdb-dots" width="1.2" height="1.6" patternUnits="userSpaceOnUse">
              <circle cx="0.6" cy="0.8" r="0.2" className="kdb-value-dot" />
            </pattern>
          </defs>
          <path d={chart.area} fill="url(#kdb-dots)" />
          <path className="kdb-value-line" d={chart.path} vectorEffect="non-scaling-stroke" />
        </svg>
        <span className="kdb-value-head-dot" style={{ left: `${xOf(points.length - 1)}%`, top: `${yOf(points.length - 1)}%` }} aria-hidden="true" />
        {at !== null ? (
          <span className="kdb-xh" style={{ left: `${xOf(at)}%` }} aria-hidden="true">
            <i style={{ top: `${yOf(at)}%` }} />
            <span className="kdb-xh-tag" data-flip={xOf(at) > 70 ? "" : undefined}>
              {usd(points[at]!.usd)} · {shortTime(points[at]!.at, series.range)}
            </span>
          </span>
        ) : null}
      </div>
      <div className="kdb-value-axis">
        <span>{shortTime(chart.first.at, series.range)}</span>
        <span>
          {usd(chart.min)} – {usd(chart.max)}
        </span>
        <span>{shortTime(chart.last.at, series.range)}</span>
      </div>
      {chart.incomplete > 0 ? <p className="kdb-foot">{copy.chartIncomplete(chart.incomplete)}</p> : null}
    </figure>
  );
}

function PnlTable({ pnl }: { readonly pnl: DataPnl }) {
  const rows = pnlRows(pnl);
  return (
    <div className="flex flex-col gap-2">
      <dl className="kdb-readouts">
        <div data-tone={pnl.totals.realizedUsd > 0 ? "up" : pnl.totals.realizedUsd < 0 ? "down" : undefined}>
          <dt>{copy.realizedTotal}</dt>
          <dd className="kv-num">{signedUsd(pnl.totals.realizedUsd)}</dd>
        </div>
        <div data-tone={pnl.totals.unrealizedUsd > 0 ? "up" : pnl.totals.unrealizedUsd < 0 ? "down" : undefined}>
          <dt>{copy.unrealizedTotal}</dt>
          <dd className="kv-num">{signedUsd(pnl.totals.unrealizedUsd)}</dd>
        </div>
      </dl>
      {pnl.totals.complete ? null : <p className="kdb-foot">{copy.pnlIncomplete}</p>}
      {rows.length === 0 ? (
        <p className="kv-muted">{copy.pnlEmpty}</p>
      ) : (
        <div className="kv-table-wrap">
          <table className="kv-table">
            <thead>
              <tr>
                <th scope="col">{copy.pnlColumns.asset}</th>
                <th scope="col" className="kv-r">{copy.pnlColumns.open}</th>
                <th scope="col" className="kv-r">{copy.pnlColumns.cost}</th>
                <th scope="col" className="kv-r">{copy.pnlColumns.realized}</th>
                <th scope="col" className="kv-r">{copy.pnlColumns.unrealized}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} data-tone={row.tone}>
                  <th scope="row">
                    {row.symbol}
                    {row.note ? <span className="kdb-reason">{row.note}</span> : null}
                  </th>
                  <td className="kv-r kv-num">{row.open}</td>
                  <td className="kv-r kv-num">{row.cost}</td>
                  <td className="kv-r kv-num">{row.realized}</td>
                  <td className="kv-r kv-num">{row.unrealized}</td>
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
      <div className="kdb-value-wrap">
        <div className="kdb-ranges">
          <Segmented ariaLabel={copy.rangeLabel} value={range} onChange={setRange} options={DATA_SNAPSHOT_RANGES.map((option) => ({ id: option, label: copy.ranges[option] }))} />
        </div>
        {series && series.range === range ? <ValueChart series={series} /> : <ViewLoading>{copy.loading}</ViewLoading>}
      </div>
      {error ? <ViewNote role="alert" tone="danger">{error}</ViewNote> : null}
      <section aria-labelledby="kdb-pnl" className="kv-sec">
        <div className="kv-sec-h">
          <h3 id="kdb-pnl" className="kdb-h3">{copy.pnl}</h3>
        </div>
        <p className="kdb-foot">{copy.pnlNote}</p>
        {pnl ? <PnlTable pnl={pnl} /> : <ViewLoading>{copy.loading}</ViewLoading>}
      </section>
    </>
  );
}

export function ValueSection({ lane }: { readonly lane: DataLane }) {
  return (
    <section aria-labelledby="kdb-value" className="kv-sec">
      <div className="kv-sec-h">
        <h3 id="kdb-value" className="kdb-h3">{copy.value}</h3>
      </div>
      <TrackingGate lane={lane} compact>{({ token }) => <TrackedValue token={token} />}</TrackingGate>
    </section>
  );
}
