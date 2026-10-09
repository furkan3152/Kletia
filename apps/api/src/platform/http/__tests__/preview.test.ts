/**
 * Asset-change preview over HTTP (asset-preview design V3): `?preview=true`
 * on create (stored and dry run), POST/GET /v1/intents/{id}/preview with the
 * per-intent limit, the prepare body (`acknowledgedPreview`), the
 * `Kletia-Preview-Ack` header and PREVIEW_CHANGED, the Postgres store
 * (round trip, size cap, pruning) and the MCP `preview_intent` tool.
 * Offline: stub venues (their steps are quoted), in-memory stores.
 */
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { PREVIEW_DIGEST_PATTERN, type IntentGraph, type IntentPreview, type StepPreview } from "@kletia/core";
import { configurePlatform, configurePreviewStore, getPreviewStore, PREVIEW_TTL_MS } from "../../index.js";
import { ACCOUNTS, resetEngine } from "../../engine/__tests__/helpers.js";
import { assertError, call as rawCall, OPERATOR_KEY, serve, useTestEnvironment, type CallOptions, type ErrorEnvelope, type Reply, type TestServer } from "./support.js";

useTestEnvironment();
const { createPlatformRouter, platformErrorHandler } = await import("../index.js");
const { PostgresPreviewStore, previewLimiter, PREVIEWS_PER_INTENT_PER_MINUTE, MAX_STORED_PREVIEW_BYTES } = await import("../preview.js");
const { closePlatformDatabase } = await import("../db.js");

