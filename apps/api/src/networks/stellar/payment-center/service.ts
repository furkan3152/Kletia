import { randomUUID } from "node:crypto";
import {
  BASE_FEE,
  Operation,
  TransactionBuilder,
  rpc,
  xdr,
} from "stellar-sdk-16";
import { decode as decodeJwt } from "jsonwebtoken";
import { StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";

import { STELLAR_TESTNET } from "../config.js";
import {
  compareStellarLastMileRoutes,
  discoverConfiguredPaymentCenterProvider,
  validateStellarLastMileQuoteRequest,
} from "../lastMile.js";
import {
  fetchAndVerifySep45Challenge,
  verifySep45SimulationFootprint,
  verifySignedSep45Challenge,
} from "./sep45Challenge.js";
import {
  createPaymentCenterSession,
  decryptAnchorAccessToken,
  encryptAnchorAccessToken,
  encryptSep24InteractiveUrl,
  openPaymentCenterSessionToken,
  readPaymentCenterSession,
  sealPaymentCenterSessionToken,
  transitionPaymentCenterSession,
} from "./store.js";
import {
  requestSep24HostedWithdrawal,
  requestSep24TransactionStatus,
  requestSep38FirmQuote,
} from "./sep38Sep24.js";
import {
  toPaymentCenterSessionView,
  type PaymentCenterSessionRecord,
} from "./types.js";
import { verifySep24PasskeyTransfer } from "./stellarTransferEvidence.js";

const SESSION_LIFETIME_MS = 30 * 60_000;
const MAX_AUTH_RESPONSE_BYTES = 64 * 1024;

const CreateSessionSchema = z
  .object({
    provider: z.string().trim().min(1).max(253),
    quoteRequest: z.unknown(),
  })
  .strict();

function controlled(
  code: string,
  message: string,
  statusCode = 400,
  cause?: unknown,
): Error {
  return Object.assign(new Error(message, { cause }), { code, statusCode });
}

function next(
  session: PaymentCenterSessionRecord,
  patch: Partial<PaymentCenterSessionRecord>,
): PaymentCenterSessionRecord {
  return {
    ...session,
    ...patch,
    version: session.version + 1,
    updatedAt: Date.now(),
  };
}

function assertSessionIdentity(input: {
  sessionId: string;
  token: unknown;
  session: PaymentCenterSessionRecord;
}): void {
  const authorization = openPaymentCenterSessionToken(input.token);
  if (
    authorization.sessionId !== input.sessionId ||
    authorization.passkeyAccount !== input.session.passkeyAccount ||
    authorization.provider !== input.session.provider ||
    authorization.expiresAt !== input.session.expiresAt
  ) {
    throw controlled(
      "PAYMENT_CENTER_SESSION_IDENTITY_MISMATCH",
      "Payment Center session authorization does not match this session.",
      401,
    );
  }
}

async function authorizedSession(
  sessionId: string,
  token: unknown,
): Promise<PaymentCenterSessionRecord> {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(sessionId)) {
    throw controlled(
      "PAYMENT_CENTER_SESSION_ID_INVALID",
      "Payment Center session ID is invalid.",
      400,
    );
  }
  const session = await readPaymentCenterSession(sessionId);
  assertSessionIdentity({ sessionId, token, session });
  if (session.expiresAt <= Date.now() && session.state !== "expired") {
    return transitionPaymentCenterSession(
      sessionId,
      [session.state],
      (current) => next(current, { state: "expired" }),
    );
  }
  return session;
}

