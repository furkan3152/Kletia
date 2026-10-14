import { ChevronDown } from "lucide-react";
import { Fragment, useState } from "react";

import { Link } from "../../../routes/Link";
import { StatusEntryPill } from "../../../site/ui/StatusPill";
import { cx, FOCUS_RING, INK_BORDER, LABEL, SURFACE, TEXT_MUTED } from "../../../site/ui/styles";
import { shortId } from "../portal/portalFormat";
import type { DeliveryRow } from "./webhookModel";

const CELL = "px-3 py-3 align-middle";

/** The facts behind one attempt: ids, the headers it carried, the error in words. */
function DeliveryFacts({ row }: { readonly row: DeliveryRow }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 text-body-s">
      <dl className="grid min-w-0 gap-x-4 gap-y-1 font-code text-[12px] sm:grid-cols-[11rem_minmax(0,1fr)]">
        <dt className="font-bold">Sent at</dt>
        <dd className="min-w-0 break-all">{row.stamp}</dd>
        <dt className="font-bold">Kletia-Event-Id</dt>
        <dd className="min-w-0 break-all">{row.eventId}</dd>
        <dt className="font-bold">Kletia-Signature</dt>
        <dd className="min-w-0 break-all">t=&lt;unix seconds&gt;,v1=&lt;HMAC-SHA256 hex&gt;</dd>
        {row.intentId ? (
          <>
            <dt className="font-bold">Intent</dt>
            <dd className="min-w-0 break-all">{row.intentId}</dd>
          </>
        ) : null}
      </dl>
      {row.problem ? <p className="font-semibold">{row.problem}</p> : null}
      <p className={TEXT_MUTED}>
        Verify the signature over the raw body before you trust a delivery:{" "}
        <Link to="/developers/events" className={cx("font-bold underline decoration-2 underline-offset-2", FOCUS_RING)}>
          how to verify
        </Link>
        .
      </p>
    </div>
  );
}

export interface DeliveriesTableProps {
  readonly rows: readonly DeliveryRow[];
}

/**
 * The delivery log of one endpoint: time, event, attempt, result, HTTP
 * status, duration, next retry and intent; each row opens its facts. A
 * real table at 640 px and up, two-line items below.
 */
export function DeliveriesTable({ rows }: DeliveriesTableProps) {
  const [open, setOpen] = useState<string | null>(null);
  const toggle = (id: string) => setOpen((current) => (current === id ? null : id));
  return (
    <div className={cx("min-w-0", INK_BORDER, SURFACE)}>
      <table className="hidden w-full border-collapse text-left text-body-s sm:table">
        <caption className="sr-only">Delivery attempts, newest first</caption>
        <thead className="bg-surface-2">
          <tr className="border-b-2 border-[#1A1A1A]/10 dark:border-white/10">
            {["Time (UTC)", "Event", "Attempt", "Result", "HTTP", "Duration", "Next retry", "Intent"].map((header) => (
              <th key={header} scope="col" className={cx(LABEL, CELL, "py-2.5 font-extrabold", TEXT_MUTED)}>
                {header}
              </th>
            ))}
            <th scope="col" className={cx(CELL, "w-12 py-2.5")}>
              <span className="sr-only">Details</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y-2 divide-[#1A1A1A]/10 dark:divide-white/10">
          {rows.map((row) => {
            const expanded = open === row.id;
            const panel = `delivery-${row.id}`;
            return (
              <Fragment key={row.id}>
                <tr className="h-12">
                  <td className={cx(CELL, "whitespace-nowrap font-code")} title={row.stamp}>
                    {row.time}
                  </td>
                  <td className={cx(CELL, "font-code text-[13px]")}>
                    {row.event}
                    {row.test ? <span className={cx("ml-1.5 font-sans text-[12px]", TEXT_MUTED)}>(test)</span> : null}
                  </td>
                  <td className={cx(CELL, "whitespace-nowrap")}>{row.attempt}</td>
                  <td className={CELL}>
                    <StatusEntryPill entry={row.status} />
                  </td>
                  <td className={cx(CELL, "font-code")}>{row.http}</td>
                  <td className={cx(CELL, "whitespace-nowrap font-code")}>{row.duration}</td>
                  <td className={cx(CELL, "whitespace-nowrap font-code")}>{row.nextRetry}</td>
                  <td className={cx(CELL, "font-code text-[12px]")}>{row.intentId ? shortId(row.intentId) : "–"}</td>
                  <td className={cx(CELL, "w-12 text-right")}>
                    <button
                      type="button"
                      onClick={() => toggle(row.id)}
                      aria-expanded={expanded}
                      aria-controls={panel}
                      aria-label={`Details of the ${row.event} attempt at ${row.time}`}
                      className={cx("inline-flex h-10 w-10 items-center justify-center", FOCUS_RING)}
                    >
                      <ChevronDown className={cx("h-5 w-5 transition-transform motion-reduce:transition-none", expanded && "rotate-180")} aria-hidden="true" />
                    </button>
                  </td>
                </tr>
                {expanded ? (
                  <tr id={panel} className="bg-surface-2">
                    <td colSpan={9} className="px-4 py-3">
                      <DeliveryFacts row={row} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>

      <ul className="divide-y-2 divide-[#1A1A1A]/10 sm:hidden dark:divide-white/10" aria-label="Delivery attempts, newest first">
        {rows.map((row) => {
          const expanded = open === row.id;
          const panel = `delivery-phone-${row.id}`;
          return (
            <li key={row.id} className="flex min-w-0 flex-col gap-2 px-3 py-2.5">
              <div className="flex min-w-0 items-start gap-2">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <StatusEntryPill entry={row.status} />
                    <span className="min-w-0 break-all font-code text-[13px] font-bold">{row.event}</span>
                  </div>
                  <p className={cx("text-body-s", TEXT_MUTED)}>
                    {row.time} UTC · {row.attempt} · HTTP {row.http} · {row.duration}
                    {row.nextRetry !== "–" ? ` · next retry ${row.nextRetry}` : ""}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => toggle(row.id)}
                  aria-expanded={expanded}
                  aria-controls={panel}
                  aria-label={`Details of the ${row.event} attempt at ${row.time}`}
                  className={cx("inline-flex h-11 w-11 shrink-0 items-center justify-center", FOCUS_RING)}
                >
                  <ChevronDown className={cx("h-5 w-5 transition-transform motion-reduce:transition-none", expanded && "rotate-180")} aria-hidden="true" />
                </button>
              </div>
              {expanded ? (
                <div id={panel}>
                  <DeliveryFacts row={row} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
