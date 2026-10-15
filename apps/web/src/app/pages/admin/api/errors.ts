/** Admin errors for display: the shared ApiErrorPanel shape and one plain sentence. */
import type { PlatformError } from "../../../../shared/platform/kletiaClient";
import { walletErrorText } from "../model/session";
import { AdminApiError, describeAdminError } from "./adminClient";

/** An admin error in the shape the shared ApiErrorPanel prints (code, status, request id, issues). */
export function toPanelError(error: unknown): PlatformError {
  if (error instanceof AdminApiError) {
    const raw = error.details?.issues;
    const issues = Array.isArray(raw)
      ? raw
          .filter((issue): issue is { path?: unknown; message?: unknown } => Boolean(issue) && typeof issue === "object")
          .map((issue) => ({ path: typeof issue.path === "string" ? issue.path : Array.isArray(issue.path) ? issue.path.join(".") : "", message: String(issue.message ?? "") }))
      : [];
    return { code: error.code, message: error.message, status: error.status, issues, requestId: error.requestId, retryable: error.retryable, unreachable: error.unreachable };
  }
  return { code: "ADMIN_CLIENT_ERROR", message: describeAdminError(error), status: 0, issues: [], requestId: null, retryable: true, unreachable: false };
}

/** One sentence for any failure: API errors in the API's words, wallet errors in plain English. */
export function errorText(error: unknown): string {
  return error instanceof AdminApiError ? describeAdminError(error) : walletErrorText(error);
}
