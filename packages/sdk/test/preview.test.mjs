import assert from "node:assert/strict";
import test from "node:test";
import { previewDigest } from "@kletia/core";
import { KletiaClient, KletiaExecutionError, KletiaPreviewChangedError, executeIntent } from "../dist/index.js";

const EVM = "0x000000000000000000000000000000000000dEaD";
const USDC = "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const ACCOUNT = `eip155:8453:${EVM}`;
const RECIPIENT = "eip155:8453:0x1111111111111111111111111111111111111111";

function jsonResponse(status, body, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-request-id": "req-p", ...headers },
  });
}

/** A preview whose digest is computed by core (so the SDK's integrity check passes). */
async function preview(intentId, worst = "-5000000", extra = {}) {
  const row = {
    network: "base", account: ACCOUNT, asset: USDC, symbol: "USDC", decimals: 6, listed: true,
    expected: { amount: worst, formatted: "-5" }, worst: { amount: worst, formatted: "-5" }, certainty: "simulated", steps: ["s1"], role: "you",
  };
  const body = {
    spec: "kletia.preview/v1", intentId, computedAt: "2026-10-09T12:00:00.000Z", stage: "plan", basis: "simulated", digest: "",
    rows: [row], payments: [], fees: [], approvals: [],
    steps: [{ stepId: "s1", network: "base", kind: "transfer", status: "simulated", at: "2026-10-09T12:00:00.000Z", deltas: [row], payments: [], fees: [], approvals: [], issues: [] }],
    totals: { youPayUsd: 5, youGetUsd: { expected: 0, worst: 0 }, paidToOthersUsd: { expected: 5, worst: 5 }, networkFeesUsd: 0.01, venueFeesUsd: 0, extraCostsUsd: 0, costUsd: { expected: 0.01, worst: 0.01 }, priceDifferenceUsd: 0, unpriced: [] },
    needs: [], warnings: [], ...extra,
  };
  return { ...body, digest: await previewDigest(body) };
}

function transferStep(status = "ready") {
  return {
    id: "s1", index: 0, kind: "transfer", network: "base", chain: "eip155:8453", account: ACCOUNT, recipient: RECIPIENT,
    protocol: "evm-transfer", mode: "wallet", dependsOn: [], status, evidence: [],
    input: { asset: USDC, symbol: "USDC", decimals: 6, amount: "5000000", formatted: "5" },
  };
}

const graph = (id, status = "planned", stepStatus = "ready") => ({ spec: "kletia.intent/v1", id, status, request: { accounts: [ACCOUNT] }, edges: [], steps: [transferStep(stepStatus)] });

const transferTx = {
  vm: "evm", network: "base", chainId: 8453, from: EVM, to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  data: `0xa9059cbb${"0".repeat(24)}1111111111111111111111111111111111111111${(5000000).toString(16).padStart(64, "0")}`, value: "0", description: "Transfer",
};

/**
 * A fake API for one transfer intent. `prepares` scripts each prepare
 * answer: { changed: preview } (409), or { preview, ack }.
 */
