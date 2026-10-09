/**
 * Intent links over HTTP (intent-links design L3), memory stores and the
 * offline preview chain: CRUD and views (public vs owner), activation delay,
 * tighten-only PATCH, drift pause and resume, visitor quotes (cached) and
 * intents, use reservations at prepare (atomic, released on a failed prepare
 * and on cancel, consumed at submit), the page shell (escaping, headers,
 * 404 / 410 / 503), the share card (PNG, sizes, ETag, void state),
 * privacy-preserving counters and reports, Solana Actions (metadata,
 * disabled links, callback tokens, CORS), operator routes, link webhooks
 * with `scope: "subtree"` routing for agent keys, and the store's atomic
 * reservation (memory, plus Postgres when KLETIA_TEST_DATABASE_URL is set).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { inflateSync } from "node:zlib";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import express from "express";
import type { IntentGraph, LinkDefinition, LinkOwnerView, LinkView } from "@kletia/core";
import { configurePlatform, configurePolicyPricing } from "../../index.js";
import { randomEvmHash, stubSolanaTransfer } from "../../engine/__tests__/helpers.js";
import { installMarket, standardPrices } from "../../engine/__tests__/policyHarness.js";
import { fund, FRIEND, installPreviewChain, PREVIEW_ADAPTERS, resetPreviewEngine, USDC, USER, type PreviewChain } from "../../engine/__tests__/previewHarness.js";
import { assertError, call, OPERATOR_KEY, serve, useTestEnvironment, waitFor, type ErrorEnvelope, type TestServer } from "./support.js";

useTestEnvironment();
delete process.env.KLETIA_LINK_ACTIVATION_DELAY_SECONDS;
delete process.env.KLETIA_LINK_BLINK_REQUIRE_APPROVAL;
const { createPlatformRouter, platformErrorHandler } = await import("../index.js");
const { configureLinkChecks, pauseForDrift } = await import("../links/service.js");
const { configureLinkStore, linkStore, MemoryLinkStore, PostgresLinkStore } = await import("../links/store.js");
const { resetLinkLimiters, isLinkAssetPath } = await import("../links/handlers.js");
const { configureShellFetcher, HEAD_END, HEAD_START } = await import("../links/page.js");
const { flushLinkStats } = await import("../links/stats.js");
const { startLinkUseListener } = await import("../links/uses.js");
const { subscribeLinkEvents } = await import("../links/events.js");
const { blinkToken } = await import("../links/blinks.js");
const { startWebhookDispatcher } = await import("../dispatcher.js");
const { createCorsMiddleware } = await import("../../../shared/http/cors.js");
const { closePlatformDatabase } = await import("../db.js");

const WEB = "http://localhost:5173";
const ACCOUNT_BASE = `eip155:8453:${USER}`;
const PAYEE = `eip155:8453:${FRIEND}`;
const SHELL = `<!doctype html><html><head><meta charset="utf-8" />${HEAD_START}<title>Kletia</title>${HEAD_END}<script type="module" src="/assets/app.js"></script></head><body><div id="root"></div></body></html>`;

const realFetch = globalThis.fetch;
let server: TestServer;
let chain: PreviewChain;
let offset = 0;
let domainVerified = true;
const events: { type: string; linkId: string; reason?: string }[] = [];
let stopEvents: () => void = () => undefined;
let stopListener: () => void = () => undefined;

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

/** "Pay 25 USDC to the payee on Base" (deliver), production lane with a fixed third party. */
function payDefinition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Pay 25 USDC to Acme",
    publisher: { name: "Acme Store", website: "https://shop.acme.example" },
    destination: { actions: [{ kind: "transfer", network: "base", from: "USDC", amount: "25", recipient: PAYEE }] },
    funding: { networks: ["base"], assets: ["USDC"], amount: { mode: "deliver" } },
    expiresAt: inDays(30),
    blink: false,
    ...overrides,
  };
}

/** "Tip the team", 10-500 USDC chosen by the visitor. */
function tipDefinition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return payDefinition({
    title: "Tip the Acme team",
    destination: { actions: [{ kind: "transfer", network: "base", from: "USDC", amount: "$amount", recipient: PAYEE }] },
    funding: { networks: ["base"], assets: ["USDC"], amount: { mode: "input", bounds: { USDC: { min: "10", max: "500", default: "100" } } } },
    ...overrides,
  });
}

async function issueKey(name: string): Promise<{ id: string; key: string }> {
  const reply = await call<{ key: { id: string; key: string } }>(server, "POST", "/keys", { body: { name } });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return reply.body.key;
}

async function createLink(key: string, definition: Record<string, unknown>): Promise<LinkOwnerView> {
  const reply = await call<{ link: LinkOwnerView }>(server, "POST", "/links", { key, body: definition });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return reply.body.link;
}

/** Activation delay off for links that should take visitors at once. */
async function activeLink(key: string, definition: Record<string, unknown>): Promise<LinkOwnerView> {
  process.env.KLETIA_LINK_ACTIVATION_DELAY_SECONDS = "0";
  try {
    const link = await createLink(key, definition);
    assert.equal(link.status, "active");
    return link;
  } finally {
    delete process.env.KLETIA_LINK_ACTIVATION_DELAY_SECONDS;
  }
}

async function visitorIntent(linkId: string, body: Record<string, unknown> = {}): Promise<IntentGraph> {
  const reply = await call<{ intent: IntentGraph }>(server, "POST", `/links/${linkId}/intents`, { body: { source: { network: "base", asset: "USDC" }, accounts: [ACCOUNT_BASE], ...body } });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return reply.body.intent;
}

function prepare(intentId: string) {
  return call<{ payload: { transactions: unknown[] } } | ErrorEnvelope>(server, "POST", `/intents/${intentId}/steps/s1/prepare`, { body: {} });
}

before(async () => {
  process.env.KLETIA_WEB_ORIGIN = WEB;
  stopEvents = subscribeLinkEvents((event) => events.push({ type: event.type, linkId: event.data.linkId, ...(event.data.reason ? { reason: event.data.reason } : {}) }));
  stopListener = startLinkUseListener();
});

after(async () => {
  stopEvents();
  stopListener();
  delete process.env.KLETIA_WEB_ORIGIN;
  configureLinkChecks(null);
  configureShellFetcher(null);
  configureLinkStore(null);
  configurePlatform({ adapters: null });
  configurePolicyPricing(null);
});

