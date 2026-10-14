/**
 * Publishable keys and flows: issuance (kl_pub_, shown once, hashed, at
 * most 5, revoked with the parent), the route allowlist, the origin rule
 * (Origin, or a first-party Origin with Kletia-Host-Origin), the per-key
 * and per-IP limits, the profile, owned intents (listed with ?owner=,
 * routed to the parent's subtree webhooks), flow sessions (single use,
 * 600 s, owned by the publishable key) and the contract authority of a
 * flow (the saver's registrations; never the publishable key's own),
 * against the offline EVM world.
 *
 *   cd apps/api && node --import tsx --test src/platform/http/__tests__/publishable.test.ts
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { PUBLISHABLE_KEY_PATTERN, type IntentGraph, type ProjectProfile, type ProjectView, type SessionView } from "@kletia/core";
import { EVM_ACCOUNT, resetEngine, SOL_ACCOUNT } from "../../engine/__tests__/helpers.js";
import { sha256Hex } from "../secrets.js";
import { assertError, call, serve, useTestEnvironment, type TestServer } from "./support.js";

useTestEnvironment();
delete process.env.KLETIA_CONTRACTS_ENABLED;

const { createPlatformRouter, platformErrorHandler } = await import("../index.js");
const { apiKeyStore, issueDeveloperKey, issueAgentKey } = await import("../auth.js");
const { publishableAddressLimiter, TIER_LIMITS } = await import("../limits.js");
const projects = await import("../projects.js");
const sessions = await import("../sessions.js");
const { dispatchTargets } = await import("../dispatcher.js");
const { configurePlatform, createIntentDetailed, prepareStep, getIntentStore } = await import("../../engine/service.js");
const harnessModule = await import("../../engine/__tests__/contractHarness.js");

const SITE = "https://shop.example";
const FIRST_PARTY = "https://kletiaai.xyz";
const SWAP = { text: "swap 1 SOL to USDC", accounts: [SOL_ACCOUNT] };

let server: TestServer;

interface Project {
  readonly owner: { id: string; key: string };
  readonly pub: { id: string; key: string };
}

async function projectKey(name: string): Promise<{ id: string; key: string }> {
  const issued = await issueDeveloperKey(name);
  return { id: issued.id, key: issued.key };
}

async function settle(key: string, patch: Record<string, unknown>): Promise<ProjectView> {
  const current = await call<{ project: ProjectView }>(server, "GET", "/projects/current", { key });
  const reply = await call<{ project: ProjectView }>(server, "PATCH", "/projects/current", { key, body: patch, headers: { "if-match": `"${current.body.project.hash}"` } });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return reply.body.project;
}

async function publishable(key: string, label = "website"): Promise<{ id: string; key: string; kind: string; parentId: string; label: string }> {
  const reply = await call<{ key: { id: string; key: string; kind: string; parentId: string; label: string } }>(server, "POST", "/projects/current/publishable-keys", { key, body: { label } });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return reply.body.key;
}

async function newProject(settings: Record<string, unknown> = {}): Promise<Project> {
  const owner = await projectKey("acme");
  await settle(owner.key, { allowedOrigins: [SITE, "http://localhost:3000"], ...settings });
  const pub = await publishable(owner.key);
  return { owner, pub };
}

/** A call with a publishable key from a browser page on `origin`. */
function browser(key: string, origin = SITE, headers: Record<string, string> = {}) {
  return { key, headers: { origin, ...headers } };
}

before(async () => {
  resetEngine();
  server = await serve((app) => {
    app.use("/v1", createPlatformRouter(), platformErrorHandler);
  });
});

after(async () => {
  await server.close();
});

beforeEach(() => {
  publishableAddressLimiter.reset();
});

