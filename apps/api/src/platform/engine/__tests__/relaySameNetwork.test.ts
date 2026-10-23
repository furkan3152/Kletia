/**
 * Relay same-network swaps on every EVM network Relay serves (Base,
 * Arbitrum One, Ethereum, OP Mainnet and Polygon PoS): supports,
 * pinned-contract planning with a claimed floor, and the output proof of
 * verify (Relay's minimum is its own claim, so the receipts must credit the
 * account with at least the lowest prepared floor).
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { encodeFunctionData, erc20Abi, type Hex } from "viem";
import { CHAINS, type IntentStep, type NetworkKey, type TransactionRequest } from "@kletia/core";
import { quoteBindingFor } from "../binding.js";
import { relayAdapter, RELAY_SWAP_NETWORKS } from "../adapters/relay.js";
import type { AdapterAction } from "../adapters/types.js";
import { account, asset, installCrossChainMock, landPrepared, PREPARED_AT, seconds, transferLog, type CrossChainMock } from "./crosschainFixtures.js";
import { EVM_ADDRESS } from "./helpers.js";
import { preparedStep } from "./rpcMock.js";

const APPROVAL_PROXY = "0xCcC88a9d1B4ED6b0EABA998850414b24f1c315bE";
const ROUTER = "0xb92fe925DC43a0ECdE6c8b1a2709c170Ec4fFf4f";

let mock: CrossChainMock;

/** Chain id an RPC URL serves (the shared mock answers Arbitrum's for every URL; Ethereum, OP and Polygon clients attest it). */
const chainIdFor = (url: string) => (/arbitrum/u.test(url) ? 42161 : /optimism/u.test(url) ? 10 : /polygon|matic/u.test(url) ? 137 : /ethereum|eth\./u.test(url) ? 1 : 8453);

beforeEach(() => {
  mock = installCrossChainMock();
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? init.body : "";
    if (body.includes("\"eth_chainId\"")) {
      const payload = JSON.parse(body) as { id: unknown } | { id: unknown }[];
      const answer = (request: { id: unknown }) => ({ jsonrpc: "2.0", id: request.id, result: `0x${chainIdFor(url).toString(16)}` });
      return new Response(JSON.stringify(Array.isArray(payload) ? payload.map(answer) : answer(payload)), { headers: { "content-type": "application/json" } });
    }
    return inner(input, init);
  }) as typeof fetch;
});

afterEach(() => {
  mock.restore();
});

function swapAction(network: NetworkKey, from: string, to: string, amount: string): AdapterAction {
  return {
    kind: "swap",
    network,
    destinationNetwork: network,
    input: asset(network, from),
    output: asset(network, to),
    amount,
    account: account(network),
    recipient: account(network),
    slippageBps: 50,
  };
}

/** Relay quote of a same-network swap: approve the approval proxy (token input) and call it, or call the router with value. */
function relaySwapQuote(action: AdapterAction, out: { amount: string; minimumAmount: string }) {
  const chainId = CHAINS[action.network].settlement.relayChainId as number;
  const calls = action.input.isNative
    ? [{ to: ROUTER, data: "0xcd6e13f7", value: action.amount }]
    : [
        { to: action.input.address as string, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [APPROVAL_PROXY as Hex, BigInt(action.amount)] }), value: "0" },
        { to: APPROVAL_PROXY, data: "0xf9e4bab4", value: "0" },
      ];
  mock.rpc.relayQuote = (body) => ({
    steps: calls.map((call, index) => ({
      id: index === calls.length - 1 ? "swap" : "approve",
      kind: "transaction",
      requestId: `0x${"78".repeat(32)}`,
      items: [{ status: "incomplete", data: { from: EVM_ADDRESS, to: call.to, data: call.data, value: call.value, chainId } }],
    })),
    fees: { gas: { amountUsd: "0.02" } },
    details: {
      recipient: body.recipient,
      currencyIn: { currency: { chainId, address: body.originCurrency, decimals: action.input.decimals, symbol: action.input.symbol }, amount: action.amount },
      currencyOut: { currency: { chainId, address: body.destinationCurrency, decimals: action.output.decimals, symbol: action.output.symbol }, ...out },
      timeEstimate: 1,
    },
  });
}

