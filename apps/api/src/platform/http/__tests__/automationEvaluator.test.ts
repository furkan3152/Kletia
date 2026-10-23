/**
 * The automation evaluator against the memory store, a recording planner and
 * fixed reads (no network): schedule windows fire once (also when two
 * evaluators race), price crossings with hysteresis, limits (cooldown, USD
 * caps, unpriced inputs, networks), Rule Book refusals as failed runs,
 * native order providers, the rebalance plan, expiry, revoked owners and
 * completion; plus the Postgres store's window uniqueness when
 * KLETIA_TEST_DATABASE_URL is set.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { beforeEach, describe, it } from "node:test";
import { validateAutomationDraft, type AutomationOwner, type IntentGraph, type IntentRequest, type NativeOrderProvider, type VenueRate } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { useTestEnvironment } from "./support.js";

useTestEnvironment();
const { evaluateAutomation, runAutomationPass } = await import("../../automation/evaluator.js");
const { MemoryAutomationStore, PostgresAutomationStore, ownerRefOf } = await import("../../automation/store.js");
const { configureNativeOrderProviders } = await import("../../automation/providers.js");
const { closePlatformDatabase } = await import("../db.js");
type Deps = import("../../automation/evaluator.js").EvaluatorDeps;
type Record_ = import("../../automation/store.js").AutomationRecord;

const ACCOUNT = "eip155:8453:0x4f183e308f24c81c05303821AD025812fBFd807D";
const OWNER: AutomationOwner = { kind: "key", keyId: "key_000000000000000000000001", projectId: "key_000000000000000000000001" };
const START = Date.parse("2026-11-02T09:00:00Z");
const HOUR = 3_600_000;

let store: import("../../automation/store.js").AutomationStore;
let planned: { request: IntentRequest; dryRun: boolean; owner?: string }[];
let price: number | null;
let notional: bigint | null;
let rates: VenueRate[];
let plannerError: PlatformError | null;
let networkOfPlan: "base" | "arbitrum";
let ownerAlive: boolean;
let sequence = 0;

function graph(request: IntentRequest): IntentGraph {
  sequence += 1;
  return {
    id: `int_${String(sequence).padStart(24, "0")}`,
    summary: { title: request.text ?? "Rebalance", inputs: [], outputs: [], networks: [networkOfPlan], signaturesRequired: 1, crossNetwork: false },
    steps: [{ network: networkOfPlan, protocol: "erc20-transfer" }],
  } as unknown as IntentGraph;
}

function deps(): Deps {
  return {
    store,
    reads: {
      priceUsd: async () => price,
      balance: async () => 0,
      rates: async () => rates,
      notionalUsdMicros: async () => notional,
    },
    planner: async (request, options) => {
      planned.push({ request, dryRun: options.dryRun === true, ...(options.ownerKeyId ? { owner: options.ownerKeyId } : {}) });
      if (plannerError) throw plannerError;
      return { intent: graph(request) };
    },
    ownerLive: async () => ownerAlive,
  };
}

async function rule(input: Record<string, unknown>, now = START - HOUR): Promise<Record_> {
  const parsed = validateAutomationDraft({ action: { kind: "intent", text: "buy $50 of ETH", accounts: [ACCOUNT] }, ...input }, now);
  assert.ok(parsed.ok, JSON.stringify(parsed.ok ? null : parsed.issues));
  const at = new Date(now).toISOString();
  const record: Record_ = {
    id: `au_${randomBytes(12).toString("hex")}`, ownerRef: ownerRefOf(OWNER), owner: OWNER, label: null, trigger: parsed.value.trigger, action: parsed.value.action,
    limits: parsed.value.limits, status: "active", statusReason: null, state: { epoch: 0 }, runs: 0, spentUsdMicros: "0", lastRunAt: null, checkedAt: null, createdAt: at, updatedAt: at,
  };
  assert.equal(await store.create(record, 50), true);
  return record;
}

const weekly = { kind: "schedule", every: { unit: "week", count: 1 }, startAt: new Date(START).toISOString() };

async function fresh(id: string): Promise<Record_> {
  const record = await store.get(id);
  assert.ok(record);
  return record;
}

beforeEach(() => {
  store = new MemoryAutomationStore();
  planned = [];
  price = null;
  notional = 50_000_000n;
  rates = [];
  plannerError = null;
  networkOfPlan = "base";
  ownerAlive = true;
  configureNativeOrderProviders([]);
});

describe("automation evaluator", () => {
  it("fires a schedule slot once: a dry run, then the stored intent with the run's ids", async () => {
    const record = await rule({ trigger: weekly });
    assert.equal((await evaluateAutomation(record, START - 1, deps())).fired, false, "before the first slot");
    const first = await evaluateAutomation(await fresh(record.id), START + 60_000, deps());
    assert.equal(first.fired, true);
    assert.equal(first.run?.status, "needs_signature");
    assert.deepEqual(planned.map((call) => call.dryRun), [true, false]);
    assert.equal(planned[1]?.owner, OWNER.kind === "key" ? OWNER.keyId : undefined, "the owner key's rule book applies");
    assert.equal(planned[1]?.request.clientReference, `automation:${first.run?.id}`);
    assert.deepEqual(planned[1]?.request.metadata, { automationId: record.id, automationRunId: first.run?.id });
    assert.equal((await evaluateAutomation(await fresh(record.id), START + 120_000, deps())).fired, false, "same slot");
    const after = await fresh(record.id);
    assert.deepEqual([after.runs, after.spentUsdMicros, after.state.lastSlot], [1, "50000000", new Date(START).toISOString()]);
    assert.equal((await evaluateAutomation(after, START + 7 * 24 * HOUR, deps())).fired, true, "next week");
  });

  it("two evaluators racing on one window produce one run", async () => {
    const record = await rule({ trigger: weekly });
    const [a, b] = await Promise.all([evaluateAutomation(record, START + 1_000, deps()), evaluateAutomation(record, START + 2_000, deps())]);
    assert.equal(Number(a.fired) + Number(b.fired), 1);
    assert.equal((await store.listRuns(record.id, 10)).length, 1);
  });

  it("price triggers fire on the crossing only, never every tick while below", async () => {
    const record = await rule({ trigger: { kind: "price", asset: "SOL", network: "solana", direction: "below", priceUsd: "120", hysteresisBps: 200 } });
    const ticks: [number | null, boolean][] = [[130, false], [null, false], [119, true], [118, false], [121, false], [119.5, false], [125, false], [119, true]];
    let now = START;
    for (const [value, fires] of ticks) {
      price = value;
      now += 60_000;
      assert.equal((await evaluateAutomation(await fresh(record.id), now, deps())).fired, fires, `price ${value}`);
    }
    assert.deepEqual((await store.listRuns(record.id, 10)).map((run) => run.window).sort(), ["cross:1", "cross:2"]);
  });

  it("skips runs outside the limits with a reason, and never spends the cap on a skip", async () => {
    const capped = await rule({ trigger: weekly, limits: { maxUsdPerRun: "25" } });
    let result = await evaluateAutomation(capped, START, deps());
    assert.deepEqual([result.run?.status, result.run?.reason, planned.length], ["skipped", "over_run_limit", 1], "only the dry run was planned");
    notional = null;
    const unpriced = await rule({ trigger: weekly, limits: { maxUsdTotal: "100" } });
    result = await evaluateAutomation(unpriced, START, deps());
    assert.equal(result.run?.reason, "unpriced");
    notional = 60_000_000n;
    const total = await rule({ trigger: { ...weekly, every: { unit: "day", count: 1 } }, limits: { maxUsdTotal: "100" } });
    assert.equal((await evaluateAutomation(total, START, deps())).run?.status, "needs_signature");
    assert.equal((await evaluateAutomation(await fresh(total.id), START + 24 * HOUR, deps())).run?.reason, "over_total_limit");
    assert.equal((await fresh(total.id)).spentUsdMicros, "60000000");
    networkOfPlan = "arbitrum";
    const scoped = await rule({ trigger: weekly, limits: { networks: ["base"] } });
    assert.equal((await evaluateAutomation(scoped, START, deps())).run?.reason, "network_not_allowed");
  });

  it("holds the cooldown between runs", async () => {
    const record = await rule({ trigger: { ...weekly, every: { unit: "hour", count: 1 } }, limits: { cooldownSeconds: 2 * 3600 } });
    assert.equal((await evaluateAutomation(record, START, deps())).run?.status, "needs_signature");
    assert.equal((await evaluateAutomation(await fresh(record.id), START + HOUR, deps())).run?.reason, "cooldown");
    assert.equal((await evaluateAutomation(await fresh(record.id), START + 2 * HOUR, deps())).run?.status, "needs_signature");
  });

  it("records a Rule Book refusal as a failed run with its code", async () => {
    plannerError = new PlatformError("POLICY_SPEND_LIMIT", "The daily cap is spent.", 403);
    const record = await rule({ trigger: weekly });
    const result = await evaluateAutomation(record, START, deps());
    assert.deepEqual([result.fired, result.run?.status, result.run?.reason], [false, "failed", "POLICY_SPEND_LIMIT"]);
    assert.equal((await fresh(record.id)).runs, 0);
  });

  it("hands runs to a native order provider, falling back to the signature when it declines", async () => {
    let accept = true;
    const provider: NativeOrderProvider = {
      id: "test-orders",
      supports: (view) => view.trigger.kind === "schedule",
      execute: async () => (accept ? { accepted: true, reference: "order-1" } : { accepted: false, reason: "pair not listed" }),
    };
    configureNativeOrderProviders([provider]);
    const record = await rule({ trigger: { ...weekly, every: { unit: "day", count: 1 } } });
    const taken = await evaluateAutomation(record, START, deps());
    assert.deepEqual([taken.run?.status, taken.run?.provider], ["prepared", { id: "test-orders", reference: "order-1" }]);
    accept = false;
    const declined = await evaluateAutomation(await fresh(record.id), START + 24 * HOUR, deps());
    assert.equal(declined.run?.status, "needs_signature");
    assert.match(declined.run?.message ?? "", /declined: pair not listed/u);
  });

  it("plans a rebalance as withdraw, bridge and deposit to the best venue", async () => {
    rates = [
      { venue: "base:aave-v3:usdc", network: "base", apyBps: 380 },
      { venue: "arbitrum:aave-v3:usdc", network: "arbitrum", apyBps: 520 },
    ];
    const record = await rule({
      trigger: { kind: "apy", asset: "USDC", networks: ["base", "arbitrum"], minDeltaBps: 50, current: "base:aave-v3:usdc" },
      action: { kind: "rebalance", accounts: [ACCOUNT] },
    });
    assert.equal((await evaluateAutomation(record, START, deps())).fired, true);
    const actions = planned[1]?.request.actions ?? [];
    assert.deepEqual(actions.map((action) => [action.kind, action.network, action.amount]), [["withdraw", "base", "max"], ["bridge", "base", "max"], ["deposit", "arbitrum", "max"]]);
    assert.equal(actions[2]?.params?.venue, "arbitrum:aave-v3:usdc");
    assert.equal((await evaluateAutomation(await fresh(record.id), START + 60_000, deps())).fired, false, "already at the best venue");
  });

  it("expires, pauses for a revoked owner key and completes after maxRuns", async () => {
    const short = await rule({ trigger: weekly, limits: { expiresAt: new Date(START + HOUR).toISOString() } });
    await evaluateAutomation(short, START + 2 * HOUR, deps());
    assert.deepEqual([(await fresh(short.id)).status, (await fresh(short.id)).statusReason], ["expired", "expired"]);
    ownerAlive = false;
    const revoked = await rule({ trigger: weekly });
    await evaluateAutomation(revoked, START, deps());
    assert.deepEqual([(await fresh(revoked.id)).status, (await fresh(revoked.id)).statusReason], ["paused", "key_revoked"]);
    ownerAlive = true;
    const twice = await rule({ trigger: { ...weekly, maxRuns: 2 } });
    await evaluateAutomation(twice, START, deps());
    await evaluateAutomation(await fresh(twice.id), START + 7 * 24 * HOUR, deps());
    assert.deepEqual([(await fresh(twice.id)).status, (await fresh(twice.id)).statusReason, (await fresh(twice.id)).runs], ["completed", "max_runs", 2]);
    const report = await runAutomationPass(START + 30 * 24 * HOUR, deps());
    assert.equal(report.fired, 0, "ended rules are not evaluated");
  });

  it("fails runs an interrupted pass left firing", async () => {
    const record = await rule({ trigger: weekly });
    await store.claimRun({
      id: "ar_000000000000000000000abc", automationId: record.id, ownerRef: record.ownerRef, window: "slot:x", status: "firing", reason: null, message: null,
      observed: null, intentId: null, title: null, notionalUsdMicros: null, provider: null, firedAt: new Date(START).toISOString(), updatedAt: new Date(START).toISOString(),
    });
    const report = await runAutomationPass(START + HOUR, deps());
    assert.equal(report.interrupted, 1);
    assert.equal((await store.listRuns(record.id, 10)).find((run) => run.id === "ar_000000000000000000000abc")?.status, "failed");
  });
});

const DATABASE_URL = process.env.KLETIA_TEST_DATABASE_URL;

describe("automation store (Postgres)", { skip: DATABASE_URL ? false : "KLETIA_TEST_DATABASE_URL is not set" }, () => {
  it("keeps one run per window and one evaluator per pass", async () => {
    process.env.KLETIA_DATABASE_URL = DATABASE_URL;
    const pg = new PostgresAutomationStore();
    store = new MemoryAutomationStore();
    const record = await rule({ trigger: weekly });
    assert.equal(await pg.create(record, 50), true);
    const run = (id: string) => ({
      id, automationId: record.id, ownerRef: record.ownerRef, window: "slot:2026-11-02T09:00:00.000Z", status: "firing" as const, reason: null, message: null,
      observed: null, intentId: null, title: null, notionalUsdMicros: null, provider: null, firedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const [a, b] = await Promise.all([pg.claimRun(run(`ar_${"a".repeat(24)}`)), pg.claimRun(run(`ar_${"b".repeat(24)}`))]);
    assert.equal(Number(a !== null) + Number(b !== null), 1);
    let inner = false;
    const outer = await pg.withLeaderLock(async () => {
      inner = await new PostgresAutomationStore().withLeaderLock(async () => undefined);
    });
    assert.deepEqual([outer, inner], [true, false]);
    await pg.delete(record.id);
  });

  it("runs an evaluation end to end: state, counters, runs, owner writes", async () => {
    const pg = new PostgresAutomationStore();
    store = new MemoryAutomationStore();
    const record = await rule({ trigger: { ...weekly, maxRuns: 1 } });
    assert.equal(await pg.create(record, 50), true);
    store = pg;
    const result = await evaluateAutomation((await pg.get(record.id))!, START + 60_000, deps());
    assert.equal(result.run?.status, "needs_signature");
    const after = (await pg.get(record.id))!;
    assert.deepEqual([after.status, after.statusReason, after.runs, after.spentUsdMicros, after.state.lastSlot], ["completed", "max_runs", 1, "50000000", new Date(START).toISOString()]);
    const [run] = await pg.listRuns(record.id, 5);
    assert.deepEqual([run?.status, run?.intentId?.startsWith("int_"), run?.notionalUsdMicros], ["needs_signature", true, "50000000"]);
    assert.equal((await pg.listOwnerRuns(record.ownerRef, ["needs_signature"], new Date(START - HOUR).toISOString(), 5)).length >= 1, true);
    assert.equal(await pg.update({ ...after, label: "renamed", updatedAt: new Date().toISOString() }, after.updatedAt), true);
    assert.equal(await pg.update({ ...after, label: "stale" }, after.updatedAt), false, "optimistic on updatedAt");
    assert.equal((await pg.listByOwner(record.ownerRef, 100)).find((entry) => entry.id === record.id)?.label, "renamed");
    await pg.pruneRuns(new Date(START + HOUR).toISOString());
    assert.equal((await pg.listRuns(record.id, 5)).length, 0);
    await pg.delete(record.id);
    delete process.env.KLETIA_DATABASE_URL;
    await closePlatformDatabase();
  });
});
