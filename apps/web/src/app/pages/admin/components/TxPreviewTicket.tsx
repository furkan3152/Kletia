import type React from "react";

import { TicketFields, TicketHead, TicketShell, type TicketField } from "../../../site/art/TicketShell";
import type { IconName } from "../../../site/art/icons";
import { cx } from "../../../site/ui/styles";

export interface TicketLine {
  readonly label: string;
  /** Printed value (mono). */
  readonly value: string;
  /** Address-book name or a decoded meaning, printed above the value. */
  readonly note?: string | null;
}

export interface TxPreviewTicketProps {
  readonly label: string;
  readonly icon: IconName;
  readonly title: string;
  readonly serial: string;
  /** The call or contract in one line ("setFeeBps(uint16)", "KletiaIntentRouterV2"). */
  readonly headline: string;
  readonly lines: readonly TicketLine[];
  readonly fields: readonly TicketField[];
  /** Stub: what the wallet will be asked to do. */
  readonly stubTitle: string;
  readonly stubBody: React.ReactNode;
  readonly warnings?: readonly string[];
  readonly className?: string;
}

/**
 * A transaction preview printed on the site's ticket stock: the call,
 * every argument with its address-book name, facts along the bottom
 * and, on the stub, what the wallet will ask.
 */
export function TxPreviewTicket({ label, icon, title, serial, headline, lines, fields, stubTitle, stubBody, warnings = [], className }: TxPreviewTicketProps) {
  return (
    <TicketShell
      label={label}
      kind="blank"
      className={cx("w-full", className)}
      main={
        <>
          <TicketHead icon={icon} title={title} serial={serial} />
          <p className="kla-ticket__eyebrow">Call</p>
          <p className="kla-ticket__intent break-all">{headline}</p>
          {lines.length > 0 ? (
            <dl className="mt-3 grid gap-2">
              {lines.map((line) => (
                <div key={line.label} className="grid min-w-0 gap-0.5 border-t-2 border-dotted border-[#1A1A1A]/30 pt-2 sm:grid-cols-[11rem_1fr] sm:gap-3">
                  <dt className="kla-ticket__k">{line.label}</dt>
                  <dd className="min-w-0">
                    {line.note ? <span className="block font-body text-[13px] font-bold">{line.note}</span> : null}
                    <code className="block break-all font-code text-[13px]">{line.value}</code>
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
          {warnings.length > 0 ? (
            <ul className="mt-3 flex flex-col gap-1.5">
              {warnings.map((warning) => (
                <li key={warning} className="border-l-[4px] border-[#B45309] bg-[#FFF3B0] px-2.5 py-1.5 font-body text-[13px] font-semibold text-[#5A2A00]">
                  {warning}
                </li>
              ))}
            </ul>
          ) : null}
          <TicketFields fields={fields} className="mt-4" />
        </>
      }
      stub={
        <div className="flex h-full flex-col gap-2">
          <p className="kla-ticket__stub-k">Wallet</p>
          <p className="font-display text-lg font-bold leading-tight">{stubTitle}</p>
          <div className="font-body text-[13px] leading-snug">{stubBody}</div>
        </div>
      }
    />
  );
}
