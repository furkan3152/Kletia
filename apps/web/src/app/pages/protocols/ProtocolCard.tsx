import { ArrowRight, ArrowUpRight } from "lucide-react";
import type { CSSProperties } from "react";

import { Link } from "../../routes/Link";
import { lineFor } from "../../site/art";
import { PlatformSign } from "../../site/art/PlatformSign";
import { cx } from "../../site/ui/styles";
import { protocolExample, studioHref } from "./protocolExamples";
import { capabilitiesOf, networkLabel, networksOf, safeWebsite, type ProtocolEntry } from "./protocolStats";

export interface ProtocolCardProps {
  readonly protocol: ProtocolEntry;
  /** Platform number printed on the sign (the venue's place in the full directory, 1 to 99). */
  readonly platform: number;
  /**
   * `view-transition-name`, unique on the page. Applied only while a filter
   * View Transition runs (`html[data-kl-vt=filter]`), so route transitions
   * still move the page as one piece.
   */
  readonly transitionName?: string;
  /** Rise in on first render with this stagger index (null = no entrance). */
  readonly introIndex?: number | null;
}

const CHIP = "border-2 px-2 py-1 font-code text-[10px] font-extrabold uppercase leading-none tracking-[0.14em]";

/**
 * Directory entry for one venue, printed as a platform sign: category
 * pictogram, the networks it calls at, what Kletia does there and an example
 * intent that opens in Studio. Every fact comes from the protocol entry (live
 * /v1/protocols, else the registry).
 */
export function ProtocolCard({ protocol, platform, transitionName, introIndex = null }: ProtocolCardProps) {
  const capabilities = capabilitiesOf(protocol);
  const example = capabilities.includes("execute") ? protocolExample(protocol.id) : null;
  const discoverOnly = capabilities.length > 0 && capabilities.every((capability) => capability === "discover");
  const website = safeWebsite(protocol.website);
  // Networks the live API reports that this bundle's registry does not know yet: named in text, never dropped.
  const unknownNetworks = networksOf(protocol).filter((key) => !lineFor(key)).map((key) => networkLabel(key).name);

  const style: CSSProperties = {
    ...(transitionName ? ({ "--kl-vt-name": transitionName } as CSSProperties) : null),
    ...(introIndex !== null ? ({ "--kl-i": introIndex } as CSSProperties) : null),
  };

  return (
    <li
      style={style}
      className={cx(
        "flex min-w-0 [&>.kla-psign]:w-full",
        introIndex !== null && "kl-rise",
        transitionName && "[html[data-kl-vt=filter]_&]:[view-transition-name:var(--kl-vt-name)]",
      )}
    >
      <PlatformSign
        platform={platform}
        // Live entries can be newer than this bundle: the sign always gets arrays.
        protocol={{ ...protocol, networks: networksOf(protocol) as ProtocolEntry["networks"], capabilities }}
        cta={
          <div className="flex flex-col gap-3">
            {protocol.crossChain || protocol.executable === true || unknownNetworks.length ? (
              <ul className="flex flex-wrap gap-1.5" aria-label="More about this venue">
                {protocol.crossChain ? (
                  <li className={cx(CHIP, "border-current")} title="Moves value between networks.">
                    Cross-network
                  </li>
                ) : null}
                {protocol.executable === true ? (
                  <li className={cx(CHIP, "border-[#0B7A4B] text-[#0B7A4B] dark:border-[#5CF2B4] dark:text-[#5CF2B4]")} title="This API deployment has an execution adapter for this venue.">
                    Adapter live
                  </li>
                ) : null}
                {unknownNetworks.length ? (
                  <li className={cx(CHIP, "border-dashed border-current normal-case tracking-normal")}>Also on {unknownNetworks.join(", ")}</li>
                ) : null}
              </ul>
            ) : null}
            <p className="mt-auto flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t-2 border-dashed border-[#1A1A1A]/20 pt-3 dark:border-white/15">
              {example ? (
                <Link to={studioHref(example.prompt)} title={`Plans “${example.prompt}” in Intent Studio`} className="group/try">
                  Try a {example.action}
                  <ArrowRight
                    className="ml-1 inline h-3.5 w-3.5 align-[-2px] transition-transform duration-150 group-hover/try:translate-x-1 motion-reduce:transition-none"
                    aria-hidden="true"
                  />
                  <span className="sr-only">: {example.prompt} (opens Intent Studio)</span>
                </Link>
              ) : (
                capabilities.includes("execute") && !discoverOnly ? (
                  <Link to="/studio">
                    Plan an intent
                    <ArrowRight className="ml-1 inline h-3.5 w-3.5 align-[-2px]" aria-hidden="true" />
                  </Link>
                ) : (
                  <span className="font-code text-[11px] font-bold uppercase tracking-[0.12em] text-[#45464B] dark:text-[#A9B6C8]">
                    {discoverOnly ? "Read-only data" : "Quotes and routes only"}
                  </span>
                )
              )}
              {website ? (
                <a href={website} target="_blank" rel="noopener noreferrer">
                  Website
                  <ArrowUpRight className="ml-0.5 inline h-3.5 w-3.5 align-[-2px]" aria-hidden="true" />
                  <span className="sr-only"> for {protocol.name} (opens in a new tab)</span>
                </a>
              ) : null}
            </p>
          </div>
        }
      />
    </li>
  );
}
