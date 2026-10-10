import type { Certainty, IntentGraph, IntentPreview, PreviewIssue } from "@kletia/core";
import { CERTAINTY_INFO, fareChangeLines, fareModel, type FareMoney, type FareRow } from "./review.js";

/** Certainty by shape (never by colour alone); the label is read with the number. */
export function CertaintyGlyph({ certainty }: { readonly certainty: Certainty }) {
  const shape = CERTAINTY_INFO[certainty].shape;
  return (
    <svg className="kw-glyph" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
      {shape === "dot" ? <circle cx="6" cy="6" r="4.5" fill="currentColor" /> : null}
      {shape === "half" ? (
        <>
          <circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6 1.75a4.25 4.25 0 0 1 0 8.5z" fill="currentColor" />
        </>
      ) : null}
      {shape === "ring" ? <circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" /> : null}
      {shape === "diamond" ? <path d="M6 1.2 10.8 6 6 10.8 1.2 6z" fill="none" stroke="currentColor" strokeWidth="1.5" /> : null}
      {shape === "dashed" ? <circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 1.6" /> : null}
    </svg>
  );
}

function Money({ value, plate }: { readonly value: FareMoney; readonly plate?: string }) {
  // The glyph and its amount never part: the amount (or the plate) wraps inside its own box.
  const body = (
    <span className="kw-fare-body">
      <span className="kw-fare-amt">
        {value.amount} {value.symbol}
      </span>
      <span className="kw-fare-usd">{value.usd ?? "price unavailable"}</span>
    </span>
  );
  return (
    <span className="kw-fare-money" title={CERTAINTY_INFO[value.certainty].sentence}>
      <CertaintyGlyph certainty={value.certainty} />
      <span className="kw-sr">{CERTAINTY_INFO[value.certainty].spoken}: </span>
      {plate ? (
        <span className="kw-plate">
          {plate} {body}
        </span>
      ) : (
        body
      )}
    </span>
  );
}

function RowLine({ row, kind }: { readonly row: FareRow; readonly kind: "pay" | "get" }) {
  return (
    <li className="kw-fare-row">
      <span className="kw-fare-net" title={row.account}>
        {row.networkName}
        {row.accountLabel ? <span className="kw-fare-acct"> · {row.accountLabel}</span> : null}
      </span>
      <span className="kw-fare-vals">
        <Money value={row.expected} />
        {row.note ? <span className="kw-fare-note">{row.note}</span> : null}
        {kind === "get" ? <span className="kw-fare-note">expected</span> : null}
        {row.bound ? <Money value={row.bound} plate={kind === "get" ? "At least" : "Up to"} /> : null}
        {row.unlisted ? <span className="kw-fare-note">not in Kletia's asset list</span> : null}
      </span>
    </li>
  );
}

export interface FareBreakdownProps {
  readonly preview: IntentPreview;
  /** Numbers the legs ("network fee, leg 2"). */
  readonly intent?: Pick<IntentGraph, "steps"> | null;
  /** The fare the user approved before; printed struck through above the new one. */
  readonly previous?: IntentPreview | null;
  /** What got worse (`PREVIEW_CHANGED` changes). */
  readonly changes?: readonly PreviewIssue[];
  readonly className?: string;
}

/**
 * The fare breakdown: everything that leaves the user's wallets, what
 * arrives where (expected and at least), fees in USD, allowances, what the
 * wallets must hold and how each number was obtained.
 */
export function FareBreakdown({ preview, intent, previous, changes, className }: FareBreakdownProps) {
  const fare = fareModel(preview, intent);
  const before = previous ? fareModel(previous, intent) : null;
  const changeLines = fareChangeLines(changes);
  return (
    <section className={`kw-fare${className ? ` ${className}` : ""}`} aria-label="Fare breakdown">
      <div className="kw-fare-head">
        <span>Fare</span>
        <span>
          {fare.legs} leg{fare.legs === 1 ? "" : "s"}
          {fare.networkChanges > 0 ? ` · ${fare.networkChanges} network change${fare.networkChanges === 1 ? "" : "s"}` : ""}
        </span>
      </div>
      {before ? (
        <div className="kw-fare-changed" role="alert">
          <p className="kw-fare-k">The fare changed since you approved it.</p>
          <p className="kw-fare-old">
            <span className="kw-sr">Previous fare: </span>
            <s>
              {[...before.youPay.map((row) => `pay ${row.expected.amount} ${row.expected.symbol}`), ...before.youGet.map((row) => `get at least ${(row.bound ?? row.expected).amount} ${row.expected.symbol}`)].join(" · ") ||
                "previous fare"}
            </s>
          </p>
          {changeLines.length > 0 ? (
            <ul className="kw-fare-list">
              {changeLines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {fare.basisNote ? <p className="kw-fare-basis">{fare.basisNote}</p> : null}
      {fare.youPay.length > 0 ? (
        <div className="kw-fare-sec">
          <p className="kw-fare-k">You pay</p>
          <ul className="kw-fare-rows">
            {fare.youPay.map((row) => (
              <RowLine key={row.key} row={row} kind="pay" />
            ))}
          </ul>
        </div>
      ) : null}
      {fare.youGet.length > 0 ? (
        <div className="kw-fare-sec">
          <p className="kw-fare-k">You get</p>
          <ul className="kw-fare-rows">
            {fare.youGet.map((row) => (
              <RowLine key={row.key} row={row} kind="get" />
            ))}
          </ul>
        </div>
      ) : null}
      {fare.paidToOthers.length > 0 ? (
        <div className="kw-fare-sec">
          <p className="kw-fare-k">Paid to others</p>
          <ul className="kw-fare-rows">
            {fare.paidToOthers.map((payment) => (
              <li key={payment.key} className="kw-fare-row">
                <span className="kw-fare-net">{payment.networkName}</span>
                <span className="kw-fare-vals">
                  <Money value={payment.expected} />
                  {payment.atLeast ? <Money value={payment.atLeast} plate="At least" /> : null}
                  <span className="kw-fare-addr">
                    to {payment.recipientName ? `${payment.recipientName}, ` : ""}
                    <code>{payment.recipient}</code>
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {fare.passesThrough.length > 0 ? (
        <details className="kw-fare-sec kw-fare-transit">
          <summary className="kw-fare-k">Passes through your wallets ({fare.passesThrough.length})</summary>
          <ul className="kw-fare-rows">
            {fare.passesThrough.map((row) => (
              <li key={row.key} className="kw-fare-row">
                <span className="kw-fare-net">{row.networkName}</span>
                <span className="kw-fare-vals">
                  <CertaintyGlyph certainty={row.certainty} />
                  <span className="kw-sr">{CERTAINTY_INFO[row.certainty].spoken}: </span>
                  <span>{row.text}</span>
                  {row.legs ? <span className="kw-fare-note">used by {row.legs}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {fare.fees.length > 0 ? (
        <div className="kw-fare-sec">
          <p className="kw-fare-k">Fees</p>
          <ul className="kw-fare-rows">
            {fare.fees.map((fee) => (
              <li key={fee.key} className="kw-fare-row">
                <span className="kw-fare-net">{fee.label}</span>
                <span className="kw-fare-vals">
                  <CertaintyGlyph certainty={fee.certainty} />
                  <span className="kw-sr">{CERTAINTY_INFO[fee.certainty].spoken}: </span>
                  <span className="kw-fare-usd">{fee.usd ?? "price unavailable"}</span>
                  {fee.detail ? <span className="kw-fare-note">{fee.detail}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {fare.allowances.length > 0 ? (
        <div className="kw-fare-sec">
          <p className="kw-fare-k">You allow</p>
          <ul className="kw-fare-rows">
            {fare.allowances.map((allowance) => (
              <li key={allowance.key} className="kw-fare-row">
                <span className="kw-fare-net">{allowance.networkName}</span>
                <span className="kw-fare-vals">
                  <span title={allowance.spender}>
                    {allowance.spenderLabel} may spend {allowance.amount}
                  </span>
                  <span className={allowance.leftover ? "kw-fare-note kw-warn" : "kw-fare-note"}>{allowance.left}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {fare.bring.length > 0 ? (
        <div className="kw-fare-sec">
          <p className="kw-fare-k">Bring</p>
          <ul className="kw-fare-list">
            {fare.bring.map((need) => (
              <li key={need.key} className={need.reason === "gas-on-arrival" ? "kw-fare-need" : undefined}>
                {need.reason === "gas-on-arrival" ? <span aria-hidden="true">⚠ </span> : null}
                {need.text}
                {need.have ? ` (you have ${need.have})` : ""}.
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {fare.arrival ? (
        <p className="kw-fare-line">
          <span className="kw-fare-k">Arrives</span> {fare.arrival}
        </p>
      ) : null}
      {fare.blocking.length > 0 ? (
        <ul className="kw-fare-list kw-error" role="alert">
          {fare.blocking.map((issue, position) => (
            <li key={`${issue.code}-${position}`}>Kletia will not sign this: {issue.message || issue.code}</li>
          ))}
        </ul>
      ) : null}
      {fare.warnings.length > 0 ? (
        <ul className="kw-fare-list">
          {fare.warnings.map((warning) => (
            <li key={warning} className="kw-warn">
              {warning}
            </li>
          ))}
        </ul>
      ) : null}
      {fare.unpriced.length > 0 ? <p className="kw-fare-basis">No USD price for {fare.unpriced.join(", ")}: totals leave them out.</p> : null}
      {fare.legend.length > 0 ? (
        <ul className="kw-fare-legend" aria-label="How each number was obtained">
          {fare.legend.map((certainty) => (
            <li key={certainty}>
              <CertaintyGlyph certainty={certainty} /> {CERTAINTY_INFO[certainty].label}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export default FareBreakdown;
