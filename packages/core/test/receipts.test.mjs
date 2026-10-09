import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  AnchorUnavailableError,
  KLETIA_RECEIPT_KEY_PINS,
  RECEIPT_PROBLEM_CODES,
  RECEIPT_PROFILES,
  ReceiptProfileError,
  base64UrlDecode,
  base64UrlEncode,
  buildPlanRecord,
  buildReceipt,
  canonicalJson,
  compareAnchors,
  evmBindingView,
  evmQuoteBinding,
  intentRef,
  isAnchorUnavailable,
  isUnsupportedSolanaVersionError,
  merkleAuditPath,
  merkleRoot,
  planRecordDigest,
  projectRequest,
  randomReceiptSalt,
  readEvmAnchor,
  readSvmAnchor,
  receiptCommitment,
  receiptDigest,
  receiptGroupPaths,
  receiptJcs,
  receiptKeyId,
  receiptLogBatchDigest,
  receiptLogSigningInput,
  receiptRequestDigest,
  receiptSigningInput,
  receiptStateDigest,
  receiptUsd,
  selectReceiptDisclosures,
  sha256,
  sha256Hex,
  verifyEd25519,
  verifyReceipt,
} from "../dist/index.js";

const vectors = JSON.parse(readFileSync(new URL("./fixtures/receipt-v1-vectors.json", import.meta.url), "utf8"));
const rpcFixture = JSON.parse(readFileSync(new URL("./fixtures/receipt-anchor-rpc.json", import.meta.url), "utf8"));
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const clone = (value) => structuredClone(value);
const NOW = Date.parse("2026-10-09T14:00:00Z");
const KEYS = vectors.key.jwks.keys;

/* ------------------------------------------------------------ test key (the vectors' seed) */

async function vectorKey() {
  const seed = createHash("sha256").update("kletia receipt test vector seed v1").digest();
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  return subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
}

async function sign(privateKey, text) {
  return base64UrlEncode(new Uint8Array(await subtle.sign({ name: "Ed25519" }, privateKey, enc.encode(text))));
}

/** Re-signs a payload (after a deliberate change) with the vectors' key. */
async function resign(document) {
  const privateKey = await vectorKey();
  const digest = await receiptDigest(document.payload);
  return { ...document, digest, signature: { ...document.signature, value: await sign(privateKey, receiptSigningInput(digest)) } };
}

/* ------------------------------------------------------------------ hashing and codecs */

test("sync SHA-256 matches node:crypto on every length around block boundaries", () => {
  for (let length = 0; length < 300; length += 1) {
    const bytes = randomBytes(length);
    assert.equal(sha256Hex(bytes), createHash("sha256").update(bytes).digest("hex"), `length ${length}`);
  }
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("héllo ✶ 🚆"), createHash("sha256").update("héllo ✶ 🚆").digest("hex"));
  assert.equal(sha256(new Uint8Array(64)).length, 32);
});

test("base64url round-trips and refuses padding, other alphabets and non-canonical tails", () => {
  for (let length = 0; length < 70; length += 1) {
    const bytes = randomBytes(length);
    const text = base64UrlEncode(bytes);
    assert.equal(text, bytes.toString("base64url"));
    assert.deepEqual(Buffer.from(base64UrlDecode(text)), bytes);
  }
  assert.equal(base64UrlDecode("YQ=="), null);
  assert.equal(base64UrlDecode("Y+8"), null);
  assert.equal(base64UrlDecode("YR"), null, "non-zero leftover bits");
  assert.equal(base64UrlDecode("A"), null);
});

/* ------------------------------------------------------------------ vectors */

test("vectors: payload JCS, digest, signing input, intent ref, kid and every commitment match byte for byte", async () => {
  const { payload, disclosures } = vectors.receipt;
  const jcs = receiptJcs(payload);
  assert.equal(enc.encode(jcs).length, vectors.expected.payloadJcsLength);
  assert.equal(await receiptDigest(payload), vectors.expected.payloadJcsSha256);
  assert.equal(vectors.receipt.digest, vectors.expected.payloadJcsSha256);
  assert.equal(receiptSigningInput(vectors.receipt.digest), vectors.expected.signingInput);
  assert.equal(enc.encode(vectors.expected.signingInput).length, 82);
  assert.equal(intentRef(vectors.intentId), vectors.expected.intentRef);
  assert.equal(receiptKeyId(vectors.key.publicJwk.x), vectors.key.kid);
  for (const [path, disclosure] of Object.entries(disclosures)) {
    assert.equal(receiptCommitment(path, disclosure), vectors.expected.commitments[path], path);
  }
  const request = disclosures["intent.request"].value;
  assert.equal(receiptRequestDigest(request.request), request.requestDigest);
});

test("vectors: Ed25519 over the signing input is deterministic and reproduces the published signature and key", async () => {
  const privateKey = await vectorKey();
  const jwk = await subtle.exportKey("jwk", privateKey);
  assert.equal(jwk.x, vectors.key.publicJwk.x);
  assert.equal(await sign(privateKey, vectors.expected.signingInput), vectors.receipt.signature.value);
  assert.equal(await verifyEd25519(vectors.key.publicJwk.x, vectors.expected.signingInput, vectors.receipt.signature.value), true);
  assert.equal(await verifyEd25519(vectors.key.publicJwk.x, `${vectors.expected.signingInput} `, vectors.receipt.signature.value), false);
});

test("vectors: RFC 6962 root, audit path, log batch digest and batch signature", async () => {
  assert.equal(merkleRoot(vectors.merkle.leaves), vectors.merkle.root);
  assert.deepEqual(merkleAuditPath(vectors.merkle.inclusion.leafIndex, vectors.merkle.leaves), vectors.merkle.inclusion.path);
  assert.equal(receiptLogBatchDigest(vectors.log.batch), vectors.log.batchDigest);
  assert.equal(receiptLogSigningInput(vectors.log.batchDigest), vectors.log.signingInput);
  const privateKey = await vectorKey();
  assert.equal(await sign(privateKey, vectors.log.signingInput), vectors.log.signature);
});

