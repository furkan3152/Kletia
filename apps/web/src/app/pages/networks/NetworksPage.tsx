import type { HealthReport, NetworkCapabilities } from "@kletia/sdk";
import { ArrowRight, Check, Minus, RefreshCw } from "lucide-react";
import { useId, useMemo, useRef, useState, useEffect } from "react";

import { describePlatformError, PLATFORM_ORIGIN } from "../../../shared/platform/kletiaClient";
import { fetchHealth, fetchNetworks, fetchProtocols } from "../../../shared/platform/platformApi";
import { registryNetworks, registryProtocols, sortNetworks } from "../../../shared/platform/registry";
import { useApiResource, type ApiResource } from "../../../shared/platform/useApiResource";
import { Link } from "../../routes/Link";
import { formatBoardClock, lineFor } from "../../site/art";
import { DepartureBoard } from "../../site/art/DepartureBoard";
import { LineBullet } from "../../site/art/LineBullet";
import { Reveal } from "../../site/motion/Reveal";
import { useInView } from "../../site/motion/useInView";
import { usePageVisible } from "../../site/motion/usePageVisible";
import { useReducedMotion } from "../../site/motion/useReducedMotion";
import { countWordTitle, PRODUCTION } from "../../site/registryCopy";
import { Badge } from "../../site/ui/Badge";
import { Section } from "../../site/ui/Section";
import { StatusDot, type HealthState } from "../../site/ui/StatusDot";
import { CONTAINER, cx, FOCUS_RING, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../site/ui/styles";
import { actionsOf, networkLabel, type ProtocolEntry } from "../protocols/protocolStats";
import { boardData } from "./boardRows";
import { formatMs, formatUptime, healthChanges } from "./useHealthHistory";
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

function originHost(): string {
  try {
    return new URL(PLATFORM_ORIGIN).host;
  } catch {
    return PLATFORM_ORIGIN;
  }
}

/** Live summary under the page title: API state, networks online and the browser round trip. */
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
  const board = boardData(health);
  const uptime = formatUptime(live?.uptimeSeconds);
  const notices = (health.data?.networks ?? []).filter((entry) => entry.detail && !entry.ok);
  const clock = board.live && health.updatedAt ? formatBoardClock(new Date(health.updatedAt)) : board.loading ? "--:-- UTC" : "OFFLINE";

  return (
    <div ref={panelRef} className="flex flex-col gap-6">
      <p className="sr-only" role="status" aria-live="polite">
        {speech.text}
      </p>
      <div className={cx("flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6", INK_BORDER, HARD_SHADOW, SURFACE)}>
        <div aria-busy={health.status === "loading"}>
          <StatusDot
            state={state}
            pulse="once"
            pulseKey={health.updatedAt ?? undefined}
            label={state === "loading" ? "Checking API" : live ? `API ${live.status}` : "Status unavailable"}
          />
          <p className={cx("mt-2 min-h-10 text-sm", TEXT_MUTED)}>
            {live
              ? `GET /v1/health answered in ${health.latencyMs ?? "?"} ms${live.version ? `, version ${live.version}` : ""}${
                  uptime ? `, up ${uptime}` : ""
                }${health.updatedAt ? `, checked ${new Date(health.updatedAt).toLocaleTimeString()}` : ""}.`
              : health.error
                ? `${describePlatformError(health.error)} The board shows the registry, not live RPC readings.`
                : "Contacting the API…"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:flex-nowrap">
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
              <RefreshCw className="kl-loop h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            ) : auto ? (
              <CountdownRing remaining={remaining} active={running} />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Re-check
          </button>
        </div>
      </div>

      <DepartureBoard
        rows={board.rows}
        clock={clock}
        busy={health.status === "loading"}
        note={
          board.live
            ? `RPC round trips measured by ${originHost()} and read from your browser every ${REFRESH_SECONDS} seconds while auto-refresh is on.`
            : board.loading
              ? `Asking ${originHost()} for the latest RPC round trips.`
              : "The API did not answer from this browser, so the board shows the registry compiled into @kletia/core and no timings."
        }
      />

      {notices.length || board.unknown.length ? (
        <ul className={cx("flex flex-col gap-2 text-sm", TEXT_MUTED)} aria-label="Notices">
          {notices.map((entry) => (
            <li key={entry.network} className="border-l-[3px] border-[#FF5A5F] pl-3">
              <strong className="text-[#1A1A1A] dark:text-white">{networkLabel(entry.network).name}:</strong> {entry.detail}
            </li>
          ))}
          {board.unknown.map((entry) => (
            <li key={`unknown-${entry.network}`} className="border-l-[3px] border-dashed border-[#1A1A1A]/40 pl-3 dark:border-white/30">
              <strong className="text-[#1A1A1A] dark:text-white">{entry.name || entry.network}</strong> is reported by the API but not
              yet in this page&apos;s registry: {entry.ok ? "running" : "no service"}
              {typeof entry.latencyMs === "number" ? `, ${formatMs(entry.latencyMs)}` : ""}.
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The network's line bullet (dashed in the test yard); nothing for a network this bundle does not know. */
function MatrixBullet({ network }: { network: string }) {
  const line = lineFor(network);
  return line ? <LineBullet line={line} decorative className={line.yard ? "kla-bullet--yard" : undefined} /> : null;
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
                    <span className="inline-flex items-center gap-2.5">
                      <MatrixBullet network={network.key} />
                      {network.name}
                    </span>
                  </th>
                  {actions.map((action, column) => {
                    const ok = supported.has(action);
                    return (
                      <td key={action} className="px-3 py-3 text-center">
                        {ok ? (
                          <Check
                            className="mx-auto h-5 w-5 text-[#0B7A4B] group-data-[reveal=shown]/matrix:animate-[kl-stamp_320ms_var(--kl-ease-snap)_backwards] dark:text-[#4ADE80] motion-reduce:!animate-none"
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
      {/* The departures board is the hero: the page is the station hall. */}
      <header className="kla-grain border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563]">
        <div className={cx(CONTAINER, "py-14 sm:py-20")}>
          <div className="grid gap-x-16 gap-y-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:items-end">
            <div className="min-w-0">
              <p className={cx(LABEL, "font-code text-[#0047E0] dark:text-[#7EA6FF]")}>Networks and status</p>
              <h1 className="mt-6 text-balance font-display text-[clamp(2.5rem,6vw,4.25rem)] font-bold leading-[1] tracking-[-0.045em]">
                {countWordTitle(PRODUCTION.length)} production networks and a test yard.
              </h1>
            </div>
            <p className={cx("max-w-2xl text-lg leading-relaxed lg:pb-1", TEXT_MUTED)}>
              Status comes from <code className="font-code text-[0.9em]">GET /v1/health</code> at{" "}
              <code className="break-words font-code text-[0.9em]">{PLATFORM_ORIGIN}</code> and is re-read from your browser every{" "}
              {REFRESH_SECONDS} seconds. The lamp and the flaps turn yellow when an RPC is slow and red when it stops answering. If
              the API cannot be reached, the board falls back to the registry compiled into{" "}
              <code className="font-code text-[0.9em]">@kletia/core</code> and says so.
            </p>
          </div>
          <section id="health" aria-labelledby="health-heading" className="mt-12 scroll-mt-24">
            <h2 id="health-heading" className="sr-only">
              RPC status per network
            </h2>
            <HealthPanel health={health} />
          </section>
        </div>
      </header>

      <Section
        id="capabilities"
        tone="paper"
        bordered
        reveal
        platform={1}
        eyebrow="Capabilities"
        title="What the planner accepts on each line"
        intro="Intent kinds per network. Production and test networks are separate capital, and a plan never mixes them."
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
        platform={2}
        eyebrow="Venues"
        title="Venues by network"
        intro="How many protocols Kletia can plan with on each network, and what it does with them. The full directory, with search and filters, has its own page."
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

