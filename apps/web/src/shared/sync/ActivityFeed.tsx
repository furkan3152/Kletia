import React from "react";
import { CHAINS, type NetworkKey } from "@kletia/core";
import {
  CircleCheck,
  CircleX,
  ExternalLink,
  LoaderCircle,
  ScrollText,
} from "lucide-react";

import {
  useActivityStore,
  type ActivityEntry,
  type ActivityStatus,
} from "./activityStore";

export interface ActivityFeedProps {
  /** Only show entries for this network (or any of these networks). */
  network?: NetworkKey | readonly NetworkKey[];
  /** Maximum number of entries to render (default 25). */
  limit?: number;
  /** Dense rows without the header, for drawers and side panels. */
  compact?: boolean;
  /** Heading shown above the list when not compact. */
  title?: string;
  /** Text shown when nothing matches. */
  emptyHint?: string;
  className?: string;
}

const STATUS_PRESENTATION: Record<
  ActivityStatus,
  { label: string; className: string; Icon: typeof CircleCheck }
> = {
  pending: {
    label: "Pending",
    className: "bg-[#FFD60A] text-[#1A1A1A]",
    Icon: LoaderCircle,
  },
  confirmed: {
    label: "Confirmed",
    className: "bg-[#14F195] text-[#1A1A1A]",
    Icon: CircleCheck,
  },
  failed: {
    label: "Failed",
    className: "bg-[#EF4444] text-white",
    Icon: CircleX,
  },
};

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function shortReference(reference: string): string {
  return reference.length > 14
    ? `${reference.slice(0, 6)}…${reference.slice(-6)}`
    : reference;
}

function ActivityRow({ entry, compact }: { entry: ActivityEntry; compact: boolean }) {
  const status = STATUS_PRESENTATION[entry.status];
  const chain = CHAINS[entry.network];
  const StatusIcon = status.Icon;
  return (
    <li className="border-[3px] border-[#1A1A1A] bg-white p-3 shadow-[3px_3px_0_#1A1A1A] dark:border-[#4B5563] dark:bg-[#131E32] dark:shadow-[3px_3px_0_#475569]">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p
            className={`truncate font-black text-[#1A1A1A] dark:text-white ${compact ? "text-xs" : "text-sm"}`}
            title={entry.title}
          >
            {entry.title}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] font-black uppercase tracking-wider text-gray-600 dark:text-slate-300">
            <span className="inline-flex items-center gap-1">
              <span
                aria-hidden="true"
                className="inline-block h-2 w-2 border border-[#1A1A1A]"
                style={{ backgroundColor: chain.color }}
              />
              {chain.shortName}
            </span>
            <time dateTime={entry.at}>{timeFormatter.format(new Date(entry.at))}</time>
            {entry.reference ? (
              <span className="font-mono normal-case tracking-normal">
                {shortReference(entry.reference)}
              </span>
            ) : null}
          </p>
        </div>
        <span
          className={`inline-flex shrink-0 items-center gap-1 border-2 border-[#1A1A1A] px-1.5 py-0.5 text-[10px] font-black uppercase ${status.className}`}
        >
          <StatusIcon
            className={`h-3 w-3 ${entry.status === "pending" ? "animate-spin" : ""}`}
            aria-hidden="true"
          />
          {status.label}
        </span>
      </div>
      {entry.url ? (
        <a
          href={entry.url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-[11px] font-black uppercase text-[#0052FF] underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0052FF] dark:text-[#93C5FD]"
        >
          View on {chain.explorer.name}
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : null}
    </li>
  );
}

/**
 * Shared, persisted activity feed. Every transaction a console feature
 * submits (EVM routes, Solana swaps, transfers and stakes) appears here.
 */
export function ActivityFeed({
  network,
  limit = 25,
  compact = false,
  title = "Activity",
  emptyHint = "No transactions yet. Confirmed and pending transactions from every workspace appear here.",
  className = "",
}: ActivityFeedProps) {
  const entries = useActivityStore((state) => state.entries);
  const networks: readonly NetworkKey[] | null =
    network === undefined ? null : typeof network === "string" ? [network] : network;
  const networkKey = networks ? networks.join(",") : "";
  const visible = React.useMemo(() => {
    const allowed = networkKey ? new Set(networkKey.split(",")) : null;
    return entries
      .filter((entry) => !allowed || allowed.has(entry.network))
      .slice(0, Math.max(1, limit));
  }, [entries, limit, networkKey]);

  return (
    <section
      aria-label={title}
      className={`flex min-w-0 flex-col gap-3 ${className}`}
    >
      {!compact ? (
        <h3 className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-gray-600 dark:text-slate-300">
          <ScrollText className="h-4 w-4" aria-hidden="true" />
          {title}
        </h3>
      ) : null}
      <div aria-live="polite" aria-relevant="additions text">
        {visible.length === 0 ? (
          <p className="border-[3px] border-dashed border-[#1A1A1A] bg-white/70 p-4 text-sm font-bold text-gray-700 dark:border-[#4B5563] dark:bg-[#131E32]/70 dark:text-slate-300">
            {emptyHint}
          </p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {visible.map((entry) => (
              <ActivityRow key={entry.id} entry={entry} compact={compact} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export default ActivityFeed;