test("RFC 7638 thumbprint reproduces RFC 8037 Appendix A.3", () => {
  assert.equal(receiptKeyId("11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"), "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k");
});

/* ------------------------------------------------------------------ profile */

test("receiptJcs: RFC 8785 sorting and string escapes; numbers outside safe integers, -0, NaN, lone surrogates, odd keys and undefined are refused", () => {
  assert.equal(receiptJcs({ b: 1, a: [true, null, "x"], c: { z: 0, y: -5 } }), '{"a":[true,null,"x"],"b":1,"c":{"y":-5,"z":0}}');
  assert.equal(receiptJcs({ s: "\u0000\u001f \u007f é 😀 \"\\/" }), '{"s":"\\u0000\\u001f \u007f é 😀 \\"\\\\/"}');
  assert.equal(receiptJcs([Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER]), "[9007199254740991,-9007199254740991]");
  const refused = [
    [1.5, "$"],
    [{ a: Number.MAX_SAFE_INTEGER + 1 }, "$.a"],
    [{ a: -0 }, "$.a"],
    [{ a: Number.NaN }, "$.a"],
    [{ a: Number.POSITIVE_INFINITY }, "$.a"],
    [{ a: 1e21 }, "$.a"],
    [{ s: "\ud800" }, "$.s"],
    [{ s: "x\udc00" }, "$.s"],
    [{ "bad key": 1 }, "$"],
    [{ ["k".repeat(65)]: 1 }, "$"],
    [{ ü: 1 }, "$"],
    [{ a: undefined }, "$.a"],
    [[1, undefined], "$[1]"],
    [{ a: 10n }, "$.a"],
    [{ d: new Date(0) }, "$.d"],
    [{ m: new Map() }, "$.m"],
  ];
  for (const [value, path] of refused) {
    assert.throws(() => receiptJcs(value), (error) => error instanceof ReceiptProfileError && error.code === "PROFILE_VIOLATION" && error.path === path, JSON.stringify(path));
  }
});

/* ------------------------------------------------------------------ offline verification */

const verify = (document, options = {}) => verifyReceipt(document, { keys: KEYS, now: NOW, ...options });
const codes = (result) => result.problems.map((problem) => problem.code);

test("verifyReceipt: the vectors verify with a supplied key, every group disclosed; the { receipt } envelope works too", async () => {
  const result = await verify(vectors.receipt, { intentId: vectors.intentId });
  assert.equal(result.valid, true, JSON.stringify(result.problems));
  assert.equal(result.digest, vectors.expected.payloadJcsSha256);
  assert.deepEqual(result.key, { status: "active", provenance: "supplied" });
  assert.equal(result.disclosed.length, 10);
  assert.deepEqual(result.sealed, []);
  assert.equal(result.intentMatches, true);
  assert.deepEqual(result.warnings.map((warning) => warning.code), ["INCLUSION_PENDING"]);
  assert.equal((await verify({ receipt: vectors.receipt })).valid, true);
});

test("verifyReceipt: no pinned production key ships yet, so an unsupplied key is KEY_UNKNOWN (fail closed)", async () => {
  assert.deepEqual(KLETIA_RECEIPT_KEY_PINS, []);
  const result = await verifyReceipt(vectors.receipt, { now: NOW });
  assert.equal(result.valid, false);
  assert.deepEqual(codes(result), ["KEY_UNKNOWN"]);
  assert.deepEqual(result.key, { status: "unknown", provenance: "none" });
});

test("verifyReceipt: pins win over supplied keys; a supplied key must be its own thumbprint", async () => {
  const pinned = await verifyReceipt(vectors.receipt, { pins: KEYS, now: NOW });
  assert.deepEqual(pinned.key, { status: "active", provenance: "pinned" });
  const revokedPin = [{ ...KEYS[0], status: "revoked", revokedOn: "2026-10-01" }];
  const conflict = await verifyReceipt(vectors.receipt, { pins: revokedPin, keys: KEYS, now: NOW });
  assert.deepEqual(codes(conflict), ["KEY_REVOKED"], "a supplied active copy cannot override a revoked pin");
  const forged = await verify(vectors.receipt, { keys: [{ ...KEYS[0], x: base64UrlEncode(new Uint8Array(32).fill(7)) }] });
  assert.deepEqual(codes(forged), ["KEY_UNKNOWN"]);
});

test("verifyReceipt: each fatal problem code from a minimal mutation", async () => {
  const base = vectors.receipt;
  const mutate = (fn) => {
    const copy = clone(base);
    fn(copy);
    return copy;
  };
  const cases = [
    ["SPEC_UNSUPPORTED", mutate((doc) => (doc.payload.spec = "kletia.receipt/v2"))],
    ["SCHEMA_INVALID", mutate((doc) => (doc.payload.intent.lane = "beta"))],
    ["SCHEMA_INVALID", mutate((doc) => (doc.payload.intent.terminal = false))],
    ["SCHEMA_INVALID", mutate((doc) => (doc.payload.extra = "smuggled"))],
    ["SCHEMA_INVALID", mutate((doc) => (doc.signature.alg = "EdDSA"))],
    ["PROFILE_VIOLATION", mutate((doc) => (doc.payload.intent.durationSeconds = 1.5))],
    ["DIGEST_MISMATCH", mutate((doc) => (doc.payload.intent.finishedOn = "2026-10-08"))],
    ["DIGEST_MISMATCH", mutate((doc) => (doc.digest = doc.digest.replace(/^2/u, "3")))],
    ["KEY_UNKNOWN", mutate((doc) => (doc.signature.kid = "x".repeat(43)))],
  ];
  for (const [code, document] of cases) {
    const result = await verify(document);
    assert.equal(result.valid, false, code);
    assert.deepEqual(codes(result), [code], `${code}: ${JSON.stringify(result.problems)}`);
  }
  const badSignature = mutate((doc) => {
    const bytes = base64UrlDecode(doc.signature.value);
    bytes[10] ^= 1;
    doc.signature.value = base64UrlEncode(bytes);
  });
  assert.deepEqual(codes(await verify(badSignature)), ["SIGNATURE_INVALID"]);
  // A changed payload with a recomputed digest still fails on the signature.
  const tampered = mutate((doc) => (doc.payload.intent.status = "failed"));
  tampered.payload.intent.terminal = false;
  tampered.digest = await receiptDigest(tampered.payload);
  assert.deepEqual(codes(await verify(tampered)), ["SIGNATURE_INVALID"]);
});