export async function createStellarPaymentCenterSession(value: unknown) {
  const parsed = CreateSessionSchema.safeParse(value);
  if (!parsed.success) {
    throw controlled(
      "PAYMENT_CENTER_SESSION_REQUEST_INVALID",
      parsed.error.issues[0]?.message || "Payment Center session request is invalid.",
    );
  }
  const quoteRequest = validateStellarLastMileQuoteRequest(
    parsed.data.quoteRequest,
  );
  if (!quoteRequest.passkeyAccount) {
    throw controlled(
      "PAYMENT_CENTER_PASSKEY_REQUIRED",
      "Create or connect the Stellar passkey identity before starting payout authentication.",
      409,
    );
  }
  const comparison = await compareStellarLastMileRoutes(quoteRequest);
  const indicativeQuote = comparison.candidates.find(
    (candidate) => candidate.provider === parsed.data.provider,
  );
  if (!indicativeQuote) {
    throw controlled(
      "PAYMENT_CENTER_PROVIDER_ROUTE_UNAVAILABLE",
      "The selected provider no longer returns the exact live payout route.",
      409,
    );
  }
  if (!indicativeQuote.sep45Advertised) {
    throw controlled(
      "PAYMENT_CENTER_SEP45_UNAVAILABLE",
      "The selected provider does not advertise passkey-compatible SEP-45 authentication.",
      409,
    );
  }
  const now = Date.now();
  const session: PaymentCenterSessionRecord = {
    schemaVersion: "kletia_stellar_payment_session_v1",
    sessionId: randomUUID(),
    state: "created",
    version: 1,
    passkeyAccount: quoteRequest.passkeyAccount,
    provider: indicativeQuote.provider,
    quoteRequest,
    indicativeQuote,
    challenge: null,
    anchorAccessTokenCiphertext: null,
    anchorAccessTokenExpiresAt: null,
    firmQuote: null,
    sep24Transaction: null,
    submittedTransfer: null,
    lastErrorCode: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + SESSION_LIFETIME_MS,
  };
  await createPaymentCenterSession(session);
  return {
    session: toPaymentCenterSessionView(session),
    sessionToken: sealPaymentCenterSessionToken(session),
  };
}

export async function readStellarPaymentCenterSession(input: {
  sessionId: string;
  sessionToken: unknown;
}) {
  return toPaymentCenterSessionView(
    await authorizedSession(input.sessionId, input.sessionToken),
  );
}

export async function prepareStellarPaymentCenterSep45Challenge(input: {
  sessionId: string;
  sessionToken: unknown;
}) {
  const session = await authorizedSession(input.sessionId, input.sessionToken);
  if (session.expiresAt <= Date.now()) {
    throw controlled(
      "PAYMENT_CENTER_SESSION_EXPIRED",
      "Payment Center session expired. Start a new payout request.",
      409,
    );
  }
  await transitionPaymentCenterSession(
    session.sessionId,
    ["created", "authentication_rejected"],
    (current) =>
      next(current, {
        state: "challenge_requesting",
        challenge: null,
        lastErrorCode: null,
      }),
  );
  try {
    const discovery = await discoverConfiguredPaymentCenterProvider(
      session.provider,
    );
    const challenge = await fetchAndVerifySep45Challenge({
      passkeyAccount: session.passkeyAccount,
      discovery,
    });
    const updated = await transitionPaymentCenterSession(
      session.sessionId,
      ["challenge_requesting"],
      (current) =>
        next(current, {
          state: "challenge_ready",
          challenge,
          lastErrorCode: null,
        }),
    );
    return {
      session: toPaymentCenterSessionView(updated),
      challenge: {
        authorizationEntries: challenge.authorizationEntries,
        clientEntryIndex: challenge.clientEntryIndex,
        networkPassphrase: challenge.networkPassphrase,
        webAuthContractId: challenge.webAuthContractId,
        signingKey: challenge.signingKey,
        homeDomain: challenge.homeDomain,
        webAuthDomain: new URL(challenge.webAuthEndpoint).hostname,
        expiresAt: challenge.expiresAt,
      },
    };
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : "SEP45_CHALLENGE_FAILED";
    await transitionPaymentCenterSession(
      session.sessionId,
      ["challenge_requesting"],
      (current) =>
        next(current, {
          state: "created",
          challenge: null,
          lastErrorCode: code,
        }),
    ).catch(() => undefined);
    throw error;
  }
}

async function simulateSignedSep45Challenge(input: {
  session: PaymentCenterSessionRecord;
  signedAuthorizationEntries: string;
}): Promise<void> {
  const challenge = input.session.challenge;
  if (!challenge) {
    throw controlled(
      "SEP45_CHALLENGE_MISSING",
      "SEP-45 challenge is missing from this session.",
      409,
    );
  }
  const entries = xdr.SorobanAuthorizationEntries.fromXDR(
    input.signedAuthorizationEntries,
    "base64",
  );
  const clientEntry = entries[challenge.clientEntryIndex];
  const args = clientEntry.rootInvocation().function().contractFn().args();
  const server = new rpc.Server(STELLAR_TESTNET.rpcUrl, { allowHttp: false });
  const source = await server.getAccount(challenge.signingKey);
  const transaction = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: challenge.networkPassphrase,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: challenge.webAuthContractId,
        function: "web_auth_verify",
        args,
        auth: entries,
      }),
    )
    .setTimeout(30)
    .build();
  const simulation = await server.simulateTransaction(
    transaction,
    undefined,
    "enforce",
  );
  if (
    rpc.Api.isSimulationError(simulation) ||
    rpc.Api.isSimulationRestore(simulation) ||
    !rpc.Api.isSimulationSuccess(simulation)
  ) {
    throw controlled(
      "SEP45_SIMULATION_REJECTED",
      "The Stellar network did not verify this passkey authentication.",
      409,
    );
  }
  verifySep45SimulationFootprint({
    readWrite: simulation.transactionData.getReadWrite(),
    passkeyAccount: input.session.passkeyAccount,
    signingKey: challenge.signingKey,
    webAuthContractId: challenge.webAuthContractId,
  });
}

