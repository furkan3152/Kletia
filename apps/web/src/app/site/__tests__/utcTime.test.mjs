// One clock on every status surface. Run with
//   node --test apps/web/src/app/site/__tests__/utcTime.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { formatUtcMinutes, formatUtcTime, isoTime } from "../format/utcTime.ts";

test("times print as 24-hour UTC with seconds, whatever the reader's locale", () => {
  const at = Date.UTC(2026, 9, 14, 13, 57, 52);
  assert.equal(formatUtcTime(at), "13:57:52 UTC");
  assert.equal(formatUtcTime(new Date(at)), "13:57:52 UTC");
  assert.equal(formatUtcTime("2026-10-14T13:57:52.400Z"), "13:57:52 UTC");
  assert.equal(formatUtcTime(Date.UTC(2026, 0, 1, 0, 0, 5)), "00:00:05 UTC");
  assert.equal(formatUtcMinutes(at), "13:57 UTC");
  assert.equal(isoTime(at), "2026-10-14T13:57:52.000Z");
});

test("an invalid time prints nothing rather than NaN", () => {
  for (const value of ["", "not a time", Number.NaN, new Date("x")]) {
    assert.equal(formatUtcTime(value), null);
    assert.equal(formatUtcMinutes(value), null);
    assert.equal(isoTime(value), null);
  }
});