test("verifyReceipt: key validity window by day (notBefore, revokedOn) and status warnings", async () => {
  const withKey = (patch) => verify(vectors.receipt, { keys: [{ ...KEYS[0], ...patch }] });
  assert.deepEqual(codes(await withKey({ notBefore: "2026-10-10" })), ["KEY_NOT_YET_VALID"]);
  assert.deepEqual(codes(await withKey({ status: "revoked", revokedOn: "2026-10-09" })), ["KEY_REVOKED"], "issuedOn on revokedOn is invalid");
  assert.deepEqual(codes(await withKey({ status: "revoked" })), ["KEY_REVOKED"], "revoked without a day revokes everything");
  const before = await withKey({ status: "revoked", revokedOn: "2026-10-10" });
  assert.equal(before.valid, true, "a receipt signed before the compromise day stays valid");
  const retired = await withKey({ status: "retired" });
  assert.equal(retired.valid, true);
  assert.ok(retired.warnings.some((warning) => warning.code === "KEY_RETIRED"));
  const development = await withKey({ status: "development" });
  assert.ok(development.warnings.some((warning) => warning.code === "KEY_DEVELOPMENT"));
});

test("verifyReceipt: disclosures are path bound; tampered, swapped, unknown and malformed disclosures are reported", async () => {
  const doc = clone(vectors.receipt);
  doc.disclosures["steps.s1.evidence"].value.anchors[0].status = "reverted";
  let result = await verify(doc);
  assert.equal(result.valid, false);
  assert.deepEqual(codes(result), ["DISCLOSURE_MISMATCH"]);
  assert.ok(!result.disclosed.includes("steps.s1.evidence"));

  const swapped = clone(vectors.receipt);
  swapped.disclosures["steps.s2.evidence"] = swapped.disclosures["steps.s1.evidence"];
  assert.deepEqual(codes(await verify(swapped)), ["DISCLOSURE_MISMATCH"]);

  const unknown = clone(vectors.receipt);
  unknown.disclosures["steps.s9.evidence"] = unknown.disclosures["steps.s1.evidence"];
  assert.deepEqual(codes(await verify(unknown)), ["DISCLOSURE_PATH_UNKNOWN"]);

  const badSalt = clone(vectors.receipt);
  badSalt.disclosures["intent.timing"].salt = "short";
  assert.deepEqual(codes(await verify(badSalt)), ["DISCLOSURE_INVALID"]);
});

test("verifyReceipt: holders can redact any subset; required groups and the intent ref are enforced", async () => {
  const redacted = { ...vectors.receipt, disclosures: selectReceiptDisclosures(vectors.receipt.disclosures, receiptGroupPaths("proof", vectors.receipt.payload)) };
  const result = await verify(redacted);
  assert.equal(result.valid, true);
  assert.deepEqual(result.disclosed, ["intent.timing", "intent.outcome", "steps.s1.amounts", "steps.s1.evidence", "steps.s2.amounts", "steps.s2.evidence"]);
  assert.deepEqual(result.sealed, ["intent.request", "intent.plan", "steps.s1.parties", "steps.s2.parties"]);
  assert.ok(result.warnings.some((warning) => warning.code === "SEALED_GROUPS"));

  const route = { ...vectors.receipt, disclosures: {} };
  assert.equal((await verify(route)).valid, true, "the skeleton alone verifies");
  const missing = await verify(route, { requireGroups: ["steps.*.evidence"] });
  assert.deepEqual(codes(missing), ["DISCLOSURE_MISSING", "DISCLOSURE_MISSING"]);
  assert.deepEqual(codes(await verify(route, { requireGroups: ["steps.s7.amounts"] })), ["DISCLOSURE_MISSING"]);

  const wrongIntent = await verify(vectors.receipt, { intentId: "int_ffffffffffffffffffffffffffffffff" });
  assert.equal(wrongIntent.intentMatches, false);
  assert.deepEqual(codes(wrongIntent), ["INTENT_REF_MISMATCH"]);
  assert.deepEqual(RECEIPT_PROFILES.route, []);
});

test("verifyReceipt: inclusion proofs verify against the signed batch; wrong index, path or batch signature fail", async () => {
  const inclusion = { batch: vectors.log.batch, batchSignature: vectors.log.signature, leafIndex: 2, path: vectors.merkle.inclusion.path, anchor: null };
  const good = await verify({ ...vectors.receipt, inclusion });
  assert.equal(good.valid, true);
  assert.deepEqual(good.inclusion, { valid: true, batch: 1 });
  assert.ok(!good.warnings.some((warning) => warning.code.startsWith("INCLUSION")));
  for (const bad of [
    { ...inclusion, leafIndex: 1 },
    { ...inclusion, path: [sha256Hex("x")] },
    { ...inclusion, batchSignature: vectors.receipt.signature.value },
    { ...inclusion, batch: { ...inclusion.batch, size: 4 } },
  ]) {
    const result = await verify({ ...vectors.receipt, inclusion: bad });
    assert.deepEqual(codes(result), ["INCLUSION_INVALID"]);
    assert.equal(result.inclusion.valid, false);
  }
  const overdue = await verify(vectors.receipt, { now: Date.parse("2026-10-13T00:00:00Z") });
  assert.deepEqual(overdue.warnings.map((warning) => warning.code), ["INCLUSION_OVERDUE"]);
});

