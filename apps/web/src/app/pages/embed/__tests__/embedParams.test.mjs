import assert from "node:assert/strict";
import test from "node:test";
import { CHAINS } from "@kletia/core";

import { embedWalletVms, readEmbedParams, readEmbedScope } from "../embedParams.ts";

test("the frame parser ignores unknown parameters", () => {
  const params = readEmbedParams("?theme=dark&clarify=off&key=kl_dev_secret&foo=bar");
  assert.deepEqual(params, { theme: "dark", text: "", examples: null, transparent: false });
  assert.deepEqual(readEmbedScope("?clarify=off&chain=base", CHAINS), { networks: null, actions: null, source: null });
});

test("networks are registry keys of one capital lane", () => {
  assert.deepEqual(readEmbedScope("?networks=base,Solana,mars,base", CHAINS).networks, ["base", "solana"]);
  // The first valid key sets the lane: testnet networks never join a mainnet scope, and the other way round.
  assert.deepEqual(readEmbedScope("?networks=base,arbitrum-sepolia,solana-devnet,ethereum", CHAINS).networks, ["base", "ethereum"]);
  assert.deepEqual(readEmbedScope("?networks=arbitrum-sepolia,base,solana-devnet", CHAINS).networks, ["arbitrum-sepolia", "solana-devnet"]);
  assert.equal(readEmbedScope("?networks=__proto__,constructor", CHAINS).networks, null);
});

test("actions keep the six known kinds", () => {
  assert.deepEqual(readEmbedScope("?actions=swap,borrow,call,stake,swap", CHAINS).actions, ["swap", "stake"]);
  assert.equal(readEmbedScope("?actions=borrow", CHAINS).actions, null);
});

test("source accepts auto and stays inside networks", () => {
  assert.equal(readEmbedScope("?source=auto&networks=base", CHAINS).source, "auto");
  assert.equal(readEmbedScope("?source=solana&networks=base,solana", CHAINS).source, "solana");
  assert.equal(readEmbedScope("?source=ethereum&networks=base,solana", CHAINS).source, null);
  assert.equal(readEmbedScope("?source=ethereum", CHAINS).source, "ethereum");
  assert.equal(readEmbedScope("?source=mars", CHAINS).source, null);
  // A source of the other lane is dropped with the networks it does not belong to.
  assert.equal(readEmbedScope("?source=solana-devnet&networks=base", CHAINS).source, null);
});

test("the wallet bar offers only the VMs the frame needs", () => {
  assert.deepEqual([...embedWalletVms({ session: ["arbitrum-sepolia"] }, CHAINS)], ["evm"]);
  assert.deepEqual([...embedWalletVms({ networks: ["solana"] }, CHAINS)], ["svm"]);
  assert.deepEqual([...embedWalletVms({ intent: ["base", "solana"] }, CHAINS)].sort(), ["evm", "svm"]);
  // Text mode without networks keeps both.
  assert.deepEqual([...embedWalletVms({}, CHAINS)].sort(), ["evm", "svm"]);
  assert.deepEqual([...embedWalletVms({ networks: ["mars"] }, CHAINS)].sort(), ["evm", "svm"]);
});