const SWAP = { text: "swap 1 SOL to USDC", accounts: ACCOUNTS };
const MCP_VERSION = "2026-07-28";
const MCP_META = {
  "io.modelcontextprotocol/protocolVersion": MCP_VERSION,
  "io.modelcontextprotocol/clientInfo": { name: "kletia-tests", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

interface CreateReply {
  readonly intent: IntentGraph;
  readonly preview?: IntentPreview;
}

interface PrepareReply {
  readonly payload: { readonly quoteBinding: string; readonly preview?: StepPreview };
  readonly intent: IntentGraph;
  readonly preview?: IntentPreview;
  readonly previewAck?: "matched" | "unknown";
}

let server: TestServer;

/** Every call carries the operator key (1,200 requests a minute) unless the test sends its own. */
function call<T = unknown>(target: TestServer, method: string, path: string, options: CallOptions = {}): Promise<Reply<T>> {
  return rawCall<T>(target, method, path, { key: OPERATOR_KEY, ...options });
}

before(async () => {
  resetEngine();
  server = await serve((app) => {
    app.use("/v1", createPlatformRouter(), platformErrorHandler);
  });
});

after(async () => {
  configurePlatform({ adapters: null });
  configurePreviewStore(null);
  await server.close();
});

beforeEach(() => {
  resetEngine();
  configurePreviewStore(null);
  previewLimiter.reset();
});

describe("POST /v1/intents?preview=true", () => {
  it("returns the plan-stage preview of a stored intent next to it, never inside the graph", async () => {
    const created = await call<CreateReply>(server, "POST", "/intents?preview=true", { body: SWAP });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const { intent, preview } = created.body;
    assert.ok(preview, "preview returned");
    assert.equal(preview.spec, "kletia.preview/v1");
    assert.equal(preview.stage, "plan");
    assert.equal(preview.intentId, intent.id);
    assert.match(preview.digest, PREVIEW_DIGEST_PATTERN);
    assert.equal(preview.steps.length, intent.steps.length);
    assert.ok(preview.rows.some((row) => row.expected.amount.startsWith("-")), "the swap input is a debit");
    assert.equal("preview" in intent, false, "the graph does not grow");
    // Without the flag nothing is computed.
    const plain = await call<CreateReply>(server, "POST", "/intents", { body: SWAP });
    assert.equal(plain.status, 201);
    assert.equal(plain.body.preview, undefined);
    assertError(await call(server, "POST", "/intents?preview=maybe", { body: SWAP }), 400, "INVALID_REQUEST");
  });

  it("previews dry runs without storing the intent", async () => {
    const dry = await call<CreateReply>(server, "POST", "/intents?dryRun=true&preview=true", { body: SWAP });
    assert.equal(dry.status, 200);
    assert.ok(dry.body.preview);
    assert.equal(dry.body.preview.stage, "plan");
    assertError(await call(server, "GET", `/intents/${dry.body.intent.id}`), 404, "INTENT_NOT_FOUND");
    assertError(await call(server, "GET", `/intents/${dry.body.intent.id}/preview`), 404, "INTENT_NOT_FOUND");
  });
});

describe("POST and GET /v1/intents/{id}/preview", () => {
  it("answers 404 PREVIEW_NOT_FOUND until a preview is computed, then serves the last one", async () => {
    const created = await call<CreateReply>(server, "POST", "/intents", { body: SWAP });
    const id = created.body.intent.id;
    const missing = assertError(await call(server, "GET", `/intents/${id}/preview`), 404, "PREVIEW_NOT_FOUND");
    assert.match(missing.error.docs ?? "", /PREVIEW_NOT_FOUND/u);
    const fresh = await call<{ preview: IntentPreview }>(server, "POST", `/intents/${id}/preview`);
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
    assert.equal(fresh.body.preview.stage, "refresh");
    assert.equal(fresh.body.preview.intentId, id);
    const last = await call<{ preview: IntentPreview }>(server, "GET", `/intents/${id}/preview`);
    assert.equal(last.status, 200);
    assert.equal(last.body.preview.digest, fresh.body.preview.digest);
    assert.equal(last.headers.get("cache-control"), "no-store");
    assertError(await call(server, "GET", `/intents/int_${"0".repeat(32)}/preview`), 404, "INTENT_NOT_FOUND");
    assertError(await call(server, "GET", "/intents/nope/preview"), 400, "INVALID_REQUEST");
  });

  it("refuses bodies and unknown quote modes, and limits recomputations per intent", async () => {
    const created = await call<CreateReply>(server, "POST", "/intents", { body: SWAP });
    const id = created.body.intent.id;
    assertError(await call(server, "POST", `/intents/${id}/preview`, { body: { refresh: true } }), 400, "INVALID_REQUEST");
    assertError(await call(server, "POST", `/intents/${id}/preview?quotes=now`), 400, "INVALID_REQUEST");
    for (let index = 0; index < PREVIEWS_PER_INTENT_PER_MINUTE; index += 1) {
      assert.equal((await call(server, "POST", `/intents/${id}/preview`, { body: {} })).status, 200, `recomputation ${index + 1}`);
    }
    const limited = await call<ErrorEnvelope>(server, "POST", `/intents/${id}/preview`);
    assertError(limited, 429, "RATE_LIMITED");
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    // Other intents keep their own window; reading the last preview is never limited.
    const other = await call<CreateReply>(server, "POST", "/intents", { body: SWAP });
    assert.equal((await call(server, "POST", `/intents/${other.body.intent.id}/preview`)).status, 200);
    assert.equal((await call(server, "GET", `/intents/${id}/preview`)).status, 200);
  });

  it("re-quotes with quotes=refresh at most once per 20 s per intent", async () => {
    const created = await call<CreateReply>(server, "POST", "/intents", { body: SWAP });
    const id = created.body.intent.id;
    assert.equal((await call(server, "POST", `/intents/${id}/preview?quotes=refresh`)).status, 200);
    const again = await call(server, "POST", `/intents/${id}/preview?quotes=refresh`);
    assertError(again, 429, "RATE_LIMITED");
    assert.ok(Number(again.headers.get("retry-after")) >= 1);
  });
});

describe("prepare with acknowledgedPreview", () => {
  it("returns payload.preview bound to the payload and the whole intent's preview", async () => {
    const created = await call<CreateReply>(server, "POST", "/intents?preview=true", { body: SWAP });
    const id = created.body.intent.id;
    const prepared = await call<PrepareReply>(server, "POST", `/intents/${id}/steps/s1/prepare`);
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
    assert.equal(prepared.body.payload.preview?.quoteBinding, prepared.body.payload.quoteBinding);
    assert.equal(prepared.body.preview?.stage, "prepare");
    assert.equal(prepared.body.previewAck, undefined, "nothing acknowledged");
    assert.equal(prepared.headers.get("kletia-preview-ack"), null);
    // An empty body stays valid (the SDK sends {}).
    assert.equal((await call(server, "POST", `/intents/${id}/steps/s1/prepare`, { body: {} })).status, 200);
  });

  it("matches an acknowledged digest, reports an unknown one, and validates the body", async () => {
    const created = await call<CreateReply>(server, "POST", "/intents?preview=true", { body: SWAP });
    const id = created.body.intent.id;
    const digest = created.body.preview?.digest as string;
    const matched = await call<PrepareReply>(server, "POST", `/intents/${id}/steps/s1/prepare`, { body: { acknowledgedPreview: digest } });
    assert.equal(matched.status, 200, JSON.stringify(matched.body));
    assert.equal(matched.body.previewAck, "matched");
    assert.equal(matched.headers.get("kletia-preview-ack"), "matched");
    const unknown = await call<PrepareReply>(server, "POST", `/intents/${id}/steps/s1/prepare`, { body: { acknowledgedPreview: `sha256:${"ab".repeat(32)}` } });
    assert.equal(unknown.status, 200);
    assert.equal(unknown.headers.get("kletia-preview-ack"), "unknown");
    assert.equal(unknown.body.previewAck, "unknown");
    assert.ok(unknown.body.preview, "the fresh preview to show again");
    const bad = assertError(await call(server, "POST", `/intents/${id}/steps/s1/prepare`, { body: { acknowledgedPreview: "md5:abc" } }), 400, "INVALID_REQUEST");
    assert.equal(bad.error.issues?.[0]?.path, "acknowledgedPreview");
    assertError(await call(server, "POST", `/intents/${id}/steps/s1/prepare`, { body: { acknowledged: digest } }), 400, "INVALID_REQUEST");
    assertError(await call(server, "POST", `/intents/${id}/steps/s1/prepare`, { body: [digest] }), 400, "INVALID_REQUEST");
  });

  it("refuses a materially worse payload with 409 PREVIEW_CHANGED carrying the fresh preview", async () => {
    const created = await call<CreateReply>(server, "POST", "/intents?preview=true", { body: SWAP });
    const id = created.body.intent.id;
    const plan = created.body.preview as IntentPreview;
    // What the user "saw": the SOL debit was half as large (as if the plan had promised it).
    const debit = plan.rows.find((row) => row.expected.amount.startsWith("-"));
    assert.ok(debit);
    const halved = (BigInt(debit.worst.amount) / 2n).toString();
    const seen: IntentPreview = {
      ...plan,
      digest: `sha256:${"cd".repeat(32)}`,
      rows: plan.rows.map((row) => (row === debit ? { ...row, expected: { ...row.expected, amount: halved }, worst: { ...row.worst, amount: halved } } : row)),
    };
    await getPreviewStore().put(seen, PREVIEW_TTL_MS);
    const refused = await call<{ error: { code: string; issues?: { path: string }[]; preview?: IntentPreview; changes?: { code: string }[] } }>(
      server, "POST", `/intents/${id}/steps/s1/prepare`, { body: { acknowledgedPreview: seen.digest } },
    );
    assertError(refused, 409, "PREVIEW_CHANGED");
    assert.equal(refused.body.error.preview?.intentId, id);
    assert.equal(refused.body.error.preview?.stage, "prepare");
    assert.ok((refused.body.error.changes?.length ?? 0) > 0, "the changes are listed");
    assert.equal(refused.body.error.issues?.[0]?.path, refused.body.error.changes?.[0]?.code);
    // The step was not handed out: it is still ready to prepare.
    const intent = await call<{ intent: IntentGraph }>(server, "GET", `/intents/${id}`);
    assert.notEqual(intent.body.intent.steps[0]?.status, "awaiting_signature");
  });
});

describe("POST /v1/mcp preview_intent", () => {
  it("returns the compact fare without calldata and shares the per-intent limit", async () => {
    const created = await call<CreateReply>(server, "POST", "/intents", { body: SWAP });
    const id = created.body.intent.id;
    const reply = await call<{ result?: { structuredContent: Record<string, unknown>; isError?: boolean } }>(server, "POST", "/mcp", {
      headers: { accept: "application/json, text/event-stream", "mcp-protocol-version": MCP_VERSION, "mcp-method": "tools/call", "mcp-name": "preview_intent" },
      body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "preview_intent", arguments: { intentId: id }, _meta: MCP_META } },
    });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const content = reply.body.result?.structuredContent ?? {};
    assert.equal(reply.body.result?.isError, undefined, JSON.stringify(content));
    assert.match(String(content.digest), PREVIEW_DIGEST_PATTERN);
    assert.ok(Array.isArray(content.rows) && content.rows.length > 0);
    assert.ok(content.totals);
    const text = JSON.stringify(content);
    assert.doesNotMatch(text, /"transactions"|"data"\s*:\s*"0x|"transaction"\s*:/u, "no calldata or transactions");
    for (let index = 1; index < PREVIEWS_PER_INTENT_PER_MINUTE; index += 1) assert.equal((await call(server, "POST", `/intents/${id}/preview`)).status, 200);
    assertError(await call(server, "POST", `/intents/${id}/preview`), 429, "RATE_LIMITED");
  });
});

/* ------------------------------------------------------------ Postgres */

const databaseUrl = process.env.KLETIA_TEST_DATABASE_URL?.trim();

describe("postgres preview store", { skip: databaseUrl ? false : "set KLETIA_TEST_DATABASE_URL to run" }, () => {
  before(() => {
    process.env.KLETIA_DATABASE_URL = databaseUrl;
  });
  afterEach(() => configurePreviewStore(null));
  after(async () => {
    await closePlatformDatabase();
    delete process.env.KLETIA_DATABASE_URL;
  });

  function sample(intentId: string, digestByte: string, stage: IntentPreview["stage"] = "plan"): IntentPreview {
    return {
      spec: "kletia.preview/v1",
      intentId,
      computedAt: new Date().toISOString(),
      stage,
      basis: "quoted",
      digest: `sha256:${digestByte.repeat(32)}`,
      rows: [],
      payments: [],
      fees: [],
      approvals: [],
      steps: [],
      totals: {
        youPayUsd: null,
        youGetUsd: { expected: null, worst: null },
        paidToOthersUsd: { expected: null, worst: null },
        networkFeesUsd: null,
        venueFeesUsd: null,
        extraCostsUsd: null,
        costUsd: { expected: null, worst: null },
        priceDifferenceUsd: null,
        unpriced: [],
      },
      needs: [],
      warnings: [],
    };
  }

  it("round-trips by digest and latest per intent, refuses oversized previews and prunes expired rows", async () => {
    const store = new PostgresPreviewStore();
    const intentId = `int_${Date.now().toString(16).padStart(32, "0")}`;
    const first = sample(intentId, "1a");
    const second = sample(intentId, "2b", "refresh");
    await store.put(first, 60_000);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.put(second, 60_000);
    assert.equal((await store.byDigest(first.digest))?.digest, first.digest);
    assert.equal((await store.latest(intentId))?.digest, second.digest, "the newest is the latest");
    assert.equal(await store.byDigest(`sha256:${"ff".repeat(32)}`), null);
    assert.equal(await store.byDigest("not a digest"), null);
    const huge = { ...sample(intentId, "3c"), warnings: ["x".repeat(MAX_STORED_PREVIEW_BYTES)] };
    await assert.rejects(store.put(huge, 60_000), /not stored/u);
    // A short-lived preview expires and is pruned; the others stay.
    const shortLived = sample(intentId, "4d");
    await store.put(shortLived, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(await store.byDigest(shortLived.digest), null, "expired previews are not served");
    await store.prune(new Date().toISOString());
    assert.equal((await store.byDigest(second.digest))?.digest, second.digest);
    await store.prune(new Date(Date.now() + 120_000).toISOString());
    assert.equal(await store.latest(intentId), null, "pruned");
  });

  it("is installed by the router when a database is configured, so prepare finds digests across instances", async () => {
    resetEngine();
    configurePreviewStore(null);
    const router = createPlatformRouter();
    assert.ok(router);
    assert.ok(getPreviewStore() instanceof PostgresPreviewStore, "Postgres store installed");
    const local = await serve((app) => {
      app.use("/v1", createPlatformRouter(), platformErrorHandler);
    });
    try {
      const created = await call<CreateReply>(local, "POST", "/intents?preview=true", { body: SWAP });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const digest = created.body.preview?.digest as string;
      // Another instance: a fresh store object reads the same rows.
      configurePreviewStore(new PostgresPreviewStore());
      const prepared = await call<PrepareReply>(local, "POST", `/intents/${created.body.intent.id}/steps/s1/prepare`, { body: { acknowledgedPreview: digest } });
      assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
      assert.equal(prepared.headers.get("kletia-preview-ack"), "matched");
    } finally {
      await local.close();
    }
  });
});
