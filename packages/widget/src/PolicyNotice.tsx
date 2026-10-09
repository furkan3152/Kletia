import type { PolicyOutcomeView } from "./review.js";

function timeText(iso: string | null): string | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export interface PolicyNoticeProps {
  readonly outcome: PolicyOutcomeView;
  /** "Check again" after an approver decided (held intents only). */
  readonly onCheckAgain?: () => void;
  readonly busy?: boolean;
}

/**
 * A Rule Book outcome: held for approval (with the approval link, which is
 * safe to hand to a person: reading it is not approving it) or refused,
 * with the ids of the rules that decided it.
 */
export function PolicyNotice({ outcome, onCheckAgain, busy = false }: PolicyNoticeProps) {
  const held = outcome.kind === "held";
  const expires = timeText(outcome.approval?.expiresAt ?? null);
  const retry = timeText(outcome.retryAt);
  return (
    <div className={held ? "kw-policy kw-policy-held" : "kw-policy kw-policy-refused"} role={held ? "status" : "alert"}>
      <p className="kw-policy-title">
        <span className="kw-policy-tag">{held ? "Held" : "Refused"}</span> {outcome.title}
      </p>
      <p>{outcome.message}</p>
      {outcome.rules.length > 0 ? (
        <ul className="kw-review-args" aria-label="Rules">
          {outcome.rules.map((rule) => (
            <li key={rule.key}>
              <code>{rule.rule}</code>
              {rule.message ? ` ${rule.message}` : ""}
              {rule.detail ? <span className="kw-muted"> ({rule.detail})</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {outcome.approval ? (
        <p>
          {outcome.approval.href ? (
            <a className="kw-link" href={outcome.approval.href} target="_blank" rel="noreferrer noopener">
              Open the approval request
              <span className="kw-sr"> (opens in a new tab)</span>
            </a>
          ) : (
            <span>
              Approval <code>{outcome.approval.id}</code>
            </span>
          )}
          {outcome.approval.ceilingUsd ? <span className="kw-muted"> · up to {outcome.approval.ceilingUsd}</span> : null}
          {expires ? <span className="kw-muted"> · expires {expires}</span> : null}
        </p>
      ) : null}
      {retry ? <p className="kw-muted">Try again after {retry}.</p> : null}
      {held && onCheckAgain ? (
        <button type="button" className="kw-btn kw-btn-sm" onClick={onCheckAgain} disabled={busy}>
          Check approval and continue
        </button>
      ) : null}
    </div>
  );
}

export default PolicyNotice;
