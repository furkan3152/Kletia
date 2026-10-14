import type { UsageReport, UsageWindow } from "@kletia/sdk";
import { BarChart3, RefreshCw } from "lucide-react";
import { useId, useState } from "react";

import { sdkSignal } from "../../../../shared/platform/kletiaClient";
import { useApiResource } from "../../../../shared/platform/useApiResource";
import { Link } from "../../../routes/Link";
import { ApiErrorPanel } from "../../../site/ui/ApiErrorPanel";
import { Button } from "../../../site/ui/Button";
import { Skeleton, SkeletonGroup } from "../../../site/ui/Skeleton";
import { cx, FOCUS_RING, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { formatTimestamp, keyedClient } from "./keyClient";
import { usageRouteRows } from "./keyRows";
import { maskKey, useSessionKey } from "./sessionKey";

const WINDOWS: readonly UsageWindow[] = ["24h", "7d"];

function hourLabel(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Hourly requests of the key: one series, so no legend; per-bar hover and a table for screen readers. */
function RequestBars({ series }: { series: UsageReport["series"] }) {
  const tableId = useId();
  const max = Math.max(1, ...series.map((point) => point.requests));
  return (
    <figure className="flex min-w-0 flex-col gap-2">
      <figcaption className={cx(LABEL, TEXT_MUTED)}>Requests per hour (peak {max})</figcaption>
      <div className="flex h-24 min-w-0 items-end gap-[2px] border-b-2 border-[#1A1A1A]/40 dark:border-white/30" aria-describedby={tableId}>
        {series.map((point) => (
          <div key={point.hour} className="group relative flex h-full min-w-[3px] flex-1 items-end" title={`${hourLabel(point.hour)}: ${point.requests} requests`}>
            <div
              className="w-full bg-[#0052FF] group-hover:bg-[#1A1A1A] dark:bg-[#7EA6FF] dark:group-hover:bg-white"
              style={{ height: point.requests === 0 ? "1px" : `${Math.max(4, (point.requests / max) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <p className={cx("flex justify-between font-code text-xs", TEXT_MUTED)} aria-hidden="true">
        <span>{series[0] ? hourLabel(series[0].hour) : ""}</span>
        <span>{series.length > 0 ? hourLabel(series[series.length - 1]!.hour) : ""}</span>
      </p>
      <table id={tableId} className="sr-only">
        <caption>Requests per hour</caption>
        <thead>
          <tr>
            <th scope="col">Hour</th>
            <th scope="col">Requests</th>
          </tr>
        </thead>
        <tbody>
          {series
            .filter((point) => point.requests > 0)
            .map((point) => (
              <tr key={point.hour}>
                <td>{hourLabel(point.hour)}</td>
                <td>{point.requests}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </figure>
  );
}

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 border-l-[6px] border-[#0052FF] pl-3 dark:border-[#7EA6FF]">
      <dt className={cx(LABEL, "order-2", TEXT_MUTED)}>{label}</dt>
      <dd className="order-1 font-display text-3xl font-bold leading-none tracking-[-0.03em]">{value}</dd>
      {note ? <dd className={cx("order-3 text-xs", TEXT_MUTED)}>{note}</dd> : null}
    </div>
  );
}

/** Usage by route: requests and the 2xx/4xx/5xx split; a high 4xx share is marked and links to the errors reference. */
function RouteTable({ routes }: { routes: UsageReport["byRoute"] }) {
  const rows = usageRouteRows(routes);
  if (rows.length === 0) return <p className={cx("text-sm", TEXT_MUTED)}>No requests in this window yet.</p>;
  const cell = "px-3 py-2 text-right font-code";
  return (
    <div className="min-w-0 overflow-x-auto">
      <table className="w-full min-w-[300px] border-collapse text-left text-body-s">
        <caption className={cx(LABEL, "pb-2 text-left", TEXT_MUTED)}>By route</caption>
        <thead className="bg-surface-2">
          <tr className="border-b-2 border-[#1A1A1A]/10 dark:border-white/10">
            <th scope="col" className={cx(LABEL, "px-3 py-2 font-extrabold", TEXT_MUTED)}>
              Route
            </th>
            {["Requests", "2xx", "4xx", "5xx"].map((label) => (
              <th key={label} scope="col" className={cx(LABEL, "px-3 py-2 text-right font-extrabold", TEXT_MUTED)}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y-2 divide-[#1A1A1A]/10 dark:divide-white/10">
          {rows.map((row) => (
            <tr key={row.route} className={row.highlight ? "bg-warning-bg" : undefined}>
              <th scope="row" className="px-3 py-2 font-code font-normal">
                {row.route}
                {row.highlight ? (
                  <Link to="/developers/errors" className={cx("ml-2 whitespace-nowrap font-sans text-xs font-bold text-warning underline decoration-2 underline-offset-2", FOCUS_RING)}>
                    {Math.round(row.clientShare * 100)}% refused: read the errors
                  </Link>
                ) : null}
              </th>
              <td className={cx(cell, "font-bold")}>{row.requests}</td>
              <td className={cell}>{row.ok}</td>
              <td className={cx(cell, row.highlight && "font-bold text-warning")}>{row.clientErrors}</td>
              <td className={cell}>{row.serverErrors}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** GET /v1/usage for the key in memory. */
export function UsagePanel() {
  const { key } = useSessionKey();
  const [range, setRange] = useState<UsageWindow>("24h");
  const usage = useApiResource<UsageReport>(`usage:${maskKey(key)}:${range}`, (_client, signal) =>
    keyedClient(key).usage({ window: range, signal: sdkSignal(signal) }),
  );
  const report = usage.data;
  const classes = report ? Object.entries(report.totals.byStatusClass).sort(([a], [b]) => a.localeCompare(b)) : [];

  return (
    <section aria-labelledby="usage-heading" className={cx("flex min-w-0 flex-col gap-4 p-4 sm:p-5", INK_BORDER, HARD_SHADOW, SURFACE)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4" aria-hidden="true" />
          <h3 id="usage-heading" className="font-display text-xl font-bold">
            Usage of <span className="font-code">{maskKey(key)}</span>
          </h3>
        </div>
        <div className="flex items-center gap-2">
          <div role="group" aria-label="Window" className="flex">
            {WINDOWS.map((item) => (
              <button
                key={item}
                type="button"
                aria-pressed={range === item}
                onClick={() => setRange(item)}
                className={cx(
                  "min-h-9 border-[3px] border-[#1A1A1A] px-3 font-code text-xs font-bold first:border-r-0 dark:border-[#4B5563]",
                  range === item ? "bg-[#1A1A1A] text-white dark:bg-[#FFD60A] dark:text-[#1A1A1A]" : "bg-white dark:bg-[#0B1120]",
                  FOCUS_RING,
                )}
              >
                {item}
              </button>
            ))}
          </div>
          <Button size="sm" variant="ghost" onClick={usage.reload} aria-label="Reload usage">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>
      {usage.status === "error" && usage.error ? (
        <ApiErrorPanel error={usage.error} title="Could not read usage" onRetry={usage.reload} />
      ) : !report || usage.status === "loading" ? (
        <SkeletonGroup label="Loading usage" className="grid gap-3 sm:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} surface="card" className="h-14" />
          ))}
        </SkeletonGroup>
      ) : (
        <div className="flex min-w-0 flex-col gap-5">
          <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Figure label={`Requests, ${report.window}`} value={String(report.totals.requests)} note={classes.map(([name, count]) => `${name} ${count}`).join(" · ") || "none yet"} />
            <Figure
              label="Left this minute"
              value={`${report.rateLimit.remaining}/${report.rateLimit.limit}`}
              note={report.rateLimit.resetAt ? `resets ${formatTimestamp(report.rateLimit.resetAt)}` : undefined}
            />
            <Figure label="Intents created" value={String(report.intents.created)} note={Object.entries(report.intents.byStatus).map(([status, count]) => `${status} ${count}`).join(" · ") || undefined} />
            <Figure label="Tier" value={report.tier} note={`since ${formatTimestamp(report.since)}`} />
          </dl>
          <RequestBars series={report.series} />
          <RouteTable routes={report.byRoute} />
          <p className={cx("text-xs", TEXT_MUTED)}>
            Counted per hour, route and status class; written every 30 s. The rate-limit window is the answering instance&apos;s.
          </p>
        </div>
      )}
    </section>
  );
}
