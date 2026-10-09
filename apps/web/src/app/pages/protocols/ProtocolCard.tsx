import { ArrowRight, ArrowUpRight, Eye } from "lucide-react";
import React from "react";

import { Link } from "../../routes/Link";
import { useSpotlight } from "../../site/motion/useSpotlight";
import { Badge } from "../../site/ui/Badge";
import { Monogram } from "../../site/ui/Monogram";
import { categoryColor } from "../../site/ui/monogramStyle";
import { cx, FOCUS_RING, INK_BORDER, LIFT, SHADOW_HARD, SPOTLIGHT, SURFACE, TEXT_MUTED } from "../../site/ui/styles";
import { protocolExample, studioHref } from "./protocolExamples";
import {
  CAPABILITY_HELP,
  CAPABILITY_LABEL,
  CAPABILITY_STRIPE,
  capabilitiesOf,
  humanizeCategory,
  networkLabel,
  networksOf,
  safeWebsite,
  strongestCapability,
  type ProtocolEntry,
} from "./protocolStats";

const CAPABILITY_TONE = { execute: "blue", quote: "yellow", discover: "neutral" } as const;
const MAX_NETWORK_CHIPS = 4;

export interface ProtocolCardProps {
  readonly protocol: ProtocolEntry;
  /**
   * `view-transition-name`, unique on the page. Applied only while a filter
   * View Transition runs (`html[data-kl-vt=filter]`), so route transitions
   * still move the page as one piece.
   */
  readonly transitionName?: string;
  /** Rise in on first render with this stagger index (null = no entrance). */
  readonly introIndex?: number | null;
  readonly headingLevel?: "h2" | "h3";
  readonly as?: "li" | "article";
}

/**
 * Directory card for one venue: monogram, capabilities, networks and an
 * example intent that opens in Studio. Equal heights in the grid (the
 * actions row sits at the bottom with `mt-auto`).
 */