function validateAnchorJwt(input: {
  token: unknown;
  passkeyAccount: string;
  provider: string;
  endpoint: string;
}): { token: string; expiresAt: number } {
  if (typeof input.token !== "string" || input.token.length < 20 || input.token.length > 16_384) {
    throw controlled(
      "SEP45_TOKEN_INVALID",
      "Anchor returned an invalid authentication token.",
      502,
    );
  }
  const claims = decodeJwt(input.token);
  if (!claims || typeof claims !== "object" || typeof claims === "string") {
    throw controlled(
      "SEP45_TOKEN_INVALID",
      "Anchor returned an unreadable authentication token.",
      502,
    );
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  let issuer: URL;
  try {
    issuer = new URL(String(claims.iss || ""));
  } catch {
    throw controlled(
      "SEP45_TOKEN_INVALID",
      "Anchor authentication token issuer is invalid.",
      502,
    );
  }
  const endpointHost = new URL(input.endpoint).hostname;
  if (
    claims.sub !== input.passkeyAccount ||
    issuer.protocol !== "https:" ||
    (issuer.hostname !== input.provider && issuer.hostname !== endpointHost) ||
    !Number.isInteger(claims.iat) ||
    !Number.isInteger(claims.exp) ||
    Number(claims.iat) > nowSeconds + 120 ||
    Number(claims.exp) <= nowSeconds ||
    Number(claims.exp) > nowSeconds + 7 * 24 * 60 * 60 ||
    "client_domain" in claims
  ) {
    throw controlled(
      "SEP45_TOKEN_IDENTITY_MISMATCH",
      "Anchor authentication token is not bound to this passkey session.",
      502,
    );
  }
  return { token: input.token, expiresAt: Number(claims.exp) * 1000 };
}

async function exchangeSignedChallenge(input: {
  endpoint: string;
  signedAuthorizationEntries: string;
  passkeyAccount: string;
  provider: string;
}): Promise<{ token: string; expiresAt: number }> {
  const response = await fetch(input.endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      authorization_entries: input.signedAuthorizationEntries,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(12_000),
  });
  const declaredLength = Number(response.headers.get("content-length") || "0");
  if (declaredLength > MAX_AUTH_RESPONSE_BYTES) {
    throw controlled(
      "SEP45_RESPONSE_TOO_LARGE",
      "Anchor authentication response exceeded Kletia's safety limit.",
      502,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_AUTH_RESPONSE_BYTES) {
    throw controlled(
      "SEP45_RESPONSE_TOO_LARGE",
      "Anchor authentication response exceeded Kletia's safety limit.",
      502,
    );
  }
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    body = null;
  }
  if (!response.ok) {
    throw controlled(
      response.status >= 500
        ? "SEP45_ANCHOR_INDETERMINATE"
        : "SEP45_ANCHOR_REJECTED",
      response.status >= 500
        ? "Anchor authentication result is uncertain; Kletia will not resend this signed challenge."
        : "Anchor rejected the signed passkey challenge.",
      response.status >= 500 ? 502 : 409,
    );
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw controlled(
      "SEP45_ANCHOR_INDETERMINATE",
      "Anchor accepted the request but returned an invalid result; Kletia will not resend it.",
      502,
    );
  }
  return validateAnchorJwt({
    token: body.token,
    passkeyAccount: input.passkeyAccount,
    provider: input.provider,
    endpoint: input.endpoint,
  });
}

