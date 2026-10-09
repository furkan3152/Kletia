import { CHAINS, isNetworkKey, YIELD_VENUES } from "@kletia/core";
import type { LendingVenueMetrics, VenuesResponse } from "@kletia/sdk";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";

import { sdkSignal } from "../../../shared/platform/kletiaClient";
import { useApiResource } from "../../../shared/platform/useApiResource";
import { networkColor, networkName, protocolName } from "../../site/intent/format";
import { Badge } from "../../site/ui/Badge";
import { CodeBlock } from "../../site/ui/CodeBlock";
import { CopyButton } from "../../site/ui/CopyButton";
import { SelectField } from "../../site/ui/Field";
import { Skeleton, SkeletonGroup } from "../../site/ui/Skeleton";
import { cx, FOCUS_RING, HARD_SHADOW, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../site/ui/styles";

type SortKey = "apy" | "supplied" | "exit" | "utilization";

const SORTS: readonly { value: SortKey; label: string }[] = [
  { value: "apy", label: "Supply APY" },
  { value: "supplied", label: "Supplied (TVL)" },
  { value: "exit", label: "Exit liquidity" },
  { value: "utilization", label: "Utilization" },
];

const VENUE_PREVIEW = 10;

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });

interface VenueRow {
  readonly venue: string;
  readonly name: string;
  readonly protocol: string;
  readonly network: string;
  readonly asset: string;
  readonly metrics: LendingVenueMetrics | null;
}

function percent(value: number | null | undefined, digits = 2): string {
  return typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : "—";
}

function amount(value: LendingVenueMetrics["totalSupplied"]): string {
  if (!value) return "—";
  const number = Number(value.formatted);
  return `${Number.isFinite(number) ? compact.format(number) : value.formatted} ${value.symbol}`;
}

function numeric(value: LendingVenueMetrics["totalSupplied"]): number {
  const number = value ? Number(value.formatted) : Number.NaN;
  return Number.isFinite(number) ? number : -1;
}

function sortValue(row: VenueRow, key: SortKey): number {
  const metrics = row.metrics;
  if (!metrics) return -1;
  switch (key) {
    case "apy":
      return metrics.supplyApy ?? -1;
    case "supplied":
      return numeric(metrics.totalSupplied);
    case "exit":
      return numeric(metrics.exitLiquidity);
    case "utilization":
      return metrics.utilization ?? -1;
  }
}

/** Registry venues for the offline view (EVM only, as GET /v1/venues). */
function registryRows(): VenueRow[] {
  return YIELD_VENUES.filter((venue) => isNetworkKey(venue.network) && CHAINS[venue.network].vm === "evm").map((venue) => ({
    venue: venue.id,
    name: venue.name,
    protocol: venue.protocol,
    network: venue.network,
    asset: venue.asset,
    metrics: null,
  }));
}

function UtilizationBar({ value }: { value: number | null }) {
  if (value === null || !Number.isFinite(value)) return <span className={TEXT_MUTED}>—</span>;
  const width = Math.max(0, Math.min(100, value * 100));
  return (
    <span className="flex min-w-[6rem] items-center gap-2">
      <span className="h-2 w-14 shrink-0 border-2 border-[#1A1A1A] bg-white dark:border-[#4B5563] dark:bg-[#0B1120]" aria-hidden="true">
        <span className={cx("block h-full", width > 92 ? "bg-[#FF5A5F]" : width > 80 ? "bg-[#FFD60A]" : "bg-[#14F195]")} style={{ width: `${width}%` }} />
      </span>
      <span className="font-code text-xs">{percent(value, 1)}</span>
    </span>
  );
}

