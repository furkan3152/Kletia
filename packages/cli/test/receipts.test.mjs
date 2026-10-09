import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { receiptJcs } from "@kletia/core";
import { cli, send, stubServer } from "./helpers.mjs";

const vectors = JSON.parse(await readFile(new URL("./fixtures/receipt-v1-vectors.json", import.meta.url), "utf8"));
const rpc = JSON.parse(await readFile(new URL("./fixtures/receipt-anchor-rpc.json", import.meta.url), "utf8"));
const RECEIPT = vectors.receipt;
const RECEIPT_ID = RECEIPT.payload.receiptId;
const KEYS = vectors.key.jwks.keys;
const INTENT = "int_00112233445566778899aabbccddeeff";
const SHARE_ID = `rsh_${"ab".repeat(12)}`;
const API_KEY = "kl_dev_abcdefghijklmnopqrstuvwxyz012345";
const clone = (value) => structuredClone(value);

function encrypt(disclosures) {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`kletia.receipt-share.v1:${RECEIPT_ID}:${SHARE_ID}`, "utf8"));
  const body = Buffer.concat([cipher.update(receiptJcs({ receiptId: RECEIPT_ID, shareId: SHARE_ID, disclosures }), "utf8"), cipher.final()]);
  return { ciphertext: Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url"), key: key.toString("base64url") };
}
const SEALED = encrypt(RECEIPT.disclosures);
const SHARE_URL = `https://kletiaai.xyz/r/${RECEIPT_ID}#s=${SHARE_ID}&k=${SEALED.key}`;

/** RPC behaviour per endpoint name (rpc1, rpc2, sol1, sol2): undefined = fixture. */
const rpcMode = new Map();
let pendingReads = 0;

let api;
let dir;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "kletia-cli-receipts-"));
  api = await stubServer(async (request, res) => {
    const route = `${request.method} ${request.path}`;
    if (request.path.startsWith("/rpc/")) {
      const name = request.path.slice(5);
      const call = request.body;
      const mode = rpcMode.get(name);
      if (mode === "down") return send(res, 503, "busy");
      let result = null;
      if (call.method === "eth_getBlockByNumber") result = call.params[0] === "finalized" ? { ...rpc.evm.eth_getBlockByNumber, number: "0x31f5000" } : rpc.evm.eth_getBlockByNumber;
      else if (call.method === "eth_getTransactionReceipt") result = mode === "tamper" ? { ...rpc.evm.eth_getTransactionReceipt, status: "0x0" } : rpc.evm.eth_getTransactionReceipt;
      else result = { ...rpc.evm, ...rpc.svm }[call.method] ?? null;
      return send(res, 200, { jsonrpc: "2.0", id: call.id, result: clone(result) });
    }
    if (route === "GET /v1/receipts/keys") return send(res, 200, { keys: KEYS, attesters: [] });
    if (route === "GET /.well-known/kletia-receipt-keys.json") return send(res, 404, {});
    if (route === `GET /v1/receipts/${RECEIPT_ID}`) {
      const { disclosures, ...signed } = RECEIPT;
      return send(res, 200, { receipt: signed });
    }
    if (route === `GET /v1/receipts/${RECEIPT_ID}/shares/${SHARE_ID}`) return send(res, 200, { ciphertext: SEALED.ciphertext, alg: "A256GCM", groups: Object.keys(RECEIPT.disclosures), expiresAt: null });
    if (route === `GET /v1/intents/${INTENT}/receipt`) {
      if (pendingReads > 0) {
        pendingReads -= 1;
        return send(res, 202, { receipt: null, pending: { reason: "awaiting_finality", expectedBy: "2026-10-09T18:16:00Z", retryAfterSeconds: 1 } }, { "retry-after": "1" });
      }
      return send(res, 200, { receipt: RECEIPT });
    }
    if (route === "GET /v1/intents/int_pending/receipt") return send(res, 202, { receipt: null, pending: { reason: "awaiting_finality", expectedBy: "2026-10-09T18:16:00Z", retryAfterSeconds: 950 } });
    if (route === `POST /v1/intents/${INTENT}/receipt/shares`) {
      return send(res, 201, { share: { id: SHARE_ID, receiptId: RECEIPT_ID, sequence: 1, groups: ["intent.outcome"], expiresAt: "2026-10-16T18:00:00.000Z", createdAt: "x", url: SHARE_URL } });
    }
    if (route === `GET /v1/intents/${INTENT}/receipt/shares`) return send(res, 200, { shares: [{ id: SHARE_ID, receiptId: RECEIPT_ID, sequence: 1, groups: [], expiresAt: null, createdAt: "x" }] });
    if (route === `DELETE /v1/intents/${INTENT}/receipt/shares/${SHARE_ID}`) return send(res, 204);
    if (route === "GET /v1/receipts/log") return send(res, 200, { batches: [{ seq: 1, batch: vectors.log.batch, batchDigest: vectors.log.batchDigest, signature: vectors.log.signature, anchor: null, closedAt: "x" }] });
    return false;
  });
});

