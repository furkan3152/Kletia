// The status vocabulary. Run with Node 22.18 or later:
//   node --test apps/web/src/app/site/ui/__tests__/statusTones.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { STATUS_TONES, statusLabel, toneFor, TONE_GLYPHS, verificationTone } from "../statusTones.ts";

/** The status table, row by row: resource, state, tone. */
const DESIGN = [
  ["contract", "active", "success"],
  ["contract", "pending", "info"],
  ["contract", "suspended", "danger"],
  ["contract", "deleted", "neutral"],
  ["contract-source", "verified", "success"],
  ["contract-source", "exact_match", "success"],
  ["contract-source", "unverified", "warning"],
  ["contract-source", "unknown", "warning"],
  ["contract-domain", "verified", "success"],
  ["contract-domain", "unverified", "warning"],
  ["contract-domain", "unknown", "warning"],
  ["link", "active", "success"],
  ["link", "pending", "info"],
  ["link", "paused", "warning"],
  ["link", "suspended", "danger"],
  ["link", "exhausted", "neutral"],
  ["link", "expired", "neutral"],
  ["link", "withdrawn", "neutral"],
  ["link", "deleted", "neutral"],
  ["link-publisher", "verified", "success"],
  ["link-publisher", "unverified", "warning"],
  ["key", "active", "success"],
  ["key", "rotating", "info"],
  ["key", "expiring", "warning"],
  ["key", "revoked", "neutral"],
  ["key", "expired", "neutral"],
  ["webhook-delivery", "delivered", "success"],
  ["webhook-delivery", "succeeded", "success"],
  ["webhook-delivery", "retrying", "warning"],
  ["webhook-delivery", "failed", "danger"],
  ["rule-book-decision", "cleared", "success"],
  ["rule-book-decision", "observed", "info"],
  ["rule-book-decision", "held", "warning"],
  ["rule-book-decision", "refused", "danger"],
  ["rule-book-decision", "allow", "success"],
  ["rule-book-decision", "confirm", "warning"],
  ["rule-book-decision", "deny", "danger"],
  ["receipt", "verifies", "success"],
  ["receipt", "superseded", "info"],
  ["receipt", "revoked", "neutral"],
  ["receipt", "invalid", "danger"],
  ["api", "ok", "success"],
  ["api", "slow", "warning"],
  ["api", "unreachable", "danger"],
  ["api", "checking", "neutral"],
];

test("every state of the status table maps to its tone", () => {
  for (const [resource, state, tone] of DESIGN) {
    assert.equal(toneFor(resource, state).tone, tone, `${resource} ${state}`);
  }
  assert.equal(toneFor("link", "Paused").tone, "warning", "states are matched without case");
});

test("an unverified publisher, source or domain is a warning, never danger", () => {
  for (const resource of ["contract-source", "contract-domain", "link-publisher"]) {
    for (const state of ["unverified", "unknown", "not_checked", ""]) {
      assert.notEqual(toneFor(resource, state).tone, "danger", `${resource} ${state || "(empty)"}`);
    }
  }
  assert.equal(verificationTone(false).tone, "warning");
  assert.equal(verificationTone(true).tone, "success");
});

test("unknown states are neutral with a readable label", () => {
  assert.deepEqual(toneFor("contract", "rate_limited"), { tone: "neutral", glyph: "ring", label: "Rate limited" });
  assert.equal(toneFor("link", "").label, "Unknown");
  assert.equal(toneFor("key", undefined).label, "Unknown");
  assert.equal(toneFor("receipt", null).tone, "neutral");
  assert.equal(toneFor("link", "constructor").tone, "neutral", "object built-ins are not states");
  assert.equal(toneFor("link", "__proto__").label, "Proto");
});

test("labels are never empty and every tone has a glyph that is not colour alone", () => {
  for (const [resource, states] of Object.entries(STATUS_TONES)) {
    for (const [state, entry] of Object.entries(states)) {
      assert.ok(entry.label.trim().length > 0, `${resource} ${state}`);
      assert.notEqual(entry.glyph, "none", `${resource} ${state}`);
    }
  }
  for (const glyph of Object.values(TONE_GLYPHS)) assert.notEqual(glyph, "none");
  assert.equal(statusLabel("  "), "Unknown");
  assert.equal(statusLabel("SUSPENDED_BY_OPERATOR"), "Suspended by operator");
});
