/**
 * The review of a custom-contract (`call` / `action`) step, printed as a
 * ticket with three rubber stamps: "Not audited by Kletia" (always),
 * "Source verified" and "Domain verified" (or their warnings). The order is
 * fixed by the bring-your-own-contract design: who, what, permissions,
 * result, provenance, notice.
 *
 * Everything an integrator controls (name, website, labels, arguments) is
 * printed as text; links are https only (`contractReviewModel`). When the
 * source, a program or the domain is unverified, signing needs the
 * acknowledgement checkbox (`onAcknowledge`).
 *
 * Used by Studio's execution flow and the intent-link page; the widget (and
 * so `/embed`) prints the same model in its own design system.
 */
import type { ContractReview } from "@kletia/core";
import { contractReviewModel } from "@kletia/widget/review";
import { useId, type ReactNode } from "react";

const STAMP_BASE =
  "inline-flex items-center gap-1 border-[3px] px-2 py-0.5 font-code text-[10.5px] font-black uppercase leading-tight tracking-[0.1em]";

/** A stamp is decorative ink; its words are real text, so nothing depends on colour. */
function ReviewStamp({ tone, children, rotate }: { tone: "red" | "green" | "amber"; children: ReactNode; rotate: string }) {
  const ink =
    tone === "red"
      ? "border-[#B42318] text-[#B42318]"
      : tone === "green"
        ? "border-[#067647] text-[#067647]"
        : "border-[#92400E] text-[#92400E] [border-style:dashed]";
  return (
    <li className={`${STAMP_BASE} ${ink}`} style={{ transform: `rotate(${rotate})` }}>
      {children}
    </li>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 border-t-2 border-dashed border-[#1A1A1A]/30 py-2.5 sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:gap-3">
      <dt className="font-display text-[11px] font-bold uppercase tracking-[0.14em]">{label}</dt>
      <dd className="m-0 min-w-0 break-words text-sm">{children}</dd>
    </div>
  );
}

export interface ContractReviewCardProps {
  readonly review: ContractReview;
  /** "Step 2 · Deposit into Acme vault". */
  readonly title?: string;
  /** The plan-time review, to show what moved when the prepared one differs. */
  readonly planned?: ContractReview | null;
  readonly acknowledged?: boolean;
  /** Renders the acknowledgement checkbox when the review needs one. */
  readonly onAcknowledge?: (acknowledged: boolean) => void;
  readonly disabled?: boolean;
  readonly className?: string;
}

export function ContractReviewCard({ review, title, planned, acknowledged = false, onAcknowledge, disabled = false, className }: ContractReviewCardProps) {
  const model = contractReviewModel(review);
  const before = planned ? contractReviewModel(planned) : null;
  const plannedChanges = before ? before.result.changes.map((change) => change.text).join(", ") : "";
  const currentChanges = model.result.changes.map((change) => change.text).join(", ");
  const moved = before !== null && plannedChanges !== currentChanges;
  const ackId = useId();
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className={`relative border-[3px] border-[#1A1A1A] bg-kl-stock p-4 text-[#1A1A1A] shadow-[4px_4px_0_#1A1A1A] dark:bg-kl-stock-night dark:shadow-[4px_4px_0_#475569] sm:p-5 ${className ?? ""}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b-2 border-[#1A1A1A] pb-3">
        <div className="min-w-0">
          <p className="font-code text-[10.5px] font-black uppercase tracking-[0.16em]">Custom contract</p>
          <h4 id={headingId} className="mt-1 font-display text-lg font-bold leading-snug">
            {title ? `${title}` : model.call?.label || model.action?.title || "Contract call"}
          </h4>
        </div>
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label="Checks">
          <ReviewStamp tone="red" rotate="-2deg">
            Not audited by Kletia
          </ReviewStamp>
          {model.contract ? (
            <ReviewStamp tone={model.contract.sourceVerified ? "green" : "amber"} rotate="1.5deg">
              {model.contract.sourceVerified ? "Source verified" : "Source not verified"}
            </ReviewStamp>
          ) : null}
          <ReviewStamp tone={model.integrator.domainVerified ? "green" : "amber"} rotate="-1deg">
            {model.integrator.domainVerified ? "Domain verified" : "Domain not verified"}
          </ReviewStamp>
        </ul>
      </div>

      <dl className="m-0">
        <Row label="Who">
          <span className="font-bold">{model.integrator.name}</span>
          {model.integrator.website ? (
            <>
              {" · "}
              <a
                href={model.integrator.website}
                target="_blank"
                rel="noreferrer noopener"
                className="font-bold text-[#0047E0] underline decoration-2 underline-offset-2 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#0052FF]"
              >
                {model.integrator.domain}
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </>
          ) : null}
          {" · "}
          {model.integrator.domainVerified ? "proved it controls this domain" : "has not proved it controls a website domain"}
        </Row>

        {model.call ? (
          <Row label="What">
            {model.call.label ? <span className="block font-bold">{model.call.label}</span> : null}
            <code className="block break-all font-code text-xs font-bold">{model.call.signature}</code>
            {model.call.args.length > 0 ? (
              <ul className="mt-1.5 flex list-none flex-col gap-1 p-0">
                {model.call.args.map((arg) => (
                  <li key={arg.key} className="text-xs">
                    <code className="font-code font-bold">{arg.name}</code> = <code className="break-all font-code">{arg.value}</code>{" "}
                    <span className="text-[#4F5056]">({arg.source})</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {model.call.value ? <span className="mt-1 block text-xs font-bold">Sends {model.call.value} with the call.</span> : null}
          </Row>
        ) : null}

        {model.action ? (
          <Row label="What">
            {model.action.title ? <span className="block font-bold">{model.action.title}</span> : null}
            <span className="block text-xs">
              Solana Action from <span className="font-code font-bold">{model.action.domain}</span>, {model.action.instructionCount} instruction
              {model.action.instructionCount === 1 ? "" : "s"}.
            </span>
          </Row>
        ) : null}

        <Row label="Permissions">
          {model.permissions.length === 0 ? (
            "No token approvals."
          ) : (
            <ul className="flex list-none flex-col gap-1 p-0">
              {model.permissions.map((permission) => (
                <li key={permission.key} title={permission.spender}>
                  {permission.text}
                  {permission.existing ? <span className="text-[#4F5056]"> ({permission.existing})</span> : null}
                </li>
              ))}
            </ul>
          )}
        </Row>

        <Row label="Result">
          {model.result.simulated ? (
            <>
              {model.result.changes.length > 0 ? (
                <ul className="flex list-none flex-wrap gap-x-3 gap-y-1 p-0 font-code text-[13px] font-bold">
                  {model.result.changes.map((change) => (
                    <li key={change.key}>
                      {change.text}
                      {change.unlisted ? <span className="font-body text-xs font-semibold text-[#4F5056]"> (not in Kletia's asset list)</span> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                "No asset changes for your account."
              )}
              <span className="mt-1 block text-xs text-[#4F5056]">
                Simulated{model.result.where ? ` at ${model.result.where}` : ""}
                {model.result.networkFee ? `, network fee about ${model.result.networkFee}` : ""}.
              </span>
              {moved ? (
                <span className="mt-1 block text-xs font-bold text-[#92400E]">
                  Changed since planning: <s className="decoration-[#B42318] decoration-2">{plannedChanges || "no changes"}</s>
                </span>
              ) : null}
            </>
          ) : (
            <span className="font-bold text-[#B42318]">Kletia could not simulate this transaction, so it will not be signed.</span>
          )}
          {model.result.warnings.map((warning) => (
            <span key={warning} className="mt-1 block text-xs font-bold text-[#92400E]">
              {warning}
            </span>
          ))}
        </Row>

        <Row label="Provenance">
          {model.contract ? (
            <>
              <span className="block text-xs">
                {model.contract.networkName}{" "}
                {model.contract.explorerUrl ? (
                  <a
                    href={model.contract.explorerUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="break-all font-code font-bold text-[#0047E0] underline decoration-2 underline-offset-2 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#0052FF]"
                  >
                    {model.contract.address}
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                ) : (
                  <code className="break-all font-code font-bold">{model.contract.address}</code>
                )}
              </span>
              <span className="block text-xs">
                {model.contract.source}
                {model.contract.revision !== null ? ` · registration revision ${model.contract.revision}` : ""}
              </span>
              {model.contract.proxy ? (
                <span className="block text-xs">
                  {model.contract.proxy.kind} to <code className="break-all font-code">{model.contract.proxy.implementation}</code> ({model.contract.proxy.source})
                </span>
              ) : null}
            </>
          ) : null}
          {model.action
            ? model.action.programs.map((program) => (
                <span key={program.id} className="block text-xs">
                  <code className="break-all font-code font-bold">{program.id}</code>: {program.verified}, {program.upgradeable}
                </span>
              ))
            : null}
        </Row>
      </dl>

      <div className="mt-1 border-[3px] border-dashed border-[#B42318] bg-[#FFF1F0] p-3 text-sm font-semibold text-[#7A1A12]">
        {model.notices.map((notice) => (
          <p key={notice} className="m-0">
            {notice}
          </p>
        ))}
      </div>

      {model.needsAcknowledgement && onAcknowledge ? (
        <div className="mt-3 flex items-start gap-3">
          <input
            id={ackId}
            type="checkbox"
            checked={acknowledged}
            disabled={disabled}
            onChange={(event) => onAcknowledge(event.target.checked)}
            className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer accent-[#0052FF] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[#0052FF] disabled:cursor-not-allowed"
          />
          <label htmlFor={ackId} className="text-sm font-semibold leading-relaxed">
            I understand: {model.acknowledgementReasons.join(" ")} I still want to sign this step.
          </label>
        </div>
      ) : null}
    </section>
  );
}

export default ContractReviewCard;
