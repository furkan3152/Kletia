/**
 * Admin API errors. Every failure leaves as `AdminErrorBody`
 * (`{ error: { code, message, requestId, details? } }`). Codes are local to
 * the admin API and not part of the public @kletia/core error catalog.
 */
import type { ErrorRequestHandler, Response } from "express";
import { PlatformError } from "../../platform/errors.js";

export type AdminErrorCode =
  | "ADMIN_DISABLED" | "ADMIN_STORE_UNAVAILABLE" | "ADMIN_ORIGIN_FORBIDDEN" | "ADMIN_HEADER_REQUIRED"
  | "ADMIN_SESSION_REQUIRED" | "ADMIN_NOT_ALLOWED" | "ADMIN_NONCE_INVALID" | "ADMIN_SIGNATURE_INVALID"
  | "ADMIN_CONFIRMATION_REQUIRED" | "ADMIN_RPC_UNAVAILABLE" | "ADMIN_TX_PENDING" | "ADMIN_RECORD_CONFLICT"
  | "ADMIN_DEPENDENCY_MISSING" | "ADMIN_TARGET_NOT_DEPLOYABLE" | "ADMIN_ARTIFACT_NOT_FOUND" | "ADMIN_SAFE_NONCE_BUSY"
  | "ADMIN_SAFE_SIGNER_INVALID" | "ADMIN_RENDER_NOT_CONFIGURED" | "ADMIN_RENDER_FAILED" | "ADMIN_INVALID_REQUEST"
  | "ADMIN_RATE_LIMITED" | "ADMIN_NOT_FOUND" | "ADMIN_EVM_WALLET_REQUIRED" | "ADMIN_UNSUPPORTED_MEDIA_TYPE"
  | "ADMIN_INTERNAL";

export type AdminErrorStatus = 400 | 401 | 403 | 404 | 409 | 415 | 422 | 429 | 500 | 502 | 503;

export class AdminHttpError extends Error {
  constructor(
    readonly status: AdminErrorStatus,
    readonly code: AdminErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "AdminHttpError";
  }
}

export function invalidRequest(message: string, issues?: readonly { path: string; message: string }[]): AdminHttpError {
  return new AdminHttpError(400, "ADMIN_INVALID_REQUEST", message, issues ? { issues } : undefined);
}

export function rpcUnavailable(network: string): AdminHttpError {
  return new AdminHttpError(502, "ADMIN_RPC_UNAVAILABLE", `The ${network} RPC could not be read right now. Retry shortly.`, { network });
}

export function storeUnavailable(): AdminHttpError {
  return new AdminHttpError(503, "ADMIN_STORE_UNAVAILABLE", "Admin storage is temporarily unavailable.");
}

export function requestIdOf(res: Response): string {
  return String(res.getHeader("X-Request-Id") ?? "");
}

export function sendAdminError(res: Response, error: AdminHttpError): void {
  if (res.headersSent) return;
  res.status(error.status).json({
    error: {
      code: error.code,
      message: error.message,
      requestId: requestIdOf(res),
      ...(error.details ? { details: error.details } : {}),
    },
  });
}

/** Maps anything thrown inside the admin router to an AdminErrorBody; 5xx never carry internals. */
export const adminErrorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof AdminHttpError) return sendAdminError(res, error);
  if (error instanceof PlatformError && error.code === "STORE_UNAVAILABLE") return sendAdminError(res, storeUnavailable());
  const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : 500;
  if (status === 400 && (error as { type?: string }).type === "entity.parse.failed") {
    return sendAdminError(res, invalidRequest("The request body is not valid JSON."));
  }
  if (status === 413) return sendAdminError(res, invalidRequest("The request body is too large."));
  console.error("[admin] unexpected error:", error instanceof Error ? error.message : error);
  return sendAdminError(res, new AdminHttpError(500, "ADMIN_INTERNAL", "The admin API failed unexpectedly."));
};
