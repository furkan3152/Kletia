import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, describe, it } from "node:test";
import type { IntentGraph } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { configureGasReserveReader, planIntent } from "../planner.js";
import { isActiveGraph, MemoryIntentStore, PostgresIntentStore, type IntentStore } from "../store.js";
import { nextTimestamp } from "../util.js";
import { ACCOUNTS, FUNDED_GAS_FACTS, OTHER_EVM_ADDRESS, resetEngine } from "./helpers.js";

async function graph(): Promise<IntentGraph> {
  resetEngine();
  return planIntent({ text: "swap 1 SOL to USDC", accounts: ACCOUNTS, clientReference: "ref-1" });
}

// Durable stores share one database across tests and runs: owner keys are unique per call.
let ownerSequence = 0;
const ownerRun = `${process.pid.toString(36)}${Date.now().toString(36)}`;
function owner(name: string): string {
  ownerSequence += 1;
  return `${name}_${ownerRun}_${ownerSequence}`;
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof PlatformError);
    return error.code;
  }
  return "OK";
}

function contract(name: string, make: () => Promise<IntentStore>): void {
  describe(`${name} intent store`, () => {
    it("lists retention candidates by stage and deletes graphs", async () => {
      const store = await make();
      if (!store.listForRetention || !store.delete) throw new Error("the built-in stores implement retention");
      const planned = await graph();
      // Long finished: sorts first in a shared database.
      const finished = "2001-01-01T00:00:00.000Z";
      const done: IntentGraph = {
        ...planned,
        id: `int_${randomBytes(16).toString("hex")}`,
        createdAt: finished,
        updatedAt: finished,
        expiresAt: finished,
        status: "completed",
        steps: planned.steps.map((step) => ({ ...step, status: "settled" as const })),
        request: { ...planned.request, clientReference: owner("ref") },
      };
      await store.create(done, { ownerKeyId: owner("key") });
      const at = Date.parse(finished);
      const ids = async (stage: "redact" | "purge", now: number) => (await store.listForRetention!(stage, now, 1_000)).map((entry) => entry.id);
      assert.equal((await ids("redact", at + 60_000)).includes(done.id), false, "inside the grace window");
      assert.equal((await ids("redact", at + 25 * 3_600_000)).includes(done.id), true, "text due after 24 hours");
      assert.equal((await ids("purge", at + 25 * 3_600_000)).includes(done.id), false);
      assert.equal((await ids("purge", at + 31 * 86_400_000)).includes(done.id), true, "graph due after 30 days");
      assert.equal(await store.delete(done.id), true);
      assert.equal(await store.get(done.id), null);
      assert.equal(await store.delete(done.id), false);
    });

    it("creates once and reads back a copy", async () => {
      const store = await make();
      const intent = await graph();
      await store.create(intent, { ownerKeyId: owner("key") });
      assert.equal(await code(store.create(intent, {})), "INTENT_EXISTS");
      const read = await store.get(intent.id);
      assert.deepEqual(read, intent);
      assert.equal(await store.get("int_00000000000000000000000000000000"), null);
    });

    it("keeps the amount-flow fields (funding, gas reserve, gas top-up, observed credit) and a stopped intent out of the active list", async () => {
      const store = await make();
      resetEngine();
      configureGasReserveReader(async () => ({ ...FUNDED_GAS_FACTS, balance: 0n }));
      const planned = await planIntent({
        text: `bridge 25 USDC from base to arbitrum as ETH then send it to ${OTHER_EVM_ADDRESS}`,
        accounts: ACCOUNTS,
        constraints: { gasOnArrival: { arbitrum: "0.50" } },
      });
      const [s1, s2] = planned.steps;
      assert.ok(s1?.gasTopup === undefined && s2?.funding?.gasReserve, "a native output takes no top-up; the send keeps a reserve");
      const topped = await planIntent({ text: "bridge 25 USDC from base to arbitrum", accounts: ACCOUNTS, constraints: { gasOnArrival: { arbitrum: "0.50" } } });
      const failed: IntentGraph = {
        ...topped,
        status: "failed",
        steps: topped.steps.map((entry) => ({
          ...entry,
          status: "failed" as const,
          failure: { code: "SETTLEMENT_MISMATCH", message: "below the floor" },
          observedCredit: { ...(entry.minimumOutput as NonNullable<typeof entry.minimumOutput>), amount: "1000000", formatted: "1" },
        })),
      };
      for (const intent of [planned, failed]) {
        await store.create(intent, { ownerKeyId: owner("flow") });
        assert.deepEqual(await store.get(intent.id), intent);
      }
      const stopped: IntentGraph = {
        ...planned,
        status: "partially_completed",
        steps: planned.steps.map((entry, index) => ({ ...entry, status: index === 0 ? "settled" as const : "skipped" as const })),
        updatedAt: nextTimestamp(planned.updatedAt),
      };
      await store.update(planned.id, stopped, planned.updatedAt);
      assert.deepEqual(await store.get(planned.id), stopped);
      assert.equal(isActiveGraph(stopped), false);
      assert.equal((await store.listActive(500)).some((entry) => entry.id === planned.id), false, "the poller ignores a stopped intent");
    });

    it("refuses a second intent with the same clientReference for one key", async () => {
      const store = await make();
      const keyRef = owner("key_ref");
      const first = await graph();
      await store.create(first, { ownerKeyId: keyRef });
      const second = await graph();
      assert.notEqual(second.id, first.id);
      assert.equal(await code(store.create(second, { ownerKeyId: keyRef })), "CLIENT_REFERENCE_EXISTS");
      // Another key (or a keyless intent) may reuse the same reference.
      await store.create(second, { ownerKeyId: owner("key_other") });
      const third = await graph();
      await store.create(third, {});
      assert.equal((await store.findByClientReference(keyRef, "ref-1"))?.id, first.id);
    });

    it("updates with optimistic concurrency (409 on a stale token, 404 when missing)", async () => {
      const store = await make();
      const intent = await graph();
      await store.create(intent, {});
      const first: IntentGraph = { ...intent, status: "executing", updatedAt: nextTimestamp(intent.updatedAt) };
      await store.update(intent.id, first, intent.updatedAt);
      const stale: IntentGraph = { ...intent, status: "cancelled", updatedAt: nextTimestamp(first.updatedAt) };
      assert.equal(await code(store.update(intent.id, stale, intent.updatedAt)), "INTENT_CONFLICT");
      assert.equal((await store.get(intent.id))?.status, "executing");
      assert.equal(await code(store.update("int_ffffffffffffffffffffffffffffffff", first, first.updatedAt)), "INTENT_NOT_FOUND");
      // Two writers racing from the same token: exactly one wins.
      const a: IntentGraph = { ...first, status: "settling", updatedAt: nextTimestamp(first.updatedAt) };
      const b: IntentGraph = { ...first, status: "failed", updatedAt: nextTimestamp(first.updatedAt) };
      const results = await Promise.allSettled([store.update(intent.id, a, first.updatedAt), store.update(intent.id, b, first.updatedAt)]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    });

    it("lists by owner, finds by client reference and lists active intents", async () => {
      const store = await make();
      const keyList = owner("key_list");
      const mine = await graph();
      const other = await graph();
      await store.create(mine, { ownerKeyId: keyList });
      await store.create(other, { ownerKeyId: owner("key_other") });
      assert.deepEqual((await store.listByOwner(keyList, 10)).map((entry) => entry.id), [mine.id]);
      assert.equal((await store.findByClientReference(keyList, "ref-1"))?.id, mine.id);
      assert.equal(await store.findByClientReference(keyList, "nope"), null);
      assert.equal(await store.ownerOf(mine.id), keyList);
      const keyless = await graph();
      await store.create(keyless, {});
      assert.equal(await store.ownerOf(keyless.id), null, "keyless intents have a null owner");
      assert.equal(await store.ownerOf("int_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"), undefined, "unknown intents are undefined");
      const [s1] = mine.steps;
      assert.ok(s1);
      const active: IntentGraph = { ...mine, status: "executing", updatedAt: nextTimestamp(mine.updatedAt), steps: [{ ...s1, status: "submitted" }] };
      assert.ok(isActiveGraph(active));
      await store.update(mine.id, active, mine.updatedAt);
      assert.ok((await store.listActive(50)).some((entry) => entry.id === mine.id));
      assert.ok(!(await store.listActive(50)).some((entry) => entry.id === other.id));
    });

    it("rotates active intents by poll time without touching the graph", async () => {
      const store = await make();
      // Durable stores keep earlier runs' rows: mark every active intent polled first, so
      // this test's intents are the only never-polled ones.
      const seen = new Set<string>();
      for (let round = 0; round < 20; round += 1) {
        const batch = (await store.listActive(500)).map((entry) => entry.id);
        if (batch.every((id) => seen.has(id))) break;
        batch.forEach((id) => seen.add(id));
        await store.markPolled(batch);
      }
      const intents: IntentGraph[] = [];
      for (let index = 0; index < 3; index += 1) {
        const intent = await graph();
        await store.create(intent, {});
        const [s1] = intent.steps;
        assert.ok(s1);
        // Strictly increasing update times: a, then b, then c.
        const previous = intents.at(-1)?.updatedAt ?? intent.updatedAt;
        const updatedAt = nextTimestamp(previous > intent.updatedAt ? previous : intent.updatedAt);
        const active: IntentGraph = { ...intent, status: "executing", updatedAt, steps: [{ ...s1, status: "submitted" }] };
        await store.update(intent.id, active, intent.updatedAt);
        intents.push(active);
      }
      const [a, b, c] = intents as [IntentGraph, IntentGraph, IntentGraph];
      // Never polled first, oldest update first.
      assert.deepEqual((await store.listActive(2)).map((entry) => entry.id), [a.id, b.id]);
      await store.markPolled([a.id, b.id]);
      assert.deepEqual(await store.get(a.id), a, "polling does not change the graph");
      // c was starved before: unchanged a and b no longer hold the head of the list.
      assert.equal((await store.listActive(1))[0]?.id, c.id);
      await store.markPolled([c.id]);
      assert.notEqual((await store.listActive(1))[0]?.id, c.id, "the most recently polled intent goes last");
      await store.markPolled([]);
      await store.markPolled(["int_dddddddddddddddddddddddddddddddd"]);
      // The optimistic concurrency token is still the graph's own.
      const done: IntentGraph = { ...a, status: "completed", updatedAt: nextTimestamp(a.updatedAt), steps: a.steps.map((entry) => ({ ...entry, status: "settled" })) };
      await store.update(a.id, done, a.updatedAt);
      for (const entry of [b, c]) {
        await store.update(entry.id, { ...entry, status: "completed", updatedAt: nextTimestamp(entry.updatedAt), steps: entry.steps.map((item) => ({ ...item, status: "settled" })) }, entry.updatedAt);
      }
      const remaining = new Set((await store.listActive(500)).map((entry) => entry.id));
      assert.ok(![a.id, b.id, c.id].some((id) => remaining.has(id)));
    });

    it("claims references atomically and refuses reuse by another step", async () => {
      const store = await make();
      const key = `eip155:8453:0x${Math.random().toString(16).slice(2).padEnd(64, "0")}`;
      await store.claimReferences([{ key, intentId: "int_a", stepId: "s1" }]);
      await store.claimReferences([{ key, intentId: "int_a", stepId: "s1" }]);
      assert.equal(await code(store.claimReferences([{ key, intentId: "int_a", stepId: "s2" }])), "REFERENCE_ALREADY_USED");
      assert.equal(await code(store.claimReferences([{ key, intentId: "int_b", stepId: "s1" }])), "REFERENCE_ALREADY_USED");
      const fresh = `${key}-fresh`;
      // A batch with one clash claims nothing.
      assert.equal(await code(store.claimReferences([{ key: fresh, intentId: "int_b", stepId: "s1" }, { key, intentId: "int_b", stepId: "s1" }])), "REFERENCE_ALREADY_USED");
      await store.claimReferences([{ key: fresh, intentId: "int_c", stepId: "s1" }]);
      const racers = await Promise.allSettled([
        store.claimReferences([{ key: `${key}-race`, intentId: "int_x", stepId: "s1" }]),
        store.claimReferences([{ key: `${key}-race`, intentId: "int_y", stepId: "s1" }]),
      ]);
      assert.equal(racers.filter((result) => result.status === "fulfilled").length, 1);
    });
  });
}

contract("memory", async () => new MemoryIntentStore());

describe("memory intent store bounds", () => {
  it("evicts the least recently used intent beyond capacity", async () => {
    const store = new MemoryIntentStore(2);
    const [a, b, c] = [await graph(), await graph(), await graph()];
    await store.create(a, {});
    await store.create(b, {});
    await store.get(a.id);
    await store.update(a.id, { ...a, updatedAt: nextTimestamp(a.updatedAt) }, a.updatedAt);
    await store.create(c, {});
    assert.equal(await store.get(b.id), null);
    assert.ok(await store.get(a.id));
    assert.ok(await store.get(c.id));
  });

  it("returns copies that cannot mutate the stored graph", async () => {
    const store = new MemoryIntentStore();
    const intent = await graph();
    await store.create(intent, {});
    const copy = await store.get(intent.id);
    assert.ok(copy);
    (copy as { status: string }).status = "cancelled";
    assert.equal((await store.get(intent.id))?.status, intent.status);
  });
});

const databaseUrl = process.env.KLETIA_TEST_DATABASE_URL?.trim();
if (databaseUrl) {
  const stores: PostgresIntentStore[] = [];
  contract("postgres", async () => {
    const store = new PostgresIntentStore(databaseUrl);
    stores.push(store);
    return store;
  });
  after(async () => {
    await Promise.all(stores.map((store) => store.close()));
  });
} else {
  describe("postgres intent store", () => {
    it("is exercised when KLETIA_TEST_DATABASE_URL is set", { skip: "KLETIA_TEST_DATABASE_URL not set" }, () => undefined);
  });
}