test("verifyReceipt: internally inconsistent disclosures are DISCLOSURE_INVALID even when Kletia signed them", async () => {
  const doc = clone(vectors.receipt);
  const request = doc.disclosures["intent.request"];
  request.value.requestDigest = sha256Hex("something else");
  doc.payload.intent.commitments.request = receiptCommitment("intent.request", request);
  const evidence = doc.disclosures["steps.s1.evidence"];
  evidence.value.anchors[0].chain = "eip155:42161";
  doc.payload.steps[0].commitments.evidence = receiptCommitment("steps.s1.evidence", evidence);
  const result = await verify(await resign(doc));
  assert.deepEqual(codes(result), ["DISCLOSURE_INVALID", "DISCLOSURE_INVALID"]);
  assert.match(result.problems[0].message, /requestDigest/u);
  assert.match(result.problems[1].message, /chain the step does not touch/u);
  assert.equal(RECEIPT_PROBLEM_CODES.includes("SHARE_DECRYPT_FAILED"), true);
});

/* ------------------------------------------------------------------ builder */

const BASE_ACCOUNT = "eip155:8453:0x3965d154f3f9737f32c73a80b9509ad06f2b0ce2";
const ARB_ACCOUNT = "eip155:42161:0x3965d154f3f9737f32c73a80b9509ad06f2b0ce2";
const SOL_ACCOUNT = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:6ncfqSF3xwxUbF1USdx1y8VqBDCKCoDxQHZ1usME27Xy";
const USDC_BASE = "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const USDC_ARB = "eip155:42161/erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const amount = (asset, units, symbol = "USDC", decimals = 6) => ({ asset, symbol, decimals, amount: units, formatted: (Number(units) / 10 ** decimals).toString(), usd: Number(units) / 10 ** decimals });
const binding = (label) => sha256Hex(`binding ${label}`);
const evmAnchor = (chain, role, label, status = "success") => ({
  vm: "evm",
  role,
  chain,
  tx: `0x${sha256Hex(`tx ${label}`)}`,
  blockNumber: "52379872",
  blockHash: `0x${sha256Hex(`block ${label}`)}`,
  blockTimestamp: 1791549091,
  transactionIndex: 2,
  status,
  from: "0x3965d154f3f9737f32c73a80b9509ad06f2b0ce2",
  to: "0x4cd00e387622c35bddb9b4c962c136462338bc31",
  valueWei: "0",
  inputDigest: sha256Hex(`input ${label}`),
  logsDigest: sha256Hex(`logs ${label}`),
  logCount: 1,
  watch: ["0x3965d154f3f9737f32c73a80b9509ad06f2b0ce2"],
  transfers: [],
});

function step(overrides) {
  return {
    id: "s1",
    index: 0,
    kind: "transfer",
    title: "Step",
    network: "base",
    chain: "eip155:8453",
    account: BASE_ACCOUNT,
    protocol: "erc20-transfer",
    mode: "wallet",
    dependsOn: [],
    status: "settled",
    evidence: [],
    ...overrides,
  };
}

function bridgeGraph(overrides = {}) {
  const s1 = step({
    kind: "bridge",
    protocol: "relay",
    input: amount(USDC_BASE, "100000000"),
    expectedOutput: amount(USDC_ARB, "99965772"),
    minimumOutput: amount(USDC_ARB, "99465943"),
    actualOutput: amount(USDC_ARB, "99965772"),
    recipient: ARB_ACCOUNT,
    settlement: { kind: "cross-network", destinationNetwork: "arbitrum", trackingId: "0xrelayrequest1", expectedSeconds: 16 },
    feesUsd: 0.0016,
    estimatedSeconds: 16,
    references: [evmAnchor("eip155:8453", "origin", "s1").tx],
    prepared: { quoteBinding: binding("s1"), preparedAt: "2026-10-09T12:31:00.000Z", expiresAt: 1791549200, transactions: [] },
    evidence: [
      { kind: "quote", network: "base", reference: binding("s1"), observedAt: "2026-10-09T12:31:00.000Z", detail: "Prepared 2 transaction(s) with Relay." },
      { kind: "quote", network: "base", reference: "0xrelayrequest1", observedAt: "2026-10-09T12:31:00.000Z", detail: "Settlement request prepared." },
      { kind: "note", network: "base", reference: "0x1", observedAt: "2026-10-09T12:31:20.000Z", detail: "References submitted." },
      { kind: "settlement", network: "arbitrum", reference: evmAnchor("eip155:42161", "fill", "s1fill").tx, observedAt: "2026-10-09T12:31:40.000Z", detail: "Relay filled." },
    ],
  });
  const graph = {
    spec: "kletia.intent/v1",
    id: "int_00112233445566778899aabbccddeeff",
    createdAt: "2026-10-09T12:30:00.000Z",
    updatedAt: "2026-10-09T12:32:10.000Z",
    expiresAt: "2026-10-09T13:00:00.000Z",
    status: "completed",
    request: { text: "bridge 100 USDC from base to arbitrum", accounts: [BASE_ACCOUNT], constraints: { maxSlippageBps: 50, maxFeeUsd: 1.5 }, metadata: { order: "A-1", campaign: "launch" } },
    interpretation: { source: "grammar", normalizedText: "bridge 100 USDC from base to arbitrum", confidence: 0.92, optimizations: [] },
    steps: [s1],
    edges: [],
    summary: { title: "Bridge 100 USDC to Arbitrum", networks: ["base", "arbitrum"], inputs: [s1.input], outputs: [s1.expectedOutput], totalFeesUsd: 0.0016, signaturesRequired: 1, crossNetwork: true },
    warnings: [],
    ...overrides,
  };
  return graph;
}