/** A submitted same-network Relay swap prepared with `transactions` (binding recorded) and its floor. */
function swapStep(action: AdapterAction, transactions: readonly TransactionRequest[], minimum: string, expected: string): IntentStep {
  const binding = quoteBindingFor(transactions);
  const at = new Date(PREPARED_AT).toISOString();
  const output = action.output;
  return preparedStep({
    kind: "swap",
    protocol: "relay",
    network: action.network,
    chain: CHAINS[action.network].id,
    account: action.account.id,
    input: { asset: action.input.id, symbol: action.input.symbol, decimals: action.input.decimals, amount: action.amount, formatted: "100" },
    expectedOutput: { asset: output.id, symbol: output.symbol, decimals: output.decimals, amount: expected, formatted: "x" },
    minimumOutput: { asset: output.id, symbol: output.symbol, decimals: output.decimals, amount: minimum, formatted: "x" },
    settlement: { kind: "same-network" },
    prepared: {
      quoteBinding: binding,
      preparedAt: at,
      expiresAt: seconds(PREPARED_AT) + 90,
      transactions: transactions.map((transaction) => ({ vm: "evm", network: action.network, to: transaction.vm === "evm" ? transaction.to : "", description: "tx" })),
    },
    evidence: [{ kind: "quote", network: action.network, reference: binding, observedAt: at }],
  });
}

function evmTx(action: AdapterAction, to: string, data: string, value = "0"): TransactionRequest {
  return { vm: "evm", network: action.network, chainId: CHAINS[action.network].evmChainId as number, from: EVM_ADDRESS, to, data, value, description: "tx" };
}

async function verify(step: IntentStep, references: readonly string[]) {
  const result = await relayAdapter.verify({ step, references, submittedAt: PREPARED_AT + 1_000, now: PREPARED_AT + 60_000 });
  return result.status === "failed" ? `failed ${result.failure.code}` : result.status === "confirmed" ? `confirmed ${result.actualOutput?.amount ?? "-"}` : result.status;
}

