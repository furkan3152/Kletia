/**
 * Shared Kletia Platform API client for the web app.
 *
 * Every first-party surface (site, developer portal, Studio and, later, the
 * console) talks to `/v1` through one lazily created `KletiaClient`, so base
 * URL validation, headers and timeouts live in exactly one place. The module
 * is tiny and wallet-free: it is safe to import from marketing routes.
 */
import { KletiaApiError, KletiaClient, KletiaPolicyError, type ApiIssue, type PolicyErrorDetails } from "@kletia/sdk";

import { BACKEND_URL } from "../config/runtime";

let client: KletiaClient | null = null;
let clientError: Error | null = null;

/** API origin the client talks to (without `/v1`). */
export const PLATFORM_ORIGIN = BACKEND_URL;

/** Returns the shared client, creating it on first use. Throws if the configured origin is unusable. */
export function getKletiaClient(): KletiaClient {
  if (client) return client;
  if (clientError) throw clientError;
  try {
    client = new KletiaClient({ baseUrl: BACKEND_URL, timeoutMs: 15_000 });
    return client;
  } catch (error) {
    clientError =
      error instanceof Error ? error : new Error("The Kletia API origin is invalid.");
    throw clientError;
  }
}

/** True when `AbortSignal.any` exists, which the SDK needs to combine a caller signal with its timeout. */
export function supportsCombinedAbort(): boolean {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function";
}

/** Only hand a caller signal to the SDK when the runtime can combine it with the SDK timeout. */
export function sdkSignal(signal: AbortSignal | undefined): AbortSignal | undefined {
  return signal && supportsCombinedAbort() ? signal : undefined;
}

/** A normalised, render-ready API failure. */
export interface PlatformError {
  readonly code: string;
  readonly message: string;
  /** HTTP status, or 0 when the API could not be reached. */
  readonly status: number;
  readonly issues: readonly ApiIssue[];
  readonly requestId: string | null;
  readonly retryable: boolean;
  /** True when the API could not be reached at all (offline, DNS, CORS, timeout). */
  readonly unreachable: boolean;
  /** Rule Book refusals and holds: the rules that decided and the approval to wait for. */
  readonly policy?: PolicyErrorDetails;
}

export function toPlatformError(error: unknown): PlatformError {
  if (error instanceof KletiaApiError) {
    return {
      code: error.code,
      message: error.message,
      status: error.status,
      issues: error.issues,
      requestId: error.requestId,
      retryable: error.retryable,
      unreachable: error.status === 0,
      ...(error instanceof KletiaPolicyError ? { policy: error.policy } : {}),
    };
  }
  const message =
    error instanceof Error && error.message ? error.message : "Unexpected error.";
  return {
    code: "CLIENT_ERROR",
    message,
    status: 0,
    issues: [],
    requestId: null,
    retryable: false,
    unreachable: false,
  };
}

/** Short human explanation for a platform error, tuned per status code. */
export function describePlatformError(error: PlatformError): string {
  if (error.unreachable) {
    return error.code === "REQUEST_TIMEOUT"
      ? "The Kletia API did not respond in time."
      : "The Kletia API is unreachable from this browser right now.";
  }
  if (error.status === 429) {
    return "Rate limit reached for this network. Wait a minute and try again.";
  }
  if (error.status >= 500) {
    return `The Kletia API failed to handle the request (${error.status}).`;
  }
  return error.message;
}

/** Demo CAIP-10 accounts used by read-only previews (dry-run planning never moves funds). */
export { PREVIEW_ACCOUNTS } from "./previewAccounts";
