import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { IntentGraph } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { planIntent } from "../planner.js";
import { isActiveGraph, MemoryIntentStore, PostgresIntentStore, type IntentStore } from "../store.js";
import { nextTimestamp } from "../util.js";
import { ACCOUNTS, resetEngine } from "./helpers.js";

async function graph(): Promise<IntentGraph> {
  resetEngine();
  return planIntent({ text: "swap 1 SOL to USDC", accounts: ACCOUNTS, clientReference: "ref-1" });
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
    it("creates once and reads back a copy", async () => {
      const store = await make();
      const intent = await graph();
      await store.create(intent, { ownerKeyId: "key_1" });
      assert.equal(await code(store.create(intent, {})), "INTENT_EXISTS");
      const read = await store.get(intent.id);
      assert.deepEqual(read, intent);
      assert.equal(await store.get("int_00000000000000000000000000000000"), null);
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
      const mine = await graph();
      const other = await graph();
      await store.create(mine, { ownerKeyId: "key_list" });
      await store.create(other, { ownerKeyId: "key_other" });
      assert.deepEqual((await store.listByOwner("key_list", 10)).map((entry) => entry.id), [mine.id]);
      assert.equal((await store.findByClientReference("key_list", "ref-1"))?.id, mine.id);
      assert.equal(await store.findByClientReference("key_list", "nope"), null);
      const [s1] = mine.steps;
      assert.ok(s1);
      const active: IntentGraph = { ...mine, status: "executing", updatedAt: nextTimestamp(mine.updatedAt), steps: [{ ...s1, status: "submitted" }] };
      assert.ok(isActiveGraph(active));
      await store.update(mine.id, active, mine.updatedAt);
      assert.ok((await store.listActive(50)).some((entry) => entry.id === mine.id));
      assert.ok(!(await store.listActive(50)).some((entry) => entry.id === other.id));
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
