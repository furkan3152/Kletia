import assert from "node:assert/strict";
import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify, createPublicKey } from "node:crypto";
import test from "node:test";
import {
  POLICY_DECISION_GENESIS,
  approvalDigest,
  approvalMessageText,
  approvalTypedData,
  decodeBase58,
  effectivePolicyDocument,
  encodeBase58,
  policyDecisionChainHash,
  policyHash,
  validatePolicy,
} from "@kletia/core";
import {
  KletiaApiError,
  KletiaClient,
  KletiaPolicyError,
  createPolicyGuard,
  eip1193ApprovalSigner,
  executeIntent,
  solanaTransactionSigners,
  verifyDecisionChain,
} from "../dist/index.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const EVM = "0x8f3c0000000000000000000000000000000aa21b";
const STRANGER = "0x9999999999999999999999999999999999999999";
const OWN_BASE = `eip155:8453:${EVM}`;
const OWN_ARB = `eip155:42161:${EVM}`;
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const USDC_BASE = `eip155:8453/erc20:${USDC}`;
const USDC_ARB = "eip155:42161/erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const RELAY_PROXY = "0xccc88a9d1b4ed6b0eaba998850414b24f1c315be";
const RELAY_ROUTER = "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f";
const AAVE_POOL = "0xa238dd80c259a72e81d7e4664a9801593f98d1c5";
const AGENT = "key_9a7f0000000000000000aa01";
const OTHER_KEY = "key_1111000000000000000000aa";
const PROJECT = "prj_1a2b0000000000000000aa00";
const APPROVAL = `apr_${"5".repeat(32)}`;
const schema = "kletia.policy/v1";

function jsonResponse(status, body, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-request-id": "req-pol", ...headers } });
}

const AGENT_POLICY = validatePolicy({ schema, label: "research-bot", networks: { allow: ["base", "arbitrum"] }, accounts: { allow: [`eip155:*:${EVM}`] }, caps: { perIntentUsd: "1000" } }, { defaults: "agent" }).value;
const HASH = policyHash(AGENT_POLICY);

function policyRead({ hash = HASH, document = AGENT_POLICY, keyActive = true, projectHash = null } = {}) {
  return {
    policy: { scope: "key", keyId: AGENT, version: 1, hash, status: "active", document, activatesAt: null, loosened: [], tightened: [], createdAt: "x", createdBy: OTHER_KEY, pending: null },
    effective: {
      keyActive,
      chain: [...(projectHash ? [{ scope: "project", id: PROJECT, version: 1, hash: projectHash }] : []), { scope: "key", id: AGENT, version: 1, hash }],
      defaults: "agent",
      levels: [
        { scope: "project", id: PROJECT, version: projectHash ? 1 : null, hash: projectHash, defaults: "project", document: null },
        { scope: "key", id: AGENT, version: 1, hash, defaults: "agent", document: effectivePolicyDocument(document, "agent") },
      ],
    },
  };
}

const usdc = (asset, units, usd) => ({ asset, symbol: "USDC", decimals: 6, amount: String(units), formatted: String(units / 1e6), usd });

function bridgeIntent({ stamp = { outcome: "allow", keyId: AGENT }, network = "base" } = {}) {
  return {
    spec: "kletia.intent/v1",
    id: "int_guard",
    status: "executing",
    request: { accounts: [OWN_BASE] },
    edges: [],
    summary: { title: "Bridge 100 USDC" },
    steps: [
      {
        id: "s1", index: 0, kind: "bridge", network, chain: "eip155:8453", account: OWN_BASE, recipient: OWN_ARB,
        protocol: "relay", mode: "wallet", dependsOn: [], status: "awaiting_signature", evidence: [],
        settlement: { kind: "cross-network", destinationNetwork: "arbitrum", expectedSeconds: 20 },
        input: usdc(USDC_BASE, 100_000_000, 100), expectedOutput: usdc(USDC_ARB, 99_960_000, 99.96), minimumOutput: usdc(USDC_ARB, 99_460_000, 99.46),
        feesUsd: 0.01, estimatedSeconds: 20,
      },
    ],
    ...(stamp ? { policy: { decisionId: "pdc_0c5a9e1f4b7d2a8c3e6f9b01", chain: [{ scope: "key", id: AGENT, version: 1, hash: HASH }], notionalUsd: "100.00", evaluatedAt: "x", ...stamp } } : {}),
  };
}

