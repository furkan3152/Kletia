/**
 * Admin operations: deployment verification, Solana-session actors, Safe
 * proposals, fee scans, Render calls, env readiness, export and catalog.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  ADMIN_CONTRACTS,
  ADMIN_DEPLOY_TARGETS,
  ADMIN_PINNED_DEPLOYMENTS,
  type AdminFeeRow,
} from "@kletia/core";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  encodeAbiParameters as encodeParams,
  getAddress,
  keccak256,
  type Hex,
} from "viem";
import { targetSatisfied } from "../catalog.js";
import { getArtifact, isDeployable, type DeployableArtifact } from "../contract-artifacts/index.js";
import { feeTotals, FEE_SCAN_MAX_CHUNKS } from "../fees.js";
import { SAFE_ABI, ZERO_ADDRESS } from "../verify/chain.js";
import { maskedRuntimeHash } from "../verify/mask.js";
import { MemoryAdminStore } from "../store/memory.js";
import {
  call,
  evmWallet,
  mockClient,
  receiptNotFound,
  signInEvm,
  signInSolana,
  solanaWallet,
  startHarness,
  type Harness,
  type MockClient,
} from "./helpers.js";

let open: Harness[] = [];
async function harness(env: NodeJS.ProcessEnv): Promise<Harness> {
  const started = await startHarness({ env });
  open.push(started);
  return started;
}
afterEach(async () => {
  await Promise.all(open.map((entry) => entry.close()));
  open = [];
});

const FACTORY = getArtifact("base/KletiaLaunchFactoryV2") as DeployableArtifact;
const ROUTER = getArtifact("base/KletiaIntentRouterV2") as DeployableArtifact;
const DEPLOYED = getAddress("0x1111111111111111111111111111111111111111");
const OWNER = getAddress("0x2222222222222222222222222222222222222222");
const TREASURY = getAddress("0x3333333333333333333333333333333333333333");
const TX = `0x${"ab".repeat(32)}` as Hex;

function factoryInput(owner = OWNER, treasury = TREASURY): Hex {
  const constructor = FACTORY.abi.find((item) => item.type === "constructor");
  const encoded = encodeAbiParameters(constructor && constructor.type === "constructor" ? constructor.inputs : [], [owner, treasury]);
  return `${FACTORY.bytecode}${encoded.slice(2)}` as Hex;
}

/** A healthy launch-factory deploy on Arbitrum, sent by `from`. */
function stageFactoryDeploy(client: MockClient, from: string, overrides: { input?: Hex; to?: string | null; status?: string; runtime?: Hex; owner?: string; pendingOwner?: string } = {}): void {
  client.getTransactionReceipt = async () => ({ status: overrides.status ?? "success", blockNumber: 990n, contractAddress: DEPLOYED, logs: [] });
  client.getTransaction = async () => ({ from, to: overrides.to === undefined ? null : overrides.to, input: overrides.input ?? factoryInput() });
  client.getCode = async ({ address }: { address: string }) => (address.toLowerCase() === DEPLOYED.toLowerCase() ? overrides.runtime ?? FACTORY.deployedBytecode : "0x");
  client.reads.set("owner", () => overrides.owner ?? OWNER);
  client.reads.set("pendingOwner", () => overrides.pendingOwner ?? ZERO_ADDRESS);
  client.reads.set("treasury", () => TREASURY);
  client.reads.set("deploymentFee", () => 0n);
}

function arbitrumClient(h: Harness): MockClient {
  const client = mockClient(42161);
  h.clients.set("arbitrum", client);
  return client;
}

const recordBody = (extra: Record<string, unknown> = {}) => ({
  targetId: "arbitrum:launch-factory-v2", txHash: TX, constructorArgs: { initialOwner: OWNER, initialTreasury: TREASURY }, ...extra,
});