describe("issuing publishable keys", () => {
  it("shows a kl_pub_ key once, stores only its hash, and lists it as kind publishable under the project key", async () => {
    const owner = await projectKey("issuer");
    const pub = await publishable(owner.key, "website");
    assert.match(pub.key, PUBLISHABLE_KEY_PATTERN);
    assert.equal(pub.kind, "publishable");
    assert.equal(pub.parentId, owner.id);
    assert.equal(pub.label, "website");
    const match = await apiKeyStore().findByHash(sha256Hex(pub.key), Date.now());
    assert.equal(match?.record.id, pub.id);
    assert.equal(match?.record.kind, "publishable");
    assert.deepEqual(match?.record.lineage, [owner.id]);
    const listed = await call<{ keys: { id: string; kind: string; parentId: string | null; key?: string; policyVersion: number | null }[] }>(server, "GET", "/keys", { key: owner.key });
    const row = listed.body.keys.find((entry) => entry.id === pub.id);
    assert.equal(row?.kind, "publishable");
    assert.equal(row?.parentId, owner.id);
    assert.equal(row?.policyVersion, 1, "a first rule book is written with the key");
    assert.equal(JSON.stringify(listed.body).includes(pub.key), false, "the secret is never listed");
  });

  it("derives the key's rule book from the project defaults", async () => {
    const owner = await projectKey("defaults");
    await settle(owner.key, { defaults: { lane: "testnet", networks: ["arbitrum-sepolia"], actions: ["swap", "bridge"] } });
    const pub = await publishable(owner.key);
    const policy = await call<{ policy: { document: { networks?: { allow?: string[]; lanes?: string[] }; kinds?: { allow?: string[] }; permissions?: Record<string, boolean> } } }>(server, "GET", `/keys/${pub.id}/policy`, { key: owner.key });
    assert.equal(policy.status, 200, JSON.stringify(policy.body));
    const document = policy.body.policy.document;
    assert.deepEqual(document.networks?.allow, ["arbitrum-sepolia"]);
    assert.deepEqual(document.networks?.lanes, ["testnet"]);
    assert.deepEqual([...(document.kinds?.allow ?? [])].sort(), ["bridge", "swap"]);
    assert.equal(document.permissions?.storeIntents, true);
  });

  it("allows at most 5 active per project, only to project keys with their current secret", async () => {
    const owner = await projectKey("cap");
    for (let index = 0; index < 5; index += 1) await publishable(owner.key, `site-${index}`);
    assertError(await call(server, "POST", "/projects/current/publishable-keys", { key: owner.key, body: { label: "sixth" } }), 409, "KEY_LIMIT_REACHED");
    assertError(await call(server, "POST", "/projects/current/publishable-keys", { key: owner.key, body: { label: "" } }), 400, "INVALID_REQUEST");
    const parent = await apiKeyStore().findById(owner.id);
    assert.ok(parent);
    const agent = await issueAgentKey("bot", parent, new Date(Date.now() + 3_600_000).toISOString(), 100);
    assertError(await call(server, "POST", "/projects/current/publishable-keys", { key: agent.key, body: { label: "x" } }), 403, "AGENT_KEY_FORBIDDEN");
  });

  it("is revoked with its parent (cascade)", async () => {
    const { owner, pub } = await newProject();
    assert.equal((await call(server, "GET", "/publishable/profile", browser(pub.key))).status, 200);
    assert.equal((await call(server, "DELETE", `/keys/${owner.id}`, { key: owner.key })).status, 204);
    assertError(await call(server, "GET", "/publishable/profile", browser(pub.key)), 401, "INVALID_API_KEY");
  });
});

