import "../../site/art/base.css";
import "../../site/art/ticket.css";
import "./receipt.css";

import { Fragment, type ReactNode } from "react";

import { LineBullet } from "../../site/art/LineBullet";
import { Stamp } from "../../site/art/Stamp";
import { Punches, TicketFields, TicketHead, type TicketField } from "../../site/art/TicketShell";
import { shortHash } from "../../site/art/ticketFormat";
import { lineFor } from "../../site/art/tokens";
import {
  anchorExplorerUrl,
  anchorRef,
  anchorWhere,
  formatDay,
  formatReceiptAmount,
  formatTime,
  issueLine,
  networkLabel,
  shortKid,
  type LegModel,
  type OfflineVerdict,
  type ReceiptModel,
} from "./receiptModel";
import { receiptSerial } from "./receiptLink";
import { LoggedStamp, RecheckedStamp, SealedStamp, VerifiedStamp, VoidStamp } from "./receiptStamps";
import type { ShareState } from "./useReceipt";

/*
 * The through ticket. Left, the control coupon: what Kletia signed, readable
 * by anyone holding the receipt id while it is shared (networks, step kinds,
 * venues, tokens, statuses, the day). Right, behind the perforation, the
 * passenger coupon: the details the owner chose to show through this link,
 * decrypted in this browser, or a wax seal where they kept them sealed.
 * Every value is printed as text; the only links are https explorer pages.
 */

export interface ReceiptTicketProps {
  readonly model: ReceiptModel;
  readonly verdict: OfflineVerdict;
  readonly share: ShareState;
  readonly supersededBy: string | null;
  /** Set after a recheck in which every transaction matched. */
  readonly rechecked: { readonly day: string; readonly sources: number } | null;
  readonly animate: boolean;
}

function NetworkMark({ network }: { readonly network: string }) {
  const line = lineFor(network);
  return line ? <LineBullet line={line} /> : <span>{networkLabel(network)}</span>;
}

