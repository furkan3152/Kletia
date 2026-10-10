import "../art/base.css";
import "./fare.css";

import type { Certainty, IntentGraph, IntentPreview, PreviewIssue } from "@kletia/core";
import { CERTAINTY_INFO, fareChangeLines, fareModel, type FareMoney, type FareRow } from "@kletia/widget/review";
import { useId, type ReactNode } from "react";

import { lineFor } from "../art";
import { LineBullet } from "../art/LineBullet";
import { cx } from "../ui/styles";

/**
 * Certainty by shape, never by colour: a dot (simulated), a half-filled
 * ring (simulated, funds assumed), a diamond (venue minimum), a ring
 * (quoted), a dashed ring (estimated). Decorative: the label is read with
 * the number.
 */
export function CertaintyMark({ certainty, className }: { readonly certainty: Certainty; readonly className?: string }) {
  const shape = CERTAINTY_INFO[certainty].shape;
  return (
    <svg className={cx("klf__mark", className)} viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      {shape === "dot" ? <circle cx="6" cy="6" r="4.6" fill="currentColor" /> : null}
      {shape === "half" ? (
        <>
          <circle cx="6" cy="6" r="4.3" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M6 1.7a4.3 4.3 0 0 1 0 8.6z" fill="currentColor" />
        </>
      ) : null}
      {shape === "ring" ? <circle cx="6" cy="6" r="4.3" fill="none" stroke="currentColor" strokeWidth="1.6" /> : null}
      {shape === "diamond" ? <path d="M6 1.1 10.9 6 6 10.9 1.1 6z" fill="none" stroke="currentColor" strokeWidth="1.6" /> : null}
      {shape === "dashed" ? <circle cx="6" cy="6" r="4.3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="2 1.6" /> : null}
    </svg>
  );
}

function Spoken({ certainty }: { readonly certainty: Certainty }) {
  return <span className="kla-sr">{CERTAINTY_INFO[certainty].spoken}: </span>;
}

function Usd({ value }: { readonly value: string | null }) {
  return value ? <span className="klf__usd">{value}</span> : <span className="klf__usd klf__usd--none">price unavailable</span>;
}

function Network({ network, name, account, accountLabel }: { readonly network: string; readonly name: string; readonly account?: string; readonly accountLabel?: string | null }) {
  const line = lineFor(network);
  return (
    <span className="klf__net" title={account}>
      {line ? <LineBullet line={line} decorative /> : null}
      <span>
        {name}
        {accountLabel ? <span className="klf__acct"> · {accountLabel}</span> : null}
      </span>
    </span>
  );
}

function Amount({ value }: { readonly value: FareMoney }) {
  return (
    <span className="klf__amt" title={CERTAINTY_INFO[value.certainty].sentence}>
      <CertaintyMark certainty={value.certainty} /> <Spoken certainty={value.certainty} />
      {value.amount} {value.symbol}
    </span>
  );
}

function MoneyRow({ row, kind }: { readonly row: FareRow; readonly kind: "pay" | "get" }) {
  return (
    <li className="klf__row">
      <Network network={row.network} name={row.networkName} account={row.account} accountLabel={row.accountLabel} />
      <span className="klf__val">
        <Amount value={row.expected} />
        {kind === "get" ? <span className="klf__note">expected</span> : null}
        {row.note ? <span className="klf__note">{row.note}</span> : null}
        {row.unlisted ? <span className="klf__note">not in Kletia's asset list</span> : null}
      </span>
      <Usd value={row.expected.usd} />
      {row.bound ? (
        <span className="klf__bound">
          <span className="klf__plate" title={CERTAINTY_INFO[row.bound.certainty].sentence}>
            <b>{kind === "get" ? "At least" : "Up to"}</b>
            <span>
              <CertaintyMark certainty={row.bound.certainty} /> <Spoken certainty={row.bound.certainty} />
              {row.bound.amount} {row.bound.symbol}
            </span>
          </span>
          <Usd value={row.bound.usd} />
        </span>
      ) : null}
    </li>
  );
}

function Section({ label, children, id }: { readonly label: string; readonly children: ReactNode; readonly id: string }) {
  return (
    <div className="klf__sec">
      <p className="klf__k" id={id}>
        {label}
      </p>
      <ul className="klf__rows" aria-labelledby={id}>
        {children}
      </ul>
    </div>
  );
}

export interface FareTableProps {
  readonly preview: IntentPreview;
  /** Numbers the legs ("network fee, leg 2"). */
  readonly intent?: Pick<IntentGraph, "steps"> | null;
  /** The fare the user approved before: printed struck through, with what got worse. */
  readonly previous?: IntentPreview | null;
  readonly changes?: readonly PreviewIssue[];
  readonly className?: string;
}

/**
 * The fare breakdown ("tariff table") under the ticket: what leaves your
 * wallets, what arrives where (expected, and at least on a yellow plate),
 * money that only passes through your wallets (collapsed), fees in USD,
 * what you allow, what to bring (gas on arrival) and when it arrives.
 * Every number carries how it was obtained, by shape and in words.
 * Presentational: it renders `IntentPreview` from `@kletia/core` as given.
 */
export function FareTable({ preview, intent, previous, changes, className }: FareTableProps) {
  const fare = fareModel(preview, intent);
  const before = previous ? fareModel(previous, intent) : null;
  const changeLines = fareChangeLines(changes);
  const id = useId().replace(/:/gu, "");
  const oldText = before
    ? [
        ...before.youPay.map((row) => `you pay ${row.expected.amount} ${row.expected.symbol}`),
        ...before.youGet.map((row) => `you get at least ${(row.bound ?? row.expected).amount} ${row.expected.symbol}`),
      ].join(" · ")
    : "";
  return (
    <section className={cx("klf", className)} aria-label="Fare breakdown">
      <div className="klf__head">
        <span className="klf__title">Fare</span>
        <span>
          {fare.legs} leg{fare.legs === 1 ? "" : "s"}
          {fare.networkChanges > 0 ? ` · ${fare.networkChanges} network change${fare.networkChanges === 1 ? "" : "s"}` : ""}
          {fare.totals.cost ? ` · cost ${fare.totals.cost}` : ""}
        </span>
      </div>
      <div className="klf__body">
        {before ? (
          <div className="klf__changed" role="alert">
            <p>The fare changed since you approved it.</p>
            {oldText ? (
              <p>
                <span className="kla-sr">Previous fare, no longer valid: </span>
                <s>{oldText}</s>
              </p>
            ) : null}
            {changeLines.length > 0 ? (
              <ul>
                {changeLines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {fare.basisNote ? <p className="klf__basis">{fare.basisNote}</p> : null}

        {fare.youPay.length > 0 ? (
          <Section label="You pay" id={`${id}-pay`}>
            {fare.youPay.map((row) => (
              <MoneyRow key={row.key} row={row} kind="pay" />
            ))}
          </Section>
        ) : null}
        {fare.youGet.length > 0 ? (
          <Section label="You get" id={`${id}-get`}>
            {fare.youGet.map((row) => (
              <MoneyRow key={row.key} row={row} kind="get" />
            ))}
          </Section>
        ) : null}
        {fare.paidToOthers.length > 0 ? (
          <Section label="Paid to others" id={`${id}-others`}>
            {fare.paidToOthers.map((payment) => (
              <li key={payment.key} className="klf__row">
                <span className="klf__net">{payment.networkName}</span>
                <span className="klf__val">
                  <Amount value={payment.expected} />
                  <span className="klf__note">expected</span>
                </span>
                <Usd value={payment.expected.usd} />
                {payment.atLeast ? (
                  <span className="klf__bound">
                    <span className="klf__plate">
                      <b>At least</b>
                      <span>
                        {payment.atLeast.amount} {payment.atLeast.symbol}
                      </span>
                    </span>
                    <Usd value={payment.atLeast.usd} />
                  </span>
                ) : null}
                <span className="klf__addr">
                  to {payment.recipientName ? `${payment.recipientName}, ` : ""}
                  {payment.recipient}
                </span>
              </li>
            ))}
          </Section>
        ) : null}
        {fare.passesThrough.length > 0 ? (
          <details className="klf__sec klf__transit">
            <summary>Passes through ({fare.passesThrough.length})</summary>
            <ul className="klf__rows">
              {fare.passesThrough.map((row) => (
                <li key={row.key} className="klf__row klf__row--wide">
                  <span className="klf__val">
                    <span className="klf__net">{row.networkName}</span>
                    <span className="klf__amt">
                      <CertaintyMark certainty={row.certainty} /> <Spoken certainty={row.certainty} />
                      {row.text}
                    </span>
                    <span className="klf__note">passes through your wallet{row.legs ? `, used by ${row.legs}` : ""}</span>
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {fare.fees.length > 0 ? (
          <Section label="Fees" id={`${id}-fees`}>
            {fare.fees.map((fee) => (
              <li key={fee.key} className="klf__row klf__row--wide">
                <span className="klf__val">
                  <span className="klf__amt">
                    <CertaintyMark certainty={fee.certainty} /> <Spoken certainty={fee.certainty} />
                    {fee.label}
                  </span>
                  {fee.detail ? <span className="klf__note">{fee.detail}</span> : null}
                </span>
                <Usd value={fee.usd} />
              </li>
            ))}
          </Section>
        ) : null}
        {fare.allowances.length > 0 ? (
          <Section label="You allow" id={`${id}-allow`}>
            {fare.allowances.map((allowance) => (
              <li key={allowance.key} className="klf__row klf__row--wide">
                <span className="klf__val">
                  <span title={allowance.spender}>
                    {allowance.spenderLabel} may spend {allowance.amount} on {allowance.networkName}
                  </span>
                  <span className={allowance.leftover ? "klf__note klf__warn" : "klf__note"}>({allowance.left})</span>
                </span>
              </li>
            ))}
          </Section>
        ) : null}
        {fare.bring.length > 0 ? (
          <Section label="Bring" id={`${id}-bring`}>
            {fare.bring.map((need) => (
              <li key={need.key} className={cx("klf__row klf__row--wide", need.reason === "gas-on-arrival" && "klf__warn")}>
                <span>
                  {need.reason === "gas-on-arrival" ? <span aria-hidden="true">⚠ </span> : null}
                  {need.text}
                  {need.have ? ` (you have ${need.have})` : ""}.
                </span>
              </li>
            ))}
          </Section>
        ) : null}
        {fare.arrival ? (
          <Section label="Arrives" id={`${id}-arrives`}>
            <li className="klf__row klf__row--wide">
              <span>{fare.arrival}</span>
            </li>
          </Section>
        ) : null}
        {fare.warnings.length > 0 ? (
          <ul className="klf__list" aria-label="Fare warnings">
            {fare.warnings.map((warning) => (
              <li key={warning} className="klf__note">
                {warning}
              </li>
            ))}
          </ul>
        ) : null}
        {fare.blocking.length > 0 ? (
          <ul className="klf__block" role="alert">
            {fare.blocking.map((issue, index) => (
              <li key={`${issue.code}-${index}`}>Kletia will not sign this: {issue.message || issue.code}</li>
            ))}
          </ul>
        ) : null}
        {fare.unpriced.length > 0 ? <p className="klf__note">No USD price for {fare.unpriced.join(", ")}: totals leave them out.</p> : null}
        {fare.legend.length > 0 ? (
          <ul className="klf__legend" aria-label="How each number was obtained">
            {fare.legend.map((certainty) => (
              <li key={certainty}>
                <CertaintyMark certainty={certainty} />
                {CERTAINTY_INFO[certainty].label}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

export default FareTable;
