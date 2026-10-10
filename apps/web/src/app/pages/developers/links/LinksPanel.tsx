import type { ContractView, LinkOwnerView, LinkStats } from "@kletia/core";
import type { PolicyReadResponse } from "@kletia/sdk";
import { ChevronDown, Pause, Play, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";

import { sdkSignal } from "../../../../shared/platform/kletiaClient";
import { useApiAction, useApiResource } from "../../../../shared/platform/useApiResource";
import { lineFor } from "../../../site/art";
import { Icon } from "../../../site/art/Icon";
import { LineBullet } from "../../../site/art/LineBullet";
import { ApiErrorPanel } from "../../../site/ui/ApiErrorPanel";
import { Badge } from "../../../site/ui/Badge";
import { Button } from "../../../site/ui/Button";
import { SelectField } from "../../../site/ui/Field";
import { Skeleton, SkeletonGroup } from "../../../site/ui/Skeleton";
import { cx, FOCUS_RING, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { keyedClient } from "../keys/keyClient";
import { maskKey, portalKeyKind, useSessionKey } from "../keys/sessionKey";
import { NeedKey } from "../portal/NeedKey";
import { formatUsd, formatWhen, timeUntil } from "../portal/portalFormat";
import { PortalTabs } from "../portal/PortalTabs";
import { useNow } from "../portal/useNow";
import { LinkBuilder } from "./LinkBuilder";
import { LinkShare } from "./LinkCreated";
import { acceptOnResume, linkStatus, reasonText } from "./linkTemplates";

const STRIPE: Readonly<Record<string, string>> = { green: "#0B7A4B", yellow: "#FFD60A", red: "#C8102E", neutral: "#94A3B8" };

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
      <span className="text-[11px] font-bold uppercase tracking-[0.1em]">
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
                <dt className={cx(LABEL, "!text-[10px]", TEXT_MUTED)}>{label}</dt>
                <dd className="font-code font-bold">{(Number(value) || 0).toLocaleString("en-US")}</dd>
              </div>
            ))}
            <div className="min-w-0">
              <dt className={cx(LABEL, "!text-[10px]", TEXT_MUTED)}>Volume</dt>
              <dd className="font-code font-bold">{formatUsd(data.totals.volumeUsd ?? "0")}</dd>
            </div>
            <div className="min-w-0">
              <dt className={cx(LABEL, "!text-[10px]", TEXT_MUTED)}>Intent per view</dt>
              <dd className="font-code font-bold">{data.conversion.intentPerPageView === null ? "—" : `${Math.round(data.conversion.intentPerPageView * 100)}%`}</dd>
            </div>
            <div className="min-w-0">
              <dt className={cx(LABEL, "!text-[10px]", TEXT_MUTED)}>Completed per intent</dt>
              <dd className="font-code font-bold">{data.conversion.completedPerIntent === null ? "—" : `${Math.round(data.conversion.completedPerIntent * 100)}%`}</dd>
            </div>
          </dl>
          {data.daily.length > 0 ? (
            <figure className="m-0 min-w-0">
              <figcaption className={cx(LABEL, "mb-2 !text-[10px]")}>Page views per day</figcaption>
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
                <caption className={cx(LABEL, "mb-2 text-left !text-[10px]")}>By where visitors started</caption>
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

function LinkRow({ link, apiKey, now, open, onToggle, onChanged }: { readonly link: LinkOwnerView; readonly apiKey: string; readonly now: number; readonly open: boolean; readonly onToggle: () => void; readonly onChanged: (message: string) => void }) {
  const status = linkStatus(link.status);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const pause = useApiAction((_client, signal, id: string) => keyedClient(apiKey).links.pause(id, { signal: sdkSignal(signal) }));
  const resume = useApiAction((_client, signal, id: string, accept: ("recipient_changed" | "contract_changed")[]) => keyedClient(apiKey).links.resume(id, { accept }, { signal: sdkSignal(signal) }));
  const remove = useApiAction((_client, signal, id: string) => keyedClient(apiKey).links.delete(id, { signal: sdkSignal(signal) }).then(() => id));
  const accept = acceptOnResume(link.pausedReason);
  const reason = reasonText(link.pausedReason ?? link.suspendedReason);
  const pendingLeft = link.status === "pending" ? timeUntil(link.activatesAt, now) : null;
  const panelId = `link-${link.id}`;
  const failure = pause.status === "error" ? pause.error : resume.status === "error" ? resume.error : remove.status === "error" ? remove.error : null;
  const stats = link.stats ?? {};

  return (
    <li className="flex min-w-0 flex-col">
      {/* The ticket is printed stock in both themes; the controls below it follow the theme. */}
      <div className={cx("relative flex min-w-0 flex-col gap-3 py-4 pl-6 pr-4 sm:pr-5", INK_BORDER, HARD_SHADOW, "bg-kl-stock text-[#1A1A1A] dark:bg-kl-stock-night")}>
      <span aria-hidden="true" className="absolute inset-y-0 left-0 w-2.5 border-r-[3px] border-dashed border-[#1A1A1A]" style={{ backgroundColor: STRIPE[status.tone] }} />
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="break-words font-display text-lg font-bold leading-tight">{link.title}</p>
          <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="font-semibold">{link.publisher.name}</span>
            {link.publisher.domain ? <span className="font-code text-[12px]">{link.publisher.domain}</span> : null}
            <Badge tone={link.publisher.domainVerified ? "green" : "red"}>{link.publisher.domainVerified ? "Verified domain" : "Unverified"}</Badge>
          </p>
          <p className="mt-1 font-code text-[11px] font-bold">
            {link.id} · revision {link.revision}
          </p>
        </div>
        <span className={cx("inline-flex -rotate-3 items-center border-[3px] px-2 py-0.5 font-code text-[11px] font-black uppercase tracking-[0.12em]", status.tone === "green" ? "border-[#0A6B42] text-[#0A6B42]" : status.tone === "red" ? "border-[#C8102E] text-[#C8102E]" : status.tone === "yellow" ? "border-dashed border-[#A84B00] text-[#7A3500]" : "border-[#45464B] text-[#45464B]")}>
          {status.label}
        </span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
        <span className="font-bold">From</span>
        {link.funding.networks.map((network) => {
          const line = lineFor(network);
          return line ? <LineBullet key={network} line={line} /> : null;
        })}
        <span>with {link.funding.assets.join(", ")}</span>
        <span>· to {link.destination.actions.map((action) => action.label).join(", ")}</span>
      </div>
      <p className="text-sm">
        {link.uses.max !== null ? `${link.uses.left ?? 0} of ${link.uses.max} uses left` : "No use limit"} · expires {formatWhen(link.expiresAt)}
        {pendingLeft && !pendingLeft.past ? ` · activates ${pendingLeft.text}` : ""}
      </p>
      {reason ? <p className="text-sm font-bold text-[#7A3500]">{reason}</p> : null}
      <div className="flex min-w-0 flex-wrap gap-x-5 gap-y-3 border-t-2 border-dashed border-[#1A1A1A]/30 pt-3">
        <Counter label="Views (7 d)" value={compact(stats.pageView)} />
        <Counter label="Intents" value={compact(stats.intent)} />
        <Counter label="Completed" value={compact(stats.completed)} />
        <Counter label="Volume" value={formatUsd(stats.volumeUsd ?? "0").replace(/\.00$/u, "")} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={panelId}
          className={cx("inline-flex min-h-10 items-center gap-1.5 text-xs font-black uppercase tracking-[0.12em] text-[#1A1A1A] underline decoration-2 underline-offset-4", "focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#0052FF]")}
        >
          <ChevronDown className={cx("h-4 w-4 transition-transform motion-reduce:transition-none", open && "rotate-180")} aria-hidden="true" />
          {open ? "Hide" : "Share, counters and controls"}
        </button>
      </div>
      </div>
      {open ? (
        <div id={panelId} className={cx("flex min-w-0 flex-col gap-6 border-t-0 p-4 sm:p-5", INK_BORDER, SURFACE)}>
          <LinkShare link={link} />
          <StatsView link={link} apiKey={apiKey} />
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              {link.status === "active" || link.status === "pending" ? (
                <Button size="sm" variant="secondary" loading={pause.status === "loading"} onClick={() => void pause.run(link.id).then((view) => view && onChanged(`${link.title} is paused.`))}>
                  <Pause className="h-3.5 w-3.5" aria-hidden="true" />
                  Pause
                </Button>
              ) : null}
              {link.status === "paused" ? (
                <Button size="sm" variant="secondary" loading={resume.status === "loading"} onClick={() => void resume.run(link.id, accept).then((view) => view && onChanged(`${link.title} is ${view.status === "pending" ? "pending again (re-pinned)" : "active again"}.`))}>
                  <Play className="h-3.5 w-3.5" aria-hidden="true" />
                  {accept.length > 0 ? "Re-pin and resume" : "Resume"}
                </Button>
              ) : null}
              {link.status !== "deleted" && !confirmDelete ? (
                <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  Withdraw
                </Button>
              ) : null}
            </div>
            {accept.length > 0 && link.status === "paused" ? (
              <p className={cx("text-xs", TEXT_MUTED)}>Resuming accepts the change ({accept.join(", ")}): Kletia pins the new value as a new revision{link.status === "paused" ? ", with the activation delay again on mainnet" : ""}.</p>
            ) : null}
            <p className={cx("text-xs", TEXT_MUTED)}>Changes only ever tighten what visitors can do (PATCH /v1/links/{"{id}"}); to change where the money goes, publish a new link.</p>
            {confirmDelete ? (
              <div className="flex flex-col gap-2 border-[3px] border-[#B91C1C] bg-[#FFE4E4] p-3 text-sm text-[#1A1A1A] dark:border-[#7F1D1D] dark:bg-[#2A1215] dark:text-[#FEE2E2]">
                <p className="font-bold">Withdraw {link.title}? Its page answers 410 at once; visitors who already started can finish.</p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="ink" loading={remove.status === "loading"} onClick={() => void remove.run(link.id).then((id) => id && onChanged(`${link.title} was withdrawn.`))}>
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
        </div>
      ) : null}
    </li>
  );
}

/** Developer portal: your intent links (links design §11.5). The key stays in memory only. */
export default function LinksPanel() {
  const { key } = useSessionKey();
  const kind = portalKeyKind(key);
  const [tab, setTab] = useState<"list" | "new">("list");
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const tag = kind ? maskKey(key) : null;
  const list = useApiResource<LinkOwnerView[]>(tag ? `links:${tag}:${status}` : null, (_client, signal) =>
    keyedClient(key).links.list(status ? { status: status as "active" } : {}, { signal: sdkSignal(signal) }),
  );
  const contracts = useApiResource<ContractView[]>(tag ? `links-contracts:${tag}` : null, (_client, signal) => keyedClient(key).contracts.list({}, { signal: sdkSignal(signal) }));
  const keys = useApiResource(tag ? `links-keys:${tag}` : null, (_client, signal) => keyedClient(key).keys.list({ signal: sdkSignal(signal) }));
  const currentId = keys.data?.find((item) => item.current)?.id ?? null;
  const policy = useApiResource<PolicyReadResponse>(tag && currentId ? `links-policy:${tag}:${currentId}` : null, (_client, signal) => keyedClient(key).policies.get(currentId!, { signal: sdkSignal(signal) }));
  const counting = (list.data ?? []).some((link) => link.status === "pending");
  const now = useNow(1_000, counting);

  if (!kind) return <NeedKey purpose="publish, pause and withdraw intent links and read their counters" agentKeys />;
  const links = list.data ?? [];
  const ruleBook = (policy.data?.effective?.chain.length ?? 0) > 0;

  return (
    <PortalTabs
      label="Links"
      active={tab}
      onChange={setTab}
      tabs={[
        { id: "list", label: "Your links", note: list.data ? String(links.length) : undefined },
        { id: "new", label: "New link" },
      ]}
    >
      {tab === "list" ? (
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <SelectField
              label="Show"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              containerClassName="w-48"
              options={[
                { value: "", label: "Every link" },
                { value: "active", label: "Active" },
                { value: "pending", label: "Pending" },
                { value: "paused", label: "Paused" },
                { value: "suspended", label: "Suspended" },
                { value: "deleted", label: "Withdrawn" },
              ]}
            />
            <Button size="sm" variant="ghost" onClick={list.reload} aria-label="Reload links">
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              Reload
            </Button>
          </div>
          <div aria-live="polite">{notice ? <p className="border-l-[6px] border-[#0B7A4B] bg-[#E9FFF5] px-3 py-2 text-sm text-[#1A1A1A] dark:bg-[#0E2A20] dark:text-[#D1FAE5]">{notice}</p> : null}</div>
          {list.status === "loading" && !list.data ? (
            <SkeletonGroup label="Loading links" className="flex flex-col gap-3">
              <Skeleton surface="card" className="h-40" />
            </SkeletonGroup>
          ) : list.status === "error" && list.error ? (
            <ApiErrorPanel error={list.error} title="Could not list links" onRetry={list.reload} />
          ) : links.length === 0 ? (
            <div className={cx("flex flex-col items-start gap-4 p-6", INK_BORDER, HARD_SHADOW, SURFACE)}>
              <Icon name="ticket" size={36} />
              <p className="font-display text-xl font-bold">{status ? "No link with this status." : "No links published with this key yet."}</p>
              <p className={cx("max-w-2xl text-sm", TEXT_MUTED)}>
                A link is a public page that does one fixed thing in the visitor&apos;s own wallet: pay you, deposit into your contract, or bridge and stake. You fix where the money goes; visitors choose where it comes from.
              </p>
              <Button onClick={() => setTab("new")}>Make a link</Button>
            </div>
          ) : (
            <ul className="flex min-w-0 flex-col gap-5">
              {links.map((link) => (
                <LinkRow
                  key={link.id}
                  link={link}
                  apiKey={key}
                  now={now}
                  open={open === link.id}
                  onToggle={() => setOpen((current) => (current === link.id ? null : link.id))}
                  onChanged={(message) => {
                    setNotice(message);
                    list.reload();
                  }}
                />
              ))}
            </ul>
          )}
          <p className={cx("text-xs", TEXT_MUTED)}>Counters on each ticket cover the last 7 days. A key holds at most 200 active links.</p>
        </div>
      ) : (
        <LinkBuilder
          apiKey={key}
          contracts={contracts.data ?? null}
          ruleBook={ruleBook}
          keyId={currentId}
          onCreated={(link) => {
            setNotice(`Published ${link.title} (${link.id}).`);
            list.reload();
          }}
        />
      )}
    </PortalTabs>
  );
}
