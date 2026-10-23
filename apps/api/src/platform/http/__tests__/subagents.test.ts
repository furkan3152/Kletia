/**
 * Sub-agents over HTTP and MCP (docs/platform/subagents.md), memory stores:
 * a main agent requests a sub-agent inside its chain; the owner wallet (EVM
 * and Solana signatures from throwaway keys made here at runtime) or a
 * project key decides; replayed, altered, foreign and late signatures fail;
 * the requester claims the key once; revoke and pause cascade; a child's
 * spending fills its parent's caps; requests lapse; the desk's pending count.
 * The request store's contract runs on memory, and on Postgres when
 * KLETIA_TEST_DATABASE_URL is set.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { CHAINS, SUBAGENT_LIMITS, type IntentGraph, type KletiaEvent } from "@kletia/core";
import { configurePlatform, configurePolicyPricing, configurePolicyReads } from "../../index.js";
import { ACCOUNTS, resetEngine } from "../../engine/__tests__/helpers.js";
import { installMarket, standardPrices } from "../../engine/__tests__/policyHarness.js";
import { evmWallet, PORTAL_ORIGIN, signIn, solanaWallet, type Wallet } from "./accountFlows.js";
import { assertError, call, serve, useTestEnvironment, type ErrorEnvelope, type TestServer } from "./support.js";

useTestEnvironment();
const { createPlatformRouter, platformErrorHandler } = await import("../index.js");
const { subscribeKeyEvents } = await import("../policies/announce.js");
const service = await import("../agents/service.js");
const { apiKeyStore } = await import("../auth.js");

let server: TestServer;
const events: KletiaEvent[] = [];
let unsubscribe: () => void = () => undefined;

before(() => {
  resetEngine();
  standardPrices(installMarket());
  configurePolicyReads({ pendingNonce: async () => 7n, solanaBlockHeight: async () => 500n });
  unsubscribe = subscribeKeyEvents((event) => events.push(event as KletiaEvent));
});

beforeEach(async () => {
  events.length = 0;
  server = await serve((app) => app.use("/v1", createPlatformRouter(), platformErrorHandler));
});

afterEach(async () => {
  await server.close();
});

after(() => {
  unsubscribe();
  configurePlatform({ adapters: null });
  configurePolicyPricing(null);
  configurePolicyReads(null);
});

interface Key {
  readonly id: string;
  readonly key: string;
}

interface RequestView {
  readonly id: string;
  readonly status: string;
  readonly policyHash: string;
  readonly childKeyId: string | null;
  readonly claimBy: string | null;
  readonly reason: string | null;
  readonly grant: { path: string; child: string; parent: string; same: boolean }[];
  readonly policy: { permissions: Record<string, boolean> };
}

interface TreeNode {
  readonly id: string;
  readonly chainMode: string;
  readonly caps: Record<string, string> | null;
  readonly usage: { dayUsd: string; weekUsd: string };
  readonly children: TreeNode[];
}

const MAIN_POLICY = {
  schema: "kletia.policy/v1",
  mode: "live",
  networks: { allow: ["arbitrum", "base"] },
  recipients: { mode: "own" },
  caps: { perIntentUsd: "500", dailyUsd: "1000" },
  execution: { pinNonce: false },
  permissions: { createChildKeys: true, storeIntents: true },
};

const SUB_POLICY = {
  schema: "kletia.policy/v1",
  mode: "live",
  networks: { allow: ["base", "arbitrum"] },
  kinds: { allow: ["bridge", "transfer"] },
  caps: { perIntentUsd: "100", dailyUsd: "250" },
  execution: { pinNonce: false },
};

const BRIDGE = (amount: number) => ({ text: `bridge ${amount} USDC from base to arbitrum`, accounts: ACCOUNTS });

/** A project owned by `wallet` (signed in on the portal) and its first project key. */
async function ownedProject(wallet: Wallet): Promise<Key> {
  const token = await signIn(server, wallet);
  const reply = await call<{ key: Key }>(server, "POST", "/accounts/projects", { headers: { origin: PORTAL_ORIGIN, "kletia-account-session": token }, body: { name: "owned" } });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return reply.body.key;
}

async function issue(name: string): Promise<Key> {
  const reply = await call<{ key: Key }>(server, "POST", "/keys", { body: { name } });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return reply.body.key;
}