describe("catalog and artifacts", () => {
  it("serves the shared catalog and artifacts by id", async () => {
    const account = evmWallet();
    const h = await harness({ KLETIA_ADMIN_ADDRESSES: account.address });
    const { cookie } = await signInEvm(h, account);
    const catalog = await call(h, "GET", "/catalog", { cookie });
    assert.equal(catalog.status, 200);
    assert.equal(catalog.body.schemaVersion, "kletia_admin_v1");
    assert.equal(catalog.body.targets.length, ADMIN_DEPLOY_TARGETS.length);
    const artifact = await call(h, "GET", "/artifacts/base/KletiaLaunchFactoryV2", { cookie });
    assert.equal(artifact.status, 200);
    assert.equal(artifact.body.artifact.maskedRuntimeHash, FACTORY.maskedRuntimeHash);
    assert.equal((await call(h, "GET", "/artifacts/base/Nope", { cookie })).body.error.code, "ADMIN_ARTIFACT_NOT_FOUND");
  });

  it("masks the router's immutables exactly (Hardhat-compiled fixture)", () => {
    assert.ok(isDeployable(ROUTER));
    assert.ok(ROUTER.immutableReferences.length > 0);
    const bytes = Buffer.from(ROUTER.deployedBytecode.slice(2), "hex");
    for (const { start, length } of ROUTER.immutableReferences) bytes.fill(0xab, start, start + length);
    const live = `0x${bytes.toString("hex")}` as Hex;
    assert.notEqual(keccak256(live), ROUTER.runtimeHash);
    assert.equal(maskedRuntimeHash(live, ROUTER.immutableReferences), ROUTER.maskedRuntimeHash);
    const outside = Buffer.from(bytes);
    outside[0] = outside[0] === 0x60 ? 0x61 : 0x60;
    assert.notEqual(maskedRuntimeHash(`0x${outside.toString("hex")}`, ROUTER.immutableReferences), ROUTER.maskedRuntimeHash);
  });

  it("reproduces the live launch factory runtime hash from the committed artifact", () => {
    const pinned = ADMIN_PINNED_DEPLOYMENTS.find((entry) => entry.network === "base" && entry.contractId === "launch-factory-v2");
    assert.equal(FACTORY.runtimeHash, pinned?.runtimeCodehash);
  });
});