const readyCollection = (anchors, landedBindings = {}) => ({
  state: "ready",
  anchors,
  landedBindings,
  finalityHeads: [{ chain: "eip155:8453", block: "52380372" }, { chain: "eip155:42161", block: "398112004" }],
  finalityMode: [{ chain: "eip155:8453", mode: "finalized" }, { chain: "eip155:42161", mode: "finalized" }],
  expectedBy: null,
});

const freshSalts = () => {
  const used = new Map();
  return (path) => {
    if (!used.has(path)) used.set(path, randomReceiptSalt());
    return used.get(path);
  };
};

async function issue(graph, collection, overrides = {}) {
  const built = buildReceipt({
    graph,
    collection,
    receiptId: "rcpt_0123456789abcdef0123456789abcdef",
    sequence: 1,
    supersedes: null,
    issuedAt: "2026-10-09T13:10:00.000Z",
    issuer: { name: "Kletia", origin: "https://api.kletiaai.xyz", apiVersion: "1.0.0", kid: vectors.key.kid },
    salts: freshSalts(),
    ...overrides,
  });
  const digest = await receiptDigest(built.payload);
  const privateKey = await vectorKey();
  const document = { payload: built.payload, digest, signature: { alg: "Ed25519", kid: vectors.key.kid, value: await sign(privateKey, receiptSigningInput(digest)) }, disclosures: built.disclosures };
  return { built, document };
}

test("buildReceipt: a completed Relay bridge with an origin and a fill anchor verifies end to end", async () => {
  const graph = bridgeGraph();
  graph.plan = { digest: "", record: buildPlanRecord(graph) };
  graph.plan = { digest: planRecordDigest(graph.plan.record), record: graph.plan.record };
  const anchors = { s1: [evmAnchor("eip155:8453", "origin", "s1"), evmAnchor("eip155:42161", "fill", "s1fill")] };
  const { built, document } = await issue(graph, readyCollection(anchors, { s1: binding("s1") }));
  const { payload } = built;
  assert.equal(payload.intent.ref, intentRef(graph.id));
  assert.equal(JSON.stringify(payload).includes(graph.id), false, "the bearer intent id never appears");
  assert.deepEqual(payload.intent.networks, ["base", "arbitrum"]);
  assert.equal(payload.intent.terminal, true);
  assert.equal(payload.intent.finality, "finalized");
  assert.equal(payload.intent.durationSeconds, 50, "first submission 12:31:20 → last change 12:32:10");
  assert.equal(payload.issuedOn, "2026-10-09");
  assert.equal(payload.steps[0].evidenceClass, "onchain+provider");
  assert.deepEqual(payload.steps[0].assets, { input: USDC_BASE, output: USDC_ARB });
  const evidence = built.disclosures["steps.s1.evidence"].value;
  assert.deepEqual(evidence.provider, { name: "relay", kind: "request", trackingId: "0xrelayrequest1" });
  assert.deepEqual(evidence.quotes, [{ binding: binding("s1"), preparedAt: "2026-10-09T12:31:00.000Z" }]);
  assert.equal(evidence.landedBinding, binding("s1"));
  assert.equal(evidence.anchors[1].role, "fill");
  const amounts = built.disclosures["steps.s1.amounts"].value;
  assert.equal(amounts.plannedInput, "100000000");
  assert.equal(amounts.plannedMinimum, "99465943");
  assert.equal(amounts.feesUsd, "0.0016");
  assert.deepEqual(built.disclosures["steps.s1.parties"].value.destinationAccount, ARB_ACCOUNT);
  assert.equal(built.disclosures["intent.timing"].value.firstSubmittedAt, "2026-10-09T12:31:20.000Z");
  assert.deepEqual(built.disclosures["intent.outcome"].value.outputs, [{ asset: USDC_ARB, symbol: "USDC", decimals: 6, amount: "99965772" }]);
  const result = await verify(document, { intentId: graph.id });
  assert.equal(result.valid, true, JSON.stringify(result.problems));
  assert.equal(result.disclosed.length, 7);
  assert.deepEqual(new Set(Object.values(built.disclosures).map((disclosure) => disclosure.salt)).size, 7, "fresh salt per group");
});

test("buildReceipt: partially completed with a reverted deposit is not terminal and carries the failure code publicly, the message privately", async () => {
  const graph = bridgeGraph({ status: "partially_completed" });
  const deposit = step({
    id: "s2",
    index: 1,
    kind: "deposit",
    network: "arbitrum",
    chain: "eip155:42161",
    account: ARB_ACCOUNT,
    protocol: "aave-v3",
    venue: "aave-v3-arbitrum-usdc",
    dependsOn: ["s1"],
    status: "failed",
    input: amount(USDC_ARB, "99965772"),
    failure: { code: "TRANSACTION_REVERTED", message: "The deposit reverted." },
    references: [evmAnchor("eip155:42161", "origin", "s2", "reverted").tx],
  });
  graph.steps = [...graph.steps, deposit];
  graph.edges = [{ from: "s1", to: "s2", kind: "funds" }];
  const anchors = { s1: [evmAnchor("eip155:8453", "origin", "s1")], s2: [evmAnchor("eip155:42161", "origin", "s2", "reverted")] };
  const { built, document } = await issue(graph, readyCollection(anchors));
  assert.equal(built.payload.intent.terminal, false);
  assert.deepEqual(built.payload.steps[1].failure, { code: "TRANSACTION_REVERTED" });
  assert.equal(built.payload.steps[1].venue, "aave-v3-arbitrum-usdc");
  assert.deepEqual(built.disclosures["steps.s2.evidence"].value.failure, { code: "TRANSACTION_REVERTED", message: "The deposit reverted." });
  assert.deepEqual(built.payload.edges, [{ from: "s1", to: "s2", kind: "funds" }]);
  const result = await verify(document);
  assert.equal(result.valid, true);
  assert.ok(result.warnings.some((warning) => warning.code === "NOT_TERMINAL"));
  const reissued = await issue(graph, readyCollection(anchors), { sequence: 2, supersedes: document.digest });
  assert.equal(reissued.built.payload.supersedes, document.digest);
  assert.equal((await verify(reissued.document)).valid, true);
});

