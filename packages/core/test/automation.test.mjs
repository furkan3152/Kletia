import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTOMATION_EVENT_TYPES,
  AUTOMATION_SENTENCE_SHAPES,
  AGENT_POLICY_DEFAULTS,
  ERROR_CATALOG,
  automationIntentRequest,
  evaluateApy,
  evaluateCrossing,
  evaluateIncoming,
  evaluateSchedule,
  latestScheduleSlot,
  nextScheduleSlot,
  planAutomationFromGoal,
  scheduleSlotTime,
  validateAutomationDraft,
  validateAutomationPatch,
} from "../dist/index.js";

const EVM = "eip155:8453:0x4f183e308f24c81c05303821AD025812fBFd807D";
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const NOW = Date.parse("2026-10-23T12:00:00Z");
const fresh = { epoch: 0 };

const weekly = { kind: "schedule", every: { unit: "week", count: 1 }, startAt: "2026-10-26T09:00:00.000Z" };

test("schedules step in UTC: daylight saving never moves a run", () => {
  // Europe/Berlin leaves summer time on 2026-10-25; the UTC slots keep their hour.
  const daily = { kind: "schedule", every: { unit: "day", count: 1 }, startAt: "2026-10-24T07:00:00.000Z", timezone: "Europe/Berlin" };
  assert.equal(new Date(scheduleSlotTime(daily, 1)).toISOString(), "2026-10-25T07:00:00.000Z");
  assert.equal(new Date(scheduleSlotTime(daily, 2)).toISOString(), "2026-10-26T07:00:00.000Z");
  assert.equal(new Date(scheduleSlotTime(weekly, 3)).toISOString(), "2026-11-16T09:00:00.000Z");
});

test("monthly schedules keep the start's day, clamped to short months", () => {
  const monthly = { kind: "schedule", every: { unit: "month", count: 1 }, startAt: "2027-01-31T08:00:00.000Z" };
  assert.equal(new Date(scheduleSlotTime(monthly, 1)).toISOString(), "2027-02-28T08:00:00.000Z");
  assert.equal(new Date(scheduleSlotTime(monthly, 2)).toISOString(), "2027-03-31T08:00:00.000Z");
  assert.deepEqual(latestScheduleSlot(monthly, Date.parse("2027-03-30T00:00:00Z")), { index: 1, at: Date.parse("2027-02-28T08:00:00Z") });
});

test("a schedule fires once for the latest due slot and never twice for one slot", () => {
  assert.equal(evaluateSchedule(weekly, fresh, NOW).fire, false, "before the start");
  const due = Date.parse("2026-11-09T10:00:00Z");
  const first = evaluateSchedule(weekly, fresh, due);
  assert.equal(first.fire, true);
  assert.equal(first.window, "slot:2026-11-09T09:00:00.000Z", "missed slots are not caught up");
  assert.equal(evaluateSchedule(weekly, first.state, due + 60_000).fire, false);
  assert.equal(evaluateSchedule(weekly, first.state, Date.parse("2026-11-16T09:00:00Z")).fire, true);
  assert.equal(nextScheduleSlot(weekly, due), Date.parse("2026-11-16T09:00:00Z"));
  assert.equal(nextScheduleSlot({ ...weekly, maxRuns: 2 }, due, 2), null);
  assert.equal(nextScheduleSlot({ ...weekly, endAt: "2026-11-10T00:00:00.000Z" }, due), null);
});

test("price crossings fire once and re-arm only past the hysteresis band", () => {
  const trigger = { direction: "below", hysteresisBps: 200 };
  const at = "2026-10-23T12:00:00.000Z";
  let verdict = evaluateCrossing(trigger, 120, fresh, 130, at);
  assert.deepEqual([verdict.fire, verdict.state.armed], [false, true], "first observation arms");
  verdict = evaluateCrossing(trigger, 120, verdict.state, 119.5, at);
  assert.equal(verdict.fire, true);
  assert.equal(verdict.window, "cross:1");
  for (const price of [118, 121, 119, 122]) {
    verdict = evaluateCrossing(trigger, 120, verdict.state, price, at);
    assert.equal(verdict.fire, false, `no refire at ${price} (re-arms only at 122.4)`);
  }
  verdict = evaluateCrossing(trigger, 120, verdict.state, 123, at);
  assert.equal(verdict.state.armed, true);
  verdict = evaluateCrossing(trigger, 120, verdict.state, 120, at);
  assert.deepEqual([verdict.fire, verdict.window], [true, "cross:2"]);
});

test("a condition already true at the first observation waits for a crossing", () => {
  const verdict = evaluateCrossing({ direction: "above" }, 3000, fresh, 3100, "t");
  assert.deepEqual([verdict.fire, verdict.state.armed], [false, false]);
  assert.equal(evaluateCrossing({ direction: "above" }, 3000, verdict.state, 3200, "t").fire, false);
});

test("incoming transfers are balance increases of at least minAmount", () => {
  const trigger = { kind: "event", account: SOL, asset: "USDC", minAmount: "10" };
  let verdict = evaluateIncoming(trigger, fresh, 50, "t");
  assert.equal(verdict.fire, false, "first read only records");
  verdict = evaluateIncoming(trigger, verdict.state, 55, "t");
  assert.equal(verdict.fire, false, "5 is below the minimum");
  verdict = evaluateIncoming(trigger, verdict.state, 80, "t");
  assert.deepEqual([verdict.fire, verdict.window, verdict.observed], [true, "in:1", "25"]);
  assert.equal(evaluateIncoming(trigger, verdict.state, 20, "t").fire, false, "a decrease never fires");
});

