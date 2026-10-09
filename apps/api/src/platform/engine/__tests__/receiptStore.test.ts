/**
 * Receipt issuer scan support in the intent stores (receipts design §12):
 * `listChangedSince(statuses, sinceIso, limit)` lists intents in receiptable
 * statuses changed at or after a time, oldest change first. Memory always;
 * Postgres when KLETIA_TEST_DATABASE_URL is set.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { IntentGraph } from "@kletia/core";
import { planIntent } from "../planner.js";
import { MemoryIntentStore, PostgresIntentStore, type IntentStore } from "../store.js";
import { ACCOUNTS, resetEngine } from "./helpers.js";

async function planned(): Promise<IntentGraph> {
  resetEngine();
  return planIntent({ text: "swap 1 SOL to USDC", accounts: ACCOUNTS });
}

function at(graph: IntentGraph, iso: string, status: IntentGraph["status"]): IntentGraph {
  return { ...graph, updatedAt: iso, status };
}

function contract(name: string, make: () => Promise<IntentStore>): void {
  describe(`${name} intent store: listChangedSince`, () => {
    it("lists receiptable intents changed since a time, oldest first, bounded", async () => {
      const store = await make();
      assert.ok(store.listChangedSince, "the store implements the scan");
      // Far-future times that move forward 100x faster than the clock: rows of earlier runs
      // (shared databases) always fall before this run's window.
      const base = Date.UTC(3000, 0, 1) + (Date.now() - Date.UTC(2026, 0, 1)) * 100;
      const iso = (minutes: number) => new Date(base + minutes * 60_000).toISOString();
      const a = await planned();
      const b = await planned();
      const c = await planned();
      const d = await planned();
      for (const graph of [a, b, c, d]) await store.create(graph, {});
      await store.update(a.id, at(a, iso(3), "completed"), a.updatedAt);
      await store.update(b.id, at(b, iso(1), "partially_completed"), b.updatedAt);
      await store.update(c.id, at(c, iso(2), "executing"), c.updatedAt);
      await store.update(d.id, at(d, iso(-10), "failed"), d.updatedAt);
      const statuses = ["completed", "partially_completed", "failed", "cancelled"] as const;
      const rows = await store.listChangedSince(statuses, iso(0), 10);
      assert.deepEqual(rows.map((row) => [row.id, row.status, row.updatedAt]), [
        [b.id, "partially_completed", iso(1)],
        [a.id, "completed", iso(3)],
      ]);
      assert.deepEqual((await store.listChangedSince(statuses, iso(0), 1)).map((row) => row.id), [b.id]);
      assert.deepEqual(await store.listChangedSince([], iso(0), 10), []);
      assert.deepEqual(await store.listChangedSince(statuses, "not a time", 10), []);
      assert.deepEqual((await store.listChangedSince(["executing"], iso(0), 10)).map((row) => row.id), [c.id]);
    });
  });
}

contract("memory", async () => new MemoryIntentStore());

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
  describe("postgres intent store: listChangedSince", () => {
    it("is exercised when KLETIA_TEST_DATABASE_URL is set", { skip: "KLETIA_TEST_DATABASE_URL not set" }, () => undefined);
  });
}
