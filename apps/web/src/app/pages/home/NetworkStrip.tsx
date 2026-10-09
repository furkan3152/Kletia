import type { ProtocolDescriptor } from "@kletia/core";
import { ArrowRight } from "lucide-react";
import type { CSSProperties } from "react";

import { Link } from "../../routes/Link";
import { LineBullet } from "../../site/art/LineBullet";
import type { Line } from "../../site/art";
import { countWordTitle, countWord, listNames, PRODUCTION, YARD } from "../../site/registryCopy";
import { Section } from "../../site/ui/Section";
import { cx, FOCUS_RING, TEXT_MUTED } from "../../site/ui/styles";

/** Venue kinds that are stations on a line. Bridges are the interchange; token programs, data and custom calls are not stops. */
const STATION_CATEGORIES = new Set(["dex", "dex-aggregator", "lending", "yield", "naming", "liquid-staking", "payments"]);

function stationsOn(line: Line, protocols: readonly ProtocolDescriptor[]): string[] {
  return protocols
    .filter(
      (protocol) =>
        Array.isArray(protocol.networks) &&
        protocol.networks.includes(line.key) &&
        protocol.crossChain !== true &&
        STATION_CATEGORIES.has(protocol.category),
    )
    .map((protocol) => protocol.name);
}

function interchangesOn(line: Line, protocols: readonly ProtocolDescriptor[]): number {
  return protocols.filter((protocol) => protocol.crossChain === true && Array.isArray(protocol.networks) && protocol.networks.includes(line.key)).length;
}

/** The coloured rail down the left edge of a row; SVM lines carry their ink sleepers. */
function Rail({ line }: { readonly line: Line }) {
  const style: CSSProperties = {
    backgroundColor: line.color,
    backgroundImage: line.gauge === "svm" ? "repeating-linear-gradient(180deg, #1A1A1A 0 4px, transparent 4px 9px)" : undefined,
    backgroundSize: line.gauge === "svm" ? "3px 100%" : undefined,
    backgroundPosition: "center",
    backgroundRepeat: "no-repeat",
  };
  return <span aria-hidden="true" className="absolute inset-y-0 left-0 w-3 border-r-[3px] border-[#1A1A1A] dark:border-[#4B5563]" style={style} />;
}

export interface NetworkStripProps {
  /** Live `/v1/protocols` when available, else the registry. */
  readonly protocols: readonly ProtocolDescriptor[];
}

/** The line index: every production network with the venues it calls at, then the test yard. */
export function NetworkStrip({ protocols }: NetworkStripProps) {
  return (
    <Section
      id="lines"
      platform={2}
      eyebrow="Networks"
      reveal
      title={`${countWordTitle(PRODUCTION.length)} production lines and ${countWord(YARD.length === 0 ? 0 : 1)} test yard.`}
      intro={
        <>
          {listNames(PRODUCTION.map((line) => line.name))} carry real funds.{" "}
          {YARD.length
            ? `${listNames(YARD.map((line) => line.name))} run in a separate yard, so a test token can never pay for a mainnet leg.`
            : null}
        </>
      }
      actions={
        <Link
          to="/networks"
          className={cx(
            "group inline-flex min-h-11 items-center gap-2 text-xs font-black uppercase tracking-[0.14em] text-[#0047E0] underline decoration-2 underline-offset-4 dark:text-[#7EA6FF]",
            FOCUS_RING,
          )}
        >
          Live status for every network
          <ArrowRight className="h-4 w-4 transition-transform duration-150 group-hover:translate-x-1 motion-reduce:transition-none" aria-hidden="true" />
        </Link>
      }
    >
      <ol
        aria-label="Production lines"
        className="border-[3px] border-[#1A1A1A] bg-[#FBFAF7] shadow-hard-md dark:border-[#4B5563] dark:bg-[#131E32]"
      >
        {PRODUCTION.map((line) => {
          const stations = stationsOn(line, protocols);
          const interchanges = interchangesOn(line, protocols);
          return (
            <li
              key={line.key}
              className="relative grid grid-cols-[3.6rem_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5 border-b-2 border-[#1A1A1A]/15 py-4 pl-7 pr-4 dark:border-white/10 md:pl-9 md:pr-6 lg:grid-cols-[3.6rem_minmax(0,11rem)_minmax(0,12rem)_minmax(0,1fr)] lg:gap-x-5"
            >
              <Rail line={line} />
              <LineBullet line={line} size="lg" decorative />
              <h3 className="font-display text-lg font-bold leading-tight tracking-[-0.02em] lg:text-[1.2rem]">{line.name}</h3>
              <p
                className={cx("col-start-2 font-code text-[11.5px] [overflow-wrap:anywhere] lg:col-start-auto", TEXT_MUTED)}
                title={line.id}
              >
                {line.id.length > 24 ? `${line.id.slice(0, 22)}…` : line.id}
              </p>
              <p className={cx("col-span-2 text-sm leading-relaxed lg:col-span-1", TEXT_MUTED)}>
                <span className="mr-2 font-code text-[10px] font-bold uppercase tracking-[0.16em]">Calls at</span>
                {stations.length ? stations.join(" · ") : "No stations yet"}
                {interchanges ? (
                  <span className="mt-1 block">
                    <span className="mr-2 font-code text-[10px] font-bold uppercase tracking-[0.16em]">Change for</span>
                    <span className="font-semibold text-[#1A1A1A] dark:text-[#F1F5F9]">
                      {interchanges} cross-network {interchanges === 1 ? "venue" : "venues"}
                    </span>{" "}
                    at the interchange
                  </span>
                ) : null}
              </p>
            </li>
          );
        })}
        {YARD.length ? (
          <li className="flex flex-wrap items-center gap-x-6 gap-y-3 bg-[repeating-linear-gradient(-45deg,transparent_0_9px,rgba(26,26,26,0.07)_9px_18px)] py-4 pl-7 pr-4 dark:bg-[repeating-linear-gradient(-45deg,transparent_0_9px,rgba(255,255,255,0.06)_9px_18px)] md:pl-9">
            <span className="font-code text-[10px] font-bold uppercase tracking-[0.16em] text-[#45464B] dark:text-[#A9B6C8]">Test yard</span>
            {YARD.map((line) => (
              <span key={line.key} className="inline-flex items-center gap-2 font-display text-[15px] font-semibold">
                <LineBullet line={line} decorative className="kla-bullet--yard" />
                {line.name}
              </span>
            ))}
            <span className={cx("font-code text-xs", TEXT_MUTED)}>separate capital, no through service</span>
          </li>
        ) : null}
      </ol>
    </Section>
  );
}