async function agentUnder(parent: string, projectKey: string, policy: Record<string, unknown> = MAIN_POLICY, name = "main", days = 30): Promise<Key> {
  const reply = await call<{ key: Key }>(server, "POST", `/keys/${parent}/children`, { key: projectKey, body: { name, policy, expiresInSeconds: days * 86_400 } });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return reply.body.key;
}

async function fileRequest(agent: Key, policy: Record<string, unknown> = SUB_POLICY, name = "invoice-payer"): Promise<{ request: RequestView; claimToken: string }> {
  const reply = await call<{ request: RequestView; claimToken: string }>(server, "POST", `/agents/${agent.id}/subagents`, { key: agent.key, body: { name, purpose: "Pays approved invoices on Base.", policy } });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return reply.body;
}

async function challenge(id: string, wallet: Wallet, decision: "approve" | "deny"): Promise<string> {
  const reply = await call<{ message: string }>(server, "POST", `/agents/requests/${id}/challenge`, {
    headers: { origin: PORTAL_ORIGIN },
    body: wallet.kind === "evm" ? { decision, walletKind: "evm", address: wallet.address, chainId: 8453 } : { decision, walletKind: "solana", address: wallet.address },
  });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return reply.body.message;
}

function decide(id: string, decision: "approve" | "deny", body: Record<string, unknown> | undefined, key?: string) {
  return call<{ request: RequestView }>(server, "POST", `/agents/requests/${id}/${decision}`, { headers: { origin: PORTAL_ORIGIN }, ...(body ? { body } : {}), ...(key ? { key } : {}) });
}

function claim(id: string, agent: Key, claimToken: string) {
  return call<{ key: Key & { expiresAt: string }; policy: { hash: string } }>(server, "POST", `/agents/requests/${id}/claim`, { key: agent.key, body: { claimToken } });
}

