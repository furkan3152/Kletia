/**
 * Kletia-held clarify threads: the store contract (conditional updates,
 * owner scoping, the open-thread cap, keyset pages, pruning) in memory
 * and, with KLETIA_TEST_DATABASE_URL, on Postgres `kletia_threads`; and
 * over HTTP: idle and absolute expiry (clock faked), 50 turns
 * (THREAD_CLOSED), 1,000 open threads per key (429 RATE_LIMITED with
 * Retry-After), and two concurrent turns of which one applies and the
 * other gets 409 THREAD_CONFLICT.
 *
 *   cd apps/api && node --import tsx --test src/platform/http/__tests__/threads.test.ts
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, afterEach, before, describe, it } from "node:test";
import { THREAD_LIMITS, THREAD_SPEC, type ClarifyThread, type ThreadRef } from "@kletia/core";
import { configurePlatform } from "../../index.js";
import { ACCOUNTS, resetEngine } from "../../engine/__tests__/helpers.js";
import { assertError, call, serve, useClarifyWallet, useTestEnvironment, type Reply, type TestServer } from "./support.js";

useTestEnvironment();
const { createPlatformRouter, platformErrorHandler } = await import("../index.js");
const threads = await import("../threads.js");
const { closePlatformDatabase } = await import("../db.js");

type ThreadRecord = import("../threads.js").ThreadRecord;
type ThreadStore = import("../threads.js").ThreadStore;

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const START = Date.parse("2026-10-14T09:00:00.000Z");

function threadId(): string {
  return `th_${[...randomBytes(24)].map((byte) => BASE32[byte % 32]).join("")}`;
}

function blob(id: string, rev: number): ClarifyThread {
  return { spec: THREAD_SPEC, id, rev, status: "needs_input", policy: "2026-10.1", steps: [], open: [], corrections: [], turns: [], undo: [] };
}

function record(owner: string, at: number, extra: Partial<ThreadRecord> = {}): ThreadRecord {
  const id = extra.id ?? threadId();
  const iso = new Date(at).toISOString();
  return {
    id,
    ownerKeyId: owner,
    rev: 1,
    status: "needs_input",
    thread: blob(id, 1),
    context: { accounts: ACCOUNTS as ThreadRecord["context"]["accounts"] },
    lastResponse: null,
    intents: [],
    summary: "Swap SOL to USDC on Solana",
    createdAt: iso,
    updatedAt: iso,
    expiresAt: threads.threadExpiry(iso, iso),
    ...extra,
  };
}

function owner(): string {
  return `key_test_${randomBytes(8).toString("hex")}`;
}

/* ------------------------------------------------------------ store contract */

