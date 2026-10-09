import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { base64UrlEncode, evmBindingView, evmQuoteBinding, receiptCommitment, receiptDigest, receiptJcs, receiptSigningInput } from "@kletia/core";
import { KletiaApiError, KletiaClient } from "../dist/index.js";
import {
  DEFAULT_REVERIFY_RPCS,
  decryptShareDisclosures,
  displayRpcUrl,
  fetchReceiptKeys,
  openShareUrl,
  parseShareUrl,
  reverifyReceipt,
  verifyEasEnvelope,
  verifyReceipt,
} from "../dist/receipts.js";

const vectors = JSON.parse(readFileSync(new URL("./fixtures/receipt-v1-vectors.json", import.meta.url), "utf8"));
const rpc = JSON.parse(readFileSync(new URL("./fixtures/receipt-anchor-rpc.json", import.meta.url), "utf8"));
const KEYS = vectors.key.jwks.keys;
const RECEIPT = vectors.receipt;
const RECEIPT_ID = RECEIPT.payload.receiptId;
const SHARE_ID = `rsh_${"ab".repeat(12)}`;
const BASE_TX = RECEIPT.disclosures["steps.s1.evidence"].value.anchors[0].tx;
const clone = (value) => structuredClone(value);

function jsonResponse(status, body, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/* --------------------------------------------------------- signing helpers */

async function vectorKey() {
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(vectors.key.seedHex, "hex")]);
  return crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
}

/** Replaces one step's evidence disclosure and re-signs the payload with the vectors' key. */
async function withEvidence(stepId, change) {
  const document = clone(RECEIPT);
  const path = `steps.${stepId}.evidence`;
  const disclosure = document.disclosures[path];
  disclosure.value = change(disclosure.value);
  const step = document.payload.steps.find((candidate) => candidate.id === stepId);
  step.commitments = { ...step.commitments, evidence: receiptCommitment(path, disclosure) };
  document.digest = await receiptDigest(document.payload);
  const signature = await crypto.subtle.sign({ name: "Ed25519" }, await vectorKey(), new TextEncoder().encode(receiptSigningInput(document.digest)));
  document.signature = { ...document.signature, value: base64UrlEncode(new Uint8Array(signature)) };
  return document;
}

/** Encrypts disclosures like the API (AES-256-GCM, AAD bound to the ids). */
function encryptShare(disclosures, receiptId = RECEIPT_ID, shareId = SHARE_ID) {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`kletia.receipt-share.v1:${receiptId}:${shareId}`, "utf8"));
  const body = Buffer.concat([cipher.update(receiptJcs({ receiptId, shareId, disclosures }), "utf8"), cipher.final()]);
  return { ciphertext: Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url"), key: key.toString("base64url") };
}

/* --------------------------------------------------------------- fake RPC */

const FINALIZED_BASE = { ...rpc.evm.eth_getBlockByNumber, number: "0x31f5000" };

/**
 * A fetch that answers JSON-RPC per host from the captured fixtures.
 * `behave(host, method, params)` may return { result }, { error }, { status },
 * { hang: true } or undefined (fixture answer).
 */
function rpcFetch(behave = () => undefined, log = []) {
  return async (url, init) => {
    const host = new URL(url).host;
    const request = JSON.parse(init.body);
    log.push({ host, method: request.method, params: request.params });
    const override = behave(host, request.method, request.params);
    if (override?.hang) {
      // Like an open socket, keep the event loop alive until the caller's timeout aborts.
      return new Promise((_resolve, reject) => {
        const alive = setTimeout(() => reject(new Error("test fetch never aborted")), 10_000);
        init.signal.addEventListener("abort", () => { clearTimeout(alive); reject(init.signal.reason); }, { once: true });
      });
    }
    if (override?.status) return new Response("busy", { status: override.status });
    if (override && "error" in override) return jsonResponse(200, { jsonrpc: "2.0", id: request.id, error: override.error });
    if (override && "result" in override) return jsonResponse(200, { jsonrpc: "2.0", id: request.id, result: override.result });
    const fixtures = { ...rpc.evm, ...rpc.svm };
    let result = null;
    if (request.method === "eth_getBlockByNumber") result = request.params[0] === "finalized" ? FINALIZED_BASE : rpc.evm.eth_getBlockByNumber;
    else if (request.method === "eth_call") result = `0x${"0".repeat(64)}`;
    else result = fixtures[request.method] ?? null;
    return jsonResponse(200, { jsonrpc: "2.0", id: request.id, result: clone(result) });
  };
}

