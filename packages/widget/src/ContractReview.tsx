import { useId } from "react";
import type { ContractReview as ContractReviewData } from "@kletia/core";
import { contractReviewModel } from "./review.js";

export interface ContractReviewProps {
  readonly review: ContractReviewData;
  /** "Step 2": which leg this review belongs to. */
  readonly title?: string;
  /** The plan-time review: when the prepared one moves the assets differently, the planned changes are printed struck through. */
  readonly planned?: ContractReviewData | null;
  /** Controlled acknowledgement (shown only when the review needs one). */
  readonly acknowledged?: boolean;
  readonly onAcknowledge?: (acknowledged: boolean) => void;
  readonly disabled?: boolean;
}

/**
 * Review of a custom-contract step, in the order who, what, permissions,
 * result, provenance and the fixed "Not audited by Kletia" notice. Every
 * value an integrator controls is printed as text; links are https only.
 */
export function ContractReview({ review, title, planned, acknowledged = false, onAcknowledge, disabled = false }: ContractReviewProps) {
  const model = contractReviewModel(review);
  const before = planned ? contractReviewModel(planned) : null;
  const plannedChanges = before ? before.result.changes.map((change) => change.text).join(", ") : "";
  const moved = before !== null && plannedChanges !== model.result.changes.map((change) => change.text).join(", ");
  const ackId = useId();
  const headingId = useId();
  return (
    <section className="kw-review" aria-labelledby={headingId}>
      <div className="kw-review-head">
        <p id={headingId} className="kw-review-title">
          {title ? `${title}: ` : ""}custom contract
        </p>
        <ul className="kw-stamps" aria-label="Checks">
          <li className="kw-stamp kw-stamp-bad">Not audited by Kletia</li>
          {model.contract ? (
            <li className={model.contract.sourceVerified ? "kw-stamp" : "kw-stamp kw-stamp-warn"}>
              {model.contract.sourceVerified ? "Source verified" : "Source not verified"}
            </li>
          ) : null}
          <li className={model.integrator.domainVerified ? "kw-stamp" : "kw-stamp kw-stamp-warn"}>
            {model.integrator.domainVerified ? "Domain verified" : "Domain not verified"}
          </li>
        </ul>
      </div>

      <dl className="kw-review-dl">
        <dt>Who</dt>
        <dd>
          <strong>{model.integrator.name}</strong>
          {model.integrator.website ? (
            <>
              {" · "}
              <a className="kw-link" href={model.integrator.website} target="_blank" rel="noreferrer noopener">
                {model.integrator.domain}
                <span className="kw-sr"> (opens in a new tab)</span>
              </a>
            </>
          ) : null}
          {" · "}
          {model.integrator.domainVerified ? "domain verified" : "domain not verified"}
        </dd>

        {model.call ? (
          <>
            <dt>What</dt>
            <dd>
              {model.call.label ? <strong>{model.call.label}</strong> : null}
              <code className="kw-code">{model.call.signature}</code>
              {model.call.args.length > 0 ? (
                <ul className="kw-review-args">
                  {model.call.args.map((arg) => (
                    <li key={arg.key}>
                      <code>{arg.name}</code> = <code className="kw-break">{arg.value}</code> <span className="kw-muted">({arg.source})</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {model.call.value ? <span className="kw-block">Sends {model.call.value} with the call</span> : null}
            </dd>
          </>
        ) : null}

        {model.action ? (
          <>
            <dt>What</dt>
            <dd>
              {model.action.title ? <strong>{model.action.title}</strong> : null}
              <span className="kw-block">
                Solana Action from {model.action.domain}, {model.action.instructionCount} instruction{model.action.instructionCount === 1 ? "" : "s"}
              </span>
            </dd>
          </>
        ) : null}

        <dt>Permissions</dt>
        <dd>
          {model.permissions.length === 0 ? (
            "No token approvals."
          ) : (
            <ul className="kw-review-args">
              {model.permissions.map((permission) => (
                <li key={permission.key} title={permission.spender}>
                  {permission.text}
                  {permission.existing ? <span className="kw-muted"> ({permission.existing})</span> : null}
                </li>
              ))}
            </ul>
          )}
        </dd>

        <dt>Result</dt>
        <dd>
          {model.result.simulated ? (
            <>
              {model.result.changes.length > 0 ? (
                <ul className="kw-review-args">
                  {model.result.changes.map((change) => (
                    <li key={change.key}>
                      {change.text}
                      {change.unlisted ? <span className="kw-muted"> (not in Kletia's asset list)</span> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                "No asset changes for your account."
              )}
              <span className="kw-block kw-muted">
                Simulated{model.result.where ? ` at ${model.result.where}` : ""}
                {model.result.networkFee ? `, network fee about ${model.result.networkFee}` : ""}.
              </span>
              {moved ? (
                <span className="kw-block kw-warn">
                  Changed since planning: <s>{plannedChanges || "no changes"}</s>
                </span>
              ) : null}
            </>
          ) : (
            <span className="kw-warn">Kletia could not simulate this transaction. It will not be signed.</span>
          )}
          {model.result.warnings.map((warning) => (
            <span key={warning} className="kw-block kw-warn">
              {warning}
            </span>
          ))}
        </dd>

        <dt>Provenance</dt>
        <dd>
          {model.contract ? (
            <>
              <span className="kw-block">
                {model.contract.networkName}{" "}
                {model.contract.explorerUrl ? (
                  <a className="kw-link kw-break" href={model.contract.explorerUrl} target="_blank" rel="noreferrer noopener">
                    {model.contract.address}
                    <span className="kw-sr"> (opens in a new tab)</span>
                  </a>
                ) : (
                  <code className="kw-break">{model.contract.address}</code>
                )}
              </span>
              <span className="kw-block">
                {model.contract.source}
                {model.contract.revision !== null ? ` · revision ${model.contract.revision}` : ""}
              </span>
              {model.contract.proxy ? (
                <span className="kw-block">
                  {model.contract.proxy.kind} to <code className="kw-break">{model.contract.proxy.implementation}</code> ({model.contract.proxy.source})
                </span>
              ) : null}
            </>
          ) : null}
          {model.action
            ? model.action.programs.map((program) => (
                <span key={program.id} className="kw-block">
                  <code className="kw-break">{program.id}</code>: {program.verified}, {program.upgradeable}
                </span>
              ))
            : null}
        </dd>
      </dl>

      <div className="kw-review-notice">
        {model.notices.map((notice) => (
          <p key={notice}>{notice}</p>
        ))}
      </div>

      {model.needsAcknowledgement && onAcknowledge ? (
        <div className="kw-ack">
          <input
            id={ackId}
            type="checkbox"
            checked={acknowledged}
            disabled={disabled}
            onChange={(event) => onAcknowledge(event.target.checked)}
          />
          <label htmlFor={ackId}>
            I understand: {model.acknowledgementReasons.join(" ")} I still want to sign this step.
          </label>
        </div>
      ) : null}
    </section>
  );
}

export default ContractReview;