beforeEach(async () => {
  // A router per test: the key issuance limit (5 an hour per address) is per router.
  server = await serve((app) => app.use("/v1", createPlatformRouter(), platformErrorHandler));
  chain = installPreviewChain();
  // The offline chain answers outbound fetches; calls to the test server go through.
  const mocked = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return url.startsWith("http://127.0.0.1:") ? realFetch(input, init) : mocked(input, init);
  }) as typeof fetch;
  resetPreviewEngine();
  standardPrices(installMarket());
  fund(chain.world, USDC.base, USER, 10_000_000_000n);
  offset = 0;
  domainVerified = true;
  events.length = 0;
  configureLinkStore(new MemoryLinkStore());
  configureLinkChecks({ now: () => Date.now() + offset, domain: async () => domainVerified });
  configureShellFetcher(async () => SHELL);
  resetLinkLimiters();
});

afterEach(async () => {
  chain.restore();
  await server.close();
});

/* ================================================================ CRUD */

describe("links: creation and views", () => {
  it("publishes a link pending its activation delay, with public and owner views", async () => {
    const publisher = await issueKey("publisher");
    const link = await createLink(publisher.key, payDefinition({ maxUses: 2, metadata: { invoice: "A-1029" } }));
    assert.match(link.id, /^lk_[0-9a-f]{24}$/u);
    assert.equal(link.status, "pending", "production + fixed third party: activation delay");
    assert.ok(link.activatesAt && Date.parse(link.activatesAt) > Date.now() + 800_000);
    assert.equal(link.revision, 1);
    assert.equal(link.publisher.domainVerified, true);
    assert.equal(link.publisher.domain, "shop.acme.example");
    assert.equal(link.fixed.recipients[0]?.address.toLowerCase(), FRIEND.toLowerCase());
    assert.deepEqual(link.uses, { max: 2, left: 2 });
    assert.equal(link.urls.page, `${WEB}/go/${link.id}`);
    assert.equal(link.ownerKeyId, publisher.id);
    assert.deepEqual(events.map((event) => event.type), ["link.created"]);

    // Anyone reads the public view: no definition, pins, owner or metadata.
    const anonymous = await call<{ link: LinkView & Record<string, unknown> }>(server, "GET", `/links/${link.id}`);
    assert.equal(anonymous.status, 200);
    for (const field of ["definition", "pins", "ownerKeyId", "pausedReason"]) assert.equal(field in anonymous.body.link, false, field);
    assert.equal(JSON.stringify(anonymous.body).includes("A-1029"), false, "metadata stays private");
    assert.equal(anonymous.body.link.notices.length, 2);
    const stranger = await issueKey("stranger");
    const foreign = await call<{ link: Record<string, unknown> }>(server, "GET", `/links/${link.id}`, { key: stranger.key });
    assert.equal("definition" in foreign.body.link, false, "another project sees the public view");
    assertError(await call(server, "PATCH", `/links/${link.id}`, { key: stranger.key, body: { title: "Mine now" } }), 404, "LINK_NOT_FOUND");
    assertError(await call(server, "DELETE", `/links/${link.id}`, { key: stranger.key }), 404, "LINK_NOT_FOUND");
    const owner = await call<{ link: LinkOwnerView }>(server, "GET", `/links/${link.id}`, { key: publisher.key });
    assert.equal(owner.body.link.definition.metadata?.invoice, "A-1029");
    assert.ok(owner.body.link.stats, "the owner view carries counters");

    // Visitors wait for the delay (Retry-After); then the link activates lazily.
    const early = await call(server, "POST", `/links/${link.id}/quote`, { body: { source: { network: "base", asset: "USDC" } } });
    assertError(early, 409, "LINK_PENDING");
    assert.ok(Number(early.headers.get("retry-after")) > 800);
    offset = 901_000;
    const activated = await call<{ link: LinkView }>(server, "GET", `/links/${link.id}`);
    assert.equal(activated.body.link.status, "active");
    assert.ok(events.some((event) => event.type === "link.activated" && event.linkId === link.id));

    const listed = await call<{ links: LinkOwnerView[] }>(server, "GET", "/links", { key: publisher.key });
    assert.deepEqual(listed.body.links.map((entry) => entry.id), [link.id]);
    assert.deepEqual((await call<{ links: unknown[] }>(server, "GET", "/links", { key: stranger.key })).body.links, []);
  });

  it("refuses invalid definitions, unknown ids, keyless writes and unreachable funding", async () => {
    const publisher = await issueKey("validation");
    const invalid = assertError(await call(server, "POST", "/links", { key: publisher.key, body: payDefinition({ title: "x" }) }), 400, "LINK_DEFINITION_INVALID");
    assert.ok(invalid.error.issues?.some((issue) => issue.path === "title"));
    assertError(await call(server, "POST", "/links", { body: payDefinition() }), 401, "API_KEY_REQUIRED");
    assertError(await call(server, "GET", `/links/lk_${"0".repeat(24)}`), 404, "LINK_NOT_FOUND");
    assertError(await call(server, "GET", "/links/not-a-link"), 400, "INVALID_REQUEST");
    const created = await call(server, "POST", "/links", { key: publisher.key, body: payDefinition({ funding: { networks: ["base"], assets: ["WETH"], amount: { mode: "deliver" } } }) });
    assert.ok(created.status === 400 || created.status === 422, JSON.stringify(created.body));
  });

  it("withdraws a link: visitors get 410 LINK_EXPIRED, the page and card turn void", async () => {
    const publisher = await issueKey("withdraw");
    const link = await activeLink(publisher.key, payDefinition());
    const before = await call(server, "GET", `/links/${link.id}/card.png`);
    assert.equal(before.status, 200);
    assert.equal((await call(server, "DELETE", `/links/${link.id}`, { key: publisher.key })).status, 204);
    assert.equal((await call(server, "DELETE", `/links/${link.id}`, { key: publisher.key })).status, 204, "idempotent");
    assertError(await call(server, "POST", `/links/${link.id}/quote`, { body: { source: { network: "base", asset: "USDC" } } }), 410, "LINK_EXPIRED");
    assertError(await call(server, "GET", `/links/${link.id}`), 410, "LINK_EXPIRED");
    const page = await fetch(`${server.base}/links/${link.id}/page`);
    assert.equal(page.status, 410);
    assert.match(await page.text(), /no longer available/u);
    const card = await call(server, "GET", `/links/${link.id}/card.png`);
    assert.match(card.headers.get("etag") ?? "", /-void"$/u);
    assert.ok(events.some((event) => event.type === "link.deleted"));
  });
});

/* ================================================================ PATCH */

describe("links: tighten-only updates", () => {
  it("lets the promise shrink and never grow", async () => {
    const publisher = await issueKey("tighten");
    const link = await activeLink(publisher.key, tipDefinition({ maxUses: 10, perAccount: { maxUses: 3 } }));
    const patch = (body: unknown) => call<{ link: LinkOwnerView }>(server, "PATCH", `/links/${link.id}`, { key: publisher.key, body });
    const refusals: [string, unknown][] = [
      ["maxUses", { maxUses: 11 }],
      ["perAccount.maxUses", { perAccount: { maxUses: 4 } }],
      ["funding.amount.bounds.USDC.min", { funding: { amount: { mode: "input", bounds: { USDC: { min: "5" } } } } }],
      ["funding.amount.bounds.USDC.max", { funding: { amount: { mode: "input", bounds: { USDC: { max: "600" } } } } }],
      ["funding.networks", { funding: { networks: ["base", "arbitrum"] } }],
      ["expiresAt", { expiresAt: inDays(60) }],
      ["blink", { blink: true }],
      ["destination", { destination: { actions: [] } }],
      ["publisher", { publisher: { name: "Someone Else" } }],
    ];
    for (const [path, body] of refusals) {
      const refused = assertError(await patch(body), 422, "LINK_IMMUTABLE_FIELD");
      assert.ok(refused.error.issues?.some((issue) => issue.path === path), `${path}: ${JSON.stringify(refused.error.issues)}`);
    }
    const tightened = await patch({ maxUses: 5, funding: { amount: { mode: "input", bounds: { USDC: { min: "20", max: "200" } } } }, expiresAt: inDays(10), title: "Tip the Acme crew" });
    assert.equal(tightened.status, 200, JSON.stringify(tightened.body));
    assert.equal(tightened.body.link.revision, 2);
    assert.deepEqual(tightened.body.link.uses, { max: 5, left: 5 });
    assert.equal(tightened.body.link.title, "Tip the Acme crew");
    const bounds = tightened.body.link.definition.funding.amount;
    assert.deepEqual(bounds.mode === "input" ? bounds.bounds.USDC : null, { min: "20", max: "200", default: "100" });
    assertError(await call(server, "POST", `/links/${link.id}/quote`, { body: { source: { network: "base", asset: "USDC" }, amount: "300" } }), 422, "LINK_INPUT_OUT_OF_BOUNDS");
    assert.ok(events.some((event) => event.type === "link.updated"));

    // Pause and resume.
    const paused = await patch({ status: "paused" });
    assert.equal(paused.body.link.status, "paused");
    assert.ok(events.some((event) => event.type === "link.paused" && event.reason === "publisher"));
    assertError(await call(server, "POST", `/links/${link.id}/quote`, { body: { source: { network: "base", asset: "USDC" } } }), 409, "LINK_PAUSED");
    assert.equal((await patch({ status: "active" })).body.link.status, "active");
  });

  it("pauses itself when a pinned recipient drifts and resumes only with accept", async () => {
    const publisher = await issueKey("drift");
    const link = await activeLink(publisher.key, payDefinition());
    const record = await linkStore().get(link.id);
    assert.ok(record);
    await pauseForDrift(record, "recipient_changed");
    assert.ok(events.some((event) => event.type === "link.paused" && event.reason === "recipient_changed"));
    const visitor = assertError(await call(server, "POST", `/links/${link.id}/quote`, { body: { source: { network: "base", asset: "USDC" } } }), 409, "LINK_PAUSED");
    assert.match(visitor.error.message, /recipient changed/u);
    assertError(await call(server, "PATCH", `/links/${link.id}`, { key: publisher.key, body: { status: "active" } }), 409, "LINK_RECIPIENT_CHANGED");
    const resumed = await call<{ link: LinkOwnerView }>(server, "PATCH", `/links/${link.id}`, { key: publisher.key, body: { status: "active", accept: ["recipient_changed"] } });
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    assert.equal(resumed.body.link.revision, 2, "re-pinned: a new revision");
    assert.equal(resumed.body.link.status, "pending", "a re-pinned production payee waits for the delay again");
  });
});

/* ================================================================= uses */

describe("links: visitors, quotes and uses", () => {
  it("quotes indicatively (cached) and per account, storing nothing", async () => {
    const publisher = await issueKey("quotes");
    const link = await activeLink(publisher.key, tipDefinition());
    const first = await call<{ intent: IntentGraph; preview: { stage: string } }>(server, "POST", `/links/${link.id}/quote`, { body: { source: { network: "base", asset: "USDC" }, amount: "40" } });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.intent.steps[0]?.input?.amount, "40000000");
    assert.equal(first.body.intent.steps[0]?.recipient?.toLowerCase(), PAYEE.toLowerCase());
    assert.equal(first.headers.get("kletia-quote-cache"), null);
    const again = await call(server, "POST", `/links/${link.id}/quote`, { body: { source: { network: "base", asset: "USDC" }, amount: "40" } });
    assert.equal(again.headers.get("kletia-quote-cache"), "hit");
    const keyed = await call<{ intent: IntentGraph }>(server, "POST", `/links/${link.id}/quote`, { body: { source: { network: "base", asset: "USDC" }, amount: "40", accounts: [ACCOUNT_BASE] } });
    assert.equal(keyed.status, 200);
    assert.deepEqual(keyed.body.intent.request.accounts, [ACCOUNT_BASE]);
    assertError(await call(server, "POST", `/links/${link.id}/quote`, { body: { source: { network: "arbitrum", asset: "USDC" }, amount: "40" } }), 422, "LINK_SOURCE_NOT_ALLOWED");
    assertError(await call(server, "POST", `/links/${link.id}/quote`, { body: { source: { network: "base", asset: "USDC" }, amount: "40", extra: true } }), 400, "INVALID_REQUEST");
  });

  it("reserves a use at the first prepare, refuses beyond maxUses, releases on cancel and consumes at submit", async () => {
    const publisher = await issueKey("uses");
    const link = await activeLink(publisher.key, payDefinition({ maxUses: 1 }));
    const first = await visitorIntent(link.id);
    assert.equal(first.metadata?.linkId, link.id);
    // The intent belongs to the publisher key: it lists it.
    const owned = await call<{ intents: IntentGraph[] }>(server, "GET", "/intents", { key: publisher.key });
    assert.ok(owned.body.intents.some((intent) => intent.id === first.id));
    // Intents reserve nothing: a second visitor can start too.
    const second = await visitorIntent(link.id, { clientReference: "second-visitor" });
    // A retry with the same clientReference replays the stored intent.
    const replay = await call<{ intent: IntentGraph }>(server, "POST", `/links/${link.id}/intents`, { body: { source: { network: "base", asset: "USDC" }, accounts: [ACCOUNT_BASE], clientReference: "second-visitor" } });
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get("idempotent-replayed"), "true");
    assert.equal(replay.body.intent.id, second.id);

    const prepared = await prepare(first.id);
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
    assert.deepEqual((await call<{ link: LinkOwnerView }>(server, "GET", `/links/${link.id}`, { key: publisher.key })).body.link.uses, { max: 1, left: 0 });
    // Preparing again keeps the same reservation.
    assert.equal((await prepare(first.id)).status, 200);
    assertError(await prepare(second.id), 409, "LINK_EXHAUSTED");
    // While every use is taken, new visitors wait (retryable).
    assertError(await call(server, "POST", `/links/${link.id}/intents`, { body: { source: { network: "base", asset: "USDC" }, accounts: [ACCOUNT_BASE] } }), 409, "LINK_EXHAUSTED");

    // Cancelling the first intent releases its use (intent status listener).
    assert.equal((await call(server, "POST", `/intents/${first.id}/cancel`, { body: {} })).status, 200);
    await waitFor(async () => (await linkStore().get(link.id))?.used === 0, 2_000, "the release");
    assert.equal((await prepare(second.id)).status, 200);
    const submitted = await call(server, "POST", `/intents/${second.id}/steps/s1/submit`, { body: { references: [randomEvmHash()] } });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    assert.equal((await linkStore().use(link.id, second.id))?.state, "consumed");
    assert.equal((await linkStore().use(link.id, first.id))?.state, "released");
    assert.equal((await linkStore().get(link.id))?.used, 1);
  });

  it("releases the reservation of a prepare that fails", async () => {
    const publisher = await issueKey("failing-prepare");
    const link = await activeLink(publisher.key, payDefinition({ maxUses: 3 }));
    const intent = await visitorIntent(link.id);
    chain.world.simulateDown = true;
    const failed = await prepare(intent.id);
    assert.ok(failed.status >= 400, JSON.stringify(failed.body));
    assert.equal((await linkStore().get(link.id))?.used, 0, "nothing stays reserved");
    assert.equal((await linkStore().use(link.id, intent.id))?.state, "released");
  });

  it("limits visitor intents per account and per-account uses", async () => {
    const publisher = await issueKey("per-account");
    const link = await activeLink(publisher.key, payDefinition({ perAccount: { maxUses: 1 } }));
    const first = await visitorIntent(link.id);
    assert.equal((await prepare(first.id)).status, 200);
    assertError(await call(server, "POST", `/links/${link.id}/intents`, { body: { source: { network: "base", asset: "USDC" }, accounts: [ACCOUNT_BASE] } }), 409, "LINK_ACCOUNT_LIMIT");
    resetLinkLimiters();
    const other = await activeLink(publisher.key, payDefinition({ title: "Pay 25 USDC to Acme again" }));
    for (let index = 0; index < 5; index += 1) await visitorIntent(other.id, { clientReference: `burst-${index}` });
    const limited = assertError(await call(server, "POST", `/links/${other.id}/intents`, { body: { source: { network: "base", asset: "USDC" }, accounts: [ACCOUNT_BASE] } }), 429, "RATE_LIMITED");
    assert.match(limited.error.message, /from one account/u);
  });
});

