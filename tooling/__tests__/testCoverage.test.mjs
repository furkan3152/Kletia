import assert from "node:assert/strict";
import test from "node:test";
import { API_AREAS, formatRows, parseLcov, summarize } from "../test-coverage.mjs";

const LCOV = [
  "TN:",
  "SF:src/platform/http/netguard.ts",
  "BRF:10",
  "BRH:9",
  "LH:90",
  "LF:100",
  "end_of_record",
  "SF:src/platform/engine/adapters/relay.ts",
  "BRF:4",
  "BRH:2",
  "LH:30",
  "LF:40",
  "end_of_record",
  "SF:src/platform/engine/service.ts",
  "LH:5",
  "LF:10",
  "end_of_record",
  "SF:src/platform/http/__tests__/support.ts",
  "LH:1",
  "LF:1",
  "end_of_record",
  "SF:../../packages/core/src/amounts.ts",
  "LH:1",
  "LF:1",
  "end_of_record",
].join("\n");

test("sums lcov counters per area, most specific area first, without tests or other workspaces", () => {
  const totals = summarize(parseLcov(LCOV), API_AREAS);
  assert.deepEqual(totals.get("src/platform/http"), { lines: [90, 100], branches: [9, 10] });
  assert.deepEqual(totals.get("src/platform/engine/adapters"), { lines: [30, 40], branches: [2, 4] });
  assert.deepEqual(totals.get("src/platform/engine"), { lines: [5, 10], branches: [0, 0] });
  assert.deepEqual(totals.get("src"), { lines: [0, 0], branches: [0, 0] });
});

test("formats one Markdown row per area", () => {
  const rows = formatRows("apps/api", summarize(parseLcov(LCOV), ["src/platform/http", "src/admin"]));
  assert.deepEqual(rows, [
    "| apps/api/src/platform/http | 90.00% (90/100) | 90.00% (9/10) |",
    "| apps/api/src/admin | n/a (0/0) | n/a (0/0) |",
  ]);
});
