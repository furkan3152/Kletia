/**
 * Parts of a link's page (portal design 4.4.6): the counters board (split
 * flaps for the totals, then every counter by window, day and source) and
 * the controls (pause, resume, withdraw). List rows use plain numbers.
 */
import type { LinkOwnerView, LinkStats } from "@kletia/core";
import { Pause, Play, Trash2 } from "lucide-react";
import { useState } from "react";

import { sdkSignal } from "../../../../shared/platform/kletiaClient";
import { useApiAction, useApiResource } from "../../../../shared/platform/useApiResource";
import { ApiErrorPanel } from "../../../site/ui/ApiErrorPanel";
import { Button } from "../../../site/ui/Button";
import { SelectField } from "../../../site/ui/Field";
import { Skeleton, SkeletonGroup } from "../../../site/ui/Skeleton";
import { cx, FOCUS_RING, LABEL, TEXT_MUTED } from "../../../site/ui/styles";
import { keyedClient } from "../keys/keyClient";
import { formatUsd } from "../portal/portalFormat";
import { acceptOnResume } from "./linkTemplates";

/** A split-flap counter: the number on dark tiles, the label under it. */
function Counter({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <span className="inline-flex gap-[2px]" aria-hidden="true">
        {value.split("").map((char, index) => (
          <span key={index} className="inline-flex h-7 min-w-[1.15rem] items-center justify-center border border-[#050608] bg-[#1B1E25] px-[3px] font-code text-[14px] font-bold text-[#F4F1EA] shadow-[inset_0_-1px_0_#050608]">
            {char}
          </span>
        ))}
      </span>
      <span className="text-label font-bold uppercase">
        <span className="sr-only">{value} </span>
        {label}
      </span>
    </div>
  );
}

function compact(value: number | undefined): string {
  const number = value ?? 0;
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
  if (number >= 10_000) return `${Math.round(number / 1_000)}K`;
  return String(number);
}