test("apy rebalances fire on the delta and never on an unreadable current venue", () => {
  const trigger = { kind: "apy", asset: "USDC", networks: ["base"], minDeltaBps: 50, current: "base:aave-v3:usdc" };
  const rates = [
    { venue: "base:aave-v3:usdc", network: "base", apyBps: 400 },
    { venue: "base:morpho:usdc", network: "base", apyBps: 430 },
  ];
  assert.equal(evaluateApy(trigger, fresh, rates).fire, false, "30 bps is under the delta");
  const better = evaluateApy(trigger, fresh, [rates[0], { ...rates[1], apyBps: 470 }]);
  assert.deepEqual([better.fire, better.from, better.to, better.state.venue], [true, "base:aave-v3:usdc", "base:morpho:usdc", "base:morpho:usdc"]);
  assert.equal(evaluateApy(trigger, fresh, [{ ...rates[1], apyBps: 900 }]).fire, false, "current venue unread");
  assert.equal(evaluateApy({ ...trigger, current: undefined }, fresh, rates).to, "base:morpho:usdc", "no position yet: deposit at the best");
});

test("drafts are validated with paths, and limits get a bounded expiry", () => {
  const draft = { trigger: weekly, action: { kind: "intent", text: "buy $50 of ETH", accounts: [EVM] } };
  const ok = validateAutomationDraft(draft, NOW);
  assert.equal(ok.ok, true);
  assert.equal(ok.value.limits.expiresAt, new Date(NOW + 180 * 86_400_000).toISOString());
  const bad = validateAutomationDraft({
    trigger: { kind: "price", asset: "NOPE", network: "solana", direction: "sideways", priceUsd: "-1" },
    action: { kind: "rebalance", accounts: [] },
    limits: { expiresAt: "2030-01-01T00:00:00Z", protocols: ["not-a-protocol"] },
    extra: 1,
  }, NOW);
  assert.equal(bad.ok, false);
  const paths = bad.issues.map((issue) => issue.path);
  for (const path of ["extra", "trigger.asset", "trigger.direction", "trigger.priceUsd", "action.kind", "action.accounts", "limits.expiresAt", "limits.protocols"]) {
    assert.ok(paths.includes(path), `${path} in ${paths.join(", ")}`);
  }
  const reserved = validateAutomationDraft({ ...draft, action: { ...draft.action, clientReference: "x" } }, NOW);
  assert.equal(reserved.ok, false, "clientReference belongs to Kletia");
  assert.equal(validateAutomationPatch({ trigger: weekly }).ok, false, "the trigger never changes");
  assert.deepEqual(validateAutomationPatch({ label: null }).value, { label: null });
});

test("a run's request carries its ids and the tighter slippage cap", () => {
  const request = automationIntentRequest(
    { kind: "intent", text: "buy $50 of ETH", accounts: [EVM], constraints: { maxSlippageBps: 80 } },
    { maxSlippageBps: 30 },
    { automationId: "au_000000000000000000000001", runId: "ar_000000000000000000000001" },
  );
  assert.equal(request.constraints.maxSlippageBps, 30);
  assert.equal(request.clientReference, "automation:ar_000000000000000000000001");
  assert.deepEqual(request.metadata, { automationId: "au_000000000000000000000001", automationRunId: "ar_000000000000000000000001" });
});

test("every sentence shape becomes a valid draft; weekly starts on the next Monday at 09:00 local", () => {
  for (const shape of AUTOMATION_SENTENCE_SHAPES) {
    const draft = planAutomationFromGoal(shape.goal, { now: NOW, accounts: [EVM, SOL] });
    assert.equal(draft.ok, true, `${shape.sentence}: ${JSON.stringify(draft.issues)}`);
  }
  const istanbul = planAutomationFromGoal(
    { trigger: { kind: "every", unit: "week", weekday: "mon", at: "09:00", timezone: "Europe/Istanbul" }, action: { kind: "intent", text: "buy $50 of ETH" } },
    { now: NOW, accounts: [EVM] },
  );
  assert.equal(istanbul.value.trigger.startAt, "2026-10-26T06:00:00.000Z");
  const newYork = planAutomationFromGoal(
    { trigger: { kind: "every", unit: "month", dayOfMonth: 1, at: "08:30", timezone: "America/New_York" }, action: { kind: "intent", text: "send 100 USDC to vitalik.eth" } },
    { now: NOW, accounts: [EVM] },
  );
  assert.equal(newYork.value.trigger.startAt, "2026-11-01T13:30:00.000Z", "EST on Nov 1 2026 is UTC-5");
});

test("automations are a Rule Book permission agents lack by default, with events and error codes", () => {
  assert.equal(AGENT_POLICY_DEFAULTS.permissions.automations, false);
  assert.deepEqual([...AUTOMATION_EVENT_TYPES], ["automation.created", "automation.updated", "automation.deleted", "automation.fired", "automation.skipped", "automation.failed"]);
  for (const code of ["AUTOMATION_NOT_FOUND", "AUTOMATION_DRAFT_INVALID", "AUTOMATION_LIMIT_REACHED", "AUTOMATION_OWNER_REQUIRED", "AUTOMATION_ACCOUNT_FORBIDDEN", "AUTOMATION_ENDED"]) {
    assert.ok(ERROR_CATALOG[code], code);
  }
});