describe("Relay same-network swaps on Ethereum, OP Mainnet and Polygon PoS", () => {
  it("serves USDC -> ETH (and the gas token) on every EVM network Relay serves, never on Solana or a testnet", () => {
    for (const network of ["ethereum", "optimism", "polygon", "base", "arbitrum"] as const) {
      assert.ok(RELAY_SWAP_NETWORKS.includes(network), network);
      const native = CHAINS[network].nativeAsset.symbol;
      assert.equal(relayAdapter.supports(swapAction(network, "USDC", native, "100000000")), true, `${network} USDC->${native}`);
    }
    assert.equal(relayAdapter.supports(swapAction("ethereum", "USDC", "USDC", "100000000")), false, "same asset");
    assert.equal(RELAY_SWAP_NETWORKS.includes("solana"), false);
    assert.equal(RELAY_SWAP_NETWORKS.includes("arc"), false);
  });

  it("plans through the pinned approval proxy and marks the floor as claimed", async () => {
    for (const network of ["ethereum", "optimism", "polygon"] as const) {
      const action = swapAction(network, "USDC", CHAINS[network].nativeAsset.symbol, "100000000");
      relaySwapQuote(action, { amount: "40317788978660328", minimumAmount: "40116200033767026" });
      const planned = await relayAdapter.plan(action);
      assert.equal(planned.floor, "claimed", network);
      assert.equal(planned.settlement.kind, "same-network");
      assert.equal(planned.minimumOutput.amount, "40116200033767026");
      assert.equal(planned.transactionCount, 2);
    }
  });

  it("refuses a native quote whose calls together carry more value than the step amount", async () => {
    const action = swapAction("base", "ETH", "USDC", "50000000000000000");
    const chainId = CHAINS[action.network].settlement.relayChainId as number;
    const calls = [
      { to: ROUTER, data: "0xcd6e13f7", value: action.amount },
      { to: ROUTER, data: "0xcd6e13f7", value: action.amount },
    ];
    relaySwapQuote(action, { amount: "124037195", minimumAmount: "123417009" });
    const quote = mock.rpc.relayQuote as NonNullable<typeof mock.rpc.relayQuote>;
    mock.rpc.relayQuote = (body) => ({
      ...(quote(body) as Record<string, unknown>),
      steps: calls.map((call, index) => ({
        id: `swap-${index}`,
        kind: "transaction",
        requestId: `0x${"78".repeat(32)}`,
        items: [{ status: "incomplete", data: { from: EVM_ADDRESS, ...call, chainId } }],
      })),
    });
    await assert.rejects(relayAdapter.plan(action), (error: Error & { code?: string }) => error.code === "RELAY_QUOTE_INVALID" && /more value/u.test(error.message));
  });

  it("confirms an ERC-20 output only when the receipts credit at least the floor (OUTCOME_NOT_PROVEN below it)", async () => {
    const action = swapAction("optimism", "ETH", "USDC", "50000000000000000");
    const usdc = action.output.address as string;
    const transactions = [evmTx(action, ROUTER, "0xcd6e13f7", action.amount)];
    const step = swapStep(action, transactions, "123417009", "124037195");
    const short = landPrepared(mock.rpc, transactions, [transferLog(usdc, EVM_ADDRESS, 120_000_000n)]);
    assert.equal(await verify(step, short), "failed OUTCOME_NOT_PROVEN");
    // A transfer of the output token to someone else is not the account's credit.
    const elsewhere = landPrepared(mock.rpc, transactions, [transferLog(usdc, "0x2222222222222222222222222222222222222222", 124_000_000n)]);
    assert.equal(await verify(step, elsewhere), "failed OUTCOME_NOT_PROVEN");
    const full = landPrepared(mock.rpc, transactions, [transferLog(usdc, EVM_ADDRESS, 124_000_000n)]);
    assert.equal(await verify(step, full), "confirmed 124000000");
    // Credit above the prepared expected output is not attributed to the step.
    const above = landPrepared(mock.rpc, transactions, [transferLog(usdc, EVM_ADDRESS, 130_000_000n)]);
    assert.equal(await verify(step, above), "confirmed 124037195");
  });

  it("proves a native output from the account's balance change over the swap block plus the gas it paid", async () => {
    const action = swapAction("ethereum", "USDC", "ETH", "100000000");
    const transactions = [
      evmTx(action, action.input.address as string, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [APPROVAL_PROXY as Hex, 100_000_000n] })),
      evmTx(action, APPROVAL_PROXY, "0xf9e4bab4"),
    ];
    const floor = 40_116_200_033_767_026n;
    const step = swapStep(action, transactions, floor.toString(), "40317788978660328");
    const references = landPrepared(mock.rpc, transactions, []);
    const block = mock.rpc.evm.get((references[1] as string).toLowerCase())?.blockNumber as bigint;
    const owner = EVM_ADDRESS.toLowerCase();
    // The swap receipt paid 21,000 gas at 1 wei (mock receipt): the credit is the delta plus that gas.
    mock.rpc.evmBalances.set(`${owner}@${block - 1n}`, 1_000_000n);
    mock.rpc.evmBalances.set(`${owner}@${block}`, 1_000_000n + floor - 21_000n - 1n);
    assert.equal(await verify(step, references), "failed OUTCOME_NOT_PROVEN");
    mock.rpc.evmBalances.set(`${owner}@${block}`, 1_000_000n + floor - 21_000n);
    assert.equal(await verify(step, references), `confirmed ${floor}`);
  });

  it("keeps cross-network legs on the binding check (their output is proven at settlement)", async () => {
    const action: AdapterAction = { ...swapAction("base", "USDC", "USDC", "25000000"), kind: "bridge", destinationNetwork: "arbitrum", output: asset("arbitrum", "USDC"), recipient: account("arbitrum") };
    const transactions = [evmTx(action, "0x4cD00E387622C35bDDB9b4c962C136462338BC31", "0xe8017952")];
    const step: IntentStep = { ...swapStep(action, transactions, "24000000", "24900000"), kind: "bridge", settlement: { kind: "cross-network", destinationNetwork: "arbitrum" } };
    const references = landPrepared(mock.rpc, transactions, []);
    assert.equal(await verify(step, references), "confirmed -");
  });
});
