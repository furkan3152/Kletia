import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { POLICY_DECISION_GENESIS, approvalDigest, policyDecisionChainHash, policyHash, validatePolicy } from "@kletia/core";
import { cli, send, stubServer } from "./helpers.mjs";

const API_KEY = "kl_dev_abcdefghijklmnopqrstuvwxyz012345";
const AGENT_SECRET = "kl_agt_0123456789abcdefghijklmnopqrstuv";
const PROJECT_KEY = "key_7d2e0000000000000000aa00";
const AGENT = "key_9a7f0000000000000000aa01";
const PROJECT = "prj_1a2b0000000000000000aa00";
const APPROVAL = `apr_${"5".repeat(32)}`;
const EVM = "0x8f3c0000000000000000000000000000000aa21b";
const schema = "kletia.policy/v1";
const keyed = { KLETIA_API_KEY: API_KEY };

const ACTIVE = validatePolicy({ schema, caps: { dailyUsd: "1000" }, amendments: { delaySeconds: 3600 } }, { defaults: "agent" }).value;
const ACTIVE_HASH = policyHash(ACTIVE);
const intent = {
  spec: "kletia.intent/v1", id: "int_held", status: "planned", request: { accounts: [`eip155:8453:${EVM}`] }, edges: [], summary: { title: "Send 900 USDC" },
  steps: [{ id: "s1", index: 0, kind: "transfer", network: "base", account: `eip155:8453:${EVM}`, recipient: "eip155:8453:0x9999999999999999999999999999999999999999", protocol: "evm-transfer", mode: "wallet", status: "ready", dependsOn: [], evidence: [], input: { asset: "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", symbol: "USDC", decimals: 6, amount: "900000000", formatted: "900" } }],
};
let approvalDigestShown = approvalDigest(intent, AGENT);

function decisions(tamper = false) {
  const out = [];
  let previous = POLICY_DECISION_GENESIS;
  for (let seq = 1; seq <= 3; seq += 1) {
    const record = { id: `pdc_${String(seq).padStart(24, "0")}`, at: "2026-10-09T12:00:00.000Z", stage: "plan", outcome: seq === 2 ? "deny" : "allow", projectId: PROJECT, keyId: AGENT, actorKeyId: AGENT, dryRun: false, chain: [], violations: seq === 2 ? [{ rule: "recipients.mode", scope: "key", keyId: AGENT, message: "Recipient is not one of the request's accounts." }] : [], triggers: [], warnings: [], requestDigest: `sha256:${"0".repeat(64)}` };
    const chainHash = policyDecisionChainHash(previous, record);
    out.push({ ...record, seq, prevHash: previous, chainHash });
    previous = chainHash;
  }
  if (tamper) out[1] = { ...out[1], outcome: "allow" };
  return out.reverse();
}
let tamperedLog = false;