const TWO_SOURCES = { base: ["https://one.example/rpc", "https://two.example/rpc"], solana: ["https://sol-one.example", "https://sol-two.example"] };

/* ------------------------------------------------------------- client routes */

test("receipts.get waits through 202 honouring retryAfterSeconds, then returns the receipt", async () => {
  const answers = [
    () => jsonResponse(202, { receipt: null, pending: { reason: "awaiting_finality", expectedBy: "2026-10-09T18:16:00Z", retryAfterSeconds: 1 } }, { "retry-after": "1" }),
    () => jsonResponse(409, { error: { code: "RECEIPT_NOT_READY", message: "running" } }, { "retry-after": "1" }),
    () => jsonResponse(200, { receipt: RECEIPT }),
  ];
  const calls = [];
  const client = new KletiaClient({ baseUrl: "http://localhost:3001", fetch: async (url) => { calls.push({ url, at: Date.now() }); return answers[calls.length - 1](); } });
  const pending = [];
  const started = Date.now();
  const result = await client.receipts.get("int_00112233445566778899aabbccddeeff", { wait: { timeoutMs: 20_000, onPending: (info) => pending.push(info.reason) } });
  assert.equal(result.receipt.digest, RECEIPT.digest);
  assert.equal(calls.length, 3);
  assert.deepEqual(pending, ["awaiting_finality", "not_ready"]);
  assert.ok(Date.now() - started >= 1_900, "waited about one second per pending answer");
  assert.match(calls[0].url, /\/v1\/intents\/int_00112233445566778899aabbccddeeff\/receipt$/u);
});

test("receipts.get without wait returns pending at once and does not retry RECEIPT_NOT_READY; wait times out with WAIT_TIMEOUT", async () => {
  let count = 0;
  const pendingClient = new KletiaClient({ baseUrl: "http://localhost:3001", fetch: async () => { count += 1; return jsonResponse(202, { receipt: null, pending: { reason: "queued", expectedBy: null, retryAfterSeconds: 30 } }); } });
  const result = await pendingClient.receipts.get("int_x", { sequence: 2 });
  assert.equal(result.receipt, null);
  assert.equal(result.pending.reason, "queued");
  let notReady = 0;
  const running = new KletiaClient({ baseUrl: "http://localhost:3001", retryBaseDelayMs: 1, fetch: async () => { notReady += 1; return jsonResponse(409, { error: { code: "RECEIPT_NOT_READY", message: "running" } }, { "retry-after": "60" }); } });
  await assert.rejects(running.receipts.get("int_x"), (error) => error instanceof KletiaApiError && error.code === "RECEIPT_NOT_READY");
  assert.equal(notReady, 1, "not retried by the transport");
  await assert.rejects(pendingClient.receipts.get("int_x", { wait: { timeoutMs: 50 } }), (error) => error.code === "WAIT_TIMEOUT");
  assert.ok(count >= 2);
});

