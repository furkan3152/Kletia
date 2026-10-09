import assert from "node:assert/strict";
import test from "node:test";
import {
  ERROR_CATALOG,
  ERROR_CATEGORIES,
  ERROR_CODE_FAMILIES,
  describeError,
  errorCatalogRows,
  errorDocsUrl,
  isKletiaErrorCode,
  isRetryableError,
  resolveErrorCode,
} from "../dist/index.js";

const STATUSES = new Set([400, 401, 403, 404, 405, 409, 410, 413, 415, 422, 429, 500, 502, 503, 504]);

test("every catalog entry is well formed", () => {
  const rows = errorCatalogRows();
  assert.ok(rows.length >= 100, `catalog has ${rows.length} entries`);
  assert.deepEqual(rows.map((row) => row.code), [...rows.map((row) => row.code)].sort(), "rows are sorted by code");
  for (const row of rows) {
    assert.match(row.code, /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/u, row.code);
    assert.ok(row.status === null || STATUSES.has(row.status), `${row.code} status ${row.status}`);
    for (const other of row.otherStatuses ?? []) assert.ok(STATUSES.has(other) && other !== row.status, `${row.code} other status ${other}`);
    assert.ok(ERROR_CATEGORIES.includes(row.category), `${row.code} category ${row.category}`);
    assert.equal(typeof row.retryable, "boolean");
    assert.ok(row.title.length > 0 && row.title.length <= 60, `${row.code} title`);
    assert.ok(row.remedy.length > 0 && row.remedy.length <= 240, `${row.code} remedy`);
    // Step-only codes never come back as an HTTP error, so they must say where they appear.
    if (row.status === null) assert.equal(row.step, true, `${row.code} is step-only`);
    // 429 and 5xx (except deliberate safety refusals and configuration gaps) are worth retrying.
    if (row.status === 429) assert.equal(row.retryable, true, row.code);
  }
});

test("idempotency, key management and MCP codes carry their contract statuses", () => {
  const expected = {
    IDEMPOTENCY_KEY_INVALID: 400,
    IDEMPOTENCY_KEY_REQUIRES_API_KEY: 400,
    IDEMPOTENCY_NOT_SUPPORTED: 400,
    IDEMPOTENCY_KEY_REUSED: 422,
    IDEMPOTENCY_REQUEST_IN_PROGRESS: 409,
    KEY_NOT_FOUND: 404,
    KEY_NOT_MANAGEABLE: 409,
    KEY_LIMIT_REACHED: 409,
    KEY_SECRET_ROTATED: 403,
    MCP_ORIGIN_FORBIDDEN: 403,
  };
  for (const [code, status] of Object.entries(expected)) assert.equal(ERROR_CATALOG[code]?.status, status, code);
  assert.equal(ERROR_CATALOG.IDEMPOTENCY_REQUEST_IN_PROGRESS.retryable, true);
  assert.equal(ERROR_CATALOG.IDEMPOTENCY_KEY_REUSED.retryable, false);
});

test("provider codes resolve to their family; unknown codes resolve to nothing", () => {
  assert.equal(resolveErrorCode("RELAY_UNAVAILABLE"), "PROVIDER_UNAVAILABLE");
  assert.equal(resolveErrorCode("JUPITER_REJECTED"), "PROVIDER_REJECTED");
  assert.equal(resolveErrorCode("RESERVE_UNAVAILABLE"), "RESERVE_UNAVAILABLE", "an exact entry wins over its family");
  assert.equal(resolveErrorCode("_UNAVAILABLE"), null);
  assert.equal(resolveErrorCode("NOT_A_CODE_AT_ALL"), null);
  assert.equal(resolveErrorCode("lower_case"), null);
  assert.ok(ERROR_CODE_FAMILIES.every((family) => isKletiaErrorCode(family.code)));
  assert.equal(describeError("LI_FI_UNAVAILABLE")?.code, "PROVIDER_UNAVAILABLE");
  assert.equal(describeError("WHATEVER"), null);
  assert.equal(isKletiaErrorCode("toString"), false, "prototype keys are not codes");
});

test("docs links point at the developer portal anchor of the resolved code", () => {
  assert.equal(errorDocsUrl("INTENT_UNSUPPORTED"), "https://kletiaai.xyz/developers#error-INTENT_UNSUPPORTED");
  assert.equal(errorDocsUrl("RELAY_UNAVAILABLE", "http://localhost:5174/"), "http://localhost:5174/developers#error-PROVIDER_UNAVAILABLE");
});

test("retryability follows the catalog, falling back to the status", () => {
  assert.equal(isRetryableError("RATE_LIMITED"), true);
  assert.equal(isRetryableError("QUOTE_MOVED", 409), false);
  assert.equal(isRetryableError("INTENT_CONFLICT", 409), true);
  assert.equal(isRetryableError("SOMETHING_NEW", 503), true);
  assert.equal(isRetryableError("SOMETHING_NEW", 400), false);
});
