import { ArrowRight, ArrowUpRight, SearchX } from "lucide-react";
import { useMemo, useState } from "react";

import { describePlatformError } from "../../../shared/platform/kletiaClient";
import { fetchNetworks, fetchProtocols } from "../../../shared/platform/platformApi";
import { registryNetworks, registryProtocols, sortNetworks } from "../../../shared/platform/registry";
import { useApiResource } from "../../../shared/platform/useApiResource";
import { Link } from "../../routes/Link";
import { Reveal } from "../../site/motion/Reveal";
import { useReducedMotion } from "../../site/motion/useReducedMotion";
import { categoryIcon, categoryWord, type IconName } from "../../site/art";
import { Icon } from "../../site/art/Icon";
import { isOwnContractEntry, protocolNoun, realProtocols } from "../../site/protocolCount";
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

interface DirectoryRow {
  readonly word: string;
  readonly icon: IconName;
  readonly count: number;
}

/** Directory rows: one per sign word (two registry categories can share one, e.g. both swap kinds), largest first. */
function directoryRows(protocols: readonly ProtocolEntry[]): DirectoryRow[] {
  const rows = new Map<string, { word: string; icon: IconName; count: number }>();
  for (const protocol of protocols) {
    const category = protocol.category || "other";
    const word = categoryWord(category);
    const row = rows.get(word) ?? { word, icon: categoryIcon(category), count: 0 };
    row.count += 1;
    rows.set(word, row);
  }
  return [...rows.values()].sort((a, b) => b.count - a.count || a.word.localeCompare(b.word, "en"));
}

/**
 * The station directory hung in the hall: every kind of venue on this page
 * and how many platforms serve it, with the page totals under it. Printed
 * signage: ink board, paper letters, yellow header, in both themes. While
 * the live list loads it is printed from the registry, so the sign keeps its
 * size and nothing below it moves.
 */
