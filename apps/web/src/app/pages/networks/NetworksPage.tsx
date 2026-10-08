import {
  CHAINS,
  isNetworkKey,
  type NetworkKey,
  type ProtocolCapability,
  type ProtocolCategory,
  type ProtocolDescriptor,
} from "@kletia/core";
import type { NetworkCapabilities } from "@kletia/sdk";
import { ArrowUpRight, Check, Minus, RefreshCw } from "lucide-react";
import { useId, useMemo, useState } from "react";

import { describePlatformError, PLATFORM_ORIGIN } from "../../../shared/platform/kletiaClient";
import { fetchHealth, fetchNetworks, fetchProtocols } from "../../../shared/platform/platformApi";
import { registryNetworks, registryProtocols, sortNetworks } from "../../../shared/platform/registry";
import { useApiResource } from "../../../shared/platform/useApiResource";
import { Badge } from "../../site/ui/Badge";
import { Button } from "../../site/ui/Button";
import { SelectField } from "../../site/ui/Field";
import { Section } from "../../site/ui/Section";
import { StatusDot, type HealthState } from "../../site/ui/StatusDot";
import { CONTAINER, cx, FOCUS_RING, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../site/ui/styles";

const CAPABILITY_TONE: Record<ProtocolCapability, "blue" | "yellow" | "neutral"> = {
  execute: "blue",
  quote: "yellow",
  discover: "neutral",
};

const ACTION_ORDER = ["swap", "bridge", "transfer", "stake", "unstake", "deposit", "withdraw", "borrow", "repay", "claim", "read"];

function networkLabel(key: string): string {
  return isNetworkKey(key) ? CHAINS[key].name : key;
}

function SourceBadge({ live, loading }: { live: boolean; loading: boolean }) {
  if (loading) return <Badge tone="neutral">Loading</Badge>;
  return live ? <Badge tone="green">Live API</Badge> : <Badge tone="yellow">Registry view</Badge>;
}

function HealthPanel() {
  const health = useApiResource("health", fetchHealth);
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
  const byNetwork = new Map((health.data?.networks ?? []).map((entry) => [entry.network, entry]));
  const networks = sortNetworks(registryNetworks());

  return (
    <div className={cx(INK_BORDER, HARD_SHADOW, SURFACE)}>
      <div className="flex flex-col gap-4 border-b-[3px] border-[#1A1A1A] p-5 dark:border-[#4B5563] sm:flex-row sm:items-center sm:justify-between sm:p-6">
        <div aria-live="polite" aria-busy={health.status === "loading"}>
          <StatusDot
            state={overall}
            label={overall === "loading" ? "Checking API" : live ? `API ${health.data!.status}` : "Status unavailable"}
          />
          <p className={cx("mt-2 text-sm", TEXT_MUTED)}>
            {live
              ? `GET /v1/health answered in ${health.latencyMs ?? "—"} ms${health.data!.version ? ` · version ${health.data!.version}` : ""}${
                  health.updatedAt ? ` · checked ${new Date(health.updatedAt).toLocaleTimeString()}` : ""
                }.`
              : health.error
                ? `${describePlatformError(health.error)} Network rows below show the registry, not live RPC health.`
                : "Contacting the API…"}
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={health.reload} disabled={health.status === "loading"}>
          <RefreshCw className={cx("h-3.5 w-3.5", health.status === "loading" && "animate-spin motion-reduce:animate-none")} aria-hidden="true" />
          Re-check
        </Button>
      </div>
      <ul className="grid sm:grid-cols-2 lg:grid-cols-3">
        {networks.map((network) => {
          const entry = byNetwork.get(network.key);
          const state: HealthState =
            health.status === "loading" && !health.data ? "loading" : entry ? (entry.ok ? "ok" : "down") : "unknown";
          return (
            <li
              key={network.key}
              className="flex flex-col gap-2 border-b-2 border-dashed border-[#1A1A1A]/15 p-5 dark:border-white/10 sm:border-r-2"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="flex items-center gap-2 font-display text-lg font-bold">
                  <span aria-hidden="true" className="h-3.5 w-3.5 border-2 border-[#1A1A1A] dark:border-[#0B1120]" style={{ backgroundColor: network.color }} />
                  {network.name}
                </p>
                <Badge tone={network.environment === "mainnet" ? "green" : "yellow"}>{network.environment}</Badge>
              </div>
              <p className="break-all font-code text-[11px] text-[#45464B] dark:text-[#A9B6C8]">{network.id}</p>
              <div className="flex items-center justify-between gap-2">
                <StatusDot state={state} label={state === "ok" ? "RPC ok" : state === "down" ? "RPC down" : state === "loading" ? "Checking" : "No live data"} />
                {entry?.latencyMs !== undefined ? <span className="font-code text-xs">{entry.latencyMs} ms</span> : null}
              </div>
              {entry?.detail ? <p className={cx("text-xs", TEXT_MUTED)}>{entry.detail}</p> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function CapabilityMatrix({ networks, live, loading }: { networks: NetworkCapabilities[]; live: boolean; loading: boolean }) {
  const actions = useMemo(() => {
    const all = new Set(networks.flatMap((network) => network.actions));
    return [...all].sort((a, b) => {
      const ia = ACTION_ORDER.indexOf(a);
      const ib = ACTION_ORDER.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
  }, [networks]);
  const captionId = useId();

  return (
    <div className={cx("min-w-0", INK_BORDER, HARD_SHADOW, SURFACE)}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b-[3px] border-[#1A1A1A] px-4 py-3 dark:border-[#4B5563]">
        <p id={captionId} className="text-xs font-bold">
          Intent kinds per network {live ? "from GET /v1/networks" : "from the @kletia/core registry and the v1 support table"}
        </p>
        <SourceBadge live={live} loading={loading} />
      </div>
      <div className={cx("overflow-x-auto", FOCUS_RING)} tabIndex={0} role="region" aria-labelledby={captionId}>
        <table className="w-full min-w-[640px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b-[3px] border-[#1A1A1A] bg-[#F1EFE8] dark:border-[#4B5563] dark:bg-[#0F1A2C]">
              <th scope="col" className={cx(LABEL, "px-4 py-3")}>
                Network
              </th>
              {actions.map((action) => (
                <th key={action} scope="col" className={cx(LABEL, "px-3 py-3 text-center")}>
                  {action}
                </th>
              ))}
              <th scope="col" className={cx(LABEL, "px-4 py-3")}>
                CAIP-2
              </th>
            </tr>
          </thead>
          <tbody>
            {networks.map((network) => (
              <tr key={network.key} className="border-b-2 border-[#1A1A1A]/10 last:border-b-0 dark:border-white/10">
                <th scope="row" className="whitespace-nowrap px-4 py-3 font-bold">
                  <span className="inline-flex items-center gap-2">
                    <span aria-hidden="true" className="h-3 w-3 border-2 border-[#1A1A1A] dark:border-[#0B1120]" style={{ backgroundColor: network.color }} />
                    {network.name}
                  </span>
                </th>
                {actions.map((action) => {
                  const supported = network.actions.includes(action);
                  return (
                    <td key={action} className="px-3 py-3 text-center">
                      {supported ? (
                        <Check className="mx-auto h-5 w-5 text-[#0B7A4B] dark:text-[#14F195]" aria-hidden="true" />
                      ) : (
                        <Minus className="mx-auto h-4 w-4 text-[#94A3B8]" aria-hidden="true" />
                      )}
                      <span className="sr-only">{supported ? "Supported" : "Not supported"}</span>
                    </td>
                  );
                })}
                <td className="whitespace-nowrap px-4 py-3 font-code text-[11px] text-[#45464B] dark:text-[#A9B6C8]">{network.id}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ProtocolDirectory({ protocols, live, loading }: { protocols: ProtocolDescriptor[]; live: boolean; loading: boolean }) {
  const [category, setCategory] = useState<"all" | ProtocolCategory>("all");
  const [network, setNetwork] = useState<"all" | NetworkKey>("all");
  const [capability, setCapability] = useState<"all" | ProtocolCapability>("all");

  const categories = useMemo(() => [...new Set(protocols.map((protocol) => protocol.category))].sort(), [protocols]);
  const networks = useMemo(
    () => [...new Set(protocols.flatMap((protocol) => protocol.networks))].filter(isNetworkKey),
    [protocols],
  );
  const filtered = protocols.filter(
    (protocol) =>
      (category === "all" || protocol.category === category) &&
      (network === "all" || protocol.networks.includes(network)) &&
      (capability === "all" || protocol.capabilities.includes(capability)),
  );

  return (
    <div className="flex flex-col gap-6">
      <div className={cx("grid gap-4 p-4 sm:grid-cols-3 sm:p-5", INK_BORDER, SURFACE)} role="group" aria-label="Filter protocols">
        <SelectField
          label="Category"
          value={category}
          onChange={(event) => setCategory(event.target.value as typeof category)}
          options={[{ value: "all", label: "All categories" }, ...categories.map((value) => ({ value, label: value.replace(/-/gu, " ") }))]}
        />
        <SelectField
          label="Network"
          value={network}
          onChange={(event) => setNetwork(event.target.value as typeof network)}
          options={[{ value: "all", label: "All networks" }, ...networks.map((value) => ({ value, label: networkLabel(value) }))]}
        />
        <SelectField
          label="Capability"
          value={capability}
          onChange={(event) => setCapability(event.target.value as typeof capability)}
          options={[
            { value: "all", label: "Any capability" },
            { value: "execute", label: "Execute" },
            { value: "quote", label: "Quote" },
            { value: "discover", label: "Discover" },
          ]}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3" aria-live="polite">
        <p className="text-sm font-bold">
          {filtered.length} of {protocols.length} protocols
        </p>
        <SourceBadge live={live} loading={loading} />
      </div>
      {filtered.length === 0 ? (
        <p className={cx("border-[3px] border-dashed border-[#1A1A1A]/30 p-8 text-center text-sm dark:border-white/15", TEXT_MUTED)}>
          No protocol matches these filters.
        </p>
      ) : (
        <ul className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((protocol) => (
            <li key={protocol.id} className={cx("flex flex-col gap-3 p-5", INK_BORDER, HARD_SHADOW, SURFACE)}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="font-display text-xl font-bold leading-tight">{protocol.name}</h3>
                  <p className="mt-1 font-code text-[11px] text-[#45464B] dark:text-[#A9B6C8]">{protocol.id}</p>
                </div>
                <Badge tone="outline">{protocol.category.replace(/-/gu, " ")}</Badge>
              </div>
              <p className={cx("flex-1 text-sm leading-relaxed", TEXT_MUTED)}>{protocol.summary}</p>
              <div className="flex flex-wrap gap-1.5" aria-label="Capabilities">
                {protocol.capabilities.map((value) => (
                  <Badge key={value} tone={CAPABILITY_TONE[value] ?? "neutral"}>
                    {value}
                  </Badge>
                ))}
                {protocol.crossChain ? <Badge tone="purple">cross-chain</Badge> : null}
              </div>
              <div className="flex flex-wrap gap-1.5" aria-label="Networks">
                {protocol.networks.map((value) => (
                  <Badge key={value} tone="neutral" dot={isNetworkKey(value) ? CHAINS[value].color : undefined}>
                    {networkLabel(value)}
                  </Badge>
                ))}
              </div>
              {/^https:\/\//u.test(protocol.website) ? (
                <a
                  href={protocol.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cx("inline-flex items-center gap-1 self-start text-xs font-black uppercase tracking-[0.12em] underline decoration-2 underline-offset-4", FOCUS_RING)}
                >
                  Website
                  <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="sr-only"> for {protocol.name} (opens in a new tab)</span>
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Networks & status: live health, capability matrix and protocol directory, with a registry fallback. */
export default function NetworksPage() {
  const networksResource = useApiResource("networks", fetchNetworks);
  const protocolsResource = useApiResource("protocols", fetchProtocols);

  const liveNetworks = networksResource.status === "success" && (networksResource.data?.length ?? 0) > 0;
  const liveProtocols = protocolsResource.status === "success" && (protocolsResource.data?.length ?? 0) > 0;
  const networks = useMemo(
    () => sortNetworks(liveNetworks ? networksResource.data! : registryNetworks()),
    [liveNetworks, networksResource.data],
  );
  const protocols = useMemo(
    () => (liveProtocols ? protocolsResource.data! : registryProtocols()),
    [liveProtocols, protocolsResource.data],
  );

  return (
    <>
      <header className="kl-grid-backdrop border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563]">
        <div className={cx(CONTAINER, "py-14 sm:py-20")}>
          <p className={cx(LABEL, "text-[#0052FF] dark:text-[#7EA6FF]")}>Networks & status</p>
          <h1 className="mt-4 max-w-4xl text-balance font-display text-[clamp(2.5rem,7vw,4.75rem)] font-bold leading-[0.95] tracking-[-0.045em]">
            Every network. Every venue. <span className="text-[#0052FF] dark:text-[#7EA6FF]">Live.</span>
          </h1>
          <p className={cx("mt-6 max-w-2xl text-lg leading-relaxed", TEXT_MUTED)}>
            What Kletia can do on each network right now, read from the public API at{" "}
            <code className="whitespace-nowrap font-code text-[0.9em]">{PLATFORM_ORIGIN}/v1</code>. When the API is unreachable this
            page falls back to the registries compiled into <code className="font-code text-[0.9em]">@kletia/core</code>.
          </p>
        </div>
      </header>

      <Section id="health" eyebrow="Health" title="API and RPC status">
        <HealthPanel />
      </Section>

      <Section
        id="capabilities"
        tone="paper"
        bordered
        eyebrow="Capabilities"
        title="Capability matrix"
        intro="Which intent kinds the planner accepts on each network. Mainnet and testnet networks are separate capital lanes."
      >
        {networksResource.status === "error" && networksResource.error ? (
          <p className={cx("mb-4 text-sm", TEXT_MUTED)} role="status">
            {describePlatformError(networksResource.error)} Showing the registry view.
          </p>
        ) : null}
        <CapabilityMatrix networks={networks} live={liveNetworks} loading={networksResource.status === "loading"} />
      </Section>

      <Section
        id="protocols"
        eyebrow="Directory"
        title="Protocol directory"
        intro="Execute: Kletia builds wallet-ready transactions. Quote: live routes, execution elsewhere. Discover: read-only market data. A registry entry is never a promise of execution."
      >
        {protocolsResource.status === "error" && protocolsResource.error ? (
          <p className={cx("mb-4 text-sm", TEXT_MUTED)} role="status">
            {describePlatformError(protocolsResource.error)} Showing the registry view.
          </p>
        ) : null}
        <ProtocolDirectory protocols={protocols} live={liveProtocols} loading={protocolsResource.status === "loading"} />
      </Section>
    </>
  );
}
