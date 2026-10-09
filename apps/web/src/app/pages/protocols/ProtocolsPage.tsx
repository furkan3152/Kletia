import { ArrowRight, ArrowUpRight, Eye, PenLine, Radar, SearchX } from "lucide-react";
import React, { useMemo, useState } from "react";

import { describePlatformError } from "../../../shared/platform/kletiaClient";
import { fetchNetworks, fetchProtocols } from "../../../shared/platform/platformApi";
import { registryNetworks, registryProtocols, sortNetworks } from "../../../shared/platform/registry";
import { useApiResource } from "../../../shared/platform/useApiResource";
import { Link } from "../../routes/Link";
import { AnimatedNumber } from "../../site/motion/AnimatedNumber";
import { Reveal } from "../../site/motion/Reveal";
import { useReducedMotion } from "../../site/motion/useReducedMotion";
import { CONTRIBUTING_URL } from "../../site/siteLinks";
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
import { applyFilters, sanitizeFilters, useProtocolFilters } from "./useProtocolFilters";

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

function HeaderStat({ label, value, accent }: { readonly label: string; readonly value: number | null; readonly accent: string }) {
  return (
    <div className="flex flex-col gap-2 border-l-[6px] pl-3 sm:pl-4" style={{ borderColor: accent }}>
      <dt className={cx(LABEL, "order-2 text-[#45464B] dark:text-[#A9B6C8]")}>{label}</dt>
      <dd className="order-1 font-display text-4xl font-bold leading-none tracking-[-0.04em] sm:text-5xl">
        <AnimatedNumber value={value} />
      </dd>
    </div>
  );
}

function GridSkeleton() {
  return (
    <SkeletonGroup label="Loading protocols" className="grid gap-5 md:grid-cols-2 xl:grid-cols-3" wrapperClassName="mt-8">
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
}

/** The card grid. Cards present on its first render rise in (first 8 staggered); later cards glide via View Transitions. */
function ProtocolGrid({ protocols }: GridProps) {
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
          transitionName={transitions ? names[index] : undefined}
          introIndex={reduced ? null : (introIds.get(protocol.id) ?? null)}
        />
      ))}
    </ul>
  );
}

const LEGEND: readonly { readonly title: string; readonly body: string; readonly icon: React.ReactNode; readonly stripe: string }[] = [
  {
    title: "Execute",
    body: `${CAPABILITY_HELP.execute} Your wallet signs each one; Kletia never holds keys or funds.`,
    icon: <PenLine className="h-5 w-5" aria-hidden="true" />,
    stripe: "#0052FF",
  },
  {
    title: "Quote",
    body: `${CAPABILITY_HELP.quote} Quotes feed the planner's routes, fees and output floors.`,
    icon: <Radar className="h-5 w-5" aria-hidden="true" />,
    stripe: "#FFD60A",
  },
  {
    title: "Discover",
    body: `${CAPABILITY_HELP.discover} A registry entry is never a promise of execution.`,
    icon: <Eye className="h-5 w-5" aria-hidden="true" />,
    stripe: "#94A3B8",
  },
];

