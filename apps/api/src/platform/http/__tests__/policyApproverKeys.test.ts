/** Regression: dropping the approver key list loosens the rule book, so it waits out the amendment delay. */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { comparePolicies, validatePolicy, type IntentGraph } from "@kletia/core";
import { configurePlatform, configurePolicyPricing, configurePolicyReads } from "../../index.js";
import { resetEngine } from "../../engine/__tests__/helpers.js";
import { ACCOUNTS } from "../../engine/__tests__/helpers.js";
import { installMarket, standardPrices } from "../../engine/__tests__/policyHarness.js";
import { call, serve, useTestEnvironment, type TestServer } from "./support.js";

useTestEnvironment();
const { createPlatformRouter, platformErrorHandler } = await import("../index.js");

let server: TestServer;

before(async () => {
  resetEngine();
  standardPrices(installMarket());
  configurePolicyReads({ pendingNonce: async () => 7n, solanaBlockHeight: async () => 500n });
  server = await serve((app) => app.use("/v1", createPlatformRouter(), platformErrorHandler));
});

after(async () => {
  await server.close();
  configurePlatform({ adapters: null });
  configurePolicyPricing(null);
  configurePolicyReads(null);
});

async function issue(name: string, key?: string): Promise<{ id: string; key: string }> {
  const reply = await call<{ key: { id: string; key: string } }>(server, "POST", "/keys", { body: { name }, ...(key ? { key } : {}) });
  assert.equal(reply.status, 201, JSON.stringify(reply.body));
  return reply.body.key;
}

describe("approver keys loosening", () => {
  it("core: keys [A] -> none is reported as looser", () => {
    const a = validatePolicy({ schema: "kletia.policy/v1", confirm: { aboveUsd: "1", approvers: { keys: ["key_aaaaaaaaaaaaaaaaaaaaaaaa"] } } }).value;
    const b = validatePolicy({ schema: "kletia.policy/v1", confirm: { aboveUsd: "1" } }).value;
    const comparison = comparePolicies(a, b);
    assert.ok(comparison.loosened.includes("confirm.approvers.keys"), "classified looser");
    assert.ok(!comparison.tightened.includes("confirm.approvers.keys"));
  });

  it("HTTP: a second project key cannot drop the approver list before the delay ends", async () => {
    const owner = await issue("owner (the only approver)");
    const leaked = await issue("backend (leaked)", owner.key);
    // Project rule book: everything above $1 needs approval by the owner key only; loosening waits 24 h.
    const v1 = await call<{ applied: string }>(server, "PUT", "/projects/current/policy", {
      key: owner.key,
      body: { schema: "kletia.policy/v1", confirm: { aboveUsd: "1", approvers: { keys: [owner.id] } }, amendments: { delaySeconds: 86_400 } },
    });
    assert.equal(v1.status, 200, JSON.stringify(v1.body));

    // Control: ADDING the leaked key to the approver list is a loosening and waits 24 h.
    const add = await call<{ applied: string; loosened: string[] }>(server, "PUT", "/projects/current/policy", {
      key: leaked.key,
      body: { schema: "kletia.policy/v1", confirm: { aboveUsd: "1", approvers: { keys: [owner.id, leaked.id] } }, amendments: { delaySeconds: 86_400 } },
    });
    assert.equal(add.body.applied, "pending");

    // Bug: REMOVING the list (which lets every project key approve) applies now.
    const drop = await call<{ applied: string; tightened: string[]; loosened: string[] }>(server, "PUT", "/projects/current/policy", {
      key: leaked.key,
      body: { schema: "kletia.policy/v1", confirm: { aboveUsd: "1" }, amendments: { delaySeconds: 86_400 } },
    });
    assert.equal(drop.status, 200);
    assert.equal(drop.body.applied, "pending", "dropping the list waits out the 24 h delay");
    assert.ok(drop.body.loosened.includes("confirm.approvers.keys"));

    // The leaked key's held intent cannot be approved by a key it mints itself.
    const created = await call<{ intent: IntentGraph }>(server, "POST", "/intents", { key: leaked.key, body: { text: "bridge 100 USDC from base to arbitrum", accounts: ACCOUNTS } });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const approvalId = created.body.intent.policy?.approval?.id;
    assert.ok(approvalId, "held for approval");
    const minted = await issue("minted by leaked key", leaked.key);
    const approved = await call(server, "POST", `/policy/approvals/${approvalId}/approve`, { key: minted.key });
    assert.notEqual(approved.status, 200, JSON.stringify(approved.body));
    const prepared = await call(server, "POST", `/intents/${created.body.intent.id}/steps/s1/prepare`, {});
    assert.notEqual(prepared.status, 200);
  });
});