describe("sub-agent requests", () => {
  it("refuses a request wider than the parent's chain, field by field", async () => {
    const root = await issue("root");
    const main = await agentUnder(root.id, root.key);
    const wide = await call<ErrorEnvelope>(server, "POST", `/agents/${main.id}/subagents`, {
      key: main.key,
      body: { name: "wide", purpose: "Too much.", policy: { ...SUB_POLICY, networks: { allow: ["base", "solana"] }, caps: { dailyUsd: "5000" }, permissions: { webhooks: true } } },
    });
    assertError(wide, 403, "SUBAGENT_POLICY_NOT_SUBSET");
    assert.deepEqual(wide.body.error.issues?.map((issue) => issue.path).sort(), ["caps.dailyUsd", "caps.perIntentUsd", "networks.allow", "permissions.webhooks"]);
    // Only the agent itself asks, under itself, with permissions.createChildKeys.
    assertError(await call(server, "POST", `/agents/${main.id}/subagents`, { key: root.key, body: { name: "x", purpose: "y", policy: SUB_POLICY } }), 403, "AGENT_KEY_FORBIDDEN");
    const plain = await agentUnder(root.id, root.key, { ...MAIN_POLICY, permissions: { storeIntents: true } }, "plain");
    assertError(await call(server, "POST", `/agents/${plain.id}/subagents`, { key: plain.key, body: { name: "x", purpose: "y", policy: SUB_POLICY } }), 403, "AGENT_KEY_FORBIDDEN");
    assertError(await call(server, "POST", `/agents/${main.id}/subagents`, { key: main.key, body: { name: "x", policy: SUB_POLICY } }), 400, "INVALID_REQUEST");
    // Agents never mint children directly any more.
    assertError(await call(server, "POST", `/keys/${main.id}/children`, { key: main.key, body: { name: "direct" } }), 403, "AGENT_KEY_FORBIDDEN");
  });

  it("the owner's EVM wallet approves once; replayed, altered, foreign and mismatched signatures fail; the agent claims once", async () => {
    const owner = evmWallet();
    const root = await ownedProject(owner);
    const main = await agentUnder(root.id, root.key);
    const filed = await fileRequest(main);
    assert.match(filed.claimToken, /^kl_scl_[A-Za-z0-9_-]{43}$/u);
    assert.equal(filed.request.status, "pending");
    assert.deepEqual(filed.request.policy.permissions, { createChildKeys: false, webhooks: false, registerContracts: false, sessions: false, storeIntents: true, mcpCreateIntents: false, links: false, automations: false });
    const caps = filed.request.grant.find((line) => line.path === "caps.dailyUsd");
    assert.deepEqual([caps?.child, caps?.parent, caps?.same], ["$250", "$1000", false]);
    const id = filed.request.id;

    // Deciders: never the agent, never a stranger wallet, never without the portal origin.
    assertError(await decide(id, "approve", undefined, main.key), 403, "SUBAGENT_APPROVER_NOT_ALLOWED");
    assertError(await decide(id, "approve", undefined), 401, "API_KEY_REQUIRED");
    assertError(await call(server, "POST", `/agents/requests/${id}/challenge`, { body: { decision: "approve", walletKind: "evm", address: owner.address, chainId: 8453 } }), 403, "ACCOUNT_ORIGIN_FORBIDDEN");
    const stranger = evmWallet();
    assertError(await call(server, "POST", `/agents/requests/${id}/challenge`, { headers: { origin: PORTAL_ORIGIN }, body: { decision: "approve", walletKind: "evm", address: stranger.address, chainId: 8453 } }), 403, "SUBAGENT_APPROVER_NOT_ALLOWED");

    const first = await challenge(id, owner, "approve");
    assert.match(first, new RegExp(`^Rule book: ${filed.request.policyHash}$`, "mu"));
    assert.match(first, /^Caps: \$100 per intent, \$250 per 24 h$/mu);
    // A foreign signature uses the message up: the right signature of it fails afterwards (single use).
    assertError(await decide(id, "approve", { message: first, signature: await stranger.sign(first) }), 403, "SUBAGENT_SIGNATURE_INVALID");
    assertError(await decide(id, "approve", { message: first, signature: await owner.sign(first) }), 403, "SUBAGENT_SIGNATURE_INVALID");
    // The decision is part of what is signed.
    const forApproval = await challenge(id, owner, "approve");
    assertError(await decide(id, "deny", { message: forApproval, signature: await owner.sign(forApproval) }), 403, "SUBAGENT_SIGNATURE_INVALID");
    // An altered message (wider caps line) never matches the stored one.
    const original = await challenge(id, owner, "approve");
    const altered = original.replace(/^Caps: .*$/mu, "Caps: $100000 per 24 h");
    assertError(await decide(id, "approve", { message: altered, signature: await owner.sign(altered) }), 403, "SUBAGENT_SIGNATURE_INVALID");
    // Another origin cannot use a message issued to the portal.
    const portal = await challenge(id, owner, "approve");
    assertError(await call(server, "POST", `/agents/requests/${id}/approve`, { headers: { origin: "https://evil.example" }, body: { message: portal, signature: await owner.sign(portal) } }), 403, "SUBAGENT_SIGNATURE_INVALID");

    const good = await challenge(id, owner, "approve");
    const approved = await decide(id, "approve", { message: good, signature: await owner.sign(good) });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.request.status, "approved");
    assert.match(approved.body.request.childKeyId ?? "", /^key_[0-9a-f]{24}$/u);
    assert.ok(approved.body.request.claimBy);
    assertError(await decide(id, "approve", { message: good, signature: await owner.sign(good) }), 409, "SUBAGENT_REQUEST_DECIDED");
    assertError(await decide(id, "deny", undefined, root.key), 409, "SUBAGENT_REQUEST_DECIDED");
    assert.equal((await decide(id, "approve", undefined, root.key)).status, 200, "a project key reads the same decision again");

    // Claim: only the requester, only with the token, only once.
    assertError(await claim(id, main, `kl_scl_${"A".repeat(43)}`), 403, "SUBAGENT_CLAIM_INVALID");
    assertError(await call(server, "POST", `/agents/requests/${id}/claim`, { key: root.key, body: { claimToken: filed.claimToken } }), 404, "SUBAGENT_REQUEST_NOT_FOUND");
    const claimed = await claim(id, main, filed.claimToken);
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
    assert.match(claimed.body.key.key, /^kl_agt_[0-9A-Za-z]{32}$/u);
    assert.equal(claimed.body.key.id, approved.body.request.childKeyId);
    assert.equal(claimed.body.policy.hash, filed.request.policyHash);
    assertError(await claim(id, main, filed.claimToken), 403, "SUBAGENT_CLAIM_INVALID");

    // The sub-agent authenticates, is permissionless and sits in the tree under its parent.
    const sub = { id: claimed.body.key.id, key: claimed.body.key.key };
    assert.equal((await call(server, "GET", "/keys", { key: sub.key })).status, 200);
    assertError(await call(server, "POST", "/webhooks", { key: sub.key, body: { url: "https://93.184.215.14/hook" } }), 403, "AGENT_KEY_FORBIDDEN");
    assertError(await call(server, "POST", `/agents/${sub.id}/subagents`, { key: sub.key, body: { name: "x", purpose: "y", policy: SUB_POLICY } }), 403, "AGENT_KEY_FORBIDDEN");
    const tree = await call<{ nodes: TreeNode[] }>(server, "GET", "/agents/tree", { key: root.key });
    const mainNode = tree.body.nodes.find((node) => node.id === root.id)?.children.find((node) => node.id === main.id);
    assert.equal(mainNode?.children[0]?.id, sub.id);
    assert.deepEqual(mainNode?.children[0]?.caps, SUB_POLICY.caps);

    // Events name the request and never carry a secret or the claim token.
    const types = events.map((event) => event.type);
    assert.ok(types.includes("agent.subagent_requested") && types.includes("agent.subagent_approved") && types.includes("key.created"), types.join(","));
    const serialised = JSON.stringify(events);
    assert.ok(!serialised.includes("kl_agt_") && !serialised.includes("kl_scl_") && !serialised.includes(filed.claimToken));
  });

  it("the owner's Solana wallet denies; the request cannot be claimed or approved after", async () => {
    const owner = solanaWallet();
    const root = await ownedProject(owner);
    const main = await agentUnder(root.id, root.key);
    const filed = await fileRequest(main);
    const message = await challenge(filed.request.id, owner, "deny");
    assert.match(message, /^Chain ID: mainnet$/mu);
    const denied = await decide(filed.request.id, "deny", { message, signature: await owner.sign(message) });
    assert.equal(denied.status, 200, JSON.stringify(denied.body));
    assert.equal(denied.body.request.status, "denied");
    assertError(await claim(filed.request.id, main, filed.claimToken), 403, "SUBAGENT_CLAIM_INVALID");
    assertError(await decide(filed.request.id, "approve", undefined, root.key), 409, "SUBAGENT_REQUEST_DECIDED");
    assert.ok(events.some((event) => event.type === "agent.subagent_denied"));
  });

  it("counts open requests for the desk by owner wallet only", async () => {
    const owner = evmWallet();
    const root = await ownedProject(owner);
    const main = await agentUnder(root.id, root.key);
    await fileRequest(main);
    const mine = await call<{ pending: number }>(server, "GET", `/agents/pending?account=eip155:8453:${owner.address}`);
    assert.deepEqual(mine.body, { pending: 1 });
    const other = await call<{ pending: number }>(server, "GET", `/agents/pending?account=eip155:1:${evmWallet().address}`);
    assert.deepEqual(other.body, { pending: 0 });
    assertError(await call(server, "GET", "/agents/pending?account=nonsense"), 400, "INVALID_REQUEST");
    assert.equal((await call<{ pending: number }>(server, "GET", `/agents/pending?account=solana:${CHAINS.solana.reference}:${solanaWallet().address}`)).body.pending, 0);
  });
});

