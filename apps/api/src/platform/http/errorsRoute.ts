/**
 * GET /v1/errors: the error catalog from @kletia/core with documentation
 * links, plus the `docs` link added to every error envelope.
 */
import { describeError, ERROR_CODE_FAMILIES, errorCatalogRows, errorDocsUrl, type ErrorCatalogRow } from "@kletia/core";
import { kletiaWebOrigin } from "./webOrigin.js";

export interface ErrorCatalogView {
  readonly errors: readonly (ErrorCatalogRow & { readonly docs: string })[];
  /** Provider codes such as RELAY_UNAVAILABLE resolve to the entry named by `code`. */
  readonly families: readonly { readonly pattern: string; readonly code: string }[];
}

let view: { readonly origin: string; readonly body: ErrorCatalogView } | null = null;

export function errorCatalogView(): ErrorCatalogView {
  const origin = kletiaWebOrigin();
  if (view?.origin === origin) return view.body;
  const body: ErrorCatalogView = {
    errors: errorCatalogRows().map((row) => ({ ...row, docs: errorDocsUrl(row.code, origin) })),
    families: ERROR_CODE_FAMILIES.map((family) => ({ pattern: `<PROVIDER>${family.suffix}`, code: family.code })),
  };
  view = { origin, body };
  return body;
}

/** Documentation link for a catalogued (or provider-family) code; undefined for anything else. */
export function errorDocsLink(code: string): string | undefined {
  return describeError(code) ? errorDocsUrl(code, kletiaWebOrigin()) : undefined;
}
