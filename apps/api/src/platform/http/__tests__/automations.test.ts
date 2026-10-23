/**
 * Automations over HTTP (memory stores, offline stub adapters): CRUD,
 * pause and resume, ownership (another key sees 404), owner resolution
 * (401 without a key or session), agent keys and `permissions.automations`,
 * wallet sessions limited to their own address, the inbox after a pass that
 * planned a real (stub-adapter) intent, and `automation.*` webhooks routed
 * to the owning key.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type { AutomationRunView, AutomationView } from "@kletia/core";
import { resetEngine, EVM_ACCOUNT, OTHER_EVM_ADDRESS } from "../../engine/__tests__/helpers.js";
import { as, evmWallet, signIn } from "./accountFlows.js";
import { assertError, call, serve, useTestEnvironment, waitFor, type TestServer } from "./support.js";

useTestEnvironment();
const { createPlatformRouter, platformErrorHandler } = await import("../index.js");
const { resetAccountLimiters } = await import("../accounts/handlers.js");
const { MemoryAccountStore, setAccountStore } = await import("../accounts/store.js");
const { configureAutomationStore, MemoryAutomationStore } = await import("../../automation/store.js");
const { automationCreations } = await import("../../automation/service.js");
const { liveEvaluatorDeps, runAutomationPass } = await import("../../automation/evaluator.js");
const { subscribeDispatchedEvents } = await import("../dispatcher.js");

let server: TestServer;
const PAYEE = `eip155:8453:${OTHER_EVM_ADDRESS}`;

async function projectKey(name = "automation-tests"): Promise<{ id: string; key: string }> {
  const reply = await call<{ key: { id: string; key: string } }>(server, "POST", "/keys", { body: { name } });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return reply.body.key;
}

function draft(account = EVM_ACCOUNT, startAt = new Date(Date.now() - 60_000).toISOString()): Record<string, unknown> {
  return {
    label: "Pay rent",
    trigger: { kind: "schedule", every: { unit: "month", count: 1 }, startAt },
    action: { kind: "intent", actions: [{ kind: "transfer", network: "base", from: "USDC", amount: "5", recipient: PAYEE }], accounts: [account] },
    limits: { maxUsdPerRun: "10" },
  };
}

async function create(key: string, body = draft()): Promise<AutomationView> {
  const reply = await call<{ automation: AutomationView }>(server, "POST", "/automations", { key, body });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return reply.body.automation;
}

/** One evaluator pass with the real engine (stub adapters) and a fixed USD notional. */
async function pass(): Promise<void> {
  await runAutomationPass(Date.now(), { ...liveEvaluatorDeps(), reads: { priceUsd: async () => null, balance: async () => 0, rates: async () => [], notionalUsdMicros: async () => 5_000_000n } });
}

before(async () => {
  server = await serve((app) => app.use("/v1", createPlatformRouter(), platformErrorHandler));
});

after(async () => {
  await server.close();
});

beforeEach(() => {
  resetEngine();
  resetAccountLimiters();
  setAccountStore(new MemoryAccountStore());
  configureAutomationStore(new MemoryAutomationStore());
  automationCreations.reset();
});

