/**
 * GET /api/network/lykia: the cached relay of Lykia's public status. It reads
 * a fixed upstream, keeps only the fields the board prints, caches answers
 * (failures briefly) and shares one upstream request between callers.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createLykiaRelay,
  LYKIA_ORIGIN,
  LYKIA_PROXY_FAILURE_TTL_MS,
  LYKIA_PROXY_TTL_MS,
  pickHealth,
  pickStats,
} from "../routes/network.js";

const STATS = {
  environment: "mainnet",
  onchain: { contracts: [{ name: "LykiaRouter", address: "0xc9c0ea4d22ddbef4504a634759fb78334efc5d18", extra: "x" }], accountsCreated: 1, secret: "no" },
  routed: { intents: 0, usd: "0.00" },
  ecosystem: { protocols: 94, verified: 42, routable: 9 },
  at: "2026-11-04T20:37:43.614Z",
};
const HEALTH = { status: "ok", version: "0.1.0", environment: "mainnet", networks: { "arc-mainnet": { reachable: true, head: 29555550, latencyMs: 40 }, "arc-testnet": { reachable: true } }, store: { kind: "postgres" } };

function fakeFetch(bodies: Record<string, unknown>, calls: string[]) {
  return async (input: string) => {
    calls.push(input);
    const path = input.slice(LYKIA_ORIGIN.length);
    const body = bodies[path];
    if (body === undefined) return new Response("nope", { status: 500 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  };
}

describe("Lykia relay", () => {
  it("keeps only the fields the board prints", () => {
    const stats = pickStats(STATS)!;
    assert.deepEqual(stats.ecosystem, { protocols: 94, verified: 42, routable: 9 });
    assert.equal((stats.onchain as { accountsCreated: number }).accountsCreated, 1);
    assert.ok(!JSON.stringify(stats).includes("secret"));
    assert.ok(!JSON.stringify(stats).includes("extra"));
    const health = pickHealth(HEALTH)!;
    assert.deepEqual(health.networks, { "arc-mainnet": { reachable: true, head: 29555550, latencyMs: 40 } });
    assert.ok(!JSON.stringify(health).includes("postgres"));
    assert.equal(pickHealth({ status: "weird" })!.status, null);
    assert.equal(pickStats("not json"), null);
  });

  it("reads the fixed upstream once per minute and shares in-flight requests", async () => {
    const calls: string[] = [];
    let clock = 1_000;
    const read = createLykiaRelay({ fetcher: fakeFetch({ "/v1/stats": STATS, "/v1/health": HEALTH }, calls), now: () => clock });
    const [a, b] = await Promise.all([read(), read()]);
    assert.equal(a, b);
    assert.deepEqual(calls.sort(), [`${LYKIA_ORIGIN}/v1/health`, `${LYKIA_ORIGIN}/v1/stats`]);
    clock += LYKIA_PROXY_TTL_MS - 1;
    await read();
    assert.equal(calls.length, 2, "still cached");
    clock += 2;
    await read();
    assert.equal(calls.length, 4, "refreshed after the minute");
  });

  it("answers one side when the other fails, and caches a full failure only briefly", async () => {
    const calls: string[] = [];
    let clock = 0;
    const half = await createLykiaRelay({ fetcher: fakeFetch({ "/v1/stats": STATS }, []), now: () => clock })();
    assert.ok(half.stats);
    assert.equal(half.health, null);

    const read = createLykiaRelay({ fetcher: fakeFetch({}, calls), now: () => clock });
    const failed = await read();
    assert.equal(failed.stats, null);
    assert.equal(failed.health, null);
    clock += LYKIA_PROXY_FAILURE_TTL_MS + 1;
    await read();
    assert.equal(calls.length, 4);
  });
});