test("buildReceipt: failed without anchors, cancelled (no anchors allowed) and legacy intents without a plan record", async () => {
  const failed = bridgeGraph({ status: "failed" });
  failed.steps = [{ ...failed.steps[0], status: "failed", references: undefined, evidence: [], failure: { code: "QUOTE_MOVED", message: "Moved." } }];
  const failedReceipt = await issue(failed, readyCollection({}));
  assert.equal(failedReceipt.built.payload.intent.finality, "none");
  assert.equal(failedReceipt.built.payload.intent.durationSeconds, null);
  assert.equal(failedReceipt.built.payload.steps[0].evidenceClass, "none");
  assert.deepEqual(failedReceipt.built.disclosures["intent.plan"].value, { planDigest: null, plan: null, reason: "intent created before plan records" });
  assert.equal((await verify(failedReceipt.document)).valid, true);

  const cancelled = { ...failed, status: "cancelled" };
  assert.equal((await issue(cancelled, readyCollection({}))).built.payload.intent.terminal, true);
  assert.throws(() => buildReceipt({ ...baseInput(cancelled), collection: readyCollection({ s1: [evmAnchor("eip155:8453", "origin", "s1")] }) }), /cancelled intent cannot carry anchors/u);
});

function baseInput(graph) {
  return {
    graph,
    collection: readyCollection({}),
    receiptId: "rcpt_0123456789abcdef0123456789abcdef",
    sequence: 1,
    supersedes: null,
    issuedAt: "2026-10-09T13:10:00.000Z",
    issuer: { name: "Kletia", origin: "https://api.kletiaai.xyz", apiVersion: "1.0.0", kid: vectors.key.kid },
    salts: freshSalts(),
  };
}

test("buildReceipt: refuses unfinalized inputs, unreceiptable statuses, foreign-chain anchors, bad sequences and broken salt sources", () => {
  const graph = bridgeGraph();
  assert.throws(() => buildReceipt({ ...baseInput(graph), collection: { ...readyCollection({}), state: "waiting_finality" } }), /never issue on unfinalized data/u);
  for (const status of ["expired", "indeterminate", "executing", "settling", "planned"]) {
    assert.throws(() => buildReceipt(baseInput({ ...graph, status })), /get no receipt/u, status);
  }
  assert.throws(() => buildReceipt({ ...baseInput(graph), collection: readyCollection({ s1: [evmAnchor("eip155:10", "origin", "op")] }) }), /does not touch/u);
  assert.throws(() => buildReceipt({ ...baseInput(graph), sequence: 2 }), /supersedes/u);
  assert.throws(() => buildReceipt({ ...baseInput(graph), supersedes: sha256Hex("x") }), /supersedes/u);
  assert.throws(() => buildReceipt({ ...baseInput(graph), salts: () => "AAAAAAAAAAAAAAAAAAAAAA" }), /repeats/u);
  assert.throws(() => buildReceipt({ ...baseInput(graph), salts: () => "not a salt" }), /16 random bytes/u);
  assert.throws(() => buildReceipt({ ...baseInput(graph), receiptId: "rcpt_x" }), /receiptId/u);
  const broken = bridgeGraph();
  broken.plan = { digest: sha256Hex("wrong"), record: buildPlanRecord(broken) };
  assert.throws(() => buildReceipt(baseInput(broken)), /plan.digest/u);
});

test("buildReceipt: BYOC call steps carry the integrator and contract in the skeleton and a review digest in evidence", async () => {
  const graph = bridgeGraph();
  graph.steps = [
    step({
      kind: "call",
      protocol: "custom-call",
      input: amount(USDC_BASE, "5000000"),
      references: [evmAnchor("eip155:8453", "origin", "call").tx],
      call: {
        contract: "ct_5f1c2a9b7e3d4c6a8b0e1f23",
        revision: 3,
        definitionHash: sha256Hex("definition"),
        entry: "deposit",
        vm: "evm",
        target: "0xbeef010f9cb27031ad51e3333f9af9c6b1228183",
        integrator: { name: "Acme Yield", website: "https://acme.example", domainVerified: true },
        function: "deposit(uint256,address)",
        pins: { codeHash: `0x${sha256Hex("code")}`, block: 52_000_000, gasRatio: 1.25 },
        review: { notices: ["Not audited by Kletia."], usd: 4.99, simulation: { gasUsed: 48770n } },
      },
    }),
  ];
  graph.summary = { ...graph.summary, inputs: [], outputs: [] };
  const { built, document } = await issue(graph, readyCollection({ s1: [evmAnchor("eip155:8453", "origin", "call")] }));
  assert.deepEqual(built.payload.steps[0].contract, {
    integrator: "Acme Yield",
    domainVerified: true,
    vm: "evm",
    target: "0xbeef010f9cb27031ad51e3333f9af9c6b1228183",
    function: "deposit(uint256,address)",
    definitionHash: sha256Hex("definition"),
    revision: 3,
  });
  const contract = built.disclosures["steps.s1.evidence"].value.contract;
  assert.equal(contract.contractId, "ct_5f1c2a9b7e3d4c6a8b0e1f23");
  assert.match(contract.reviewDigest, /^[0-9a-f]{64}$/u);
  assert.deepEqual(contract.pins, { codeHash: `0x${sha256Hex("code")}`, block: 52_000_000, gasRatio: "1.25" }, "floats become decimal strings");
  assert.equal((await verify(document)).valid, true);
});