describe("cascade, budget and lapses", () => {
  it("a project key approves; the child's spending fills the parent's caps; pause and revoke stop the subtree", async () => {
    const root = await issue("root");
    const main = await agentUnder(root.id, root.key, { ...MAIN_POLICY, caps: { perIntentUsd: "100", dailyUsd: "100" } });
    const filed = await fileRequest(main, { ...SUB_POLICY, caps: { perIntentUsd: "100", dailyUsd: "100" } });
    const approved = await decide(filed.request.id, "approve", undefined, root.key);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const claimed = await claim(filed.request.id, main, filed.claimToken);
    const sub = { id: claimed.body.key.id, key: claimed.body.key.key };

    const spent = await call<{ intent: IntentGraph }>(server, "POST", "/intents", { key: sub.key, body: BRIDGE(60) });
    assert.equal(spent.status, 201, JSON.stringify(spent.body));
    const prepared = await call(server, "POST", `/intents/${spent.body.intent.id}/steps/s1/prepare`, {});
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
    // The parent's own window already holds the child's 60: another 60 is over its $100 day.
    const parentIntent = await call<{ intent: IntentGraph }>(server, "POST", "/intents", { key: main.key, body: BRIDGE(60) });
    const refusal = parentIntent.status === 201 ? await call(server, "POST", `/intents/${parentIntent.body.intent.id}/steps/s1/prepare`, {}) : parentIntent;
    assertError(refusal, 403, "POLICY_SPEND_LIMIT");
    const tree = await call<{ nodes: TreeNode[] }>(server, "GET", "/agents/tree", { key: main.key });
    const mainNode = tree.body.nodes[0];
    assert.equal(mainNode?.id, main.id);
    assert.ok(Number(mainNode?.usage.dayUsd) >= 60, `the parent's window counts the child: ${mainNode?.usage.dayUsd}`);
    assert.equal(mainNode?.usage.dayUsd, mainNode?.children[0]?.usage.dayUsd);

    // Pausing the parent pauses the child at once (the chain is read fresh).
    assertError(await call(server, "POST", `/agents/${main.id}/pause`, { key: main.key }), 403, "AGENT_KEY_FORBIDDEN");
    const paused = await call<{ mode: string }>(server, "POST", `/agents/${main.id}/pause`, { key: root.key });
    assert.equal(paused.status, 200, JSON.stringify(paused.body));
    const blocked = await call<ErrorEnvelope & { error: { policy?: { violations: { rule: string }[] } } }>(server, "POST", "/intents", { key: sub.key, body: BRIDGE(5) });
    assertError(blocked, 403, "POLICY_VIOLATION");
    assert.ok(blocked.body.error.policy?.violations.some((violation) => violation.rule === "mode.paused"));
    const pausedTree = await call<{ nodes: TreeNode[] }>(server, "GET", "/agents/tree", { key: root.key });
    assert.equal(pausedTree.body.nodes.find((node) => node.id === root.id)?.children[0]?.children[0]?.chainMode, "paused");

    // Revoking the parent revokes the sub-agent with it.
    const revoked = await call<{ revoked: string[] }>(server, "POST", `/agents/${main.id}/revoke`, { key: root.key });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.deepEqual([...revoked.body.revoked].sort(), [main.id, sub.id].sort());
    assertError(await call(server, "GET", "/keys", { key: sub.key }), 401, "INVALID_API_KEY");
    assert.ok(events.some((event) => event.type === "agent.subagent_revoked"));
  });

  it("an agent revokes its own sub-agent but nothing above it", async () => {
    const root = await issue("root");
    const main = await agentUnder(root.id, root.key);
    const filed = await fileRequest(main);
    await decide(filed.request.id, "approve", undefined, root.key);
    const sub = (await claim(filed.request.id, main, filed.claimToken)).body.key;
    assertError(await call(server, "POST", `/agents/${main.id}/revoke`, { key: sub.key }), 404, "KEY_NOT_FOUND");
    assertError(await call(server, "POST", `/agents/${root.id}/revoke`, { key: main.key }), 404, "KEY_NOT_FOUND");
    const revoked = await call<{ revoked: string[] }>(server, "POST", `/agents/${sub.id}/revoke`, { key: main.key });
    assert.deepEqual(revoked.body.revoked, [sub.id]);
  });

  it("enforces depth and open-request limits", async () => {
    const root = await issue("root");
    const level1 = await agentUnder(root.id, root.key);
    const level2 = await agentUnder(level1.id, root.key, MAIN_POLICY, "level-2", 20);
    const level3 = await agentUnder(level2.id, root.key, MAIN_POLICY, "level-3", 10);
    assertError(await call(server, "POST", `/agents/${level3.id}/subagents`, { key: level3.key, body: { name: "x", purpose: "y", policy: SUB_POLICY } }), 409, "KEY_DEPTH_EXCEEDED");
    // At depth 3 a sub-agent cannot get createChildKeys.
    const nested = await call<ErrorEnvelope>(server, "POST", `/agents/${level2.id}/subagents`, { key: level2.key, body: { name: "x", purpose: "y", policy: { ...SUB_POLICY, permissions: { createChildKeys: true } } } });
    assertError(nested, 403, "SUBAGENT_POLICY_NOT_SUBSET");
    for (let index = 0; index < SUBAGENT_LIMITS.openRequestsPerParent; index += 1) await fileRequest(level1, SUB_POLICY, `helper-${index}`);
    assertError(await call(server, "POST", `/agents/${level1.id}/subagents`, { key: level1.key, body: { name: "one-more", purpose: "y", policy: SUB_POLICY } }), 409, "SUBAGENT_LIMIT_REACHED");
  });

  it("lapses: a revoked parent cancels its requests, an unclaimed key is revoked after the claim window", async () => {
    const root = await issue("root");
    const main = await agentUnder(root.id, root.key);
    const open = await fileRequest(main, SUB_POLICY, "never-decided");
    const late = await fileRequest(main, SUB_POLICY, "never-claimed");
    await decide(late.request.id, "approve", undefined, root.key);
    const auth = { tier: "developer" as const, keyId: main.id, projectId: root.id, keyKind: "agent" as const };
    const afterWindow = Date.now() + (SUBAGENT_LIMITS.claimWindowSeconds + 60) * 1000;
    await assert.rejects(service.claimSubagent(auth, late.request.id, { claimToken: late.claimToken }, afterWindow), (error: { code?: string }) => error.code === "SUBAGENT_CLAIM_INVALID");
    const lapsed = await service.getSubagentRequest(auth, late.request.id, afterWindow);
    assert.deepEqual([lapsed.status, lapsed.reason], ["expired", "claim_window"]);
    const childRecord = await apiKeyStore().findById(lapsed.childKeyId ?? "");
    assert.ok(childRecord?.revokedAt, "the unclaimed key was revoked");
    const tooLate = await service.getSubagentRequest(auth, open.request.id, Date.now() + (SUBAGENT_LIMITS.requestTtlSeconds + 60) * 1000);
    assert.equal(tooLate.status, "expired");

    const other = await agentUnder(root.id, root.key, MAIN_POLICY, "other");
    const orphan = await fileRequest(other);
    assert.equal((await call(server, "DELETE", `/keys/${other.id}`, { key: root.key })).status, 204);
    const tree = await call<{ requests: RequestView[] }>(server, "GET", "/agents/tree", { key: root.key });
    const cancelled = tree.body.requests.find((request) => request.id === orphan.request.id);
    assert.deepEqual([cancelled?.status, cancelled?.reason], ["cancelled", "parent_inactive"]);
    assertError(await decide(orphan.request.id, "approve", undefined, root.key), 409, "SUBAGENT_REQUEST_DECIDED");
  });

  it("MCP: request, list, claim and revoke with the agent's own key", async () => {
    const root = await issue("root");
    const main = await agentUnder(root.id, root.key);
    let sequence = 0;
    const tool = async (name: string, args: Record<string, unknown>, key: string) => {
      sequence += 1;
      const reply = await call<{ result?: { structuredContent: Record<string, unknown>; isError?: boolean; content: { text: string }[] } }>(server, "POST", "/mcp", {
        key,
        headers: { accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": name },
        body: {
          jsonrpc: "2.0",
          id: sequence,
          method: "tools/call",
          params: { name, arguments: args, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "t", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } },
        },
      });
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      return reply.body.result;
    };
    const requested = await tool("request_subagent", { name: "helper", purpose: "Bridges for the main agent.", policy: SUB_POLICY }, main.key);
    assert.equal(requested?.isError, undefined, JSON.stringify(requested));
    const requestId = String(requested?.structuredContent.requestId);
    const claimToken = String(requested?.structuredContent.claimToken);
    assert.equal(requested?.structuredContent.status, "pending");
    const refused = await tool("request_subagent", { name: "x", purpose: "y" }, root.key);
    assert.equal(refused?.isError, true, "project keys do not request through MCP");
    await decide(requestId, "approve", undefined, root.key);
    const listed = await tool("list_subagents", {}, main.key);
    assert.equal((listed?.structuredContent.requests as { status: string }[])[0]?.status, "approved");
    const claimed = await tool("claim_subagent", { requestId, claimToken }, main.key);
    assert.match(String(claimed?.structuredContent.key), /^kl_agt_/u);
    assert.doesNotMatch(claimed?.content[0]?.text ?? "", /kl_agt_/u, "the key stays out of the text part");
    const revoked = await tool("revoke_subagent", { keyId: claimed?.structuredContent.keyId }, main.key);
    assert.deepEqual(revoked?.structuredContent.revoked, [claimed?.structuredContent.keyId]);
  });
});