export async function completeStellarPaymentCenterSep45(input: {
  sessionId: string;
  sessionToken: unknown;
  signedAuthorizationEntries: unknown;
}) {
  const session = await authorizedSession(input.sessionId, input.sessionToken);
  if (!session.challenge || session.challenge.expiresAt <= Date.now()) {
    throw controlled(
      "SEP45_CHALLENGE_EXPIRED",
      "Passkey challenge expired. Request a new challenge before signing.",
      409,
    );
  }
  const signedAuthorizationEntries = verifySignedSep45Challenge({
    unsignedChallenge: session.challenge,
    signedAuthorizationEntries: input.signedAuthorizationEntries,
  });
  const authenticating = await transitionPaymentCenterSession(
    session.sessionId,
    ["challenge_ready"],
    (current) =>
      next(current, {
        state: "authenticating",
        lastErrorCode: null,
      }),
  );
  try {
    await simulateSignedSep45Challenge({
      session: authenticating,
      signedAuthorizationEntries,
    });
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : "SEP45_SIMULATION_UNAVAILABLE";
    const retryable = code === "SEP45_SIMULATION_UNAVAILABLE";
    await transitionPaymentCenterSession(
      session.sessionId,
      ["authenticating"],
      (current) =>
        next(current, {
          state: retryable ? "challenge_ready" : "authentication_rejected",
          lastErrorCode: code,
        }),
    );
    throw error;
  }

  try {
    const credential = await exchangeSignedChallenge({
      endpoint: session.challenge.webAuthEndpoint,
      signedAuthorizationEntries,
      passkeyAccount: session.passkeyAccount,
      provider: session.provider,
    });
    const authenticated = await transitionPaymentCenterSession(
      session.sessionId,
      ["authenticating"],
      (current) =>
        next(current, {
          state: "authenticated",
          anchorAccessTokenCiphertext: encryptAnchorAccessToken(
            credential.token,
          ),
          anchorAccessTokenExpiresAt: credential.expiresAt,
          lastErrorCode: null,
        }),
    );
    return toPaymentCenterSessionView(authenticated);
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : "SEP45_ANCHOR_INDETERMINATE";
    const indeterminate =
      code === "SEP45_ANCHOR_INDETERMINATE" ||
      (error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError"));
    await transitionPaymentCenterSession(
      session.sessionId,
      ["authenticating"],
      (current) =>
        next(current, {
          state: indeterminate
            ? "authentication_indeterminate"
            : "authentication_rejected",
          lastErrorCode: code,
        }),
    );
    if (indeterminate && !(error && typeof error === "object" && "code" in error)) {
      throw controlled(
        "SEP45_ANCHOR_INDETERMINATE",
        "Anchor authentication result is uncertain; Kletia will not resend this signed challenge.",
        502,
        error,
      );
    }
    throw error;
  }
}

function assertAuthenticatedSession(
  session: PaymentCenterSessionRecord,
): string {
  if (
    !session.anchorAccessTokenCiphertext ||
    !session.anchorAccessTokenExpiresAt ||
    session.anchorAccessTokenExpiresAt <= Date.now()
  ) {
    throw controlled(
      "PAYMENT_CENTER_AUTHENTICATION_EXPIRED",
      "The provider login expired. Start a new Payment Center session.",
      409,
    );
  }
  return decryptAnchorAccessToken(session.anchorAccessTokenCiphertext);
}

function errorCode(error: unknown, fallback: string): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : fallback;
}

function isTimeoutOrAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

export async function createStellarPaymentCenterFirmQuote(input: {
  sessionId: string;
  sessionToken: unknown;
}) {
  const session = await authorizedSession(input.sessionId, input.sessionToken);
  const anchorAccessToken = assertAuthenticatedSession(session);
  const requesting = await transitionPaymentCenterSession(
    session.sessionId,
    ["authenticated"],
    (current) =>
      next(current, {
        state: "firm_quote_requesting",
        firmQuote: null,
        lastErrorCode: null,
      }),
  );
  let providerRequestStarted = false;
  try {
    const discovery = await discoverConfiguredPaymentCenterProvider(
      requesting.provider,
    );
    providerRequestStarted = true;
    const firmQuote = await requestSep38FirmQuote({
      discovery,
      session: requesting,
      anchorAccessToken,
    });
    const updated = await transitionPaymentCenterSession(
      requesting.sessionId,
      ["firm_quote_requesting"],
      (current) =>
        next(current, {
          state: "firm_quote_ready",
          firmQuote,
          lastErrorCode: null,
        }),
    );
    return toPaymentCenterSessionView(updated);
  } catch (error) {
    const code = errorCode(error, "SEP38_FIRM_QUOTE_FAILED");
    const indeterminate =
      code === "SEP38_FIRM_QUOTE_INDETERMINATE" ||
      (providerRequestStarted && isTimeoutOrAbort(error)) ||
      (providerRequestStarted &&
        !(error && typeof error === "object" && "statusCode" in error));
    await transitionPaymentCenterSession(
      requesting.sessionId,
      ["firm_quote_requesting"],
      (current) =>
        next(current, {
          state: indeterminate ? "firm_quote_indeterminate" : "authenticated",
          lastErrorCode: code,
        }),
    ).catch(() => undefined);
    if (indeterminate && code !== "SEP38_FIRM_QUOTE_INDETERMINATE") {
      throw controlled(
        "SEP38_FIRM_QUOTE_INDETERMINATE",
        "Firm quote result is uncertain; Kletia will not reserve the same quote again in this session.",
        502,
        error,
      );
    }
    throw error;
  }
}