function contract(name: string, make: () => ThreadStore): void {
  describe(`${name} thread store`, () => {
    it("caps open threads per owner, ignoring cancelled and expired ones", async () => {
      const store = make();
      const me = owner();
      const now = new Date(START).toISOString();
      await store.create(record(me, START), 2, now);
      await store.create(record(me, START, { status: "cancelled" }), 2, now);
      await store.create(record(me, START - THREAD_LIMITS.absoluteMs), 2, now);
      assert.equal(await store.countOpen(me, now), 1);
      await store.create(record(me, START), 2, now);
      await assert.rejects(store.create(record(me, START), 2, now), (error: { status?: number; code?: string; headers?: Record<string, string> }) => {
        assert.equal(error.status, 429);
        assert.equal(error.code, "RATE_LIMITED");
        assert.ok(error.headers?.["Retry-After"]);
        return true;
      });
      // Another owner has its own budget.
      await store.create(record(owner(), START), 2, now);
    });

    it("updates only while the revision is the one read, and only for the owner", async () => {
      const store = make();
      const me = owner();
      const first = record(me, START);
      await store.create(first, 10, first.createdAt);
      const later = new Date(START + 60_000).toISOString();
      const next = { ...first, rev: 2, thread: blob(first.id, 2), updatedAt: later, expiresAt: threads.threadExpiry(first.createdAt, later) };
      assert.equal(await store.update({ ...next, ownerKeyId: owner() }, 1), false, "another owner never updates");
      assert.equal(await store.update(next, 1), true);
      assert.equal(await store.update({ ...next, rev: 3 }, 1), false, "the loser of a race sees the moved revision");
      const stored = await store.get(first.id);
      assert.equal(stored?.rev, 2);
      assert.equal(stored?.updatedAt, later);
      assert.equal(stored?.thread.rev, 2);
      assert.deepEqual(stored?.context.accounts, ACCOUNTS);
    });

    it("lists newest first in keyset pages, filters by status and hides expired threads", async () => {
      const store = make();
      const me = owner();
      for (let index = 0; index < 5; index += 1) {
        await store.create(record(me, START + index * 1_000, { status: index === 4 ? "ready" : "needs_input" }), 100, new Date(START).toISOString());
      }
      await store.create(record(me, START - THREAD_LIMITS.absoluteMs - 1), 100, new Date(START).toISOString());
      const now = new Date(START + 10_000).toISOString();
      const first = await store.list(me, { limit: 2 }, now);
      assert.equal(first.records.length, 2);
      assert.ok(first.next);
      assert.ok((first.records[0] as ThreadRecord).updatedAt > (first.records[1] as ThreadRecord).updatedAt);
      const second = await store.list(me, { limit: 2, cursor: first.next ?? undefined }, now);
      const third = await store.list(me, { limit: 2, cursor: second.next ?? undefined }, now);
      assert.equal(third.next, null);
      const ids = [...first.records, ...second.records, ...third.records].map((entry) => entry.id);
      assert.equal(new Set(ids).size, 5, "five live threads, the expired one hidden");
      assert.equal((await store.list(me, { limit: 10, status: "ready" }, now)).records.length, 1);
      const cursor = threads.encodeThreadCursor(first.next as NonNullable<typeof first.next>);
      assert.deepEqual(threads.decodeThreadCursor(cursor), first.next);
      assert.equal(threads.decodeThreadCursor("bm9wZQ"), null);
    });

    it("deletes the owner's thread and prunes expired ones", async () => {
      const store = make();
      const me = owner();
      const live = record(me, START);
      const stale = record(me, START - THREAD_LIMITS.idleMs - 1);
      await store.create(live, 10, live.createdAt);
      await store.create(stale, 10, live.createdAt);
      assert.equal(await store.delete(owner(), live.id), false);
      assert.ok((await store.prune(new Date(START).toISOString())) >= 1);
      assert.equal(await store.get(stale.id), null);
      assert.ok(await store.get(live.id));
      assert.equal(await store.delete(me, live.id), true);
      assert.equal(await store.get(live.id), null);
    });

    it("drops the last response rather than exceed 32 KB", async () => {
      const store = make();
      const me = owner();
      const big = record(me, START, { lastResponse: { status: "needs_input", padding: "x".repeat(THREAD_LIMITS.storedRecordBytes) } });
      await store.create(big, 10, big.createdAt);
      assert.equal((await store.get(big.id))?.lastResponse, null);
    });
  });
}

contract("memory", () => new threads.MemoryThreadStore());

const databaseUrl = process.env.KLETIA_TEST_DATABASE_URL?.trim();
if (databaseUrl) {
  describe("postgres", () => {
    before(() => {
      process.env.KLETIA_DATABASE_URL = databaseUrl;
    });
    after(async () => {
      delete process.env.KLETIA_DATABASE_URL;
      await closePlatformDatabase();
    });
    contract("postgres", () => new threads.PostgresThreadStore());
  });
} else {
  describe("postgres thread store", () => {
    it("is exercised when KLETIA_TEST_DATABASE_URL is set", { skip: "KLETIA_TEST_DATABASE_URL not set" }, () => undefined);
  });
}

/* ------------------------------------------------------------ over HTTP */

