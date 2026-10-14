import { ChevronRight } from "lucide-react";

import { DataTable } from "../../../site/ui/DataTable";
import { StatusPill } from "../../../site/ui/StatusPill";
import { cx, FOCUS_RING, LABEL, TEXT_MUTED } from "../../../site/ui/styles";
import { AUTH_TIERS, OPERATOR_TIER_NOTE } from "../devContent";

/**
 * The authentication reference (portal design 4.4.2): one row per tier,
 * collapsed by default on the Keys page (the full reference lives in the
 * docs). Opening it is a native <details>, so it works without script.
 */
export function AuthTable() {
  return (
    <details className="group flex min-w-0 flex-col" id="auth">
      <summary
        className={cx(
          "flex min-h-11 cursor-pointer list-none items-center gap-2 font-display text-title font-bold [&::-webkit-details-marker]:hidden",
          FOCUS_RING,
        )}
      >
        <ChevronRight className="h-5 w-5 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
        Authentication
        <span className={cx(LABEL, "ml-1 font-sans", TEXT_MUTED)}>Reference</span>
      </summary>
      <div className="flex min-w-0 flex-col gap-3 pt-3">
        <p className={cx("max-w-3xl text-body-s", TEXT_MUTED)}>
          Four tiers share one API. Every response carries X-Request-Id and RateLimit headers, and errors use stable UPPER_SNAKE_CASE codes.
        </p>
        <DataTable
          caption="Authentication tiers"
          rows={AUTH_TIERS}
          rowKey={(tier) => tier.tier}
          columns={[
            { key: "tier", header: "Tier", phone: "primary", cell: (tier) => <span className="font-bold">{tier.tier}</span> },
            {
              key: "browser",
              header: "In browsers",
              phone: "primary",
              cell: (tier) =>
                tier.browser === "yes" ? <StatusPill tone="success">Browser safe</StatusPill> : <StatusPill tone="warning">Server only</StatusPill>,
            },
            { key: "header", header: "Header", cell: (tier) => <code className="break-words font-code text-xs">{tier.header}</code> },
            { key: "limit", header: "Limit", cell: (tier) => tier.limit },
            { key: "can", header: "What it can do", cell: (tier) => tier.can },
          ]}
        />
        <p className={cx("text-body-s", TEXT_MUTED)}>{OPERATOR_TIER_NOTE}</p>
      </div>
    </details>
  );
}
