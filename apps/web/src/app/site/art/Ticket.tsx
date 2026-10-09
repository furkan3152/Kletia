import "./base.css";
import "./ticket.css";

import { cx } from "../ui/styles";
import { Icon } from "./Icon";
import { LineBullet } from "./LineBullet";
import { Stamp } from "./Stamp";
import { STAMP_SENTENCES, type StampState } from "./stampText";
import { legNumber } from "./ticketFormat";
import { Punches, TicketFields, TicketHead, TicketShell, type TicketField } from "./TicketShell";
import type { Line } from "./tokens";

/*
 * Intent ticket. The intent is printed as the user wrote it, the plan is the
 * list of legs, and the stub carries the state as a rubber stamp. Everything
 * readable is real text; stamps and punches are decorative and the state is
 * repeated in words for assistive tech.
 */

export interface TicketLeg {
  /** Bold verb, e.g. "Bridge". */
  readonly verb: string;
  /** The rest of the leg, e.g. "50 USDC, Base → Solana". */
  readonly detail: string;
  /** Venue name, e.g. "Relay". */
  readonly via: string;
  /** Seen on-chain. */
  readonly done: boolean;
}

export interface TicketProps {
  readonly serial: string;
  /** The sentence as the user wrote it (printed in quotes). */
  readonly intent: string;
  readonly from: Line;
  readonly to: Line;
  readonly legs: readonly TicketLeg[];
  readonly state: StampState;
  /** Small print on the stamp (a date for signed, a block for settled). */
  readonly stampDetail?: string;
  /** Small print above the word on the signed seal, e.g. "Leg 1 of 2". */
  readonly stampCaption?: string;
  /** "Dry run" or "Live": the first field. */
  readonly ticketClass: string;
  /** Replaces the default fields (Class, Signed by, Settles when). */
  readonly fields?: readonly TicketField[];
  /** Print "Example" before the serial (illustrations on marketing pages). */
  readonly example?: boolean;
  /** Press the stamp once when the ticket scrolls into view. */
  readonly animateStamp?: boolean;
  readonly className?: string;
}

export function Ticket({
  serial,
  intent,
  from,
  to,
  legs,
  state,
  stampDetail,
  stampCaption,
  ticketClass,
  fields,
  example = false,
  animateStamp = false,
  className,
}: TicketProps) {
  const done = legs.filter((leg) => leg.done).length;
  return (
    <TicketShell
      label={`Intent ticket ${serial}`}
      kind="intent"
      state={state}
      className={className}
      main={
        <>
          <TicketHead icon="ticket" title="Kletia intent ticket" serial={serial} example={example} />
          <p className="kla-ticket__eyebrow">You asked for</p>
          <p className="kla-ticket__intent">“{intent}”</p>

          <div className="kla-ticket__route">
            <span className="kla-ticket__end">
              <span className="kla-ticket__k">From</span>
              <LineBullet line={from} decorative />
              <span className="kla-ticket__place">{from.name}</span>
            </span>
            <span className="kla-ticket__track" aria-hidden="true" />
            <span className="kla-ticket__end">
              <span className="kla-ticket__k">To</span>
              <LineBullet line={to} decorative />
              <span className="kla-ticket__place">{to.name}</span>
            </span>
          </div>

          <ol className="kla-ticket__legs">
            {legs.map((leg, index) => (
              <li key={index} className="kla-ticket__leg" data-done={leg.done || undefined}>
                <span className="kla-ticket__leg-no" aria-hidden="true">
                  {legNumber(index)}
                </span>
                <span className="kla-ticket__leg-what">
                  <strong>{leg.verb}</strong> {leg.detail}
                </span>
                <span className="kla-ticket__leg-via">via {leg.via}</span>
                <span className="kla-ticket__leg-mark">
                  <span aria-hidden="true">{leg.done ? "✓" : "·"}</span>
                  <span className="kla-sr">{leg.done ? "seen on-chain" : "not settled yet"}</span>
                </span>
              </li>
            ))}
          </ol>

          <TicketFields
            fields={
              fields ?? [
                { label: "Class", value: ticketClass },
                { label: "Signed by", value: "Your wallet" },
                { label: "Settles when", value: "Seen on-chain" },
              ]
            }
          />
        </>
      }
      stub={
        <>
          <p className="kla-ticket__stub-k">Legs</p>
          <p className="kla-ticket__stub-n">{legs.length}</p>
          <Punches total={legs.length} punched={done} />
          <p className="kla-sr">{STAMP_SENTENCES[state]}</p>
          <Stamp state={state} detail={stampDetail} caption={stampCaption} animate={animateStamp} className="kla-ticket__stamp" />
        </>
      }
    />
  );
}

export interface TicketStubProps {
  readonly serial: string;
  readonly legs: number;
  readonly legsDone: number;
  readonly state: StampState;
  readonly stampDetail?: string;
  readonly stampCaption?: string;
  readonly animateStamp?: boolean;
  /** Delay before the stamp press, for a row of stubs. */
  readonly stampDelayMs?: number;
  readonly className?: string;
}

/** The torn-off stub on its own: it collects one stamp per state. The state is also written out for assistive tech. */
export function TicketStub({
  serial,
  legs,
  legsDone,
  state,
  stampDetail,
  stampCaption,
  animateStamp = false,
  stampDelayMs,
  className,
}: TicketStubProps) {
  return (
    <div className={cx("kla-ticket-wrap kla-stub-wrap", className)}>
      <div className="kla-stub" data-state={state}>
        <p className="kla-stub__serial">No. {serial}</p>
        <p className="kla-ticket__stub-k">Legs</p>
        <p className="kla-ticket__stub-n">{legs}</p>
        <Punches total={legs} punched={legsDone} />
        <p className="kla-sr">{STAMP_SENTENCES[state]}</p>
        <Stamp
          state={state}
          detail={stampDetail}
          caption={stampCaption}
          animate={animateStamp}
          delayMs={stampDelayMs}
          className="kla-stub__stamp"
        />
      </div>
    </div>
  );
}

export interface BlankTicketProps {
  /** Real heading-like text, e.g. "Nothing planned yet." */
  readonly title: string;
  readonly body: string;
  readonly className?: string;
}

/** Studio empty state: an unprinted ticket. Title and body are real text passed in by the page. */
export function BlankTicket({ title, body, className }: BlankTicketProps) {
  return (
    <TicketShell
      label="Blank intent ticket"
      kind="blank"
      className={className}
      main={
        <>
          <header className="kla-ticket__head">
            <span className="kla-ticket__brand">
              <Icon name="ticket" size={18} />
              Kletia intent ticket
            </span>
            <span className="kla-ticket__serial" aria-hidden="true">
              No. ____-____
            </span>
          </header>
          <p className="kla-ticket__eyebrow">You asked for</p>
          <p className="kla-ticket__blank-title">{title}</p>
          <p className="kla-ticket__blank-body">{body}</p>
          <div className="kla-ticket__blank-lines" aria-hidden="true">
            <span />
            <span />
          </div>
        </>
      }
      stub={
        <>
          <p className="kla-ticket__stub-k">Legs</p>
          <p className="kla-ticket__stub-n">
            <span aria-hidden="true">–</span>
            <span className="kla-sr">none yet</span>
          </p>
        </>
      }
    />
  );
}