describe("what a publishable key may call", () => {
  it("refuses every server-only route with PUBLISHABLE_KEY_FORBIDDEN", async () => {
    const { pub } = await newProject();
    for (const [method, path, body] of [
      ["GET", "/keys"],
      ["POST", "/keys", { name: "x" }],
      ["GET", "/webhooks"],
      ["POST", "/webhooks", { url: "https://hooks.example/k" }],
      ["GET", "/contracts"],
      ["GET", "/usage"],
      ["GET", "/intents"],
      ["GET", "/projects/current"],
      ["PATCH", "/projects/current", {}],
      ["POST", "/projects/current/publishable-keys", { label: "x" }],
      ["GET", "/events"],
      ["GET", "/threads"],
      ["POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }],
      ["POST", "/policy/approvals/apr_00000000000000000000000000000000/approve", {}],
      ["GET", "/policy/decisions"],
      ["POST", "/links", {}],
    ] as const) {
      assertError(await call(server, method, path, { ...browser(pub.key), ...(body ? { body } : {}) }), 403, "PUBLISHABLE_KEY_FORBIDDEN");
    }
  });

  it("serves the public tier, the profile and owned intents", async () => {
    const { owner, pub } = await newProject({ brand: { name: "Acme Store", website: "https://acme.example" }, defaults: { lane: "production", networks: ["solana", "base"], examples: ["swap 1 SOL to USDC"] } });
    assert.equal((await call(server, "GET", "/networks", browser(pub.key))).status, 200);
    const profile = await call<{ profile: ProjectProfile }>(server, "GET", "/publishable/profile", browser(pub.key));
    assert.equal(profile.status, 200);
    assert.deepEqual(profile.body.profile.brand, { name: "Acme Store", host: "acme.example", verified: false });
    assert.equal(profile.body.profile.projectId, `prj_${owner.id}`);
    assert.equal(profile.body.profile.lane, "production");
    assert.deepEqual(profile.body.profile.defaults.networks, ["solana", "base"]);
    assert.equal(JSON.stringify(profile.body).includes("ownerKeyId"), false, "who saved a flow is never revealed");
    const dry = await call<{ intent: IntentGraph }>(server, "POST", "/intents?dryRun=true", { ...browser(pub.key), body: SWAP });
    assert.equal(dry.status, 200, JSON.stringify(dry.body));
    const stored = await call<{ intent: IntentGraph }>(server, "POST", "/intents", { ...browser(pub.key), body: SWAP });
    assert.equal(stored.status, 201, JSON.stringify(stored.body));
    assert.equal(await getIntentStore().ownerOf(stored.body.intent.id), pub.id, "owned by the publishable key");
    assert.deepEqual(await getIntentStore().metaOf?.(stored.body.intent.id), { ownerKeyId: pub.id, exposureScope: "owner" });
    // Owned intents reach the parent's subtree webhooks and are listed by the parent with ?owner=.
    const targets = await dispatchTargets({ type: "intent.created", data: { intentId: stored.body.intent.id } } as unknown as Parameters<typeof dispatchTargets>[0]);
    assert.deepEqual(targets, [{ ownerKeyId: pub.id, subtreeOnly: false }, { ownerKeyId: owner.id, subtreeOnly: true }]);
    const listed = await call<{ intents: IntentGraph[] }>(server, "GET", `/intents?owner=${pub.id}`, { key: owner.key });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.deepEqual(listed.body.intents.map((intent) => intent.id), [stored.body.intent.id]);
    const stranger = await projectKey("stranger");
    assertError(await call(server, "GET", `/intents?owner=${pub.id}`, { key: stranger.key }), 404, "KEY_NOT_FOUND");
    const sibling = await issueDeveloperKey("sibling", { id: owner.id, maxActive: 5 });
    assertError(await call(server, "GET", `/intents?owner=${sibling.id}`, { key: owner.key }), 404, "KEY_NOT_FOUND");
  });

  it("refuses call and action steps in its own intents (CONTRACT_UNKNOWN)", async () => {
    const { pub } = await newProject();
    const body = { accounts: [EVM_ACCOUNT], actions: [{ kind: "call", network: "base", contract: `ct_${"0".repeat(24)}`, entry: "deposit", amount: "10" }] };
    assertError(await call(server, "POST", "/intents?dryRun=true", { ...browser(pub.key), body }), 422, "CONTRACT_UNKNOWN");
  });
});

describe("the origin rule", () => {
  it("needs Origin in allowedOrigins, or a first-party Origin with Kletia-Host-Origin in allowedOrigins", async () => {
    const { pub } = await newProject();
    assertError(await call(server, "GET", "/publishable/profile", { key: pub.key }), 403, "PUBLISHABLE_ORIGIN_FORBIDDEN");
    assertError(await call(server, "GET", "/publishable/profile", browser(pub.key, "https://evil.example")), 403, "PUBLISHABLE_ORIGIN_FORBIDDEN");
    assert.equal((await call(server, "GET", "/publishable/profile", browser(pub.key, SITE))).status, 200);
    assert.equal((await call(server, "GET", "/publishable/profile", browser(pub.key, "http://localhost:3000"))).status, 200);
    // The /embed frame: Kletia's own origin, with the bridge-proven host origin.
    assert.equal((await call(server, "GET", "/publishable/profile", browser(pub.key, FIRST_PARTY, { "kletia-host-origin": SITE }))).status, 200);
    assertError(await call(server, "GET", "/publishable/profile", browser(pub.key, FIRST_PARTY)), 403, "PUBLISHABLE_ORIGIN_FORBIDDEN");
    assertError(await call(server, "GET", "/publishable/profile", browser(pub.key, FIRST_PARTY, { "kletia-host-origin": "https://evil.example" })), 403, "PUBLISHABLE_ORIGIN_FORBIDDEN");
    // A foreign page cannot borrow the frame's header.
    assertError(await call(server, "GET", "/publishable/profile", browser(pub.key, "https://evil.example", { "kletia-host-origin": SITE })), 403, "PUBLISHABLE_ORIGIN_FORBIDDEN");
  });

  it("follows allowedOrigins changes of the project", async () => {
    const { owner, pub } = await newProject();
    await settle(owner.key, { allowedOrigins: ["https://other.example"] });
    assertError(await call(server, "GET", "/publishable/profile", browser(pub.key, SITE)), 403, "PUBLISHABLE_ORIGIN_FORBIDDEN");
    assert.equal((await call(server, "GET", "/publishable/profile", browser(pub.key, "https://other.example"))).status, 200);
  });
});

describe("rate limits", () => {
  it("counts 120 per minute per key and the public per-IP limit", async () => {
    assert.equal(TIER_LIMITS.publishable, 120);
    const { pub } = await newProject();
    const first = await call(server, "GET", "/networks", browser(pub.key));
    assert.match(first.headers.get("ratelimit-policy") ?? "", /q=120/u, "the key's own window is 120 per minute");
    for (let index = 1; index < TIER_LIMITS.public; index += 1) assert.equal((await call(server, "GET", "/networks", browser(pub.key))).status, 200);
    const limited = assertError(await call(server, "GET", "/networks", browser(pub.key)), 429, "RATE_LIMITED");
    assert.match(limited.error.message, /publishable key from one address/u);
  });
});

describe("flow sessions", () => {
  const flow = { id: "swap-sol", label: "Swap SOL to USDC", actions: [{ kind: "swap", network: "solana", from: "SOL", to: "USDC", amount: "1" }], amount: { action: 0, min: "0.5", max: "2" } };

  it("mints a single-use 600 s session owned by the publishable key from { flow, hostOrigin } only", async () => {
    const { owner, pub } = await newProject({ flows: [flow] });
    const reply = await call<{ session: SessionView }>(server, "POST", "/sessions", { ...browser(pub.key), body: { flow: "swap-sol", hostOrigin: SITE } });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    const session = reply.body.session;
    assert.equal(session.maxIntents, 1);
    assert.equal(Date.parse(session.expiresAt) - Date.parse(session.createdAt), 600_000);
    assert.deepEqual(session.allowedOrigins, [SITE, "http://localhost:3000"]);
    assert.equal(session.amount?.max, "2");
    assert.equal(session.integrator.domainVerified, false);
    const record = await sessions.sessionStore().get(session.id);
    assert.equal(record?.ownerKeyId, pub.id);
    assert.equal(record?.template.contractAuthorityKeyId, owner.id, "the flow's saver is the contract authority");
    const created = await sessions.createSessionIntent(session.id, { accounts: [SOL_ACCOUNT], hostOrigin: SITE });
    assert.deepEqual(await getIntentStore().metaOf?.(created.intent.id), { ownerKeyId: pub.id, contractAuthorityKeyId: owner.id, exposureScope: "owner" });
    await assert.rejects(sessions.createSessionIntent(session.id, { accounts: [SOL_ACCOUNT], hostOrigin: SITE }), (error: { code?: string }) => error.code === "SESSION_USED");
  });

  it("refuses templates, unknown flows and hosts the project does not allow", async () => {
    const { pub } = await newProject({ flows: [flow] });
    assertError(await call(server, "POST", "/sessions", { ...browser(pub.key), body: { actions: flow.actions, allowedOrigins: [SITE] } }), 403, "PUBLISHABLE_KEY_FORBIDDEN");
    assertError(await call(server, "POST", "/sessions", { ...browser(pub.key), body: { flow: "nope", hostOrigin: SITE } }), 404, "FLOW_UNKNOWN");
    assertError(await call(server, "POST", "/sessions", { ...browser(pub.key), body: { flow: "swap-sol", hostOrigin: "https://evil.example" } }), 403, "PUBLISHABLE_ORIGIN_FORBIDDEN");
  });
});

describe("contract authority of a flow (offline EVM world)", () => {
  let harness: import("../../engine/__tests__/contractHarness.js").EvmHarness;
  let directory: import("../../engine/__tests__/contractHarness.js").MemoryDirectory;

  before(() => {
    harness = harnessModule.installEvmHarness();
    directory = harnessModule.installDirectory();
    configurePlatform({ contracts: directory });
    // The router wraps the installed directory; this one was installed after it.
    projects.installPublishableContractGuard();
    harnessModule.fund(harness.world, harnessModule.USDC_BASE, harnessModule.USER, 1_000_000_000n);
  });

  after(() => {
    harness.restore();
    configurePlatform({ contracts: null });
  });

  it("plans and prepares a flow's call step with the saver's registration, never a text intent's", async () => {
    // Keys and settings through the module functions: the offline world answers every fetch.
    const saver = await projectKey("vault-owner");
    const auth = { tier: "developer" as const, keyId: saver.id, projectId: saver.id, keyKind: "project" as const };
    const registration = directory.add(await harnessModule.registrationOf(harnessModule.vaultDefinitionBody(), { ownerKeyId: saver.id, projectId: "proj_flow", visibility: "project" }));
    directory.projects.set(saver.id, "proj_flow");
    const action = { kind: "call", network: "base", contract: registration.id, entry: "deposit", amount: "100" };
    const view = await projects.getProject(auth);
    const saved = await projects.patchProject(auth, `"${view.hash}"`, { allowedOrigins: [SITE], flows: [{ id: "deposit", label: "Deposit into Acme vault", actions: [action] }] });
    assert.equal(saved.settings.flows?.[0]?.ownerKeyId, saver.id);
    const pub = await projects.createPublishableKey(auth, { label: "website" });
    // Project-visible to every key of the project in this directory: only the guard keeps the publishable key out.
    directory.projects.set(pub.id, "proj_flow");
    const pubAuth = { tier: "publishable" as const, keyId: pub.id, projectId: saver.id, keyKind: "publishable" as const };
    const account = `eip155:8453:${harnessModule.USER}`;
    await assert.rejects(
      createIntentDetailed({ accounts: [account], actions: [action] }, { ownerKeyId: pub.id, dryRun: true }),
      (error: { code?: string }) => error.code === "CONTRACT_UNKNOWN",
    );
    await assert.rejects(
      createIntentDetailed({ text: "deposit 100 USDC into acme vault", accounts: [account] }, { ownerKeyId: pub.id, dryRun: true }),
      // The alias is unknown to a publishable key: the grammar finds no contract phrase at all.
      (error: { code?: string }) => error.code === "CONTRACT_UNKNOWN" || error.code === "INTENT_UNSUPPORTED",
    );
    const session = await projects.createFlowSession(pubAuth, { flow: "deposit", hostOrigin: SITE });
    const created = await sessions.createSessionIntent(session.id, { accounts: [account], hostOrigin: SITE });
    const step = created.intent.steps[0];
    assert.equal(step?.kind, "call");
    assert.equal(step?.call?.contract, registration.id);
    const prepared = await prepareStep(created.intent.id, step.id);
    assert.equal(prepared.intent.steps[0]?.status, "awaiting_signature");
    assert.deepEqual(directory.spends.map((entry) => entry.owner), [pub.id], "the daily notional is the publishable key's");
    // Without the saver's right to the registration, the flow's intent no longer prepares.
    directory.projects.set(saver.id, "proj_other");
    registration.ownerKeyId = "key_someone_else";
    await assert.rejects(prepareStep(created.intent.id, step.id), (error: { code?: string }) => error.code === "CONTRACT_NOT_USABLE");
  });
});