/** EVM lending venues from GET /v1/venues: supply APY, size and exit liquidity, with the venue id to plan against. */
export function VenuesPanel() {
  const venues = useApiResource<VenuesResponse>("venues", (client, signal) =>
    client.request<VenuesResponse>("GET", "/venues", undefined, { signal: sdkSignal(signal) }),
  );
  const [network, setNetwork] = useState("all");
  const [asset, setAsset] = useState("all");
  const [sort, setSort] = useState<SortKey>("apy");
  const [picked, setPicked] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const live = venues.data?.venues;
  const rows: VenueRow[] = useMemo(
    () =>
      live && live.length > 0
        ? live.map((metrics) => ({ venue: metrics.venue, name: metrics.name, protocol: metrics.protocol, network: metrics.network, asset: metrics.asset, metrics }))
        : registryRows(),
    [live],
  );
  const offline = !(live && live.length > 0);
  const networks = [...new Set(rows.map((row) => row.network))];
  const assets = [...new Set(rows.filter((row) => network === "all" || row.network === network).map((row) => row.asset))].sort();
  const visible = rows
    .filter((row) => (network === "all" || row.network === network) && (asset === "all" || row.asset === asset))
    .sort((a, b) => sortValue(b, sort) - sortValue(a, sort));
  const shownRows = showAll ? visible : visible.slice(0, VENUE_PREVIEW);
  // Default to a venue that can take a deposit and pay it back now, not merely the highest rate.
  const healthy = visible.find(
    (row) => row.metrics && row.metrics.warnings.length === 0 && row.metrics.exitLiquidity && Number(row.metrics.exitLiquidity.formatted) > 0,
  );
  const selected = rows.find((row) => row.venue === picked) ?? healthy ?? visible[0] ?? null;
  const unavailable = venues.data?.unavailable ?? [];
  const observed = live?.[0]?.observedAt;

  const snippet = selected
    ? `// Plan a deposit into ${selected.name} on ${networkName(selected.network)}
const intent = await kletia.intents.create({
  actions: [{
    kind: "deposit",
    network: "${selected.network}",
    from: "${selected.asset}",
    amount: "100",
    params: { venue: "${selected.venue}" },
  }],
  accounts: [formatAccountId("${selected.network}", address)],
});
// The planner re-checks the venue on-chain at plan and prepare (422 VENUE_UNVERIFIED otherwise).`
    : "";

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className={cx("flex min-w-0 flex-col gap-4 p-4 sm:p-5", INK_BORDER, HARD_SHADOW, SURFACE)}>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-bold" aria-live="polite">
          <p className="flex flex-wrap items-center gap-2">
            <Badge tone={offline ? (venues.status === "loading" ? "neutral" : "yellow") : "green"}>
              {offline ? (venues.status === "loading" ? "Loading" : "Registry only") : "Live"}
            </Badge>
            {offline
              ? venues.status === "loading"
                ? "Reading /v1/venues (on-chain reads, cached 60 s)…"
                : "The API is unreachable: venue ids from the bundled registry, without rates."
              : `GET /v1/venues · ${rows.length} venues · read ${observed ? new Date(observed).toLocaleTimeString("en-US", { hour12: false }) : "just now"} · advisory`}
          </p>
          <button type="button" onClick={venues.reload} className={cx("inline-flex min-h-9 items-center gap-1 underline decoration-2 underline-offset-2", FOCUS_RING)}>
            <RefreshCw className="h-3 w-3" aria-hidden="true" />
            Refresh
          </button>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <SelectField
            label="Network"
            value={network}
            onChange={(event) => {
              setNetwork(event.target.value);
              setAsset("all");
            }}
            options={[{ value: "all", label: "All networks" }, ...networks.map((item) => ({ value: item, label: networkName(item) }))]}
          />
          <SelectField
            label="Asset"
            value={asset}
            onChange={(event) => setAsset(event.target.value)}
            options={[{ value: "all", label: "All assets" }, ...assets.map((item) => ({ value: item, label: item }))]}
          />
          <SelectField label="Sort by" value={sort} onChange={(event) => setSort(event.target.value as SortKey)} options={SORTS} />
        </div>
        {asset === "all" && (sort === "supplied" || sort === "exit") ? (
          <p className={cx("text-xs", TEXT_MUTED)}>Sizes are in each venue&apos;s own asset: pick one asset to compare them.</p>
        ) : null}

        {venues.status === "loading" && offline ? (
          <SkeletonGroup label="Loading venues" className="flex flex-col gap-2">
            {[0, 1, 2, 3, 4].map((index) => (
              <Skeleton key={index} surface="card" className="h-11" />
            ))}
          </SkeletonGroup>
        ) : (
          <>
          <ul className="flex flex-col gap-2 md:hidden" aria-label="Lending venues">
            {shownRows.map((row) => {
              const metrics = row.metrics;
              const isPicked = selected?.venue === row.venue;
              return (
                <li key={row.venue}>
                  <button
                    type="button"
                    onClick={() => setPicked(row.venue)}
                    aria-pressed={isPicked}
                    className={cx(
                      "flex w-full min-w-0 flex-col gap-2 border-2 border-[#1A1A1A] p-3 text-left dark:border-[#4B5563]",
                      isPicked ? "bg-[#FFF7CC] dark:bg-[#22345A]" : "bg-white dark:bg-[#0B1120]",
                      FOCUS_RING,
                    )}
                  >
                    <span className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                      <span className="font-bold">{row.name}</span>
                      <span className="font-code text-sm font-bold">{percent(metrics?.supplyApy)}</span>
                    </span>
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge dot={networkColor(row.network)}>{networkName(row.network)}</Badge>
                      <span className={cx("break-all font-code text-[11px]", TEXT_MUTED)}>{row.venue}</span>
                    </span>
                    <span className="grid grid-cols-3 gap-2 text-[11px]">
                      <span>
                        <span className={cx("block", TEXT_MUTED)}>Supplied</span>
                        <span className="font-code">{amount(metrics?.totalSupplied ?? null)}</span>
                      </span>
                      <span>
                        <span className={cx("block", TEXT_MUTED)}>Exit</span>
                        <span className="font-code">{amount(metrics?.exitLiquidity ?? null)}</span>
                      </span>
                      <span>
                        <span className={cx("block", TEXT_MUTED)}>Utilization</span>
                        <span className="font-code">{percent(metrics?.utilization ?? null, 1)}</span>
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="hidden md:block">
            <table className="w-full border-collapse text-left text-sm">
              <caption className="sr-only">Lending venues, sorted by {SORTS.find((item) => item.value === sort)?.label}</caption>
              <thead>
                <tr className={cx(LABEL, "!text-[10px]", TEXT_MUTED)}>
                  <th scope="col" className="py-2 pr-3">Venue</th>
                  <th scope="col" className="py-2 pr-3">Network</th>
                  <th scope="col" className="py-2 pr-3 text-right">Supply APY</th>
                  <th scope="col" className="py-2 pr-3 text-right">Supplied</th>
                  <th scope="col" className="py-2 pr-3 text-right">Exit liquidity</th>
                  <th scope="col" className="py-2">Utilization</th>
                </tr>
              </thead>
              <tbody>
                {shownRows.map((row) => {
                  const metrics = row.metrics;
                  const isPicked = selected?.venue === row.venue;
                  return (
                    <tr key={row.venue} className={cx("border-t-2 border-[#1A1A1A]/10 align-top dark:border-white/10", isPicked && "bg-[#FFF7CC] dark:bg-[#22345A]")}>
                      <td className="py-2.5 pr-3">
                        <button
                          type="button"
                          onClick={() => setPicked(row.venue)}
                          aria-pressed={isPicked}
                          className={cx("flex flex-col items-start text-left", FOCUS_RING)}
                        >
                          <span className="font-bold">{row.name}</span>
                          <span className={cx("font-code text-[11px]", TEXT_MUTED)}>{row.venue}</span>
                        </button>
                        {metrics?.warnings.length ? (
                          <span className="mt-1 flex items-start gap-1 text-[11px] text-[#8A6100] dark:text-[#FFD60A]">
                            <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                            {metrics.warnings[0]}
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2.5 pr-3">
                        <Badge dot={networkColor(row.network)}>{networkName(row.network)}</Badge>
                        <span className={cx("mt-1 block text-[11px]", TEXT_MUTED)}>{protocolName(row.protocol)}</span>
                      </td>
                      <td className="py-2.5 pr-3 text-right font-code font-bold">
                        {percent(metrics?.supplyApy)}
                        {metrics?.apySource === "share-price" ? (
                          <span className={cx("block text-[10px] font-normal", TEXT_MUTED)}>
                            realised, {Math.round((metrics.apyWindowSeconds ?? 0) / 86400) || "<1"} d
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2.5 pr-3 text-right font-code">{amount(metrics?.totalSupplied ?? null)}</td>
                      <td className="py-2.5 pr-3 text-right font-code">{amount(metrics?.exitLiquidity ?? null)}</td>
                      <td className="py-2.5">
                        <UtilizationBar value={metrics?.utilization ?? null} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {visible.length > shownRows.length || showAll ? (
            <button
              type="button"
              onClick={() => setShowAll((value) => !value)}
              aria-expanded={showAll}
              className={cx("inline-flex min-h-9 w-fit items-center text-xs font-bold underline decoration-2 underline-offset-2", FOCUS_RING)}
            >
              {showAll ? `Show the top ${VENUE_PREVIEW}` : `Show all ${visible.length} venues`}
            </button>
          ) : null}
          </>
        )}
        {unavailable.length > 0 ? (
          <details className="kl-details text-xs">
            <summary className={cx("min-h-9 cursor-pointer font-bold", FOCUS_RING)}>{unavailable.length} venue(s) could not be read right now</summary>
            <ul className="mt-2 flex flex-col gap-1">
              {unavailable.map((item) => (
                <li key={item.venue} className="font-code">
                  {item.venue}: {item.code} · {item.message}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        <p className={cx("text-xs leading-relaxed", TEXT_MUTED)}>
          Rates and sizes are advisory and cached for 60 seconds; plan and prepare re-read what they gate on. Exit liquidity is
          what can leave the venue now. Solana venues (Jupiter Lend, Kamino) report their rate in the plan&apos;s step warnings.
        </p>
      </div>
      {selected ? (
        <div className="flex min-w-0 flex-col gap-2">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-bold">Use a venue:</span> pass its id as <code className="font-code">params.venue</code>
            <CopyButton text={selected.venue} label={`Copy venue id ${selected.venue}`} appearance="light" notify="toast" />
          </p>
          <CodeBlock code={snippet} language="ts" label="Deposit into a chosen venue" filename="deposit.ts" />
        </div>
      ) : null}
    </div>
  );
}