function DirectorySign({ protocols, ownContracts }: { readonly protocols: readonly ProtocolEntry[]; readonly ownContracts: boolean }) {
  const rows = useMemo(() => directoryRows(protocols), [protocols]);
  const totals = useMemo(() => protocolTotals(protocols), [protocols]);
  return (
    <aside
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
      <ul className="px-5 py-2">
        {rows.map((row) => (
          <li key={row.word} className="flex items-center gap-4 border-b border-dashed border-[#F4F1EA]/25 py-2.5 last:border-b-0">
            <Icon name={row.icon} size={26} />
            <span className="font-display text-lg font-bold tracking-[-0.01em]">{row.word}</span>
            <span aria-hidden="true" className="h-0 min-w-6 flex-1 border-b-2 border-dotted border-[#F4F1EA]/40" />
            <span className="font-code text-sm font-bold tabular-nums">
              {row.count}
              <span className="sr-only"> {row.count === 1 ? "platform" : "platforms"}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="border-t-[3px] border-[#F4F1EA]/20 px-5 py-3 font-code text-[11px] font-semibold uppercase leading-relaxed tracking-[0.12em] text-[#F4F1EA]/85">
        {totals.execute} built by Kletia · {totals.crossChain} cross-network · {totals.networks} networks
        {ownContracts ? <span className="block text-[#FFD60A]">Custom contracts belong to developer integrations</span> : null}
      </p>
    </aside>
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
}

/** The card grid. Cards present on its first render rise in (first 8 staggered); later cards glide via View Transitions. */
function ProtocolGrid({ protocols, platforms }: GridProps) {
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
 * Bring your own contract, shown apart from the directory: the registry's
 * "custom" entries are not protocols but the doors your own registrations use.
 */
function OwnContractsPanel({ entries }: { readonly entries: readonly ProtocolEntry[] }) {
  return (
    <aside
      aria-labelledby="own-contracts-heading"
      className={cx("mt-10 grid gap-6 bg-[#FFF7CC] p-6 text-[#1A1A1A] dark:bg-[#1A2841] dark:text-[#E2E8F0] sm:p-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center", INK_BORDER, SHADOW_HARD)}
    >
      <div className="min-w-0">
        <p className={cx(LABEL, "flex items-center gap-2 font-code")}>
          <Icon name="contract" size={22} />
          Developer integrations
        </p>
        <h3 id="own-contracts-heading" className="mt-3 font-display text-2xl font-bold tracking-[-0.02em] sm:text-3xl">
          Your project, your contracts
        </h3>
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed">
          Register your own EVM contract or Solana Action with your project's API key and use it in your own integration.
          Your contracts stay scoped to your project and are not offered for signing on Kletia's main site.
          Kletia pins the code and simulates calls; it does not audit your contract.
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
      <ButtonLink to="/developers#contracts" variant="primary" className="self-start lg:self-center">
        Register a contract
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </ButtonLink>
    </aside>
  );
}

/** /protocols: every venue Kletia can plan with, live from GET /v1/protocols with a registry fallback. */
export default function ProtocolsPage() {
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
    const categorySet = new Set<string>();
    for (const protocol of protocols) {
      for (const key of networksOf(protocol)) keys.add(key);
      if (protocol.category) categorySet.add(protocol.category);
    }
    const rank = (key: string) => {
      const index = networkOrder.indexOf(key);
      return index === -1 ? 999 : index;
    };
    const ordered = [...keys].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    return {
      networkOptions: ordered.map(networkLabel),
      categories: [...categorySet].sort(),
      available: { networks: keys, categories: categorySet },
    };
  }, [protocols, networkOrder]);

  const api = useProtocolFilters(protocolsLoading ? null : available);
  const effective = sanitizeFilters(api.filters, available);
  const shownApi = useMemo(() => ({ ...api, filters: effective }), [api, effective]);
  const filtered = useMemo(() => applyFilters(protocols, effective), [protocols, effective]);
  const totals = useMemo(() => protocolTotals(protocols), [protocols]);
  // Platform numbers follow the whole directory in the chosen order, so filtering never renumbers a sign.
  const platforms = useMemo(
    () =>
      new Map(
        applyFilters(protocols, { ...EMPTY_FILTERS, sort: effective.sort }).map((protocol, index) => [protocol.id, Math.min(99, index + 1)]),
      ),
    [protocols, effective.sort],
  );
  const live = liveProtocols;

  return (
    <>
      <header className="kla-grain border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563]">
        <div className={cx(CONTAINER, "grid gap-12 py-14 sm:py-20 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:items-start lg:gap-16")}>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-4">
              <p className={cx(LABEL, "font-code text-[#0047E0] dark:text-[#7EA6FF]")}>Protocol directory</p>
              <SourceBadge live={live} loading={protocolsLoading} />
            </div>
            <h1 className="mt-6 max-w-4xl text-balance font-display text-[clamp(2.5rem,7vw,4.5rem)] font-bold leading-[1] tracking-[-0.045em]">
              {/* While the live list loads the count comes from the registry, so the heading never re-wraps. */}
              {protocolNoun(totals.protocols)} Kletia can route through.
            </h1>
            <p className={cx("mt-6 max-w-2xl text-lg leading-relaxed", TEXT_MUTED)}>
              <strong className="text-[#1A1A1A] dark:text-white">Execute</strong> means Kletia builds the transaction.{" "}
              <strong className="text-[#1A1A1A] dark:text-white">Quote</strong> means it prices a route that settles somewhere
              else. <strong className="text-[#1A1A1A] dark:text-white">Discover</strong> means it only reads data. Every sign lists
              the networks the venue calls at.
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
          <DirectorySign protocols={protocols} ownContracts={ownContractEntries.length > 0} />
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

      <section aria-labelledby="protocol-grid-heading" className="scroll-mt-48 py-10 sm:py-14">
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
            <ProtocolGrid protocols={filtered} platforms={platforms} />
          )}
          {ownContractEntries.length > 0 ? <OwnContractsPanel entries={ownContractEntries} /> : null}
        </div>
      </section>

      <Section
        id="capabilities"
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
              <p className="font-code text-[11px] font-bold uppercase tracking-[0.16em] text-[#FFD60A]">Open registry</p>
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
