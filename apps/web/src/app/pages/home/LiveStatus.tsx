import { ArrowRight, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";

import { describePlatformError, PLATFORM_ORIGIN } from "../../../shared/platform/kletiaClient";
import { registryNetworks, sortNetworks } from "../../../shared/platform/registry";
import { Link } from "../../routes/Link";
import { AnimatedNumber } from "../../site/motion/AnimatedNumber";
import { Badge } from "../../site/ui/Badge";
import { Button } from "../../site/ui/Button";
import { Section } from "../../site/ui/Section";
import { StatusDot, type HealthState } from "../../site/ui/StatusDot";
import { cx, FOCUS_RING, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../site/ui/styles";
import { LatencyBar } from "../networks/LatencyBar";
import { formatMs, formatUptime, useHealthHistory } from "../networks/useHealthHistory";
import { actionsOf, networkLabel } from "../protocols/protocolStats";
import type { HomeData } from "./useHomeData";

const NETWORKS = sortNetworks(registryNetworks());
const KNOWN = new Set<string>(NETWORKS.map((network) => network.key));

function Figure({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-l-[3px] border-[#1A1A1A]/20 pl-3 dark:border-white/15">
      <dt className={cx(LABEL, "!text-[10px]", TEXT_MUTED)}>{label}</dt>
      <dd className="font-code text-sm font-bold">{children}</dd>
    </div>
  );
}

export function LiveStatus({ data }: { readonly data: HomeData }) {
  const { health, networks: capabilities } = data;
  const report = health.status === "success" ? health.data : undefined;
  const history = useHealthHistory(report, report ? health.updatedAt : null);
  const liveActions = new Map((capabilities.data ?? []).map((network) => [network.key as string, actionsOf(network)]));
  const byNetwork = new Map((health.data?.networks ?? []).map((entry) => [entry.network as string, entry]));
  const live = Boolean(report);
  const loading = health.status === "loading" && !health.data;
  const overall: HealthState = loading
    ? "loading"
    : report
      ? report.status === "ok"
        ? "ok"
        : report.status === "degraded"
          ? "degraded"
          : "down"
      : "unknown";
  const uptime = formatUptime(report?.uptimeSeconds);
  const extra = (health.data?.networks ?? []).filter((entry) => !KNOWN.has(entry.network));

  return (
    <Section
      id="status"
      tone="paper"
      bordered
      reveal
      eyebrow="Live status"
      title="Real endpoints. Real networks."
      intro={
        <>
          This panel calls <code className="font-code text-[0.9em]">GET /v1/health</code> on the public API through{" "}
          <code className="font-code text-[0.9em]">@kletia/sdk</code>, right now, from your browser.
        </>
      }
      actions={
        <Link
          to="/networks"
          className={cx("inline-flex min-h-11 items-center gap-2 text-sm font-black uppercase tracking-[0.14em] underline decoration-[3px] underline-offset-4", FOCUS_RING)}
        >
          Capabilities & venues
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      }
    >
      <div className={cx("grid lg:grid-cols-[0.85fr_1.15fr]", INK_BORDER, HARD_SHADOW, SURFACE)}>
        <div className="flex flex-col gap-6 border-b-[3px] border-[#1A1A1A] p-6 dark:border-[#4B5563] sm:p-8 lg:border-b-0 lg:border-r-[3px]">
          <div className="flex items-center justify-between gap-3">
            <p className={cx(LABEL, TEXT_MUTED)}>Platform API</p>
            {!live && !loading ? <Badge tone="yellow">Registry view</Badge> : <Badge tone="green">Live</Badge>}
          </div>
          <div aria-live="polite" aria-busy={health.status === "loading"}>
            <StatusDot
              state={overall}
              pulse="once"
              pulseKey={health.updatedAt ?? undefined}
              label={loading ? "Checking API" : report ? `API ${report.status}` : "Status unavailable"}
              className="[&>span:last-child]:text-base"
            />
            {!live && health.status === "error" && health.error ? (
              <p className={cx("mt-3 text-sm leading-relaxed", TEXT_MUTED)}>
                {describePlatformError(health.error)} Showing the registry view instead.
              </p>
            ) : null}
          </div>
          <div>
            <p className="font-display text-[clamp(3.5rem,9vw,5.5rem)] font-bold leading-none tracking-[-0.05em]">
              <AnimatedNumber value={report ? health.latencyMs : null} format={formatMs} />
            </p>
            <p className={cx("mt-2 text-sm", TEXT_MUTED)}>Round trip for this check, measured in your browser.</p>
          </div>
          <dl className="grid grid-cols-2 gap-4">
            <Figure label="Uptime">{uptime ?? "—"}</Figure>
            <Figure label="Version">{report?.version || "—"}</Figure>
            <Figure label="Networks online">
              {report ? `${(report.networks ?? []).filter((entry) => entry.ok).length}/${(report.networks ?? []).length}` : "—"}
            </Figure>
            <Figure label="Checked">{report && health.updatedAt ? new Date(health.updatedAt).toLocaleTimeString() : "—"}</Figure>
            <Figure label="Webhooks">{report?.webhooks?.status ? report.webhooks.status.replace(/_/gu, " ") : "—"}</Figure>
            <Figure label="Intent store">{report?.storage?.intents || "—"}</Figure>
          </dl>
          <p className="break-all border-2 border-dashed border-[#1A1A1A]/25 px-3 py-2 font-code text-xs text-[#45464B] dark:border-white/15 dark:text-[#A9B6C8]">
            GET {PLATFORM_ORIGIN}/v1/health
          </p>
          <div className="mt-auto flex flex-wrap gap-3">
            <Button variant="secondary" size="sm" onClick={health.reload} disabled={health.status === "loading"}>
              <RefreshCw className={cx("h-3.5 w-3.5", health.status === "loading" && "animate-spin motion-reduce:animate-none")} aria-hidden="true" />
              Re-check
            </Button>
          </div>
        </div>

        <ul className="grid content-start xl:grid-cols-2" aria-label="Per-network status">
          {NETWORKS.map((network) => {
            const entry = byNetwork.get(network.key);
            const state: HealthState = loading ? "loading" : entry ? (entry.ok ? "ok" : "down") : "unknown";
            const actions = liveActions.get(network.key) ?? actionsOf(network);
            return (
              <li
                key={network.key}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 border-b-2 border-dashed border-[#1A1A1A]/20 px-6 py-3.5 dark:border-white/10 sm:px-8 xl:px-5 xl:odd:border-r-2"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span aria-hidden="true" className="h-4 w-4 shrink-0 border-2 border-[#1A1A1A] dark:border-[#0B1120]" style={{ backgroundColor: network.color }} />
                  <div className="min-w-0">
                    <p className="truncate font-bold leading-tight">{network.name}</p>
                    <p className="font-code text-[11px] leading-snug text-[#0052FF] [overflow-wrap:anywhere] dark:text-[#7EA6FF]">
                      {actions.length > 0 ? actions.join(" · ") : network.id}
                      {actions.length > 0 && !liveActions.has(network.key) ? " (registry)" : ""}
                    </p>
                  </div>
                </div>
                <StatusDot
                  state={state}
                  pulse="once"
                  pulseKey={entry ? (health.updatedAt ?? undefined) : undefined}
                  label={state === "ok" ? "RPC ok" : state === "down" ? "RPC down" : state === "loading" ? "Checking" : "No data"}
                  className="justify-self-end"
                />
                {entry && typeof entry.latencyMs === "number" ? (
                  <div className="col-span-2 flex items-center gap-3 pl-7">
                    <LatencyBar ms={entry.latencyMs} history={history[network.key]} className="flex-1" />
                    <span className="w-16 shrink-0 text-right font-code text-xs text-[#45464B] dark:text-[#A9B6C8]">
                      <AnimatedNumber value={entry.latencyMs} format={formatMs} />
                    </span>
                  </div>
                ) : null}
              </li>
            );
          })}
          {extra.map((entry) => (
            <li key={entry.network} className="flex items-center justify-between border-b-2 border-dashed border-[#1A1A1A]/20 px-6 py-3.5 dark:border-white/10 sm:px-8 xl:px-5">
              <span className="font-bold">{networkLabel(entry.network).name}</span>
              <StatusDot state={entry.ok ? "ok" : "down"} pulse="none" />
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}