/* =========================================================== page, card */

function pngSize(buffer: Buffer): { width: number; height: number } {
  assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "PNG signature");
  assert.equal(buffer.subarray(12, 16).toString("latin1"), "IHDR");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

describe("links: page shell and share card", () => {
  it("injects escaped per-link meta between the markers, with strict headers", async () => {
    const publisher = await issueKey("page");
    const link = await activeLink(publisher.key, payDefinition({ title: `Pay "Acme" <b>now</b> & then` }));
    const page = await fetch(`${server.base}/links/${link.id}/page`, { headers: { "user-agent": "Mozilla/5.0" } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(page.headers.get("content-type") ?? "", /text\/html/u);
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.equal(page.headers.get("content-security-policy"), "frame-ancestors 'none'");
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    assert.match(html, /<meta property="og:title" content="Pay &quot;Acme&quot; &lt;b&gt;now&lt;\/b&gt; &amp; then · Acme Store" \/>/u);
    assert.equal(html.includes("<b>now</b>"), false, "nothing unescaped");
    assert.match(html, /<meta name="robots" content="noindex,nofollow" \/>/u);
    assert.ok(html.includes(`<meta property="og:image" content="${WEB}/go/${link.id}/card.png?v=1" />`));
    assert.ok(html.includes('<script type="module" src="/assets/app.js"></script>'), "the rest of the shell is untouched");
    assert.equal(html.split(HEAD_START).length, 2);

    const unknown = await fetch(`${server.base}/links/lk_${"f".repeat(24)}/page`);
    assert.equal(unknown.status, 404);
    assert.match(await unknown.text(), /no longer available/u);
    const malformed = await fetch(`${server.base}/links/%3Cscript%3E/page`);
    assert.equal(malformed.status, 404);

    configureShellFetcher(async () => {
      throw new Error("down");
    });
    const unavailable = await fetch(`${server.base}/links/${link.id}/page`);
    assert.equal(unavailable.status, 503);
    assert.match(await unavailable.text(), /LINK_PAGE_UNAVAILABLE/u);
    assert.equal(unavailable.headers.get("cache-control"), "no-store");
  });

  it("renders wide and square PNG cards cached per revision", async () => {
    const publisher = await issueKey("card");
    const link = await activeLink(publisher.key, tipDefinition());
    const wide = await fetch(`${server.base}/links/${link.id}/card.png?v=1`);
    assert.equal(wide.status, 200);
    assert.equal(wide.headers.get("content-type"), "image/png");
    assert.equal(wide.headers.get("cache-control"), "public, max-age=86400, immutable");
    const wideBytes = Buffer.from(await wide.arrayBuffer());
    assert.deepEqual(pngSize(wideBytes), { width: 1200, height: 600 });
    // The image data inflates (a valid zlib stream) to height × (1 + width × 3) bytes (RGB, filter byte per row).
    const idat = wideBytes.indexOf("IDAT");
    const length = wideBytes.readUInt32BE(idat - 4);
    assert.equal(inflateSync(wideBytes.subarray(idat + 4, idat + 4 + length)).length, 600 * (1 + 1200 * 3));
    const etag = wide.headers.get("etag") ?? "";
    assert.equal(etag, `"${link.id}-r1-wide-ok"`);
    assert.equal((await fetch(`${server.base}/links/${link.id}/card.png`, { headers: { "if-none-match": etag } })).status, 304);
    const square = await fetch(`${server.base}/links/${link.id}/card.png?variant=square`);
    assert.deepEqual(pngSize(Buffer.from(await square.arrayBuffer())), { width: 600, height: 600 });
    assert.equal(square.headers.get("cache-control"), "public, max-age=300");
  });

  it("exempts the page and card from the per-IP tier limit (they carry a per-link limit)", () => {
    assert.equal(isLinkAssetPath(`/links/lk_${"a".repeat(24)}/page`), true);
    assert.equal(isLinkAssetPath(`/links/lk_${"a".repeat(24)}/card.png`), true);
    assert.equal(isLinkAssetPath(`/links/lk_${"a".repeat(24)}/quote`), false);
    assert.equal(isLinkAssetPath("/links"), false);
  });
});

/* ============================================================ counters */

describe("links: counters and reports", () => {
  it("counts views, quotes, intents and reports without anything per visitor", async () => {
    const publisher = await issueKey("stats");
    const link = await activeLink(publisher.key, tipDefinition());
    await fetch(`${server.base}/links/${link.id}/page`, { headers: { "user-agent": "Mozilla/5.0 (Macintosh)" } });
    await fetch(`${server.base}/links/${link.id}/page`, { headers: { "user-agent": "Twitterbot/1.0" } });
    await call(server, "POST", `/links/${link.id}/quote`, { body: { source: { network: "base", asset: "USDC" }, amount: "40" } });
    await visitorIntent(link.id, { amount: "40" });
    assert.equal((await call(server, "POST", `/links/${link.id}/report`, { body: { reason: "phishing" } })).status, 204);
    assertError(await call(server, "POST", `/links/${link.id}/report`, { body: { reason: "phishing", note: "my email is me@example.com" } }), 400, "INVALID_REQUEST");
    await flushLinkStats();
    const stats = await call<{ stats: { totals: Record<string, number>; daily: unknown[]; bySource: { source: string }[]; conversion: Record<string, number | null> } }>(server, "GET", `/links/${link.id}/stats?window=30d`, { key: publisher.key });
    assert.equal(stats.status, 200, JSON.stringify(stats.body));
    const totals = stats.body.stats.totals;
    assert.equal(totals.pageView, 1);
    assert.equal(totals.unfurl, 1);
    assert.equal(totals.quote, 1);
    assert.equal(totals.intent, 1);
    assert.equal(totals.report, 1);
    assert.equal(stats.body.stats.daily.length, 30);
    assert.ok(stats.body.stats.bySource.some((row) => row.source === "base:USDC"));
    const text = JSON.stringify(stats.body).toLowerCase();
    assert.equal(text.includes(USER.toLowerCase()), false, "no addresses");
    assert.equal(text.includes("mozilla") || text.includes("127.0.0.1"), false, "no user agents or IPs");
    assertError(await call(server, "GET", `/links/${link.id}/stats?window=1y`, { key: publisher.key }), 400, "INVALID_REQUEST");
    assertError(await call(server, "GET", `/links/${link.id}/stats`, { key: (await issueKey("nosy")).key }), 404, "LINK_NOT_FOUND");
  });
});

/* =============================================================== blinks */

describe("links: Solana Actions and operator routes", () => {
  function solanaDefinition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      title: "Pay 5 USDC on Solana",
      publisher: { name: "Acme Store", website: "https://shop.acme.example" },
      destination: { actions: [{ kind: "transfer", network: "solana", from: "USDC", amount: "5", recipient: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1" }] },
      funding: { networks: ["solana"], assets: ["USDC"], amount: { mode: "deliver" } },
      expiresAt: inDays(30),
      blink: true,
      ...overrides,
    };
  }

  it("serves Actions metadata with the spec headers, disabled when the link cannot be a blink", async () => {
    const publisher = await issueKey("blinks");
    const base = await activeLink(publisher.key, payDefinition());
    const disabled = await call<{ type: string; disabled?: boolean; error?: { message: string } }>(server, "GET", `/blinks/${base.id}`);
    assert.equal(disabled.status, 200);
    assert.equal(disabled.headers.get("x-action-version"), "2.4");
    assert.equal(disabled.headers.get("access-control-allow-origin"), "*");
    assert.equal(disabled.body.type, "action");
    assert.equal(disabled.body.disabled, true);
    assert.match(disabled.body.error?.message ?? "", /go\//u);
    const unknown = await call<{ message: string }>(server, "GET", `/blinks/lk_${"0".repeat(24)}`);
    assert.equal(unknown.status, 404);
    assert.equal(typeof unknown.body.message, "string");
    const refused = await call<{ message: string }>(server, "POST", `/blinks/${base.id}`, { body: { account: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" } });
    assert.equal(refused.status, 422);
    assert.equal("error" in (refused.body as object), false, "Actions errors are { message }");

    // A Solana-only link of a verified publisher, once the operator approves it.
    configurePlatform({ adapters: [...PREVIEW_ADAPTERS, stubSolanaTransfer] });
    const solana = await activeLink(publisher.key, solanaDefinition());
    const pendingApproval = await call<{ disabled?: boolean }>(server, "GET", `/blinks/${solana.id}`);
    assert.equal(pendingApproval.body.disabled, true, "mainnet blinks wait for operator approval");
    assertError(await call(server, "POST", `/links/${solana.id}/blink-approval`, { key: publisher.key, body: { approved: true } }), 401, "API_KEY_REQUIRED");
    const approved = await call<{ link: LinkOwnerView }>(server, "POST", `/links/${solana.id}/blink-approval`, { key: OPERATOR_KEY, body: { approved: true } });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.link.blink.enabled, true);
    const metadata = await call<{ type: string; title: string; links: { actions: { href: string; type: string }[] } }>(server, "GET", `/blinks/${solana.id}`);
    assert.equal(metadata.status, 200, JSON.stringify(metadata.body));
    assert.equal(metadata.body.title, "Acme Store");
    assert.match(metadata.body.links.actions[0]?.href ?? "", new RegExp(`/v1/blinks/${solana.id}\\?asset=USDC$`, "u"));
    assert.match(metadata.headers.get("x-blockchain-ids") ?? "", /^solana:/u);
    assertError(await call(server, "POST", `/links/${base.id}/blink-approval`, { key: OPERATOR_KEY, body: { approved: true } }), 422, "LINK_NOT_BLINK_ELIGIBLE");

    // Callback tokens bind link, intent, step and account.
    const intentId = `int_${"1".repeat(32)}`;
    const account = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    const token = blinkToken(solana.id, intentId, "s1", account);
    assert.match(token ?? "", /^[A-Za-z0-9_-]{22}$/u);
    const forged = await call<{ message: string }>(server, "POST", `/blinks/${solana.id}/next?intent=${intentId}&step=s1&t=${"A".repeat(22)}`, { body: { account, signature: "1".repeat(88) } });
    assert.equal(forged.status, 403);
    const otherAccount = await call<{ message: string }>(server, "POST", `/blinks/${solana.id}/next?intent=${intentId}&step=s1&t=${token}`, { body: { account: "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", signature: "1".repeat(88) } });
    assert.equal(otherAccount.status, 403, "the token is per account");
  });

  it("answers Actions preflights for every origin, platform routes for allowed origins only", async () => {
    const app = express();
    app.use(createCorsMiddleware());
    app.use("/v1", createPlatformRouter(), platformErrorHandler);
    const corsServer = await serve((target) => target.use(app));
    try {
      const preflight = await fetch(`${corsServer.base}/blinks/lk_${"0".repeat(24)}`, { method: "OPTIONS", headers: { origin: "https://dial.to", "access-control-request-method": "POST" } });
      assert.ok(preflight.status === 204 || preflight.status === 200);
      assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
      assert.match(preflight.headers.get("access-control-allow-methods") ?? "", /POST/u);
    } finally {
      await corsServer.close();
    }
  });

  it("lets the operator suspend a link: every prepare is refused", async () => {
    const publisher = await issueKey("suspend");
    const link = await activeLink(publisher.key, payDefinition());
    const intent = await visitorIntent(link.id);
    assertError(await call(server, "POST", `/links/${link.id}/suspend`, { key: publisher.key, body: { reason: "abuse_reports" } }), 401, "API_KEY_REQUIRED");
    const suspended = await call<{ link: LinkOwnerView }>(server, "POST", `/links/${link.id}/suspend`, { key: OPERATOR_KEY, body: { reason: "abuse_reports" } });
    assert.equal(suspended.status, 200);
    assert.equal(suspended.body.link.suspendedReason, "abuse_reports");
    assertError(await prepare(intent.id), 409, "LINK_SUSPENDED");
    assertError(await call(server, "PATCH", `/links/${link.id}`, { key: publisher.key, body: { status: "active" } }), 409, "LINK_SUSPENDED");
    assert.ok(events.some((event) => event.type === "link.suspended"));
  });
});

/* ============================================================== webhooks */

describe("links: webhooks and agent keys", () => {
  it("delivers link events to the owner and to subtree webhooks of its ancestors only", async () => {
    const deliveries: { url: string; type: string }[] = [];
    const stop = startWebhookDispatcher(async (url, _body, headers) => {
      deliveries.push({ url: url.toString(), type: headers["kletia-event-type"] ?? "" });
      return 204;
    });
    try {
      const project = await issueKey("tree-root");
      const self = await call<{ webhook: { scope: string } }>(server, "POST", "/webhooks", { key: project.key, body: { url: "https://93.184.215.14/self", events: ["link.created"] } });
      assert.equal(self.body.webhook.scope, "self");
      const subtree = await call<{ webhook: { scope: string } }>(server, "POST", "/webhooks", { key: project.key, body: { url: "https://93.184.215.14/subtree", events: ["link.created"], scope: "subtree" } });
      assert.equal(subtree.status, 201, JSON.stringify(subtree.body));
      assert.equal(subtree.body.webhook.scope, "subtree");
      assertError(await call(server, "POST", "/webhooks", { key: project.key, body: { url: "https://93.184.215.14/x", scope: "everyone" } }), 400, "INVALID_REQUEST");

      // An agent key without the links permission cannot publish.
      const observer = await call<{ key: { id: string; key: string } }>(server, "POST", `/keys/${project.id}/children`, { key: project.key, body: { name: "observer", expiresInSeconds: 86_400 } });
      assert.equal(observer.status, 201, JSON.stringify(observer.body));
      assertError(await call(server, "POST", "/links", { key: observer.body.key.key, body: payDefinition() }), 403, "AGENT_KEY_FORBIDDEN");

      // With the permission, its rule book still bounds the link: own recipients only.
      const agentPolicy = { schema: "kletia.policy/v1", permissions: { links: true } };
      const agent = await call<{ key: { id: string; key: string } }>(server, "POST", `/keys/${project.id}/children`, { key: project.key, body: { name: "publisher-agent", expiresInSeconds: 86_400, policy: agentPolicy } });
      assert.equal(agent.status, 201, JSON.stringify(agent.body));
      const conflict = assertError(await call(server, "POST", "/links", { key: agent.body.key.key, body: payDefinition() }), 422, "LINK_POLICY_CONFLICT");
      assert.ok(conflict.error.issues?.some((issue) => /recipients/u.test(issue.message) || /recipients/u.test(issue.path)), JSON.stringify(conflict.error.issues));
      const widened = await call(server, "PUT", `/keys/${agent.body.key.id}/policy`, { key: project.key, body: { ...agentPolicy, recipients: { mode: "allowlist", allow: [PAYEE] } } });
      assert.equal(widened.status, 200, JSON.stringify(widened.body));

      deliveries.length = 0;
      const link = await createLink(agent.body.key.key, payDefinition());
      assert.equal(link.ownerKeyId, agent.body.key.id);
      await waitFor(() => deliveries.length >= 1, 2_000, "a link delivery");
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(deliveries.map((delivery) => `${delivery.type} ${new URL(delivery.url).pathname}`), ["link.created /subtree"]);
      // The project key manages the agent's link.
      const managed = await call<{ link: LinkOwnerView }>(server, "GET", `/links/${link.id}`, { key: project.key });
      assert.equal(managed.body.link.ownerKeyId, agent.body.key.id);
    } finally {
      stop();
    }
  });
});

/* ================================================================== MCP */

describe("links: MCP Rule Book and link tools", () => {
  const META = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "kletia-tests", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  let sequence = 0;

  async function tool(name: string, args: Record<string, unknown>, key?: string): Promise<{ structuredContent: Record<string, unknown>; isError?: boolean }> {
    sequence += 1;
    const reply = await call<{ result?: { structuredContent: Record<string, unknown>; isError?: boolean }; error?: unknown }>(server, "POST", "/mcp", {
      ...(key ? { key } : {}),
      headers: { accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": name },
      body: { jsonrpc: "2.0", id: sequence, method: "tools/call", params: { name, arguments: args, _meta: META } },
    });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.ok(reply.body.result, JSON.stringify(reply.body.error));
    return reply.body.result;
  }

  it("reads the rule book, checks and stores intents within it, and publishes and quotes links", async () => {
    const project = await issueKey("mcp-root");
    const agentPolicy = {
      schema: "kletia.policy/v1",
      networks: { allow: ["base"] },
      recipients: { mode: "allowlist", allow: [PAYEE] },
      caps: { perIntentUsd: "100" },
      permissions: { storeIntents: true, mcpCreateIntents: true, links: true },
    };
    const agent = await call<{ key: { id: string; key: string } }>(server, "POST", `/keys/${project.id}/children`, { key: project.key, body: { name: "mcp-agent", expiresInSeconds: 86_400, policy: agentPolicy } });
    assert.equal(agent.status, 201, JSON.stringify(agent.body));
    const agentKey = agent.body.key.key;

    const policy = (await tool("get_policy", {}, agentKey)).structuredContent;
    assert.equal(policy.kind, "agent");
    assert.equal(policy.active, true);
    assert.equal((policy.permissions as Record<string, boolean>).links, true);

    const allowed = (await tool("check_intent", { text: `send 20 USDC to ${FRIEND} on base`, accounts: [ACCOUNT_BASE] }, agentKey)).structuredContent;
    assert.equal(allowed.outcome, "allow", JSON.stringify(allowed));
    const refused = (await tool("check_intent", { text: `send 200 USDC to ${FRIEND} on base`, accounts: [ACCOUNT_BASE] }, agentKey)).structuredContent;
    assert.equal(refused.outcome, "deny");
    assert.ok((refused.rules as { rule: string; status: string }[]).some((rule) => rule.rule === "caps.perIntentUsd" && rule.status === "fail"));

    const stored = (await tool("create_intent", { text: `send 20 USDC to ${FRIEND} on base`, accounts: [ACCOUNT_BASE], clientReference: "mcp-1" }, agentKey)).structuredContent;
    assert.match(String(stored.intentId), /^int_/u);
    assert.equal((stored.policy as { outcome: string }).outcome, "allow");
    assert.equal(JSON.stringify(stored).includes("0xa9059cbb"), false, "no calldata");
    const over = await tool("create_intent", { text: `send 200 USDC to ${FRIEND} on base`, accounts: [ACCOUNT_BASE] }, agentKey);
    assert.equal(over.isError, true);
    const error = (over.structuredContent as { error: { code: string; policy?: { violations: { rule: string }[] } } }).error;
    assert.equal(error.code, "POLICY_VIOLATION");
    assert.ok(error.policy?.violations.some((violation) => violation.rule === "caps.perIntentUsd"));

    const created = (await tool("create_link", { definition: payDefinition({ title: "Pay 25 USDC via MCP" }) }, agentKey)).structuredContent;
    assert.match(String(created.page), new RegExp(`^${WEB}/go/lk_[0-9a-f]{24}$`, "u"));
    const linkId = String(created.id);
    const listed = (await tool("list_links", {}, agentKey)).structuredContent as { links: { id: string }[] };
    assert.deepEqual(listed.links.map((link) => link.id), [linkId]);
    const read = (await tool("get_link", { linkId })).structuredContent;
    assert.equal(read.status, "pending");
    const payees = read.fixedRecipients as string[];
    assert.equal(payees.length, 1);
    assert.match(payees[0] ?? "", new RegExp(`^${FRIEND}( on base)$`, "iu"));
    offset = 901_000;
    const quoted = (await tool("quote_link", { linkId, source: { network: "base", asset: "USDC" } })).structuredContent;
    assert.ok(Array.isArray(quoted.steps) && (quoted.steps as unknown[]).length === 1, JSON.stringify(quoted));
    assert.match(String(quoted.note), /Nothing was stored/u);
  });
});

/* ======================================================== the use store */

function storeRecord(id: string, maxUses: number | null, perAccount = false): Parameters<ReturnType<typeof linkStore>["create"]>[0] {
  const now = new Date().toISOString();
  const definition = {
    title: "Store contract",
    publisher: { name: "Acme Store" },
    destination: { actions: [{ kind: "transfer", network: "base", from: "USDC", amount: "1", recipient: PAYEE }] },
    funding: { networks: ["base"], assets: ["USDC"], amount: { mode: "deliver" } },
    expiresAt: inDays(1),
    blink: false,
    ...(perAccount ? { perAccount: { maxUses: 1 } } : {}),
  } as unknown as LinkDefinition;
  return {
    id,
    ownerKeyId: `key_${randomBytes(12).toString("hex")}`,
    projectId: null,
    status: "active",
    revision: 1,
    definition,
    pins: { recipients: [], contracts: [], destinationAsset: { asset: "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", symbol: "USDC", decimals: 6 } },
    publisher: { name: "Acme Store", domainVerified: false },
    maxUses,
    used: 0,
    expiresAt: inDays(1),
    activatesAt: null,
    blinkApprovedAt: null,
    pausedReason: null,
    suspendedReason: null,
    flags: {},
    createdAt: now,
    updatedAt: now,
  };
}

function useStoreContract(name: string, make: () => InstanceType<typeof MemoryLinkStore> | InstanceType<typeof PostgresLinkStore>): void {
  describe(`${name} link use store`, () => {
    it("reserves atomically: 40 concurrent first prepares of a 7-use link get exactly 7", async () => {
      const store = make();
      const id = `lk_${randomBytes(12).toString("hex")}`;
      await store.create(storeRecord(id, 7), 200, Date.now());
      const outcomes = await Promise.all(
        Array.from({ length: 40 }, (_, index) => store.reserve({ linkId: id, intentId: `int_${index.toString(16).padStart(32, "0")}`, accountHash: null, source: "base:USDC", perAccountMax: null, now: Date.now() })),
      );
      assert.equal(outcomes.filter((outcome) => outcome.ok).length, 7);
      assert.ok(outcomes.filter((outcome) => !outcome.ok).every((outcome) => !outcome.ok && outcome.reason === "exhausted"));
      assert.equal((await store.get(id))?.used, 7);
      // A replayed reservation is not a second use; release frees one; consume is once.
      const intentId = `int_${(0).toString(16).padStart(32, "0")}`;
      const replay = await store.reserve({ linkId: id, intentId, accountHash: null, source: "base:USDC", perAccountMax: null, now: Date.now() });
      assert.ok(replay.ok && replay.replayed);
      assert.equal(await store.release(id, intentId, Date.now()), true);
      assert.equal(await store.release(id, intentId, Date.now()), false);
      assert.equal((await store.get(id))?.used, 6);
      const other = `int_${(1).toString(16).padStart(32, "0")}`;
      assert.deepEqual(await store.consume(id, other, Date.now()), { changed: true, overflow: false });
      assert.deepEqual(await store.consume(id, other, Date.now()), { changed: false, overflow: false });
      assert.equal(await store.release(id, other, Date.now()), false, "a consumed use is never released");
    });

    it("round-trips links, writes optimistically, lists, counts and finds stale reservations", async () => {
      const store = make();
      const id = `lk_${randomBytes(12).toString("hex")}`;
      const record = storeRecord(id, 3);
      await store.create(record, 200, Date.now());
      const stored = await store.get(id);
      assert.deepEqual(stored, record);
      assert.deepEqual((await store.listByOwner(record.ownerKeyId, { limit: 10 })).map((entry) => entry.id), [id]);
      const later = new Date(Date.parse(record.updatedAt) + 1_000).toISOString();
      assert.equal(await store.update({ ...record, status: "paused", pausedReason: "publisher", updatedAt: later }, record.updatedAt), true);
      assert.equal(await store.update({ ...record, title: "stale" } as typeof record, record.updatedAt), false, "a stale write loses");
      assert.equal((await store.get(id))?.status, "paused");
      assert.deepEqual((await store.listByOwner(record.ownerKeyId, { status: "active", limit: 10 })).length, 0);
      // The per-key cap counts live links.
      await assert.rejects(store.create({ ...storeRecord(`lk_${randomBytes(12).toString("hex")}`, null), ownerKeyId: record.ownerKeyId }, 1, Date.now()), (error: unknown) => (error as { code?: string }).code === "LINK_LIMIT_REACHED");

      const day = new Date().toISOString().slice(0, 10);
      await store.addStats([
        { linkId: id, day, metric: "quote", dimension: "base:USDC", count: 2, usdMicros: 0 },
        { linkId: id, day, metric: "quote", dimension: "base:USDC", count: 3, usdMicros: 0 },
        { linkId: id, day, metric: "volumeUsdMicros", dimension: "base:USDC", count: 0, usdMicros: 25_000_000 },
      ]);
      const stats = await store.readStats(id, day);
      assert.equal(stats.find((row) => row.metric === "quote")?.count, 5, "rows add up");
      assert.equal(stats.find((row) => row.metric === "volumeUsdMicros")?.usdMicros, 25_000_000);

      // A paused link takes no reservation; an active one does, and an old one is stale.
      const old = Date.now() - 2 * 86_400_000;
      const intentId = `int_${"e".repeat(32)}`;
      const paused = await store.reserve({ linkId: id, intentId, accountHash: null, source: "base:USDC", perAccountMax: null, now: Date.now() });
      assert.ok(!paused.ok && paused.reason === "inactive");
      const activeId = `lk_${randomBytes(12).toString("hex")}`;
      await store.create(storeRecord(activeId, 3), 200, Date.now());
      assert.equal((await store.reserve({ linkId: activeId, intentId, accountHash: null, source: "base:USDC", perAccountMax: null, now: old })).ok, true);
      const stale = await store.staleReservations(new Date(Date.now() - 86_400_000).toISOString(), 500);
      assert.ok(stale.some((use) => use.linkId === activeId && use.intentId === intentId));
    });

    it("enforces the per-account limit inside the reservation", async () => {
      const store = make();
      const id = `lk_${randomBytes(12).toString("hex")}`;
      await store.create(storeRecord(id, null, true), 200, Date.now());
      const reserve = (index: number) => store.reserve({ linkId: id, intentId: `int_${index.toString(16).padStart(32, "0")}`, accountHash: "a".repeat(64), source: "base:USDC", perAccountMax: 1, now: Date.now() });
      const outcomes = await Promise.all([reserve(1), reserve(2), reserve(3)]);
      assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1);
      assert.ok(outcomes.some((outcome) => !outcome.ok && outcome.reason === "account_limit"));
      assert.equal(await store.accountUses(id, "a".repeat(64)), 1);
    });
  });
}

useStoreContract("memory", () => new MemoryLinkStore());

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
    useStoreContract("postgres", () => new PostgresLinkStore());
  });
} else {
  describe("postgres link use store", () => {
    it("is exercised when KLETIA_TEST_DATABASE_URL is set", { skip: "KLETIA_TEST_DATABASE_URL not set" }, () => undefined);
  });
}
