/**
 * eth_simulateV1: the decoder on live fixtures (Base Steakhouse deposit,
 * revert without approval, Polygon native transfer), every asset-change
 * refusal rule, the endpoint policy (capability probe, fallback,
 * unavailable) and balance-slot discovery.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { encodeFunctionData, erc20Abi, getAddress, type Hex } from "viem";
import { assetChangeRows, creditsTo, EVENT_TOPICS, flowRefusal, userFlows, type FlowLog } from "../contracts/assetChanges.js";
import { balanceOverride, discoverBalanceSlot } from "../contracts/balanceSlots.js";
import { parseSimulatedBlock, readUint, revertReason, simulateEvmCalls } from "../contracts/simulateEvm.js";
import { simulationCapability, simulationEndpoints, simulationUrls } from "../contracts/simulationRpc.js";
import {
  approvalLog,
  installEvmHarness,
  OTHER_TOKEN,
  resetContractCaches,
  SIM_URLS,
  transferLog,
  USDC_BASE,
  USER,
  VAULT,
  type EvmHarness,
} from "./contractHarness.js";

const fixtures = JSON.parse(readFileSync(new URL("./contractFixtures.json", import.meta.url), "utf8")) as {
  baseSteakhouseDeposit: unknown;
  baseDepositWithoutApproval: unknown;
  polygonNativeTransfer: unknown;
};
const LIVE_USER = "0x00000000000000000000000000000000c1e7a001";
const LIVE_USDC = USDC_BASE.toLowerCase();
const LIVE_VAULT = VAULT.toLowerCase();

let harness: EvmHarness;

beforeEach(() => {
  resetContractCaches();
  harness = installEvmHarness();
});

afterEach(() => harness.restore());

describe("simulateV1 decoding (live fixtures, Base 2026-10-09)", () => {
  it("decodes the approve + deposit block and proves the user's asset changes", async () => {
    const block = parseSimulatedBlock(fixtures.baseSteakhouseDeposit, 7);
    assert.ok(block);
    assert.deepEqual(block.calls.map((call) => call.status), Array(7).fill("success"));
    assert.equal(readUint(block.calls[0]), 100_000_000n);
    assert.equal(readUint(block.calls[4]), 0n);
    assert.equal(readUint(block.calls[6]), 0n, "allowance after the deposit is 0");
    const shares = readUint(block.calls[5]);
    assert.ok(shares !== null && shares > 90_000_000_000_000_000_000n && shares < 91_000_000_000_000_000_000n, `shares ${shares}`);
    const logs: FlowLog[] = [...block.calls[2]!.logs, ...block.calls[3]!.logs];
    const flows = userFlows(logs, LIVE_USER);
    assert.equal(flows.debits.get(LIVE_USDC), 100_000_000n);
    assert.equal(flows.credits.get(LIVE_VAULT), shares);
    assert.equal(creditsTo(logs, LIVE_VAULT, LIVE_USER), shares);
    assert.equal(flowRefusal(flows, {
      input: { token: LIVE_USDC, amount: 100_000_000n },
      value: 0n,
      approval: { token: LIVE_USDC, spender: LIVE_VAULT, amount: 100_000_000n },
      traced: true,
    }), null);
    assert.ok(block.calls[3]!.gasUsed > 300_000n);
    const rows = await assetChangeRows("base", flows, true);
    assert.deepEqual(rows.map((row) => [row.symbol, row.delta, row.listed]), [["USDC", "-100000000", true], ["steakUSDC", String(shares), false]]);
    assert.equal(rows[0]?.formatted, "-100");
    assert.match(rows[1]?.formatted ?? "", /^\+90\.\d+$/u);
  });

  it("surfaces the revert reason of a deposit without approval", () => {
    const block = parseSimulatedBlock(fixtures.baseDepositWithoutApproval, 1);
    assert.equal(block?.calls[0]?.status, "reverted");
    assert.equal(block?.calls[0]?.error, "execution reverted: ERC20: transfer amount exceeds allowance");
    assert.equal(revertReason({ message: "execution reverted", data: "0x4e487b710000000000000000000000000000000000000000000000000000000000000011" }), "execution reverted: panic 0x11");
  });

  it("ignores Polygon's 0x…1010 system log and counts the traced native transfer", () => {
    const block = parseSimulatedBlock(fixtures.polygonNativeTransfer, 1);
    assert.ok(block);
    const addresses = block.calls[0]!.logs.map((log) => log.address);
    assert.ok(addresses.includes("0x0000000000000000000000000000000000001010"));
    const flows = userFlows(block.calls[0]!.logs, LIVE_USER);
    assert.equal(flows.nativeOut, 10_000_000_000_000_000n);
    assert.equal(flows.debits.size, 0, "the POL system log is not an ERC-20 debit");
    assert.equal(flowRefusal(flows, { input: { token: null, amount: 10_000_000_000_000_000n }, value: 10_000_000_000_000_000n, approval: null, traced: true }), null);
    assert.match(flowRefusal(flows, { input: null, value: 0n, approval: null, traced: true }) ?? "", /native value/u);
  });

  it("rejects malformed blocks (treated as an RPC failure)", () => {
    assert.equal(parseSimulatedBlock([{ number: "0x1", calls: [{ status: "0x2", logs: [] }] }], 1), null);
    assert.equal(parseSimulatedBlock([{ number: "0x1", calls: [] }], 1), null);
    assert.equal(parseSimulatedBlock({}, 1), null);
  });
});

describe("asset-change refusal rules", () => {
  const rules = {
    input: { token: USDC_BASE.toLowerCase(), amount: 100n },
    value: 0n,
    approval: { token: USDC_BASE, spender: VAULT, amount: 100n },
    traced: true,
  };
  const honest: FlowLog[] = [approvalLog(USDC_BASE, USER, VAULT, 100n), transferLog(USDC_BASE, USER, VAULT, 100n), transferLog(VAULT, "0x0000000000000000000000000000000000000000", USER, 90n)];

  it("accepts the exact input debit, the exact approval and its decrement", () => {
    assert.equal(flowRefusal(userFlows(honest, USER), rules), null);
    assert.equal(flowRefusal(userFlows([...honest, approvalLog(USDC_BASE, USER, VAULT, 0n)], USER), rules), null);
  });

  it("refuses a larger or smaller input debit", () => {
    assert.match(flowRefusal(userFlows([transferLog(USDC_BASE, USER, VAULT, 101n)], USER), rules) ?? "", /not exactly the step amount/u);
    assert.match(flowRefusal(userFlows([transferLog(USDC_BASE, USER, VAULT, 99n)], USER), rules) ?? "", /not exactly the step amount/u);
  });

  it("refuses a debit of another token, an NFT or multi-token move", () => {
    assert.match(flowRefusal(userFlows([...honest, transferLog(OTHER_TOKEN, USER, VAULT, 1n)], USER), rules) ?? "", /another token/u);
    const nft = { ...transferLog(OTHER_TOKEN, USER, VAULT, 0n), topics: [...transferLog(OTHER_TOKEN, USER, VAULT, 0n).topics, `0x${"0".repeat(63)}7`], data: "0x" };
    assert.match(flowRefusal(userFlows([...honest, nft], USER), rules) ?? "", /NFT/u);
    const single = { address: OTHER_TOKEN, topics: [EVENT_TOPICS.transferSingle, `0x${"0".repeat(64)}`, `0x${USER.slice(2).toLowerCase().padStart(64, "0")}`, `0x${"0".repeat(64)}`], data: `0x${"0".repeat(128)}` };
    assert.match(flowRefusal(userFlows([...honest, single], USER), rules) ?? "", /NFT or multi-token/u);
  });

  it("refuses approvals beyond the prepared exact one and operator approvals", () => {
    assert.match(flowRefusal(userFlows([...honest, approvalLog(USDC_BASE, USER, OTHER_TOKEN, 1n)], USER), rules) ?? "", /beyond the prepared exact approval/u);
    assert.match(flowRefusal(userFlows([...honest, approvalLog(USDC_BASE, USER, VAULT, 2n ** 255n)], USER), rules) ?? "", /beyond/u);
    assert.match(flowRefusal(userFlows([...honest, approvalLog(OTHER_TOKEN, USER, VAULT, 1n)], USER), rules) ?? "", /beyond/u);
    const forAll = { address: OTHER_TOKEN, topics: [EVENT_TOPICS.approvalForAll, `0x${USER.slice(2).toLowerCase().padStart(64, "0")}`, `0x${VAULT.slice(2).toLowerCase().padStart(64, "0")}`], data: `0x${"0".repeat(63)}1` };
    assert.match(flowRefusal(userFlows([...honest, forAll], USER), rules) ?? "", /operator approval/u);
  });

  it("refuses native value sent beyond the declared value", () => {
    const native = { ...transferLog("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", USER, VAULT, 5n), address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" };
    assert.match(flowRefusal(userFlows([...honest, native], USER), rules) ?? "", /native value/u);
    assert.equal(flowRefusal(userFlows([...honest, native], USER), { ...rules, traced: false }), null, "receipts carry no traced transfers (value is bound by the payload)");
  });
});

describe("simulation endpoints", () => {
  const calls = [{ from: USER, to: USDC_BASE, data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [getAddress(USER)] }) }];

  it("reads per-network URL lists from the environment", () => {
    assert.deepEqual(simulationUrls("base"), SIM_URLS);
    process.env.KLETIA_SIMULATION_RPC_URLS_ARBITRUM_SEPOLIA = "https://sim-c.test, ftp://bad.test ,https://sim-c.test";
    assert.deepEqual(simulationUrls("arbitrum-sepolia"), ["https://sim-c.test"]);
  });

  it("probes each URL once (cached) and only uses capable ones", async () => {
    harness.world.simulateErrors.add(SIM_URLS[0] as string);
    assert.deepEqual(await simulationEndpoints("base"), [SIM_URLS[1]]);
    const probes = harness.world.simulateCount;
    await simulationEndpoints("base");
    assert.equal(harness.world.simulateCount, probes, "probe results are cached");
    const result = await simulateEvmCalls("base", { calls });
    assert.equal(result.status, "ok");
    assert.equal(result.status === "ok" ? result.endpoint : "", SIM_URLS[1]);
  });

  it("falls back to the next endpoint when one fails a real request, and reports unavailable when none can", async () => {
    await simulationEndpoints("base");
    harness.world.simulateErrors.add(SIM_URLS[0] as string);
    const first = await simulateEvmCalls("base", { calls });
    assert.equal(first.status === "ok" ? first.endpoint : first.status, SIM_URLS[1]);
    harness.world.simulateErrors.add(SIM_URLS[1] as string);
    const none = await simulateEvmCalls("base", { calls });
    assert.equal(none.status, "unavailable");
  });

  it("reports health per network", async () => {
    harness.world.simulateErrors.add(SIM_URLS[0] as string);
    harness.world.simulateErrors.add(SIM_URLS[1] as string);
    harness.router.handlers.set("simulateTransaction", () => ({ context: { slot: 1 }, value: { err: "AccountNotFound", logs: [] } }));
    const capability = await simulationCapability();
    assert.equal(capability.base, "unavailable");
    assert.equal(capability.solana, "ok");
  });
});

describe("balance-slot discovery", () => {
  it("finds USDC's slot 9 (Solidity layout) and builds the override", async () => {
    assert.deepEqual(await discoverBalanceSlot("base", USDC_BASE, USER), { kind: "mapping", slot: 9n, layout: "solidity" });
    const override = await balanceOverride("base", USDC_BASE, USER, 123n);
    assert.ok(override);
    const simulated = await simulateEvmCalls("base", {
      calls: [{ from: USER, to: USDC_BASE, data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [getAddress(USER)] }) as Hex }],
      overrides: override,
    });
    assert.equal(simulated.status === "ok" ? readUint(simulated.calls[0]) : null, 123n);
  });

  it("finds slot 0 and Vyper-ordered mappings, and caches a miss", async () => {
    assert.deepEqual(await discoverBalanceSlot("base", OTHER_TOKEN, USER), { kind: "mapping", slot: 0n, layout: "solidity" });
    const vyper = "0x3434343434343434343434343434343434343434";
    harness.world.tokens.set(vyper, { symbol: "VY", decimals: 18, slot: 3, layout: "vyper" });
    assert.deepEqual(await discoverBalanceSlot("base", vyper, USER), { kind: "mapping", slot: 3n, layout: "vyper" });
    // A rebasing token (balance = stored shares x index) never reads a marker back: no override.
    const odd = "0x5656565656565656565656565656565656565656";
    harness.world.tokens.set(odd, { symbol: "ODD", decimals: 18, slot: 51, layout: "solidity", multiplier: 3n });
    assert.equal(await discoverBalanceSlot("base", odd, USER), null);
    const before = [harness.world.simulateCount, harness.world.accessListCount];
    assert.equal(await balanceOverride("base", odd, USER, 1n), null);
    assert.deepEqual([harness.world.simulateCount, harness.world.accessListCount], before, "a miss is cached");
  });
});