describe("deployment verification", () => {
  it("records a verified deploy, audits it and is idempotent per tx", async () => {
    const account = evmWallet();
    const h = await harness({ KLETIA_ADMIN_ADDRESSES: account.address });
    const { cookie } = await signInEvm(h, account);
    stageFactoryDeploy(arbitrumClient(h), account.address);
    const reply = await call(h, "POST", "/deployments", { cookie, body: recordBody() });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    const record = reply.body.record;
    assert.equal(record.status, "verified", JSON.stringify(record.checks));
    assert.equal(record.address, DEPLOYED);
    assert.equal(record.ownerKind, "eoa");
    assert.equal(record.wired, false);
    assert.match(record.id, /^dep_[0-9a-f]{24}$/u);
    const ids = record.checks.map((check: { id: string }) => check.id).sort();
    assert.deepEqual(ids, ["chain", "confirmations", "constructor_args", "creation", "deployer", "init_code", "owner", "role_reads", "runtime_code", "tx_success"]);
    const again = await call(h, "POST", "/deployments", { cookie, body: recordBody() });
    assert.equal(again.status, 200);
    assert.equal(again.body.record.id, record.id);
    assert.ok((await h.store.listAudit(10, null)).some((row) => row.action === "deployment.record" && row.outcome === "ok"));

    const exported = await call(h, "GET", "/deployments/export", { cookie });
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get("content-disposition") ?? "", /^attachment; filename="kletia-deployments-2026-10-15\.json"$/u);
    assert.equal(exported.body.schemaVersion, "kletia_admin_deployments_export_v1");
    assert.equal(exported.body.networks.arbitrum[0].address, DEPLOYED);
    assert.equal(exported.body.networks.arbitrum[0].compiler.solc, "0.8.24");
  });

  it("maps chain, pending, revert and non-creation failures to errors without storing", async () => {
    const account = evmWallet();
    const h = await harness({ KLETIA_ADMIN_ADDRESSES: account.address });
    const { cookie } = await signInEvm(h, account);
    const client = arbitrumClient(h);
    stageFactoryDeploy(client, account.address);
    client.getChainId = async () => 1;
    assert.equal((await call(h, "POST", "/deployments", { cookie, body: recordBody() })).body.error.code, "ADMIN_RPC_UNAVAILABLE");
    client.getChainId = async () => 42161;
    client.getTransactionReceipt = async ({ hash }: { hash: Hex }) => { throw receiptNotFound(hash); };
    const pending = await call(h, "POST", "/deployments", { cookie, body: recordBody() });
    assert.equal(pending.status, 409);
    assert.equal(pending.body.error.code, "ADMIN_TX_PENDING");
    stageFactoryDeploy(client, account.address, { status: "reverted" });
    assert.equal((await call(h, "POST", "/deployments", { cookie, body: recordBody() })).status, 422);
    stageFactoryDeploy(client, account.address, { to: DEPLOYED });
    assert.equal((await call(h, "POST", "/deployments", { cookie, body: recordBody() })).status, 422);
    client.getBlockNumber = async () => 990n;
    stageFactoryDeploy(client, account.address);
    assert.equal((await call(h, "POST", "/deployments", { cookie, body: recordBody() })).body.error.code, "ADMIN_TX_PENDING", "needs confirmations");
    assert.equal((await h.store.listDeployments({})).length, 0);
  });

  const failingCases: [string, (client: MockClient, from: string) => void, string, Record<string, unknown>?][] = [
    ["init code mismatch", (client, from) => stageFactoryDeploy(client, from, { input: `${ROUTER.bytecode}${"00".repeat(64)}` as Hex }), "init_code"],
    ["argument mismatch", (client, from) => stageFactoryDeploy(client, from, { input: factoryInput(OWNER, OWNER) }), "constructor_args"],
    ["masked runtime mismatch", (client, from) => stageFactoryDeploy(client, from, { runtime: ROUTER.deployedBytecode }), "runtime_code"],
    ["owner mismatch", (client, from) => stageFactoryDeploy(client, from, { owner: TREASURY }), "owner"],
    ["pending owner set", (client, from) => stageFactoryDeploy(client, from, { pendingOwner: TREASURY }), "owner"],
    ["deployer is not the session wallet", (client) => stageFactoryDeploy(client, OWNER), "deployer"],
  ];
  for (const [name, stage, failedCheck] of failingCases) {
    it(`stores verification_failed on ${name}`, async () => {
      const account = evmWallet();
      const h = await harness({ KLETIA_ADMIN_ADDRESSES: account.address });
      const { cookie } = await signInEvm(h, account);
      stage(arbitrumClient(h), account.address);
      const reply = await call(h, "POST", "/deployments", { cookie, body: recordBody() });
      assert.equal(reply.status, 201);
      assert.equal(reply.body.record.status, "verification_failed");
      const failed = reply.body.record.checks.filter((check: { ok: boolean }) => !check.ok).map((check: { id: string }) => check.id);
      assert.ok(failed.includes(failedCheck), `${failedCheck} in ${failed.join(",")}`);
    });
  }

  it("accepts an imported deploy from another deployer", async () => {
    const account = evmWallet();
    const h = await harness({ KLETIA_ADMIN_ADDRESSES: account.address });
    const { cookie } = await signInEvm(h, account);
    stageFactoryDeploy(arbitrumClient(h), OWNER);
    const reply = await call(h, "POST", "/deployments", { cookie, body: recordBody({ import: true }) });
    assert.equal(reply.body.record.status, "verified");
  });

  it("does not relax the session-address (creator/owner) rule for imports", async () => {
    const account = evmWallet();
    const h = await harness({ KLETIA_ADMIN_ADDRESSES: account.address });
    const { cookie } = await signInEvm(h, account);
    const token = getArtifact("arc/KletiaToken") as DeployableArtifact;
    const constructor = token.abi.find((item) => item.type === "constructor");
    const inputs = constructor && constructor.type === "constructor" ? constructor.inputs : [];
    const client = mockClient(5042002);
    h.clients.set("arc", client);
    const stage = (creator: string) => {
      const args = { name: "Kletia", symbol: "KLET", totalSupply: "1000000000", creator, treasury: TREASURY };
      const encoded = encodeAbiParameters(inputs, [args.name, args.symbol, BigInt(args.totalSupply), creator, TREASURY]);
      client.getTransactionReceipt = async () => ({ status: "success", blockNumber: 990n, contractAddress: DEPLOYED, logs: [] });
      client.getTransaction = async () => ({ from: OWNER, to: null, input: `${token.bytecode}${encoded.slice(2)}` });
      client.getCode = async ({ address }: { address: string }) => (address.toLowerCase() === DEPLOYED.toLowerCase() ? token.deployedBytecode : "0x");
      return args;
    };
    // A stranger's KLET token (Ownable(creator) with creator = the stranger) must not become "verified".
    const stranger = await call(h, "POST", "/deployments", { cookie, body: { targetId: "arc:arc-klet-token", txHash: TX, constructorArgs: stage(OWNER), import: true } });
    assert.equal(stranger.status, 201, JSON.stringify(stranger.body));
    assert.equal(stranger.body.record.status, "verification_failed");
    const failed = stranger.body.record.checks.filter((check: { ok: boolean }) => !check.ok).map((check: { id: string }) => check.id);
    assert.deepEqual(failed, ["constructor_args"]);
    // Imported from another deployer with the admin as creator: verified.
    const otherTx = `0x${"cd".repeat(32)}` as Hex;
    client.getCode = async () => "0x";
    const admin = stage(account.address);
    client.getTransactionReceipt = async () => ({ status: "success", blockNumber: 990n, contractAddress: OWNER, logs: [] });
    client.getCode = async ({ address }: { address: string }) => (address.toLowerCase() === OWNER.toLowerCase() ? token.deployedBytecode : "0x");
    const own = await call(h, "POST", "/deployments", { cookie, body: { targetId: "arc:arc-klet-token", txHash: otherTx, constructorArgs: admin, import: true } });
    assert.equal(own.body.record.status, "verified", JSON.stringify(own.body.record.checks));
  });

  it("accepts a Solana session's deploy sent by an allowlisted EVM wallet", async () => {
    const wallet = solanaWallet();
    const evm = evmWallet();
    const h = await harness({ KLETIA_ADMIN_SOLANA_ADDRESSES: wallet.address, KLETIA_ADMIN_ADDRESSES: evm.address });
    const { cookie } = await signInSolana(h, wallet);
    stageFactoryDeploy(arbitrumClient(h), evm.address);
    const reply = await call(h, "POST", "/deployments", { cookie, body: recordBody() });
    assert.equal(reply.body.record.status, "verified");
    assert.equal(reply.body.record.createdBy, wallet.address);
  });

  it("refuses quarantined targets, conflicting addresses and unknown dependencies", async () => {
    const account = evmWallet();
    const h = await harness({ KLETIA_ADMIN_ADDRESSES: account.address });
    const { cookie } = await signInEvm(h, account);
    const quarantined = await call(h, "POST", "/deployments", { cookie, body: { targetId: "base:uniswap-v3-adapter", txHash: TX, constructorArgs: {} } });
    assert.equal(quarantined.status, 422);
    assert.equal(quarantined.body.error.code, "ADMIN_TARGET_NOT_DEPLOYABLE");
    const client = arbitrumClient(h);
    stageFactoryDeploy(client, account.address);
    assert.equal((await call(h, "POST", "/deployments", { cookie, body: recordBody() })).status, 201);
    const otherTx = `0x${"cd".repeat(32)}`;
    const conflict = await call(h, "POST", "/deployments", { cookie, body: recordBody({ txHash: otherTx }) });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, "ADMIN_RECORD_CONFLICT");
    assert.equal(await targetSatisfied(h.store, "arbitrum:uniswap-v2-adapter:uniswap"), false);
    assert.equal(await targetSatisfied(h.store, "arc:arc-forwarder"), true);
  });

  it("changes a record's status only with a confirmation", async () => {
    const account = evmWallet();
    const h = await harness({ KLETIA_ADMIN_ADDRESSES: account.address });
    const { cookie } = await signInEvm(h, account);
    stageFactoryDeploy(arbitrumClient(h), account.address);
    const { body } = await call(h, "POST", "/deployments", { cookie, body: recordBody() });
    const id = body.record.id;
    assert.equal((await call(h, "PATCH", `/deployments/${id}`, { cookie, body: { status: "archived", confirmation: { message: "x", signature: "0x" } } })).status, 403);
    const { payloadSha256 } = await import("../auth/messages.js");
    const nonce = await call(h, "POST", "/auth/nonce", { cookie, body: { address: account.address, purpose: "confirm", action: "deployment.status", network: "arbitrum", payloadSha256: payloadSha256({ id, status: "archived" }) } });
    const ok = await call(h, "PATCH", `/deployments/${id}`, { cookie, body: { status: "archived", confirmation: { message: nonce.body.message, signature: await account.signMessage({ message: nonce.body.message }) } } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.record.status, "archived");
  });
});

