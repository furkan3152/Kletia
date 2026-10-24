/**
 * Tracked wallet sets (data/trackingStore.ts) on the memory store and, when
 * KLETIA_TEST_DATABASE_URL is set, on Postgres: one set per address,
 * add/remove, cascading delete, idempotent hour and day snapshot points, and
 * the transaction cache.
 *
 *   cd apps/api && node --import tsx --test src/platform/http/__tests__/dataTrackingStore.test.ts
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, describe, it } from "node:test";
import type { DataTransaction } from "@kletia/core";
import { useTestEnvironment } from "./support.js";

const databaseUrl = process.env.KLETIA_TEST_DATABASE_URL?.trim();
useTestEnvironment();
if (databaseUrl) process.env.KLETIA_DATABASE_URL = databaseUrl;
const { MemoryDataTrackingStore, PostgresDataTrackingStore } = await import("../../data/index.js");
const { closePlatformDatabase } = await import("../db.js");
type Store = InstanceType<typeof MemoryDataTrackingStore> | InstanceType<typeof PostgresDataTrackingStore>;

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const evm = () => `0x${hex(20)}`;

function record(evmAddresses: string[], solana: string[] = []) {
  return { id: `trk_${hex(12)}`, ownerRef: `wallet:evm:${evmAddresses[0]}`, lane: "production" as const, evm: evmAddresses, solana, createdAt: new Date().toISOString(), lastSnapshotAt: null };
}

function tx(id: string, time: string): DataTransaction {
  return {
    id, network: "base", hash: id.slice(5), account: "eip155:8453:0x0000000000000000000000000000000000000001" as never, time, block: 1, kind: "send", status: "success",
    legs: [], fee: null, counterparty: null, protocol: null, method: null, kletiaIntentId: null, kletiaReceiptId: null, source: "etherscan", explorerUrl: "",
  };
}

function suite(name: string, make: () => Store): void {
  describe(name, () => {
    it("keeps an address in one set, adds and removes wallets, and finds a set by any member", async () => {
      const store = make();
      const a = evm();
      const first = record([a]);
      await store.create(first);
      await assert.rejects(store.create(record([a.toUpperCase().replace("0X", "0x")])), { code: "DATA_WALLET_TRACKED" });
      const sol = hex(16);
      const grown = await store.addWallet(first.id, "solana", sol);
      assert.deepEqual(grown.solana, [sol]);
      assert.equal((await store.byMember("solana", sol))?.id, first.id);
      assert.equal((await store.byMember("evm", a.toUpperCase().replace("0X", "0x")))?.id, first.id, "EVM members match in any case");
      const other = record([evm()]);
      await store.create(other);
      await assert.rejects(store.addWallet(other.id, "solana", sol), { code: "DATA_WALLET_TRACKED" });
      await store.removeWallet(first.id, "solana", sol);
      assert.equal(await store.byMember("solana", sol), null);
      await store.addWallet(other.id, "solana", sol);
      assert.equal((await store.byMember("solana", sol))?.id, other.id);
    });

    it("writes the first reading of an hour and the latest of a day, idempotently", async () => {
      const store = make();
      const set = record([evm()]);
      await store.create(set);
      await store.writeSnapshot({ trackingId: set.id, at: "2026-10-24T08:05:00.000Z", usd: 100, complete: true });
      await store.writeSnapshot({ trackingId: set.id, at: "2026-10-24T08:40:00.000Z", usd: 110, complete: false });
      await store.writeSnapshot({ trackingId: set.id, at: "2026-10-24T08:40:00.000Z", usd: 110, complete: false });
      await store.writeSnapshot({ trackingId: set.id, at: "2026-10-24T09:05:00.000Z", usd: 120, complete: true });
      assert.deepEqual((await store.snapshots(set.id, "h", null)).map((point) => point.usd), [100, 120]);
      assert.deepEqual((await store.snapshots(set.id, "d", null)).map((point) => [point.usd, point.complete]), [[120, true]]);
      assert.equal((await store.get(set.id))?.lastSnapshotAt, "2026-10-24T09:05:00.000Z");
      await store.pruneHourly("2026-10-24T09:00:00.000Z");
      assert.deepEqual((await store.snapshots(set.id, "h", null)).map((point) => point.usd), [120]);
      assert.deepEqual((await store.snapshots(set.id, "h", "2026-10-25T00:00:00.000Z")).length, 0);
    });

    it("caches transactions newest first and deletes everything with the set", async () => {
      const store = make();
      const set = record([evm()]);
      await store.create(set);
      await store.cacheTransactions(set.id, [tx("base:0x01", "2026-10-20T00:00:00.000Z"), tx("base:0x02", "2026-10-21T00:00:00.000Z")]);
      await store.cacheTransactions(set.id, [tx("base:0x02", "2026-10-21T00:00:00.000Z")]);
      assert.deepEqual((await store.cachedTransactions(set.id, 10)).map((row) => row.id), ["base:0x02", "base:0x01"]);
      await store.writeSnapshot({ trackingId: set.id, at: "2026-10-24T08:05:00.000Z", usd: 1, complete: true });
      assert.equal(await store.delete(set.id), true);
      assert.equal(await store.get(set.id), null);
      assert.equal(await store.byMember("evm", set.evm[0]!), null);
      assert.deepEqual(await store.cachedTransactions(set.id, 10), []);
      assert.deepEqual(await store.snapshots(set.id, "d", null), []);
      await store.writeSnapshot({ trackingId: set.id, at: "2026-10-24T09:05:00.000Z", usd: 1, complete: true });
      assert.deepEqual(await store.snapshots(set.id, "d", null), [], "a deleted set takes no points");
    });

    it("lists the least recently snapshotted sets first", async () => {
      const store = make();
      const older = record([evm()]);
      const fresh = record([evm()]);
      await store.create(older);
      await store.create(fresh);
      await store.writeSnapshot({ trackingId: older.id, at: "2026-10-24T08:05:00.000Z", usd: 1, complete: true });
      const order = (await store.listForSnapshot(500)).map((entry) => entry.id).filter((id) => id === older.id || id === fresh.id);
      assert.deepEqual(order, [fresh.id, older.id]);
    });
  });
}

suite("tracked wallet sets in memory", () => new MemoryDataTrackingStore());

if (databaseUrl) {
  suite("tracked wallet sets on Postgres", () => new PostgresDataTrackingStore());
  it("runs one snapshot leader at a time on Postgres", async () => {
    const store = new PostgresDataTrackingStore();
    let inner: boolean | null = null;
    const outer = await store.withLeaderLock(async () => {
      inner = await store.withLeaderLock(async () => undefined);
    });
    assert.equal(outer, true);
    assert.equal(inner, false);
  });
  after(async () => {
    delete process.env.KLETIA_DATABASE_URL;
    await closePlatformDatabase();
  });
} else {
  describe("tracked wallet sets on Postgres", () => {
    it("is exercised when KLETIA_TEST_DATABASE_URL is set", { skip: "KLETIA_TEST_DATABASE_URL not set" }, () => undefined);
  });
}
