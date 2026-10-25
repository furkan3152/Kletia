/**
 * Rule Book outcomes: holds, refusals and approval links.
 */
import { APPROVAL_ID_PATTERN, type IntentGraph } from "@kletia/core";
import { cleanText, httpsUrl } from "./text.js";

/* ============================================================ Rule Book */

export interface PolicyRuleLine {
  readonly key: string;
  /** Stable rule id, e.g. `caps.dailyUsd`. */
  readonly rule: string;
  readonly message: string;
  /** "observed 2140.00, limit 2000.00". */
  readonly detail: string | null;
}

export interface PolicyOutcomeView {
  readonly kind: "held" | "refused";
  readonly code: string;
  readonly title: string;
  readonly message: string;
  readonly rules: readonly PolicyRuleLine[];
  readonly approval: {
    readonly id: string;
    /** https link (or the caller's same-origin fallback); null when none is safe. */
    readonly href: string | null;
    readonly expiresAt: string | null;
    readonly ceilingUsd: string | null;
    readonly status: string | null;
  } | null;
  /** ISO time a retry may succeed (spend windows, schedule). */
  readonly retryAt: string | null;
}

export interface ApprovalLinkOptions {
  /**
   * Used when the API's approval URL is not https (local development):
   * the caller's own origin, e.g. `location.origin` on the Kletia web app.
   * The link is then `<origin>/approve#<id>`.
   */
  readonly fallbackOrigin?: string | null;
}

/** A safe link to the approval gate: the API's https `/approve#apr_…` URL for that id, else the fallback origin's. */
export function approvalHref(approval: { readonly id?: unknown; readonly url?: unknown } | null | undefined, options: ApprovalLinkOptions = {}): string | null {
  const id = typeof approval?.id === "string" && APPROVAL_ID_PATTERN.test(approval.id) ? approval.id : null;
  if (!id) return null;
  const url = httpsUrl(approval?.url);
  if (url && url.pathname === "/approve" && url.hash === `#${id}` && !url.search) return url.href;
  const origin = options.fallbackOrigin;
  if (typeof origin === "string") {
    try {
      const base = new URL(origin);
      if ((base.protocol === "https:" || base.protocol === "http:") && base.origin === origin) return `${origin}/approve#${id}`;
    } catch {
      return null;
    }
  }
  return null;
}

interface PolicyViolationLike {
  readonly rule?: unknown;
  readonly message?: unknown;
  readonly observed?: unknown;
  readonly limit?: unknown;
}

function ruleLines(violations: readonly PolicyViolationLike[] | undefined, triggers?: readonly unknown[]): PolicyRuleLine[] {
  const lines: PolicyRuleLine[] = [];
  for (const [position, violation] of (violations ?? []).entries()) {
    const rule = cleanText(violation.rule, 64) || "rule";
    const observed = cleanText(violation.observed, 40);
    const limit = cleanText(violation.limit, 40);
    lines.push({
      key: `${rule}|${position}`,
      rule,
      message: cleanText(violation.message, 300),
      detail: observed || limit ? [observed ? `observed ${observed}` : "", limit ? `limit ${limit}` : ""].filter(Boolean).join(", ") : null,
    });
  }
  for (const [position, trigger] of (triggers ?? []).entries()) {
    const rule = cleanText(trigger, 64);
    if (rule && !lines.some((line) => line.rule === rule)) lines.push({ key: `${rule}|t${position}`, rule, message: "", detail: null });
  }
  return lines;
}

