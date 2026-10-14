/**
 * The journey over HTTP and MCP: `?journey=true` on create (dry runs too,
 * `journeyReads=none`) and prepare with `journey.basis.previewDigest ===
 * preview.digest`, no flag on GET intent or POST preview, GET
 * /v1/intents/{id}/journey (200, 404, the per-intent limit of 30 a minute
 * and the refresh limiter), POST …/stop (cancelled, idempotent,
 * INTENT_IN_FLIGHT with Retry-After), and the MCP `get_journey` tool
 * (read-only, no calldata) plus the journey in `plan_intent` and
 * `get_intent`. Offline: stub venues, stubbed balance, gas and venue reads,
 * in-memory stores.
 *
 *   cd apps/api && node --import tsx --test src/platform/http/__tests__/journey.test.ts
 */
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { JOURNEY_DIGEST_PATTERN, type IntentGraph, type IntentPreview, type Journey } from "@kletia/core";
import { configureHoldingsReaders } from "../../engine/holdings.js";
import { configureJourneyVenueReader } from "../../engine/journey/facts.js";
import { configurePlatform, configurePreviewPricer, configurePreviewStore, resetJourneyCaches } from "../../index.js";
import { ACCOUNTS, randomEvmHash, resetEngine, stub } from "../../engine/__tests__/helpers.js";
import { assertError, call as rawCall, OPERATOR_KEY, serve, useTestEnvironment, type CallOptions, type Reply, type TestServer } from "./support.js";

useTestEnvironment();
const { createPlatformRouter, platformErrorHandler } = await import("../index.js");
const { JOURNEY_READS_PER_INTENT_PER_MINUTE, resetJourneyLimiters } = await import("../journey.js");
const { KLETIA_TOOLS, runTool } = await import("../mcp/tools.js");

const SWAP = { text: "swap 1 SOL to USDC", accounts: ACCOUNTS };
const BRIDGE_THEN_SWAP = { text: "bridge 50 USDC from base to solana then swap half to JitoSOL", accounts: ACCOUNTS };

interface CreateReply {
  readonly intent: IntentGraph;
  readonly preview?: IntentPreview;
  readonly journey?: Journey | null;
}

let server: TestServer;
let balanceReads = 0;

/** Every call carries the operator key (1,200 requests a minute) unless the test sends its own. */
function call<T = unknown>(method: string, path: string, options: CallOptions = {}): Promise<Reply<T>> {
  return rawCall<T>(server, method, path, { key: OPERATOR_KEY, ...options });
}

async function stored(body: unknown = SWAP): Promise<IntentGraph> {
  const created = await call<CreateReply>("POST", "/intents", { body });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.intent;
}

before(async () => {
  resetEngine();
  server = await serve((app) => {
    app.use("/v1", createPlatformRouter(), platformErrorHandler);
  });
});

after(async () => {
  configurePlatform({ adapters: null });
  await server.close();
});

beforeEach(() => {
  resetEngine();
  configurePreviewStore(null);
  resetJourneyCaches();
  resetJourneyLimiters();
  balanceReads = 0;
  configurePreviewPricer({ price: async (asset) => (asset.includes("slip44:60") ? 2480 : asset.includes("slip44:501") ? 106 : 1) });
  configureJourneyVenueReader(async (venue) => ({
    name: venue.name,
    apy: 0.04,
    utilization: 0.8,
    exitLiquidity: "18000000000000",
    capRemaining: null,
    paused: false,
    frozen: false,
    shareRate: null,
    at: new Date().toISOString(),
  }));
  configureHoldingsReaders({
    evmBalance: async () => {
      balanceReads += 1;
      return 10n ** 16n;
    },
    solanaBalance: async () => {
      balanceReads += 1;
      return 10n ** 9n;
    },
    gasPrice: async () => 6_000_000n,
    solanaRent: async (_network, bytes) => (bytes === 0 ? 890_880n : 2_039_280n),
    solanaTokenAccountExists: async () => true,
  });
});

afterEach(() => {
  configureHoldingsReaders(null);
  configureJourneyVenueReader(null);
  configurePreviewPricer(null);
  resetJourneyCaches();
});

