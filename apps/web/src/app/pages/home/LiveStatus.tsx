import { CHAINS, isNetworkKey } from "@kletia/core";
import { ArrowRight, RefreshCw } from "lucide-react";

import { describePlatformError, PLATFORM_ORIGIN } from "../../../shared/platform/kletiaClient";
import { fetchHealth, fetchNetworks } from "../../../shared/platform/platformApi";
import { registryNetworks, sortNetworks } from "../../../shared/platform/registry";
import { useApiResource } from "../../../shared/platform/useApiResource";
import { Link } from "../../routes/Link";
import { Badge } from "../../site/ui/Badge";
import { Button } from "../../site/ui/Button";
import { Section } from "../../site/ui/Section";
import { StatusDot, type HealthState } from "../../site/ui/StatusDot";
import { cx, FOCUS_RING, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../site/ui/styles";

const NETWORKS = sortNetworks(registryNetworks());

export function LiveStatus() {
  const health = useApiResource("health", fetchHealth);
  const capabilities = useApiResource("networks", fetchNetworks);
  const liveActions = new Map((capabilities.data ?? []).map((network) => [network.key, network.actions]));
  const byNetwork = new Map((health.data?.networks ?? []).map((entry) => [entry.network, entry]));
  const live = health.status === "success" && health.data;
  const overall: HealthState =
    health.status === "loading" && !health.data
      ? "loading"
      : live
        ? health.data!.status === "ok"
          ? "ok"
          : health.data!.status === "degraded"
            ? "degraded"
            : "down"
        : "unknown";

  return (
    <Section
      id="status"
      tone="paper"
      bordered
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
          Capabilities & protocols
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      }
    >
      <div className={cx("grid lg:grid-cols-[0.9fr_1.1fr]", INK_BORDER, HARD_SHADOW, SURFACE)}>
        <div className="flex flex-col gap-5 border-b-[3px] border-[#1A1A1A] p-6 dark:border-[#4B5563] lg:border-b-0 lg:border-r-[3px] sm:p-8">
          <p className={cx(LABEL, TEXT_MUTED)}>Platform API</p>
          <div aria-live="polite" aria-busy={health.status === "loading"}>
            <StatusDot
              state={overall}
              label={
                overall === "loading"
                  ? "Checking API"
                  : live
                    ? `API ${health.data!.status}`
                    : "Status unavailable"
              }
              className="[&>span:last-child]:text-base"
            />
            <p className={cx("mt-4 text-sm leading-relaxed", TEXT_MUTED)}>
              {live
                ? `Responded in ${health.latencyMs ?? "—"} ms${health.data!.version ? ` · version ${health.data!.version}` : ""}.`
                : health.status === "error" && health.error
                  ? `${describePlatformError(health.error)} Showing the registry view instead.`
                  : "Contacting the API…"}
            </p>
          </div>
          <p className="break-all font-code text-xs text-[#45464B] dark:text-[#A9B6C8]">{PLATFORM_ORIGIN}/v1/health</p>
          <div className="mt-auto flex flex-wrap gap-3">
            <Button variant="secondary" size="sm" onClick={health.reload} disabled={health.status === "loading"}>
              <RefreshCw className={cx("h-3.5 w-3.5", health.status === "loading" && "animate-spin motion-reduce:animate-none")} aria-hidden="true" />
              Re-check
            </Button>
            {!live && health.status !== "loading" ? <Badge tone="yellow">Registry view</Badge> : null}
          </div>
        </div>

        <ul className="divide-y-2 divide-dashed divide-[#1A1A1A]/20 dark:divide-white/10" aria-label="Per-network status">
          {NETWORKS.map((network) => {
            const entry = byNetwork.get(network.key);
            const state: HealthState =
              health.status === "loading" && !health.data ? "loading" : entry ? (entry.ok ? "ok" : "down") : "unknown";
            return (
              <li key={network.key} className="flex flex-wrap items-center justify-between gap-3 px-6 py-3.5 sm:px-8">
                <div className="flex min-w-0 items-center gap-3">
                  <span aria-hidden="true" className="h-4 w-4 shrink-0 border-2 border-[#1A1A1A] dark:border-[#0B1120]" style={{ backgroundColor: network.color }} />
                  <div className="min-w-0">
                    <p className="font-bold leading-tight">{network.name}</p>
                    <p className="truncate font-code text-[11px] text-[#45464B] dark:text-[#A9B6C8]">{network.id}</p>
                    <p className="mt-0.5 font-code text-[11px] text-[#0052FF] dark:text-[#7EA6FF]">
                      {(liveActions.get(network.key) ?? network.actions).join(" · ")}
                      {liveActions.has(network.key) ? "" : " (registry)"}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {entry?.latencyMs !== undefined ? (
                    <span className="font-code text-xs text-[#45464B] dark:text-[#A9B6C8]">{entry.latencyMs} ms</span>
                  ) : null}
                  <StatusDot
                    state={state}
                    label={state === "ok" ? "RPC ok" : state === "down" ? "RPC down" : state === "loading" ? "Checking" : "No data"}
                  />
                </div>
              </li>
            );
          })}
          {(health.data?.networks ?? [])
            .filter((entry) => !isNetworkKey(entry.network) || !NETWORKS.some((network) => network.key === entry.network))
            .map((entry) => (
              <li key={entry.network} className="flex items-center justify-between px-6 py-3.5 sm:px-8">
                <span className="font-bold">{isNetworkKey(entry.network) ? CHAINS[entry.network].name : entry.network}</span>
                <StatusDot state={entry.ok ? "ok" : "down"} />
              </li>
            ))}
        </ul>
      </div>
    </Section>
  );
}