/** /protocols: every venue Kletia can plan with, live from GET /v1/protocols with a registry fallback. */
export default function ProtocolsPage() {
  const protocolsResource = useApiResource("protocols", fetchProtocols);
  const networksResource = useApiResource("networks", fetchNetworks);
  const api = useProtocolFilters();

  const liveProtocols = (protocolsResource.data?.length ?? 0) > 0;
  const protocolsLoading = protocolsResource.status === "loading" && !liveProtocols;
  const protocols = useMemo<readonly ProtocolEntry[]>(
    () => (liveProtocols ? (protocolsResource.data as readonly ProtocolEntry[]) : registryProtocols()),
    [liveProtocols, protocolsResource.data],
  );
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

  const effective = sanitizeFilters(api.filters, available);
  const filtered = useMemo(() => applyFilters(protocols, effective), [protocols, effective]);
  const totals = useMemo(() => protocolTotals(protocols), [protocols]);
  const live = liveProtocols;

  return (
    <>
      <header className="kl-grid-backdrop border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563]">
        <div className={cx(CONTAINER, "py-14 sm:py-20")}>
          <div className="flex flex-wrap items-center gap-3">
            <p className={cx(LABEL, "text-[#0052FF] dark:text-[#7EA6FF]")}>Protocol directory</p>
            <SourceBadge live={live} loading={protocolsLoading} />
          </div>
          <h1 className="mt-4 max-w-4xl text-balance font-display text-[clamp(2.5rem,7vw,4.75rem)] font-bold leading-[0.95] tracking-[-0.045em]">
            Every venue, <span className="bg-[#FFD60A] px-1.5 text-[#1A1A1A]">one intent.</span>
          </h1>
          <p className={cx("mt-6 max-w-2xl text-lg leading-relaxed", TEXT_MUTED)}>
            Kletia plans with these protocols: it <strong className="text-[#1A1A1A] dark:text-white">executes</strong>{" "}
            wallet-ready transactions, <strong className="text-[#1A1A1A] dark:text-white">quotes</strong> live routes
            that settle elsewhere, or <strong className="text-[#1A1A1A] dark:text-white">discovers</strong> read-only
            market data. Pick one and try an example intent in Studio.
          </p>
          <dl className="mt-10 grid max-w-3xl grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-4">
            <HeaderStat label="Protocols" value={protocolsLoading ? null : totals.protocols} accent="#0052FF" />
            <HeaderStat label="Execute-capable" value={protocolsLoading ? null : totals.execute} accent="#FFD60A" />
            <HeaderStat label="Cross-chain" value={protocolsLoading ? null : totals.crossChain} accent="#9945FF" />
            <HeaderStat label="Networks covered" value={protocolsLoading ? null : totals.networks} accent="#14F195" />
          </dl>
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
      </header>

      <ProtocolFilters
        api={api}
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
            <ProtocolGrid protocols={filtered} />
          )}
        </div>
      </section>

      <Section
        id="capabilities"
        tone="paper"
        bordered
        reveal
        eyebrow="Execute · Quote · Discover"
        title="What each capability means"
        intro="A capability describes what Kletia does with a venue today. Planning always picks the venue; an example intent never promises a specific one."
      >
        <Reveal as="ul" stagger className="grid gap-5 md:grid-cols-3">
          {LEGEND.map((item) => (
            <li key={item.title} data-reveal-item className={cx("flex flex-col", INK_BORDER, SHADOW_HARD, SURFACE)}>
              <span aria-hidden="true" className="block h-[6px] border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563]" style={{ backgroundColor: item.stripe }} />
              <div className="flex flex-1 flex-col gap-3 p-6">
                <p className="flex items-center gap-2 font-display text-2xl font-bold tracking-[-0.02em]">
                  {item.icon}
                  {item.title}
                </p>
                <p className={cx("text-[15px] leading-relaxed", TEXT_MUTED)}>{item.body}</p>
              </div>
            </li>
          ))}
        </Reveal>
      </Section>

      <section aria-labelledby="missing-venue-heading" className="py-16 sm:py-20">
        <div className={CONTAINER}>
          <div className={cx("flex flex-col gap-8 bg-[#111318] p-8 text-white dark:bg-[#060A14] sm:p-10 lg:flex-row lg:items-center lg:justify-between", INK_BORDER, "shadow-[8px_8px_0_#FFD60A] dark:shadow-[8px_8px_0_#FFD60A]")}>
            <div className="max-w-2xl">
              <p className={cx(LABEL, "text-[#FFD60A]")}>Open registry</p>
              <h2 id="missing-venue-heading" className="mt-3 font-display text-3xl font-bold tracking-[-0.03em] sm:text-4xl">
                Missing a venue?
              </h2>
              <p className="mt-4 text-[15px] leading-relaxed text-white/80">
                Kletia&apos;s registry is open source; protocols are added in <code className="font-code text-[#FFD60A]">@kletia/core</code>{" "}
                with pinned contract addresses and an execution adapter in the API.
              </p>
            </div>
            <div className="flex flex-col gap-3 sm:flex-row">
              <ButtonLink to={CONTRIBUTING_URL} variant="accent" size="lg">
                Contribute a venue
                <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
              </ButtonLink>
              <ButtonLink to="/developers" variant="secondary" size="lg" className="!border-white">
                Developer docs
              </ButtonLink>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
