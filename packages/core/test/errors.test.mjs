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

test("bring-your-own-contract codes carry the design's statuses (design 7.8)", () => {
  // [status, category, retryable, step]
  const expected = {
    CONTRACT_NOT_FOUND: [404, "not_found", false],
    CONTRACT_UNKNOWN: [422, "intent", false],
    CONTRACT_EXISTS: [409, "conflict", false],
    CONTRACT_LIMIT_REACHED: [409, "conflict", false],
    CONTRACT_DEFINITION_INVALID: [400, "request", false],
    CONTRACT_FUNCTION_FORBIDDEN: [422, "intent", false],
    CONTRACT_ARGUMENT_FORBIDDEN: [422, "intent", false],
    CONTRACT_BINDING_INVALID: [422, "intent", false],
    CONTRACT_NOT_DEPLOYED: [422, "intent", false],
    CONTRACT_DELEGATED_EOA: [422, "intent", false],
    CONTRACT_DENIED: [422, "permission", false],
    CONTRACT_PROXY_UNSUPPORTED: [422, "intent", false],
    CONTRACT_PENDING: [409, "conflict", true],
    CONTRACT_SUSPENDED: [409, "conflict", false],
    CONTRACT_NOT_USABLE: [409, "conflict", false],
    CONTRACT_CHANGED: [409, "conflict", false],
    CONTRACT_REVISION_CHANGED: [409, "conflict", false],
    CONTRACT_ACTION_UNKNOWN: [422, "intent", false],
    CONTRACT_PARAM_INVALID: [422, "intent", false],
    CONTRACT_AMOUNT_LIMIT: [422, "intent", false],
    CONTRACT_SPEND_LIMIT: [422, "intent", true],
    CONTRACT_CHANGED_DURING_EXECUTION: [null, "verification", false, true],
    CONTRACT_HANDOFF_UNSUPPORTED: [422, "intent", false],
    CONTRACTS_DISABLED: [503, "unavailable", true],
    SIMULATION_UNAVAILABLE: [503, "unavailable", true],
    SIMULATION_ASSET_CHANGE_REFUSED: [422, "intent", false],
    ACTION_URL_FORBIDDEN: [422, "request", false],
    ACTION_ENDPOINT_UNAVAILABLE: [502, "upstream", true],
    ACTION_RESPONSE_INVALID: [502, "upstream", true],
    ACTION_RESPONSE_UNSUPPORTED: [422, "intent", false],
    ACTION_TRANSACTION_REJECTED: [422, "intent", false],
    PROGRAM_NOT_ALLOWED: [422, "intent", false],
    PROGRAM_CHANGED: [409, "conflict", false],
    SESSION_NOT_FOUND: [404, "not_found", false],
    SESSION_EXPIRED: [410, "expired", false],
    SESSION_USED: [409, "conflict", false],
    SESSION_ORIGIN_FORBIDDEN: [403, "permission", false],
  };
  for (const [code, [status, category, retryable, step]] of Object.entries(expected)) {
    const entry = ERROR_CATALOG[code];
    assert.ok(entry, `${code} is catalogued`);
    assert.equal(entry.status, status, `${code} status`);
    assert.equal(entry.category, category, `${code} category`);
    assert.equal(entry.retryable, retryable, `${code} retryable`);
    assert.equal(Boolean(entry.step), Boolean(step), `${code} step`);
  }
  // Exact entries win over the provider families they look like.
  assert.equal(resolveErrorCode("ACTION_ENDPOINT_UNAVAILABLE"), "ACTION_ENDPOINT_UNAVAILABLE");
  assert.equal(resolveErrorCode("SIMULATION_UNAVAILABLE"), "SIMULATION_UNAVAILABLE");
  assert.equal(describeError("ACTION_ENDPOINT_UNAVAILABLE").category, "upstream");
  assert.equal(isRetryableError("CONTRACT_PENDING", 409), true);
  assert.equal(isRetryableError("CONTRACT_CHANGED", 409), false);
  // Reused codes keep their meaning.
  for (const code of ["SIMULATION_FAILED", "QUOTE_MOVED", "OUTCOME_NOT_PROVEN", "REFERENCE_MISMATCH", "INSUFFICIENT_BALANCE", "KEY_SECRET_ROTATED", "API_KEY_REQUIRED"]) {
    assert.ok(isKletiaErrorCode(code), code);
  }
});

test("every contract validation issue code is a catalogued error", async () => {
  const { CONTRACT_ISSUE_PRECEDENCE } = await import("../dist/index.js");
  for (const code of CONTRACT_ISSUE_PRECEDENCE) assert.ok(isKletiaErrorCode(code), code);
});
