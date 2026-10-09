import type { HealthReport, NetworkCapabilities } from "@kletia/sdk";
import { ArrowRight, Check, Minus, RefreshCw } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { describePlatformError, PLATFORM_ORIGIN } from "../../../shared/platform/kletiaClient";
import { fetchHealth, fetchNetworks, fetchProtocols } from "../../../shared/platform/platformApi";
import { registryNetworks, registryProtocols, sortNetworks } from "../../../shared/platform/registry";
import { useApiResource, type ApiResource } from "../../../shared/platform/useApiResource";
import { Link } from "../../routes/Link";
import { AnimatedNumber } from "../../site/motion/AnimatedNumber";
import { Reveal } from "../../site/motion/Reveal";
import { useInView } from "../../site/motion/useInView";
import { usePageVisible } from "../../site/motion/usePageVisible";
import { useReducedMotion } from "../../site/motion/useReducedMotion";
import { Badge } from "../../site/ui/Badge";
import { Section } from "../../site/ui/Section";
import { StatusDot, type HealthState } from "../../site/ui/StatusDot";
import { CONTAINER, cx, FOCUS_RING, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../site/ui/styles";
import { actionsOf, networkLabel, type ProtocolEntry } from "../protocols/protocolStats";
import { LatencyBar } from "./LatencyBar";
import { formatMs, formatUptime, healthChanges, useHealthHistory } from "./useHealthHistory";
import { VenuesByNetwork } from "./VenuesByNetwork";

const ACTION_ORDER = ["swap", "bridge", "transfer", "stake", "unstake", "deposit", "withdraw", "borrow", "repay", "claim", "read"];
const REFRESH_SECONDS = 30;

function SourceBadge({ live, loading }: { live: boolean; loading: boolean }) {
  if (loading) return <Badge tone="neutral">Loading</Badge>;
  return live ? <Badge tone="green">Live API</Badge> : <Badge tone="yellow">Registry view</Badge>;
}

function overallState(health: ApiResource<HealthReport>): HealthState {
  if (health.status === "loading" && !health.data) return "loading";
  if (health.status !== "success" || !health.data) return "unknown";
  return health.data.status === "ok" ? "ok" : health.data.status === "degraded" ? "degraded" : "down";
}

/** Live summary under the page title: API state, networks online and the browser round trip. */
function LiveSummary({ health }: { health: ApiResource<HealthReport> }) {
  const state = overallState(health);
  const live = health.status === "success" ? health.data : undefined;
  const entries = live?.networks ?? [];
  const online = entries.filter((entry) => entry.ok).length;
  return (
    <div className={cx("mt-10 inline-flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3", INK_BORDER, HARD_SHADOW, SURFACE)}>
      <StatusDot
        state={state}
        pulse="once"
        pulseKey={health.updatedAt ?? undefined}
        label={state === "loading" ? "Checking API" : live ? `API ${live.status}` : "Status unavailable"}
      />
      <p className="text-sm">
        <span className="font-display text-2xl font-bold tracking-[-0.03em]">
          <AnimatedNumber value={live ? online : null} />
        </span>
        <span className="font-display text-2xl font-bold tracking-[-0.03em]">/{live ? entries.length : "—"}</span>{" "}
        <span className={cx("font-semibold", TEXT_MUTED)}>networks online</span>
      </p>
      <p className="text-sm">
        <span className="font-display text-2xl font-bold tracking-[-0.03em]">
          <AnimatedNumber value={live ? health.latencyMs : null} format={formatMs} />
        </span>{" "}
        <span className={cx("font-semibold", TEXT_MUTED)}>round trip, from your browser</span>
      </p>
    </div>
  );
}

/** A one-shot highlight sweep across its parent each time `token` changes (WAAPI, transform only). */
function CheckSweep({ token }: { token: number | null }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const first = useRef(token);
  const reduced = useReducedMotion();
  useEffect(() => {
    if (token === null || token === first.current || reduced) return undefined;
    const element = ref.current;
    if (!element || typeof element.animate !== "function") return undefined;
    const animation = element.animate(
      [
        { transform: "translateX(-100%)", opacity: 1 },
        { transform: "translateX(100%)", opacity: 1 },
      ],
      { duration: 600, easing: "linear" },
    );
    return () => animation.cancel();
  }, [token, reduced]);
  return (
    <span
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 -translate-x-full bg-[linear-gradient(90deg,transparent,rgba(255,214,10,0.35),transparent)] opacity-0 dark:bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.08),transparent)]"
    />
  );
}

