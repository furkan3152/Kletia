/**
 * HTTP helpers: error mapping, transport errors and path segments.
 */
import {
  isContractId,
  isLinkId,
  isSessionId,
  isThreadId,
  type IntentPreview,
} from "@kletia/core";
import {
  KletiaApiError,
  KletiaPolicyError,
  KletiaPreviewChangedError,
  type ApiIssue,
  type PolicyErrorDetails,
} from "../errors.js";

/** A request body sent as raw bytes (`projects.setLogo`) instead of JSON. */
export class RawBody {
  constructor(
    readonly bytes: Uint8Array,
    readonly contentType: string,
  ) {}
}

/** An attempt that failed this way may still have run on the server. */
export function mayHaveRun(error: KletiaApiError): boolean {
  return error.status === 0 || error.status >= 500 || error.code === "IDEMPOTENCY_REQUEST_IN_PROGRESS";
}

export function ownSecretEnded(action: "rotate" | "revoke", error: KletiaApiError): KletiaApiError {
  const happened =
    action === "rotate"
      ? "The rotation may have gone through: an earlier attempt got no answer, and the retry was refused because this client's secret no longer authenticates"
      : "The revoke may have gone through: an earlier attempt got no answer, and the retry was refused because this client's secret no longer authenticates";
  const consequence =
    action === "rotate"
      ? "If the key rotated itself, its new secret was only in the lost response and cannot be recovered."
      : "If the key revoked itself, it is revoked.";
  return new KletiaApiError({
    code: "OUTCOME_UNKNOWN",
    message: `${happened} (${error.code}). ${consequence}`,
    status: error.status,
    hints:
      action === "rotate"
        ? ["Check rotatedAt and last4 in the key list with another key of the project, and rotate from that key."]
        : ["Check revokedAt in the key list with another key of the project."],
    requestId: error.requestId,
    cause: error,
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("Kletia baseUrl must use HTTPS (HTTP is allowed only for localhost).");
  }
  return url.origin + url.pathname.replace(/\/+$/u, "").replace(/\/v1$/u, "");
}

/** `Retry-After` as seconds (delta-seconds or an HTTP date), or null when absent. */
export function retryAfterSeconds(response: Response): number | null {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return null;
  if (/^\d+$/u.test(value)) return Number(value);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

/** Builds the error for a non-2xx response from the API's JSON error envelope. */
/** `error.policy` of a Rule Book refusal, when it has the documented shape. */
function policyDetails(value: unknown): PolicyErrorDetails | null {
  if (!isRecord(value) || !Array.isArray(value.violations)) return null;
  const stage = value.stage;
  const approval = isRecord(value.approval) && typeof value.approval.id === "string" && typeof value.approval.url === "string" ? value.approval : null;
  return {
    decisionId: typeof value.decisionId === "string" ? value.decisionId : null,
    stage: stage === "plan" || stage === "prepare" || stage === "evaluate" || stage === "sign" ? stage : "plan",
    outcome: "deny",
    keyId: typeof value.keyId === "string" ? value.keyId : null,
    violations: value.violations.filter((entry): entry is PolicyErrorDetails["violations"][number] => isRecord(entry) && typeof entry.rule === "string" && typeof entry.message === "string"),
    retryAt: typeof value.retryAt === "string" ? value.retryAt : null,
    ...(approval
      ? {
          approval: {
            id: approval.id as string,
            url: approval.url as string,
            expiresAt: typeof approval.expiresAt === "string" ? approval.expiresAt : "",
            ...(typeof approval.ceilingUsd === "string" ? { ceilingUsd: approval.ceilingUsd } : {}),
            ...(approval.status === "pending" || approval.status === "approved" || approval.status === "rejected" || approval.status === "expired" ? { status: approval.status } : {}),
          },
        }
      : {}),
  };
}

/** Builds the error for a non-2xx response from the API's JSON error envelope. */
export function errorFromResponse(response: Response, parsed: unknown, fallbackMessage: string): KletiaApiError {
  const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : {};
  const input = {
    code: typeof error.code === "string" ? error.code : `HTTP_${response.status}`,
    message: typeof error.message === "string" ? error.message : fallbackMessage,
    status: response.status,
    issues: Array.isArray(error.issues) ? (error.issues as ApiIssue[]) : [],
    hints: Array.isArray(error.hints)
      ? error.hints.filter((hint): hint is string => typeof hint === "string")
      : [],
    requestId: response.headers.get("x-request-id"),
    retryAfterSeconds: retryAfterSeconds(response),
    docs: typeof error.docs === "string" ? error.docs : null,
    details: isRecord(error.details) ? error.details : null,
  };
  const policy = policyDetails(error.policy);
  if (policy) return new KletiaPolicyError({ ...input, policy });
  if (input.code === "PREVIEW_CHANGED" && isRecord(error.preview) && typeof error.preview.digest === "string") {
    const changes = Array.isArray(error.changes) ? error.changes.filter((entry) => isRecord(entry) && typeof entry.code === "string") : [];
    return new KletiaPreviewChangedError({ ...input, preview: error.preview as unknown as IntentPreview, changes: changes as unknown as KletiaPreviewChangedError["changes"] });
  }
  return new KletiaApiError(input);
}

export function abortedError(signal: AbortSignal | undefined): KletiaApiError {
  return new KletiaApiError({
    code: "REQUEST_ABORTED",
    message: "The request was aborted.",
    status: 0,
    cause: signal?.reason,
  });
}

/** Maps a fetch failure (or a failed stream read) to a KletiaApiError. */
export function transportError(error: unknown, signal: AbortSignal | undefined, timeout?: AbortSignal): KletiaApiError {
  if (signal?.aborted) return abortedError(signal);
  const timedOut = (error as Error)?.name === "TimeoutError" || timeout?.aborted === true;
  return new KletiaApiError({
    code: timedOut ? "REQUEST_TIMEOUT" : "NETWORK_ERROR",
    message: timedOut ? "The Kletia API did not respond in time." : "The Kletia API is unreachable.",
    status: 0,
    cause: error,
  });
}

export function encodeSegment(value: string, name: string): string {
  if (!value || value.length > 200) throw new Error(`${name} is required.`);
  return encodeURIComponent(value);
}

/** A registration id path segment; anything else is refused before a request is made. */
export function contractSegment(id: string): string {
  if (!isContractId(id)) throw new TypeError("Contract ids look like ct_ followed by 24 lower-case hex characters.");
  return id;
}

/** A session id path segment; anything else is refused before a request is made. */
export function sessionSegment(id: string): string {
  if (!isSessionId(id)) throw new TypeError("Session ids look like cs_ followed by 32 lower-case hex characters.");
  return id;
}

/** A link id path segment; anything else is refused before a request is made. */
export function linkSegment(id: string): string {
  if (!isLinkId(id)) throw new TypeError("Link ids look like lk_ followed by 24 lower-case hex characters.");
  return id;
}

/** A thread id (`th_…`) path segment. */
export function threadSegment(id: string): string {
  if (!isThreadId(id)) throw new TypeError("Thread ids look like th_ followed by 24 base32 characters.");
  return id;
}

/** A receipt id (`rcpt_…`) path segment. */
export function receiptSegment(id: string): string {
  if (!/^rcpt_[0-9a-f]{32}$/u.test(id)) throw new TypeError("Receipt ids look like rcpt_ followed by 32 lower-case hex characters.");
  return id;
}

/** A receipt share id (`rsh_…`) path segment. */
export function shareSegment(id: string): string {
  if (!/^rsh_[0-9a-f]{24}$/u.test(id)) throw new TypeError("Share ids look like rsh_ followed by 24 lower-case hex characters.");
  return id;
}

/** An approval id (`apr_…`) path segment. */
export function approvalSegment(id: string): string {
  if (!/^apr_[0-9a-f]{32}$/u.test(id)) throw new TypeError("Approval ids look like apr_ followed by 32 lower-case hex characters.");
  return id;
}

/** `If-Match` value for a rule book write: the active hash (`sha256:…`) or `none`. */
export function ifMatchHeader(value: string | undefined): Record<string, string> {
  if (value === undefined) return {};
  if (value !== "none" && !/^sha256:[0-9a-f]{64}$/u.test(value)) throw new TypeError('ifMatch must be the rule book hash ("sha256:…") or "none".');
  return { "if-match": `"${value}"` };
}