describe("POST /v1/intents?journey=true", () => {
  it("returns { intent, preview, journey } for a dry run, the journey built on that preview", async () => {
    const dry = await call<CreateReply>("POST", "/intents?dryRun=true&journey=true", { body: SWAP });
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    const { intent, preview, journey } = dry.body;
    assert.ok(preview, "journey implies the plan preview");
    assert.equal(preview.stage, "plan");
    assert.ok(journey, "journey returned");
    assert.equal(journey.spec, "kletia.journey/v1");
    assert.equal(journey.intentId, intent.id);
    assert.equal(journey.stage, "plan");
    assert.equal(journey.basis.previewDigest, preview.digest);
    assert.equal(journey.basis.reads, "live");
    assert.match(journey.digest, JOURNEY_DIGEST_PATTERN);
    assert.equal(journey.legs.length, intent.steps.length);
    assert.ok(journey.stops.some((stop) => stop.kind === "start"), "a start stop");
    assert.equal("journey" in intent, false, "the graph does not grow");
    assertError(await call("GET", `/intents/${intent.id}/journey`), 404, "INTENT_NOT_FOUND");
  });

  it("stores the intent, honours journeyReads=none and refuses other values", async () => {
    const created = await call<CreateReply>("POST", "/intents?journey=true&journeyReads=none", { body: SWAP });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.journey?.basis.reads, "none");
    assert.equal(created.body.journey?.basis.previewDigest, created.body.preview?.digest);
    assert.equal(balanceReads, 0, "no account read");
    assertError(await call("POST", "/intents?dryRun=true&journey=true&journeyReads=some", { body: SWAP }), 400, "INVALID_REQUEST");
    assertError(await call("POST", "/intents?dryRun=true&journey=maybe", { body: SWAP }), 400, "INVALID_REQUEST");
    const plain = await call<CreateReply>("POST", "/intents?dryRun=true", { body: SWAP });
    assert.equal("journey" in plain.body, false, "no journey without the flag");
    assert.equal(plain.body.preview, undefined);
  });

  it("has no journey flag on GET intent or POST preview", async () => {
    const intent = await stored();
    const read = await call<Record<string, unknown>>("GET", `/intents/${intent.id}?journey=true`);
    assert.equal(read.status, 200);
    assert.deepEqual(Object.keys(read.body), ["intent"]);
    const preview = await call<Record<string, unknown>>("POST", `/intents/${intent.id}/preview?journey=true`);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.deepEqual(Object.keys(preview.body), ["preview"]);
  });
});

describe("POST …/steps/{stepId}/prepare?journey=true", () => {
  it("adds the journey at signing time, built on the prepare-stage preview", async () => {
    const intent = await stored();
    const prepared = await call<{ intent: IntentGraph; preview?: IntentPreview; journey?: Journey | null }>("POST", `/intents/${intent.id}/steps/s1/prepare?journey=true`);
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
    assert.ok(prepared.body.preview);
    assert.equal(prepared.body.preview.stage, "prepare");
    assert.ok(prepared.body.journey);
    assert.equal(prepared.body.journey.basis.previewDigest, prepared.body.preview.digest);
    assert.equal(prepared.body.journey.legs[0]?.status, "awaiting_signature");
    const plain = await call<Record<string, unknown>>("POST", `/intents/${intent.id}/steps/s1/prepare`);
    assert.equal(plain.status, 200);
    assert.equal("journey" in plain.body, false);
  });
});

describe("GET /v1/intents/{id}/journey", () => {
  it("answers 200 with the journey, 404 for an unknown intent and 400 for a bad id or reads value", async () => {
    const intent = await stored();
    const reply = await call<{ journey: Journey }>("GET", `/intents/${intent.id}/journey`);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.journey.intentId, intent.id);
    assert.equal(reply.headers.get("cache-control"), "no-store");
    const none = await call<{ journey: Journey }>("GET", `/intents/${intent.id}/journey?reads=none`);
    assert.equal(none.body.journey.basis.reads, "none");
    assertError(await call("GET", `/intents/int_${"0".repeat(32)}/journey`), 404, "INTENT_NOT_FOUND");
    assertError(await call("GET", "/intents/nope/journey"), 400, "INVALID_REQUEST");
    assertError(await call("GET", `/intents/${intent.id}/journey?reads=all`), 400, "INVALID_REQUEST");
  });

  it(`allows ${JOURNEY_READS_PER_INTENT_PER_MINUTE} reads per intent per minute, then 429 with Retry-After`, async () => {
    const intent = await stored();
    const other = await stored();
    for (let index = 0; index < JOURNEY_READS_PER_INTENT_PER_MINUTE; index += 1) {
      const reply = await call("GET", `/intents/${intent.id}/journey`);
      assert.equal(reply.status, 200, `read ${index + 1}`);
    }
    const limited = assertError(await call("GET", `/intents/${intent.id}/journey`), 429, "RATE_LIMITED");
    assert.match(limited.error.message, /journey reads per intent per minute/u);
    assert.ok(Number((await call("GET", `/intents/${intent.id}/journey`)).headers.get("retry-after")) > 0);
    assert.equal((await call("GET", `/intents/${other.id}/journey`)).status, 200, "another intent has its own window");
  });

  it("serves the 15 s cache, and refresh=true reads again at most once per 10 s per intent", async () => {
    const intent = await stored();
    assert.equal((await call("GET", `/intents/${intent.id}/journey`)).status, 200);
    const reads = balanceReads;
    assert.equal((await call("GET", `/intents/${intent.id}/journey`)).status, 200);
    assert.equal(balanceReads, reads, "cached");
    const refreshed = await call<{ journey: Journey }>("GET", `/intents/${intent.id}/journey?refresh=true`);
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
    const again = assertError(await call("GET", `/intents/${intent.id}/journey?refresh=true`), 429, "RATE_LIMITED");
    assert.match(again.error.message, /journey refresh per intent every 10 seconds/u);
  });
});

