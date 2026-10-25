import "./activityFeed.css";

import React from "react";
import { CHAINS, type NetworkKey } from "@kletia/core";
import { ExternalLink } from "lucide-react";

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

const STATUS_LABEL: Record<ActivityStatus, string> = {
  pending: "Pending",
  confirmed: "Confirmed",
  failed: "Failed",
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

/** One line of the machine's log (Card machine): a status lamp, the title, network, time, reference. */
function ActivityRow({ entry, compact }: { entry: ActivityEntry; compact: boolean }) {
  const chain = CHAINS[entry.network];
  return (
    <li className="kaf-row" data-status={entry.status} data-compact={compact ? "" : undefined}>
      <span className="kaf-lamp" aria-hidden="true" />
      <div className="kaf-main">
        <p className="kaf-title" title={entry.title}>
          {entry.title}
        </p>
        <p className="kaf-meta">
          <span className="kaf-net">
            <span aria-hidden="true" className="kaf-stripe" style={{ backgroundColor: chain.color }} />
            {chain.shortName}
          </span>
          <time dateTime={entry.at}>{timeFormatter.format(new Date(entry.at))}</time>
          {entry.reference ? <span className="kaf-ref">{shortReference(entry.reference)}</span> : null}
        </p>
        {entry.url ? (
          <a href={entry.url} target="_blank" rel="noopener noreferrer" className="kaf-link">
            View on {chain.explorer.name}
            <ExternalLink aria-hidden="true" />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        ) : null}
      </div>
      <span className="kaf-status">{STATUS_LABEL[entry.status]}</span>
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
    <section aria-label={title} className={`kaf ${className}`}>
      {!compact ? <h3 className="kaf-h">{title}</h3> : null}
      <div aria-live="polite" aria-relevant="additions text">
        {visible.length === 0 ? (
          <p className="kaf-empty">{emptyHint}</p>
        ) : (
          <ul className="kaf-list">
            {visible.map((entry) => (
              <ActivityRow key={entry.id} entry={entry} compact={compact} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
