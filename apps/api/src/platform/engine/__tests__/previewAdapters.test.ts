/**
 * Built-in adapters return their quote's own transactions from `plan`
 * (asset-change preview design §5.1, source 2), identical to what `prepare`
 * returns for the same quote, so a plan-time preview simulates exactly the
 * payload a wallet would get, with no extra provider call.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { encodeFunctionData, erc20Abi, parseAbi, type Hex } from "viem";
import { CHAINS, type IntentGraph } from "@kletia/core";
import { evmTransferAdapter } from "../adapters/evmTransfer.js";
import { lifiAdapter } from "../adapters/lifi.js";
import { relayAdapter } from "../adapters/relay.js";
import type { AdapterAction } from "../adapters/types.js";
import { account, asset, bridgeAction, installCrossChainMock, lifiQuoteBody, LIFI_DIAMOND, RELAY_DEPOSITORY, type CrossChainMock } from "./crosschainFixtures.js";
import { EVM_ADDRESS, OTHER_EVM_ADDRESS } from "./helpers.js";
import { preparedStep } from "./rpcMock.js";

const DEPOSITORY_ABI = parseAbi(["function depositErc20(address depositor, address token, uint256 amount, bytes32 id)"]);
const ORDER = `0x${"34".repeat(32)}` as Hex;

let mock: CrossChainMock;

beforeEach(() => {
  mock = installCrossChainMock();
});

afterEach(() => mock.restore());

function relayQuote(action: AdapterAction): void {
  const chainId = CHAINS[action.network].settlement.relayChainId as number;
  const calls = [
    { to: action.input.address as string, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [RELAY_DEPOSITORY as Hex, BigInt(action.amount)] }) },
    { to: RELAY_DEPOSITORY, data: encodeFunctionData({ abi: DEPOSITORY_ABI, functionName: "depositErc20", args: [EVM_ADDRESS as Hex, action.input.address as Hex, BigInt(action.amount), ORDER] }) },
  ];
  mock.rpc.relayQuote = (body) => ({
    steps: calls.map((call, index) => ({
      id: index === calls.length - 1 ? "deposit" : "approve",
      kind: "transaction",
      requestId: `0x${"12".repeat(32)}`,
      items: [{ status: "incomplete", data: { from: EVM_ADDRESS, to: call.to, data: call.data, value: "0", chainId } }],
    })),
    fees: {
      gas: { currency: { chainId, address: "0x0000000000000000000000000000000000000000", symbol: "ETH", decimals: 18 }, amount: "495113245440", amountUsd: "0.001236" },
      relayer: { currency: { chainId, address: action.input.address, symbol: "USDC", decimals: 6 }, amount: "34228", amountUsd: "0.034223" },
      app: { currency: { chainId, address: action.input.address, symbol: "USDC", decimals: 6 }, amount: "0", amountUsd: "0" },
    },
    details: {
      recipient: body.recipient,
      currencyIn: { currency: { chainId, address: body.originCurrency, decimals: 6, symbol: "USDC" }, amount: action.amount },
      currencyOut: { currency: { chainId: CHAINS[action.destinationNetwork].settlement.relayChainId, address: body.destinationCurrency, decimals: 6, symbol: "USDC" }, amount: "24974466", minimumAmount: "24849594" },
      timeEstimate: 2,
    },
  });
}

describe("plan-time preview transactions of built-in adapters", () => {
  it("Relay: the quote's approve and deposit, exactly as prepare maps them, with its relayer fee", async () => {
    const action = bridgeAction("base", "arbitrum");
    relayQuote(action);
    const planned = await relayAdapter.plan(action);
    assert.ok(planned.preview);
    const step = preparedStep({ network: "base", chain: CHAINS.base.id, account: action.account.id, status: "ready" });
    const prepared = await relayAdapter.prepare({ graph: {} as IntentGraph, step, action, now: Date.now() });
    assert.deepEqual(planned.preview.transactions, prepared.transactions);
    assert.equal(planned.preview.approvalSpender, RELAY_DEPOSITORY.toLowerCase());
    assert.deepEqual(planned.preview.venueFees, [{
      kind: "venue",
      label: "Relay relayer fee",
      asset: { asset: action.input.id, symbol: "USDC", decimals: 6 },
      amount: "34228",
      formatted: "0.034228",
      usd: 0.034223,
      paid: "deducted",
      certainty: "quoted",
    }]);
    assert.ok(planned.preview.expiresAt > Date.now() / 1000);
  });

  it("LI.FI: approval and diamond call built by the same code as prepare", async () => {
    const action = bridgeAction("base", "arbitrum");
    const transactionId = `0x${"ab".repeat(32)}`;
    // One quote body for both calls: the fixture stamps its deadlines with the current second.
    const body = lifiQuoteBody(action, { transactionId });
    mock.lifiQuote = () => structuredClone(body);
    const planned = await lifiAdapter.plan(action);
    assert.ok(planned.preview);
    const step = preparedStep({ network: "base", chain: CHAINS.base.id, account: action.account.id, status: "ready" });
    const prepared = await lifiAdapter.prepare({ graph: { request: {} } as unknown as IntentGraph, step, action: { ...action, provider: planned.provider as string }, now: Date.now() });
    assert.deepEqual(planned.preview.transactions, prepared.transactions);
    assert.equal(planned.preview.transactions.length, 2, "approve + bridge call while the allowance is short");
    assert.equal(planned.preview.approvalSpender, LIFI_DIAMOND.toLowerCase());
    assert.deepEqual(planned.preview.venueFees?.map((fee) => [fee.label, fee.usd, fee.paid]), [["LI.FI fees", 0.0625, "deducted"]]);
  });

  it("EVM transfer: the deterministic transfer call, no read needed", async () => {
    const action: AdapterAction = {
      kind: "transfer",
      network: "base",
      destinationNetwork: "base",
      input: asset("base", "USDC"),
      output: asset("base", "USDC"),
      amount: "25000000",
      account: account("base"),
      recipient: account("base", OTHER_EVM_ADDRESS),
      slippageBps: 50,
    };
    const planned = await evmTransferAdapter.plan(action);
    const prepared = await evmTransferAdapter.prepare({ graph: {} as IntentGraph, step: preparedStep({ network: "base", chain: CHAINS.base.id, account: action.account.id }), action, now: Date.now() });
    const strip = (transactions: readonly unknown[]) => transactions.map((transaction) => ({ ...(transaction as Record<string, unknown>), gas: undefined }));
    assert.deepEqual(strip(planned.preview?.transactions ?? []), strip(prepared.transactions));
  });
});