export function ProtocolCard({ protocol, transitionName, introIndex = null, headingLevel = "h3", as = "li" }: ProtocolCardProps) {
  const color = categoryColor(protocol.category);
  const { ref, handlers, style } = useSpotlight<HTMLElement>({ color: color.bg });
  const capabilities = capabilitiesOf(protocol);
  const strongest = strongestCapability(protocol);
  const networks = networksOf(protocol).map(networkLabel);
  const shown = networks.slice(0, MAX_NETWORK_CHIPS);
  const hidden = networks.length - shown.length;
  const allNetworks = networks.map((network) => network.name).join(", ");
  const example = capabilities.includes("execute") ? protocolExample(protocol.id) : null;
  const discoverOnly = capabilities.length > 0 && capabilities.every((capability) => capability === "discover");
  const website = safeWebsite(protocol.website);
  const Heading = headingLevel;
  const Element = as;

  const cardStyle: React.CSSProperties = {
    ...style,
    ...(transitionName ? ({ "--kl-vt-name": transitionName } as React.CSSProperties) : null),
    ...(introIndex !== null ? ({ "--kl-i": introIndex } as React.CSSProperties) : null),
  };

  return (
    <Element
      ref={ref}
      {...handlers}
      style={cardStyle}
      className={cx(
        "flex min-w-0 flex-col",
        INK_BORDER,
        SHADOW_HARD,
        SURFACE,
        LIFT,
        SPOTLIGHT,
        introIndex !== null && "kl-rise",
        transitionName && "[html[data-kl-vt=filter]_&]:[view-transition-name:var(--kl-vt-name)]",
      )}
    >
      <span
        aria-hidden="true"
        className="block h-[6px] border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563]"
        style={{ backgroundColor: CAPABILITY_STRIPE[strongest] }}
      />
      <div className="flex flex-1 flex-col gap-4 p-5">
        <div className="flex items-start gap-4">
          <Monogram name={protocol.name} category={protocol.category} size="md" className="mt-0.5" />
          <div className="min-w-0 flex-1">
            <Heading className="break-words font-display text-[20px] font-bold leading-tight tracking-[-0.01em]">
              {protocol.name}
            </Heading>
            <p className="mt-1 font-code text-[11px] text-[#45464B] [overflow-wrap:anywhere] dark:text-[#A9B6C8]">
              {protocol.id}
            </p>
          </div>
          <Badge tone="outline" className="mt-0.5 shrink-0">
            {humanizeCategory(protocol.category)}
          </Badge>
        </div>

        {protocol.summary ? (
          <p className={cx("text-sm leading-relaxed", TEXT_MUTED)}>{protocol.summary}</p>
        ) : null}

        <div>
          <p className="sr-only">Capabilities:</p>
          <ul className="flex flex-wrap gap-1.5">
            {capabilities.map((capability) => (
              <li key={capability}>
                <Badge tone={CAPABILITY_TONE[capability]} title={CAPABILITY_HELP[capability]}>
                  {CAPABILITY_LABEL[capability]}
                </Badge>
              </li>
            ))}
            {protocol.crossChain ? (
              <li>
                <Badge tone="purple" title="Moves value between networks.">
                  Cross-chain
                </Badge>
              </li>
            ) : null}
            {protocol.executable === true ? (
              <li>
                <Badge tone="green" title="This API deployment has an execution adapter for this venue.">
                  Adapter live
                </Badge>
              </li>
            ) : null}
          </ul>
        </div>

        <div title={allNetworks || undefined}>
          <p className="sr-only">Networks: {allNetworks || "none listed"}.</p>
          <ul aria-hidden="true" className="flex flex-wrap gap-1.5">
            {shown.map((network) => (
              <li key={network.key}>
                <Badge tone="neutral" dot={network.color ?? undefined} className={network.known ? undefined : "font-code normal-case"}>
                  {network.shortName}
                </Badge>
              </li>
            ))}
            {hidden > 0 ? (
              <li>
                <Badge tone="outline">+{hidden}</Badge>
              </li>
            ) : null}
          </ul>
        </div>

        <div className="mt-auto flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t-2 border-dashed border-[#1A1A1A]/20 pt-4 dark:border-white/10">
          {example ? (
            <Link
              to={studioHref(example.prompt)}
              className={cx(
                "group/try inline-flex min-h-9 items-center gap-1.5 text-xs font-black uppercase tracking-[0.12em] text-[#0052FF] underline decoration-2 underline-offset-4 dark:text-[#7EA6FF]",
                FOCUS_RING,
              )}
              title={`Plans “${example.prompt}” in Intent Studio`}
            >
              Try a {example.action} intent
              <ArrowRight
                className="h-3.5 w-3.5 transition-transform duration-150 ease-kl-standard group-hover/try:translate-x-1 motion-reduce:transition-none motion-reduce:group-hover/try:translate-x-0"
                aria-hidden="true"
              />
              <span className="sr-only">: {example.prompt} (opens Intent Studio)</span>
            </Link>
          ) : discoverOnly ? (
            <span className={cx("inline-flex items-center gap-1.5 text-xs font-bold", TEXT_MUTED)}>
              <Eye className="h-3.5 w-3.5" aria-hidden="true" />
              Read-only data
            </span>
          ) : capabilities.includes("execute") ? (
            <Link
              to="/studio"
              className={cx(
                "inline-flex min-h-9 items-center gap-1.5 text-xs font-black uppercase tracking-[0.12em] underline decoration-2 underline-offset-4",
                FOCUS_RING,
              )}
            >
              Plan an intent
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          ) : (
            <span className={cx("inline-flex items-center gap-1.5 text-xs font-bold", TEXT_MUTED)}>
              <Eye className="h-3.5 w-3.5" aria-hidden="true" />
              Quotes and routes only
            </span>
          )}
          {website ? (
            <a
              href={website}
              target="_blank"
              rel="noopener noreferrer"
              className={cx(
                "inline-flex min-h-9 items-center gap-1 text-xs font-black uppercase tracking-[0.12em] underline decoration-2 underline-offset-4",
                FOCUS_RING,
              )}
            >
              Website
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="sr-only"> for {protocol.name} (opens in a new tab)</span>
            </a>
          ) : null}
        </div>
      </div>
    </Element>
  );
}