test("projectRequest and buildPlanRecord: floats to strings, user maps to sorted pairs, stable across key order, lone surrogates replaced", () => {
  const request = {
    accounts: [BASE_ACCOUNT],
    actions: [{ kind: "deposit", network: "base", from: "USDC", amount: "10", params: { venue: "spark-usdc", portionBps: 5000, deep: true } }],
    constraints: { maxFeeUsd: 1e-7, maxSlippageBps: 50, deadline: 1791549091, maxSeconds: 2.5e21 },
    metadata: { zeta: "1", alpha: "2", "Beta key": "x" },
    text: "pay \ud800 bob",
  };
  const projected = projectRequest(request);
  assert.deepEqual(projected.metadata, [["Beta key", "x"], ["alpha", "2"], ["zeta", "1"]]);
  assert.deepEqual(projected.actions[0].params, [["deep", "boolean", "true"], ["portionBps", "number", "5000"], ["venue", "string", "spark-usdc"]]);
  assert.equal(projected.constraints.maxFeeUsd, "0.0000001");
  assert.equal(projected.constraints.maxSeconds, "2500000000000000000000", "non-safe numbers become decimal text");
  assert.equal(projected.text, "pay � bob");
  const reordered = projectRequest({ text: request.text, metadata: { "Beta key": "x", zeta: "1", alpha: "2" }, constraints: { maxSeconds: 2.5e21, deadline: 1791549091, maxSlippageBps: 50, maxFeeUsd: 1e-7 }, actions: request.actions, accounts: request.accounts });
  assert.equal(receiptRequestDigest(reordered), receiptRequestDigest(projected));
  assert.doesNotThrow(() => receiptJcs(projected));

  const record = buildPlanRecord(bridgeGraph());
  assert.equal(record.spec, "kletia.plan/v1");
  assert.equal(record.interpretation.confidenceBps, 9200);
  assert.equal(record.steps[0].feesUsd, "0.0016");
  assert.deepEqual(record.steps[0].settlement, { kind: "cross-network", destinationNetwork: "arbitrum", expectedSeconds: 16 });
  assert.equal(planRecordDigest(record), planRecordDigest(buildPlanRecord(bridgeGraph())));
  assert.equal(receiptUsd(0.00001), "0.0000");
  assert.equal(receiptUsd(-0.00001), "0.0000");
  assert.equal(receiptUsd(Number.NaN), null);
});

test("receiptStateDigest changes when a status, a reference or a fill changes", () => {
  const graph = bridgeGraph();
  const digest = receiptStateDigest(graph, { s1: ["0xfill"] });
  assert.match(digest, /^[0-9a-f]{64}$/u);
  assert.notEqual(receiptStateDigest({ ...graph, status: "failed" }, { s1: ["0xfill"] }), digest);
  assert.notEqual(receiptStateDigest(graph, {}), digest);
  assert.equal(receiptStateDigest(bridgeGraph(), { s1: ["0xfill"] }), digest);
});

/* ------------------------------------------------------------------ anchor readers */

function fixtureTransport(section, overrides = {}) {
  const calls = [];
  const transport = async (method, params) => {
    calls.push({ method, params });
    if (method in overrides) {
      const value = overrides[method];
      if (value instanceof Error) throw value;
      return typeof value === "function" ? value(params) : value;
    }
    return clone(rpcFixture[section][method]);
  };
  transport.calls = calls;
  return transport;
}

test("readEvmAnchor reproduces the vectors' live Base anchor from the captured RPC responses", async () => {
  const expected = vectors.receipt.disclosures["steps.s1.evidence"].value.anchors[0];
  const transport = fixtureTransport("evm");
  const anchor = await readEvmAnchor(transport, { chain: expected.chain, tx: expected.tx, role: "origin", watch: [...expected.watch].reverse() });
  assert.deepEqual(anchor, expected);
  assert.deepEqual(compareAnchors(expected, anchor), []);
  assert.deepEqual(transport.calls.map((call) => call.method), ["eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getBlockByNumber"]);
  const narrower = await readEvmAnchor(fixtureTransport("evm"), { chain: expected.chain, tx: expected.tx, role: "origin", watch: ["0x2df380544b88adb3ad0a94100dcc45fd705aae2d"] });
  assert.equal(narrower.transfers.length, 2, "both transfers touch the watched address");
  const none = await readEvmAnchor(fixtureTransport("evm"), { chain: expected.chain, tx: expected.tx, role: "origin", watch: ["0x0000000000000000000000000000000000000001"] });
  assert.deepEqual(none.transfers, []);
  assert.equal(none.logsDigest, expected.logsDigest, "the logs digest covers every log, watched or not");
});

test("readSvmAnchor reads a live Solana version 1 transaction (maxSupportedTransactionVersion 1) and reproduces the vectors' anchor", async () => {
  const expected = vectors.receipt.disclosures["steps.s2.evidence"].value.anchors[0];
  const transport = fixtureTransport("svm");
  const anchor = await readSvmAnchor(transport, { chain: expected.chain, signature: expected.signature, role: "origin", watch: expected.watch });
  assert.deepEqual(anchor, expected);
  assert.equal(anchor.version, "1");
  assert.equal(transport.calls[0].params[1].maxSupportedTransactionVersion, 1);
  assert.equal(transport.calls[1].params[1].transactionDetails, "none");
  const unwatched = await readSvmAnchor(fixtureTransport("svm"), { chain: expected.chain, signature: expected.signature, role: "origin", watch: [] });
  assert.deepEqual(unwatched.tokenDeltas, []);
  assert.deepEqual(unwatched.lamportDeltas, []);
});

