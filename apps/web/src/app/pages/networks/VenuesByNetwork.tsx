import { ArrowRight } from "lucide-react";

import { Link } from "../../routes/Link";
import { AnimatedNumber } from "../../site/motion/AnimatedNumber";
import { Reveal } from "../../site/motion/Reveal";
import { Badge } from "../../site/ui/Badge";
import { Monogram } from "../../site/ui/Monogram";
import { cx, FOCUS_RING, INK_BORDER, LABEL, LIFT, SHADOW_HARD, SURFACE, TEXT_MUTED } from "../../site/ui/styles";
import {
  capabilityCounts,
  networkLabel,
  protocolsOnNetwork,
  strongestCapability,
  type ProtocolEntry,
} from "../protocols/protocolStats";

const MAX_MONOGRAMS = 6;
const RANK = { execute: 0, quote: 1, discover: 2 } as const;

export interface VenuesByNetworkProps {
  /** Network keys in display order (production lane first). */
  readonly networks: readonly { readonly key: string; readonly environment?: string }[];
  readonly protocols: readonly ProtocolEntry[];
}

/** One compact card per network: venue count, capability mix, a monogram stack and a link into /protocols. */
export function VenuesByNetwork({ networks, protocols }: VenuesByNetworkProps) {
  return (
    <Reveal as="ul" stagger className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
      {networks.map((network) => {
        const label = networkLabel(network.key);
        const venues = protocolsOnNetwork(protocols, network.key).sort(
          (a, b) => RANK[strongestCapability(a)] - RANK[strongestCapability(b)] || a.name.localeCompare(b.name),
        );
        const counts = capabilityCounts(venues);
        const stack = venues.slice(0, MAX_MONOGRAMS);
        const testnet = network.environment === "testnet";
        return (
          <li key={network.key} data-reveal-item className={cx("flex min-w-0", INK_BORDER, SHADOW_HARD, SURFACE, LIFT)}>
            <span
              aria-hidden="true"
              className="w-3 shrink-0 border-r-[3px] border-[#1A1A1A] dark:border-[#4B5563]"
              style={{ backgroundColor: label.color ?? "#94A3B8" }}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-4 p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate font-display text-xl font-bold leading-tight">{label.name}</h3>
                  <p className={cx(LABEL, "mt-1 !text-[10px]", testnet ? "text-[#B45309] dark:text-[#FFD60A]" : "text-[#0B7A4B] dark:text-[#14F195]")}>
                    {testnet ? "Testnet lane" : "Production lane"}
                  </p>
                </div>
                <p className="text-right">
                  <span className="block font-display text-4xl font-bold leading-none tracking-[-0.04em]">
                    <AnimatedNumber value={venues.length} />
                  </span>
                  <span className={cx(LABEL, "!text-[10px]", TEXT_MUTED)}>{venues.length === 1 ? "venue" : "venues"}</span>
                </p>
              </div>

              <p className="flex flex-wrap gap-1.5">
                <Badge tone="blue">Execute {counts.execute}</Badge>
                <Badge tone="yellow">Quote {counts.quote}</Badge>
                <Badge tone="neutral">Discover {counts.discover}</Badge>
              </p>

              {stack.length > 0 ? (
                <div className="flex items-center">
                  <ul aria-hidden="true" className="flex items-center pl-1">
                    {stack.map((protocol, index) => (
                      <li key={protocol.id} className={index > 0 ? "-ml-2" : undefined} style={{ zIndex: MAX_MONOGRAMS - index }}>
                        <Monogram name={protocol.name} category={protocol.category} size="sm" className="[&>span]:hidden" />
                      </li>
                    ))}
                  </ul>
                  {venues.length > stack.length ? (
                    <span className="ml-3 font-code text-xs font-bold text-[#45464B] dark:text-[#A9B6C8]">
                      +{venues.length - stack.length}
                    </span>
                  ) : null}
                  <span className="sr-only">Includes {stack.map((protocol) => protocol.name).join(", ")}.</span>
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
                  View {venues.length} {venues.length === 1 ? "protocol" : "protocols"}
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