function aaveIntent() {
  const intent = bridgeIntent();
  return {
    ...intent,
    steps: [{ ...intent.steps[0], kind: "deposit", protocol: "aave-v3", venue: "base:aave-v3:usdc", recipient: undefined, settlement: undefined, expectedOutput: undefined, minimumOutput: undefined }],
  };
}

const word = (hex) => hex.replace(/^0x/u, "").toLowerCase().padStart(64, "0");
const approveData = (spender, amount) => `0x095ea7b3${word(spender)}${word(BigInt(amount).toString(16))}`;
const evmTx = (to, data, extra = {}) => ({ vm: "evm", network: "base", chainId: 8453, from: EVM, to, data, value: "0", nonce: "7", description: "t", ...extra });

function payload(transactions, chainHashes = [HASH]) {
  return { vm: "evm", transactions, expiresAt: 0, quoteBinding: "qb", policy: { decisionId: "pdc_0c5a9e1f4b7d2a8c3e6f9b01", exposureId: "px_000000000000000000000001", notionalUsd: "100.00", chainHashes } };
}

const relayPayload = (overrides = {}) =>
  payload([evmTx(USDC, approveData(RELAY_PROXY, 100_000_000), { nonce: "7" }), evmTx(RELAY_ROUTER, "0x12345678", { nonce: "8", ...overrides })]);

function guardClient({ read = policyRead(), approval } = {}) {
  const calls = [];
  const client = new KletiaClient({
    baseUrl: "http://localhost:3001",
    apiKey: "kl_agt_0123456789abcdefghijklmnopqrstuv",
    fetch: async (url, init) => {
      const { pathname } = new URL(url);
      calls.push(`${init.method} ${pathname}`);
      if (pathname === `/v1/keys/${AGENT}/policy`) return jsonResponse(200, typeof read === "function" ? read() : read);
      if (pathname === `/v1/policy/approvals/${APPROVAL}`) return jsonResponse(200, { approval });
      throw new Error(`unexpected ${pathname}`);
    },
  });
  return { client, calls };
}

const signer = { honorsNonce: true };

async function refused(promise, rule) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof KletiaPolicyError, String(error));
    assert.equal(error.stage, "sign");
    assert.equal(error.status, 0);
    assert.ok(error.violations.some((violation) => violation.rule === rule), `${rule} in ${error.violations.map((violation) => violation.rule).join(", ")}`);
    return true;
  });
}

/* ------------------------------------------------------------------ guard */

test("the guard refuses a key whose rule book is not the pinned one, at creation and before each signature", async () => {
  const { client } = guardClient();
  await refused(createPolicyGuard({ client, keyId: AGENT, pinnedHash: `sha256:${"0".repeat(64)}` }), "guard.pinnedHash");
  // The server's hash field alone is not trusted: the document must hash to the pin.
  const lying = guardClient({ read: policyRead({ document: { ...AGENT_POLICY, caps: { perIntentUsd: "1000000" } } }) });
  await refused(createPolicyGuard({ client: lying.client, keyId: AGENT, pinnedHash: HASH }), "guard.pinnedHash");
  let reads = 0;
  const changing = guardClient({ read: () => (reads++ === 0 ? policyRead() : policyRead({ hash: `sha256:${"1".repeat(64)}` })) });
  const guard = await createPolicyGuard({ client: changing.client, keyId: AGENT, pinnedHash: HASH });
  await refused(guard.check({ intent: bridgeIntent(), step: bridgeIntent().steps[0], payload: relayPayload(), signer }), "guard.pinnedHash");
  await assert.rejects(createPolicyGuard({ client: changing.client, keyId: AGENT, pinnedHash: "not-a-hash" }), TypeError);
  const revoked = guardClient({ read: policyRead({ keyActive: false }) });
  await assert.rejects(createPolicyGuard({ client: revoked.client, keyId: AGENT, pinnedHash: HASH }), (error) => error.code === "POLICY_OWNER_REVOKED");
  const ancestors = guardClient({ read: policyRead({ projectHash: `sha256:${"2".repeat(64)}` }) });
  await refused(createPolicyGuard({ client: ancestors.client, keyId: AGENT, pinnedHash: HASH, ancestorPins: { [PROJECT]: null } }), "guard.ancestorPins");
});

