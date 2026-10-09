import React from "react";

import { AnimatedNumber } from "../../site/motion/AnimatedNumber";
import { cssVars } from "../../site/motion/tokens";
import { StatusDot, type HealthState } from "../../site/ui/StatusDot";
import { CONTAINER, cx, LABEL } from "../../site/ui/styles";
import { formatMs } from "../networks/useHealthHistory";
import type { HomeData } from "./useHomeData";

interface CellProps {
  readonly label: string;
  readonly accent: string;
  readonly note: React.ReactNode;
  readonly children: React.ReactNode;
  readonly index: number;
}

function Cell({ label, accent, note, children, index }: CellProps) {
  return (
    <div
      className={cx(
        "relative flex min-w-0 flex-col gap-3 px-4 py-7 sm:px-6 lg:py-9",
        index % 2 === 1 && "border-l-[3px] border-white/15",
        index >= 2 && "border-t-[3px] border-white/15 lg:border-t-0",
        index === 2 && "lg:border-l-[3px]",
      )}
    >
      <span aria-hidden="true" className="kl-fill-x absolute left-0 top-0 h-[6px] w-full" style={{ backgroundColor: accent, ...cssVars({ "--kl-delay": `${150 + index * 90}ms` }) }} />
      <dt className={cx(LABEL, "order-2 text-[#FFD60A]")}>{label}</dt>
      <dd className="order-1 font-display text-[2.6rem] font-bold leading-none tracking-[-0.045em] sm:text-6xl">{children}</dd>
      <dd className="order-3 text-xs text-white/70">{note}</dd>
    </div>
  );
}

/** Full-bleed band of live, derivable figures (no invented metrics) directly under the hero. */
export function StatsBand({ data }: { readonly data: HomeData }) {
  const { health, networksOnline, protocolCount, intentKindCount, liveNetworks, liveProtocols } = data;
  const report = health.status === "success" ? health.data : undefined;
  const state: HealthState =
    health.status === "loading" && !health.data
      ? "loading"
      : report
        ? report.status === "ok"
          ? "ok"
          : report.status === "degraded"
            ? "degraded"
            : "down"
        : "unknown";
  const unreachable = health.status === "error" && !report;
  const loading = health.status === "loading" && !report;

  return (
    <section aria-labelledby="stats-band-heading" className="border-b-[3px] border-[#1A1A1A] bg-[#111318] text-white dark:border-[#4B5563] dark:bg-[#060A14]">
      <h2 id="stats-band-heading" className="sr-only">
        Kletia by the numbers
      </h2>
      <div className={CONTAINER}>
        <dl className="grid grid-cols-2 lg:grid-cols-4">
          <Cell
            index={0}
            label="API round trip"
            accent="#0052FF"
            note={
              <StatusDot
                state={state}
                pulse="none"
                label={loading ? "Checking" : report ? `API ${report.status}` : "Unreachable"}
                className="[&>span:last-child]:text-white"
              />
            }
          >
            <AnimatedNumber value={report ? health.latencyMs : null} format={formatMs} />
          </Cell>
          <Cell index={1} label="Networks online" accent="#14F195" note="RPC health from /v1/health">
            {networksOnline ? (
              <>
                <AnimatedNumber value={networksOnline.ok} />
                <span className="text-white/45">/{networksOnline.total}</span>
              </>
            ) : (
              "—"
            )}
          </Cell>
          <Cell index={2} label="Protocols in registry" accent="#9945FF" note={liveProtocols ? "From /v1/protocols" : "From @kletia/core"}>
            <AnimatedNumber value={protocolCount} />
          </Cell>
          <Cell index={3} label="Intent kinds" accent="#FFD60A" note={liveNetworks ? "Across /v1/networks" : "From the v1 support table"}>
            <AnimatedNumber value={intentKindCount} />
          </Cell>
        </dl>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t-2 border-dashed border-white/15 py-3 font-code text-[11px] text-white/70">
          {unreachable ? (
            <span className="border-2 border-[#FFD60A] bg-[#FFD60A] px-1.5 font-sans text-[10px] font-black uppercase tracking-[0.14em] text-[#1A1A1A]">
              Registry view
            </span>
          ) : null}
          <span>
            {unreachable
              ? "The API is unreachable from this browser; counts come from the registry compiled into @kletia/core."
              : "Live from /v1/health · /v1/networks · /v1/protocols, measured from your browser."}
          </span>
        </p>
      </div>
    </section>
  );
}