/* ------------------------------------------------------------ the store */

const { MemorySubagentRequestStore, PostgresSubagentRequestStore } = await import("../agents/store.js");
const { closePlatformDatabase } = await import("../db.js");
type Store = InstanceType<typeof MemorySubagentRequestStore> | InstanceType<typeof PostgresSubagentRequestStore>;

function storeContract(name: string, make: () => Store): void {
  describe(`${name} sub-agent request store`, () => {
    it("serialises creation per parent, consumes a challenge once and lets one transition win", async () => {
      const store = make();
      const parent = `key_${randomBytes(12).toString("hex")}`;
      const project = `key_${randomBytes(12).toString("hex")}`;
      const now = Date.now();
      const record = (id: string) => ({
        id,
        projectId: project,
        parentKeyId: parent,
        name: "helper",
        purpose: "test",
        policy: { schema: "kletia.policy/v1" as const, mode: "dry-run" as const },
        policyHash: `sha256:${"0".repeat(64)}`,
        keyExpiresAt: new Date(now + 86_400_000).toISOString(),
        status: "pending" as const,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 3_600_000).toISOString(),
        decidedAt: null,
        decidedBy: null,
        childKeyId: null,
        claimTokenHash: "ab".repeat(32),
        claimedAt: null,
        challenge: null,
        reason: null,
      });
      const ids = [1, 2, 3].map(() => `sar_${randomBytes(16).toString("hex")}`);
      const created = await Promise.allSettled(ids.map((id) => store.create(record(id), 2)));
      assert.equal(created.filter((result) => result.status === "fulfilled").length, 2, "at most 2 open per parent, even concurrently");
      const first = (await store.list(project, [parent], 10))[0]?.id ?? "";
      assert.equal(await store.countPending([project], now), 2);
      const challenge = { nonceHash: "cd".repeat(32), message: "m", origin: PORTAL_ORIGIN, walletKind: "evm" as const, address: "0xabc", chainId: 8453, decision: "approve" as const, expiresAt: new Date(now + 600_000).toISOString() };
      assert.equal(await store.setChallenge(first, challenge), true);
      assert.equal(await store.consumeChallenge(first, "ef".repeat(32), now), null, "another nonce");
      assert.equal(await store.consumeChallenge(first, challenge.nonceHash, now + 601_000), null, "expired");
      assert.deepEqual(await store.consumeChallenge(first, challenge.nonceHash, now), challenge);
      assert.equal(await store.consumeChallenge(first, challenge.nonceHash, now), null, "single use");
      const decider = { kind: "key" as const, keyId: `key_${"1".repeat(24)}` };
      const raced = await Promise.all([1, 2, 3].map(() => store.transition(first, ["pending"], "approved", { decidedAt: new Date(now).toISOString(), decidedBy: decider })));
      assert.equal(raced.filter((entry) => entry !== null).length, 1, "one winner");
      const minted = await store.transition(first, ["approved"], "approved", { childKeyId: `key_${"2".repeat(24)}` });
      assert.deepEqual([minted?.status, minted?.childKeyId, minted?.decidedBy], ["approved", `key_${"2".repeat(24)}`, decider]);
      assert.equal(await store.setChallenge(first, challenge), false, "decided requests take no challenge");
      assert.equal(await store.countPending([project], now), 1);
    });
  });
}

storeContract("memory", () => new MemorySubagentRequestStore());

const databaseUrl = process.env.KLETIA_TEST_DATABASE_URL?.trim();
if (databaseUrl) {
  describe("postgres", () => {
    before(() => {
      process.env.KLETIA_DATABASE_URL = databaseUrl;
    });
    after(async () => {
      delete process.env.KLETIA_DATABASE_URL;
      await closePlatformDatabase();
    });
    storeContract("postgres", () => new PostgresSubagentRequestStore());
  });
} else {
  describe("postgres sub-agent request store", () => {
    it("is exercised when KLETIA_TEST_DATABASE_URL is set", { skip: "KLETIA_TEST_DATABASE_URL not set" }, () => undefined);
  });
}
