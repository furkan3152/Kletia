import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { decodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { ARC_SWAP_ABI, ARC_STAKING_ABI } from "../../../networks/arc/abis.js";
import { configuredArcDefiDeployments, ARC_LEGACY_DEFI_CONTRACTS } from "../../../networks/arc/executionEnvironment.js";
import { ArcPlanError, dispatchArcAction } from "../../../networks/arc/handlers.js";
import { ARC_REVIEWED_V2_RUNTIMES } from "../../../networks/arc/reviewedRuntimePins.js";
import { ArcDefiReadinessError, assertReviewedArcDefiRuntime, type ArcIdentityReader } from "../../../networks/arc/runtimeIdentity.js";
import { boundedArcSwapCall } from "../../../networks/arc/swapBounds.js";
import { arcPublicClient, isNetworkTargetAllowed } from "../../../shared/config/networks.js";
import type { ParsedIntent } from "../../../shared/ai/parser.js";

const ACCOUNT = getAddress("0x1111111111111111111111111111111111111111");
const DEPLOYMENT = getAddress("0x2222222222222222222222222222222222222222");
const original = { call: arcPublicClient.call, estimateGas: arcPublicClient.estimateGas, readContract: arcPublicClient.readContract };
afterEach(() => Object.assign(arcPublicClient, original));
const intent = (action: string, extra: Partial<ParsedIntent> = {}): ParsedIntent => ({ isComplete: true, action, amount: "1", message: "", tokenIn: "USDC", tokenOut: "USDC", ...extra });
const reader: ArcIdentityReader = { getChainId: async () => 5042002, getBytecode: async () => "0x6000", readSwapPool: async () => DEPLOYMENT };

describe("Arc reviewed V2 readiness", () => {
  it("keeps all new-capital configurations disabled until deployment evidence is supplied", () => {
    assert.deepEqual(configuredArcDefiDeployments({}), { swap: null, staking: null, lending: null });
    for (const kind of ["swap", "staking", "lending"] as const) {
      const prefix = `ARC_${kind.toUpperCase()}_V2`;
      assert.throws(() => configuredArcDefiDeployments({ [`${prefix}_ADDRESS`]: DEPLOYMENT }), /configured together/u);
      assert.throws(() => configuredArcDefiDeployments({ [`${prefix}_ADDRESS`]: ARC_LEGACY_DEFI_CONTRACTS[kind], [`${prefix}_RUNTIME_CODEHASH`]: ARC_REVIEWED_V2_RUNTIMES[kind].runtimeCodehash }), /legacy/u);
      assert.throws(() => configuredArcDefiDeployments({ [`${prefix}_ADDRESS`]: DEPLOYMENT, [`${prefix}_RUNTIME_CODEHASH`]: `0x${"11".repeat(32)}` }), /compiled reviewed/u);
      const valid = configuredArcDefiDeployments({ [`${prefix}_ADDRESS`]: DEPLOYMENT, [`${prefix}_RUNTIME_CODEHASH`]: ARC_REVIEWED_V2_RUNTIMES[kind].runtimeCodehash });
      assert.equal(valid[kind]?.address, DEPLOYMENT);
    }
  });

  it("refuses unavailable deployments, wrong-chain reads, absent code and arbitrary bytecode", async () => {
    const empty = configuredArcDefiDeployments({});
    await assert.rejects(assertReviewedArcDefiRuntime("swap", empty, reader), (e: unknown) => e instanceof ArcDefiReadinessError && e.code === "ARC_DEFI_V2_NOT_CONFIGURED");
    const configured = configuredArcDefiDeployments({ ARC_SWAP_V2_ADDRESS: DEPLOYMENT, ARC_SWAP_V2_RUNTIME_CODEHASH: ARC_REVIEWED_V2_RUNTIMES.swap.runtimeCodehash });
    await assert.rejects(assertReviewedArcDefiRuntime("swap", configured, { ...reader, getChainId: async () => 1 }), (e: unknown) => e instanceof ArcDefiReadinessError && e.code === "ARC_DEFI_V2_CHAIN_MISMATCH");
    for (const code of [undefined, "0x", "0x6000"] as const) {
      await assert.rejects(assertReviewedArcDefiRuntime("swap", configured, { ...reader, getBytecode: async () => code }), (e: unknown) => e instanceof ArcDefiReadinessError && e.code === "ARC_DEFI_V2_RUNTIME_MISMATCH");
    }
  });

  it("refuses legacy new exposure before any RPC, approval or wallet payload", async () => {
    let rpcCalls = 0;
    Object.assign(arcPublicClient, { call: async () => { rpcCalls += 1; throw new Error("must not call RPC"); }, readContract: async () => { rpcCalls += 1; throw new Error("must not read RPC"); } });
    for (const action of ["swap", "stake", "add_liquidity", "lending_deposit", "lending_borrow"]) {
      await assert.rejects(dispatchArcAction(intent(action), ACCOUNT), (e: unknown) => e instanceof ArcPlanError && e.code === "ARC_DEFI_V2_NOT_CONFIGURED" && e.statusCode === 503);
      await assert.rejects(dispatchArcAction(intent(action, { protocol: "kletia legacy" }), ACCOUNT), (e: unknown) => e instanceof ArcPlanError && e.code === "ARC_LEGACY_WITHDRAWAL_ONLY");
    }
    assert.equal(rpcCalls, 0);
    assert.equal(isNetworkTargetAllowed("arc", ARC_LEGACY_DEFI_CONTRACTS.swap, "swap"), false);
    assert.equal(isNetworkTargetAllowed("arc", ARC_LEGACY_DEFI_CONTRACTS.staking, "stake"), false);
    assert.equal(isNetworkTargetAllowed("arc", ARC_LEGACY_DEFI_CONTRACTS.lending, "lending_borrow"), false);
  });

  it("preserves explicit legacy unstake and debt repayment routes to the historical targets", async () => {
    const calls: { to: Address; data: Hex }[] = [];
    Object.assign(arcPublicClient, { call: async (request: { to: Address; data: Hex }) => { calls.push(request); return { data: "0x" }; }, estimateGas: async () => 100_000n });
    const unstake = await dispatchArcAction(intent("unstake", { protocol: "kletia legacy", amount: "2" }), ACCOUNT);
    assert.equal(unstake.targetContract, ARC_LEGACY_DEFI_CONTRACTS.staking);
    assert.deepEqual(decodeFunctionData({ abi: ARC_STAKING_ABI, data: unstake.calldata }).args, [2n * 10n ** 18n]);
    assert.equal(unstake.simulation?.status, "simulated");
    const repay = await dispatchArcAction(intent("lending_repay", { protocol: "kletia legacy", amount: "3" }), ACCOUNT);
    assert.equal(repay.targetContract, ARC_LEGACY_DEFI_CONTRACTS.lending);
    assert.equal(repay.value, (3n * 10n ** 18n).toString());
    assert.equal(calls.length, 2);
  });
});

describe("Arc Swap V2 bound calldata", () => {
  it("encodes the stricter user floor and expiry in both native and token swap directions", () => {
    const native = boundedArcSwapCall({ amount: 1_000n, output: 10_000n, usdcToKlet: true, slippage: "1.25", userMinimum: 9_990n, now: 1_700_000_000_000 });
    assert.deepEqual(decodeFunctionData({ abi: ARC_SWAP_ABI, data: native.calldata }).args, [9_990n, 1_700_000_300n]);
    const token = boundedArcSwapCall({ amount: 1_000n, output: 10_000n, usdcToKlet: false, slippage: "1.25", now: 1_700_000_000_000 });
    assert.deepEqual(decodeFunctionData({ abi: ARC_SWAP_ABI, data: token.calldata }).args, [1_000n, 9_875n, 1_700_000_300n]);
  });

  it("rejects impossible or zero output floors and invalid slippage", () => {
    for (const slippage of ["NaN", "-1", "100", "1.001", "1%"])
      assert.throws(() => boundedArcSwapCall({ amount: 1n, output: 100n, usdcToKlet: true, slippage }), /slippage/u);
    for (const output of [0n, 1n]) assert.throws(() => boundedArcSwapCall({ amount: 1n, output, usdcToKlet: true }), /positive user minimum/u);
    assert.throws(() => boundedArcSwapCall({ amount: 1n, output: 100n, userMinimum: 101n, usdcToKlet: true }), /positive user minimum/u);
  });
});