const STATUS_SENTENCE: Readonly<Record<ReceiptModel["status"], string>> = {
  completed: "Completed",
  partially_completed: "Partly completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

function statusLine(model: ReceiptModel): string {
  const took = model.duration ? `, ${model.duration} after the first transaction` : "";
  const final = model.terminal ? " Final." : " Not final: a retried step would get a new issue.";
  return `${STATUS_SENTENCE[model.status]} on ${formatDay(model.finishedOn)}${took}.${final}`;
}

function LegRow({ leg, hasDetails }: { readonly leg: LegModel; readonly hasDetails: boolean }) {
  const assets = [leg.input, leg.output].filter(Boolean).join(" → ");
  const mark = leg.mark === "seen" ? "✓" : leg.mark === "failed" ? "✕" : leg.mark === "skipped" ? "–" : "·";
  return (
    <li className="kl-rcpt__leg" data-mark={leg.mark}>
      <span className="kla-ticket__leg-no" aria-hidden="true">
        {String(leg.index + 1).padStart(2, "0")}
      </span>
      <span className="kl-rcpt__leg-what">
        <span className="kla-sr">Leg {leg.index + 1}: </span>
        <NetworkMark network={leg.network} />
        {leg.destination ? (
          <>
            <span aria-hidden="true">→ </span>
            <span className="kla-sr">to </span>
            <NetworkMark network={leg.destination} />
          </>
        ) : null}
        <strong>{leg.verb}</strong>
        {assets ? ` ${assets}` : ""}
        <span className="kl-rcpt__via"> via {leg.via}</span>
      </span>
      <span className="kl-rcpt__mark">
        <span aria-hidden="true">{mark}</span>
        <span className="kla-sr">, {leg.statusWords}</span>
      </span>
      {leg.contract ? (
        <span className="kl-rcpt__leg-note">
          Custom contract by <strong>{leg.contract.integrator}</strong> ({leg.contract.domainVerified ? "domain verified" : "domain not verified"}), revision {leg.contract.revision}
          {leg.contract.function ? `, ${leg.contract.function}` : ""}. Not audited by Kletia.
        </span>
      ) : null}
      {leg.failureCode ? (
        <span className="kl-rcpt__leg-note">
          Stopped with <strong>{leg.failureCode}</strong>
          {hasDetails && leg.evidence?.failure?.message ? `: ${leg.evidence.failure.message}` : "."}
        </span>
      ) : null}
    </li>
  );
}

function Sealed({ children }: { readonly children: ReactNode }) {
  return (
    <p className="kl-rcpt__sealed">
      <SealedStamp small />
      <span>{children}</span>
    </p>
  );
}

function Rows({ rows }: { readonly rows: readonly (readonly [string, ReactNode | null])[] }) {
  const shown = rows.filter((row): row is readonly [string, ReactNode] => row[1] !== null && row[1] !== undefined && row[1] !== "");
  if (shown.length === 0) return null;
  return (
    <dl className="kl-rcpt__rows">
      {shown.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function shortAccount(account: string | null): string | null {
  if (!account) return null;
  const address = account.slice(account.lastIndexOf(":") + 1);
  return address.length > 16 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

function LegDetails({ leg }: { readonly leg: LegModel }) {
  const amounts = leg.amounts;
  const parties = leg.parties;
  const evidence = leg.evidence;
  const amountRows: (readonly [string, ReactNode | null])[] = amounts
    ? [
        ["Sent", formatReceiptAmount(amounts.input)],
        ["Received", formatReceiptAmount(amounts.actualOutput)],
        ["Expected", amounts.actualOutput ? null : formatReceiptAmount(amounts.expectedOutput)],
        ["At least", formatReceiptAmount(amounts.minimumOutput)],
        ["Fees", amounts.feesUsd ? `$${Number(amounts.feesUsd).toFixed(2)}` : null],
      ]
    : [];
  const partyRows: (readonly [string, ReactNode | null])[] = parties
    ? [
        ["From", parties.account ? <span className="kl-rcpt__mono" title={parties.account}>{shortAccount(parties.account)}</span> : null],
        [
          "To",
          parties.recipient ? (
            <span className="kl-rcpt__mono" title={parties.recipient}>
              {parties.recipientName ? `${parties.recipientName} · ` : ""}
              {shortAccount(parties.recipient)}
            </span>
          ) : null,
        ],
        ["Paid out to", parties.destinationAccount ? <span className="kl-rcpt__mono" title={parties.destinationAccount}>{shortAccount(parties.destinationAccount)}</span> : null],
      ]
    : [];
  return (
    <div className="kl-rcpt__group">
      <p className="kl-rcpt__group-k">
        Leg {String(leg.index + 1).padStart(2, "0")} · {leg.verb}
      </p>
      {amounts ? <Rows rows={amountRows} /> : <Sealed>Amounts sealed by the owner.</Sealed>}
      {parties ? <Rows rows={partyRows} /> : null}
      {evidence ? (
        evidence.anchors.length > 0 ? (
          <ul className="kl-rcpt__rows">
            {evidence.anchors.map((anchor) => {
              const href = anchorExplorerUrl(anchor);
              const ref = anchorRef(anchor);
              return (
                <li key={`${anchor.role}:${ref}`} className="kl-rcpt__mono">
                  {anchor.role === "fill" ? "Fill " : "Tx "}
                  {href ? (
                    <a className="kla-link" href={href} target="_blank" rel="noopener noreferrer">
                      {shortHash(ref)}
                      <span className="kla-sr"> (opens the explorer in a new tab)</span>
                    </a>
                  ) : (
                    <span title={ref}>{shortHash(ref)}</span>
                  )}{" "}
                  · {anchorWhere(anchor)}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="kl-rcpt__pcount">No transaction for this leg.</p>
        )
      ) : leg.evidenceClass !== "none" ? (
        <Sealed>Transactions sealed by the owner.</Sealed>
      ) : null}
    </div>
  );
}

function shareMessage(share: ShareState): string | null {
  switch (share.kind) {
    case "none":
      return "This link carries no key, so only the signed route is shown. Ask the owner for the full link.";
    case "invalid":
      return "The key in this link is damaged or incomplete. Copy the whole link, including everything after #.";
    case "revoked":
      return "The owner revoked this link. Its details no longer open.";
    case "expired":
      return "This link expired. Its details no longer open.";
    case "locked":
      return "The key in this link does not open the stored details.";
    case "unavailable":
      return "The shared details could not be loaded right now. The signed part is still checked below.";
    default:
      return null;
  }
}

function PassengerCoupon({ model, verdict, share, rechecked, animate }: Pick<ReceiptTicketProps, "model" | "verdict" | "share" | "rechecked" | "animate">) {
  const message = shareMessage(share);
  const open = share.kind === "open" && verdict.kind === "verified";
  const detailsVoid = share.kind === "open" && verdict.kind === "void";
  const total = model.shown.length + model.sealed.length;
  const evidenceShown = model.legs.some((leg) => leg.evidence !== null);
  const seenLegs = model.legs.filter((leg) => leg.mark === "seen").length;
  return (
    <section className="kl-rcpt__coupon kl-rcpt__passenger" aria-labelledby="kl-rcpt-passenger">
      <p className="kl-rcpt__pk">Passenger coupon</p>
      <h2 id="kl-rcpt-passenger" className="kl-rcpt__ptitle">
        Shown by the owner
      </h2>
      {open ? (
        <p className="kl-rcpt__pcount">
          {model.shown.length} of {total} details shown{model.shown.length === 0 ? ": the owner shared the route only" : ""}.
        </p>
      ) : null}
      {message ? <p className="kl-rcpt__notice">{message}</p> : null}
      {detailsVoid ? (
        <>
          <p className="kl-rcpt__notice">The details in this link do not match what Kletia signed, so they are not shown.</p>
          <ul className="kl-rcpt__problems">
            {verdict.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </>
      ) : null}
      {open ? (
        <>
          <div className="kl-rcpt__group">
            <p className="kl-rcpt__group-k">You asked for</p>
            {model.sentence ? <p className="kl-rcpt__said">“{model.sentence}”</p> : <Sealed>The request is sealed by the owner.</Sealed>}
          </div>
          {model.outcome ? (
            <div className="kl-rcpt__group">
              <p className="kl-rcpt__group-k">Outcome</p>
              <Rows
                rows={[
                  ["Paid", model.outcome.inputs.map((amount) => formatReceiptAmount(amount)).filter(Boolean).join(", ") || null],
                  ["Received", model.outcome.outputs.map((amount) => formatReceiptAmount(amount)).filter(Boolean).join(", ") || null],
                  ["Fees", model.outcome.totalFeesUsd ? `$${Number(model.outcome.totalFeesUsd).toFixed(2)}` : null],
                ]}
              />
            </div>
          ) : null}
          {model.legs.map((leg) => (
            <LegDetails key={leg.id} leg={leg} />
          ))}
          {model.timing ? (
            <div className="kl-rcpt__group">
              <p className="kl-rcpt__group-k">Times</p>
              <Rows
                rows={[
                  ["Planned", formatTime(model.timing.createdAt)],
                  ["First sent", model.timing.firstSubmittedAt ? formatTime(model.timing.firstSubmittedAt) : null],
                  ["Finished", formatTime(model.timing.finishedAt)],
                  ["Issued", formatTime(model.timing.issuedAt)],
                ]}
              />
            </div>
          ) : null}
          {evidenceShown ? <p className="kl-rcpt__notice">Showing transactions reveals the addresses that sent them.</p> : null}
        </>
      ) : null}
      <Punches total={model.legs.length} punched={seenLegs} />
      {rechecked ? (
        <div className="kl-rcpt__pstamp">
          <RecheckedStamp day={rechecked.day} sources={rechecked.sources} animate={animate} />
        </div>
      ) : null}
    </section>
  );
}

export function ReceiptTicket({ model, verdict, share, supersededBy, rechecked, animate }: ReceiptTicketProps) {
  const fields: TicketField[] = [
    { label: "Class", value: model.lane === "production" ? "Live" : "Test networks" },
    { label: "Finished", value: formatDay(model.finishedOn) },
    { label: "Finality", value: model.finalized ? "Finalized on-chain" : "No transaction" },
    { label: "Issued", value: formatDay(model.issuedOn) },
    { label: "Signed by", value: <span title={model.kid}>Kletia key {shortKid(model.kid)}</span> },
  ];
  if (model.duration) fields.splice(2, 0, { label: "Took", value: model.duration });
  const voided = verdict.kind === "void";
  const hasDetails = share.kind === "open" && !voided;
  return (
    <div className="kl-rcpt">
      <div className="kl-rcpt__ticket" data-void={(voided && !verdict.signatureValid) || undefined}>
        <article className="kl-rcpt__coupon kl-rcpt__control" aria-label={`Receipt ${receiptSerial(model.receiptId)}, issue ${model.sequence}`}>
          <TicketHead icon="verify" title="Kletia receipt" serial={`${receiptSerial(model.receiptId)} · ${model.sequence}`} />
          <p className="kla-ticket__eyebrow kl-rcpt__k">Control coupon · signed by Kletia</p>
          <p className="kl-rcpt__issue">{issueLine(model, supersededBy)}</p>
          <p className="kl-rcpt__status">{statusLine(model)}</p>
          <p className="kl-rcpt__route">
            <span className="kla-sr">Networks: {model.networks.map(networkLabel).join(", ")}</span>
            {model.networks.map((network, index) => (
              <Fragment key={network}>
                {index > 0 ? <span className="kl-rcpt__track" aria-hidden="true" /> : null}
                <span aria-hidden="true">
                  <NetworkMark network={network} />
                </span>
              </Fragment>
            ))}
          </p>
          <p className="kla-ticket__eyebrow kl-rcpt__k">Legs</p>
          <ol className="kl-rcpt__legs">
            {model.legs.map((leg) => (
              <LegRow key={leg.id} leg={leg} hasDetails={hasDetails} />
            ))}
          </ol>
          <TicketFields fields={fields} className="kl-rcpt__fields" />
          <div className="kl-rcpt__stamps">
            <span className="kla-sr">
              {voided ? `Void: ${verdict.sentence}` : "Verified: Kletia's signature checks out."} {model.outcomeStamp.words}
              {model.inclusion ? ` Logged in Kletia's transparency log, batch ${model.inclusion.batch}${model.inclusion.anchored ? ", anchored on Base" : ""}.` : ""}
            </span>
            {voided ? <VoidStamp detail={verdict.stamp} animate={animate} /> : <VerifiedStamp detail={verdict.stamp} animate={animate} />}
            <Stamp state={model.outcomeStamp.state} detail={model.outcomeStamp.detail} animate={animate} delayMs={120} />
            {model.inclusion ? <LoggedStamp batch={model.inclusion.batch} anchored={model.inclusion.anchored} animate={animate} delayMs={240} /> : null}
          </div>
        </article>
        <PassengerCoupon model={model} verdict={verdict} share={share} rechecked={rechecked} animate={animate} />
      </div>
    </div>
  );
}