function StatsView({ link, apiKey }: { readonly link: LinkOwnerView; readonly apiKey: string }) {
  const [window, setWindow] = useState<"7d" | "30d" | "90d">("7d");
  const stats = useApiResource<LinkStats>(`link-stats:${link.id}:${window}`, (_client, signal) => keyedClient(apiKey).links.stats(link.id, { window }, { signal: sdkSignal(signal) }));
  const data = stats.data;
  const peak = Math.max(1, ...(data?.daily ?? []).map((day) => day.pageView ?? 0));
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <SelectField
          label="Window"
          value={window}
          onChange={(event) => setWindow(event.target.value as "7d" | "30d" | "90d")}
          options={[
            { value: "7d", label: "7 days" },
            { value: "30d", label: "30 days" },
            { value: "90d", label: "90 days" },
          ]}
          containerClassName="w-40"
        />
        <p className={cx("max-w-md text-xs", TEXT_MUTED)}>Additive day counts by source; no address, IP or user agent is kept.</p>
      </div>
      {stats.status === "error" && stats.error ? <ApiErrorPanel error={stats.error} title="Could not read the counters" onRetry={stats.reload} /> : null}
      {data ? (
        <>
          <dl className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
            {[
              ["Page views", data.totals.pageView],
              ["Unfurls", data.totals.unfurl],
              ["Quotes", data.totals.quote],
              ["Intents", data.totals.intent],
              ["Prepared", data.totals.prepared],
              ["Submitted", data.totals.submitted],
              ["Completed", data.totals.completed],
              ["Failed", data.totals.failed],
            ].map(([label, value]) => (
              <div key={String(label)} className="min-w-0">
                <dt className={cx(LABEL, TEXT_MUTED)}>{label}</dt>
                <dd className="font-code font-bold">{(Number(value) || 0).toLocaleString("en-US")}</dd>
              </div>
            ))}
            <div className="min-w-0">
              <dt className={cx(LABEL, TEXT_MUTED)}>Volume</dt>
              <dd className="font-code font-bold">{formatUsd(data.totals.volumeUsd ?? "0")}</dd>
            </div>
            <div className="min-w-0">
              <dt className={cx(LABEL, TEXT_MUTED)}>Intent per view</dt>
              <dd className="font-code font-bold">{data.conversion.intentPerPageView === null ? "—" : `${Math.round(data.conversion.intentPerPageView * 100)}%`}</dd>
            </div>
            <div className="min-w-0">
              <dt className={cx(LABEL, TEXT_MUTED)}>Completed per intent</dt>
              <dd className="font-code font-bold">{data.conversion.completedPerIntent === null ? "—" : `${Math.round(data.conversion.completedPerIntent * 100)}%`}</dd>
            </div>
          </dl>
          {data.daily.length > 0 ? (
            <figure className="m-0 min-w-0">
              <figcaption className={cx(LABEL, "mb-2")}>Page views per day</figcaption>
              <div className="flex h-24 min-w-0 items-end gap-[2px] border-b-2 border-[#1A1A1A] dark:border-[#E2E8F0]" aria-hidden="true">
                {data.daily.map((day) => (
                  <span key={day.day} title={`${day.day}: ${day.pageView ?? 0} views, ${day.completed ?? 0} completed`} className="min-w-[3px] flex-1 bg-[#0052FF] dark:bg-[#7EA6FF]" style={{ height: `${Math.max(2, Math.round(((day.pageView ?? 0) / peak) * 100))}%` }} />
                ))}
              </div>
              <table className="sr-only">
                <caption>Page views and completions per day</caption>
                <thead>
                  <tr>
                    <th scope="col">Day</th>
                    <th scope="col">Page views</th>
                    <th scope="col">Completed</th>
                  </tr>
                </thead>
                <tbody>
                  {data.daily.map((day) => (
                    <tr key={day.day}>
                      <th scope="row">{day.day}</th>
                      <td>{day.pageView ?? 0}</td>
                      <td>{day.completed ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </figure>
          ) : null}
          {data.bySource.length > 0 ? (
            <div className={cx("min-w-0 overflow-x-auto", FOCUS_RING)} tabIndex={0} role="region" aria-label="By where visitors started (scrolls sideways)">
              <table className="w-full min-w-[28rem] text-left text-sm">
                <caption className={cx(LABEL, "mb-2 text-left")}>By where visitors started</caption>
                <thead>
                  <tr className="border-b-2 border-[#1A1A1A] dark:border-[#4B5563]">
                    <th scope="col" className="py-1.5 pr-3">Source</th>
                    <th scope="col" className="py-1.5 pr-3">Quotes</th>
                    <th scope="col" className="py-1.5 pr-3">Intents</th>
                    <th scope="col" className="py-1.5 pr-3">Completed</th>
                    <th scope="col" className="py-1.5">Volume</th>
                  </tr>
                </thead>
                <tbody>
                  {data.bySource.map((row) => (
                    <tr key={row.source} className="border-b border-dashed border-[#1A1A1A]/20 dark:border-white/10">
                      <th scope="row" className="py-1.5 pr-3 font-code text-[12px]">{row.source}</th>
                      <td className="py-1.5 pr-3 font-code">{row.quote ?? 0}</td>
                      <td className="py-1.5 pr-3 font-code">{row.intent ?? 0}</td>
                      <td className="py-1.5 pr-3 font-code">{row.completed ?? 0}</td>
                      <td className="py-1.5 font-code">{formatUsd(row.volumeUsd ?? "0")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : stats.status === "loading" ? (
        <SkeletonGroup label="Loading counters">
          <Skeleton surface="card" className="h-24" />
        </SkeletonGroup>
      ) : null}
    </div>
  );
}

export interface LinkControlsProps {
  readonly link: LinkOwnerView;
  readonly apiKey: string;
  /** The link changed (paused, resumed) or was withdrawn. */
  readonly onChanged: (message: string, withdrawn?: boolean) => void;
}

/** Pause, resume (re-pinning when a pinned value changed) and withdraw, with a confirmation. */
export function LinkControls({ link, apiKey, onChanged }: LinkControlsProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const pause = useApiAction((_client, signal, id: string) => keyedClient(apiKey).links.pause(id, { signal: sdkSignal(signal) }));
  const resume = useApiAction((_client, signal, id: string, accept: ("recipient_changed" | "contract_changed")[]) => keyedClient(apiKey).links.resume(id, { accept }, { signal: sdkSignal(signal) }));
  const remove = useApiAction((_client, signal, id: string) => keyedClient(apiKey).links.delete(id, { signal: sdkSignal(signal) }).then(() => id));
  const accept = acceptOnResume(link.pausedReason);
  const failure = pause.status === "error" ? pause.error : resume.status === "error" ? resume.error : remove.status === "error" ? remove.error : null;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {link.status === "active" || link.status === "pending" ? (
          <Button variant="secondary" loading={pause.status === "loading"} onClick={() => void pause.run(link.id).then((view) => view && onChanged(`${link.title} is paused.`))}>
            <Pause className="h-4 w-4" aria-hidden="true" />
            Pause
          </Button>
        ) : null}
        {link.status === "paused" ? (
          <Button
            variant="secondary"
            loading={resume.status === "loading"}
            onClick={() => void resume.run(link.id, accept).then((view) => view && onChanged(`${link.title} is ${view.status === "pending" ? "pending again (re-pinned)" : "active again"}.`))}
          >
            <Play className="h-4 w-4" aria-hidden="true" />
            {accept.length > 0 ? "Re-pin and resume" : "Resume"}
          </Button>
        ) : null}
        {link.status !== "deleted" && !confirmDelete ? (
          <Button variant="ghost" onClick={() => setConfirmDelete(true)}>
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            Withdraw
          </Button>
        ) : null}
      </div>
      {accept.length > 0 && link.status === "paused" ? (
        <p className={cx("text-[13px]", TEXT_MUTED)}>Resuming accepts the change ({accept.join(", ")}): Kletia pins the new value as a new revision, with the activation delay again on mainnet.</p>
      ) : null}
      {confirmDelete ? (
        <div className="flex flex-col gap-2 border-[3px] border-danger bg-danger-bg p-3 text-sm text-fg">
          <p className="font-bold">Withdraw {link.title}? Its page answers 410 at once; visitors who already started can finish.</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ink" loading={remove.status === "loading"} onClick={() => void remove.run(link.id).then((id) => id && onChanged(`${link.title} was withdrawn.`, true))}>
              Withdraw the link
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setConfirmDelete(false)}>
              Keep it
            </Button>
          </div>
        </div>
      ) : null}
      <div aria-live="polite">{failure ? <ApiErrorPanel error={failure} title="The change was refused" /> : null}</div>
    </div>
  );
}

/** The counters board of a link page: split-flap totals (the board earns its place here), then the full counters. */
export function LinkCountersBoard({ link, apiKey }: { readonly link: LinkOwnerView; readonly apiKey: string }) {
  const stats = link.stats;
  return (
    <div className="flex min-w-0 flex-col gap-5">
      {stats ? (
        <div className="flex min-w-0 flex-wrap gap-x-5 gap-y-3">
          <Counter label="Views (7 d)" value={compact(stats.pageView)} />
          <Counter label="Intents" value={compact(stats.intent)} />
          <Counter label="Completed" value={compact(stats.completed)} />
          <Counter label="Volume" value={formatUsd(stats.volumeUsd ?? "0").replace(/\.00$/u, "")} />
        </div>
      ) : null}
      <StatsView link={link} apiKey={apiKey} />
    </div>
  );
}