describe("contract state and actions", () => {
  it("reports Solana sessions as able to act through the EVM wallet, with a note", async () => {
    const wallet = solanaWallet();
    const admin = getAddress("0xff3a3cfc42d27e85dba9ea85f0bfec34bd632f9a");
    const h = await harness({ KLETIA_ADMIN_SOLANA_ADDRESSES: wallet.address, KLETIA_ADMIN_ADDRESSES: admin });
    const { cookie } = await signInSolana(h, wallet);
    const base = mockClient(8453);
    h.clients.set("base", base);
    const gateway = "0x39Eb74cB023e18c3e9C80ca46888a7Da22bFED7B";
    base.getCode = async () => "0x6000";
    base.reads.set("owner", () => admin);
    base.reads.set("usdc", () => "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    base.reads.set("pricePerCall", () => 10000n);
    base.reads.set("balanceOf", () => 5_000_000n);
    base.getCode = async ({ address }: { address: string }) => (address.toLowerCase() === admin.toLowerCase() ? "0x" : "0x6000");
    const state = await call(h, "GET", `/contracts/pinned:base:${gateway}/state`, { cookie });
    assert.equal(state.status, 200, JSON.stringify(state.body));
    assert.equal(state.body.adminCanAct, "direct");
    assert.match(state.body.adminCanActReason, /Signed in with Solana\. Connect the EVM admin wallet/u);
    assert.equal(state.body.values.pricePerCall, "10000");
    assert.ok(state.body.balances.some((amount: { symbol: string; amount: string }) => amount.symbol === "USDC" && amount.amount === "5000000"));
    assert.equal((await call(h, "GET", "/contracts/pinned:base:0x0000000000000000000000000000000000000001/state", { cookie })).status, 404, "arbitrary addresses are refused");
  });

  it("verifies a direct action from an allowlisted EVM wallet and refuses other senders", async () => {
    const wallet = solanaWallet();
    const admin = evmWallet();
    const h = await harness({ KLETIA_ADMIN_SOLANA_ADDRESSES: wallet.address, KLETIA_ADMIN_ADDRESSES: admin.address });
    const { cookie } = await signInSolana(h, wallet);
    const base = mockClient(8453);
    h.clients.set("base", base);
    const gateway = "0x39Eb74cB023e18c3e9C80ca46888a7Da22bFED7B";
    const gatewayAbi = getArtifact("base/X402Gateway")?.abi ?? [];
    const input = encodeFunctionData({ abi: gatewayAbi, functionName: "withdraw", args: [admin.address] });
    base.getTransactionReceipt = async () => ({ status: "success", blockNumber: 999n, logs: [] });
    base.getTransaction = async () => ({ from: admin.address, to: gateway, input });
    const ok = await call(h, "POST", "/actions/verify", { cookie, body: { network: "base", txHash: TX, contract: gateway, actionId: "gateway.withdraw" } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.decoded.fn, "withdraw");
    assert.equal(ok.body.decoded.args.to, admin.address);
    assert.match(ok.body.auditId, /^aud_/u);
    base.getTransaction = async () => ({ from: OWNER, to: gateway, input });
    const stranger = await call(h, "POST", "/actions/verify", { cookie, body: { network: "base", txHash: TX, contract: gateway, actionId: null } });
    assert.equal(stranger.status, 403);
    assert.equal(stranger.body.error.code, "ADMIN_EVM_WALLET_REQUIRED");
  });
});

describe("Safe proposals", () => {
  const SAFE = getAddress("0x84f19Fdfd8C50C6349BFe86Cd90BE131387ab47D");
  const ROUTER_ADDRESS = "0xf9BaA05c71c2078A43f6831Eca88220b42932413";
  const SAFE_TX_HASH = `0x${"77".repeat(32)}` as Hex;

  async function setup(threshold = 2) {
    const first = evmWallet();
    const second = evmWallet();
    const h = await harness({ KLETIA_ADMIN_ADDRESSES: first.address });
    const { cookie } = await signInEvm(h, first);
    const base = mockClient(8453);
    h.clients.set("base", base);
    let nonce = 3n;
    base.reads.set(`${SAFE.toLowerCase()}:nonce`, () => nonce);
    base.reads.set(`${SAFE.toLowerCase()}:getThreshold`, () => BigInt(threshold));
    base.reads.set(`${SAFE.toLowerCase()}:getOwners`, () => [first.address, second.address]);
    const feeData = encodeFunctionData({ abi: ROUTER.abi, functionName: "setFeeBps", args: [5] });
    base.reads.set(`${SAFE.toLowerCase()}:getTransactionHash`, (args) => {
      assert.equal(args[9], nonce);
      return args[2] === feeData ? SAFE_TX_HASH : keccak256(`${args[2] as Hex}${nonce.toString(16).padStart(2, "0")}` as Hex);
    });
    const data = encodeFunctionData({ abi: ROUTER.abi, functionName: "setFeeBps", args: [5] });
    const created = await call(h, "POST", "/safe-proposals", { cookie, body: { network: "base", safe: SAFE, to: ROUTER_ADDRESS, value: "0", data, description: "Lower the fee to 5 bps", actionId: "router.setFeeBps" } });
    return { h, cookie, base, first, second, created, setNonce: (value: bigint) => { nonce = value; } };
  }

  it("takes the hash from the chain, collects owner signatures and becomes ready", async () => {
    const { h, cookie, first, second, created } = await setup();
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const proposal = created.body.proposal;
    assert.equal(proposal.safeTxHash, SAFE_TX_HASH);
    assert.equal(proposal.nonce, "3");
    assert.deepEqual(proposal.decoded, { fn: "setFeeBps", args: { newFeeBps: "5" } });
    const stranger = evmWallet();
    const refused = await call(h, "POST", `/safe-proposals/${proposal.id}/signatures`, { cookie, body: { signature: await stranger.sign({ hash: SAFE_TX_HASH }) } });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, "ADMIN_SAFE_SIGNER_INVALID");
    const one = await call(h, "POST", `/safe-proposals/${proposal.id}/signatures`, { cookie, body: { signature: await first.sign({ hash: SAFE_TX_HASH }) } });
    assert.equal(one.body.proposal.status, "collecting");
    const duplicate = await call(h, "POST", `/safe-proposals/${proposal.id}/signatures`, { cookie, body: { signature: await first.sign({ hash: SAFE_TX_HASH }) } });
    assert.equal(duplicate.status, 409);
    const two = await call(h, "POST", `/safe-proposals/${proposal.id}/signatures`, { cookie, body: { signature: await second.sign({ hash: SAFE_TX_HASH }) } });
    assert.equal(two.body.proposal.status, "ready");
    const busy = await call(h, "POST", "/safe-proposals", { cookie, body: { network: "base", safe: SAFE, to: ROUTER_ADDRESS, value: "0", data: "0x", description: "x" } });
    assert.equal(busy.status, 409);
    assert.equal(busy.body.error.code, "ADMIN_SAFE_NONCE_BUSY");
  });

  it("requires an ExecutionSuccess log for this safeTxHash and marks stale nonces", async () => {
    const { h, cookie, base, created, setNonce } = await setup();
    const id = created.body.proposal.id;
    const successLog = (hash: Hex) => ({
      address: SAFE,
      topics: encodeEventTopics({ abi: SAFE_ABI, eventName: "ExecutionSuccess" }),
      data: encodeParams([{ type: "bytes32" }, { type: "uint256" }], [hash, 0n]),
    });
    base.getTransactionReceipt = async () => ({ status: "success", blockNumber: 999n, logs: [successLog(`0x${"11".repeat(32)}`)] });
    const wrong = await call(h, "POST", `/safe-proposals/${id}/executed`, { cookie, body: { txHash: TX } });
    assert.equal(wrong.status, 422);
    base.getTransactionReceipt = async () => ({ status: "success", blockNumber: 999n, logs: [successLog(SAFE_TX_HASH)] });
    const done = await call(h, "POST", `/safe-proposals/${id}/executed`, { cookie, body: { txHash: TX } });
    assert.equal(done.body.proposal.status, "executed");

    setNonce(3n);
    const next = await call(h, "POST", "/safe-proposals", { cookie, body: { network: "base", safe: SAFE, to: ROUTER_ADDRESS, value: "0", data: encodeFunctionData({ abi: ROUTER.abi, functionName: "pause" }), description: "Pause", actionId: "router.pause" } });
    assert.equal(next.status, 201, JSON.stringify(next.body));
    setNonce(4n);
    const list = await call(h, "GET", "/safe-proposals", { cookie });
    assert.equal(list.body.proposals.find((proposal: { id: string }) => proposal.id === next.body.proposal.id).status, "stale");
  });

  it("refuses arbitrary calls and renounceOwnership", async () => {
    const { h, cookie } = await setup();
    const renounce = encodeFunctionData({ abi: ROUTER.abi, functionName: "renounceOwnership" });
    const refused = await call(h, "POST", "/safe-proposals", { cookie, body: { network: "base", safe: SAFE, to: ROUTER_ADDRESS, value: "0", data: renounce, description: "x" } });
    assert.equal(refused.status, 400);
    const arbitrary = await call(h, "POST", "/safe-proposals", { cookie, body: { network: "base", safe: SAFE, to: OWNER, value: "0", data: "0xdeadbeef", description: "x" } });
    assert.equal(arbitrary.status, 400);
  });
});

describe("fees", () => {
  it("scans pushed fees with a persisted cursor capped per request", async () => {
    const account = evmWallet();
    const h = await harness({ KLETIA_ADMIN_ADDRESSES: account.address });
    const { cookie } = await signInEvm(h, account);
    const base = mockClient(8453);
    h.clients.set("base", base);
    const start = 49_936_328n;
    base.getBlockNumber = async () => start + 1_000_000n;
    let calls = 0;
    base.getLogs = async ({ address }: { address: string }) => {
      calls += 1;
      if (address.toLowerCase() !== "0xf9baa05c71c2078a43f6831eca88220b42932413" || calls !== 1) return [];
      return [{ args: { feeAmount: 2_000_000n, tokenOut: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" } }];
    };
    const view = await call(h, "GET", "/fees", { cookie });
    assert.equal(view.status, 200, JSON.stringify(view.body));
    const router = view.body.rows.find((row: AdminFeeRow) => row.contractId === "intent-router-v2" && row.kind === "pushed");
    assert.equal(router.scannedThroughBlock, (start - 1n + 10_000n * BigInt(FEE_SCAN_MAX_CHUNKS)).toString());
    assert.match(router.note, /Scanning, \d+ blocks left/u);
    assert.equal(router.amounts[0].symbol, "USDC");
    assert.equal(router.amounts[0].usd, 2);
    assert.equal(view.body.totals.pushedUsd, 2);
    const saved = await h.store.getFeeScan(router.scanKey);
    assert.equal(saved?.totals["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"], "2000000");
    const rescan = await call(h, "POST", "/fees/rescan", { cookie, body: { key: router.scanKey } });
    assert.equal(rescan.status, 202);
    assert.equal(rescan.body.scannedThroughBlock, (start - 1n + 10_000n * BigInt(2 * FEE_SCAN_MAX_CHUNKS)).toString());
    assert.equal((await h.store.getFeeScan(router.scanKey))?.totals["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"], "2000000", "totals carried over");
  });

  it("excludes testnets from USD totals and counts unpriced tokens", () => {
    const row = (network: AdminFeeRow["network"], testnet: boolean, kind: AdminFeeRow["kind"], usd: number | null): AdminFeeRow => ({
      network, contractId: "intent-router-v2", address: OWNER, kind, recipient: null, claim: null, scannedThroughBlock: null, scanKey: null,
      blocksLeft: null, testnet, note: null, amounts: [{ token: "native", symbol: "ETH", decimals: 18, amount: "1", usd }],
    });
    assert.deepEqual(feeTotals([row("base", false, "pushed", 5), row("arc", true, "pushed", 100), row("base", false, "accrued", 3), row("base", false, "accrued", null)]), {
      pushedUsd: 5, accruedUsd: 3, unpricedTokens: 1,
    });
  });
});

describe("services and environment", () => {
  it("never calls Render without a key and calls only the allowed URLs with one", async () => {
    const account = evmWallet();
    const h = await harness({ KLETIA_ADMIN_ADDRESSES: account.address });
    const { cookie } = await signInEvm(h, account);
    const off = await call(h, "GET", "/services", { cookie });
    assert.deepEqual(off.body, { configured: false, services: [], runningCommit: null });
    assert.equal((await call(h, "POST", "/services/api/deploy", { cookie, body: {} })).body.error.code, "ADMIN_RENDER_NOT_CONFIGURED");
    assert.equal(h.fetchCalls.length, 0);

    h.env = { RENDER_API_KEY: "rnd_sentinel_key_value" };
    h.fetchImpl = async (url) => {
      if (url.endsWith("/deploys?limit=5")) return Response.json([{ deploy: { id: "dep-1", status: "live", trigger: "api", commit: { id: "abc", message: "m" }, createdAt: "t", finishedAt: "t" }, cursor: "c" }]);
      if (url.endsWith("/deploys")) return Response.json({ id: "dep-2", status: "created", trigger: "api", createdAt: "t" }, { status: 201 });
      return Response.json({ id: "srv", name: "Kletia", suspended: "not_suspended", serviceDetails: { url: "https://api.kletiaai.xyz" } });
    };
    const on = await call(h, "GET", "/services", { cookie });
    assert.equal(on.body.services[0].name, "Kletia");
    assert.equal(on.body.services[0].suspended, false);
    assert.equal(on.body.services[0].deploys[0].commit.id, "abc");
    const deploy = await call(h, "POST", "/services/site/deploy", { cookie, body: { clearCache: true } });
    assert.equal(deploy.status, 202);
    const allowed = new Set([
      "GET https://api.render.com/v1/services/srv-d7ccgk1kh4rs73cir6c0", "GET https://api.render.com/v1/services/srv-d7ccgk1kh4rs73cir6c0/deploys?limit=5",
      "GET https://api.render.com/v1/services/srv-d7cd2mlckfvc7388hrmg", "GET https://api.render.com/v1/services/srv-d7cd2mlckfvc7388hrmg/deploys?limit=5",
      "POST https://api.render.com/v1/services/srv-d7cd2mlckfvc7388hrmg/deploys",
    ]);
    for (const entry of h.fetchCalls) assert.ok(allowed.has(`${entry.init?.method} ${entry.url}`), entry.url);
    const posted = h.fetchCalls.find((entry) => entry.init?.method === "POST");
    assert.equal(posted?.init?.body, JSON.stringify({ clearCache: "clear" }));
    assert.equal((posted?.init?.headers as Record<string, string>).Authorization, "Bearer rnd_sentinel_key_value");

    h.fetchImpl = async () => new Response("upstream echo rnd_sentinel_key_value", { status: 401 });
    const failed = await call(h, "POST", "/services/api/deploy", { cookie, body: {} });
    assert.equal(failed.status, 502);
    assert.equal(failed.body.error.details.upstreamStatus, 401);
    assert.doesNotMatch(JSON.stringify(failed.body), /sentinel/u);
    const limited = await call(h, "POST", "/services/api/deploy", { cookie, body: {} });
    assert.equal(limited.status, 429, "3 deploys per 10 minutes");
  });

  it("does not spend the global redeploy budget on unknown service names", async () => {
    const account = evmWallet();
    const h = await harness({ KLETIA_ADMIN_ADDRESSES: account.address, RENDER_API_KEY: "rnd_sentinel_key_value" });
    h.env = { RENDER_API_KEY: "rnd_sentinel_key_value" };
    const { cookie } = await signInEvm(h, account);
    for (const service of ["nope", "API", "srv-d7ccgk1kh4rs73cir6c0", "..%2Fenv-vars"]) {
      const reply = await call(h, "POST", `/services/${service}/deploy`, { cookie, body: {} });
      assert.equal(reply.status, 404, service);
    }
    assert.equal(h.fetchCalls.length, 0);
    h.fetchImpl = async () => Response.json({ id: "dep-9", status: "created", trigger: "api", createdAt: "t" }, { status: 201 });
    const deploy = await call(h, "POST", "/services/api/deploy", { cookie, body: {} });
    assert.equal(deploy.status, 202, JSON.stringify(deploy.body));
  });

  it("returns env presence as booleans only, never values", async () => {
    const account = evmWallet();
    const h = await harness({ KLETIA_ADMIN_ADDRESSES: account.address });
    h.env = { KLETIA_PLATFORM_SECRET: "sentinel-secret-value-123", RENDER_API_KEY: "sentinel-render-key", KLETIA_ADMIN_SOLANA_ADDRESSES: "x" };
    const { cookie } = await signInEvm(h, account);
    const responses = await Promise.all(["/env", "/catalog", "/overview", "/services", "/network-profiles", "/deployments", "/audit"].map((path) => call(h, "GET", path, { cookie })));
    for (const reply of responses) assert.doesNotMatch(JSON.stringify(reply.body), /sentinel/u);
    const env = responses[0]?.body;
    assert.equal(env.store, "memory");
    const secret = env.items.find((item: { name: string }) => item.name === "KLETIA_PLATFORM_SECRET");
    assert.deepEqual(secret, { name: "KLETIA_PLATFORM_SECRET", group: "Core", required: true, set: true });
    assert.ok(env.items.some((item: { name: string }) => item.name === "KLETIA_ADMIN_SOLANA_ADDRESSES"));
  });
});

describe("catalog invariants used by the API", () => {
  it("every deployable artifact referenced by a deployable target exists", () => {
    for (const target of ADMIN_DEPLOY_TARGETS.filter((entry) => entry.status === "deployable" || entry.status === "pinned")) {
      const spec = ADMIN_CONTRACTS[target.contractId];
      if (spec.lifecycle === "current" && spec.constructorInputs.length > 0) assert.ok(isDeployable(getArtifact(spec.artifactId)), target.id);
    }
    assert.ok(new MemoryAdminStore());
  });
});
