// The Webhooks page's pure parts: delivery rows, the URL pre-check
// (mirrors the API's static checks), event selection, scope labels and
// what a key may do. Run with Node 22.18 or later:
//   node --test apps/web/src/app/pages/developers/__tests__/*.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { CONTRACT_EVENT_TYPES } from "@kletia/core";

import {
  buildEvents,
  checkWebhookUrl,
  deliveryRowModel,
  eventsSummary,
  filterDeliveries,
  groupState,
  lastDeliverySummary,
  scopeLabel,
  toggleGroup,
  utcStamp,
  webhookPermissions,
  WEBHOOK_EVENT_GROUPS,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_MAX_ATTEMPTS,
} from "../webhooks/webhookModel.ts";

const base = { id: "whd_1", eventId: "evt_1", eventType: "contract.activated", at: "2026-10-14T14:08:53.120Z" };

test("delivery rows: attempts of four, retries in UTC, and Gave up after the last failure", () => {
  assert.equal(WEBHOOK_MAX_ATTEMPTS, 4);
  const retrying = deliveryRowModel({ ...base, attempt: 1, status: "failed", error: "http_status", httpStatus: 405, durationMs: 175.4, nextRetryAt: "2026-10-14T14:08:54.200Z" });
  assert.equal(retrying.attempt, "1 of 4");
  assert.equal(retrying.time, "14:08:53");
  assert.equal(retrying.http, "405");
  assert.equal(retrying.duration, "175 ms");
  assert.equal(retrying.nextRetry, "14:08:54 UTC");
  assert.equal(retrying.status.tone, "warning");
  assert.equal(retrying.status.label, "Retrying");
  assert.match(retrying.problem, /HTTP 405/u);

  const gaveUp = deliveryRowModel({ ...base, eventType: "intent.step_updated", intentId: "int_7585", attempt: 4, status: "failed", error: "http_status", httpStatus: 405 });
  assert.equal(gaveUp.attempt, "4 of 4");
  assert.equal(gaveUp.status.label, "Gave up");
  assert.equal(gaveUp.status.tone, "danger");
  assert.equal(gaveUp.nextRetry, "–");
  assert.equal(gaveUp.intentId, "int_7585");

  const delivered = deliveryRowModel({ ...base, attempt: 2, status: "succeeded", httpStatus: 200, durationMs: 80 });
  assert.equal(delivered.status.tone, "success");
  assert.equal(delivered.status.label, "Delivered");
  assert.equal(delivered.problem, null);
  assert.equal(delivered.failed, false);

  // A test event is sent once: its failure is "Failed", never a retry.
  const testRow = deliveryRowModel({ ...base, eventType: "webhook.test", attempt: 1, status: "failed", error: "http_status", httpStatus: 405, test: true });
  assert.equal(testRow.attempt, "1 of 1");
  assert.equal(testRow.status.label, "Failed");
  assert.equal(testRow.status.tone, "danger");

  const unreached = deliveryRowModel({ ...base, attempt: 1, status: "failed", error: "timeout" });
  assert.equal(unreached.http, "–");
  assert.equal(unreached.duration, "–");
  const dropped = deliveryRowModel({ ...base, attempt: 1, status: "dropped", error: "queue_full" });
  assert.equal(dropped.status.tone, "danger");
  assert.match(dropped.problem, /dropped/u);

  assert.deepEqual(filterDeliveries([retrying, delivered, gaveUp], "failed").map((row) => row.status.label), ["Retrying", "Gave up"]);
  assert.equal(filterDeliveries([retrying, delivered], "all").length, 2);
  assert.deepEqual(lastDeliverySummary([{ ...base, attempt: 1, status: "failed", httpStatus: 405, nextRetryAt: "2026-10-14T14:08:54Z" }]).text, "405 · 14:08 UTC");
  assert.equal(lastDeliverySummary([]), null);
  assert.equal(utcStamp("2026-10-14T13:57:00Z"), "14 Oct 2026, 13:57 UTC");
  assert.equal(utcStamp("nope"), "–");
});