describe("automations: keys", () => {
  it("creates, lists, reads, relabels, pauses, resumes and deletes; other keys see 404", async () => {
    const owner = await projectKey();
    const created = await create(owner.key);
    assert.match(created.id, /^au_[0-9a-f]{24}$/u);
    assert.deepEqual([created.status, created.execution, created.owner.kind, created.runs], ["active", { mode: "signature" }, "key", 0]);
    assert.ok(created.nextRunAt, "the due slot shows as the next run");
    const listed = await call<{ automations: AutomationView[] }>(server, "GET", "/automations", { key: owner.key });
    assert.deepEqual(listed.body.automations.map((item) => item.id), [created.id]);
    const relabelled = await call<{ automation: AutomationView }>(server, "PATCH", `/automations/${created.id}`, { key: owner.key, body: { label: "Rent", limits: { maxUsdPerRun: "8" } } });
    assert.deepEqual([relabelled.body.automation.label, relabelled.body.automation.limits.maxUsdPerRun], ["Rent", "8"]);
    assertError(await call(server, "PATCH", `/automations/${created.id}`, { key: owner.key, body: { trigger: draft().trigger } }), 400, "AUTOMATION_DRAFT_INVALID");
    const paused = await call<{ automation: AutomationView }>(server, "POST", `/automations/${created.id}/pause`, { key: owner.key });
    assert.deepEqual([paused.body.automation.status, paused.body.automation.nextRunAt], ["paused", null]);
    const resumed = await call<{ automation: AutomationView }>(server, "POST", `/automations/${created.id}/resume`, { key: owner.key });
    assert.equal(resumed.body.automation.status, "active");
    const stranger = await projectKey("stranger");
    assertError(await call(server, "GET", `/automations/${created.id}`, { key: stranger.key }), 404, "AUTOMATION_NOT_FOUND");
    assertError(await call(server, "DELETE", `/automations/${created.id}`, { key: stranger.key }), 404, "AUTOMATION_NOT_FOUND");
    assertError(await call(server, "GET", "/automations/au_nope", { key: owner.key }), 404, "AUTOMATION_NOT_FOUND");
    assert.equal((await call(server, "DELETE", `/automations/${created.id}`, { key: owner.key })).status, 204);
    assertError(await call(server, "GET", `/automations/${created.id}`, { key: owner.key }), 404, "AUTOMATION_NOT_FOUND");
  });

  it("refuses invalid drafts with issues, and callers without a key or session", async () => {
    const owner = await projectKey();
    const invalid = assertError(await call(server, "POST", "/automations", { key: owner.key, body: { trigger: { kind: "sometimes" }, action: {} } }), 400, "AUTOMATION_DRAFT_INVALID");
    assert.ok(invalid.error.issues?.some((issue) => issue.path === "trigger.kind"));
    assertError(await call(server, "GET", "/automations"), 401, "AUTOMATION_OWNER_REQUIRED");
    assertError(await call(server, "POST", "/automations", { body: draft() }), 401, "AUTOMATION_OWNER_REQUIRED");
  });

  it("lets agent keys automate only with permissions.automations; pausing is always allowed", async () => {
    const project = await projectKey();
    const observer = await call<{ key: { id: string; key: string } }>(server, "POST", `/keys/${project.id}/children`, { key: project.key, body: { name: "observer", expiresInSeconds: 86_400 } });
    assert.equal(observer.status, 201, JSON.stringify(observer.body));
    assertError(await call(server, "POST", "/automations", { key: observer.body.key.key, body: draft() }), 403, "AGENT_KEY_FORBIDDEN");
    const policy = { schema: "kletia.policy/v1", permissions: { automations: true } };
    const agent = await call<{ key: { id: string; key: string } }>(server, "POST", `/keys/${project.id}/children`, { key: project.key, body: { name: "automator", expiresInSeconds: 86_400, policy } });
    assert.equal(agent.status, 201, JSON.stringify(agent.body));
    const created = await create(agent.body.key.key);
    assert.deepEqual(created.owner, { kind: "key", keyId: agent.body.key.id, projectId: created.owner.kind === "key" ? created.owner.projectId : null });
    // The parent takes the permission away: the agent can still pause, not resume.
    assert.equal((await call(server, "PUT", `/keys/${agent.body.key.id}/policy`, { key: project.key, body: { schema: "kletia.policy/v1" } })).status, 200);
    assert.equal((await call(server, "POST", `/automations/${created.id}/pause`, { key: agent.body.key.key })).status, 200);
    assertError(await call(server, "POST", `/automations/${created.id}/resume`, { key: agent.body.key.key }), 403, "AGENT_KEY_FORBIDDEN");
  });

  it("fires through the evaluator into the inbox and the key's automation webhooks", async () => {
    const owner = await projectKey();
    const events: { type: string; automationId?: string }[] = [];
    const stop = subscribeDispatchedEvents((event) => {
      if (event.type.startsWith("automation.")) events.push({ type: event.type, automationId: (event.data as { automationId?: string }).automationId });
    });
    try {
      const created = await create(owner.key);
      await pass();
      await pass();
      const runs = await call<{ runs: AutomationRunView[] }>(server, "GET", `/automations/${created.id}/runs`, { key: owner.key });
      assert.equal(runs.body.runs.length, 1, "one run per slot");
      const [run] = runs.body.runs;
      assert.deepEqual([run?.status, run?.notionalUsd], ["needs_signature", "5.00"]);
      assert.match(run?.intentId ?? "", /^int_/u);
      const inbox = await call<{ runs: (AutomationRunView & { intentStatus: string; automationLabel: string })[] }>(server, "GET", "/automations/inbox", { key: owner.key });
      assert.deepEqual(inbox.body.runs.map((entry) => [entry.id, entry.intentStatus, entry.automationLabel]), [[run?.id, "planned", "Pay rent"]]);
      const intent = await call<{ intent: { metadata: Record<string, string> } }>(server, "GET", `/intents/${run?.intentId}`);
      assert.deepEqual(intent.body.intent.metadata, { automationId: created.id, automationRunId: run?.id });
      assert.equal((await call(server, "POST", `/intents/${run?.intentId}/cancel`)).status, 200);
      const emptied = await call<{ runs: unknown[] }>(server, "GET", "/automations/inbox", { key: owner.key });
      assert.equal(emptied.body.runs.length, 0, "a cancelled intent leaves the inbox");
      await waitFor(() => events.some((event) => event.type === "automation.fired"), 2_000, "automation.fired");
      assert.deepEqual(events.map((event) => event.type).slice(0, 2), ["automation.created", "automation.fired"]);
    } finally {
      stop();
    }
  });
});

describe("automations: wallet sessions (the desk)", () => {
  it("owns automations by the signed-in wallet and refuses other addresses", async () => {
    const wallet = evmWallet();
    const token = await signIn(server, wallet);
    const own = `eip155:8453:${wallet.address}`;
    const reply = await call<{ automation: AutomationView }>(server, "POST", "/automations", { headers: as(token), body: draft(own) });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    assert.deepEqual(reply.body.automation.owner, { kind: "wallet", walletKind: "evm", address: reply.body.automation.owner.kind === "wallet" ? reply.body.automation.owner.address : "" });
    assertError(await call(server, "POST", "/automations", { headers: as(token), body: draft(EVM_ACCOUNT) }), 403, "AUTOMATION_ACCOUNT_FORBIDDEN");
    const listed = await call<{ automations: AutomationView[] }>(server, "GET", "/automations", { headers: as(token) });
    assert.equal(listed.body.automations.length, 1);
    const other = await signIn(server, evmWallet());
    assertError(await call(server, "GET", `/automations/${reply.body.automation.id}`, { headers: as(other) }), 404, "AUTOMATION_NOT_FOUND");
    assertError(await call(server, "GET", "/automations", { headers: as(token, "https://evil.example") }), 403, "ACCOUNT_ORIGIN_FORBIDDEN");
    await pass();
    const inbox = await call<{ runs: AutomationRunView[] }>(server, "GET", "/automations/inbox", { headers: as(token) });
    assert.equal(inbox.body.runs.length, 1, "the wallet's own inbox, without webhooks");
  });
});