after(() => api.close());

async function receiptFile(document = RECEIPT, name = `receipt-${Math.random().toString(36).slice(2)}.json`) {
  const path = join(dir, name);
  await writeFile(path, JSON.stringify({ receipt: document }));
  return path;
}

async function keysFile() {
  const path = join(dir, `keys-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(path, JSON.stringify({ keys: KEYS }));
  return path;
}

const noNetwork = async (url) => {
  throw new Error(`no network expected, got ${url}`);
};

test("receipt verify <file> is offline: VALID with trusted keys (exit 0), KEY_UNKNOWN without (exit 3)", async () => {
  const file = await receiptFile();
  const ok = await cli(["receipt", "verify", file, "--keys", await keysFile(), "--intent", vectors.intentId], { fetch: noNetwork });
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /^VALID: key active \(supplied, keys supplied\)$/mu);
  assert.match(ok.stdout, /intent id matches/u);
  assert.match(ok.stdout, /disclosed 10 groups, sealed 0/u);
  const none = await cli(["receipt", "verify", file], { fetch: noNetwork });
  assert.equal(none.code, 3);
  assert.match(none.stdout, /problem KEY_UNKNOWN/u);
  assert.match(none.stdout, /pass --keys/u);
  const json = await cli(["receipt", "verify", file, "--keys", await keysFile(), "--json"], { fetch: noNetwork });
  assert.equal(JSON.parse(json.stdout).verification.valid, true);
});

test("receipt verify: a tampered receipt is invalid (exit 3), a wrong intent id too", async () => {
  const forged = clone(RECEIPT);
  forged.disclosures["steps.s1.amounts"].value.input.amount = "1";
  const bad = await cli(["receipt", "verify", await receiptFile(forged), "--keys", await keysFile()], { fetch: noNetwork });
  assert.equal(bad.code, 3);
  assert.match(bad.stdout, /DISCLOSURE_MISMATCH/u);
  const other = await cli(["receipt", "verify", await receiptFile(), "--keys", await keysFile(), "--intent", "int_ffffffffffffffffffffffffffffffff"], { fetch: noNetwork });
  assert.equal(other.code, 3);
  assert.match(other.stdout, /INTENT_REF_MISMATCH/u);
});

test("receipt verify <share url> fetches, decrypts locally and never prints the link key", async () => {
  const result = await cli(["receipt", "verify", SHARE_URL, "--keys", `${api.base}/v1/receipts/keys`], { base: api.base });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^VALID/mu);
  assert.equal((result.stdout + result.stderr).includes(SEALED.key), false);
  const wrong = await cli(["receipt", "verify", SHARE_URL.replace(/k=.*/u, `k=${"A".repeat(43)}`), "--keys", `${api.base}/v1/receipts/keys`], { base: api.base });
  assert.equal(wrong.code, 3);
  assert.match(wrong.stdout, /SHARE_DECRYPT_FAILED/u);
  // Without --keys the API set alone is not trusted (the web mirror does not list it).
  const untrusted = await cli(["receipt", "verify", SHARE_URL], { base: api.base });
  assert.equal(untrusted.code, 3);
  assert.match(untrusted.stdout, /KEY_UNKNOWN/u);
});

test("receipt reverify: exit 0 verified on two sources, 4 on a mismatch, 5 when sources are down, 3 when invalid offline", async () => {
  const file = await receiptFile();
  const rpcs = ["--rpc", `base=${api.base}/rpc/rpc1`, "--rpc", `base=${api.base}/rpc/rpc2`, "--rpc", `solana=${api.base}/rpc/sol1`, "--rpc", `solana=${api.base}/rpc/sol2`, "--keys", await keysFile()];
  rpcMode.clear();
  const ok = await cli(["receipt", "reverify", file, ...rpcs], { base: api.base });
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /VERDICT VERIFIED/u);
  assert.match(ok.stdout, /s1\s+origin\s+eip155:8453\s+0xa8606b8a…d21db0\s+match\s+finalized/u);
  rpcMode.set("rpc1", "tamper");
  rpcMode.set("rpc2", "tamper");
  const mismatch = await cli(["receipt", "reverify", file, ...rpcs], { base: api.base });
  assert.equal(mismatch.code, 4);
  assert.match(mismatch.stdout, /VERDICT MISMATCH/u);
  rpcMode.set("rpc2", "fixture");
  const conflict = await cli(["receipt", "reverify", file, ...rpcs], { base: api.base });
  assert.equal(conflict.code, 4, "conflicting sources exit 4");
  rpcMode.set("rpc1", "down");
  rpcMode.set("rpc2", "down");
  const down = await cli(["receipt", "reverify", file, ...rpcs, "--json"], { base: api.base });
  assert.equal(down.code, 5);
  assert.equal(JSON.parse(down.stdout).verdict, "inconclusive");
  rpcMode.clear();
  const forged = clone(RECEIPT);
  forged.digest = "0".repeat(64);
  const invalid = await cli(["receipt", "reverify", await receiptFile(forged), ...rpcs], { base: api.base });
  assert.equal(invalid.code, 3);
  const badRpc = await cli(["receipt", "reverify", file, "--rpc", "base=http://example.com/rpc"], { base: api.base });
  assert.equal(badRpc.code, 64, "plain http only for localhost");
});

test("receipt share prints the link once: refused on a terminal without --reveal or --out; --out writes it mode 600", async () => {
  const refused = await cli(["receipt", "share", INTENT, "--profile", "amounts"], { base: api.base, env: { KLETIA_API_KEY: API_KEY }, tty: true });
  assert.equal(refused.code, 64);
  assert.equal(api.requests.some((request) => request.method === "POST" && request.path.endsWith("/receipt/shares")), false, "decided before the call");
  const shown = await cli(["receipt", "share", INTENT, "--profile", "proof", "--expires", "7d", "--reveal"], { base: api.base, env: { KLETIA_API_KEY: API_KEY }, tty: true });
  assert.equal(shown.code, 0, shown.stderr);
  assert.equal(shown.stdout.trim(), SHARE_URL, "the link, unredacted, once");
  assert.deepEqual(api.requests.at(-1).body, { profile: "proof", expiresInSeconds: 604_800 });
  assert.match(shown.stderr, /kletia receipt unshare/u);
  const out = join(dir, "share-link.txt");
  const filed = await cli(["receipt", "share", INTENT, "--groups", "intent.outcome", "--out", out, "--json"], { base: api.base, env: { KLETIA_API_KEY: API_KEY } });
  assert.equal(filed.code, 0, filed.stderr);
  assert.equal((await readFile(out, "utf8")).trim(), SHARE_URL);
  assert.equal((await stat(out)).mode & 0o777, 0o600);
  assert.equal(filed.stdout.includes(SEALED.key), false);
  assert.equal(JSON.parse(filed.stdout).id, SHARE_ID);
  const both = await cli(["receipt", "share", INTENT, "--profile", "full", "--groups", "intent.outcome", "--reveal"], { base: api.base });
  assert.equal(both.code, 64);
});

test("receipt get waits for a pending receipt and writes --out; a pending receipt exits 5", async () => {
  pendingReads = 1;
  const out = join(dir, "got.json");
  const got = await cli(["receipt", "get", INTENT, "--wait", "30", "--out", out], { base: api.base });
  assert.equal(got.code, 0, got.stderr);
  assert.match(got.stderr, /Pending \(awaiting_finality\)/u);
  assert.equal(JSON.parse(await readFile(out, "utf8")).receipt.digest, RECEIPT.digest);
  assert.equal((await stat(out)).mode & 0o777, 0o600);
  const pending = await cli(["receipt", "get", "int_pending", "--out", join(dir, "never.json")], { base: api.base });
  assert.equal(pending.code, 5);
  assert.match(pending.stdout, /No receipt yet: awaiting_finality/u);
  await assert.rejects(stat(join(dir, "never.json")), "no file is left behind");
});

test("receipt shares, unshare, keys and log", async () => {
  const shares = await cli(["receipt", "shares", INTENT], { base: api.base });
  assert.match(shares.stdout, new RegExp(`${SHARE_ID}\\s+${RECEIPT_ID}\\s+1\\s+skeleton\\s+never`, "u"));
  const unshare = await cli(["receipt", "unshare", INTENT, SHARE_ID], { base: api.base });
  assert.equal(unshare.code, 0);
  assert.equal((await cli(["receipt", "unshare", INTENT, "rsh_bad"], { base: api.base })).code, 64);
  const keys = await cli(["receipt", "keys", "--check"], { base: api.base });
  assert.match(keys.stdout, new RegExp(`${vectors.key.kid}\\s+active\\s+2026-10-01\\s+-\\s+API only`, "u"));
  const log = await cli(["receipt", "log"], { base: api.base });
  assert.match(log.stdout, /^1\s+3\s+2026-10-09\s+3f734122df…4d33bf\s+-$/mu);
});

test("redact masks agent keys and the key of a share link wherever they appear", async () => {
  const { redact } = await import("../dist/index.js");
  const text = `key kl_agt_0123456789abcdefghijklmnopqrstuv link ${SHARE_URL}`;
  const masked = redact(text);
  assert.equal(masked.includes("0123456789abcdefghijklmnopqrstuv"), false);
  assert.equal(masked.includes(SEALED.key), false);
  assert.match(masked, /kl_agt_…stuv/u);
  assert.match(masked, new RegExp(`#s=${SHARE_ID}&k=\\[redacted\\]`, "u"));
});
