import assert from "node:assert/strict";
import test from "node:test";
import {
  describeScopeRefusal,
  KletiaScopeError,
  normalizeScope,
  outOfScope,
  scopedSourceNetwork,
  scopeVms,
} from "../dist/scope.js";

const OWNER = "0x5eed00000000000000000000000000000000c0de";
const step = (index, kind, network, extra = {}) => ({
  id: `s${index}`,
  index,
  kind,
  title: `${kind} on ${network}`,
  network,
  account: `eip155:8453:${OWNER}`,
  status: "ready",
  evidence: [],
  dependsOn: [],
  ...extra,
});

test("no scope means nothing is refused", () => {
  assert.equal(outOfScope({ steps: [step(0, "borrow", "ethereum")] }, {}), null);
  assert.equal(outOfScope({ steps: [step(0, "swap", "base")] }, { networks: [], actions: [] }), null);
});

test("a bridge destination outside the networks is counted", () => {
  const intent = { steps: [step(0, "bridge", "base", { settlement: { destinationNetwork: "ethereum" } }), step(1, "swap", "solana")] };
  const refusal = outOfScope(intent, { networks: ["base", "solana"] });
  assert.deepEqual(refusal.networks, ["ethereum"]);
  assert.equal(refusal.steps.length, 1);
  assert.equal(refusal.steps[0].stepIndex, 0);
  assert.deepEqual(refusal.steps[0].networks, ["ethereum"]);
  assert.deepEqual(describeScopeRefusal(refusal, { networks: ["base", "solana"] }), [
    "This site works with Base and Solana. This plan also uses Ethereum (step 1).",
  ]);
  assert.equal(outOfScope(intent, { networks: ["base", "solana", "ethereum"] }), null);
});

test("a recipient on another network is counted", () => {
  const intent = { steps: [step(0, "transfer", "base", { recipient: `eip155:42161:${OWNER}` })] };
  assert.deepEqual(outOfScope(intent, { networks: ["base"] }).networks, ["arbitrum"]);
});

test("actions outside the scope are listed; unstake counts as staking, borrow and calls never fit", () => {
  const intent = { steps: [step(0, "swap", "base"), step(1, "deposit", "base"), step(2, "unstake", "solana"), step(3, "call", "base")] };
  const refusal = outOfScope(intent, { actions: ["swap", "stake"] });
  assert.deepEqual(refusal.kinds, ["deposit", "call"]);
  assert.deepEqual(refusal.steps.map((item) => item.stepIndex), [1, 3]);
  assert.match(describeScopeRefusal(refusal, { actions: ["swap", "stake"] })[0], /offers swaps and staking\. This plan also needs deposits and call\./u);
  assert.equal(outOfScope({ steps: [step(0, "borrow", "base")] }, { actions: ["swap", "bridge", "transfer", "stake", "deposit", "withdraw"] }).kinds[0], "borrow");
});

test("the scope error carries a stable code and no addresses", () => {
  const refusal = outOfScope({ steps: [step(0, "swap", "ethereum", { recipient: `eip155:1:${OWNER}` })] }, { networks: ["base"] });
  const error = new KletiaScopeError(refusal);
  assert.equal(error.code, "EMBED_SCOPE_REFUSED");
  assert.ok(!error.message.includes(OWNER.slice(2, 10)));
});

test("normalizeScope keeps known networks of one lane and known actions", () => {
  assert.deepEqual(normalizeScope({ networks: ["base", "nope", "base", "solana-devnet", "solana"], actions: ["swap", "borrow", "swap"] }), {
    networks: ["base", "solana"],
    actions: ["swap"],
  });
  assert.deepEqual(normalizeScope({ networks: ["arbitrum-sepolia", "base", "solana-devnet"] }), { networks: ["arbitrum-sepolia", "solana-devnet"] });
  assert.deepEqual(normalizeScope({}), {});
});

test("the source network stays inside the scope and accepts auto", () => {
  assert.equal(scopedSourceNetwork("auto", { networks: ["base"] }), "auto");
  assert.equal(scopedSourceNetwork("base", { networks: ["base"] }), "base");
  assert.equal(scopedSourceNetwork("ethereum", { networks: ["base"] }), null);
  assert.equal(scopedSourceNetwork("ethereum", {}), "ethereum");
  assert.equal(scopedSourceNetwork("mars", {}), null);
});

test("wallet VMs follow the network scope", () => {
  assert.deepEqual([...scopeVms({ networks: ["arbitrum-sepolia"] })], ["evm"]);
  assert.deepEqual([...scopeVms({ networks: ["solana"] })], ["svm"]);
  assert.deepEqual([...scopeVms({})].sort(), ["evm", "svm"]);
});