function harness({ intentId, prepares, stored }) {
  const calls = [];
  let stepStatus = "ready";
  let prepareIndex = 0;
  const client = new KletiaClient({
    baseUrl: "http://localhost:3001",
    retryBaseDelayMs: 1,
    fetch: async (url, init) => {
      const { pathname, search } = new URL(url);
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ method: init.method, path: pathname, search, body });
      if (pathname.endsWith("/preview") && init.method === "GET") {
        return stored ? jsonResponse(200, { preview: stored }) : jsonResponse(404, { error: { code: "PREVIEW_NOT_FOUND", message: "none" } });
      }
      if (pathname.endsWith("/prepare")) {
        const answer = prepares[Math.min(prepareIndex, prepares.length - 1)];
        prepareIndex += 1;
        if (answer.changed) {
          return jsonResponse(409, { error: { code: "PREVIEW_CHANGED", message: "worse", issues: [{ path: "PREVIEW_WORSE_AMOUNT", message: "worse" }], preview: answer.changed, changes: [{ code: "PREVIEW_WORSE_AMOUNT", severity: "block", message: "USDC worse" }] } });
        }
        stepStatus = "awaiting_signature";
        const payloadPreview = { ...answer.preview.steps[0], quoteBinding: answer.binding ?? "qb1", ...(answer.issues ? { issues: answer.issues } : {}) };
        return jsonResponse(200, {
          intent: graph(intentId, "executing", stepStatus),
          payload: { vm: "evm", transactions: [transferTx], expiresAt: Math.floor(Date.now() / 1000) + 60, quoteBinding: "qb1", preview: payloadPreview },
          preview: answer.preview,
          ...(answer.ack ? { previewAck: answer.ack } : {}),
        });
      }
      if (pathname.endsWith("/submit")) {
        stepStatus = "settled";
        return jsonResponse(200, { intent: { ...graph(intentId, "completed", "settled") } });
      }
      throw new Error(`unexpected ${init.method} ${pathname}`);
    },
  });
  let sends = 0;
  const signers = { evm: { address: EVM, async sendTransaction() { sends += 1; return `0x${String(sends).padStart(64, "b")}`; }, async waitForTransaction() {} } };
  return { client, calls, signers, sends: () => sends };
}

test("intents.create with preview: true asks for ?preview=true and returns { intent, preview }", async () => {
  const shown = await preview("int_a");
  const calls = [];
  const client = new KletiaClient({
    baseUrl: "http://localhost:3001",
    fetch: async (url, init) => {
      const { search } = new URL(url);
      calls.push(search);
      return jsonResponse(200, { intent: graph("int_a"), ...(search.includes("preview=true") ? { preview: shown } : {}) });
    },
  });
  const both = await client.intents.create({ text: "send 5 USDC", accounts: [ACCOUNT] }, { preview: true, dryRun: true });
  assert.equal(both.intent.id, "int_a");
  assert.equal(both.preview.digest, shown.digest);
  assert.match(calls[0], /dryRun=true/u);
  assert.match(calls[0], /preview=true/u);
  const plain = await client.intents.create({ text: "send 5 USDC", accounts: [ACCOUNT] }, { dryRun: true });
  assert.equal(plain.id, "int_a", "without preview the graph itself, as before");
  assert.doesNotMatch(calls[1], /preview/u);
});

test("intents.preview recomputes (quotes=refresh, retried like a read) and getPreview reads the last one", async () => {
  const shown = await preview("int_b");
  const calls = [];
  let failures = 1;
  const client = new KletiaClient({
    baseUrl: "http://localhost:3001",
    retryBaseDelayMs: 1,
    fetch: async (url, init) => {
      const { pathname, search } = new URL(url);
      calls.push({ method: init.method, pathname, search, body: init.body });
      if (init.method === "POST" && failures-- > 0) return jsonResponse(503, { error: { code: "SIMULATION_UNAVAILABLE", message: "busy" } });
      return jsonResponse(200, { preview: shown });
    },
  });
  const fresh = await client.intents.preview("int_b", { refreshQuotes: true });
  assert.equal(fresh.digest, shown.digest);
  assert.equal(calls.length, 2, "a recomputation is retried like a read");
  assert.equal(calls[0].search, "?quotes=refresh");
  assert.equal(calls[0].body, "{}");
  const last = await client.intents.getPreview("int_b");
  assert.equal(last.digest, shown.digest);
  assert.deepEqual([calls[2].method, calls[2].pathname], ["GET", "/v1/intents/int_b/preview"]);
});