describe("POST /v1/intents/{id}/stop", () => {
  it("cancels an intent nothing of which started, with its journey, and is idempotent", async () => {
    const intent = await stored(BRIDGE_THEN_SWAP);
    const stopped = await call<{ intent: IntentGraph; journey: Journey | null }>("POST", `/intents/${intent.id}/stop`);
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
    assert.equal(stopped.body.intent.status, "cancelled");
    assert.ok(stopped.body.intent.steps.every((step) => step.status === "skipped"));
    assert.equal(stopped.body.journey?.intentId, intent.id);
    assert.equal(stopped.body.journey?.stage, "final");
    const again = await call<{ intent: IntentGraph }>("POST", `/intents/${intent.id}/stop`);
    assert.equal(again.status, 200);
    assert.equal(again.body.intent.updatedAt, stopped.body.intent.updatedAt, "nothing changed");
    // Idempotency-Key replays the stored response.
    const keyed = await call<{ intent: IntentGraph }>("POST", `/intents/${intent.id}/stop`, { headers: { "idempotency-key": "stop-1" } });
    const replay = await call<{ intent: IntentGraph }>("POST", `/intents/${intent.id}/stop`, { headers: { "idempotency-key": "stop-1" } });
    assert.equal(keyed.status, 200);
    assert.equal(replay.headers.get("idempotent-replayed"), "true");
    assertError(await call("POST", `/intents/int_${"0".repeat(32)}/stop`), 404, "INTENT_NOT_FOUND");
  });

  it("refuses with 409 INTENT_IN_FLIGHT and Retry-After while a payload can be signed or a leg settles", async () => {
    const intent = await stored(BRIDGE_THEN_SWAP);
    const prepared = await call("POST", `/intents/${intent.id}/steps/s1/prepare`);
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
    const signable = await call("POST", `/intents/${intent.id}/stop`);
    const body = assertError(signable, 409, "INTENT_IN_FLIGHT");
    assert.match(body.error.message, /can still be signed/u);
    const wait = Number(signable.headers.get("retry-after"));
    assert.ok(wait > 0 && wait <= 600, `Retry-After ${wait}`);
    stub.poll = () => ({ status: "settling", evidence: [] });
    const submitted = await call<{ intent: IntentGraph }>("POST", `/intents/${intent.id}/steps/s1/submit`, { body: { references: [randomEvmHash(), randomEvmHash()] } });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    assert.equal(submitted.body.intent.steps[0]?.status, "settling");
    const settling = await call("POST", `/intents/${intent.id}/stop`);
    assertError(settling, 409, "INTENT_IN_FLIGHT");
    assert.equal(settling.headers.get("retry-after"), "30");
    const unchanged = await call<{ intent: IntentGraph }>("GET", `/intents/${intent.id}`);
    assert.equal(unchanged.body.intent.steps[1]?.status, "pending", "nothing skipped");
  });
});

describe("MCP journey tools", () => {
  const tool = (name: string) => {
    const found = KLETIA_TOOLS.find((entry) => entry.name === name);
    assert.ok(found, name);
    return found;
  };

  it("get_journey is read-only and returns the compact journey without calldata or requests", async () => {
    const intent = await stored(BRIDGE_THEN_SWAP);
    const getJourney = tool("get_journey");
    assert.equal(getJourney.annotations.readOnlyHint, true);
    const result = await runTool(getJourney, { intentId: intent.id }, { tier: "public" });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const content = result.structuredContent as { stage: string; stops: { holder: string; holdings: string[] }[]; legs: { venue: string }[]; consequences: unknown[] };
    assert.equal(content.stage, "plan");
    assert.ok(content.stops.length >= 2);
    assert.ok(content.stops.every((stop) => typeof stop.holder === "string" && Array.isArray(stop.holdings)));
    assert.ok(content.legs.every((leg) => typeof leg.venue === "string"));
    const text = JSON.stringify(result);
    assert.doesNotMatch(text, /"transactions"|"data":"0x|"request"|"accounts"/u, "no calldata and no replan request");
    const invalid = await runTool(getJourney, { intentId: "nope" }, { tier: "public" });
    assert.equal(invalid.isError, true);
  });

  it("plan_intent and get_intent carry the journey next to the preview", async () => {
    const plan = await runTool(tool("plan_intent"), { ...SWAP }, { tier: "public" });
    assert.equal(plan.isError, undefined, JSON.stringify(plan));
    const planned = plan.structuredContent as { preview?: { digest: string }; journey?: { previewDigest: string; stage: string } };
    assert.ok(planned.journey, "journey in plan_intent");
    assert.equal(planned.journey.previewDigest, planned.preview?.digest);
    const intent = await stored();
    const read = await runTool(tool("get_intent"), { intentId: intent.id }, { tier: "public" });
    assert.equal(read.isError, undefined, JSON.stringify(read));
    assert.equal((read.structuredContent as { journey?: { stage: string } }).journey?.stage, "plan");
  });
});
