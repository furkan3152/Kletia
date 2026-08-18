import type { NetworkMode } from "../config/networks";

export const INTENT_SESSION_MISMATCH_MESSAGE =
  "Intent response network, chain or request identity did not match the active session.";

type IntentRequestIdentity = {
  network: NetworkMode;
  chainId: number;
  requestId: string;
};

type IntentHttpBoundaryResult =
  { kind: "success" } | { kind: "rejection"; message: string };

const PRE_SESSION_REJECTION_MESSAGES: Readonly<Record<string, string>> = {
  AMBIGUOUS_ADDRESS:
    "The wallet address was rejected because more than one address was supplied.",
  CONFLICTING_ADDRESS:
    "The wallet address was rejected because request address fields conflicted.",
  HIGH_RISK_ADDRESS:
    "Base address risk policy blocked the intent before a plan was created.",
  HTML_NOT_ALLOWED:
    "The intent was rejected because HTML is not allowed in prompts.",
  INVALID_ADDRESS: "The wallet address is not a valid EVM address.",
  INVALID_CHAIN_ID:
    "The intent was rejected because its chain identifier was invalid.",
  INVALID_PROMPT: "The intent prompt must be non-empty text.",
  MALICIOUS_URL_DETECTED:
    "URL risk policy blocked the external resource before an x402 plan was created.",
  PROMPT_TOO_LONG: "The intent prompt exceeded the allowed length.",
  SENSITIVE_DATA_NOT_ALLOWED:
    "The intent was rejected because it contained credential-like sensitive data.",
  TOO_MANY_URLS:
    "The intent was rejected because it contained too many external URLs.",
  URL_SECURITY_UNAVAILABLE:
    "URL risk verification failed closed; the x402 plan was not created and no payment was attempted.",
  WEBACY_UNAVAILABLE:
    "Base address risk verification is unavailable; intent planning stopped before any payment or transaction.",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const identityConflicts = (
  payload: Record<string, unknown>,
  expected: IntentRequestIdentity,
): boolean =>
  (payload.network !== undefined && payload.network !== expected.network) ||
  (payload.chainId !== undefined && payload.chainId !== expected.chainId) ||
  (payload.requestId !== undefined && payload.requestId !== expected.requestId);

const hasExactIdentity = (
  payload: Record<string, unknown>,
  expected: IntentRequestIdentity,
): boolean =>
  payload.network === expected.network &&
  payload.chainId === expected.chainId &&
  payload.requestId === expected.requestId;

const boundedBoundErrorMessage = (
  payload: Record<string, unknown>,
): string | null => {
  if (typeof payload.message !== "string") return null;
  const message = payload.message.trim();
  const hasDisallowedControlCharacter = [...message].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      (codePoint < 32 &&
        codePoint !== 9 &&
        codePoint !== 10 &&
        codePoint !== 13) ||
      codePoint === 127
    );
  });
  if (
    message.length === 0 ||
    message.length > 500 ||
    hasDisallowedControlCharacter
  ) {
    return null;
  }
  return message;
};

export function resolveIntentHttpResponseBoundary(
  payload: unknown,
  expected: IntentRequestIdentity,
  response: { ok: boolean; status: number },
): IntentHttpBoundaryResult {
  if (!isRecord(payload)) {
    throw new Error(
      `Intent service returned HTTP ${response.status} without a valid response.`,
    );
  }

  if (response.ok) {
    if (!hasExactIdentity(payload, expected)) {
      throw new Error(INTENT_SESSION_MISMATCH_MESSAGE);
    }
    return { kind: "success" };
  }

  if (identityConflicts(payload, expected)) {
    throw new Error(INTENT_SESSION_MISMATCH_MESSAGE);
  }

  if (
    payload.success === true ||
    payload.status === "success" ||
    payload.result !== undefined
  ) {
    throw new Error(
      `Intent service returned an invalid success payload with HTTP ${response.status}.`,
    );
  }

  if (hasExactIdentity(payload, expected)) {
    const message = boundedBoundErrorMessage(payload);
    return {
      kind: "rejection",
      message:
        message ||
        `Intent service rejected the request (HTTP ${response.status}).`,
    };
  }

  const code = typeof payload.code === "string" ? payload.code : "";
  return {
    kind: "rejection",
    message:
      PRE_SESSION_REJECTION_MESSAGES[code] ||
      `Intent service rejected the request before a session-bound error envelope was available (HTTP ${response.status}).`,
  };
}