const usdText = (value: unknown): string | null => {
  const text = cleanText(value, 24);
  return /^\d+(?:\.\d+)?$/u.test(text) ? `$${Number(text).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null;
};

/** The plan-time hold of an intent (`intent.policy.outcome === "confirm"`), or null. */
export function policyHold(intent: Pick<IntentGraph, "policy"> | null | undefined, options: ApprovalLinkOptions = {}): PolicyOutcomeView | null {
  const stamp = intent?.policy;
  if (!stamp || stamp.outcome !== "confirm") return null;
  const approval = stamp.approval;
  return {
    kind: "held",
    code: "POLICY_APPROVAL_REQUIRED",
    title: "Held for approval",
    message:
      "The integrator's rule book asks a person to approve this intent before Kletia prepares anything to sign. You can sign once it is approved.",
    rules: ruleLines([], approval?.triggers ?? []),
    approval: approval
      ? {
          id: cleanText(approval.id, 64),
          href: approvalHref(approval, options),
          expiresAt: cleanText(approval.expiresAt, 40) || null,
          ceilingUsd: usdText(approval.ceilingUsd),
          status: "pending",
        }
      : null,
    retryAt: null,
  };
}

export interface PolicyErrorLike {
  readonly code: string;
  readonly message?: string;
  readonly policy?: {
    readonly violations?: readonly PolicyViolationLike[];
    readonly retryAt?: string | null;
    readonly approval?: { readonly id?: unknown; readonly url?: unknown; readonly expiresAt?: unknown; readonly ceilingUsd?: unknown; readonly status?: unknown };
  } | null;
}

const POLICY_TITLES: Readonly<Record<string, string>> = Object.freeze({
  POLICY_VIOLATION: "Refused by the rule book",
  POLICY_SPEND_LIMIT: "Over a spend limit",
  POLICY_SCHEDULE_CLOSED: "Outside the allowed hours",
  POLICY_PRICE_UNAVAILABLE: "No fresh price to check a limit",
  POLICY_OWNER_REVOKED: "The key behind this intent was revoked",
  POLICY_APPROVAL_REQUIRED: "Held for approval",
  POLICY_APPROVAL_REJECTED: "Approval rejected",
  POLICY_APPROVAL_EXPIRED: "Approval expired",
  POLICY_APPROVAL_STALE: "The approval no longer covers this intent",
  AGENT_KEY_FORBIDDEN: "Not allowed for this agent key",
});

const POLICY_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  POLICY_VIOLATION: "The integrator's rule book does not allow this intent. Nothing was prepared and nothing can be signed.",
  POLICY_SPEND_LIMIT: "This would go over a spend limit of the integrator's rule book. Nothing was prepared.",
  POLICY_SCHEDULE_CLOSED: "The integrator's rule book does not allow payloads at this time. Nothing was prepared.",
  POLICY_PRICE_UNAVAILABLE: "A USD limit applies and no fresh price covers an asset, so Kletia refused rather than guess. Try again shortly.",
  POLICY_OWNER_REVOKED: "The integrator's key (or a key above it) was revoked or expired. Nothing was prepared.",
  POLICY_APPROVAL_REQUIRED: "A person must approve this intent before Kletia prepares anything to sign.",
  POLICY_APPROVAL_REJECTED: "The approver rejected this intent, so it was cancelled. Nothing was signed.",
  POLICY_APPROVAL_EXPIRED: "Nobody approved this intent in time. Plan it again to ask for a new approval.",
  POLICY_APPROVAL_STALE: "Prices moved above the approved ceiling. Plan the intent again.",
  AGENT_KEY_FORBIDDEN: "The agent key behind this intent lacks the permission.",
});

export function isPolicyCode(code: unknown): boolean {
  return typeof code === "string" && (code.startsWith("POLICY_") || code === "AGENT_KEY_FORBIDDEN");
}

/** A Rule Book refusal or hold from an API error (`error.policy`), or null for other errors. */
export function policyOutcome(error: PolicyErrorLike | null | undefined, options: ApprovalLinkOptions = {}): PolicyOutcomeView | null {
  if (!error || !isPolicyCode(error.code)) return null;
  const policy = error.policy ?? null;
  const approval = policy?.approval;
  const held = error.code === "POLICY_APPROVAL_REQUIRED";
  const approvalId = typeof approval?.id === "string" && APPROVAL_ID_PATTERN.test(approval.id) ? approval.id : null;
  return {
    kind: held ? "held" : "refused",
    code: cleanText(error.code, 64),
    title: POLICY_TITLES[error.code] ?? "Refused by the rule book",
    message: POLICY_MESSAGES[error.code] ?? cleanText(error.message, 300),
    rules: ruleLines(policy?.violations),
    approval: approvalId
      ? {
          id: approvalId,
          href: approvalHref(approval, options),
          expiresAt: cleanText(approval?.expiresAt, 40) || null,
          ceilingUsd: usdText(approval?.ceilingUsd),
          status: cleanText(approval?.status, 16) || null,
        }
      : null,
    retryAt: cleanText(policy?.retryAt, 40) || null,
  };
}