test("prepareStep sends acknowledgedPreview, refuses a malformed digest locally and surfaces PREVIEW_CHANGED with the fresh preview", async () => {
  const fresh = await preview("int_c", "-6000000");
  const calls = [];
  const client = new KletiaClient({
    baseUrl: "http://localhost:3001",
    fetch: async (url, init) => {
      calls.push(JSON.parse(init.body));
      return jsonResponse(409, { error: { code: "PREVIEW_CHANGED", message: "worse", preview: fresh, changes: [{ code: "PREVIEW_WORSE_AMOUNT", severity: "block", message: "worse" }] } });
    },
  });
  assert.throws(() => client.intents.prepareStep("int_c", "s1", { acknowledgedPreview: "sha256:nothex" }), TypeError);
  assert.equal(calls.length, 0, "nothing sent");
  const digest = `sha256:${"a".repeat(64)}`;
  await assert.rejects(client.intents.prepareStep("int_c", "s1", { acknowledgedPreview: digest }), (error) => {
    assert.ok(error instanceof KletiaPreviewChangedError);
    assert.equal(error.code, "PREVIEW_CHANGED");
    assert.equal(error.status, 409);
    assert.equal(error.preview.digest, fresh.digest);
    assert.equal(error.changes[0].code, "PREVIEW_WORSE_AMOUNT");
    return true;
  });
  assert.deepEqual(calls, [{ acknowledgedPreview: digest }], "prepare is never retried");
});

test("onPreview returning false stops before prepare and before any wallet prompt", async () => {
  const plan = await preview("int_d");
  const h = harness({ intentId: "int_d", prepares: [{ preview: plan, ack: "matched" }] });
  const seen = [];
  const final = await executeIntent(h.client, graph("int_d"), h.signers, {
    preview: plan,
    onPreview: (shown, stepPreview, context) => {
      seen.push({ digest: shown.digest, step: stepPreview?.stepId, reason: context.reason });
      return false;
    },
  });
  assert.equal(final.status, "planned");
  assert.deepEqual(seen, [{ digest: plan.digest, step: "s1", reason: "before-prepare" }]);
  assert.equal(h.calls.filter((call) => call.path.endsWith("/prepare")).length, 0);
  assert.equal(h.sends(), 0);
});

test("the approved digest is sent as acknowledgedPreview; a matched, not worse payload signs without asking twice", async () => {
  const plan = await preview("int_e");
  const h = harness({ intentId: "int_e", prepares: [{ preview: plan, ack: "matched" }] });
  let asked = 0;
  const final = await executeIntent(h.client, graph("int_e"), h.signers, { preview: plan, onPreview: () => { asked += 1; return true; } });
  assert.equal(final.status, "completed");
  assert.equal(asked, 1);
  const prepare = h.calls.find((call) => call.path.endsWith("/prepare"));
  assert.deepEqual(prepare.body, { acknowledgedPreview: plan.digest });
  assert.equal(h.sends(), 1);
});

test("PREVIEW_CHANGED asks again with the fresh preview and prepares with its digest; declining it never signs", async () => {
  const plan = await preview("int_f");
  const worse = await preview("int_f", "-5200000");
  for (const approveSecond of [true, false]) {
    const h = harness({ intentId: "int_f", prepares: [{ changed: worse }, { preview: worse, ack: "matched" }] });
    const reasons = [];
    const final = await executeIntent(h.client, graph("int_f"), h.signers, {
      preview: plan,
      onPreview: (shown, _step, context) => {
        reasons.push([context.reason, shown.digest === worse.digest ? "worse" : "plan", context.changes.map((change) => change.code).join()]);
        return context.reason === "changed" ? approveSecond : true;
      },
    });
    const prepares = h.calls.filter((call) => call.path.endsWith("/prepare"));
    if (approveSecond) {
      assert.equal(final.status, "completed");
      assert.deepEqual(reasons, [["before-prepare", "plan", ""], ["changed", "worse", "PREVIEW_WORSE_AMOUNT"]]);
      assert.deepEqual(prepares.map((call) => call.body.acknowledgedPreview), [plan.digest, worse.digest]);
      assert.equal(h.sends(), 1);
    } else {
      assert.equal(prepares.length, 1);
      assert.equal(h.sends(), 0, "never signs without a second approval");
    }
  }
});

