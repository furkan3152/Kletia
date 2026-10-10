// First-party signing refuses custom contracts; the hosted integrator frame
// keeps the SDK's review gate for its exact intent/session-created intent.
import assert from "node:assert/strict";
import test from "node:test";
import { CONTRACT_REVIEW_NOTICE } from "@kletia/core";
import { KletiaClient, executeIntent } from "@kletia/sdk";

import {
  assertEmbedContractExecution,
  assertFirstPartyContractExecution,
  CUSTOM_CONTRACT_EXECUTION_CODE,
  createIntegrationIntentScope,
  isCustomContractExecution,
  withContractPreparationBoundary,
} from "../../../../shared/platform/contractExecutionBoundary.ts";

const INTENT = `int_${"a".repeat(32)}`;
const OTHER_INTENT = `int_${"b".repeat(32)}`;
const EVM = "0x1111111111111111111111111111111111111111";
const TARGET = "0x2222222222222222222222222222222222222222";
const SOLANA = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const refused = (error) => error.code === CUSTOM_CONTRACT_EXECUTION_CODE;

test("core steps, structured actions and legacy custom names are all integration-only", () => {
  const markers = [
    { kind: "call" }, { kind: "action" }, { protocol: "custom-call" }, { protocol: "solana-actions" },
    { kind: "swap", call: {} }, { kind: "deposit", contract: "ct_registration" },
    { action: "custom_call" }, { actionType: "custom_action" }, { action: "contract-call" },
  ];
  for (const marker of markers) {
    assert.equal(isCustomContractExecution(marker), true, JSON.stringify(marker));
    assert.throws(() => assertFirstPartyContractExecution(marker), refused);
    assert.throws(() => assertFirstPartyContractExecution({ steps: [{ kind: "transfer" }, marker] }), refused);
    assert.throws(() => assertFirstPartyContractExecution({ request: { actions: [marker] } }), refused);
  }
  for (const kind of ["swap", "bridge", "stake", "deposit", "borrow", "approve", "read"]) {
    assert.doesNotThrow(() => assertFirstPartyContractExecution({ steps: [{ kind, protocol: "aave-v3" }] }));
  }
});

test("a custom link destination is blocked before the wallet panel is loaded", () => {
  assert.equal(isCustomContractExecution({ actions: [{ kind: "call", contract: { id: "ct_registration" } }] }), true);
  assert.equal(isCustomContractExecution({ actions: [{ kind: "action" }] }), true);
  assert.equal(isCustomContractExecution({ actions: [{ kind: "transfer" }] }), false);
});

test("metadata, another intent id and malformed ids do not grant the embed exception", () => {
  const graph = { id: INTENT, steps: [{ kind: "call" }], metadata: { surface: "embed", integration: "trusted" } };
  for (const id of [null, OTHER_INTENT, "int_bad"]) assert.throws(() => assertEmbedContractExecution(graph, id), refused);
  assert.doesNotThrow(() => assertEmbedContractExecution(graph, INTENT));
  assert.throws(() => assertFirstPartyContractExecution({ steps: [{ kind: "swap" }] }, {}), refused, "a fresh review cannot hide behind an ordinary step label");
});