let api;
let dir;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "kletia-cli-policy-"));
  api = await stubServer(async (request, res) => {
    const route = `${request.method} ${request.path}`;
    if (request.headers.authorization !== `Bearer ${API_KEY}` && !route.startsWith("GET /v1/policy/approvals/apr_") && !route.startsWith("GET /v1/intents/")) {
      return send(res, 401, { error: { code: "API_KEY_REQUIRED", message: "key" } });
    }
    if (route === `GET /v1/keys/${AGENT}/policy`) {
      return send(res, 200, {
        policy: { scope: "key", keyId: AGENT, version: 1, hash: ACTIVE_HASH, status: "active", document: ACTIVE, activatesAt: null, loosened: [], tightened: [], createdAt: "x", createdBy: PROJECT_KEY, pending: null },
        effective: { keyActive: true, chain: [{ scope: "key", id: AGENT, version: 1, hash: ACTIVE_HASH }], defaults: "agent", levels: [{ scope: "project", id: PROJECT, version: null, hash: null, defaults: "project", document: null }, { scope: "key", id: AGENT, version: 1, hash: ACTIVE_HASH, defaults: "agent", document: ACTIVE }] },
      });
    }
    if (route === `PUT /v1/keys/${AGENT}/policy`) {
      return send(res, 200, { policy: { scope: "key", keyId: AGENT, version: 2, hash: policyHash(request.body), status: "pending", document: request.body, activatesAt: "2026-10-09T13:00:00.000Z", loosened: ["caps.dailyUsd"], tightened: [], createdAt: "x", createdBy: PROJECT_KEY }, applied: "pending", tightened: [], loosened: ["caps.dailyUsd"], supersededPending: null, warnings: [] });
    }
    if (route === `POST /v1/keys/${PROJECT_KEY}/children`) {
      return send(res, 201, { key: { id: AGENT, name: request.body.name, tier: "developer", kind: "agent", parentId: PROJECT_KEY, depth: 1, createdAt: "x", expiresAt: "2026-11-08T12:00:00.000Z", key: AGENT_SECRET }, policy: { scope: "key", keyId: AGENT, version: 1, hash: ACTIVE_HASH, status: "active", warnings: [] } });
    }
    if (route === "GET /v1/keys") {
      return send(res, 200, { keys: [
        { id: PROJECT_KEY, name: "backend", tier: "developer", last4: "2345", createdAt: "", lastUsedAt: null, rotatedAt: null, previousExpiresAt: null, revokedAt: null, current: true, kind: "project", parentId: null, depth: 0, expiresAt: null, policyVersion: null, descendants: 1 },
        { id: AGENT, name: `research-bot ${AGENT_SECRET}`, tier: "developer", last4: "stuv", createdAt: "", lastUsedAt: null, rotatedAt: null, previousExpiresAt: null, revokedAt: null, current: false, kind: "agent", parentId: PROJECT_KEY, depth: 1, expiresAt: "2026-11-08T12:00:00.000Z", policyVersion: 1, descendants: 0 },
      ] });
    }
    if (route === "POST /v1/policy/evaluate") {
      const deny = request.body.request.text.includes("900");
      return send(res, 200, { evaluation: { keyId: AGENT, decisionId: "pdc_000000000000000000000009", outcome: deny ? "deny" : "allow", notionalUsd: deny ? "900.00" : "20.00", code: deny ? "POLICY_VIOLATION" : null, complete: true, warnings: [], violations: [], triggers: [], rules: [
        { rule: "networks.allow", scope: "key", keyId: AGENT, status: "pass", observed: "base", limit: "base" },
        { rule: "caps.perIntentUsd", scope: "key", keyId: AGENT, status: deny ? "fail" : "pass", observed: deny ? "900.00" : "20.00", limit: "100.00" },
      ], schedule: [] }, intent: null, planError: null });
    }
    if (route === "GET /v1/policy/decisions") return send(res, 200, { decisions: decisions(tamperedLog), head: { seq: 3, chainHash: decisions()[0].chainHash } });
    if (route === `GET /v1/policy/approvals/${APPROVAL}`) {
      return send(res, 200, { approval: { id: APPROVAL, status: "pending", intentId: intent.id, keyId: AGENT, title: "Send 900 USDC", steps: [{ id: "s1", kind: "transfer", network: "base", protocol: "evm-transfer", input: "900 USDC", recipient: intent.steps[0].recipient }], recipients: [], notionalUsd: "900.00", ceilingUsd: "918.00", triggers: ["confirm.aboveUsd"], digest: approvalDigestShown, expiresAt: "2026-10-09T13:52:10Z", createdAt: "x", decidedAt: null, decidedBy: null, approvers: { requireWallet: false, wallets: [], keys: 0 }, signing: { approvalId: APPROVAL, intentId: intent.id, digest: approvalDigestShown, ceilingUsdCents: "91800", maxExpiresAt: 0 } } });
    }
    if (route === `GET /v1/intents/${intent.id}`) return send(res, 200, { intent });
    if (route === `POST /v1/policy/approvals/${APPROVAL}/approve`) return send(res, 200, { approval: { id: APPROVAL, status: "approved" } });
    if (route === "POST /v1/intents") {
      return send(res, 403, { error: { code: "POLICY_VIOLATION", message: "The rule book of key_9a7f… refused this intent.", issues: [{ path: "steps[0].recipient", message: "Recipient is not one of the request's accounts. (recipients.mode)" }], policy: { decisionId: "pdc_0c5a9e1f4b7d2a8c3e6f9b01", stage: "plan", outcome: "deny", keyId: AGENT, violations: [{ rule: "recipients.mode", scope: "key", keyId: AGENT, path: "steps[0].recipient", message: "Recipient is not one of the request's accounts.", observed: "eip155:8453:0x9999…", limit: "own" }], retryAt: null } } });
    }
    return false;
  });
});

after(() => api.close());

async function file(value) {
  const path = join(dir, `${Math.random().toString(36).slice(2)}.json`);
  await writeFile(path, JSON.stringify(value));
  return path;
}