function CountdownRing({ remaining, active }: { remaining: number; active: boolean }) {
  const reduced = useReducedMotion();
  if (reduced) return <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />;
  const progress = Math.max(0, Math.min(1, 1 - remaining / REFRESH_SECONDS));
  return (
    <span aria-hidden="true" className="relative inline-flex h-5 w-5 items-center justify-center">
      <svg viewBox="0 0 20 20" className="absolute inset-0 -rotate-90">
        <circle cx="10" cy="10" r="8" fill="none" strokeWidth="2.5" className="stroke-[#1A1A1A]/15 dark:stroke-white/15" />
        <circle
          cx="10"
          cy="10"
          r="8"
          fill="none"
          strokeWidth="2.5"
          pathLength={1}
          strokeDasharray="1"
          strokeDashoffset={1 - progress}
          className={cx("stroke-[#0052FF] dark:stroke-[#FFD60A]", active && progress > 0 && "transition-[stroke-dashoffset] duration-1000 ease-linear")}
        />
      </svg>
      <RefreshCw className="h-2.5 w-2.5" />
    </span>
  );
}

interface HealthPanelProps {
  readonly health: ApiResource<HealthReport>;
}

/** API and per-network RPC health with auto-refresh, latency bars and change-only announcements. */
function HealthPanel({ health }: HealthPanelProps) {
  const visible = usePageVisible();
  const [panelRef, inView] = useInView<HTMLDivElement>({ rootMargin: "100px" });
  const [auto, setAuto] = useState(true);
  const [remaining, setRemaining] = useState(REFRESH_SECONDS);
  const remainingRef = useRef(REFRESH_SECONDS);
  const reload = health.reload;
  const running = auto && visible && inView && health.status !== "loading";

  const fresh = health.status === "success" ? health.data : undefined;
  const history = useHealthHistory(fresh, fresh ? health.updatedAt : null);

  // Announce only changes (and the result of a manual re-check), never every refresh.
  const [speech, setSpeech] = useState<{ readonly at: number | null; readonly report?: HealthReport; readonly text: string }>({
    at: null,
    text: "",
  });
  const [manualAt, setManualAt] = useState<number | null>(null);
  if (fresh && health.updatedAt !== null && health.updatedAt !== speech.at) {
    const changes = healthChanges(speech.report, fresh);
    let text = changes
      .map((change) => `${networkLabel(change.network).name} RPC is ${change.ok ? "back up" : "down"}.`)
      .join(" ");
    if (speech.report && speech.report.status !== fresh.status) text = `API is ${fresh.status}. ${text}`;
    if (manualAt !== null && health.updatedAt >= manualAt) {
      const online = (fresh.networks ?? []).filter((entry) => entry.ok).length;
      text = `Checked: API ${fresh.status}, ${online} of ${(fresh.networks ?? []).length} networks online. ${text}`;
      setManualAt(null);
    }
    setSpeech({ at: health.updatedAt, report: fresh, text: text.trim() });
  }

  useEffect(() => {
    if (!running) return undefined;
    const timer = window.setInterval(() => {
      remainingRef.current -= 1;
      if (remainingRef.current <= 0) {
        remainingRef.current = REFRESH_SECONDS;
        reload();
      }
      setRemaining(remainingRef.current);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [running, reload]);

  const recheck = () => {
    remainingRef.current = REFRESH_SECONDS;
    setRemaining(REFRESH_SECONDS);
    setManualAt(Date.now());
    reload();
  };

  const state = overallState(health);
  const live = health.status === "success" ? health.data : undefined;
  const byNetwork = new Map((health.data?.networks ?? []).map((entry) => [entry.network as string, entry]));
  const networks = sortNetworks(registryNetworks());
  const known = new Set<string>(networks.map((network) => network.key));
  const extra = (health.data?.networks ?? []).filter((entry) => !known.has(entry.network));
  const uptime = formatUptime(live?.uptimeSeconds);

  return (
    <div ref={panelRef} className={cx(INK_BORDER, HARD_SHADOW, SURFACE)}>
      <p className="sr-only" role="status" aria-live="polite">
        {speech.text}
      </p>
      <div className="flex flex-col gap-4 border-b-[3px] border-[#1A1A1A] p-5 dark:border-[#4B5563] sm:flex-row sm:items-center sm:justify-between sm:p-6">
        <div aria-busy={health.status === "loading"}>
          <StatusDot
            state={state}
            pulse="once"
            pulseKey={health.updatedAt ?? undefined}
            label={state === "loading" ? "Checking API" : live ? `API ${live.status}` : "Status unavailable"}
          />
          <p className={cx("mt-2 text-sm", TEXT_MUTED)}>
            {live
              ? `GET /v1/health answered in ${health.latencyMs ?? "—"} ms${live.version ? ` · version ${live.version}` : ""}${
                  uptime ? ` · up ${uptime}` : ""
                }${health.updatedAt ? ` · checked ${new Date(health.updatedAt).toLocaleTimeString()}` : ""}.`
              : health.error
                ? `${describePlatformError(health.error)} Network rows below show the registry, not live RPC health.`
                : "Contacting the API…"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-pressed={auto}
            onClick={() => setAuto((value) => !value)}
            title="Re-check every 30 seconds while this panel is visible"
            className={cx(
              "inline-flex min-h-9 items-center gap-1.5 border-2 border-dashed border-[#1A1A1A] px-2.5 text-[11px] font-black uppercase tracking-[0.12em] dark:border-[#4B5563]",
              auto ? "bg-[#E6FFF4] text-[#0B5E3A] dark:bg-[#0E2A22] dark:text-[#5CF2B4]" : "bg-transparent",
              FOCUS_RING,
            )}
          >
            Auto-refresh: {auto ? "on" : "off"}
          </button>
          <button
            type="button"
            onClick={recheck}
            disabled={health.status === "loading"}
            className={cx(
              "inline-flex min-h-9 items-center gap-1.5 border-[3px] border-[#1A1A1A] bg-white px-3 text-[11px] font-black uppercase tracking-[0.12em] text-[#1A1A1A] shadow-hard-sm transition-[transform,box-shadow] duration-90 ease-kl-snap hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-hard-md active:translate-x-[3px] active:translate-y-[3px] active:shadow-none disabled:opacity-60 motion-reduce:transition-none motion-reduce:hover:translate-x-0 motion-reduce:hover:translate-y-0 dark:border-[#4B5563] dark:bg-[#1A2841] dark:text-white",
              FOCUS_RING,
            )}
          >
            {health.status === "loading" ? (
              <RefreshCw className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            ) : auto ? (
              <CountdownRing remaining={remaining} active={running} />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Re-check
          </button>
        </div>
      </div>
      <ul className="grid sm:grid-cols-2 lg:grid-cols-3">
        {networks.map((network) => {
          const entry = byNetwork.get(network.key);
          const rowState: HealthState =
            health.status === "loading" && !health.data ? "loading" : entry ? (entry.ok ? "ok" : "down") : "unknown";
          return (
            <li
              key={network.key}
              className="flex min-w-0 flex-col gap-2.5 border-b-2 border-dashed border-[#1A1A1A]/15 p-5 dark:border-white/10 sm:border-r-2"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="flex min-w-0 items-center gap-2 font-display text-lg font-bold">
                  <span aria-hidden="true" className="h-3.5 w-3.5 shrink-0 border-2 border-[#1A1A1A] dark:border-[#0B1120]" style={{ backgroundColor: network.color }} />
                  <span className="truncate">{network.name}</span>
                </p>
                <Badge tone={network.environment === "mainnet" ? "green" : "yellow"}>{network.environment}</Badge>
              </div>
              <p className="break-all font-code text-[11px] text-[#45464B] dark:text-[#A9B6C8]">{network.id}</p>
              <div className="flex items-center justify-between gap-2">
                <StatusDot
                  state={rowState}
                  pulse="once"
                  pulseKey={entry ? (health.updatedAt ?? undefined) : undefined}
                  label={rowState === "ok" ? "RPC ok" : rowState === "down" ? "RPC down" : rowState === "loading" ? "Checking" : "No live data"}
                />
                <span className="relative overflow-hidden font-code text-xs">
                  {entry && typeof entry.latencyMs === "number" ? <AnimatedNumber value={entry.latencyMs} format={formatMs} /> : null}
                  <CheckSweep token={entry ? health.updatedAt : null} />
                </span>
              </div>
              {entry && typeof entry.latencyMs === "number" ? <LatencyBar ms={entry.latencyMs} history={history[network.key]} /> : null}
              {entry?.detail ? <p className={cx("text-xs", TEXT_MUTED)}>{entry.detail}</p> : null}
            </li>
          );
        })}
        {extra.map((entry) => (
          <li key={entry.network} className="flex min-w-0 flex-col gap-2.5 border-b-2 border-dashed border-[#1A1A1A]/15 p-5 dark:border-white/10 sm:border-r-2">
            <p className="truncate font-display text-lg font-bold">{entry.name || entry.network}</p>
            <div className="flex items-center justify-between gap-2">
              <StatusDot state={entry.ok ? "ok" : "down"} pulse="none" label={entry.ok ? "RPC ok" : "RPC down"} />
              {typeof entry.latencyMs === "number" ? <span className="font-code text-xs">{formatMs(entry.latencyMs)}</span> : null}
            </div>
            {typeof entry.latencyMs === "number" ? <LatencyBar ms={entry.latencyMs} history={history[entry.network]} /> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CapabilityMatrix({ networks, live, loading }: { networks: NetworkCapabilities[]; live: boolean; loading: boolean }) {
  const actions = useMemo(() => {
    const all = new Set(networks.flatMap((network) => actionsOf(network)));
    return [...all].sort((a, b) => {
      const ia = ACTION_ORDER.indexOf(a);
      const ib = ACTION_ORDER.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
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
      <Reveal
        className={cx(
          "group/matrix kl-scroll-shadow overflow-x-auto [--kl-scroll-bg:#ffffff] dark:[--kl-scroll-bg:#131E32]",
          FOCUS_RING,
        )}
        tabIndex={0}
        role="region"
        aria-labelledby={captionId}
      >
        <table className="w-full min-w-[640px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563]">
              <th scope="col" className={cx(LABEL, "sticky left-0 z-10 bg-[#F1EFE8] px-4 py-3 dark:bg-[#0F1A2C]")}>
                Network
              </th>
              {actions.map((action) => (
                <th key={action} scope="col" className={cx(LABEL, "bg-[#F1EFE8] px-3 py-3 text-center dark:bg-[#0F1A2C]")}>
                  {action}
                </th>
              ))}
              <th scope="col" className={cx(LABEL, "bg-[#F1EFE8] px-4 py-3 dark:bg-[#0F1A2C]")}>
                CAIP-2
              </th>
            </tr>
          </thead>
          <tbody>
            {networks.map((network) => {
              const supported = new Set(actionsOf(network));
              return (
                <tr
                  key={network.key}
                  className="group/row border-b-2 border-[#1A1A1A]/10 transition-colors duration-150 last:border-b-0 hover:bg-[#FFF7CC]/70 motion-reduce:transition-none dark:border-white/10 dark:hover:bg-white/[0.04]"
                >
                  <th
                    scope="row"
                    className="sticky left-0 z-10 whitespace-nowrap bg-white px-4 py-3 font-bold transition-colors duration-150 group-hover/row:bg-[#FFF9DB] motion-reduce:transition-none dark:bg-[#131E32] dark:group-hover/row:bg-[#18243A]"
                  >
                    <span className="inline-flex items-center gap-2">
                      <span aria-hidden="true" className="h-3 w-3 border-2 border-[#1A1A1A] dark:border-[#0B1120]" style={{ backgroundColor: network.color }} />
                      {network.name}
                    </span>
                  </th>
                  {actions.map((action, column) => {
                    const ok = supported.has(action);
                    return (
                      <td key={action} className="px-3 py-3 text-center">
                        {ok ? (
                          <Check
                            className="mx-auto h-5 w-5 text-[#0B7A4B] group-data-[reveal=shown]/matrix:animate-[kl-stamp_320ms_var(--kl-ease-snap)_backwards] dark:text-[#14F195] motion-reduce:!animate-none"
                            style={{ animationDelay: `${280 + column * 70}ms` }}
                            aria-hidden="true"
                          />
                        ) : (
                          <Minus className="mx-auto h-4 w-4 text-[#6B7280] dark:text-[#94A3B8]" aria-hidden="true" />
                        )}
                        <span className="sr-only">{ok ? "Supported" : "Not supported"}</span>
                      </td>
                    );
                  })}
                  <td className="whitespace-nowrap px-4 py-3 font-code text-[11px] text-[#45464B] dark:text-[#A9B6C8]">{network.id}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Reveal>
    </div>
  );
}

/** Networks & status: live health, capability matrix and venues per network, with a registry fallback. */
export default function NetworksPage() {
  const health = useApiResource("health", fetchHealth);
  const networksResource = useApiResource("networks", fetchNetworks);
  const protocolsResource = useApiResource("protocols", fetchProtocols);

  const liveNetworks = networksResource.status === "success" && (networksResource.data?.length ?? 0) > 0;
  const liveProtocols = (protocolsResource.data?.length ?? 0) > 0;
  const networks = useMemo(
    () => sortNetworks(liveNetworks ? networksResource.data! : registryNetworks()),
    [liveNetworks, networksResource.data],
  );
  const protocols = useMemo<readonly ProtocolEntry[]>(
    () => (liveProtocols ? (protocolsResource.data as readonly ProtocolEntry[]) : registryProtocols()),
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
            <code className="break-all font-code text-[0.9em]">{PLATFORM_ORIGIN}/v1</code>. When the API is unreachable this
            page falls back to the registries compiled into <code className="font-code text-[0.9em]">@kletia/core</code>.
          </p>
          <LiveSummary health={health} />
        </div>
      </header>

      <Section id="health" eyebrow="Health" title="API and RPC status" reveal>
        <HealthPanel health={health} />
      </Section>

      <Section
        id="capabilities"
        tone="paper"
        bordered
        reveal
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
        reveal
        eyebrow="Venues"
        title="Venues by network"
        intro="How many protocols Kletia can plan with on each network, and what it can do with them. The full directory, with search and filters, lives on its own page."
        actions={
          <Link
            to="/protocols"
            className={cx("inline-flex min-h-11 items-center gap-2 text-sm font-black uppercase tracking-[0.14em] underline decoration-[3px] underline-offset-4", FOCUS_RING)}
          >
            Protocol directory
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        }
      >
        {protocolsResource.status === "error" && protocolsResource.error && !liveProtocols ? (
          <p className={cx("mb-4 text-sm", TEXT_MUTED)} role="status">
            {describePlatformError(protocolsResource.error)} Showing the registry view.
          </p>
        ) : null}
        <div className="mb-6 flex items-center gap-3">
          <SourceBadge live={liveProtocols} loading={protocolsResource.status === "loading" && !liveProtocols} />
        </div>
        <VenuesByNetwork networks={networks} protocols={protocols} />
      </Section>
    </>
  );
}

