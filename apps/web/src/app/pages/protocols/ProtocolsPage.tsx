import { ArrowRight, ArrowUpRight, SearchX } from "lucide-react";
import { useMemo, useState } from "react";

import { describePlatformError } from "../../../shared/platform/kletiaClient";
import { fetchNetworks, fetchProtocols } from "../../../shared/platform/platformApi";
import { registryNetworks, registryProtocols, sortNetworks } from "../../../shared/platform/registry";
import { useApiResource } from "../../../shared/platform/useApiResource";
import { Link } from "../../routes/Link";
import { Reveal } from "../../site/motion/Reveal";
import { useReducedMotion } from "../../site/motion/useReducedMotion";
import { Icon } from "../../site/art/Icon";
import { PlatformNumber } from "../../site/art/Ornaments";
import { countProtocols, isOwnContractEntry, protocolHeadline, protocolNoun, realProtocols } from "../../site/protocolCount";
import { CONTRIBUTING_URL, GITHUB_URL } from "../../site/siteLinks";
import { Badge } from "../../site/ui/Badge";
import { Button, ButtonLink } from "../../site/ui/Button";
import { Section } from "../../site/ui/Section";
import { Skeleton, SkeletonGroup, SkeletonText } from "../../site/ui/Skeleton";
import { CONTAINER, cx, FOCUS_RING, INK_BORDER, LABEL, SHADOW_HARD, SURFACE, TEXT_MUTED } from "../../site/ui/styles";
import { ProtocolCard } from "./ProtocolCard";
import { ProtocolFilters } from "./ProtocolFilters";
import {
  CAPABILITY_HELP,
  networkLabel,
  networksOf,
  protocolTotals,
  protocolTransitionName,
  type ProtocolEntry,
} from "./protocolStats";
import { directoryRowFilter, directoryRows, isRowSelected, knownCategoryFilters } from "./directoryFilter";
import { applyFilters, EMPTY_FILTERS, sanitizeFilters, useProtocolFilters } from "./useProtocolFilters";

/** Above this many cards, filter changes skip the View Transition (too many snapshots). */
const VT_CARD_LIMIT = 80;
const INTRO_CARDS = 8;

function SourceBadge({ live, loading }: { readonly live: boolean; readonly loading: boolean }) {
  if (loading) return <Badge tone="neutral">Loading</Badge>;
  return live ? (
    <Badge tone="green" title="Read from GET /v1/protocols and GET /v1/networks">
      Live API
    </Badge>
  ) : (
    <Badge tone="yellow" title="Compiled into @kletia/core; the API could not be reached">
      Registry view
    </Badge>
  );
}

/**
 * The station directory hung in the hall: every kind of venue on this page
 * and how many platforms serve it, with the page totals under it. Printed
 * signage: ink board, paper letters, yellow header, in both themes. Each row
 * is a button that sets the category filter and moves to the grid (S-13).
 * While the live list loads it is printed from the registry, so the sign
 * keeps its size and nothing below it moves.
 */