test("policy validate is local: hash and warnings, invalid exits 1, no request", async () => {
  const before = api.requests.length;
  const ok = await cli(["policy", "validate", "--file", await file({ schema, caps: { dailyUsd: "500" } }), "--defaults", "agent"]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /^valid {2}sha256:[0-9a-f]{64}$/mu);
  assert.match(ok.stdout, /warning ACCOUNTS_NOT_PINNED/u);
  const bad = await cli(["policy", "validate", "--file", await file({ schema, caps: { dailyUsd: "lots" } })]);
  assert.equal(bad.code, 1);
  assert.match(bad.stdout, /INVALID\n {2}caps\.dailyUsd/u);
  assert.equal(api.requests.length, before);
});

test("policy validate --against shows what tightens and loosens", async () => {
  const result = await cli(["policy", "validate", "--file", await file({ schema, caps: { dailyUsd: "5000" }, amendments: { delaySeconds: 3600 } }), "--against", AGENT], { base: api.base, env: keyed });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /loosens: caps\.dailyUsd/u);
  assert.match(result.stdout, /Loosening waits 3600s/u);
});

test("policy set shows the diff, sends If-Match and says when a loosening applies", async () => {
  const result = await cli(["policy", "set", AGENT, "--file", await file({ schema, caps: { dailyUsd: "5000" }, amendments: { delaySeconds: 3600 } }), "--if-match", ACTIVE_HASH], { base: api.base, env: keyed });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /loosens: caps\.dailyUsd/u);
  assert.match(result.stdout, /v2 is pending until 2026-10-09 13:00:00Z/u);
  const put = api.requests.at(-1);
  assert.equal(put.method, "PUT");
  assert.equal(put.headers["if-match"], `"${ACTIVE_HASH}"`);
  assert.match(put.headers["idempotency-key"], /^[0-9a-f-]{36}$/u);
  const invalid = await cli(["policy", "set", AGENT, "--file", await file({ schema, mode: "sometimes" })], { base: api.base, env: keyed });
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /POLICY_INVALID/u);
  assert.match(invalid.stderr, /nothing was sent/u);
});

test("keys create-agent refuses an unfilled template locally, then prints the agent secret once", async () => {
  const before = api.requests.length;
  const unfilled = await cli(["keys", "create-agent", "--parent", PROJECT_KEY, "--name", "research-bot", "--template", "payments-agent", "--reveal"], { base: api.base, env: keyed });
  assert.equal(unfilled.code, 1);
  assert.match(unfilled.stderr, /POLICY_INVALID/u);
  assert.match(unfilled.stderr, /recipients\.allow/u);
  assert.equal(api.requests.length, before, "nothing sent");
  const created = await cli(
    ["keys", "create-agent", "--parent", PROJECT_KEY, "--name", "research-bot", "--template", "payments-agent", "--account", `eip155:*:${EVM}`, "--recipient", "eip155:*:0x9999999999999999999999999999999999999999", "--approver-wallet", "eip155:8453:0x4b2000000000000000000000000000000000d9c1", "--expires", "30d", "--reveal"],
    { base: api.base, env: keyed, tty: true },
  );
  assert.equal(created.code, 0, created.stderr);
  assert.equal(created.stdout.trim(), AGENT_SECRET, "the secret once, on stdout");
  assert.match(created.stderr, new RegExp(`Created agent key ${AGENT}.*rule book v1 ${ACTIVE_HASH}`, "u"));
  const body = api.requests.at(-1).body;
  assert.equal(body.template, "payments-agent");
  assert.equal(body.expiresInSeconds, 2_592_000);
  assert.deepEqual(body.fill.accounts, [`eip155:*:${EVM}`]);
  const tty = await cli(["keys", "create-agent", "--parent", PROJECT_KEY, "--name", "x", "--policy", await file({ schema })], { base: api.base, env: keyed, tty: true });
  assert.equal(tty.code, 64, "a secret is never printed on a terminal by surprise");
});