test("the guard accepts a valid Relay bridge and an Aave deposit", async () => {
  const { client } = guardClient();
  const guard = await createPolicyGuard({ client, keyId: AGENT, pinnedHash: HASH });
  await guard.check({ intent: bridgeIntent(), step: bridgeIntent().steps[0], payload: relayPayload(), signer });
  const aave = aaveIntent();
  await guard.check({ intent: aave, step: aave.steps[0], payload: payload([evmTx(USDC, approveData(AAVE_POOL, 100_000_000)), evmTx(AAVE_POOL, "0x617ba037", { nonce: "8" })]), signer });
});

test("the guard never signs keyless intents or another key's intents", async () => {
  const { client } = guardClient();
  const guard = await createPolicyGuard({ client, keyId: AGENT, pinnedHash: HASH });
  const keyless = bridgeIntent({ stamp: null });
  await refused(guard.check({ intent: keyless, step: keyless.steps[0], payload: relayPayload(), signer }), "guard.stamp");
  const foreign = bridgeIntent({ stamp: { outcome: "allow", keyId: OTHER_KEY } });
  await refused(guard.check({ intent: foreign, step: foreign.steps[0], payload: relayPayload(), signer }), "guard.stamp");
});

test("the guard refuses each payload problem", async () => {
  const { client } = guardClient();
  const guard = await createPolicyGuard({ client, keyId: AGENT, pinnedHash: HASH });
  const intent = bridgeIntent();
  const step = intent.steps[0];
  const max = (2n ** 256n - 1n).toString();
  await refused(guard.check({ intent, step, payload: payload([evmTx(USDC, approveData(RELAY_PROXY, 100_000_000)), evmTx(STRANGER, "0x12345678", { nonce: "8" })]), signer }), "payload.to");
  await refused(guard.check({ intent, step, payload: payload([evmTx(USDC, approveData(RELAY_PROXY, max)), evmTx(RELAY_ROUTER, "0x1234", { nonce: "8" })]), signer }), "payload.approve");
  await refused(guard.check({ intent, step, payload: payload([evmTx(USDC, approveData(STRANGER, 100_000_000)), evmTx(RELAY_ROUTER, "0x1234", { nonce: "8" })]), signer }), "payload.approve");
  await refused(guard.check({ intent, step, payload: relayPayload({ value: "1" }), signer }), "payload.value");
  await refused(guard.check({ intent, step, payload: relayPayload({ nonce: undefined }), signer }), "execution.pinNonce");
  await refused(guard.check({ intent, step, payload: relayPayload(), signer: { honorsNonce: false } }), "execution.pinNonce");
  await refused(guard.check({ intent, step, payload: relayPayload({ chainId: 1 }), signer }), "payload.chain");
  await refused(guard.check({ intent, step, payload: relayPayload({ from: STRANGER }), signer }), "payload.from");
  await refused(guard.check({ intent, step, payload: payload(relayPayload().transactions, [`sha256:${"3".repeat(64)}`]), signer }), "guard.clearance");
  const transfer = { ...intent, steps: [{ ...step, kind: "transfer", protocol: "evm-transfer", recipient: OWN_BASE, settlement: undefined, expectedOutput: undefined, minimumOutput: undefined }] };
  const pay = (to, amount) => `0xa9059cbb${word(to)}${word(BigInt(amount).toString(16))}`;
  await guard.check({ intent: transfer, step: transfer.steps[0], payload: payload([evmTx(USDC, pay(EVM, 100_000_000))]), signer });
  await refused(guard.check({ intent: transfer, step: transfer.steps[0], payload: payload([evmTx(USDC, pay(STRANGER, 100_000_000))]), signer }), "payload.transfer");
  await refused(guard.check({ intent: transfer, step: transfer.steps[0], payload: payload([evmTx(USDC, pay(EVM, 100_000_001))]), signer }), "payload.transfer");
});