function DirectorySign({
  protocols,
  executable,
  loading,
  ownContracts,
  category,
  onPick,
}: {
  readonly protocols: readonly ProtocolEntry[];
  /** Executable through the API (live data), or null in the registry view. */
  readonly executable: number | null;
  /** The live list is still loading: the executable count keeps its place. */
  readonly loading: boolean;
  readonly ownContracts: boolean;
  readonly category: string;
  readonly onPick: (category: string) => void;
}) {
  const rows = useMemo(() => directoryRows(protocols), [protocols]);
  const totals = useMemo(() => protocolTotals(protocols), [protocols]);
  return (
    <section
      aria-labelledby="directory-heading"
      className="border-[3px] border-[#1A1A1A] bg-[#1A1A1A] text-[#F4F1EA] shadow-[8px_8px_0_#1A1A1A] [--kla-plate:#FFD60A] dark:border-[#4B5563] dark:bg-[#060A14] dark:shadow-[8px_8px_0_#475569]"
    >
      <h2
        id="directory-heading"
        className="flex items-baseline justify-between gap-4 bg-[#FFD60A] px-5 py-3 font-code text-xs font-extrabold uppercase tracking-[0.18em] text-[#1A1A1A]"
      >
        <span>Station directory</span>
        <span className="font-semibold">{protocolNoun(totals.protocols)}</span>
      </h2>
      <ul className="px-3 py-2">
        {rows.map((row) => {
          const pressed = isRowSelected(row, category);
          return (
            <li key={row.key} className="border-b border-dashed border-[#F4F1EA]/25 last:border-b-0">
              <button
                type="button"
                aria-pressed={pressed}
                onClick={() => onPick(directoryRowFilter(row, category))}
                title={pressed ? "Show every category" : `Show only ${row.word.toLowerCase()} venues`}
                className={cx(
                  "flex min-h-11 w-full items-center gap-4 px-2 py-2 text-left transition-colors duration-150 hover:bg-[#F4F1EA]/10 motion-reduce:transition-none focus-visible:outline focus-visible:outline-[3px] focus-visible:-outline-offset-[3px] focus-visible:outline-[#FFD60A]",
                  pressed && "bg-[#FFD60A] text-[#1A1A1A] hover:bg-[#FFD60A] [--kla-plate:#F4F1EA]",
                )}
              >
                <Icon name={row.icon} size={26} />
                <span className="font-display text-lg font-bold tracking-[-0.01em]">{row.word}</span>
                <span aria-hidden="true" className="h-0 min-w-6 flex-1 border-b-2 border-dotted border-current opacity-40" />
                <span className="font-code text-sm font-bold tabular-nums">
                  {row.count}
                  <span className="sr-only"> {row.count === 1 ? "platform" : "platforms"}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="border-t-[3px] border-[#F4F1EA]/20 px-5 py-3 font-code text-xs font-semibold uppercase leading-relaxed tracking-[0.1em] text-[#F4F1EA]/85">
        {executable !== null ? `${executable} executable through the API · ` : loading ? "·· executable through the API · " : ""}
        {totals.crossChain} cross-network · {totals.networks} networks
        {ownContracts ? <span className="block text-[#FFD60A]">+ your own contracts, listed apart</span> : null}
      </p>
    </section>
  );
}

function GridSkeleton() {
  return (
    <SkeletonGroup label="Loading protocols" className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className={cx("flex h-[22rem] flex-col gap-4 p-5", INK_BORDER, SURFACE)}>
          <div className="flex items-start gap-4">
            <Skeleton surface="card" className="h-12 w-12 shrink-0" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton surface="card" className="h-5 w-2/3" />
              <Skeleton surface="card" className="h-3 w-1/3 border-2" />
            </div>
          </div>
          <SkeletonText surface="card" lines={3} />
          <div className="flex gap-1.5">
            <Skeleton surface="card" className="h-6 w-20 border-2" />
            <Skeleton surface="card" className="h-6 w-16 border-2" />
          </div>
          <Skeleton surface="card" className="mt-auto h-6 w-1/2 border-2" />
        </div>
      ))}
    </SkeletonGroup>
  );
}

interface GridProps {
  readonly protocols: readonly ProtocolEntry[];
  /** Platform number per protocol id: its place in the whole directory, so filtering never renumbers a sign. */
  readonly platforms: ReadonlyMap<string, number>;
  readonly nameOf: (id: string) => string | undefined;
}

/** The card grid. Cards present on its first render rise in (first 8 staggered); later cards glide via View Transitions. */
function ProtocolGrid({ protocols, platforms, nameOf }: GridProps) {
  const reduced = useReducedMotion();
  const [introIds] = useState(() => new Map(protocols.slice(0, INTRO_CARDS).map((protocol, index) => [protocol.id, index])));
  const names = useMemo(() => {
    const used = new Set<string>();
    return protocols.map((protocol) => {
      let name = protocolTransitionName(protocol.id);
      for (let suffix = 2; used.has(name); suffix += 1) name = `${protocolTransitionName(protocol.id)}-${suffix}`;
      used.add(name);
      return name;
    });
  }, [protocols]);
  const transitions = protocols.length <= VT_CARD_LIMIT;

  return (
    <ul className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
      {protocols.map((protocol, index) => (
        <ProtocolCard
          key={protocol.id}
          protocol={protocol}
          platform={platforms.get(protocol.id) ?? index + 1}
          transitionName={transitions ? names[index] : undefined}
          introIndex={reduced ? null : (introIds.get(protocol.id) ?? null)}
          nameOf={nameOf}
        />
      ))}
    </ul>
  );
}

const LEGEND: readonly { readonly title: string; readonly body: string; readonly service: "execute" | "quote" | "discover" }[] = [
  {
    title: "Execute",
    body: `${CAPABILITY_HELP.execute} Your wallet signs each one; Kletia never holds keys or funds.`,
    service: "execute",
  },
  {
    title: "Quote",
    body: `${CAPABILITY_HELP.quote} Quotes feed the planner's routes, fees and minimum outputs.`,
    service: "quote",
  },
  {
    title: "Discover",
    body: `${CAPABILITY_HELP.discover} A registry entry is never a promise of execution.`,
    service: "discover",
  },
];

/** The service chips exactly as the signs print them. */
const SERVICE_CHIP: Readonly<Record<"execute" | "quote" | "discover", string>> = {
  execute: "border-current text-[#0047E0] dark:text-[#7EA6FF]",
  quote: "border-[#1A1A1A] bg-[#FFD60A] text-[#1A1A1A]",
  discover: "border-current",
};

/**
 * Bring your own contract, a section of its own: the registry's "custom"
 * entries are not protocols but the doors your own registrations use, so they
 * are never counted with the directory.
 */
function OwnContractsPanel({ entries }: { readonly entries: readonly ProtocolEntry[] }) {
  return (
    <section
      id="your-contracts"
      aria-labelledby="own-contracts-heading"
      className={cx("grid scroll-mt-48 gap-6 bg-[#FFF7CC] p-6 text-[#1A1A1A] dark:bg-[#1A2841] dark:text-[#E2E8F0] sm:p-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center", INK_BORDER, SHADOW_HARD)}
    >
      <div className="min-w-0">
        <p className={cx(LABEL, "flex items-center gap-2 font-code")}>
          <Icon name="contract" size={22} />
          Not counted as protocols
        </p>
        <h2 id="own-contracts-heading" className="mt-3 font-display text-2xl font-bold tracking-[-0.02em] sm:text-3xl">
          Your own contracts
        </h2>
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed">
          Register your own EVM contract or Solana Action with your API key, and intents created with that key can call it. Kletia
          pins its code, simulates every call and shows who you are on every step. It does not audit your contract.
        </p>
        <ul className="mt-4 flex flex-wrap gap-2">
          {entries.map((entry) => (
            <li key={entry.id} className="border-2 border-[#1A1A1A] bg-white px-2.5 py-1 font-code text-xs font-bold dark:border-[#4B5563] dark:bg-[#0B1120]">
              {entry.name}
              <span className="font-medium"> · {networksOf(entry).length} {networksOf(entry).length === 1 ? "network" : "networks"}</span>
            </li>
          ))}
        </ul>
      </div>
      <ButtonLink to="/developers/contracts" variant="primary" className="self-start lg:self-center">
        Register a contract
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </ButtonLink>
    </section>
  );
}

/** /protocols: every venue Kletia can plan with, live from GET /v1/protocols with a registry fallback. */
export default function ProtocolsPage() {
  const reduced = useReducedMotion();
  const protocolsResource = useApiResource("protocols", fetchProtocols);
  const networksResource = useApiResource("networks", fetchNetworks);

  const liveProtocols = (protocolsResource.data?.length ?? 0) > 0;
  const protocolsLoading = protocolsResource.status === "loading" && !liveProtocols;
  const listed = useMemo<readonly ProtocolEntry[]>(
    () => (liveProtocols ? (protocolsResource.data as readonly ProtocolEntry[]) : registryProtocols()),
    [liveProtocols, protocolsResource.data],
  );
  // The directory counts and lists real protocols; the "custom" entries are the doors for your own contracts, shown apart.
  const protocols = useMemo(() => realProtocols(listed), [listed]);
  const ownContractEntries = useMemo(() => listed.filter(isOwnContractEntry), [listed]);
  const liveNetworks = (networksResource.data?.length ?? 0) > 0;
  const networkOrder = useMemo(
    () => sortNetworks(liveNetworks ? networksResource.data! : registryNetworks()).map((network) => network.key as string),
    [liveNetworks, networksResource.data],
  );

  // Filter options come from the data (never a hardcoded list).
  const { networkOptions, categories, available } = useMemo(() => {
    const keys = new Set<string>();
    for (const protocol of protocols) {
      for (const key of networksOf(protocol)) keys.add(key);
    }
    const rank = (key: string) => {
      const index = networkOrder.indexOf(key);
      return index === -1 ? 999 : index;
    };
    const ordered = [...keys].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    return {
      networkOptions: ordered.map(networkLabel),
      // The category filter offers the directory's groups (the sign words), in the sign's order.
      categories: directoryRows(protocols).map((row) => ({ value: row.key, label: row.word })),
      available: { networks: keys, categories: knownCategoryFilters(protocols) },
    };
  }, [protocols, networkOrder]);

  const api = useProtocolFilters(protocolsLoading ? null : available);
  const effective = sanitizeFilters(api.filters, available);
  const shownApi = useMemo(() => ({ ...api, filters: effective }), [api, effective]);
  const filtered = useMemo(() => applyFilters(protocols, effective), [protocols, effective]);
  // Platform numbers follow the whole directory in the chosen order, so filtering never renumbers a sign.
  const platforms = useMemo(
    () =>
      new Map(
        applyFilters(protocols, { ...EMPTY_FILTERS, sort: effective.sort }).map((protocol, index) => [protocol.id, Math.min(99, index + 1)]),
      ),
    [protocols, effective.sort],
  );
  const live = liveProtocols;
  const counted = useMemo(() => countProtocols(listed), [listed]);
  const nameOf = useMemo(() => {
    const names = new Map(listed.map((entry) => [entry.id as string, entry.name]));
    return (id: string) => names.get(id);
  }, [listed]);
  // A directory row sets the category and moves to the grid, without a scroll jump while reduced motion is on.
  const pickCategory = (category: string) => {
    api.update({ category }, { animate: filtered.length <= VT_CARD_LIMIT && protocols.length <= VT_CARD_LIMIT });
    const grid = document.getElementById("protocol-grid");
    grid?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  };

  return (
    <>
      <header className="kla-grain border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563]">
        <div className={cx(CONTAINER, "grid gap-12 py-14 sm:py-20 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:items-start lg:gap-16")}>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-4">
              <PlatformNumber code="PRO">Protocol directory</PlatformNumber>
              <SourceBadge live={live} loading={protocolsLoading} />
            </div>
            <h1 className="mt-6 max-w-4xl text-balance font-display text-[clamp(2.2rem,5.4vw,3.75rem)] font-bold leading-[1.02] tracking-[-0.04em]">
              {/* Counted from GET /v1/protocols: registry entries, live adapters on the platform surface, your own contracts apart.
                  While the live list loads the executable count is a blank of its width, so the heading never re-wraps. */}
              {protocolsLoading ? (
                <>
                  {protocolNoun(counted.protocols)},{" "}
                  <span aria-hidden="true" className="inline-block h-[0.8em] w-[1.15em] bg-current opacity-10" />
                  <span className="sr-only">counting</span> executable through the API
                  {counted.ownContracts ? ", + your own contracts" : ""}.
                </>
              ) : (
                <>{protocolHeadline(listed)}.</>
              )}
            </h1>
            <p className={cx("mt-6 max-w-2xl text-lg leading-relaxed", TEXT_MUTED)}>
              <strong className="text-[#1A1A1A] dark:text-white">Executable</strong> means Platform API v1 builds the
              transaction on this deployment; <strong className="text-[#1A1A1A] dark:text-white">named</strong> venues run
              through the protocol shown beside them. <strong className="text-[#1A1A1A] dark:text-white">Data feeds</strong> are
              only read, and <strong className="text-[#1A1A1A] dark:text-white">Console only</strong> venues run in the Kletia
              console, not the API. Every sign lists the networks the venue calls at.
            </p>
            <div className="mt-10 flex flex-wrap gap-x-6 gap-y-3">
              <Link
                to="/networks"
                className={cx("inline-flex min-h-11 items-center gap-2 text-sm font-black uppercase tracking-[0.14em] underline decoration-[3px] underline-offset-4", FOCUS_RING)}
              >
                Network status
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
              <Link
                to="/studio"
                className={cx("inline-flex min-h-11 items-center gap-2 text-sm font-black uppercase tracking-[0.14em] underline decoration-[3px] underline-offset-4", FOCUS_RING)}
              >
                Plan an intent
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </div>
          </div>
          <DirectorySign
            protocols={protocols}
            executable={counted.executable}
            loading={protocolsLoading}
            ownContracts={ownContractEntries.length > 0}
            category={effective.category}
            onPick={pickCategory}
          />
        </div>
      </header>

      <ProtocolFilters
        api={shownApi}
        networks={networkOptions}
        categories={categories}
        shown={filtered.length}
        total={protocols.length}
        loading={protocolsLoading}
        animate={filtered.length <= VT_CARD_LIMIT && protocols.length <= VT_CARD_LIMIT}
      />

      <section id="protocol-grid" aria-labelledby="protocol-grid-heading" className="scroll-mt-48 py-10 sm:py-14">
        <div className={CONTAINER}>
          <h2 id="protocol-grid-heading" className="sr-only">
            Protocols
          </h2>
          {protocolsResource.status === "error" && protocolsResource.error && !liveProtocols ? (
            <div
              role="status"
              className="mb-8 flex flex-col gap-3 border-[3px] border-dashed border-[#1A1A1A]/40 bg-[#FFF7CC] p-4 text-sm text-[#1A1A1A] dark:border-white/20 dark:bg-[#1A2841] dark:text-[#E2E8F0] sm:flex-row sm:items-center sm:justify-between"
            >
              <p>
                <strong>Registry view.</strong> {describePlatformError(protocolsResource.error)} These cards come from the
                registry compiled into <code className="font-code">@kletia/core</code>.
              </p>
              <Button size="sm" variant="secondary" onClick={protocolsResource.reload} className="shrink-0 self-start sm:self-auto">
                Retry
              </Button>
            </div>
          ) : null}

          {protocolsLoading ? (
            <GridSkeleton />
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-4 border-[3px] border-dashed border-[#1A1A1A]/40 px-6 py-14 text-center dark:border-white/20">
              <SearchX className="h-10 w-10 text-[#45464B] dark:text-[#A9B6C8]" aria-hidden="true" />
              <p className="font-display text-2xl font-bold tracking-[-0.02em]">No protocol matches these filters</p>
              <p className={cx("max-w-md text-sm", TEXT_MUTED)}>
                Try fewer networks, another capability or a shorter search. The registry grows as venues are added to{" "}
                <code className="font-code">@kletia/core</code>.
              </p>
              <Button variant="accent" onClick={() => api.clear({ animate: false })}>
                Clear filters
              </Button>
            </div>
          ) : (
            <ProtocolGrid protocols={filtered} platforms={platforms} nameOf={nameOf} />
          )}
        </div>
      </section>

      {ownContractEntries.length > 0 ? (
        <div className={cx(CONTAINER, "pb-14 sm:pb-16")}>
          <OwnContractsPanel entries={ownContractEntries} />
        </div>
      ) : null}

      <Section
        id="capabilities"
        deferPaint="760px"
        eyebrow="Execute · Quote · Discover"
        tone="paper"
        bordered
        reveal
        title="What each service means"
        intro="The planner picks the venue. An example sentence on a sign never promises that a specific venue will be used."
      >
        <Reveal as="ul" stagger className="grid gap-5 md:grid-cols-3">
          {LEGEND.map((item) => (
            <li key={item.title} data-reveal-item className={cx("flex flex-col gap-4 p-6", INK_BORDER, SHADOW_HARD, SURFACE)}>
              <p>
                <span className={cx("inline-block border-2 px-2.5 py-1.5 font-code text-xs font-extrabold uppercase leading-none tracking-[0.14em]", SERVICE_CHIP[item.service])}>
                  {item.title}
                </span>
              </p>
              <p className={cx("text-[15px] leading-relaxed", TEXT_MUTED)}>{item.body}</p>
            </li>
          ))}
        </Reveal>
      </Section>

      <section aria-labelledby="missing-venue-heading" className="py-16 sm:py-20">
        <div className={CONTAINER}>
          <div className={cx("flex flex-col gap-8 bg-[#111318] p-8 text-white dark:bg-[#060A14] sm:p-10 lg:flex-row lg:items-center lg:justify-between", INK_BORDER, "shadow-[8px_8px_0_#FFD60A] dark:shadow-[8px_8px_0_#FFD60A]")}>
            <div className="max-w-2xl">
              <p className="font-code text-xs font-bold uppercase tracking-[0.16em] text-[#FFD60A]">Open registry</p>
              <h2 id="missing-venue-heading" className="mt-3 font-display text-3xl font-bold tracking-[-0.03em] sm:text-4xl">
                Is a venue missing?
              </h2>
              <p className="mt-4 text-[15px] leading-relaxed text-white/80">
                Adapters live in <code className="font-code text-[#FFD60A]">apps/api/src/platform/engine/adapters</code>. Open an
                issue with the venue, the networks and the calls you need, or send a pull request.
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <ButtonLink to={`${GITHUB_URL}/issues`} variant="accent" size="lg">
                Open an issue
                <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
              </ButtonLink>
              <ButtonLink to={CONTRIBUTING_URL} variant="secondary" size="lg" className="!border-white">
                Contributing guide
                <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
              </ButtonLink>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