function harness({ vm = "evm", custom = true, changeAtPrepare = false, unexpectedReview = false, beforePrepareResponse, preparedIntentId = INTENT } = {}) {
  const counts = { prepare: 0, wallet: 0, submit: 0, review: 0 };
  const evm = vm === "evm";
  const review = {
    kind: evm ? "evm-call" : "solana-action",
    integrator: { name: "Project integration", domainVerified: true },
    notices: [CONTRACT_REVIEW_NOTICE],
    ...(evm ? { contract: { address: TARGET }, call: { label: "Project call", args: [] } } : {}),
    approvals: [], simulation: { status: "ok", at: "prepare", assetChanges: [], warnings: [] },
  };
  const graph = (isCustom = custom, status = "ready") => ({
    spec: "kletia.intent/v1", id: INTENT, status: status === "settled" ? "completed" : "planned",
    steps: [{
      id: "step1", index: 0, kind: isCustom ? (evm ? "call" : "action") : "transfer",
      title: "One reviewed step", network: evm ? "base" : "solana", mode: "wallet", status,
      account: evm ? `eip155:8453:${EVM}` : `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${SOLANA}`,
      protocol: isCustom ? (evm ? "custom-call" : "solana-actions") : (evm ? "evm-native" : "solana-native"),
      ...(isCustom ? { call: { vm, target: TARGET, selector: "0x12345678", integrator: { name: "Project integration" } } } : {}),
      dependsOn: [], evidence: [],
    }],
  });
  const preparedCustom = custom || changeAtPrepare;
  const client = new KletiaClient({
    baseUrl: "http://localhost:3001",
    fetch: async (url) => {
      let body;
      if (url.endsWith("/prepare")) {
        counts.prepare += 1;
        await beforePrepareResponse?.();
        body = {
          intent: { ...graph(preparedCustom, "awaiting_signature"), id: preparedIntentId },
          payload: {
            vm, expiresAt: Math.floor(Date.now() / 1000) + 60, quoteBinding: "binding",
            transactions: [evm
              ? { vm, network: "base", chainId: 8453, from: EVM, to: TARGET, data: preparedCustom ? "0x12345678" : "0x", value: "0" }
              : { vm, network: "solana", feePayer: SOLANA, transaction: "AQID", encoding: "base64" }],
            ...(preparedCustom || unexpectedReview ? { review } : {}),
          },
        };
      } else if (url.endsWith("/submit")) {
        counts.submit += 1;
        body = { intent: graph(preparedCustom, "settled") };
      } else throw new Error(`Unexpected request: ${url}`);
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    },
  });
  const signers = {
    evm: { address: EVM, sendTransaction: async () => { counts.wallet += 1; return `0x${"c".repeat(64)}`; }, waitForTransaction: async () => {} },
    solana: { address: SOLANA, signAndSendTransaction: async () => { counts.wallet += 1; return "5".repeat(88); } },
  };
  const options = { onReview: () => { counts.review += 1; return true; } };
  return { client, graph: graph(changeAtPrepare ? false : custom), signers, options, counts };
}

test("fresh EVM and Solana custom payloads cannot reach a first-party wallet", async () => {
  for (const vm of ["evm", "svm"]) {
    for (const changeAtPrepare of [false, true]) {
      const h = harness({ vm, custom: !changeAtPrepare, changeAtPrepare });
      await assert.rejects(executeIntent(withContractPreparationBoundary(h.client), h.graph, h.signers, h.options), refused);
      assert.deepEqual(h.counts, { prepare: 1, wallet: 0, submit: 0, review: 0 });
    }
  }
});

test("an unexpected prepared review is refused even without custom graph markers", async () => {
  const h = harness({ custom: false, unexpectedReview: true });
  await assert.rejects(executeIntent(withContractPreparationBoundary(h.client), h.graph, h.signers, h.options), refused);
  assert.equal(h.counts.wallet, 0);
});

test("ordinary hosted text planning cannot sign a custom contract", async () => {
  const h = harness();
  await assert.rejects(executeIntent(withContractPreparationBoundary(h.client, () => null), h.graph, h.signers, h.options), refused);
  assert.equal(h.counts.wallet, 0);
});

test("the exact integrator intent/session-created intent still needs review and can execute", async () => {
  for (const vm of ["evm", "svm"]) {
    const h = harness({ vm });
    const final = await executeIntent(withContractPreparationBoundary(h.client, () => INTENT), h.graph, h.signers, h.options);
    assert.equal(final.status, "completed");
    assert.deepEqual(h.counts, { prepare: 1, wallet: 1, submit: 1, review: 1 });

    const declined = harness({ vm });
    await executeIntent(withContractPreparationBoundary(declined.client, () => INTENT), declined.graph, declined.signers, { onReview: () => false });
    assert.equal(declined.counts.wallet, 0, "integration scope never replaces the user's review approval");
  }
});

test("an embed scope changed before prepare finishes cannot sign the earlier custom intent", async () => {
  for (const preparedIntentId of [INTENT, OTHER_INTENT]) {
    let started;
    const preparing = new Promise((resolve) => { started = resolve; });
    let finish;
    const h = harness({ preparedIntentId, beforePrepareResponse: () => {
      started();
      return new Promise((resolve) => { finish = resolve; });
    } });
    const scope = createIntegrationIntentScope(INTENT);
    const guarded = withContractPreparationBoundary(h.client, scope.get);
    const execution = assert.rejects(executeIntent(guarded, h.graph, h.signers, h.options), refused);
    await preparing;
    scope.set(OTHER_INTENT);
    finish();
    await execution;
    assert.equal(h.counts.wallet, 0, "a response cannot rebind the earlier request to the new integration target");
  }
});

test("built-in transactions still execute on the main site and an ordinary embed", async () => {
  for (const scope of [undefined, () => null]) {
    const h = harness({ custom: false });
    const final = await executeIntent(withContractPreparationBoundary(h.client, scope), h.graph, h.signers);
    assert.equal(final.status, "completed");
    assert.deepEqual(h.counts, { prepare: 1, wallet: 1, submit: 1, review: 0 });
  }
});
