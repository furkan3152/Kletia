/**
 * Rule Book HTTP flows shared by the memory run (policies.test.ts) and the
 * Postgres run (policiesPg.test.ts): agent keys, rule book versions, the
 * installed gate, approvals (key, EIP-712 wallet, Solana message) and the
 * decision log. Not a test file itself.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signEd25519 } from "node:crypto";
import { describe, it } from "node:test";
import { getBase58Decoder } from "@solana/kit";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  approvalMessageText,
  approvalTypedData,
  CHAINS,
  POLICY_DECISION_GENESIS,
  verifyDecisionChain,
  type IntentGraph,
  type PolicyDecision,
} from "@kletia/core";
import { ACCOUNTS, OTHER_EVM_ADDRESS } from "../../engine/__tests__/helpers.js";
import { assertError, call, type ErrorEnvelope, type Reply, type TestServer } from "./support.js";

export interface IssuedKey {
  readonly id: string;
  readonly key: string;
}

interface PolicyError extends ErrorEnvelope {
  readonly error: ErrorEnvelope["error"] & {
    readonly policy?: {
      readonly decisionId: string | null;
      readonly stage: string;
      readonly keyId: string | null;
      readonly violations: readonly { readonly rule: string; readonly path?: string }[];
      readonly retryAt: string | null;
      readonly approval?: { readonly id: string; readonly url: string; readonly status?: string };
    };
  };
}

const BRIDGE = (amount: number) => ({ text: `bridge ${amount} USDC from base to arbitrum`, accounts: ACCOUNTS });

async function issue(server: TestServer, name: string, key?: string): Promise<IssuedKey> {
  const reply = await call<{ key: IssuedKey }>(server, "POST", "/keys", { body: { name }, ...(key ? { key } : {}) });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return reply.body.key;
}

async function child(server: TestServer, parent: string, key: string, body: Record<string, unknown> = { name: "bot" }): Promise<IssuedKey & { kind: string; depth: number; expiresAt: string }> {
  const reply = await call<{ key: IssuedKey & { kind: string; depth: number; expiresAt: string } }>(server, "POST", `/keys/${parent}/children`, { key, body });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return reply.body.key;
}

async function putPolicy(server: TestServer, path: string, key: string, document: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Reply<{ policy: { version: number; hash: string; status: string; activatesAt: string | null }; applied: string; loosened: string[] }>> {
  return call(server, "PUT", path, { key, body: { schema: "kletia.policy/v1", ...document }, headers });
}

/** Registers the shared flows; `current()` returns the server of the running test. */
export function ruleBookFlows(current: () => TestServer): void {
  describe("agent keys", () => {
    it("issues kl_agt_ children under a key, with a first rule book, depth and expiry limits", async () => {
      const root = await issue(current(), "root");
      const agent = await child(current(), root.id, root.key, { name: "research-bot", template: "observer", expiresInSeconds: 7_200 });
      assert.match(agent.key, /^kl_agt_[0-9A-Za-z]{32}$/u);
      assert.equal(agent.kind, "agent");
      assert.equal(agent.depth, 1);
      assert.ok(Math.abs(Date.parse(agent.expiresAt) - Date.now() - 7_200_000) < 60_000);
      const listed = await call<{ keys: { id: string; kind: string; parentId: string | null; policyVersion: number | null; descendants: number }[] }>(current(), "GET", "/keys", { key: root.key });
      assert.equal(listed.body.keys.find((entry) => entry.id === agent.id)?.parentId, root.id);
      assert.equal(listed.body.keys.find((entry) => entry.id === agent.id)?.policyVersion, 1);
      assert.equal(listed.body.keys.find((entry) => entry.id === root.id)?.descendants, 1);
      // The agent authenticates and sees only its own subtree.
      const own = await call<{ keys: { id: string }[] }>(current(), "GET", "/keys", { key: agent.key });
      assert.deepEqual(own.body.keys.map((entry) => entry.id), [agent.id]);
      assertError(await call(current(), "POST", `/keys/${root.id}/children`, { key: root.key, body: { name: "x", expiresInSeconds: 60 } }), 400, "INVALID_REQUEST");
      assertError(await call(current(), "POST", `/keys/${root.id}/children`, { key: root.key, body: { name: "x", template: "payments-agent" } }), 400, "POLICY_INVALID");
      assertError(await call(current(), "POST", `/keys/${root.id}/children`, { key: root.key, body: { name: "x", policy: { schema: "kletia.policy/v1", mode: "fast" } } }), 400, "POLICY_INVALID");
      // An agent cannot outlive its parent; depth stops at 2 below the project key.
      const second = await child(current(), agent.id, root.key, { name: "level-2", expiresInSeconds: 3_600 });
      assert.equal(second.depth, 2);
      assertError(await call(current(), "POST", `/keys/${agent.id}/children`, { key: root.key, body: { name: "late", expiresInSeconds: 10_000 } }), 400, "INVALID_REQUEST");
      assertError(await call(current(), "POST", `/keys/${second.id}/children`, { key: root.key, body: { name: "level-3", expiresInSeconds: 3_600 } }), 409, "KEY_DEPTH_EXCEEDED");
    });

    it("replays a child creation sealed under Idempotency-Key", async () => {
      const root = await issue(current(), "root");
      const headers = { "idempotency-key": "child-create-1" };
      const first = await call<{ key: IssuedKey }>(current(), "POST", `/keys/${root.id}/children`, { key: root.key, body: { name: "bot" }, headers });
      const replay = await call<{ key: IssuedKey }>(current(), "POST", `/keys/${root.id}/children`, { key: root.key, body: { name: "bot" }, headers });
      assert.equal(first.status, 201);
      assert.equal(replay.status, 201);
      assert.equal(replay.headers.get("idempotent-replayed"), "true");
      assert.equal(replay.body.key.key, first.body.key.key);
    });

    it("forbids agents what their rule book does not grant, and never project key or rule book management", async () => {
      const root = await issue(current(), "root");
      const agent = await child(current(), root.id, root.key, { name: "bot" });
      assertError(await call(current(), "POST", "/keys", { key: agent.key, body: { name: "escalate" } }), 403, "AGENT_KEY_FORBIDDEN");
      assertError(await call(current(), "POST", "/webhooks", { key: agent.key, body: { url: "https://93.184.215.14/hook" } }), 403, "AGENT_KEY_FORBIDDEN");
      assertError(await call(current(), "POST", "/sessions", { key: agent.key, body: {} }), 403, "AGENT_KEY_FORBIDDEN");
      assertError(await call(current(), "POST", "/contracts", { key: agent.key, body: {} }), 403, "AGENT_KEY_FORBIDDEN");
      assertError(await call(current(), "POST", `/keys/${agent.id}/children`, { key: agent.key, body: { name: "grandchild" } }), 403, "AGENT_KEY_FORBIDDEN");
      assertError(await putPolicy(current(), `/keys/${agent.id}/policy`, agent.key, { mode: "live" }), 403, "AGENT_KEY_FORBIDDEN");
      assertError(await putPolicy(current(), "/projects/current/policy", agent.key, { mode: "live" }), 403, "AGENT_KEY_FORBIDDEN");
      assertError(await call(current(), "DELETE", `/keys/${agent.id}`, { key: agent.key }), 403, "AGENT_KEY_FORBIDDEN");
      assertError(await call(current(), "DELETE", `/keys/${root.id}`, { key: agent.key }), 404, "KEY_NOT_FOUND");
      // The parent grants child keys: the agent may create one under itself, and manage it.
      const granted = await putPolicy(current(), `/keys/${agent.id}/policy`, root.key, { mode: "live", permissions: { createChildKeys: true } });
      assert.equal(granted.status, 200, JSON.stringify(granted.body));
      assert.equal(granted.body.applied, "now");
      const grandchild = await child(current(), agent.id, agent.key, { name: "helper", expiresInSeconds: 3_600 });
      const rotated = await call<{ key: { key: string } }>(current(), "POST", `/keys/${grandchild.id}/rotate`, { key: agent.key, body: { graceSeconds: 0 } });
      assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
      assert.match(rotated.body.key.key, /^kl_agt_/u, "rotation keeps the agent prefix");
      // Stored intents need the permission: the observer default refuses them, dry runs plan.
      const dry = await call<{ intent: IntentGraph }>(current(), "POST", "/intents?dryRun=true", { key: rotated.body.key.key, body: BRIDGE(5) });
      assert.equal(dry.status, 200, JSON.stringify(dry.body));
      const stored = await call<PolicyError>(current(), "POST", "/intents", { key: rotated.body.key.key, body: BRIDGE(5) });
      assertError(stored, 403, "POLICY_VIOLATION");
      assert.deepEqual(stored.body.error.policy?.violations.map((violation) => violation.rule), ["mode.dryRun"]);
    });

    it("revokes a subtree in one write; descendants stop authenticating and preparing", async () => {
      const root = await issue(current(), "root");
      const agent = await child(current(), root.id, root.key, { name: "bot", policy: { schema: "kletia.policy/v1", mode: "live", recipients: { mode: "any" }, permissions: { createChildKeys: true } } });
      const grandchild = await child(current(), agent.id, root.key, { name: "helper", expiresInSeconds: 3_600, policy: { schema: "kletia.policy/v1", mode: "live", recipients: { mode: "any" } } });
      const created = await call<{ intent: IntentGraph }>(current(), "POST", "/intents", { key: grandchild.key, body: BRIDGE(5) });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.intent.policy?.outcome, "allow");
      const revoked = await call(current(), "DELETE", `/keys/${agent.id}`, { key: root.key });
      assert.equal(revoked.status, 204);
      assertError(await call(current(), "GET", "/keys", { key: grandchild.key }), 401, "INVALID_API_KEY");
      assertError(await call(current(), "GET", "/keys", { key: agent.key }), 401, "INVALID_API_KEY");
      const prepare = await call<PolicyError>(current(), "POST", `/intents/${created.body.intent.id}/steps/s1/prepare`, {});
      assertError(prepare, 403, "POLICY_OWNER_REVOKED");
      assert.equal(prepare.body.error.policy?.violations[0]?.rule, "key.status");
      const listed = await call<{ keys: { id: string; revokedAt: string | null }[] }>(current(), "GET", "/keys", { key: root.key });
      assert.ok(listed.body.keys.filter((entry) => entry.id !== root.id).every((entry) => entry.revokedAt !== null), "the cascade revoked the whole subtree");
    });

    it("shortens expiry at once and refuses to extend past the parent", async () => {
      const root = await issue(current(), "root");
      const agent = await child(current(), root.id, root.key, { name: "bot", expiresInSeconds: 86_400 });
      const shorter = new Date(Date.now() + 3_600_000).toISOString();
      const patched = await call<{ key: { expiresAt: string } }>(current(), "PATCH", `/keys/${agent.id}`, { key: root.key, body: { expiresAt: shorter } });
      assert.equal(patched.status, 200, JSON.stringify(patched.body));
      assert.equal(patched.body.key.expiresAt, shorter);
      assertError(await call(current(), "PATCH", `/keys/${agent.id}`, { key: root.key, body: { expiresAt: null } }), 400, "INVALID_REQUEST");
      assertError(await call(current(), "PATCH", `/keys/${agent.id}`, { key: root.key, body: { expiresAt: new Date(Date.now() - 1_000).toISOString() } }), 400, "INVALID_REQUEST");
    });
  });

  describe("rule books", () => {
    it("applies tightening at once, holds loosening for the old delay, and honours If-Match", async () => {
      const root = await issue(current(), "root");
      const path = `/keys/${root.id}/policy`;
      const first = await putPolicy(current(), path, root.key, { caps: { dailyUsd: "1000" }, amendments: { delaySeconds: 1 } });
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(first.body.applied, "now");
      assert.equal(first.headers.get("etag"), `"${first.body.policy.hash}"`);
      const tighter = await putPolicy(current(), path, root.key, { caps: { dailyUsd: "500" }, amendments: { delaySeconds: 1 } }, { "if-match": `"${first.body.policy.hash}"` });
      assert.equal(tighter.body.applied, "now");
      assert.deepEqual(tighter.body.loosened, []);
      assertError(await putPolicy(current(), path, root.key, { caps: { dailyUsd: "400" } }, { "if-match": first.body.policy.hash }), 409, "POLICY_CONFLICT");
      const looser = await putPolicy(current(), path, root.key, { caps: { dailyUsd: "2000" }, amendments: { delaySeconds: 1 } });
      assert.equal(looser.body.applied, "pending");
      assert.deepEqual(looser.body.loosened, ["caps.dailyUsd"]);
      assert.ok(looser.body.policy.activatesAt);
      const read = await call<{ policy: { version: number; pending: { version: number } | null }; effective: { chain: { id: string }[] } }>(current(), "GET", path, { key: root.key });
      assert.equal(read.body.policy.version, tighter.body.policy.version);
      assert.equal(read.body.policy.pending?.version, looser.body.policy.version);
      assertError(await call(current(), "DELETE", path, { key: root.key }), 409, "POLICY_AMENDMENT_PENDING");
      const cancelled = await call<{ policy: { status: string } }>(current(), "DELETE", `${path}/pending`, { key: root.key });
      assert.equal(cancelled.body.policy.status, "cancelled");
      assertError(await call(current(), "DELETE", `${path}/pending`, { key: root.key }), 404, "POLICY_NOT_FOUND");
      const again = await putPolicy(current(), path, root.key, { caps: { dailyUsd: "3000" }, amendments: { delaySeconds: 1 } });
      assert.equal(again.body.applied, "pending");
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const promoted = await call<{ policy: { version: number; document: { caps: { dailyUsd: string } }; pending: unknown } }>(current(), "GET", path, { key: root.key });
      assert.equal(promoted.body.policy.version, again.body.policy.version, "promoted lazily on read");
      assert.equal(promoted.body.policy.document.caps.dailyUsd, "3000");
      assert.equal(promoted.body.policy.pending, null);
      const versions = await call<{ versions: { version: number; status: string }[] }>(current(), "GET", `${path}/versions`, { key: root.key });
      // v1, v2 tightened (superseded), v3 loosened then cancelled, v4 loosened then promoted.
      assert.deepEqual(versions.body.versions.map((entry) => `${entry.version}:${entry.status}`), ["4:active", "3:cancelled", "2:superseded", "1:superseded"]);
      assertError(await call(current(), "PUT", path, { key: root.key, body: { schema: "kletia.policy/v1", caps: { dailyUsd: "ten" } } }), 400, "POLICY_INVALID");
      // Removal is a loosening of everything: pending for the active version's delay.
      const removal = await call<{ applied: string; policy: { status: string } }>(current(), "DELETE", path, { key: root.key });
      assert.equal(removal.body.applied, "pending");
    });

    it("bounds every key by the project rule book and refuses with error.policy", async () => {
      const root = await issue(current(), "root");
      const paused = await putPolicy(current(), "/projects/current/policy", root.key, { mode: "paused" });
      assert.equal(paused.status, 200, JSON.stringify(paused.body));
      const refused = await call<PolicyError>(current(), "POST", "/intents", { key: root.key, body: BRIDGE(5) });
      assertError(refused, 403, "POLICY_VIOLATION");
      assert.equal(refused.body.error.policy?.stage, "plan");
      assert.deepEqual(refused.body.error.policy?.violations.map((violation) => violation.rule), ["mode.paused"]);
      assert.match(refused.body.error.policy?.decisionId ?? "", /^pdc_[0-9a-f]{24}$/u);
      // Keyless intents are not governed (the public tier exists).
      assert.equal((await call(current(), "POST", "/intents?dryRun=true", { body: BRIDGE(5) })).status, 200);
      const read = await call<{ policy: { document: { mode: string } } }>(current(), "GET", "/projects/current/policy", { key: root.key });
      assert.equal(read.body.policy.document.mode, "paused");
    });

    it("validates offline and explains a request in the simulator", async () => {
      const valid = await call<{ valid: boolean; hash: string; comparison: { loosened: string[] } }>(current(), "POST", "/policy/validate", {
        body: { policy: { schema: "kletia.policy/v1", caps: { dailyUsd: "100" } }, against: { schema: "kletia.policy/v1", caps: { dailyUsd: "50" } } },
      });
      assert.equal(valid.body.valid, true);
      assert.match(valid.body.hash, /^sha256:[0-9a-f]{64}$/u);
      assert.deepEqual(valid.body.comparison.loosened, ["caps.dailyUsd"]);
      const invalid = await call<{ valid: boolean; issues: { path: string }[] }>(current(), "POST", "/policy/validate", { body: { policy: { schema: "kletia.policy/v1", nope: 1 } } });
      assert.equal(invalid.body.valid, false);
      assert.ok(invalid.body.issues.length > 0);

      const root = await issue(current(), "root");
      const evaluation = await call<{ evaluation: { outcome: string; rules: { rule: string; status: string }[]; notionalUsd: string | null; decisionId: string }; intent: IntentGraph | null }>(
        current(), "POST", "/policy/evaluate", {
          key: root.key,
          body: { request: { text: `send 10 USDC to ${OTHER_EVM_ADDRESS} on base`, accounts: ACCOUNTS }, policy: { schema: "kletia.policy/v1", recipients: { mode: "own" }, caps: { perIntentUsd: "5" } } },
        },
      );
      assert.equal(evaluation.status, 200, JSON.stringify(evaluation.body));
      assert.equal(evaluation.body.evaluation.outcome, "deny");
      const failed = evaluation.body.evaluation.rules.filter((rule) => rule.status === "fail").map((rule) => rule.rule).sort();
      assert.deepEqual(failed, ["caps.perIntentUsd", "recipients.mode"]);
      assert.ok(evaluation.body.intent, "the dry-run plan is returned");
      // The draft never changed the stored rule book.
      const stored = await call<{ policy: unknown }>(current(), "GET", `/keys/${root.id}/policy`, { key: root.key });
      assert.equal(stored.body.policy, null);
    });
  });

  describe("approvals", () => {
    async function heldIntent(key: IssuedKey, document: Record<string, unknown>): Promise<{ intent: IntentGraph; approvalId: string }> {
      const put = await putPolicy(current(), `/keys/${key.id}/policy`, key.key, document);
      assert.equal(put.status, 200, JSON.stringify(put.body));
      const created = await call<{ intent: IntentGraph }>(current(), "POST", "/intents", { key: key.key, body: BRIDGE(100) });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const approval = created.body.intent.policy?.approval;
      assert.ok(approval, "the plan stamped a hold");
      return { intent: created.body.intent, approvalId: approval.id };
    }

    it("holds a stored intent until a project key outside the requester approves it", async () => {
      const root = await issue(current(), "root");
      const sibling = await issue(current(), "approver", root.key);
      const { intent, approvalId } = await heldIntent(root, { confirm: { aboveUsd: "50" } });
      assert.equal(intent.policy?.outcome, "confirm");
      const held = await call<PolicyError>(current(), "POST", `/intents/${intent.id}/steps/s1/prepare`, {});
      assertError(held, 403, "POLICY_APPROVAL_REQUIRED");
      assert.equal(held.headers.get("retry-after"), "15");
      assert.equal(held.body.error.policy?.approval?.id, approvalId);
      const view = await call<{ approval: { status: string; ceilingUsd: string; recipients: string[]; approvers: { requireWallet: boolean } } }>(current(), "GET", `/policy/approvals/${approvalId}`);
      assert.equal(view.status, 200);
      assert.equal(view.body.approval.status, "pending");
      assert.equal(view.body.approval.ceilingUsd, "102.00");
      assertError(await call(current(), "POST", `/policy/approvals/${approvalId}/approve`, { key: root.key }), 403, "APPROVER_NOT_ALLOWED");
      assertError(await call(current(), "POST", `/policy/approvals/${approvalId}/approve`), 401, "API_KEY_REQUIRED");
      const approved = await call<{ approval: { status: string; decidedBy: { kind: string } } }>(current(), "POST", `/policy/approvals/${approvalId}/approve`, { key: sibling.key });
      assert.equal(approved.status, 200, JSON.stringify(approved.body));
      assert.equal(approved.body.approval.status, "approved");
      assert.equal((await call(current(), "POST", `/policy/approvals/${approvalId}/approve`, { key: sibling.key })).status, 200, "idempotent by state");
      assertError(await call(current(), "POST", `/policy/approvals/${approvalId}/reject`, { key: sibling.key }), 409, "APPROVAL_DECIDED");
      const prepared = await call<{ payload: { policy?: { decisionId: string; exposureId: string } } }>(current(), "POST", `/intents/${intent.id}/steps/s1/prepare`, {});
      assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
      assert.match(prepared.body.payload.policy?.exposureId ?? "", /^px_[0-9a-f]{24}$/u);
      const mine = await call<{ approvals: { id: string }[] }>(current(), "GET", "/policy/approvals?role=requester", { key: root.key });
      assert.deepEqual(mine.body.approvals.map((entry) => entry.id), [approvalId]);
      assertError(await call(current(), "GET", `/policy/approvals/apr_${"0".repeat(32)}`), 404, "APPROVAL_NOT_FOUND");
    });

    it("accepts only listed wallets under requireWallet: EIP-712 and Solana message signatures", async () => {
      const root = await issue(current(), "root");
      const sibling = await issue(current(), "approver", root.key);
      const evm = privateKeyToAccount(generatePrivateKey());
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const solanaAddress = getBase58Decoder().decode(new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(-32)));
      const evmSigner = `eip155:8453:${evm.address}`;
      const solanaSigner = `solana:${CHAINS.solana.reference}:${solanaAddress}`;
      const document = { confirm: { aboveUsd: "50", approvers: { wallets: [`eip155:*:${evm.address}`, solanaSigner], requireWallet: true } } };

      const first = await heldIntent(root, document);
      assertError(await call(current(), "POST", `/policy/approvals/${first.approvalId}/approve`, { key: sibling.key }), 403, "APPROVER_NOT_ALLOWED");
      const view = await call<{ approval: { signing: { digest: string; ceilingUsdCents: string; maxExpiresAt: number }; approvers: { wallets: string[] } } }>(current(), "GET", `/policy/approvals/${first.approvalId}`);
      assert.ok(view.body.approval.approvers.wallets.every((wallet) => wallet.includes("…")), "approver wallets are masked");
      const { signing } = view.body.approval;
      const expiresAt = Math.min(signing.maxExpiresAt, Math.floor(Date.now() / 1000) + 600);
      const input = { approvalId: first.approvalId, intentId: first.intent.id, digest: signing.digest, ceilingUsdCents: signing.ceilingUsdCents, expiresAt };
      // A signature over another ceiling never counts.
      const tampered = await evm.signTypedData(approvalTypedData({ ...input, ceilingUsdCents: "99999999", decision: "approve", signer: evmSigner }));
      assertError(await call(current(), "POST", `/policy/approvals/${first.approvalId}/approve`, { body: { account: evmSigner, signature: tampered, expiresAt } }), 403, "APPROVAL_SIGNATURE_INVALID");
      const stranger = privateKeyToAccount(generatePrivateKey());
      const foreign = await stranger.signTypedData(approvalTypedData({ ...input, decision: "approve", signer: `eip155:8453:${stranger.address}` }));
      assertError(await call(current(), "POST", `/policy/approvals/${first.approvalId}/approve`, { body: { account: `eip155:8453:${stranger.address}`, signature: foreign, expiresAt } }), 403, "APPROVER_NOT_ALLOWED");
      const signature = await evm.signTypedData(approvalTypedData({ ...input, decision: "approve", signer: evmSigner }));
      const approved = await call<{ approval: { status: string; decidedBy: { kind: string; id: string } } }>(current(), "POST", `/policy/approvals/${first.approvalId}/approve`, { body: { account: evmSigner, signature, expiresAt } });
      assert.equal(approved.status, 200, JSON.stringify(approved.body));
      assert.equal(approved.body.approval.decidedBy.kind, "wallet");

      const second = await heldIntent(root, document);
      const secondView = await call<{ approval: { signing: { digest: string; ceilingUsdCents: string; maxExpiresAt: number } } }>(current(), "GET", `/policy/approvals/${second.approvalId}`);
      const secondInput = { approvalId: second.approvalId, intentId: second.intent.id, digest: secondView.body.approval.signing.digest, ceilingUsdCents: secondView.body.approval.signing.ceilingUsdCents, expiresAt, decision: "reject" as const };
      const message = Buffer.from(approvalMessageText(secondInput), "utf8");
      const solanaSignature = getBase58Decoder().decode(new Uint8Array(signEd25519(null, message, privateKey)));
      const rejected = await call<{ approval: { status: string } }>(current(), "POST", `/policy/approvals/${second.approvalId}/reject`, { body: { account: solanaSigner, signature: solanaSignature, expiresAt } });
      assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
      assert.equal(rejected.body.approval.status, "rejected");
      const intent = await call<{ intent: IntentGraph }>(current(), "GET", `/intents/${second.intent.id}`);
      assert.equal(intent.body.intent.status, "cancelled", "a rejection cancels the intent");
      assertError(await call(current(), "POST", `/intents/${second.intent.id}/steps/s1/prepare`, {}), 409, "INTENT_CANCELLED");
    });
  });

  describe("decision log", () => {
    it("is hash-chained per project and scoped to the caller's subtree", async () => {
      const root = await issue(current(), "root");
      const agent = await child(current(), root.id, root.key, { name: "bot", policy: { schema: "kletia.policy/v1", mode: "live", recipients: { mode: "own" } } });
      assertError(await call(current(), "POST", "/intents", { key: agent.key, body: { text: `send 10 USDC to ${OTHER_EVM_ADDRESS} on base`, accounts: ACCOUNTS } }), 403, "POLICY_VIOLATION");
      await putPolicy(current(), `/keys/${root.id}/policy`, root.key, { caps: { dailyUsd: "100" } });
      const all = await call<{ decisions: PolicyDecision[]; head: { seq: number; chainHash: string } }>(current(), "GET", "/policy/decisions?limit=200", { key: root.key });
      assert.equal(all.status, 200, JSON.stringify(all.body));
      assert.ok(all.body.decisions.length >= 4, "key creation, amendments and the denial are logged");
      const verified = verifyDecisionChain(all.body.decisions);
      assert.equal(verified.valid, true, verified.problems.join("; "));
      assert.equal(all.body.decisions.at(-1)?.prevHash, POLICY_DECISION_GENESIS);
      assert.equal(all.body.head.chainHash, all.body.decisions[0]?.chainHash);
      const denials = await call<{ decisions: PolicyDecision[] }>(current(), "GET", "/policy/decisions?outcome=deny", { key: root.key });
      assert.deepEqual(denials.body.decisions.map((decision) => decision.violations[0]?.rule), ["recipients.mode"]);
      const agentView = await call<{ decisions: PolicyDecision[] }>(current(), "GET", "/policy/decisions", { key: agent.key });
      assert.ok(agentView.body.decisions.every((decision) => decision.keyId === agent.id), "an agent sees its own subtree only");
      const one = await call<{ decision: PolicyDecision }>(current(), "GET", `/policy/decisions/${denials.body.decisions[0]?.id}`, { key: root.key });
      assert.equal(one.body.decision.outcome, "deny");
      const spend = await call<{ spend: { scopes: { scope: string; capDailyUsd: string | null; usedDailyUsd: string }[] } }>(current(), "GET", "/policy/spend", { key: root.key });
      assert.equal(spend.body.spend.scopes.find((scope) => scope.scope === root.id)?.capDailyUsd, "100");
    });
  });

}
