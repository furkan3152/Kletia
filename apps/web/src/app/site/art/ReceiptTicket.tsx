import "./base.css";
import "./ticket.css";

import { Stamp } from "./Stamp";
import { STAMP_SENTENCES } from "./stampText";
import { countOf, legNumber, shortHash } from "./ticketFormat";
import { LineBullet } from "./LineBullet";
import { Punches, TicketFields, TicketHead, TicketShell, type TicketField } from "./TicketShell";
import type { Line } from "./tokens";

/*
 * Receipt: the intent ticket after the trip, with one evidence row per leg
 * (network, transaction, block or slot, event) and the outcome stamped on the
 * stub: a cut-corner SETTLED plate or a FAILED octagon. Built for verifiable
 * receipts: the digest and the signing key are printed along the bottom so a
 * reader can check the receipt against the API.
 */

export type EvidenceStatus = "seen" | "pending" | "reverted" | "missing";

export interface EvidenceRow {
  readonly line: Line;
  /** Bold verb, e.g. "Bridge". */
  readonly verb: string;
  /** The rest of the leg, e.g. "50 USDC, Base → Solana". */
  readonly detail: string;
  /** Transaction hash or signature (printed shortened). */
  readonly tx?: string;
  /** Explorer link for `tx`. */
  readonly href?: string;
  /** Where it was seen, e.g. "Block 21 004 112" or "Slot 290 112 004". */
  readonly where?: string;
  /** The event or instruction that proves the leg, e.g. "FundsDeposited". */
  readonly event?: string;
  readonly status: EvidenceStatus;
}

export interface ReceiptTicketProps {
  readonly serial: string;
  /** The sentence as the user wrote it. */
  readonly intent: string;
  readonly outcome: "settled" | "failed";
  readonly evidence: readonly EvidenceRow[];
  /** Pre-formatted issue time, e.g. "09 Oct 2026, 10:42 UTC". */
  readonly issued: string;
  /** Receipt digest, e.g. "sha256:9c1e…" (printed shortened, full value in a title). */
  readonly digest?: string;
  /** Who signed the receipt, e.g. a key id. */
  readonly signer?: string;
  /** Extra fields after Issued, Digest and Signed by. */
  readonly fields?: readonly TicketField[];
  /** Small print on the stamp (e.g. the final block). */
  readonly stampDetail?: string;
  readonly example?: boolean;
  readonly animateStamp?: boolean;
  readonly className?: string;
}

const MARK: Readonly<Record<EvidenceStatus, { readonly glyph: string; readonly words: string }>> = {
  seen: { glyph: "✓", words: "seen on-chain" },
  pending: { glyph: "·", words: "waiting for evidence" },
  reverted: { glyph: "✕", words: "reverted" },
  missing: { glyph: "?", words: "no evidence found" },
};

export function ReceiptTicket({
  serial,
  intent,
  outcome,
  evidence,
  issued,
  digest,
  signer,
  fields = [],
  stampDetail,
  example = false,
  animateStamp = false,
  className,
}: ReceiptTicketProps) {
  const seen = evidence.filter((row) => row.status === "seen").length;
  const printed: TicketField[] = [{ label: "Issued", value: issued }];
  if (digest) printed.push({ label: "Digest", value: <span title={digest}>{shortHash(digest, 13, 6)}</span> });
  if (signer) printed.push({ label: "Signed by", value: signer });
  return (
    <TicketShell
      label={`Receipt ${serial}`}
      kind="receipt"
      state={outcome}
      className={className}
      main={
        <>
          <TicketHead icon="verify" title="Kletia receipt" serial={serial} example={example} />
          <p className="kla-ticket__eyebrow">Receipt for</p>
          <p className="kla-ticket__intent">“{intent}”</p>

          <p className="kla-ticket__eyebrow kla-receipt__k">Evidence</p>
          <ol className="kla-ticket__legs kla-receipt__rows">
            {evidence.map((row, index) => (
              <li key={index} className="kla-receipt__row" data-status={row.status}>
                <span className="kla-ticket__leg-no" aria-hidden="true">
                  {legNumber(index)}
                </span>
                <span className="kla-receipt__what">
                  <LineBullet line={row.line} className="kla-receipt__bullet" />
                  <span>
                    <strong>{row.verb}</strong> {row.detail}
                  </span>
                </span>
                <span className="kla-ticket__leg-mark">
                  <span aria-hidden="true">{MARK[row.status].glyph}</span>
                  <span className="kla-sr">{MARK[row.status].words}</span>
                </span>
                {row.tx || row.where || row.event ? (
                  <span className="kla-receipt__proof">
                    {row.tx ? (
                      row.href ? (
                        <a className="kla-link kla-receipt__tx" href={row.href} target="_blank" rel="noreferrer noopener">
                          <span className="kla-sr">Leg {index + 1} transaction </span>
                          tx {shortHash(row.tx)}
                          <span className="kla-sr"> (opens the explorer)</span>
                        </a>
                      ) : (
                        <span className="kla-receipt__tx" title={row.tx}>
                          tx {shortHash(row.tx)}
                        </span>
                      )
                    ) : null}
                    {row.where ? <span>{row.where}</span> : null}
                    {row.event ? <span className="kla-receipt__event">{row.event}</span> : null}
                  </span>
                ) : null}
              </li>
            ))}
          </ol>

          <TicketFields fields={[...printed, ...fields]} className="kla-receipt__fields" />
        </>
      }
      stub={
        <>
          <p className="kla-ticket__stub-k">Evidence</p>
          <p className="kla-ticket__stub-n kla-receipt__count">
            <span aria-hidden="true">{countOf(seen, evidence.length)}</span>
            <span className="kla-sr">
              {seen} of {evidence.length} legs seen on-chain
            </span>
          </p>
          <Punches total={evidence.length} punched={seen} />
          <p className="kla-sr">{STAMP_SENTENCES[outcome]}</p>
          <Stamp state={outcome} detail={stampDetail} animate={animateStamp} className="kla-ticket__stamp" />
        </>
      }
    />
  );
}
