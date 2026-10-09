/**
 * Rule Book refusals as PlatformErrors (policy design §11.2, §13). Each
 * code is emitted literally with its catalogued status (the error-catalog
 * drift test reads these call sites). The envelope gains `error.policy`:
 * the decision id, the stage, the key whose rule book refused, every
 * violated rule id with its path, observed value and limit, and `retryAt`;
 * `retryAfterSeconds` becomes the `Retry-After` header.
 */
import type { PolicyViolation } from "@kletia/core";
import { PlatformError, type PlatformIssue } from "../../errors.js";

export interface PolicyApprovalReference {
  readonly id: string;
  readonly url: string;
  readonly expiresAt: string;
  readonly ceilingUsd?: string;
  readonly status?: "pending" | "approved" | "rejected" | "expired";
}

export interface PolicyErrorDetails {
  readonly decisionId: string | null;
  readonly stage: "plan" | "prepare" | "evaluate";
  readonly outcome: "deny";
  /** The key (or `prj_…`) whose rule book refused first; the owner when no rule book is named. */
  readonly keyId: string | null;
  readonly violations: readonly PolicyViolation[];
  /** ISO time when a retry may succeed (spend windows, schedule, approvals); null otherwise. */
  readonly retryAt: string | null;
  readonly approval?: PolicyApprovalReference;
}

export type PolicyRefusalCode =
  | "POLICY_VIOLATION"
  | "POLICY_SPEND_LIMIT"
  | "POLICY_SCHEDULE_CLOSED"
  | "POLICY_PRICE_UNAVAILABLE"
  | "POLICY_OWNER_REVOKED"
  | "POLICY_APPROVAL_REQUIRED"
  | "POLICY_APPROVAL_REJECTED"
  | "POLICY_APPROVAL_EXPIRED"
  | "POLICY_APPROVAL_STALE"
  | "AGENT_KEY_FORBIDDEN";

/** The error a refusal code maps to, with its catalogued status (literal sites for the drift scan). */
function refusal(code: string, message: string, issues: readonly PlatformIssue[]): PlatformError {
  switch (code) {
    case "POLICY_SPEND_LIMIT":
      return new PlatformError("POLICY_SPEND_LIMIT", message, 403, issues);
    case "POLICY_SCHEDULE_CLOSED":
      return new PlatformError("POLICY_SCHEDULE_CLOSED", message, 403, issues);
    case "POLICY_PRICE_UNAVAILABLE":
      return new PlatformError("POLICY_PRICE_UNAVAILABLE", message, 503, issues);
    case "POLICY_OWNER_REVOKED":
      return new PlatformError("POLICY_OWNER_REVOKED", message, 403, issues);
    case "POLICY_APPROVAL_REQUIRED":
      return new PlatformError("POLICY_APPROVAL_REQUIRED", message, 403, issues);
    case "POLICY_APPROVAL_REJECTED":
      return new PlatformError("POLICY_APPROVAL_REJECTED", message, 403, issues);
    case "POLICY_APPROVAL_EXPIRED":
      return new PlatformError("POLICY_APPROVAL_EXPIRED", message, 410, issues);
    case "POLICY_APPROVAL_STALE":
      return new PlatformError("POLICY_APPROVAL_STALE", message, 409, issues);
    case "AGENT_KEY_FORBIDDEN":
      return new PlatformError("AGENT_KEY_FORBIDDEN", message, 403, issues);
    default:
      // Unknown codes refuse with the generic (non-retryable) violation: never weaker.
      return new PlatformError("POLICY_VIOLATION", message, 403, issues);
  }
}

function whose(violation: PolicyViolation | undefined, fallback: string | null): string {
  const id = violation?.keyId ?? fallback;
  if (violation?.scope === "project") return `The project rule book${id ? ` (${id})` : ""}`;
  return id ? `The rule book of ${id}` : "The rule book";
}

/** A sentence for the first violation, naming the rule book and the rule id. */
export function policyRefusalMessage(code: string, violations: readonly PolicyViolation[], ownerKeyId: string | null): string {
  const first = violations[0];
  if (!first) return "The rule book refused this request.";
  const more = violations.length > 1 ? ` (and ${violations.length - 1} more)` : "";
  const subject = whose(first, ownerKeyId);
  const reason = `${first.message.replace(/\.$/u, "")} (${first.rule})${more}.`;
  switch (code) {
    case "POLICY_APPROVAL_REQUIRED":
      return `${subject} holds this intent for approval: ${reason} Share error.policy.approval.url with an approver, then retry.`;
    case "POLICY_SPEND_LIMIT":
      return `${subject} refused this payload: ${reason} Retry after Retry-After, when earlier spend leaves the window.`;
    case "POLICY_PRICE_UNAVAILABLE":
      return `${subject} needs a USD price that no fresh source gives right now: ${reason} Retry shortly.`;
    case "POLICY_OWNER_REVOKED":
      return "The key that owns this intent, or one of its ancestors, is revoked or expired: nothing more is prepared. Steps already submitted keep settling.";
    default:
      return `${subject} refused this intent: ${reason}`;
  }
}

/**
 * Builds the refusal for a set of violations (code by the §13 precedence,
 * given by the evaluator). `retryAfterSeconds` sets Retry-After.
 */
export function policyError(code: string, details: PolicyErrorDetails, retryAfterSeconds?: number | null, message?: string): PlatformError {
  const issues: PlatformIssue[] = details.violations.slice(0, 20).map((violation) => ({
    path: violation.path ?? violation.rule,
    message: `${violation.message} (${violation.rule})`.slice(0, 300),
  }));
  const error = refusal(code, (message ?? policyRefusalMessage(code, details.violations, details.keyId)).slice(0, 600), issues);
  const policy = { ...details, violations: details.violations.slice(0, 20) };
  const base = error.toJSON();
  Object.defineProperty(error, "policy", { value: policy, enumerable: false });
  Object.defineProperty(error, "toJSON", { value: () => ({ ...base, policy }), enumerable: false });
  if (typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    Object.defineProperty(error, "retryAfterSeconds", { value: Math.min(604_800, Math.ceil(retryAfterSeconds)), enumerable: false });
  }
  return error;
}

/** The `error.policy` details of a refusal built by `policyError`, if any. */
export function policyErrorDetails(error: unknown): PolicyErrorDetails | null {
  if (!(error instanceof PlatformError)) return null;
  const policy = (error as { readonly policy?: unknown }).policy;
  return policy && typeof policy === "object" ? (policy as PolicyErrorDetails) : null;
}
