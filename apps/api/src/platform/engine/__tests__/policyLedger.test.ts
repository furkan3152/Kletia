/**
 * The exposure ledger (policy design §6): rolling windows per scope,
 * mutually exclusive groups counted once at their largest amount, atomic
 * reservations under concurrency, Retry-After arithmetic, idempotent
 * replays, chain-head re-checks, Solana expiry and nonce overrides.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DAY_MS, MemorySpendLedger, WEEK_MS, windowRetryAt, windowUsage } from "../policy/memory.js";
import type { ExposureRecord, ScopeCap } from "../policy/ports.js";

const PROJECT = "prj_00000000000000000000aaaa";
const ROOT = "key_000000000000000000000001";
const AGENT_A = "key_00000000000000000000000a";
const AGENT_B = "key_00000000000000000000000b";
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0);
const usd = (dollars: number) => BigInt(Math.round(dollars * 1_000_000));

let serial = 0;
function exposure(overrides: Partial<ExposureRecord> = {}): ExposureRecord {
  serial += 1;
  return {
    id: `px_${serial.toString(16).padStart(24, "0")}`,
    projectId: PROJECT,
    ownerKeyId: AGENT_A,
    intentId: `int_${"0".repeat(31)}${serial % 10}`,
    stepId: "s1",
    network: "base",
    quoteBinding: "a".repeat(64),
    exclusiveKey: null,
    validUntilHeight: null,
    usdMicros: usd(100),
    decisionId: `pdc_${"0".repeat(24)}`,
    createdAt: T0,
    ...overrides,
  };
}

const daily = (scope: string, dollars: number): ScopeCap => ({ scope, dailyUsdMicros: usd(dollars) });

describe("exposure ledger", () => {
  it("sums rolling 24 h and 7 d windows per scope and drops dead exposures", async () => {
    const ledger = new MemorySpendLedger();
    await ledger.reserve({ exposure: exposure({ createdAt: T0 - 2 * DAY_MS }), scopes: [AGENT_A, PROJECT], caps: [], chain: [], now: T0 });
    await ledger.reserve({ exposure: exposure({ createdAt: T0 - 60_000, usdMicros: usd(40) }), scopes: [AGENT_A, PROJECT], caps: [], chain: [], now: T0 });
    const dead = exposure({ usdMicros: usd(500) });
    await ledger.reserve({ exposure: dead, scopes: [AGENT_A, PROJECT], caps: [], chain: [], now: T0 });
    await ledger.abort(dead.id);
    const usage = await ledger.usage([AGENT_A, PROJECT, AGENT_B], T0);
    assert.deepEqual(usage.get(AGENT_A), { dayUsdMicros: usd(40), weekUsdMicros: usd(140) });
    assert.deepEqual(usage.get(PROJECT), { dayUsdMicros: usd(40), weekUsdMicros: usd(140) });
    assert.deepEqual(usage.get(AGENT_B), { dayUsdMicros: 0n, weekUsdMicros: 0n });
  });

  it("refuses a reservation that would cross any capped scope and writes nothing", async () => {
    const ledger = new MemorySpendLedger();
    const first = await ledger.reserve({ exposure: exposure({ usdMicros: usd(600) }), scopes: [AGENT_A, ROOT, PROJECT], caps: [daily(AGENT_A, 1_000), daily(PROJECT, 700)], chain: [], now: T0 });
    assert.equal(first.ok, true);
    const second = await ledger.reserve({ exposure: exposure({ usdMicros: usd(150) }), scopes: [AGENT_A, ROOT, PROJECT], caps: [daily(AGENT_A, 1_000), daily(PROJECT, 700)], chain: [], now: T0 + 1_000 });
    assert.equal(second.ok, false);
    assert.ok(!second.ok && second.reason === "cap");
    if (!second.ok && second.reason === "cap") {
      assert.equal(second.scope, PROJECT);
      assert.equal(second.window, "24h");
      assert.equal(second.retryAt, T0 + DAY_MS + 1, "when the $600 leaves the window");
    }
    assert.equal((await ledger.usage([AGENT_A], T0 + 2_000)).get(AGENT_A)?.dayUsdMicros, usd(600), "nothing written for the refused one");
  });

  it("counts payloads sharing a pinned nonce once, at their largest amount", async () => {
    const ledger = new MemorySpendLedger();
    const key = "evm:8453:0x4f183e308f24c81c05303821ad025812fbfd807d:7";
    const caps = [daily(AGENT_A, 150)];
    const a = await ledger.reserve({ exposure: exposure({ exclusiveKey: key, usdMicros: usd(100) }), scopes: [AGENT_A], caps, chain: [], now: T0 });
    const b = await ledger.reserve({ exposure: exposure({ exclusiveKey: key, usdMicros: usd(120) }), scopes: [AGENT_A], caps, chain: [], now: T0 + 1 });
    assert.ok(a.ok && b.ok);
    if (b.ok) assert.equal(b.usage[0]?.deltaUsdMicros, usd(20), "only the growth counts");
    assert.equal((await ledger.usage([AGENT_A], T0 + 2)).get(AGENT_A)?.dayUsdMicros, usd(120));
    // An unpinned payload of the same size counts on its own.
    const c = await ledger.reserve({ exposure: exposure({ usdMicros: usd(100) }), scopes: [AGENT_A], caps, chain: [], now: T0 + 3 });
    assert.equal(c.ok, false);
    // A landed transaction that overrode the nonce: the group counts in full.
    await ledger.clearExclusive(key);
    assert.equal((await ledger.usage([AGENT_A], T0 + 4)).get(AGENT_A)?.dayUsdMicros, usd(220));
  });

  it("is idempotent per exposure id", async () => {
    const ledger = new MemorySpendLedger();
    const record = exposure({ usdMicros: usd(90) });
    const caps = [daily(AGENT_A, 100)];
    const first = await ledger.reserve({ exposure: record, scopes: [AGENT_A, PROJECT], caps, chain: [], now: T0 });
    const replay = await ledger.reserve({ exposure: record, scopes: [AGENT_A, PROJECT], caps, chain: [], now: T0 + 5 });
    assert.ok(first.ok && !first.replayed);
    assert.ok(replay.ok && replay.replayed, "a retried reservation is accepted without counting twice");
    assert.equal((await ledger.usage([AGENT_A], T0 + 6)).get(AGENT_A)?.dayUsdMicros, usd(90));
  });

  it("refuses when the rule book heads moved under the lock (a pause committed first)", async () => {
    let heads = [{ scope: "key" as const, id: AGENT_A, version: 1, hash: `sha256:${"1".repeat(64)}` }];
    const ledger = new MemorySpendLedger({ currentChain: async () => heads });
    const ok = await ledger.reserve({ exposure: exposure(), scopes: [AGENT_A], caps: [], chain: heads, now: T0 });
    assert.equal(ok.ok, true);
    const stale = heads;
    heads = [{ ...stale[0] as (typeof stale)[number], version: 2, hash: `sha256:${"2".repeat(64)}` }];
    const moved = await ledger.reserve({ exposure: exposure(), scopes: [AGENT_A], caps: [], chain: stale, now: T0 });
    assert.deepEqual(moved, { ok: false, reason: "chain_changed" });
  });

  it("serialises concurrent reservations per project: 60 × $30 under a $1,000 project cap accepts exactly 33", async () => {
    const ledger = new MemorySpendLedger();
    const results = await Promise.all(Array.from({ length: 60 }, (_, index) => {
      const owner = index % 2 === 0 ? AGENT_A : AGENT_B;
      return ledger.reserve({
        exposure: exposure({ ownerKeyId: owner, usdMicros: usd(30) }),
        scopes: [owner, ROOT, PROJECT],
        caps: [daily(owner, 600), daily(PROJECT, 1_000)],
        chain: [],
        now: T0,
      });
    }));
    assert.equal(results.filter((result) => result.ok).length, 33);
    const usage = await ledger.usage([AGENT_A, AGENT_B, PROJECT], T0);
    assert.equal(usage.get(PROJECT)?.dayUsdMicros, usd(990));
    assert.ok((usage.get(AGENT_A)?.dayUsdMicros ?? 0n) <= usd(600));
    assert.ok((usage.get(AGENT_B)?.dayUsdMicros ?? 0n) <= usd(600));
  });

  it("marks landed exposures, records uncleared ones and expires Solana payloads past their block height", async () => {
    const ledger = new MemorySpendLedger();
    const evm = exposure({ intentId: "int_e", stepId: "s1", quoteBinding: "b".repeat(64) });
    await ledger.reserve({ exposure: evm, scopes: [AGENT_A], caps: [], chain: [], now: T0 });
    assert.deepEqual((await ledger.land({ intentId: "int_e", stepId: "s1", quoteBinding: "b".repeat(64), now: T0 })).map((entry) => entry.id), [evm.id]);
    assert.equal((await ledger.land({ intentId: "int_e", stepId: "s1", quoteBinding: "c".repeat(64), now: T0 })).length, 0, "an unknown binding has no exposure");
    const sol1 = exposure({ intentId: "int_s", network: "solana", validUntilHeight: 1_000 });
    const sol2 = exposure({ intentId: "int_s", network: "solana", validUntilHeight: 3_000 });
    await ledger.reserve({ exposure: sol1, scopes: [AGENT_A], caps: [], chain: [], now: T0 });
    await ledger.reserve({ exposure: sol2, scopes: [AGENT_A], caps: [], chain: [], now: T0 });
    assert.equal(await ledger.expire("int_s", "s1", 2_000n), 1);
    const states = new Map(ledger.snapshot().map((row) => [row.record.id, row.state]));
    assert.equal(states.get(sol1.id), "dead");
    assert.equal(states.get(sol2.id), "open");
    assert.equal(states.get(evm.id), "landed");
    const uncleared = exposure({ usdMicros: usd(5) });
    await ledger.recordLanded(uncleared, [AGENT_A, PROJECT]);
    await ledger.recordLanded(uncleared, [AGENT_A, PROJECT]);
    assert.equal(ledger.snapshot().filter((row) => row.record.id === uncleared.id && row.state === "landed").length, 2, "one row per scope, once");
  });

  it("computes the window arithmetic used by both ledgers", () => {
    const groups = [
      { key: "a", usdMicros: usd(300), at: T0 - 20 * 3_600_000 },
      { key: "b", usdMicros: usd(500), at: T0 - 10 * 3_600_000 },
      { key: "c", usdMicros: usd(100), at: T0 - 3 * DAY_MS },
    ];
    assert.deepEqual(windowUsage(groups, T0), { dayUsdMicros: usd(800), weekUsdMicros: usd(900) });
    assert.equal(windowRetryAt(groups, usd(1_000), usd(100), DAY_MS, T0), T0, "fits now");
    assert.equal(windowRetryAt(groups, usd(1_000), usd(400), DAY_MS, T0), T0 - 20 * 3_600_000 + DAY_MS + 1, "after the oldest group leaves");
    assert.equal(windowRetryAt(groups, usd(1_000), usd(900), DAY_MS, T0), T0 - 10 * 3_600_000 + DAY_MS + 1);
    assert.equal(windowRetryAt(groups, usd(1_000), usd(1_001), DAY_MS, T0), null, "never fits");
    assert.ok((windowRetryAt(groups, usd(1_000), usd(950), WEEK_MS, T0) ?? 0) <= T0 + WEEK_MS, "capped at 7 days");
  });
});
