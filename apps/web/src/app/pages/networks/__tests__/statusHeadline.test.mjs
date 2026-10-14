// The /networks headline states the live status. Run with
//   node --test apps/web/src/app/pages/networks/__tests__/statusHeadline.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { NETWORK_KEYS } from "@kletia/core";

import { statusHeadline } from "../statusHeadline.ts";

const all = (patch = {}) => ({
  status: "success",
  report: { networks: NETWORK_KEYS.map((network) => ({ network, ok: true, latencyMs: 120, ...(patch[network] ?? {}) })) },
});

test("every network answering in time: all running", () => {
  assert.equal(NETWORK_KEYS.length, 9);
  assert.deepEqual(statusHeadline(all()), { text: "All 9 networks are running", tone: "ok" });
});

test("one slow network is named; several are counted", () => {
  assert.deepEqual(statusHeadline(all({ solana: { latencyMs: 2400 } })), { text: "Solana is slow", tone: "slow" });
  assert.equal(statusHeadline(all({ solana: { latencyMs: 2400 }, base: { latencyMs: 1600 } })).text, "2 networks are slow");
  // The board's own threshold: 1500 ms is still running.
  assert.equal(statusHeadline(all({ solana: { latencyMs: 1500 } })).text, "All 9 networks are running");
});

test("networks not answering win over slow ones", () => {
  assert.deepEqual(statusHeadline(all({ solana: { ok: false }, arbitrum: { ok: false } })), { text: "2 networks are not answering", tone: "down" });
  assert.equal(statusHeadline(all({ base: { ok: false }, solana: { latencyMs: 5000 } })).text, "Base is not answering");
});

test("no answer from the API: status unavailable, never all running", () => {
  assert.deepEqual(statusHeadline({ status: "error" }), { text: "Status unavailable", tone: "unknown" });
  assert.deepEqual(statusHeadline({ status: "success", report: { networks: [] } }), { text: "Status unavailable", tone: "unknown" });
  assert.deepEqual(statusHeadline({ status: "success", report: {} }), { text: "Status unavailable", tone: "unknown" });
  assert.equal(statusHeadline({ status: "loading" }).tone, "checking");
  // A network without a reading is never counted as running.
  const partial = all({ solana: { ok: null } });
  assert.equal(statusHeadline(partial).text, "8 of 9 networks answered");
});
