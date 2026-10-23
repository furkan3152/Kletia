/**
 * Unit tests of the rate-limit and idempotency primitives (limits.ts,
 * idempotency.ts) without a server: fixed windows, weighted budgets, stream
 * slots, the per-address identity behind a proxy and Idempotency-Key parsing.
 */
import assert from "node:assert/strict";
import type { Request } from "express";
import { describe, it } from "node:test";
import { HttpError, setAuth } from "../context.js";
import { MemoryIdempotencyStore, parseIdempotencyKey } from "../idempotency.js";
import { acquireStreamSlot, clientIp, KeyWindowLimiter, openStreamCount, WeightedWindowLimiter } from "../limits.js";

function refusal(run: () => unknown): HttpError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof HttpError, String(error));
    return error;
  }
  assert.fail("expected a refusal");
}

function request(ip: string, keyId?: string): Request {
  const req = { ip, socket: { remoteAddress: "10.0.0.1" }, get: () => undefined } as unknown as Request;
  if (keyId) setAuth(req, { tier: "developer", keyId });
  return req;
}

describe("fixed-window limiters", () => {
  it("allows exactly the limit per window and key, then 429 with Retry-After until the window ends", () => {
    const limiter = new KeyWindowLimiter(3, 60_000, "things per minute");
    for (let index = 0; index < 3; index += 1) limiter.take("a", 1_000);
    const error = refusal(() => limiter.take("a", 31_000));
    assert.equal(error.status, 429);
    assert.equal(error.code, "RATE_LIMITED");
    assert.equal(error.headers?.["Retry-After"], "30");
    assert.match(error.message, /per API key/u);
    limiter.take("b", 31_000);
    limiter.take("a", 61_000);
    limiter.reset();
    for (let index = 0; index < 3; index += 1) limiter.take("a", 61_000);
  });

  it("evicts the oldest windows beyond its key budget instead of growing without bound", () => {
    const limiter = new KeyWindowLimiter(1, 60_000, "things", 2, "");
    limiter.take("a", 0);
    limiter.take("b", 0);
    limiter.take("c", 0);
    limiter.take("a", 0);
    assert.doesNotMatch(refusal(() => limiter.take("c", 0)).message, /per API key/u);
  });

  it("charges weighted requests whole or not at all", () => {
    const budget = new WeightedWindowLimiter(10, 60_000, "reads");
    budget.take("ip:a", 6, 0);
    const error = refusal(() => budget.take("ip:a", 5, 0));
    assert.match(error.message, /needs 5 and 4 remain/u);
    budget.take("ip:a", 4, 0);
    refusal(() => budget.take("ip:a", 0, 0));
    budget.take("ip:a", 2.2, 60_000);
    assert.match(refusal(() => budget.take("ip:a", 8, 60_000)).message, /needs 8 and 7 remain/u, "fractional weights round up");
  });
});

describe("client identity", () => {
  it("uses the proxy-resolved req.ip and groups IPv6 by /56", () => {
    assert.equal(clientIp(request("203.0.113.9")), "203.0.113.9");
    assert.equal(clientIp(request("2001:db8:aa:bb01::1")), clientIp(request("2001:db8:aa:bbff::9")));
    assert.notEqual(clientIp(request("2001:db8:aa:bb01::1")), clientIp(request("2001:db8:aa:cc01::1")));
    assert.equal(clientIp({ socket: { remoteAddress: "198.51.100.7" } } as unknown as Request), "198.51.100.7");
  });

  it("caps SSE streams per address and per key, and releases each slot once", () => {
    const before = openStreamCount();
    const releases = Array.from({ length: 10 }, () => acquireStreamSlot(request("198.51.100.20")));
    assert.ok(releases.every((release) => release !== null));
    assert.equal(acquireStreamSlot(request("198.51.100.20")), null, "eleventh stream from one address");
    releases[0]?.();
    releases[0]?.();
    assert.equal(openStreamCount(), before + 9);
    const again = acquireStreamSlot(request("198.51.100.20"));
    assert.notEqual(again, null);
    for (const release of [...releases, again]) release?.();
    assert.equal(openStreamCount(), before);
    const keyed = Array.from({ length: 10 }, (_, index) => acquireStreamSlot(request(`198.51.100.${30 + index}`, "key_streams")));
    assert.equal(acquireStreamSlot(request("198.51.100.99", "key_streams")), null, "eleventh stream of one key");
    for (const release of keyed) release?.();
    assert.equal(openStreamCount(), before);
  });
});

describe("Idempotency-Key", () => {
  it("parses bare and quoted tokens and refuses everything else", () => {
    assert.equal(parseIdempotencyKey(undefined), null);
    assert.equal(parseIdempotencyKey(" 3f1c-AA_b.c:d "), "3f1c-AA_b.c:d");
    assert.equal(parseIdempotencyKey('"order-1"'), "order-1");
    for (const bad of ["", '""', '"', '"abc', "a b", "a/b", "ü", "x".repeat(129), '"a"b"']) {
      assert.equal(refusal(() => parseIdempotencyKey(bad)).code, "IDEMPOTENCY_KEY_INVALID", bad);
    }
  });

  it("scopes keys per owner, refuses another request under the same key and replays only finished ones", async () => {
    const store = new MemoryIdempotencyStore();
    const base = { key: "k1", fingerprint: "f1", method: "POST", route: "/intents" };
    const first = await store.begin({ ...base, owner: "key_a" }, 0);
    assert.equal(first.state, "acquired");
    assert.equal((await store.begin({ ...base, owner: "key_b" }, 0)).state, "acquired", "another key never sees it");
    assert.equal((await store.begin({ ...base, owner: "key_a" }, 1)).state, "in_progress");
    assert.equal((await store.begin({ ...base, owner: "key_a", fingerprint: "f2" }, 1)).state, "mismatch");
    if (first.state !== "acquired") return;
    await store.complete("key_a", "k1", first.token, { status: 201, kind: "json", body: "{}" });
    const replay = await store.begin({ ...base, owner: "key_a" }, 2);
    assert.equal(replay.state, "replay");
    assert.equal((await store.begin({ ...base, owner: "key_a" }, 24 * 60 * 60_000 + 1)).state, "acquired", "expired entries run again");
  });

  it("takes over a reservation whose request never finished and ignores the stale token", async () => {
    const store = new MemoryIdempotencyStore();
    const entry = { owner: "key_a", key: "k2", fingerprint: "f", method: "POST", route: "/intents" };
    const stale = await store.begin(entry, 0);
    const fresh = await store.begin(entry, 120_001);
    assert.equal(fresh.state, "acquired");
    if (stale.state !== "acquired" || fresh.state !== "acquired") return;
    await store.complete("key_a", "k2", stale.token, { status: 500, kind: "empty", body: "" });
    assert.equal((await store.begin(entry, 120_002)).state, "in_progress", "the stale request cannot complete the new reservation");
    await store.release("key_a", "k2", fresh.token);
    assert.equal((await store.begin(entry, 120_003)).state, "acquired");
  });
});