/** Holds every `get` until `count` reads have arrived, so concurrent turns read the same revision. */
class BarrierStore implements ThreadStore {
  private waiting: (() => void)[] = [];
  constructor(private readonly inner: ThreadStore, private remaining: number) {}
  get kind() {
    return this.inner.kind;
  }
  countOpen(ownerKeyId: string, now: string) {
    return this.inner.countOpen(ownerKeyId, now);
  }
  create(entry: ThreadRecord, maxOpen: number, now: string) {
    return this.inner.create(entry, maxOpen, now);
  }
  async get(id: string) {
    const value = await this.inner.get(id);
    if (this.remaining > 0) {
      this.remaining -= 1;
      if (this.remaining === 0) for (const release of this.waiting.splice(0)) release();
      else await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    return value;
  }
  update(entry: ThreadRecord, expectedRev: number) {
    return this.inner.update(entry, expectedRev);
  }
  list(...args: Parameters<ThreadStore["list"]>) {
    return this.inner.list(...args);
  }
  delete(ownerKeyId: string, id: string) {
    return this.inner.delete(ownerKeyId, id);
  }
  prune(now: string) {
    return this.inner.prune(now);
  }
}

function httpSuite(name: string, make: () => ThreadStore, guard: { enter?: () => void; leave?: () => Promise<void> } = {}): void {
  describe(`remembered threads over HTTP (${name})`, () => {
    let server: TestServer;
    let key: string;
    let keyId: string;
    let now = START;
    let store: ThreadStore;

    function turn(body: Record<string, unknown>): Promise<Reply<{ status: string; thread: ThreadRef }>> {
      return call(server, "POST", "/intents?clarify=true&dryRun=true", { key, body });
    }

    before(async () => {
      resetEngine();
      await useClarifyWallet();
      server = await serve((app) => app.use("/v1", createPlatformRouter(), platformErrorHandler));
      const issued = await call<{ key: { id: string; key: string } }>(server, "POST", "/keys", { body: { name: `threads-${name}` } });
      key = issued.body.key.key;
      keyId = issued.body.key.id;
      guard.enter?.();
      store = make();
      threads.configureThreadStore(store);
      threads.configureThreadClock(() => now);
    });

    afterEach(() => {
      threads.configureThreadStore(store);
    });

    after(async () => {
      threads.configureThreadStore(null);
      threads.configureThreadClock(null);
      await useClarifyWallet(false);
      configurePlatform({ adapters: null });
      await server.close();
      await guard.leave?.();
    });

    it("expires 30 minutes after the last turn and 24 hours after creation", async () => {
      now = START;
      const first = await turn({ text: "swap SOL to USDC", accounts: ACCOUNTS, remember: true });
      assert.equal(first.status, 200, JSON.stringify(first.body));
      const ref = first.body.thread;
      assert.equal(ref.expiresAt, new Date(START + THREAD_LIMITS.idleMs).toISOString());
      // A turn moves the idle expiry.
      now = START + 29 * 60_000;
      const second = await turn({ threadId: ref.id, expectedRev: ref.rev, text: "1" });
      assert.equal(second.status, 200, JSON.stringify(second.body));
      assert.equal(second.body.thread.expiresAt, new Date(now + THREAD_LIMITS.idleMs).toISOString());
      // A thread used until late in its day still ends 24 hours after creation.
      const current = (await store.get(ref.id)) as ThreadRecord;
      const late = new Date(START + THREAD_LIMITS.absoluteMs - 10 * 60_000).toISOString();
      const kept = { ...current, updatedAt: late, expiresAt: threads.threadExpiry(current.createdAt, late) };
      assert.equal(kept.expiresAt, new Date(START + THREAD_LIMITS.absoluteMs).toISOString());
      assert.equal(await store.update(kept, current.rev), true);
      now = START + THREAD_LIMITS.absoluteMs - 60_000;
      assert.equal((await call(server, "GET", `/threads/${ref.id}`, { key })).status, 200);
      now = START + THREAD_LIMITS.absoluteMs;
      assertError(await turn({ threadId: ref.id, text: "make it 3" }), 404, "THREAD_NOT_FOUND");

      const idle = await turn({ text: "swap SOL to USDC", accounts: ACCOUNTS, remember: true });
      now += THREAD_LIMITS.idleMs;
      assertError(await call(server, "GET", `/threads/${idle.body.thread.id}`, { key }), 404, "THREAD_NOT_FOUND");
      // The pruner removes the expired rows.
      assert.ok((await store.prune(new Date(now).toISOString())) >= 1);
      assert.equal(await store.get(idle.body.thread.id), null);
    });

    it("closes after 50 turns (THREAD_CLOSED)", async () => {
      now = START + 2 * THREAD_LIMITS.absoluteMs;
      const first = await turn({ text: "swap SOL to USDC", accounts: ACCOUNTS, remember: true });
      const current = (await store.get(first.body.thread.id)) as ThreadRecord;
      const worn = { ...current, rev: THREAD_LIMITS.maxTurns, thread: { ...current.thread, rev: THREAD_LIMITS.maxTurns } };
      assert.equal(await store.update(worn, current.rev), true);
      assertError(await turn({ threadId: current.id, text: "1" }), 409, "THREAD_CLOSED");
      assert.equal((await store.get(current.id))?.rev, THREAD_LIMITS.maxTurns, "a refusal leaves the thread unchanged");
    });

    it("applies one of two concurrent turns and refuses the other with THREAD_CONFLICT", async () => {
      now = START + 3 * THREAD_LIMITS.absoluteMs;
      const first = await turn({ text: "swap SOL to USDC", accounts: ACCOUNTS, remember: true });
      threads.configureThreadStore(new BarrierStore(store, 2));
      const replies = await Promise.all([turn({ threadId: first.body.thread.id, text: "1" }), turn({ threadId: first.body.thread.id, text: "2" })]);
      threads.configureThreadStore(store);
      assert.deepEqual(replies.map((reply) => reply.status).sort(), [200, 409], JSON.stringify(replies.map((reply) => reply.body)));
      const loser = replies.find((reply) => reply.status === 409) as Reply<unknown>;
      assertError(loser, 409, "THREAD_CONFLICT");
      assert.equal((await store.get(first.body.thread.id))?.rev, 2);
    });

    it("caps a key at 1,000 open threads (429 RATE_LIMITED with Retry-After)", async () => {
      now = START + 4 * THREAD_LIMITS.absoluteMs;
      const at = new Date(now).toISOString();
      const open = await store.countOpen(keyId, at);
      const capped = new threads.MemoryThreadStore();
      threads.configureThreadStore(capped);
      for (let index = open; index < THREAD_LIMITS.openPerKey; index += 1) await capped.create(record(keyId, now), THREAD_LIMITS.openPerKey, at);
      const refused = await turn({ text: "swap SOL to USDC", accounts: ACCOUNTS, remember: true });
      assertError(refused, 429, "RATE_LIMITED");
      assert.ok(refused.headers.get("retry-after"));
      // Client-held turns are not capped.
      assert.equal((await turn({ text: "swap SOL to USDC", accounts: ACCOUNTS })).status, 200);
    });
  });
}

httpSuite("memory", () => new threads.MemoryThreadStore());
if (databaseUrl) {
  httpSuite("postgres", () => new threads.PostgresThreadStore(), {
    enter: () => {
      process.env.KLETIA_DATABASE_URL = databaseUrl;
    },
    leave: async () => {
      delete process.env.KLETIA_DATABASE_URL;
      await closePlatformDatabase();
    },
  });
}

describe("startThreadPruner", () => {
  it("deletes expired threads on its interval", async () => {
    const store = new threads.MemoryThreadStore();
    const stale = record(owner(), Date.now() - THREAD_LIMITS.absoluteMs - 1);
    await store.create(stale, 10, new Date(0).toISOString());
    threads.configureThreadStore(store);
    const stop = threads.startThreadPruner(5);
    try {
      const deadline = Date.now() + 2_000;
      while ((await store.get(stale.id)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(await store.get(stale.id), null);
    } finally {
      stop();
      threads.configureThreadStore(null);
    }
  });
});