test("anchor readers: null, -32015, RPC errors, malformed data and reorged blocks are unavailable, never a mismatch", async () => {
  const evm = vectors.receipt.disclosures["steps.s1.evidence"].value.anchors[0];
  const svm = vectors.receipt.disclosures["steps.s2.evidence"].value.anchors[0];
  const unavailable = async (promise, reason) => {
    await assert.rejects(promise, (error) => error instanceof AnchorUnavailableError && isAnchorUnavailable(error) && error.reason === reason);
  };
  const input = { chain: evm.chain, tx: evm.tx, role: "origin", watch: evm.watch };
  await unavailable(readEvmAnchor(fixtureTransport("evm", { eth_getTransactionReceipt: null }), input), "not_found");
  await unavailable(readEvmAnchor(fixtureTransport("evm", { eth_getTransactionByHash: new Error("-32602: Archive requests require a personal token") }), input), "rpc_error");
  await unavailable(readEvmAnchor(fixtureTransport("evm", { eth_getBlockByNumber: { hash: `0x${"ab".repeat(32)}`, timestamp: "0x1" } }), input), "not_found");
  await unavailable(readEvmAnchor(fixtureTransport("evm", { eth_getTransactionReceipt: { ...rpcFixture.evm.eth_getTransactionReceipt, logs: "nope" } }), input), "malformed");
  await unavailable(readEvmAnchor(fixtureTransport("evm", { eth_getTransactionByHash: { ...rpcFixture.evm.eth_getTransactionByHash, chainId: "0x1" } }), input), "wrong_chain");
  const versionError = Object.assign(new Error("Transaction version (1) is not supported by the requesting client"), { code: -32015 });
  assert.equal(isUnsupportedSolanaVersionError(versionError), true);
  assert.equal(isUnsupportedSolanaVersionError({ message: rpcFixture.svm["getTransaction@v0"].message }), true);
  const svmInput = { chain: svm.chain, signature: svm.signature, role: "origin", watch: svm.watch };
  await unavailable(readSvmAnchor(fixtureTransport("svm", { getTransaction: versionError }), svmInput), "client_too_old");
  await unavailable(readSvmAnchor(fixtureTransport("svm", { getTransaction: null }), svmInput), "not_found");
  await unavailable(readSvmAnchor(fixtureTransport("svm", { getBlock: new Error("Block 448389317 cleaned up, does not exist on node") }), svmInput), "rpc_error");
});

test("readEvmAnchor on a 48-log reverted receipt: status, log count and watched ERC-20 transfers only", async () => {
  const watched = "0x1111111111111111111111111111111111111111";
  const topic = (address) => `0x${"0".repeat(24)}${address.slice(2)}`;
  const logs = Array.from({ length: 48 }, (_, index) => ({
    address: index % 2 ? "0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913" : "0x4200000000000000000000000000000000000006",
    data: `0x${(index + 1).toString(16).padStart(64, "0")}`,
    logIndex: `0x${index.toString(16)}`,
    topics: index % 3 === 0
      ? ["0xDDF252AD1BE2C89B69C2B068FC378DAA952BA7F163C4A11628F55A4DF523B3EF", topic(index % 6 === 0 ? watched : "0x2222222222222222222222222222222222222222"), topic("0x3333333333333333333333333333333333333333")]
      : [`0x${sha256Hex(`event ${index}`)}`],
  }));
  const hash = `0x${"12".repeat(32)}`;
  const blockHash = `0x${"34".repeat(32)}`;
  const transport = async (method) => ({
    eth_getTransactionByHash: { hash, input: "0xdeadbeef", value: "0x10", chainId: "0x2105" },
    eth_getTransactionReceipt: { transactionHash: hash, blockNumber: "0x31f4a60", blockHash, transactionIndex: "0x5", status: "0x0", from: "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD", to: null, logs },
    eth_getBlockByNumber: { hash: blockHash, number: "0x31f4a60", timestamp: "0x6a5b6c7d" },
  })[method];
  const anchor = await readEvmAnchor(transport, { chain: "eip155:8453", tx: hash.toUpperCase().replace("0X", "0x"), role: "origin", watch: [watched.toUpperCase().replace("0X", "0x")] });
  assert.equal(anchor.status, "reverted");
  assert.equal(anchor.logCount, 48);
  assert.equal(anchor.to, "", "contract creations anchor an empty target");
  assert.equal(anchor.valueWei, "16");
  assert.equal(anchor.inputDigest, createHash("sha256").update(Buffer.from("deadbeef", "hex")).digest("hex"));
  assert.deepEqual(anchor.transfers.map((transfer) => transfer.logIndex), [0, 6, 12, 18, 24, 30, 36, 42]);
  assert.ok(anchor.transfers.every((transfer) => transfer.from === watched && transfer.to === "0x3333333333333333333333333333333333333333"));
  const changed = { ...anchor, status: "success", logsDigest: sha256Hex("other"), transfers: [] };
  assert.deepEqual(compareAnchors(anchor, changed), ["status", "logsDigest", "transfers"]);
  assert.deepEqual(compareAnchors(anchor, vectors.receipt.disclosures["steps.s2.evidence"].value.anchors[0]), ["vm"]);
});

test("evmQuoteBinding equals the engine's quoteBindingForViews (sha256 of canonical JSON of lower-cased views)", async () => {
  const views = [
    { vm: "evm", chainId: 8453, from: "0x3965D154F3F9737F32C73A80B9509AD06F2B0CE2", to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", data: "0x095EA7B3AB", value: "0" },
    { vm: "evm", chainId: 8453, from: "0x3965d154f3f9737f32c73a80b9509ad06f2b0ce2", to: "0x4cd00e387622c35bddb9b4c962c136462338bc31", data: "0xabcd", value: "0x0" },
  ];
  // The engine's canonicalJson + node sha256 over its bindingView (engine/binding.ts).
  const engineViews = views.map((view) => ({ vm: "evm", chainId: view.chainId, from: view.from.toLowerCase(), to: view.to.toLowerCase(), data: view.data.toLowerCase(), value: BigInt(view.value).toString() }));
  const expected = createHash("sha256").update(canonicalJson(engineViews)).digest("hex");
  assert.equal(await evmQuoteBinding(views), expected);
  assert.equal(await evmQuoteBinding(views.map(evmBindingView)), expected);
  assert.notEqual(await evmQuoteBinding([views[1], views[0]]), expected, "order matters");
});