test("an unknown acknowledged digest re-shows the fresh preview before signing", async () => {
  const plan = await preview("int_g");
  const fresh = await preview("int_g", "-5000001");
  const h = harness({ intentId: "int_g", prepares: [{ preview: fresh, ack: "unknown" }] });
  const reasons = [];
  await executeIntent(h.client, graph("int_g"), h.signers, { preview: plan, onPreview: (_shown, _step, context) => { reasons.push(context.reason); return context.reason !== "unacknowledged"; } });
  assert.deepEqual(reasons, ["before-prepare", "unacknowledged"]);
  assert.equal(h.sends(), 0);
});

test("a matched ack is not trusted blindly: a locally worse preview asks again", async () => {
  const plan = await preview("int_h");
  const worse = await preview("int_h", "-9000000");
  const h = harness({ intentId: "int_h", prepares: [{ preview: worse, ack: "matched" }] });
  const reasons = [];
  await executeIntent(h.client, graph("int_h"), h.signers, { preview: plan, onPreview: (_shown, _step, context) => { reasons.push([context.reason, context.changes.length > 0]); return context.reason === "before-prepare"; } });
  assert.deepEqual(reasons, [["before-prepare", false], ["prepared", true]]);
  assert.equal(h.sends(), 0);
});

test("without a preview to show first, the prepared preview is asked for; the last kept preview is read when none is passed", async () => {
  const stored = await preview("int_i");
  const h = harness({ intentId: "int_i", prepares: [{ preview: stored, ack: "matched" }], stored });
  let asked = 0;
  await executeIntent(h.client, graph("int_i"), h.signers, { onPreview: () => { asked += 1; return true; } });
  assert.equal(asked, 1, "the stored preview is asked once; the matched payload is not asked again");
  assert.ok(h.calls.some((call) => call.method === "GET" && call.path === "/v1/intents/int_i/preview"));
  assert.equal(h.sends(), 1);
});

test("refuses tampered previews and previews of another payload", async () => {
  const plan = await preview("int_j");
  const tampered = { ...(await preview("int_j", "-1")), digest: plan.digest };
  const h = harness({ intentId: "int_j", prepares: [{ preview: tampered, ack: "matched" }] });
  await assert.rejects(executeIntent(h.client, graph("int_j"), h.signers, { preview: plan, onPreview: () => true }), (error) => error instanceof KletiaExecutionError && /digest/u.test(error.message));
  assert.equal(h.sends(), 0);
  const other = harness({ intentId: "int_j", prepares: [{ preview: plan, ack: "matched", binding: "another" }] });
  await assert.rejects(executeIntent(other.client, graph("int_j"), other.signers, { preview: plan, onPreview: () => true }), (error) => error instanceof KletiaExecutionError && /quote binding/u.test(error.message));
  assert.equal(other.sends(), 0);
});

test("without onPreview, a blocking preview issue refuses the step; warnings proceed", async () => {
  const plan = await preview("int_k");
  const blocked = harness({ intentId: "int_k", prepares: [{ preview: plan, issues: [{ code: "INSUFFICIENT_BALANCE", severity: "block", message: "needs 5 USDC" }] }] });
  await assert.rejects(executeIntent(blocked.client, graph("int_k"), blocked.signers), (error) => error instanceof KletiaExecutionError && /INSUFFICIENT_BALANCE/u.test(error.message));
  assert.equal(blocked.sends(), 0);
  assert.equal(blocked.calls.find((call) => call.path.endsWith("/prepare")).body.acknowledgedPreview, undefined, "no ack without a hook");
  const warned = harness({ intentId: "int_k", prepares: [{ preview: plan, issues: [{ code: "PREVIEW_ALLOWANCE_LEFT", severity: "warn", message: "left 1" }] }] });
  const final = await executeIntent(warned.client, graph("int_k"), warned.signers);
  assert.equal(final.status, "completed");
  assert.equal(warned.sends(), 1);
});