test("the guard enforces the rule book itself (core evaluation) and the local network allowlist", async () => {
  const { client } = guardClient();
  const guard = await createPolicyGuard({ client, keyId: AGENT, pinnedHash: HASH });
  const big = bridgeIntent();
  big.steps[0].input = usdc(USDC_BASE, 2_000_000_000, 2000);
  await assert.rejects(guard.check({ intent: big, step: big.steps[0], payload: relayPayload(), signer }), (error) => error instanceof KletiaPolicyError && error.violations.some((violation) => violation.rule === "caps.perIntentUsd"));
  const local = await createPolicyGuard({ client, keyId: AGENT, pinnedHash: HASH, networks: ["base"] });
  await refused(local.check({ intent: bridgeIntent(), step: bridgeIntent().steps[0], payload: relayPayload(), signer }), "networks.allow");
});

test("confirm intents need an approved approval for exactly these steps", async () => {
  const held = bridgeIntent({ stamp: { outcome: "confirm", keyId: AGENT, approval: { id: APPROVAL, url: `https://kletiaai.xyz/approve#${APPROVAL}`, expiresAt: "x", ceilingUsd: "102.00", triggers: ["confirm.aboveUsd"] } } });
  const view = (status, digest = approvalDigest(held, AGENT)) => ({ id: APPROVAL, status, intentId: held.id, keyId: AGENT, digest, signing: { approvalId: APPROVAL, intentId: held.id, digest, ceilingUsdCents: "10200", maxExpiresAt: 0 } });
  for (const [status, rule] of [["pending", "approval.required"], ["rejected", "approval.rejected"], ["expired", "approval.expired"]]) {
    const { client } = guardClient({ approval: view(status) });
    const guard = await createPolicyGuard({ client, keyId: AGENT, pinnedHash: HASH });
    await refused(guard.check({ intent: held, step: held.steps[0], payload: relayPayload(), signer }), rule);
  }
  const stale = guardClient({ approval: view("approved", `0x${"4".repeat(64)}`) });
  await refused((await createPolicyGuard({ client: stale.client, keyId: AGENT, pinnedHash: HASH })).check({ intent: held, step: held.steps[0], payload: relayPayload(), signer }), "approval.stale");
  const good = guardClient({ approval: view("approved") });
  await (await createPolicyGuard({ client: good.client, keyId: AGENT, pinnedHash: HASH })).check({ intent: held, step: held.steps[0], payload: relayPayload(), signer });
});

function solanaTransaction({ signers = 1, payer = new Uint8Array(32).fill(7) } = {}) {
  const keys = [payer, ...Array.from({ length: signers }, (_, index) => new Uint8Array(32).fill(20 + index))].slice(0, Math.max(2, signers));
  const bytes = [signers, ...new Array(64 * signers).fill(0), 0x80, signers, 0, 1, keys.length, ...keys.flatMap((key) => [...key]), ...new Array(32).fill(1), 0, 0];
  return { base64: Buffer.from(bytes).toString("base64"), payer: encodeBase58(payer) };
}

