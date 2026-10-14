// "Your project" tiles on the Overview (overview/overviewModel.ts, portal design 4.4.1): built from API payloads,
// unknown is "–" never 0, attention for failing deliveries and held approvals, agent keys apart, and one tile's
// error never blanks the others. Run with Node 22.18 or later:
//   node --test apps/web/src/app/pages/developers/__tests__/overviewModel.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import {
  contractsTile,
  count,
  currentKeyLane,
  intentsTile,
  keysTile,
  linksTile,
  projectGlance,
  ruleBookTile,
  webhooksTile,
} from "../overview/overviewModel.ts";

const ok = (data) => ({ status: "success", data, error: null });
const loading = { status: "loading" };
const failed = (status = 500, code = "INTERNAL") => ({ status: "error", error: { status, code, message: "x" } });

const KEYS = [
  { revokedAt: null, kind: "project", current: true, policyVersion: 1, lane: "any" },
  { revokedAt: null, kind: "project", current: false, policyVersion: null, lane: "testnet" },
  { revokedAt: "2026-10-01T00:00:00Z", kind: "project", current: false },
  { revokedAt: null, kind: "agent", current: false, policyVersion: 2 },
];
const values = (tile) => Object.fromEntries(tile.lines.map((line) => [line.label, line.value]));

test("unknown is a dash, never 0", () => {
  assert.equal(count(undefined), "–");
  assert.equal(count(null), "–");
  assert.equal(count(Number.NaN), "–");
  assert.equal(count(0), "0");
  for (const tile of projectGlance({
    keys: loading,
    usage: loading,
    webhooks: loading,
    deliveries: {},
    contracts: loading,
    links: loading,
    approvals: loading,
  })) {
    assert.equal(tile.state, "loading", tile.id);
    for (const line of tile.lines) assert.equal(line.value, "–", `${tile.id} ${line.label}`);
    assert.equal(tile.attention, null, tile.id);
  }
});

test("keys: active project keys and agent keys are counted apart; revoked keys are not counted", () => {
  const tile = keysTile(ok(KEYS));
  assert.deepEqual(values(tile), { "project keys": "2", "agent keys": "1" });
  assert.equal(tile.state, "ready");
  assert.equal(currentKeyLane(ok(KEYS)), "any");
  assert.equal(currentKeyLane(loading), null);
});

test("failing deliveries raise attention; a clean count needs every endpoint's log", () => {
  const hooks = ok([{ id: "wh_a" }, { id: "wh_b" }]);
  const clean = webhooksTile(hooks, { wh_a: ok([{ status: "succeeded" }]), wh_b: ok([]) });
  assert.deepEqual(values(clean), { endpoints: "2", "failed deliveries": "0" });
  assert.equal(clean.attention, null);
  const failing = webhooksTile(hooks, { wh_a: ok([{ status: "failed" }, { status: "dropped" }, { status: "succeeded" }]), wh_b: failed() });
  assert.equal(values(failing)["failed deliveries"], "2");
  assert.equal(failing.attention, "2 deliveries failed");
  const unknown = webhooksTile(hooks, { wh_a: ok([]), wh_b: loading });
  assert.equal(values(unknown)["failed deliveries"], "–", "an unread log is not a clean log");
  const none = webhooksTile(ok([]), {});
  assert.deepEqual(values(none), { endpoints: "0", "failed deliveries": "0" });
});

test("held approvals raise attention on the Rule Book tile", () => {
  const tile = ruleBookTile(ok(KEYS), ok([{ status: "pending" }, { status: "pending" }, { status: "approved" }]));
  assert.deepEqual(values(tile), { "this key's rule book": "v1", "held for approval": "2" });
  assert.equal(tile.attention, "2 approvals waiting");
  const quiet = ruleBookTile(ok([{ revokedAt: null, current: true, policyVersion: null }]), ok([]));
  assert.deepEqual(values(quiet), { "this key's rule book": "none", "held for approval": "0" });
  assert.equal(quiet.attention, null);
  const half = ruleBookTile(ok(KEYS), failed(403, "AGENT_KEY_FORBIDDEN"));
  assert.equal(half.state, "ready");
  assert.equal(values(half)["held for approval"], "–");
});

test("contracts, links and intents read their own payloads", () => {
  const contracts = contractsTile(ok([{ status: "active" }, { status: "pending" }]));
  assert.deepEqual(values(contracts), { active: "1", pending: "1" });
  assert.equal(contracts.attention, "1 waiting to activate");
  assert.equal(contractsTile(ok([{ status: "suspended" }])).attention, "1 suspended");
  const links = linksTile(ok([{ status: "active" }, { status: "paused" }, { status: "deleted" }]));
  assert.deepEqual(values(links), { links: "2", paused: "1" });
  const intents = intentsTile(ok({ intents: { created: 6, byStatus: { completed: 3, failed: 1, partially_failed: 1 } } }));
  assert.deepEqual(values(intents), { created: "6", failed: "2" });
  assert.equal(intents.attention, "2 intents failed");
  assert.deepEqual(values(intentsTile(ok({}))), { created: "–", failed: "–" });
});

test("one tile's error never blanks the others", () => {
  const tiles = projectGlance({
    keys: ok(KEYS),
    usage: failed(0, "NETWORK"),
    webhooks: failed(403, "AGENT_KEY_FORBIDDEN"),
    deliveries: {},
    contracts: ok([{ status: "active" }]),
    links: ok([]),
    approvals: ok([]),
  });
  const byId = Object.fromEntries(tiles.map((tile) => [tile.id, tile]));
  assert.deepEqual(tiles.map((tile) => tile.id), ["keys", "intents", "webhooks", "contracts", "links", "rule-book"]);
  assert.equal(byId.intents.state, "error");
  assert.equal(byId.intents.error, "The API did not answer.");
  assert.equal(byId.webhooks.error, "403 AGENT_KEY_FORBIDDEN");
  for (const line of byId.webhooks.lines) assert.equal(line.value, "–");
  assert.equal(byId.keys.state, "ready");
  assert.equal(values(byId.contracts).active, "1");
  assert.equal(values(byId.links).links, "0");
  assert.equal(byId["rule-book"].state, "ready");
});