export async function createStellarPaymentCenterHostedWithdrawal(input: {
  sessionId: string;
  sessionToken: unknown;
}) {
  const session = await authorizedSession(input.sessionId, input.sessionToken);
  const anchorAccessToken = assertAuthenticatedSession(session);
  if (!session.firmQuote || session.firmQuote.expiresAt <= Date.now()) {
    throw controlled(
      "SEP38_FIRM_QUOTE_EXPIRED",
      "The firm quote expired. Start a new Payment Center session before creating a withdrawal.",
      409,
    );
  }
  const requesting = await transitionPaymentCenterSession(
    session.sessionId,
    ["firm_quote_ready"],
    (current) =>
      next(current, {
        state: "sep24_session_requesting",
        sep24Transaction: null,
        lastErrorCode: null,
      }),
  );
  let providerRequestStarted = false;
  try {
    const discovery = await discoverConfiguredPaymentCenterProvider(
      requesting.provider,
    );
    providerRequestStarted = true;
    const hosted = await requestSep24HostedWithdrawal({
      discovery,
      session: requesting,
      anchorAccessToken,
      interactiveUrlCiphertext: encryptSep24InteractiveUrl,
    });
    const updated = await transitionPaymentCenterSession(
      requesting.sessionId,
      ["sep24_session_requesting"],
      (current) =>
        next(current, {
          state: "sep24_session_ready",
          sep24Transaction: hosted.snapshot,
          lastErrorCode: null,
        }),
    );
    return {
      session: toPaymentCenterSessionView(updated),
      interactiveUrl: hosted.interactiveUrl,
    };
  } catch (error) {
    const code = errorCode(error, "SEP24_SESSION_FAILED");
    const indeterminate =
      code === "SEP24_SESSION_INDETERMINATE" ||
      (providerRequestStarted && isTimeoutOrAbort(error)) ||
      (providerRequestStarted &&
        !(error && typeof error === "object" && "statusCode" in error));
    await transitionPaymentCenterSession(
      requesting.sessionId,
      ["sep24_session_requesting"],
      (current) =>
        next(current, {
          state: indeterminate
            ? "sep24_session_indeterminate"
            : "firm_quote_ready",
          lastErrorCode: code,
        }),
    ).catch(() => undefined);
    if (indeterminate && code !== "SEP24_SESSION_INDETERMINATE") {
      throw controlled(
        "SEP24_SESSION_INDETERMINATE",
        "Hosted withdrawal result is uncertain; Kletia will not create a duplicate session.",
        502,
        error,
      );
    }
    throw error;
  }
}

function sessionStateForSep24Status(
  current: PaymentCenterSessionRecord,
  status: Awaited<ReturnType<typeof requestSep24TransactionStatus>>,
): PaymentCenterSessionRecord["state"] {
  if (status.status === "completed") return "settled";
  if (status.status === "refunded") return "refunded";
  if (status.status === "expired") return "expired";
  if (["no_market", "too_small", "too_large", "error"].includes(status.status)) {
    return "failed";
  }
  if (status.status === "pending_user_transfer_start") {
    if (current.submittedTransfer) return "settlement_pending";
    return status.transferInstruction
      ? "awaiting_user_transfer"
      : "sep24_session_ready";
  }
  if (
    [
      "pending_user_transfer_complete",
      "pending_external",
      "pending_stellar",
    ].includes(status.status) ||
    current.state === "settlement_pending" ||
    Boolean(status.stellarTransactionId)
  ) {
    return "settlement_pending";
  }
  return "sep24_session_ready";
}