test("Solana payloads: fee payer and a single signer only", async () => {
  const one = solanaTransaction();
  assert.deepEqual(solanaTransactionSigners(one.base64), { feePayer: one.payer, requiredSignatures: 1, version: 0 });
  assert.equal(solanaTransactionSigners(solanaTransaction({ signers: 2 }).base64).requiredSignatures, 2);
  const read = policyRead();
  const solAccount = `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${one.payer}`;
  const document = validatePolicy({ schema, accounts: { allow: [`solana:*:${one.payer}`] } }, { defaults: "agent" }).value;
  const hash = policyHash(document);
  const { client } = guardClient({ read: policyRead({ hash, document }) });
  const guard = await createPolicyGuard({ client, keyId: AGENT, pinnedHash: hash });
  const intent = {
    ...bridgeIntent(),
    request: { accounts: [solAccount] },
    policy: { ...bridgeIntent().policy, chain: [{ scope: "key", id: AGENT, version: 1, hash }] },
    steps: [{ id: "s1", index: 0, kind: "transfer", network: "solana", chain: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", account: solAccount, recipient: solAccount, protocol: "solana-transfer", mode: "wallet", dependsOn: [], status: "awaiting_signature", evidence: [], feesUsd: 0.001 }],
  };
  const sol = (base64, feePayer = one.payer) => ({ vm: "svm", transactions: [{ vm: "svm", network: "solana", feePayer, transaction: base64, encoding: "base64", description: "t" }], expiresAt: 0, quoteBinding: "q", policy: { decisionId: "pdc_0c5a9e1f4b7d2a8c3e6f9b01", exposureId: "px_1", notionalUsd: null, chainHashes: [hash] } });
  await guard.check({ intent, step: intent.steps[0], payload: sol(one.base64), signer: null });
  await refused(guard.check({ intent, step: intent.steps[0], payload: sol(solanaTransaction({ signers: 2 }).base64), signer: null }), "payload.signers");
  const otherPayer = solanaTransaction({ payer: new Uint8Array(32).fill(9) });
  await refused(guard.check({ intent, step: intent.steps[0], payload: sol(otherPayer.base64), signer: null }), "payload.from");
  assert.ok(read.policy);
});

test("executeIntent runs the guard before any wallet prompt", async () => {
  const intent = bridgeIntent();
  const reads = guardClient();
  const guard = await createPolicyGuard({ client: reads.client, keyId: AGENT, pinnedHash: HASH });
  let sends = 0;
  const api = new KletiaClient({
    baseUrl: "http://localhost:3001",
    fetch: async (url) => {
      if (url.endsWith("/prepare")) return jsonResponse(200, { intent, payload: payload([evmTx(USDC, approveData(STRANGER, 100_000_000)), evmTx(RELAY_ROUTER, "0x12", { nonce: "8" })]) });
      throw new Error(url);
    },
  });
  const ready = { ...intent, steps: [{ ...intent.steps[0], status: "ready" }] };
  await assert.rejects(
    executeIntent(api, ready, { evm: { address: EVM, honorsNonce: true, async sendTransaction() { sends += 1; return `0x${"a".repeat(64)}`; }, async waitForTransaction() {} } }, { policyGuard: guard }),
    (error) => error instanceof KletiaPolicyError && error.stage === "sign",
  );
  assert.equal(sends, 0);
});

test("a held intent: onApprovalRequired gets the approval and executeIntent returns; without it the KletiaPolicyError is thrown", async () => {
  const intent = { ...bridgeIntent(), steps: [{ ...bridgeIntent().steps[0], status: "ready" }] };
  const refusal = {
    error: {
      code: "POLICY_APPROVAL_REQUIRED",
      message: "held",
      issues: [{ path: "confirm.aboveUsd", message: "above" }],
      policy: { decisionId: "pdc_0c5a9e1f4b7d2a8c3e6f9b01", stage: "prepare", outcome: "deny", keyId: AGENT, violations: [{ rule: "approval.required", scope: "key", keyId: AGENT, message: "on hold" }], retryAt: null, approval: { id: APPROVAL, url: `https://kletiaai.xyz/approve#${APPROVAL}`, expiresAt: "2026-10-09T13:52:10Z", ceilingUsd: "102.00" } },
    },
  };
  const api = new KletiaClient({ baseUrl: "http://localhost:3001", fetch: async () => jsonResponse(403, refusal, { "retry-after": "15" }) });
  const seen = [];
  const returned = await executeIntent(api, intent, { evm: { address: EVM, async sendTransaction() { throw new Error("never"); }, async waitForTransaction() {} } }, { onApprovalRequired: (approval) => { seen.push(approval); } });
  assert.equal(returned.id, intent.id);
  assert.equal(seen[0].url, `https://kletiaai.xyz/approve#${APPROVAL}`);
  await assert.rejects(executeIntent(api, intent, { evm: { address: EVM, async sendTransaction() { throw new Error("never"); }, async waitForTransaction() {} } }), (error) => {
    assert.ok(error instanceof KletiaPolicyError);
    assert.equal(error.code, "POLICY_APPROVAL_REQUIRED");
    assert.equal(error.decisionId, "pdc_0c5a9e1f4b7d2a8c3e6f9b01");
    assert.equal(error.approval.id, APPROVAL);
    assert.equal(error.retryAfterSeconds, 15);
    assert.equal(error.retryable, true);
    return true;
  });
});

/* -------------------------------------------------------------- management */

test("policy, decision, spend, child key and approval routes send the documented requests", async () => {
  const calls = [];
  const client = new KletiaClient({
    baseUrl: "http://localhost:3001",
    apiKey: "kl_dev_test",
    fetch: async (url, init) => {
      const { pathname, search } = new URL(url);
      calls.push({ method: init.method, pathname, search, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
      const route = `${init.method} ${pathname}`;
      if (route === `PUT /v1/keys/${AGENT}/policy`) return jsonResponse(200, { policy: { version: 2 }, applied: "pending", tightened: [], loosened: ["caps.dailyUsd"], supersededPending: null, warnings: [] });
      if (route === `GET /v1/keys/${AGENT}/policy`) return jsonResponse(200, policyRead());
      if (route === `DELETE /v1/keys/${AGENT}/policy/pending`) return jsonResponse(200, { policy: { version: 2, status: "cancelled" } });
      if (route === `GET /v1/keys/${AGENT}/policy/versions`) return jsonResponse(200, { versions: [{ version: 1 }] });
      if (route === "PUT /v1/projects/current/policy") return jsonResponse(200, { policy: { version: 1 }, applied: "now", tightened: [], loosened: [], supersededPending: null, warnings: [] });
      if (route === "POST /v1/policy/validate") return jsonResponse(200, { valid: true, issues: [], warnings: [], hash: HASH });
      if (route === "POST /v1/policy/evaluate") return jsonResponse(200, { evaluation: { keyId: AGENT, outcome: "deny", rules: [], violations: [], triggers: [], warnings: [], code: "POLICY_VIOLATION", notionalUsd: "900.00", complete: true }, intent: null, planError: null });
      if (route === "GET /v1/policy/decisions") return jsonResponse(200, { decisions: [], head: null });
      if (route === "GET /v1/policy/spend") return jsonResponse(200, { spend: { keyId: AGENT, at: "x", scopes: [] } });
      if (route === `POST /v1/keys/${OTHER_KEY}/children`) return jsonResponse(201, { key: { id: AGENT, kind: "agent", key: "kl_agt_0123456789abcdefghijklmnopqrstuv" }, policy: { version: 1, hash: HASH } });
      if (route === `PATCH /v1/keys/${AGENT}`) return jsonResponse(200, { key: { id: AGENT } });
      if (route === "GET /v1/policy/approvals") return jsonResponse(200, { approvals: [] });
      if (route === `POST /v1/policy/approvals/${APPROVAL}/approve`) return jsonResponse(200, { approval: { id: APPROVAL, status: "approved" } });
      throw new Error(`unexpected ${route}`);
    },
  });
  const written = await client.policies.put(AGENT, AGENT_POLICY, { ifMatch: HASH });
  assert.equal(written.applied, "pending");
  assert.equal(calls[0].headers["if-match"], `"${HASH}"`);
  assert.match(calls[0].headers["idempotency-key"], UUID);
  assert.deepEqual(calls[0].body, AGENT_POLICY);
  assert.throws(() => client.policies.put(AGENT, AGENT_POLICY, { ifMatch: "v1" }), TypeError);
  assert.equal((await client.policies.get(AGENT)).effective.keyActive, true);
  assert.equal((await client.policies.cancelPending(AGENT)).status, "cancelled");
  await client.policies.versions(AGENT, { limit: 5 });
  assert.equal(calls.at(-1).search, "?limit=5");
  await client.policies.project.put(AGENT_POLICY, { ifMatch: "none" });
  assert.equal(calls.at(-1).headers["if-match"], '"none"');
  assert.equal((await client.policies.validate(AGENT_POLICY, { defaults: "agent", against: null })).valid, true);
  assert.deepEqual(calls.at(-1).body, { policy: AGENT_POLICY, against: null, defaults: "agent" });
  const evaluation = await client.policies.evaluate({ keyId: AGENT, request: { text: "bridge 900 USDC from base to arbitrum", accounts: [OWN_BASE] }, stage: "plan" });
  assert.equal(evaluation.evaluation.outcome, "deny");
  assert.equal(calls.at(-1).headers["idempotency-key"], undefined, "the simulator is never replayed");
  await client.policies.decisions({ keyId: AGENT, outcome: "deny", limit: 50 });
  assert.equal(calls.at(-1).search, `?keyId=${AGENT}&outcome=deny&limit=50`);
  await client.policies.spend(AGENT);
  assert.equal(calls.at(-1).search, `?keyId=${AGENT}`);
  const child = await client.keys.createChild(OTHER_KEY, { name: "research-bot", template: "payments-agent", fill: { recipients: [OWN_ARB] }, expiresInSeconds: 30 * 86_400 });
  assert.equal(child.key.kind, "agent");
  assert.match(calls.at(-1).headers["idempotency-key"], UUID);
  await client.keys.update(AGENT, { expiresAt: "2026-11-01T00:00:00Z" });
  assert.deepEqual(calls.at(-1).body, { expiresAt: "2026-11-01T00:00:00Z" });
  await client.approvals.list({ role: "approver", status: "pending" });
  assert.equal(calls.at(-1).search, "?role=approver&status=pending");
  assert.equal((await client.approvals.approve(APPROVAL)).status, "approved");
  await assert.rejects(client.approvals.get("apr_bad"), TypeError);
});

test("rule book removals are not retried automatically (a lost response could remove twice)", async () => {
  let count = 0;
  const client = new KletiaClient({ baseUrl: "http://localhost:3001", apiKey: "kl_dev_test", retryBaseDelayMs: 1, fetch: async () => { count += 1; return jsonResponse(503, { error: { code: "STORE_UNAVAILABLE", message: "down" } }); } });
  await assert.rejects(client.policies.delete(AGENT), (error) => error.code === "STORE_UNAVAILABLE");
  assert.equal(count, 1);
});

test("verifyDecisionChain (re-exported) checks a decision page's hash chain", () => {
  const records = [];
  let previous = POLICY_DECISION_GENESIS;
  for (let seq = 1; seq <= 3; seq += 1) {
    const record = { id: `pdc_${String(seq).padStart(24, "0")}`, at: "2026-10-09T12:00:00.000Z", stage: "plan", outcome: "allow", projectId: PROJECT, keyId: AGENT, actorKeyId: AGENT, dryRun: false, chain: [], violations: [], triggers: [], warnings: [], requestDigest: `sha256:${"0".repeat(64)}` };
    const chainHash = policyDecisionChainHash(previous, record);
    records.push({ ...record, seq, prevHash: previous, chainHash });
    previous = chainHash;
  }
  assert.equal(verifyDecisionChain(records).valid, true);
  const broken = records.map((record, index) => (index === 1 ? { ...record, outcome: "deny" } : record));
  assert.equal(verifyDecisionChain(broken).valid, false);
});

/* ------------------------------------------------------- wallet approvals */

function approvalApi(intent, { digest } = {}) {
  const calls = [];
  const realDigest = approvalDigest(intent, AGENT);
  const shown = digest ?? realDigest;
  const view = { id: APPROVAL, status: "pending", intentId: intent.id, keyId: AGENT, title: "Bridge 100 USDC", steps: [], recipients: [], notionalUsd: "100.00", ceilingUsd: "102.00", triggers: ["confirm.aboveUsd"], digest: shown, expiresAt: "2026-10-09T13:52:10Z", createdAt: "x", decidedAt: null, decidedBy: null, approvers: { requireWallet: true, wallets: [], keys: 0 }, signing: { approvalId: APPROVAL, intentId: intent.id, digest: shown, ceilingUsdCents: "10200", maxExpiresAt: 1791560000 } };
  const client = new KletiaClient({
    baseUrl: "http://localhost:3001",
    fetch: async (url, init) => {
      const { pathname } = new URL(url);
      calls.push({ method: init.method, pathname, body: init.body ? JSON.parse(init.body) : undefined });
      if (pathname === `/v1/policy/approvals/${APPROVAL}` && init.method === "GET") return jsonResponse(200, { approval: view });
      if (pathname === `/v1/intents/${intent.id}`) return jsonResponse(200, { intent });
      if (pathname.startsWith(`/v1/policy/approvals/${APPROVAL}/`)) return jsonResponse(200, { approval: { ...view, status: pathname.endsWith("approve") ? "approved" : "rejected" } });
      throw new Error(pathname);
    },
  });
  return { client, calls, view };
}

test("approveWithWallet: an EIP-712 signer signs exactly core's typed data, verified by viem", async () => {
  const { privateKeyToAccount } = await import("viem/accounts");
  const { verifyTypedData } = await import("viem");
  const wallet = privateKeyToAccount(`0x${"42".repeat(32)}`);
  const intent = bridgeIntent();
  const api = approvalApi(intent);
  const now = () => 1791550000_000;
  let signed = 0;
  const result = await api.client.approvals.approveWithWallet(APPROVAL, { account: `eip155:8453:${wallet.address}`, signTypedData: (typed) => { signed += 1; return wallet.signTypedData(typed); } }, { now });
  assert.equal(result.status, "approved");
  const post = api.calls.find((call) => call.method === "POST");
  assert.equal(post.pathname, `/v1/policy/approvals/${APPROVAL}/approve`);
  assert.equal(post.body.account, `eip155:8453:${wallet.address}`);
  assert.equal(post.body.expiresAt, 1791550600);
  const typed = approvalTypedData({ approvalId: APPROVAL, intentId: intent.id, digest: api.view.digest, ceilingUsdCents: "10200", decision: "approve", expiresAt: 1791550600, signer: post.body.account });
  assert.equal(await verifyTypedData({ address: wallet.address, signature: post.body.signature, ...typed }), true);
  assert.equal(await verifyTypedData({ address: wallet.address, signature: post.body.signature, ...approvalTypedData({ approvalId: APPROVAL, intentId: intent.id, digest: api.view.digest, ceilingUsdCents: "10201", decision: "approve", expiresAt: 1791550600, signer: post.body.account }) }), false);
  assert.equal(signed, 1);
  // A digest that is not the intent's is never signed.
  const lying = approvalApi(intent, { digest: `0x${"6".repeat(64)}` });
  await assert.rejects(lying.client.approvals.approveWithWallet(APPROVAL, { account: `eip155:8453:${wallet.address}`, signTypedData: () => { signed += 1; return "0x"; } }, { now }), (error) => error instanceof KletiaApiError && error.code === "APPROVAL_SIGNATURE_INVALID");
  assert.equal(signed, 1);
  assert.equal(lying.calls.some((call) => call.method === "POST"), false);
});

test("rejectWithWallet: a Solana signer signs core's message text", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const address = encodeBase58(new Uint8Array(raw));
  const intent = bridgeIntent();
  const api = approvalApi(intent);
  const now = () => 1791550000_000;
  await api.client.approvals.rejectWithWallet(APPROVAL, { account: `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${address}`, signMessage: async (message) => new Uint8Array(nodeSign(null, message, privateKey)) }, { now, validForSeconds: 120 });
  const post = api.calls.find((call) => call.method === "POST");
  assert.equal(post.pathname, `/v1/policy/approvals/${APPROVAL}/reject`);
  const text = approvalMessageText({ approvalId: APPROVAL, intentId: intent.id, digest: api.view.digest, ceilingUsdCents: "10200", decision: "reject", expiresAt: 1791550120 });
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
  assert.equal(nodeVerify(null, Buffer.from(text), key, Buffer.from(decodeBase58(post.body.signature))), true);
});

test("eip1193ApprovalSigner switches to the account's chain and sends eth_signTypedData_v4 JSON", async () => {
  const requests = [];
  let chain = "0x1";
  const provider = {
    async request({ method, params }) {
      requests.push({ method, params });
      if (method === "eth_chainId") return chain;
      if (method === "wallet_switchEthereumChain") { chain = params[0].chainId; return null; }
      if (method === "eth_signTypedData_v4") return `0x${"ab".repeat(65)}`;
      throw new Error(method);
    },
  };
  const approver = eip1193ApprovalSigner(provider, OWN_BASE);
  const typed = approvalTypedData({ approvalId: APPROVAL, intentId: "int_guard", digest: `0x${"7".repeat(64)}`, ceilingUsdCents: "10200", decision: "approve", expiresAt: 1791550600, signer: OWN_BASE });
  await approver.signTypedData(typed);
  const call = requests.find((entry) => entry.method === "eth_signTypedData_v4");
  assert.equal(call.params[0], EVM);
  const json = JSON.parse(call.params[1]);
  assert.deepEqual(json.types.EIP712Domain.map((field) => field.name), ["name", "version", "chainId"]);
  assert.equal(json.message.ceilingUsdCents, "10200");
  assert.equal(json.domain.chainId, 8453);
  assert.equal(chain, "0x2105");
  assert.throws(() => eip1193ApprovalSigner(provider, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"), TypeError);
});