test("receipt share, list, revoke, withdraw, keys and log routes; share creation carries an Idempotency-Key with a key", async () => {
  const calls = [];
  const client = new KletiaClient({
    baseUrl: "http://localhost:3001",
    apiKey: "kl_dev_test",
    fetch: async (url, init) => {
      const { pathname, search } = new URL(url);
      calls.push({ method: init.method, pathname, search, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
      const route = `${init.method} ${pathname}`;
      if (route === "POST /v1/intents/int_s/receipt/shares") return jsonResponse(201, { share: { id: SHARE_ID, receiptId: RECEIPT_ID, sequence: 1, groups: [], expiresAt: null, createdAt: "x", url: `https://kletiaai.xyz/r/${RECEIPT_ID}#s=${SHARE_ID}&k=${"k".repeat(43)}` } });
      if (route === "GET /v1/intents/int_s/receipt/shares") return jsonResponse(200, { shares: [{ id: SHARE_ID, receiptId: RECEIPT_ID, sequence: 1, groups: [], expiresAt: null, createdAt: "x" }] });
      if (route === `DELETE /v1/intents/int_s/receipt/shares/${SHARE_ID}` || route === "DELETE /v1/intents/int_s/receipt/disclosures") return new Response(null, { status: 204 });
      if (route === "GET /v1/intents/int_s/receipts") return jsonResponse(200, { receipts: [{ receiptId: RECEIPT_ID, sequence: 1 }] });
      if (route === "GET /v1/receipts/keys") return jsonResponse(200, { keys: KEYS, attesters: [] });
      if (route === "GET /v1/receipts/log") return jsonResponse(200, { batches: [{ seq: 1 }] });
      if (route === "GET /v1/receipts/log/1") return jsonResponse(200, { batch: { seq: 1 }, leaves: { offset: 0, limit: 10, total: 3, items: vectors.merkle.leaves } });
      if (route === "GET /v1/receipts/log/inclusion") return jsonResponse(200, { inclusion: { leafIndex: 2 } });
      throw new Error(`unexpected ${route}`);
    },
  });
  const { share } = await client.receipts.share("int_s", { profile: "proof", expiresInSeconds: 7 * 86_400 });
  assert.equal(share.id, SHARE_ID);
  assert.deepEqual(calls[0].body, { profile: "proof", expiresInSeconds: 604_800 });
  assert.match(calls[0].headers["idempotency-key"], /^[0-9a-f-]{36}$/u);
  assert.equal((await client.receipts.shares("int_s")).length, 1);
  await client.receipts.unshare("int_s", SHARE_ID);
  await client.receipts.withdraw("int_s");
  assert.equal((await client.receipts.list("int_s"))[0].sequence, 1);
  assert.equal((await client.receipts.keys()).keys[0].kid, vectors.key.kid);
  await client.receipts.log({ unanchored: true, limit: 5 });
  assert.equal(calls.at(-1).search, "?limit=5&unanchored=true");
  assert.equal((await client.receipts.batch(1, { leaves: true, limit: 10 })).leaves.total, 3);
  await client.receipts.inclusion(RECEIPT.digest);
  assert.equal(calls.at(-1).search, `?digest=${RECEIPT.digest}`);
  await assert.rejects(client.receipts.unshare("int_s", "rsh_bad"), TypeError);
  await assert.rejects(client.receipts.inclusion("XYZ"), TypeError);
});

/* -------------------------------------------------------------------- keys */

test("fetchReceiptKeys trusts only keys both origins list identically", async () => {
  const other = { ...KEYS[0], x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", kid: "unused" };
  const fetch = async (url) => {
    if (url === "http://localhost:3001/v1/receipts/keys") return jsonResponse(200, { keys: [KEYS[0], other], attesters: [] });
    if (url === "https://web.example/.well-known/kletia-receipt-keys.json") return jsonResponse(200, { keys: [{ ...KEYS[0], status: "revoked", revokedOn: "2026-10-05" }] });
    return jsonResponse(404, {});
  };
  const result = await fetchReceiptKeys({ baseUrl: "http://localhost:3001", webOrigin: "https://web.example", fetch });
  assert.equal(result.keys.length, 1, "a key whose kid is not its thumbprint, or listed once, is dropped");
  assert.equal(result.keys[0].status, "revoked", "the stricter status wins");
  assert.equal(result.keys[0].revokedOn, "2026-10-05");
  const missing = await fetchReceiptKeys({ baseUrl: "http://localhost:3001", webOrigin: "https://nowhere.example", fetch });
  assert.deepEqual(missing.keys, []);
  assert.match(missing.errors[0], /web mirror/u);
});

/* ------------------------------------------------------------------ shares */

test("parseShareUrl reads only the fragment and refuses query keys", () => {
  const key = "A".repeat(43);
  assert.deepEqual(parseShareUrl(`https://kletiaai.xyz/r/${RECEIPT_ID}#s=${SHARE_ID}&k=${key}`), { receiptId: RECEIPT_ID, shareId: SHARE_ID, key });
  assert.equal(parseShareUrl(`https://kletiaai.xyz/r/${RECEIPT_ID}?k=${key}#s=${SHARE_ID}&k=${key}`), null);
  assert.equal(parseShareUrl(`http://kletiaai.xyz/r/${RECEIPT_ID}#s=${SHARE_ID}&k=${key}`), null, "plain http only on localhost");
  assert.equal(parseShareUrl(`https://kletiaai.xyz/r/rcpt_x#s=${SHARE_ID}&k=${key}`), null);
});

function shareApi(sealed) {
  const { disclosures, ...signed } = RECEIPT;
  return async (url) => {
    const { pathname } = new URL(url);
    if (pathname === `/v1/receipts/${RECEIPT_ID}`) return jsonResponse(200, { receipt: signed });
    if (pathname === `/v1/receipts/${RECEIPT_ID}/shares/${SHARE_ID}`) return jsonResponse(200, { ciphertext: sealed.ciphertext, alg: "A256GCM", groups: Object.keys(disclosures), expiresAt: null });
    if (pathname === "/v1/receipts/keys") return jsonResponse(200, { keys: KEYS });
    if (pathname === "/.well-known/kletia-receipt-keys.json") return jsonResponse(200, { keys: KEYS });
    return jsonResponse(404, { error: { code: "RECEIPT_SHARE_NOT_FOUND", message: "unknown" } });
  };
}

test("openShareUrl decrypts the vector share locally and verifies it; a tampered ciphertext or key is SHARE_DECRYPT_FAILED", async () => {
  const sealed = encryptShare(RECEIPT.disclosures);
  const url = `https://kletiaai.xyz/r/${RECEIPT_ID}#s=${SHARE_ID}&k=${sealed.key}`;
  const opened = await openShareUrl(url, { baseUrl: "http://localhost:3001", webOrigin: "http://localhost:3001", fetch: shareApi(sealed) });
  assert.equal(opened.verification.valid, true, JSON.stringify(opened.verification.problems));
  assert.equal(opened.keySource, "api+web");
  assert.equal(opened.verification.disclosed.length, 10);
  assert.equal(JSON.stringify(opened).includes(vectors.intentId), false, "a share never carries the intent id");
  const supplied = await openShareUrl(url, { baseUrl: "http://localhost:3001", keys: KEYS, fetch: shareApi(sealed) });
  assert.equal(supplied.keySource, "supplied");
  assert.equal(supplied.verification.valid, true);

  const raw = Buffer.from(sealed.ciphertext, "base64url");
  raw[raw.length - 20] ^= 1;
  const tampered = { ...sealed, ciphertext: raw.toString("base64url") };
  const broken = await openShareUrl(url, { baseUrl: "http://localhost:3001", keys: KEYS, fetch: shareApi(tampered) });
  assert.equal(broken.verification.valid, false);
  assert.equal(broken.verification.problems[0].code, "SHARE_DECRYPT_FAILED");
  const wrongKey = await openShareUrl(`https://kletiaai.xyz/r/${RECEIPT_ID}#s=${SHARE_ID}&k=${"B".repeat(43)}`, { baseUrl: "http://localhost:3001", keys: KEYS, fetch: shareApi(sealed) });
  assert.equal(wrongKey.verification.problems[0].code, "SHARE_DECRYPT_FAILED");
  assert.equal(await decryptShareDisclosures(RECEIPT_ID, `rsh_${"cd".repeat(12)}`, sealed.ciphertext, sealed.key), null, "the AAD binds the ids");
  await assert.rejects(openShareUrl(url.replace(SHARE_ID, `rsh_${"ef".repeat(12)}`), { baseUrl: "http://localhost:3001", keys: KEYS, fetch: shareApi(sealed) }), (error) => error instanceof KletiaApiError && error.status === 404);
});

test("openShareUrl without trusted keys fails closed with KEY_UNKNOWN", async () => {
  const sealed = encryptShare(RECEIPT.disclosures);
  const api = shareApi(sealed);
  const fetch = async (url, init) => (url.includes(".well-known") ? jsonResponse(404, {}) : api(url, init));
  const opened = await openShareUrl(`https://kletiaai.xyz/r/${RECEIPT_ID}#s=${SHARE_ID}&k=${sealed.key}`, { baseUrl: "http://localhost:3001", webOrigin: "https://kletiaai.xyz", fetch });
  assert.equal(opened.verification.valid, false);
  assert.equal(opened.verification.problems[0].code, "KEY_UNKNOWN");
  assert.ok(opened.notes.some((note) => /web mirror/u.test(note)));
});

/* ----------------------------------------------------------------- reverify */

test("reverifyReceipt: both anchors match on two sources each and are finalized: verified", async () => {
  const log = [];
  const report = await reverifyReceipt(RECEIPT, { keys: KEYS, rpcs: TWO_SOURCES, fetch: rpcFetch(undefined, log) });
  assert.equal(report.verdict, "verified", JSON.stringify(report, null, 1).slice(0, 2000));
  assert.equal(report.anchors.length, 2);
  for (const anchor of report.anchors) {
    assert.equal(anchor.result, "match");
    assert.equal(anchor.finalized, true);
    assert.deepEqual(anchor.sources.map((source) => source.result), ["match", "match"]);
  }
  assert.equal(report.singleSource, false);
  assert.deepEqual(report.bindings.map((binding) => binding.result), ["not_applicable", "not_applicable"]);
  assert.ok(log.every((entry) => ["eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getBlockByNumber", "getTransaction", "getBlock"].includes(entry.method)), "read-only calls only");
  assert.ok(log.some((entry) => entry.method === "getTransaction" && entry.params[1].maxSupportedTransactionVersion === 1));
});

test("reverifyReceipt: a source returning different data is a mismatch; disagreeing sources are a conflict", async () => {
  const tamper = (host, method) => (method === "eth_getTransactionReceipt" ? { result: { ...rpc.evm.eth_getTransactionReceipt, status: "0x0" } } : undefined);
  const both = await reverifyReceipt(RECEIPT, { keys: KEYS, rpcs: TWO_SOURCES, fetch: rpcFetch(tamper) });
  assert.equal(both.verdict, "mismatch");
  const base = both.anchors.find((anchor) => anchor.chain === "eip155:8453");
  assert.equal(base.result, "mismatch");
  assert.deepEqual(base.mismatched, ["status"]);
  const one = await reverifyReceipt(RECEIPT, { keys: KEYS, rpcs: TWO_SOURCES, fetch: rpcFetch((host, method) => (host === "two.example" ? tamper(host, method) : undefined)) });
  assert.equal(one.anchors.find((anchor) => anchor.chain === "eip155:8453").result, "conflict");
  assert.equal(one.verdict, "inconclusive");
});

test("reverifyReceipt: null, -32015, archive errors, HTTP errors and timeouts are unavailable, never a mismatch", async () => {
  const cases = [
    (host, method) => (method === "eth_getTransactionReceipt" ? { result: null } : undefined),
    (host, method) => (method === "eth_getTransactionReceipt" ? { error: { code: -32000, message: "Archive requests require a personal token" } } : undefined),
    () => ({ status: 429 }),
    () => ({ hang: true }),
  ];
  for (const behave of cases) {
    const report = await reverifyReceipt(RECEIPT, { keys: KEYS, rpcs: { base: TWO_SOURCES.base }, fetch: rpcFetch(behave), timeoutMs: 100, checkFinality: false });
    const base = report.anchors.find((anchor) => anchor.chain === "eip155:8453");
    assert.equal(base.result, "unavailable");
    assert.ok(base.sources.every((source) => source.result === "unavailable"));
    assert.notEqual(report.verdict, "mismatch");
  }
  const old = await reverifyReceipt(RECEIPT, { keys: KEYS, rpcs: TWO_SOURCES, fetch: rpcFetch((host, method) => (method === "getTransaction" ? { error: rpc.svm["getTransaction@v0"] } : undefined)) });
  const solana = old.anchors.find((anchor) => anchor.chain.startsWith("solana:"));
  assert.equal(solana.result, "unavailable");
  assert.match(solana.sources[0].detail, /client_too_old/u);
  assert.equal(old.verdict, "inconclusive");
});

test("reverifyReceipt: quorum rules and the single-source warning", async () => {
  const downTwo = (host) => (host === "two.example" ? { status: 503 } : undefined);
  const strict = await reverifyReceipt(RECEIPT, { keys: KEYS, rpcs: TWO_SOURCES, fetch: rpcFetch(downTwo) });
  assert.equal(strict.anchors.find((anchor) => anchor.chain === "eip155:8453").result, "unavailable", "one match does not meet quorum 2");
  assert.equal(strict.singleSource, true);
  assert.equal(strict.verdict, "inconclusive");
  const relaxed = await reverifyReceipt(RECEIPT, { keys: KEYS, rpcs: TWO_SOURCES, quorum: 1, fetch: rpcFetch(downTwo) });
  assert.equal(relaxed.verdict, "verified");
  const single = await reverifyReceipt(RECEIPT, { keys: KEYS, rpcs: { base: ["https://one.example/rpc"], solana: ["https://sol-one.example"] }, fetch: rpcFetch() });
  assert.equal(single.verdict, "verified", "one configured endpoint: quorum 1");
  assert.equal(single.singleSource, true);
  assert.ok(single.warnings.some((warning) => warning.code === "SINGLE_SOURCE"));
});

test("reverifyReceipt: an anchor above the finalized head is not_finalized", async () => {
  const report = await reverifyReceipt(RECEIPT, {
    keys: KEYS,
    rpcs: TWO_SOURCES,
    fetch: rpcFetch((host, method, params) => (method === "eth_getBlockByNumber" && params[0] === "finalized" ? { result: { ...FINALIZED_BASE, number: "0x100" } } : undefined)),
  });
  assert.equal(report.anchors.find((anchor) => anchor.chain === "eip155:8453").result, "not_finalized");
  assert.equal(report.verdict, "inconclusive");
});

test("reverifyReceipt: the landed EVM binding is rebuilt from the transaction; another binding is a mismatch", async () => {
  const tx = rpc.evm.eth_getTransactionByHash;
  const truth = await evmQuoteBinding([evmBindingView({ chainId: 8453, from: tx.from, to: tx.to, data: tx.input, value: tx.value })]);
  const matching = await withEvidence("s1", (evidence) => ({ ...evidence, quotes: [{ binding: truth, preparedAt: "2026-10-09T09:00:00.000Z" }], landedBinding: truth }));
  const good = await reverifyReceipt(matching, { keys: KEYS, rpcs: TWO_SOURCES, fetch: rpcFetch() });
  assert.equal(good.offline.valid, true, JSON.stringify(good.offline.problems));
  assert.deepEqual(good.bindings.find((binding) => binding.step === "s1"), { step: "s1", result: "match" });
  assert.equal(good.verdict, "verified");
  const other = "f".repeat(64);
  const lying = await withEvidence("s1", (evidence) => ({ ...evidence, quotes: [{ binding: other, preparedAt: "2026-10-09T09:00:00.000Z" }], landedBinding: other }));
  const bad = await reverifyReceipt(lying, { keys: KEYS, rpcs: TWO_SOURCES, fetch: rpcFetch() });
  assert.equal(bad.bindings.find((binding) => binding.step === "s1").result, "mismatch");
  assert.equal(bad.verdict, "mismatch");
});

test("reverifyReceipt: sealed evidence is inconclusive; an invalid receipt is a mismatch before any RPC call", async () => {
  const { "steps.s2.evidence": _sealed, ...rest } = RECEIPT.disclosures;
  const sealed = await reverifyReceipt({ ...RECEIPT, disclosures: rest }, { keys: KEYS, rpcs: TWO_SOURCES, fetch: rpcFetch() });
  assert.deepEqual(sealed.sealedSteps, ["s2"]);
  assert.equal(sealed.verdict, "inconclusive");
  const log = [];
  const forged = clone(RECEIPT);
  forged.disclosures["steps.s1.amounts"].value.input.amount = "1";
  const invalid = await reverifyReceipt(forged, { keys: KEYS, rpcs: TWO_SOURCES, fetch: rpcFetch(undefined, log) });
  assert.equal(invalid.verdict, "mismatch");
  assert.equal(invalid.offline.problems[0].code, "DISCLOSURE_MISMATCH");
  assert.equal(log.length, 0);
});

test("reverifyReceipt: anchoring reads EAS.getTimestamp(batchDigest) on Base, zero and non-zero", async () => {
  const inclusion = { batch: vectors.log.batch, batchSignature: vectors.log.signature, leafIndex: 2, path: vectors.merkle.inclusion.path, anchor: null };
  const withInclusion = { ...RECEIPT, inclusion };
  const calls = [];
  const zero = await reverifyReceipt(withInclusion, { keys: KEYS, rpcs: TWO_SOURCES, fetch: rpcFetch(undefined, calls) });
  assert.deepEqual(zero.anchoring, { batchDigest: vectors.log.batchDigest, timestamp: 0, result: "not_anchored", claimed: null });
  const call = calls.find((entry) => entry.method === "eth_call");
  assert.equal(call.params[0].to, "0x4200000000000000000000000000000000000021");
  assert.equal(call.params[0].data, `0xd45c4435${vectors.log.batchDigest}`);
  const stamped = await reverifyReceipt(withInclusion, { keys: KEYS, rpcs: TWO_SOURCES, fetch: rpcFetch((host, method) => (method === "eth_call" ? { result: `0x${(1791550000).toString(16).padStart(64, "0")}` } : undefined)) });
  assert.equal(stamped.anchoring.result, "anchored");
  assert.equal(stamped.anchoring.timestamp, 1791550000);
  assert.equal(stamped.verdict, "verified");
});

test("reverifyReceipt reports RPC URLs without query strings or long path tokens", () => {
  assert.equal(displayRpcUrl("https://base-mainnet.g.alchemy.com/v2/abcdefghijklmnopqrstuvwx?key=secret"), "https://base-mainnet.g.alchemy.com/v2/…");
  assert.equal(displayRpcUrl("https://sepolia-rollup.arbitrum.io/rpc"), "https://sepolia-rollup.arbitrum.io/rpc");
  assert.deepEqual(DEFAULT_REVERIFY_RPCS.base, ["https://mainnet.base.org", "https://base.drpc.org"]);
  assert.equal(Object.values(DEFAULT_REVERIFY_RPCS).flat().some((url) => url.includes("cloudflare-eth")), false);
});

/* ---------------------------------------------------------------------- EAS */

async function easEnvelope(document, mutate = (message) => message) {
  const { privateKeyToAccount } = await import("viem/accounts");
  const viem = await import("viem");
  const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
  const schema = viem.keccak256(viem.encodePacked(["string", "address", "bool"], ["bytes32 receiptDigest,string spec,uint32 sequence", viem.zeroAddress, true]));
  const data = viem.encodeAbiParameters(viem.parseAbiParameters("bytes32, string, uint32"), [`0x${document.digest}`, document.payload.spec, document.payload.sequence]);
  const message = mutate({ version: 2, schema, recipient: viem.zeroAddress, time: 1791550300n, expirationTime: 0n, revocable: true, refUID: viem.zeroHash, data, salt: `0x${"22".repeat(32)}` });
  const domain = { name: "EAS Attestation", version: "1.0.1", chainId: 8453, verifyingContract: "0x4200000000000000000000000000000000000021" };
  const types = { Attest: [["version", "uint16"], ["schema", "bytes32"], ["recipient", "address"], ["time", "uint64"], ["expirationTime", "uint64"], ["revocable", "bool"], ["refUID", "bytes32"], ["data", "bytes"], ["salt", "bytes32"]].map(([name, type]) => ({ name, type })) };
  const signature = await account.signTypedData({ domain, types, primaryType: "Attest", message });
  const uid = viem.keccak256(viem.encodePacked(
    ["uint16", "bytes", "address", "address", "uint64", "uint64", "bool", "bytes32", "bytes", "bytes32", "uint32"],
    [2, viem.toHex(viem.stringToBytes(message.schema)), message.recipient, viem.zeroAddress, message.time, 0n, true, message.refUID, message.data, message.salt, 0],
  ));
  return {
    signer: account.address,
    sig: { domain, primaryType: "Attest", types, message: { ...message, time: message.time.toString(), expirationTime: "0" }, uid, signature: { r: signature.slice(0, 66), s: `0x${signature.slice(66, 130)}`, v: Number.parseInt(signature.slice(130, 132), 16) } },
  };
}

test("verifyEasEnvelope checks the domain, schema, attested digest, UID and signature offline (viem)", async () => {
  const envelope = await easEnvelope(RECEIPT);
  const good = await verifyEasEnvelope({ ...RECEIPT, attestations: { eas: envelope } });
  assert.equal(good.valid, true, good.problems.join("; "));
  assert.equal(good.recipient, "0x0000000000000000000000000000000000000000");
  const otherChain = { ...envelope, sig: { ...envelope.sig, domain: { ...envelope.sig.domain, chainId: 1 } } };
  assert.equal((await verifyEasEnvelope({ ...RECEIPT, attestations: { eas: otherChain } })).valid, false);
  const otherReceipt = await easEnvelope({ ...RECEIPT, digest: "0".repeat(64) });
  const wrong = await verifyEasEnvelope({ ...RECEIPT, attestations: { eas: otherReceipt } });
  assert.equal(wrong.valid, false);
  assert.ok(wrong.problems.some((problem) => /another receipt/u.test(problem)));
  const forgedUid = { ...envelope, sig: { ...envelope.sig, uid: `0x${"33".repeat(32)}` } };
  assert.equal((await verifyEasEnvelope({ ...RECEIPT, attestations: { eas: forgedUid } })).valid, false);
  assert.equal((await verifyEasEnvelope(RECEIPT)).valid, false, "no envelope");
});

test("verifyReceipt is re-exported from the receipts subpath", async () => {
  const result = await verifyReceipt(RECEIPT, { keys: KEYS, intentId: vectors.intentId });
  assert.equal(result.valid, true);
  assert.equal(result.intentMatches, true);
});

test("live (KLETIA_LIVE=1): the vectors' real anchors re-verify against the default public endpoints", { skip: process.env.KLETIA_LIVE !== "1" }, async () => {
  const report = await reverifyReceipt(RECEIPT, { keys: KEYS, quorum: 2, timeoutMs: 20_000 });
  for (const anchor of report.anchors) assert.notEqual(anchor.result, "mismatch", JSON.stringify(anchor));
  assert.ok(report.anchors.every((anchor) => anchor.result === "match"), JSON.stringify(report.anchors, null, 1));
  assert.equal(report.verdict, "verified");
});
