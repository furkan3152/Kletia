/** Regression: pausing and resuming a pending link never shortens its activation delay, and a rotated-out secret cannot create or change links. */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { IntentGraph, LinkOwnerView } from "@kletia/core";
import { configurePlatform, configurePolicyPricing } from "../../index.js";
import { installMarket, standardPrices } from "../../engine/__tests__/policyHarness.js";
import { fund, FRIEND, installPreviewChain, resetPreviewEngine, USDC, USER, type PreviewChain } from "../../engine/__tests__/previewHarness.js";
import { call, serve, useTestEnvironment, type TestServer } from "./support.js";

useTestEnvironment();
delete process.env.KLETIA_LINK_ACTIVATION_DELAY_SECONDS; // default 900 s
const { createPlatformRouter, platformErrorHandler } = await import("../index.js");
const { configureLinkChecks } = await import("../links/service.js");
const { configureLinkStore, MemoryLinkStore } = await import("../links/store.js");
const { configureShellFetcher, HEAD_END, HEAD_START } = await import("../links/page.js");

const realFetch = globalThis.fetch;
let server: TestServer;
let chain: PreviewChain;

before(async () => {
  process.env.KLETIA_WEB_ORIGIN = "http://localhost:5173";
  server = await serve((app) => app.use("/v1", createPlatformRouter(), platformErrorHandler));
  chain = installPreviewChain();
  const mocked = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return url.startsWith("http://127.0.0.1:") ? realFetch(input, init) : mocked(input, init);
  }) as typeof fetch;
  resetPreviewEngine();
  standardPrices(installMarket());
  fund(chain.world, USDC.base, USER, 10_000_000_000n);
  configureLinkStore(new MemoryLinkStore());
  // Real clock; the publisher's domain verifies (a verified seal makes the phishing link more credible).
  configureLinkChecks({ now: () => Date.now(), domain: async () => true });
  configureShellFetcher(async () => `<!doctype html><html><head>${HEAD_START}<title>K</title>${HEAD_END}</head><body></body></html>`);
});

after(async () => {
  chain.restore();
  await server.close();
  configureLinkChecks(null);
  configureShellFetcher(null);
  configureLinkStore(null);
  configurePlatform({ adapters: null });
  configurePolicyPricing(null);
  delete process.env.KLETIA_WEB_ORIGIN;
});

describe("link activation delay", () => {
  it("pause + resume keeps the pending delay", async () => {
    const issued = await call<{ key: { id: string; key: string } }>(server, "POST", "/keys", { body: { name: "publisher (stolen)" } });
    const key = issued.body.key.key;
    const payee = `eip155:8453:${FRIEND}`; // attacker-controlled payee
    const created = await call<{ link: LinkOwnerView }>(server, "POST", "/links", {
      key,
      body: {
        title: "Pay invoice 1029",
        publisher: { name: "Acme Store", website: "https://shop.acme.example" },
        destination: { actions: [{ kind: "transfer", network: "base", from: "USDC", amount: "$amount", recipient: payee }] },
        funding: { networks: ["base"], assets: ["USDC"], amount: { mode: "input", bounds: { USDC: { min: "10", max: "500", default: "100" } } } },
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        blink: false,
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const link = created.body.link;
    assert.equal(link.status, "pending");

    const early = await call(server, "POST", `/links/${link.id}/intents`, { body: { source: { network: "base", asset: "USDC" }, amount: "100", accounts: [`eip155:8453:${USER}`] } });
    assert.equal(early.status, 409);

    const paused = await call<{ link: LinkOwnerView }>(server, "PATCH", `/links/${link.id}`, { key, body: { status: "paused" } });
    const resumed = await call<{ link: LinkOwnerView }>(server, "PATCH", `/links/${link.id}`, { key, body: { status: "active" } });
    assert.equal(resumed.body.link.status, "pending", "resuming a paused pending link returns it to pending");
    assert.equal(resumed.body.link.activatesAt, link.activatesAt, "the original activation time is kept");

    const refused = await call<{ error: { code: string } }>(server, "POST", `/links/${link.id}/intents`, { body: { source: { network: "base", asset: "USDC" }, amount: "100", accounts: [`eip155:8453:${USER}`] } });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, "LINK_PENDING");
  });

  it("a rotated-out secret cannot create or change links", async () => {
    const issued = await call<{ key: { id: string; key: string } }>(server, "POST", "/keys", { body: { name: "publisher" } });
    const leaked = issued.body.key.key;
    const rotated = await call<{ key: { key: string; previousExpiresAt: string } }>(server, "POST", `/keys/${issued.body.key.id}/rotate`, { key: leaked, body: {} });
    // The old secret is refused for key management and contract registration ...
    const created = await call<{ error: { code: string } }>(server, "POST", "/links", {
      key: leaked,
      body: {
        title: "Pay invoice 2044",
        publisher: { name: "Acme Store", website: "https://shop.acme.example" },
        destination: { actions: [{ kind: "transfer", network: "base", from: "USDC", amount: "$amount", recipient: `eip155:8453:${FRIEND}` }] },
        funding: { networks: ["base"], assets: ["USDC"], amount: { mode: "input", bounds: { USDC: { min: "10", max: "500" } } } },
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      },
    });
    assert.equal(created.status, 403);
    assert.equal(created.body.error.code, "KEY_SECRET_ROTATED");
    // The new secret still works.
    const current = await call(server, "GET", "/links", { key: rotated.body.key.key });
    assert.equal(current.status, 200);
  });
});