test("keys tree draws agents under their parents and never prints an agent secret", async () => {
  const result = await cli(["keys", "tree"], { base: api.base, env: keyed });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^${PROJECT_KEY} \\*  backend  project  no rule book  no expiry$`, "mu"));
  assert.match(result.stdout, new RegExp(`^└─ ${AGENT}  research-bot kl_agt_…stuv  agent  rule book v1  expires 2026-11-08 12:00:00Z$`, "mu"));
  assert.equal(result.stdout.includes(AGENT_SECRET), false);
});

test("policy evaluate lists every rule; deny exits 1", async () => {
  const allow = await cli(["policy", "evaluate", AGENT, "--text", "send 20 USDC to myself", "--account", `base:${EVM}`], { base: api.base, env: keyed });
  assert.equal(allow.code, 0, allow.stderr);
  assert.match(allow.stdout, /^ALLOW {2}notional \$20\.00/mu);
  const deny = await cli(["policy", "evaluate", AGENT, "--text", "send 900 USDC to 0x99", "--account", `base:${EVM}`, "--at", "2026-10-10T07:30:00Z"], { base: api.base, env: keyed });
  assert.equal(deny.code, 1);
  assert.match(deny.stdout, /^DENY \(POLICY_VIOLATION\)/mu);
  assert.match(deny.stdout, /^fail\s+caps\.perIntentUsd\s+key_9a7f0000000000000000aa01\s+900\.00\s+100\.00/mu);
  assert.equal(api.requests.at(-1).body.at, "2026-10-10T07:30:00.000Z");
});

test("policy decisions --verify-chain recomputes the hash chain (exit 3 when broken)", async () => {
  tamperedLog = false;
  const ok = await cli(["policy", "decisions", "--verify-chain"], { base: api.base, env: keyed });
  assert.equal(ok.code, 0, ok.stdout);
  assert.match(ok.stdout, /chain valid up to 3/u);
  assert.match(ok.stdout, /^2\s+2026-10-09 12:00:00Z\s+plan\s+deny\s+key_9a7f\S+\s+-\s+recipients\.mode$/mu);
  tamperedLog = true;
  const broken = await cli(["policy", "decisions", "--verify-chain"], { base: api.base, env: keyed });
  assert.equal(broken.code, 3);
  assert.match(broken.stdout, /chain BROKEN/u);
  tamperedLog = false;
});

test("approvals approve shows the request, needs --yes and refuses a digest that is not the intent's", async () => {
  const shown = await cli(["approvals", "approve", APPROVAL], { base: api.base, env: keyed });
  assert.equal(shown.code, 64);
  assert.match(shown.stdout, /Send 900 USDC/u);
  assert.match(shown.stderr, /pass --yes/u);
  assert.equal(api.requests.some((request) => request.method === "POST" && request.path.endsWith("/approve")), false);
  const approved = await cli(["approvals", "approve", APPROVAL, "--yes"], { base: api.base, env: keyed });
  assert.equal(approved.code, 0, approved.stderr);
  assert.match(approved.stdout, /approved\.$/mu);
  approvalDigestShown = `0x${"6".repeat(64)}`;
  const forged = await cli(["approvals", "approve", APPROVAL, "--yes"], { base: api.base, env: keyed });
  assert.equal(forged.code, 1);
  assert.match(forged.stderr, /APPROVAL_SIGNATURE_INVALID/u);
  approvalDigestShown = approvalDigest(intent, AGENT);
});

test("Rule Book refusals print their rule ids, path, observed value and decision", async () => {
  const result = await cli(["plan", "send 900 USDC to 0x99", "--account", `base:${EVM}`, "--save"], { base: api.base, env: keyed });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /POLICY_VIOLATION \(HTTP 403\)/u);
  assert.match(result.stderr, /rule recipients\.mode \(key_9a7f0000000000000000aa01\): Recipient is not one of the request's accounts\. \[observed eip155:8453:0x9999…, limit own\]/u);
  assert.match(result.stderr, /decision pdc_0c5a9e1f4b7d2a8c3e6f9b01/u);
  const json = await cli(["plan", "send 900 USDC", "--account", `base:${EVM}`, "--save", "--json"], { base: api.base, env: keyed });
  assert.equal(JSON.parse(json.stderr).error.policy.violations[0].rule, "recipients.mode");
});

test("policy template lists templates and prints one", async () => {
  const list = await cli(["policy", "template"]);
  assert.match(list.stdout, /payments-agent\s+accounts\.allow,recipients\.allow,confirm\.approvers\.wallets/u);
  const one = await cli(["policy", "template", "treasury-rebalancer"]);
  assert.equal(JSON.parse(one.stdout).label, "Treasury rebalancer");
  assert.match(one.stderr, /Fill before use: accounts\.allow/u);
  assert.equal((await cli(["policy", "template", "nope"])).code, 64);
});
