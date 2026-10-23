/**
 * Wrap venue: the gas asset to its canonical wrapped token and back, 1:1, on
 * the pinned wrapped-native contract (WETH9, WPOL), one transaction with no
 * approval and no slippage, never auctioned; verify holds the Deposit /
 * Withdrawal event to the account and amount.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { decodeFunctionData, getAddress, type Abi, type Hex } from "viem";
import { getProtocol, nativeAssetId, venueContracts, type EvmTransactionRequest, type NetworkKey } from "@kletia/core";
import { WETH_ABI } from "../adapters/lending/common.js";
import type { AdapterAction, AdapterRoute, ProtocolAdapter } from "../adapters/types.js";
import { wrapAdapter, wrapDirection, wrappedNativeOf } from "../adapters/wrap.js";
import { resolveAsset } from "../assets.js";
import { runVenueAuction } from "../auction.js";
import { configurePlatform, createIntent, getIntent, prepareStep, submitStep } from "../service.js";
import { MemoryIntentStore } from "../store.js";
import { EVM_ACCOUNT, resetRouting, STUB_ADAPTERS } from "./helpers.js";
import { ACCOUNT, eventLog, installLendingChain, landPrepared, type LendingChain } from "./lendingChain.js";

let chain: LendingChain;

beforeEach(() => {
  chain = installLendingChain();
  resetRouting();
  configurePlatform({ store: new MemoryIntentStore(), adapters: [...STUB_ADAPTERS, wrapAdapter] });
});

afterEach(() => {
  chain.restore();
});

async function route(network: NetworkKey, from: string, to: string, destination: NetworkKey = network): Promise<AdapterRoute> {
  return { kind: "swap", network, destinationNetwork: destination, input: await resolveAsset(network, from), output: await resolveAsset(destination, to) };
}

async function action(network: NetworkKey, from: string, to: string, amount: string): Promise<AdapterAction> {
  const base = await route(network, from, to);
  const id = `eip155:${network === "polygon" ? 137 : network === "base" ? 8453 : network === "ethereum" ? 1 : network === "arbitrum" ? 42161 : 10}:${ACCOUNT}`;
  const { parseAccountId } = await import("@kletia/core");
  const account = parseAccountId(id);
  assert.ok(account);
  return { ...base, amount, account, recipient: account, slippageBps: 50 };
}

describe("wrap venue: what it serves", () => {
  it("serves the gas asset and its pinned wrapped token, both ways, on every EVM production network", async () => {
    for (const network of ["base", "ethereum", "arbitrum", "optimism"] as const) {
      assert.equal(wrapDirection(await route(network, "ETH", "WETH")), "wrap", network);
      assert.equal(wrapDirection(await route(network, "WETH", "ETH")), "unwrap", network);
      assert.equal(wrappedNativeOf(network)?.toLowerCase(), venueContracts("wrap", network, "wrapped-native")[0]?.toLowerCase());
    }
    assert.equal(wrapDirection(await route("polygon", "POL", "WPOL")), "wrap");
    assert.equal(wrapDirection(await route("polygon", "WPOL", "POL")), "unwrap");
    assert.equal(wrapAdapter.supports(await route("polygon", "WETH", "POL")), false, "Polygon's bridged WETH is not the wrapped gas asset");
    assert.equal(wrapAdapter.supports(await route("base", "USDC", "WETH")), false);
    assert.equal(wrapAdapter.supports(await route("base", "ETH", "WETH", "arbitrum")), false, "never across networks");
    assert.equal(wrapAdapter.supports({ ...(await route("base", "ETH", "WETH")), kind: "bridge" }), false);
    assert.equal(wrapAdapter.supports(await route("solana", "SOL", "USDC")), false);
    assert.equal(getProtocol("wrap")?.tier, "core");
  });

  it("plans 1:1 with an on-chain floor, one transaction and no slippage", async () => {
    const planned = await wrapAdapter.plan(await action("base", "ETH", "WETH", "1500000000000000000"));
    assert.equal(planned.protocol, "wrap");
    assert.equal(planned.input.amount, "1500000000000000000");
    assert.equal(planned.expectedOutput.amount, "1500000000000000000");
    assert.equal(planned.minimumOutput.amount, "1500000000000000000");
    assert.equal(planned.floor, "onchain");
    assert.equal(planned.slippageBps, 0);
    assert.equal(planned.transactionCount, 1);
    const transaction = planned.preview?.transactions[0] as EvmTransactionRequest;
    assert.equal(getAddress(transaction.to), getAddress(wrappedNativeOf("base") as string));
    assert.equal(transaction.value, "1500000000000000000");
    assert.equal(decodeFunctionData({ abi: WETH_ABI, data: transaction.data as Hex }).functionName, "deposit");
    const unwrap = await wrapAdapter.plan(await action("polygon", "WPOL", "POL", "7000000000000000000"));
    const call = unwrap.preview?.transactions[0] as EvmTransactionRequest;
    assert.equal(getAddress(call.to), getAddress(wrappedNativeOf("polygon") as string));
    assert.equal(call.value, "0");
    assert.deepEqual(decodeFunctionData({ abi: WETH_ABI, data: call.data as Hex }).args, [7_000_000_000_000_000_000n]);
  });

  it("pays the acting account only", async () => {
    const other = await action("base", "ETH", "WETH", "1");
    const { parseAccountId } = await import("@kletia/core");
    const recipient = parseAccountId("eip155:8453:0x1111111111111111111111111111111111111111");
    assert.ok(recipient);
    await assert.rejects(wrapAdapter.plan({ ...other, recipient }), /pays the acting account/u);
  });
});

describe("wrap venue: never auctioned", () => {
  it("serves the pair alone even when another venue could quote it", async () => {
    let asked = 0;
    const rival: ProtocolAdapter = {
      ...(STUB_ADAPTERS.find((adapter) => adapter.id === "relay") as ProtocolAdapter),
      supports: () => true,
      plan: async () => {
        asked += 1;
        throw new Error("never asked");
      },
    };
    const result = await runVenueAuction([rival, wrapAdapter], await action("base", "ETH", "WETH", "1000000000000000000"), { maxSeconds: 600, explicitMaxSeconds: false, prefer: [] });
    assert.equal(result.winner.protocol, "wrap");
    assert.equal(asked, 0, "the swap auction short-circuits to the wrap venue");
    assert.deepEqual(result.losers, []);
  });

  it("plans a swap of ETH to WETH as a wrap through the planner", async () => {
    const graph = await createIntent({ actions: [{ kind: "swap", network: "base", from: "ETH", to: "WETH", amount: "0.5" }], accounts: [EVM_ACCOUNT] });
    assert.equal(graph.steps[0]?.protocol, "wrap");
    assert.equal(graph.steps[0]?.minimumOutput?.amount, "500000000000000000");
    assert.equal(graph.interpretation.routes?.[0]?.shape, "wrap");
  });
});

describe("wrap venue: verification", () => {
  it("confirms a Deposit of exactly the amount to the account from the pinned contract, and refuses anything else", async () => {
    chain.nativeBalances.set(ACCOUNT.toLowerCase(), 10n ** 19n);
    const graph = await createIntent({ actions: [{ kind: "swap", network: "base", from: "ETH", to: "WETH", amount: "0.5" }], accounts: [EVM_ACCOUNT] });
    const { payload } = await prepareStep(graph.id, "s1");
    const transactions = payload.transactions as EvmTransactionRequest[];
    const weth = wrappedNativeOf("base") as string;
    const wrong = landPrepared(chain, transactions, [[eventLog(weth, WETH_ABI as unknown as Abi, "Deposit", { dst: ACCOUNT, wad: 1n })]]);
    const refused = await submitStep(graph.id, "s1", wrong);
    assert.equal(refused.steps[0]?.status, "failed");
    assert.equal(refused.steps[0]?.failure?.code, "OUTCOME_NOT_PROVEN");

    const second = await createIntent({ actions: [{ kind: "swap", network: "base", from: "ETH", to: "WETH", amount: "0.5" }], accounts: [EVM_ACCOUNT] });
    const prepared = (await prepareStep(second.id, "s1")).payload.transactions as EvmTransactionRequest[];
    const good = landPrepared(chain, prepared, [[eventLog(weth, WETH_ABI as unknown as Abi, "Deposit", { dst: ACCOUNT, wad: 500_000_000_000_000_000n })]]);
    await submitStep(second.id, "s1", good);
    const done = await getIntent(second.id);
    assert.equal(done.steps[0]?.status, "settled");
    assert.equal(done.steps[0]?.actualOutput?.amount, "500000000000000000");
    assert.equal(done.steps[0]?.actualOutput?.asset.toLowerCase(), `eip155:8453/erc20:${weth.toLowerCase()}`);
    assert.notEqual(done.steps[0]?.actualOutput?.asset, nativeAssetId("base"));
  });
});
