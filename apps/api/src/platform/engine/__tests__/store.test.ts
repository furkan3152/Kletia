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
    it("creates once and reads back a copy", async () => {
      const store = await make();
      const intent = await graph();
      await store.create(intent, { ownerKeyId: owner("key") });
      assert.equal(await code(store.create(intent, {})), "INTENT_EXISTS");
      const read = await store.get(intent.id);
      assert.deepEqual(read, intent);
      assert.equal(await store.get("int_00000000000000000000000000000000"), null);
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
