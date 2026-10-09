import "./base.css";
import "./ticket.css";

import type { ReactNode } from "react";

import { cx } from "../ui/styles";
import { Icon } from "./Icon";
import type { IconName } from "./icons";
import { punchCount } from "./ticketFormat";

/*
 * The die-cut ticket every ticket variant is printed on: cream stock with
 * grain, an ink edge, two half-moon notches at the tear line (cut with a CSS
 * mask, so the ticket sits on any surface), a dotted perforation and a stub.
 * The hard shadow is a drop-shadow on the wrapper, so it follows the cut.
 * Under 500 px of width the stub moves below the ticket and the cut turns.
 * The stock and its ink stay the same at night (the night rule).
 */

export interface TicketShellProps {
  /** Accessible name of the ticket, e.g. "Intent ticket 7F3A-C21E". */
  readonly label: string;
  /** Variant hook for styles: "intent", "receipt", "link" or "blank". */
  readonly kind?: "intent" | "receipt" | "link" | "blank";
  /** Written to data-state (the stamp state), for page styles and tests. */
  readonly state?: string;
  readonly main: ReactNode;
  readonly stub: ReactNode;
  readonly className?: string;
}

export function TicketShell({ label, kind = "intent", state, main, stub, className }: TicketShellProps) {
  return (
    <div className={cx("kla-ticket-wrap", `kla-ticket-wrap--${kind}`, className)}>
      <article className={cx("kla-ticket", `kla-ticket--${kind}`)} aria-label={label} data-state={state}>
        <div className="kla-ticket__main">{main}</div>
        <div className="kla-ticket__stub">{stub}</div>
      </article>
    </div>
  );
}

export interface TicketHeadProps {
  readonly icon: IconName;
  readonly title: string;
  readonly serial: string;
  /** Print an "Example" plate before the serial (illustrations on marketing pages). */
  readonly example?: boolean;
}

/** Ticket masthead: pictogram, ticket title and serial number. */
export function TicketHead({ icon, title, serial, example = false }: TicketHeadProps) {
  return (
    <header className="kla-ticket__head">
      <span className="kla-ticket__brand">
        <Icon name={icon} size={18} />
        {title}
      </span>
      <span className="kla-ticket__serial">
        {example ? <span className="kla-ticket__example">Example</span> : null}
        No. {serial}
      </span>
    </header>
  );
}

export interface TicketField {
  readonly label: string;
  readonly value: ReactNode;
}

/** Small label/value pairs printed along the bottom of a ticket. */
export function TicketFields({ fields, className }: { readonly fields: readonly TicketField[]; readonly className?: string }) {
  if (!fields.length) return null;
  return (
    <dl className={cx("kla-ticket__fields", className)}>
      {fields.map((field) => (
        <div key={field.label}>
          <dt>{field.label}</dt>
          <dd>{field.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Punched holes on a stub, one per leg (hidden from assistive tech: the count is printed). */
export function Punches({ total, punched }: { readonly total: number; readonly punched: number }) {
  const count = punchCount(total);
  if (!count) return null;
  return (
    <div className="kla-ticket__punches" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <span key={index} className="kla-ticket__punch" data-punched={index < punched || undefined}>
          {index + 1}
        </span>
      ))}
    </div>
  );
}
