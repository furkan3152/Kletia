import "./base.css";
import "./ticket.css";

import { useId, type ReactNode } from "react";

import { LineBullet } from "./LineBullet";
import { Punches, TicketHead, TicketShell } from "./TicketShell";
import type { Line } from "./tokens";

/*
 * Link ticket: a shareable intent link printed as a ticket. It names the
 * publisher (with a blind-embossed seal when their domain is verified, a
 * hazard plate when it is not), the sentence the link fills in, and the
 * bounds Kletia enforces on whatever plan comes out of it. The stub shows how
 * long the link is valid and how many uses are left.
 */

export interface LinkPublisher {
  readonly name: string;
  /** Domain the link was published from, e.g. "shop.example". */
  readonly domain?: string;
  /** The domain was verified by Kletia. */
  readonly verified: boolean;
}

export interface LinkBound {
  readonly label: string;
  readonly value: ReactNode;
}

export interface LinkTicketProps {
  readonly serial: string;
  /** The sentence the link fills in. */
  readonly intent: string;
  readonly publisher: LinkPublisher;
  /** Hard limits on the plan, e.g. { label: "Up to", value: "50 USDC" }. */
  readonly bounds: readonly LinkBound[];
  /** Networks the plan may touch. */
  readonly networks?: readonly Line[];
  /** The shareable URL as printed. */
  readonly url: string;
  /** Make the printed URL a link. */
  readonly href?: string;
  /** Pre-formatted expiry, e.g. "12 Oct 2026". */
  readonly expires?: string;
  readonly uses?: { readonly used: number; readonly max: number };
  /** Small print under the URL. */
  readonly note?: string;
  readonly example?: boolean;
  readonly className?: string;
}

const DEFAULT_NOTE = "The link only fills in the form. You review the plan and sign it in your own wallet.";

/* Scalloped edge of the blind-embossed seal (24 points). */
const SEAL_EDGE =
  Array.from({ length: 24 }, (_, index) => {
    const angle = (index / 24) * Math.PI * 2;
    const radius = index % 2 ? 41 : 46;
    return `${index ? "L" : "M"}${(48 + Math.cos(angle) * radius).toFixed(1)} ${(48 + Math.sin(angle) * radius).toFixed(1)}`;
  }).join("") + "Z";

function Seal() {
  const arc = `${useId().replace(/:/g, "")}-arc`;
  return (
    <svg viewBox="0 0 96 96" className="kla-seal" aria-hidden="true" focusable="false">
      <path className="kla-seal__edge" d={SEAL_EDGE} />
      <circle cx={48} cy={48} r={32} className="kla-seal__ring" />
      <path d="M36 49l8 8 16-17" className="kla-seal__tick" />
      <path id={arc} d="M48 48m-25 0a25 25 0 1 1 50 0" fill="none" />
      <text className="kla-seal__text">
        <textPath href={`#${arc}`} startOffset="50%" textAnchor="middle">
          VERIFIED
        </textPath>
      </text>
    </svg>
  );
}

export function LinkTicket({
  serial,
  intent,
  publisher,
  bounds,
  networks = [],
  url,
  href,
  expires,
  uses,
  note = DEFAULT_NOTE,
  example = false,
  className,
}: LinkTicketProps) {
  const usesLeft = uses ? Math.max(0, uses.max - uses.used) : null;
  return (
    <TicketShell
      label={`Intent link ${serial}`}
      kind="link"
      state={publisher.verified ? "verified" : "unverified"}
      className={className}
      main={
        <>
          <TicketHead icon="route" title="Kletia intent link" serial={serial} example={example} />

          <p className="kla-ticket__eyebrow">Published by</p>
          <p className="kla-linkt__publisher">
            <span className="kla-linkt__name">{publisher.name}</span>
            {publisher.domain ? <span className="kla-linkt__domain">{publisher.domain}</span> : null}
            {publisher.verified ? (
              <span className="kla-linkt__badge kla-linkt__badge--ok">Verified domain</span>
            ) : (
              <span className="kla-linkt__badge kla-linkt__badge--warn">Unverified publisher</span>
            )}
          </p>

          <p className="kla-ticket__eyebrow">Fills in</p>
          <p className="kla-ticket__intent">“{intent}”</p>

          <p className="kla-ticket__eyebrow">Bounds Kletia enforces</p>
          <dl className="kla-linkt__bounds">
            {bounds.map((bound) => (
              <div key={bound.label}>
                <dt>{bound.label}</dt>
                <dd>{bound.value}</dd>
              </div>
            ))}
            {networks.length ? (
              <div>
                <dt>Networks</dt>
                <dd className="kla-linkt__lines">
                  {networks.map((line) => (
                    <LineBullet key={line.key} line={line} />
                  ))}
                </dd>
              </div>
            ) : null}
          </dl>

          <p className="kla-linkt__url">
            {href ? (
              <a className="kla-link" href={href}>
                {url}
              </a>
            ) : (
              url
            )}
          </p>
          <p className="kla-linkt__note">{note}</p>
        </>
      }
      stub={
        <>
          {expires ? (
            <>
              <p className="kla-ticket__stub-k">Valid until</p>
              <p className="kla-linkt__expires">{expires}</p>
            </>
          ) : (
            <p className="kla-ticket__stub-k">No expiry</p>
          )}
          {uses ? (
            <>
              <p className="kla-ticket__stub-k kla-linkt__uses-k">Uses</p>
              <p className="kla-linkt__uses">
                {usesLeft} of {uses.max} left
              </p>
              <Punches total={uses.max} punched={uses.used} />
            </>
          ) : null}
          {publisher.verified ? <Seal /> : <span className="kla-linkt__hazard" aria-hidden="true" />}
        </>
      }
    />
  );
}
