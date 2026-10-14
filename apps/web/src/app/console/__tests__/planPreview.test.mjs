// The desk's dry run keeps what the API said on a refusal (hints, details)
// and never treats a malformed answer as a plan. Run with
//   node --test apps/web/src/app/console/__tests__/*.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { failureFromBody, planPreview } from "../hooks/planPreview.ts";

function fakeFetch(status, body, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "x-request-id": "req_1" },
    });
  };
}

const request = { text: "bridge 25 USDC to solana", accounts: ["eip155:8453:0x9B58BE768EAB41bD43C8293DDDB6bf3c0D066590"], sourceNetwork: "auto" };

test("a dry run posts to /v1/intents?dryRun=true&preview=true and returns the plan with its fare", async () => {
  const calls = [];
  const intent = { id: "int_dry_1", steps: [], summary: { title: "Bridge" } };
  const result = await planPreview("https://api.example", request, {
    fetchImpl: fakeFetch(200, { intent, preview: { digest: "d1", intentId: "int_dry_1" } }, calls),
  });
  assert.equal(calls[0].url, "https://api.example/v1/intents?dryRun=true&preview=true");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), request);
  assert.equal(result.ok, true);
  assert.equal(result.intent.id, "int_dry_1");
  assert.equal(result.preview.digest, "d1");
});

test("SOURCE_REQUIRED keeps its details and INTENT_UNSUPPORTED its hints", async () => {
  const details = { asset: "USDC", amount: "25", toNetwork: "solana", candidates: [{ network: "base", balance: "3.10", enough: false }] };
  const source = await planPreview("https://api.example", request, {
    fetchImpl: fakeFetch(422, { error: { code: "SOURCE_REQUIRED", message: "No network holds 25 USDC.", details } }),
  });
  assert.equal(source.ok, false);
  assert.equal(source.failure.code, "SOURCE_REQUIRED");
  assert.deepEqual(source.failure.details, details);
  assert.equal(source.failure.requestId, "req_1");
  assert.equal(source.failure.retryable, false);
  const unsupported = await planPreview("https://api.example", request, {
    fetchImpl: fakeFetch(422, { error: { code: "INTENT_UNSUPPORTED", message: "x", hints: ["swap 1 SOL to USDC", 7, "x".repeat(300)] } }),
  });
  assert.deepEqual(unsupported.failure.hints, ["swap 1 SOL to USDC"]);
});

test("malformed answers and transport failures are failures, never plans", async () => {
  const malformed = await planPreview("https://api.example", request, { fetchImpl: fakeFetch(200, { intent: { id: 1 } }) });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.failure.code, "INVALID_RESPONSE");
  const html = await planPreview("https://api.example", request, { fetchImpl: fakeFetch(503, "<html>") });
  assert.equal(html.failure.code, "HTTP_503");
  assert.equal(html.failure.retryable, true);
  const offline = await planPreview("https://api.example", request, {
    fetchImpl: async () => {
      throw new TypeError("Failed to fetch");
    },
  });
  assert.equal(offline.failure.code, "UNREACHABLE");
  assert.equal(offline.failure.status, 0);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    planPreview("https://api.example", request, {
      signal: controller.signal,
      fetchImpl: async (_url, init) => {
        init.signal.throwIfAborted();
        return new Response("{}");
      },
    }),
  );
  assert.deepEqual(failureFromBody(400, { error: { code: "INVALID_REQUEST", message: "Bad", issues: [{ path: "text", message: "Required" }, "junk"] } }, null).issues, [
    { path: "text", message: "Required" },
  ]);
});
