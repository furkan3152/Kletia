import { ArrowRight } from "lucide-react";

import { Link } from "../../routes/Link";
import { AnimatedNumber } from "../../site/motion/AnimatedNumber";
import { Reveal } from "../../site/motion/Reveal";
import { categoryIcon, categoryWord, lineFor } from "../../site/art";
import { Icon } from "../../site/art/Icon";
import { isOwnContractEntry, protocolNoun } from "../../site/protocolCount";
import { LineBullet } from "../../site/art/LineBullet";
import { Badge } from "../../site/ui/Badge";
import { cx, FOCUS_RING, INK_BORDER, LABEL, SHADOW_HARD, SURFACE, TEXT_MUTED } from "../../site/ui/styles";
import {
  capabilityCounts,
  networkLabel,
  protocolsOnNetwork,
  strongestCapability,
  type ProtocolEntry,
} from "../protocols/protocolStats";

const RANK = { execute: 0, quote: 1, discover: 2 } as const;

export interface VenuesByNetworkProps {
  /** Network keys in display order (production lane first). */
  readonly networks: readonly { readonly key: string; readonly environment?: string }[];
  readonly protocols: readonly ProtocolEntry[];
}

/** One compact card per network: venue count, capability mix, the kinds of venue as pictograms and a link into /protocols. */
export function VenuesByNetwork({ networks, protocols }: VenuesByNetworkProps) {
  return (
    <Reveal as="ul" stagger className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
      {networks.map((network) => {
        const label = networkLabel(network.key);
        const onNetwork = protocolsOnNetwork(protocols, network.key);
        // Count real protocols only; custom calls belong to project integrations.
        const ownContracts = onNetwork.some(isOwnContractEntry);
        const venues = onNetwork.filter((protocol) => !isOwnContractEntry(protocol)).sort(
          (a, b) => RANK[strongestCapability(a)] - RANK[strongestCapability(b)] || a.name.localeCompare(b.name),
        );
        const counts = capabilityCounts(venues);
        // One pictogram per kind of venue (swap, lend, stake, ...), in the order the venues are listed.
        const kinds = [...new Map(venues.map((protocol) => [categoryIcon(protocol.category), categoryWord(protocol.category)])).entries()];
        const testnet = network.environment === "testnet";
        const line = lineFor(network.key);
        return (
          <li key={network.key} data-reveal-item className={cx("flex min-w-0", INK_BORDER, SHADOW_HARD, SURFACE)}>
            <span
              aria-hidden="true"
              className="w-3 shrink-0 border-r-[3px] border-[#1A1A1A] dark:border-[#4B5563]"
              style={{
                backgroundColor: label.color ?? "#94A3B8",
                backgroundImage: line?.gauge === "svm" ? "repeating-linear-gradient(180deg, #1A1A1A 0 4px, transparent 4px 9px)" : undefined,
                backgroundSize: "3px 100%",
                backgroundPosition: "center",
                backgroundRepeat: "no-repeat",
              }}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-4 p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="flex min-w-0 items-center gap-2.5 font-display text-xl font-bold leading-tight">
                    {line ? <LineBullet line={line} decorative className={line.yard ? "kla-bullet--yard" : undefined} /> : null}
                    <span className="truncate">{label.name}</span>
                  </h3>
                  <p className={cx(LABEL, "mt-1.5 !text-[10px]", TEXT_MUTED)}>
                    {testnet ? "Test yard" : "Production line"}
                  </p>
                </div>
                <p className="text-right">
                  <span className="block font-display text-4xl font-bold leading-none tracking-[-0.04em]">
                    <AnimatedNumber value={venues.length} />
                  </span>
                  <span className={cx(LABEL, "!text-[10px]", TEXT_MUTED)}>{venues.length === 1 ? "protocol" : "protocols"}</span>
                </p>
              </div>

              <p className="flex flex-wrap gap-1.5">
                <Badge tone="blue">Execute {counts.execute}</Badge>
                <Badge tone="yellow">Quote {counts.quote}</Badge>
                <Badge tone="neutral">Discover {counts.discover}</Badge>
                {ownContracts ? <Badge tone="ink">Custom calls in project integrations</Badge> : null}
              </p>

              {kinds.length > 0 ? (
                <div>
                  <ul aria-hidden="true" className="flex flex-wrap gap-1.5">
                    {kinds.map(([icon, word]) => (
                      <li
                        key={icon}
                        title={word}
                        className="flex h-9 w-9 items-center justify-center border-2 border-[#1A1A1A] bg-white dark:border-[#4B5563] dark:bg-[#0B1120]"
                      >
                        <Icon name={icon} size={22} />
                      </li>
                    ))}
                  </ul>
                  <p className="sr-only">
                    Kinds of venue: {kinds.map(([, word]) => word).join(", ")}. Includes {venues.map((protocol) => protocol.name).join(", ")}.
                  </p>
                </div>
              ) : (
                <p className={cx("text-sm", TEXT_MUTED)}>No venues in the registry yet.</p>
              )}

              {venues.length > 0 ? (
                <Link
                  to={`/protocols?network=${encodeURIComponent(network.key)}`}
                  className={cx(
                    "group/link mt-auto inline-flex min-h-9 items-center gap-2 self-start text-xs font-black uppercase tracking-[0.12em] underline decoration-2 underline-offset-4",
                    FOCUS_RING,
                  )}
                >
                  View {protocolNoun(venues.length)}
                  <span className="sr-only"> on {label.name}</span>
                  <ArrowRight
                    className="h-3.5 w-3.5 transition-transform duration-150 group-hover/link:translate-x-1 motion-reduce:transition-none motion-reduce:group-hover/link:translate-x-0"
                    aria-hidden="true"
                  />
                </Link>
              ) : null}
            </div>
          </li>
        );
      })}
    </Reveal>
  );
}