test("the URL pre-check mirrors the API: https, no credentials, a public host", () => {
  assert.deepEqual(checkWebhookUrl(" https://example.com/kletia/d7 "), { ok: true, url: "https://example.com/kletia/d7" });
  assert.equal(checkWebhookUrl("https://example.com:8443/hook").ok, true);
  assert.equal(checkWebhookUrl("https://8.8.8.8/hook").ok, true);
  assert.equal(checkWebhookUrl("https://[2606:4700::1111]/hook").ok, true);
  const refused = {
    "": /Enter/u,
    "example.com/hook": /absolute URL/u,
    "http://example.com/hook": /HTTPS/u,
    "https://user:pw@example.com/hook": /credentials/u,
    "https://example.com/hook#x": /fragment/u,
    "https://example.com:22/hook": /port/u,
    "https://localhost/hook": /public DNS name/u,
    "https://api.internal/hook": /public DNS name/u,
    "https://intranet/hook": /public DNS name/u,
    "https://127.0.0.1/hook": /public internet address/u,
    "https://10.1.2.3/hook": /public internet address/u,
    "https://169.254.169.254/latest": /public internet address/u,
    "https://[::1]/hook": /public internet address/u,
    "https://[fd00:ec2::254]/hook": /public internet address/u,
    "https://[2001:db8::1]/hook": /public internet address/u,
  };
  for (const [url, message] of Object.entries(refused)) {
    const result = checkWebhookUrl(url);
    assert.equal(result.ok, false, url);
    assert.match(result.message, message, url);
  }
  assert.equal(checkWebhookUrl(`https://example.com/${"a".repeat(2100)}`).ok, false);
});

test("event selection builds events in API order, or leaves it out for every current type", () => {
  assert.deepEqual(buildEvents("all", ["intent.created"]), { ok: true, events: undefined });
  const chosen = buildEvents("choose", ["contract.activated", "intent.status_changed", "intent.step_updated", "not.a.type"]);
  assert.deepEqual(chosen, { ok: true, events: ["intent.status_changed", "intent.step_updated", "contract.activated"] });
  const none = buildEvents("choose", []);
  assert.equal(none.ok, false);
  assert.match(none.message, /at least one/u);

  const contracts = WEBHOOK_EVENT_GROUPS.find((group) => group.id === "contract");
  assert.deepEqual(contracts.types, [...CONTRACT_EVENT_TYPES]);
  let selected = toggleGroup(contracts, new Set(), true);
  assert.equal(groupState(contracts, selected), "all");
  selected.delete("contract.suspended");
  assert.equal(groupState(contracts, selected), "some");
  selected = toggleGroup(contracts, selected, false);
  assert.equal(groupState(contracts, selected), "none");
  assert.ok(WEBHOOK_EVENT_TYPES.includes("intent.receipt_issued"));
  assert.equal(new Set(WEBHOOK_EVENT_TYPES).size, WEBHOOK_EVENT_TYPES.length, "no type twice");

  assert.equal(eventsSummary(["intent.created"]), "intent.created");
  assert.equal(eventsSummary(["intent.created", "contract.activated", "link.paused"]), "3 types");
  assert.equal(eventsSummary(WEBHOOK_EVENT_TYPES), `Every type (${WEBHOOK_EVENT_TYPES.length})`);
});

test("scope labels and what each key may do", () => {
  assert.equal(scopeLabel("self"), "This key");
  assert.equal(scopeLabel(undefined), "This key");
  assert.equal(scopeLabel("subtree"), "This key and its agent keys");
  const developer = webhookPermissions("developer");
  assert.deepEqual([developer.read, developer.create, developer.test, developer.remove], [true, true, true, true]);
  const agent = webhookPermissions("agent");
  assert.deepEqual([agent.read, agent.create, agent.test, agent.remove], [true, false, false, false], "unknown grant: read only");
  assert.match(agent.summary, /permissions\.webhooks/u);
  const refused = webhookPermissions("agent", false);
  assert.deepEqual([refused.create, refused.test, refused.remove], [false, false, false]);
  assert.match(refused.summary, /developer key/u);
  const granted = webhookPermissions("agent", true);
  assert.deepEqual([granted.read, granted.create, granted.test, granted.remove], [true, true, true, true]);
  assert.equal(webhookPermissions(null).read, false);
});