export async function refreshStellarPaymentCenterWithdrawalStatus(input: {
  sessionId: string;
  sessionToken: unknown;
}) {
  const session = await authorizedSession(input.sessionId, input.sessionToken);
  if (["settled", "refunded", "canceled", "expired"].includes(session.state)) {
    return toPaymentCenterSessionView(session);
  }
  if (!session.sep24Transaction) {
    throw controlled(
      "SEP24_TRANSACTION_NOT_READY",
      "Create and complete the hosted withdrawal form before checking its status.",
      409,
    );
  }
  const anchorAccessToken = assertAuthenticatedSession(session);
  const discovery = await discoverConfiguredPaymentCenterProvider(session.provider);
  const status = await requestSep24TransactionStatus({
    discovery,
    session,
    anchorAccessToken,
  });
  const updated = await transitionPaymentCenterSession(
    session.sessionId,
    [session.state],
    (current) =>
      next(current, {
        state: sessionStateForSep24Status(current, status),
        sep24Transaction: current.sep24Transaction
          ? { ...current.sep24Transaction, status }
          : current.sep24Transaction,
        lastErrorCode:
          status.status === "pending_user_transfer_start" &&
          !status.transferInstruction
            ? "SEP24_TRANSFER_INSTRUCTION_UNSUPPORTED"
            : null,
      }),
  );
  return toPaymentCenterSessionView(updated);
}

export async function submitStellarPaymentCenterWithdrawalTransfer(input: {
  sessionId: string;
  sessionToken: unknown;
  transactionHash: unknown;
}) {
  const transactionHash = String(input.transactionHash || "")
    .trim()
    .toLowerCase();
  if (!/^[a-f\d]{64}$/u.test(transactionHash)) {
    throw controlled(
      "SEP24_TRANSFER_HASH_INVALID",
      "A canonical Stellar transaction hash is required.",
      400,
    );
  }
  let session = await authorizedSession(input.sessionId, input.sessionToken);
  const instruction = session.sep24Transaction?.status?.transferInstruction;
  if (!instruction) {
    throw controlled(
      "SEP24_TRANSFER_INSTRUCTION_NOT_READY",
      "The provider has not supplied a reviewed Stellar transfer instruction.",
      409,
    );
  }
  if (session.submittedTransfer) {
    if (session.submittedTransfer.transactionHash !== transactionHash) {
      throw controlled(
        "SEP24_TRANSFER_ALREADY_SUBMITTED",
        "This withdrawal already has a different submitted Stellar transaction; Kletia will not send it again.",
        409,
      );
    }
  } else {
    session = await transitionPaymentCenterSession(
      session.sessionId,
      ["awaiting_user_transfer"],
      (current) =>
        next(current, {
          state: "settlement_pending",
          submittedTransfer: {
            transactionHash,
            submittedAt: Date.now(),
            chainVerifiedAt: null,
            ledgerSequence: null,
          },
          lastErrorCode: null,
        }),
    );
  }
  if (session.submittedTransfer?.chainVerifiedAt) {
    return toPaymentCenterSessionView(session);
  }
  try {
    const evidence = await verifySep24PasskeyTransfer({
      transactionHash,
      passkeyAccount: session.passkeyAccount,
      instruction,
    });
    const verified = await transitionPaymentCenterSession(
      session.sessionId,
      ["settlement_pending"],
      (current) =>
        next(current, {
          submittedTransfer: current.submittedTransfer
            ? {
                ...current.submittedTransfer,
                chainVerifiedAt: Date.now(),
                ledgerSequence: evidence.ledgerSequence,
              }
            : current.submittedTransfer,
          lastErrorCode: null,
        }),
    );
    return toPaymentCenterSessionView(verified);
  } catch (error) {
    await transitionPaymentCenterSession(
      session.sessionId,
      ["settlement_pending"],
      (current) =>
        next(current, {
          lastErrorCode: errorCode(error, "SEP24_TRANSFER_EVIDENCE_UNAVAILABLE"),
        }),
    ).catch(() => undefined);
    throw error;
  }
}

export function assertPaymentCenterSessionHeader(value: unknown): string {
  if (typeof value !== "string" || value.length < 20 || value.length > 2_048) {
    throw controlled(
      "PAYMENT_CENTER_SESSION_TOKEN_REQUIRED",
      "Payment Center session authorization is required.",
      401,
    );
  }
  return value;
}

export function assertPasskeyContractAccount(value: unknown): string {
  const account = String(value || "").trim();
  if (!StrKey.isValidContract(account)) {
    throw controlled(
      "PAYMENT_CENTER_PASSKEY_INVALID",
      "A valid Stellar passkey C-account is required.",
      400,
    );
  }
  return account;
}
