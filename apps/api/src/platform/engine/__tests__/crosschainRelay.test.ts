import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { encodeFunctionData, erc20Abi, parseAbi, type Hex } from "viem";
import { CHAINS, type IntentGraph, type IntentStep } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { relayAdapter, RELAY_NETWORKS } from "../adapters/relay.js";
import { configureRelayApiKey, fetchRelayStatus } from "../adapters/relayClient.js";
import type { AdapterAction } from "../adapters/types.js";
import {
  bridgeAction,
  COMPUTE_BUDGET,
  installCrossChainMock,
  PREPARED_AT,
  RELAY_DEPOSITORY,
  RELAY_ROUTER,
  RELAY_SOLANA_DEPOSITORY,
  seconds,
  TOKEN_PROGRAM,
  USDC_SOL,
  type CrossChainMock,
} from "./crosschainFixtures.js";
import { EVM_ADDRESS, OTHER_EVM_ADDRESS, randomRequestId, randomSolanaSignature, SOL_ADDRESS } from "./helpers.js";
import { preparedStep } from "./rpcMock.js";

const DEPOSITORY_ABI = parseAbi([
  "function depositErc20(address depositor, address token, uint256 amount, bytes32 id)",
  "function depositNative(address depositor, bytes32 id)",
]);
const ORDER = `0x${"34".repeat(32)}` as Hex;

let mock: CrossChainMock;
/** Paths of every Relay API request, in order. */
let relayCalls: { path: string; query: URLSearchParams; apiKey: string | null }[] = [];

beforeEach(() => {
  mock = installCrossChainMock();
  relayCalls = [];
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname.endsWith("relay.link")) {
      relayCalls.push({ path: url.pathname, query: url.searchParams, apiKey: new Headers(init?.headers).get("x-api-key") });
    }
    return inner(input, init);
  }) as typeof fetch;
});

afterEach(() => {
  mock.restore();
  configureRelayApiKey(null);
});

async function errorOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof PlatformError, String(error));
    return `${error.code}: ${error.message}`;
  }
  return "OK";
}

type EvmCall = { to: string; data: string; value?: string; from?: string };

function depositErc20(action: AdapterAction, overrides: { depositor?: string; token?: string; amount?: bigint } = {}): Hex {
  return encodeFunctionData({
    abi: DEPOSITORY_ABI,
    functionName: "depositErc20",
    args: [(overrides.depositor ?? action.account.address) as Hex, (overrides.token ?? action.input.address) as Hex, overrides.amount ?? BigInt(action.amount), ORDER],
  });
}

function approve(spender: string, amount: bigint): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender as Hex, amount] });
}

/** Relay `/quote` answering `action` with the given EVM calls (one transaction step per call). */
function relayEvmQuote(action: AdapterAction, calls: readonly EvmCall[]) {
  const chainId = CHAINS[action.network].settlement.relayChainId as number;
  mock.rpc.relayQuote = (body) => ({
    steps: calls.map((call, index) => ({
      id: index === calls.length - 1 ? "deposit" : "approve",
      kind: "transaction",
      requestId: `0x${"12".repeat(32)}`,
      items: [{ status: "incomplete", data: { from: call.from ?? EVM_ADDRESS, to: call.to, data: call.data, value: call.value ?? "0", chainId } }],
    })),
    fees: { gas: { amountUsd: "0.01" } },
    details: {
      recipient: body.recipient,
      currencyIn: { currency: { chainId, address: body.originCurrency, decimals: action.input.decimals, symbol: action.input.symbol }, amount: action.amount },
      currencyOut: {
        currency: { chainId: CHAINS[action.destinationNetwork].settlement.relayChainId, address: body.destinationCurrency, decimals: action.output.decimals, symbol: action.output.symbol },
        amount: "24974466",
        minimumAmount: "24849594",
      },
      timeEstimate: 2,
    },
  });
}

function relaySolanaQuote(action: AdapterAction, programs: readonly string[]) {
  mock.rpc.relayQuote = (body) => ({
    steps: [{
      id: "deposit",
      kind: "transaction",
      requestId: `0x${"56".repeat(32)}`,
      items: [{
        status: "incomplete",
        data: {
          instructions: programs.map((programId) => ({ programId, keys: [{ pubkey: SOL_ADDRESS, isSigner: true, isWritable: true }], data: "0b9c60da" })),
          addressLookupTableAddresses: [],
        },
      }],
    }],
    fees: { gas: { amountUsd: "0.01" } },
    details: {
      recipient: body.recipient,
      currencyIn: { currency: { chainId: 792703809, address: USDC_SOL, decimals: 6, symbol: "USDC" }, amount: action.amount },
      currencyOut: { currency: { chainId: 8453, address: action.output.address, decimals: 6, symbol: "USDC" }, amount: "24973365", minimumAmount: "24848499" },
      timeEstimate: 2,
    },
  });
}

describe("Relay networks and pinned targets", () => {
  it("reads its networks from the protocol registry", () => {
    for (const network of ["base", "arbitrum", "ethereum", "optimism", "polygon", "solana"] as const) {
      assert.ok(RELAY_NETWORKS.includes(network), network);
    }
    assert.equal(relayAdapter.supports(bridgeAction("ethereum", "polygon")), true);
    assert.equal(RELAY_NETWORKS.includes("arc"), false);
  });

  it("plans a bridge that approves and deposits exactly into the pinned depository", async () => {
    const action = bridgeAction("base", "arbitrum");
    relayEvmQuote(action, [
      { to: action.input.address as string, data: approve(RELAY_DEPOSITORY, 25_000_000n) },
      { to: RELAY_DEPOSITORY, data: depositErc20(action) },
    ]);
    const planned = await relayAdapter.plan(action);
    assert.equal(planned.minimumOutput.amount, "24849594");
    assert.equal(planned.transactionCount, 2);
  });

  it("refuses unpinned targets, spenders and deposits that differ from the step, at plan", async () => {
    const action = bridgeAction("base", "arbitrum");
    const token = action.input.address as string;
    const cases: [EvmCall[], RegExp][] = [
      [[{ to: "0xa5F565650890fBA1824Ee0F21EbBbF660a179934", data: "0x1234" }], /not a pinned Relay contract/u],
      [[{ to: token, data: approve(OTHER_EVM_ADDRESS, 25_000_000n) }, { to: OTHER_EVM_ADDRESS, data: "0x1234" }], /spender is not a pinned Relay contract/u],
      // A same-asset bridge may only deposit: the router is not a valid target for it.
      [[{ to: token, data: approve(RELAY_ROUTER, 25_000_000n) }, { to: RELAY_ROUTER, data: "0x1234" }], /not a pinned Relay contract/u],
      [[{ to: RELAY_DEPOSITORY, data: depositErc20(action, { depositor: OTHER_EVM_ADDRESS }) }], /another depositor/u],
      [[{ to: RELAY_DEPOSITORY, data: depositErc20(action, { token: OTHER_EVM_ADDRESS }) }], /names another token/u],
      [[{ to: RELAY_DEPOSITORY, data: depositErc20(action, { amount: 24_000_000n }) }], /amount differs/u],
      [[{ to: RELAY_DEPOSITORY, data: depositErc20(action), value: "1" }], /must not carry value/u],
      [[{ to: RELAY_DEPOSITORY, data: "0x12345678" }], /not a deposit/u],
      [[{ to: RELAY_DEPOSITORY, data: depositErc20(action) }, { to: RELAY_DEPOSITORY, data: depositErc20(action) }], /exactly one depository deposit/u],
      [[{ to: RELAY_DEPOSITORY, data: depositErc20(action), from: OTHER_EVM_ADDRESS }], /not sent by the step account/u],
      [[{ to: token, data: approve(RELAY_DEPOSITORY, 30_000_000n) }, { to: RELAY_DEPOSITORY, data: depositErc20(action) }], /approval exceeds the step amount/u],
    ];
    for (const [calls, reason] of cases) {
      relayEvmQuote(action, calls);
      const error = await errorOf(() => relayAdapter.plan(action));
      assert.match(error, /^RELAY_QUOTE_INVALID/u, reason.source);
      assert.match(error, reason);
    }
  });

  it("allows the router and approval proxy only for routes that swap, and checks native deposits", async () => {
    const swap = bridgeAction("base", "arbitrum", { out: "ETH" });
    relayEvmQuote(swap, [
      { to: swap.input.address as string, data: approve(RELAY_ROUTER, 25_000_000n) },
      { to: RELAY_ROUTER, data: "0x1234" },
    ]);
    assert.equal((await relayAdapter.plan(swap)).protocol, "relay");
    const native = bridgeAction("base", "optimism", { symbol: "ETH", amount: "10000000000000000" });
    const depositNative = encodeFunctionData({ abi: DEPOSITORY_ABI, functionName: "depositNative", args: [EVM_ADDRESS, ORDER] });
    relayEvmQuote(native, [{ to: RELAY_DEPOSITORY, data: depositNative, value: "10000000000000000" }]);
    assert.equal((await relayAdapter.plan(native)).transactionCount, 1);
    relayEvmQuote(native, [{ to: RELAY_DEPOSITORY, data: depositNative, value: "9000000000000000" }]);
    assert.match(await errorOf(() => relayAdapter.plan(native)), /native deposit value differs/u);
  });

  it("runs the same checks at prepare", async () => {
    const action = bridgeAction("base", "arbitrum");
    relayEvmQuote(action, [{ to: "0xa5F565650890fBA1824Ee0F21EbBbF660a179934", data: "0x1234" }]);
    const step = preparedStep({ network: "base", chain: CHAINS.base.id, account: action.account.id });
    const prepare = () => relayAdapter.prepare({ graph: {} as IntentGraph, step, action, now: Date.now() });
    assert.match(await errorOf(prepare), /^RELAY_QUOTE_INVALID.*not a pinned Relay contract/u);
    relayEvmQuote(action, [{ to: RELAY_DEPOSITORY, data: depositErc20(action) }]);
    const prepared = await prepare();
    assert.equal(prepared.transactions.length, 1);
    assert.equal(prepared.transactions[0]?.vm === "evm" ? prepared.transactions[0].to : "", RELAY_DEPOSITORY);
  });

  it("refuses Solana deposits that invoke anything but the pinned depository and helper programs", async () => {
    const action = bridgeAction("solana", "base");
    relaySolanaQuote(action, [COMPUTE_BUDGET, RELAY_SOLANA_DEPOSITORY]);
    assert.equal((await relayAdapter.plan(action)).protocol, "relay");
    relaySolanaQuote(action, [RELAY_SOLANA_DEPOSITORY, "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"]);
    assert.match(await errorOf(() => relayAdapter.plan(action)), /JUP6.*not a pinned Relay program/u);
    relaySolanaQuote(action, [RELAY_SOLANA_DEPOSITORY, TOKEN_PROGRAM]);
    assert.match(await errorOf(() => relayAdapter.plan(action)), /does not invoke the pinned Relay depository/u);
    relaySolanaQuote(action, [COMPUTE_BUDGET]);
    assert.match(await errorOf(() => relayAdapter.plan(action)), /does not invoke the pinned Relay depository/u);
  });
});

describe("Relay status v3 and request lookups", () => {
  function settlingStep(requestId: string, deposit: string): IntentStep {
    return preparedStep({
      kind: "bridge",
      protocol: "relay",
      status: "settling",
      network: "solana",
      chain: CHAINS.solana.id,
      account: `${CHAINS.solana.id}:${SOL_ADDRESS}`,
      recipient: `eip155:8453:${EVM_ADDRESS}`,
      references: [deposit],
      minimumOutput: { asset: `eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, symbol: "USDC", decimals: 6, amount: "9900000", formatted: "9.9" },
      settlement: { kind: "cross-network", destinationNetwork: "base", trackingId: requestId },
      evidence: [{ kind: "quote", network: "solana", reference: requestId, observedAt: new Date(PREPARED_AT).toISOString() }],
      prepared: {
        quoteBinding: "d".repeat(64),
        preparedAt: new Date(PREPARED_AT).toISOString(),
        expiresAt: seconds(PREPARED_AT) + 90,
        transactions: [{ vm: "svm", network: "solana", feePayer: SOL_ADDRESS, to: RELAY_SOLANA_DEPOSITORY, description: "deposit" }],
      },
    });
  }

  it("reads /intents/status/v3 and reports Relay's failure reason", async () => {
    const requestId = randomRequestId();
    const deposit = randomSolanaSignature();
    mock.rpc.relayStatus.set(requestId, {
      status: "failure", inTxHashes: [deposit], txHashes: [], updatedAt: 1791523705389,
      originChainId: 792703809, destinationChainId: 8453, failReason: "SOLVER_CAPACITY_EXCEEDED", refundFailReason: "N/A",
    });
    const state = await fetchRelayStatus(requestId);
    assert.equal(state.status, "failure");
    assert.equal(state.failReason, "SOLVER_CAPACITY_EXCEEDED");
    const result = await relayAdapter.poll?.(settlingStep(requestId, deposit), Date.now());
    assert.equal(result?.status === "failed" ? result.failure.code : result?.status, "SETTLEMENT_FAILED");
    assert.match(result?.status === "failed" ? result.failure.message : "", /SOLVER_CAPACITY_EXCEEDED/u);
    assert.ok(relayCalls.every((call) => call.path === "/intents/status/v3"), JSON.stringify(relayCalls.map((call) => call.path)));
    // Unknown ids read as "unknown", never as a status that settles.
    assert.equal((await fetchRelayStatus(randomRequestId())).status, "unknown");
  });

  it("makes no by-hash lookup without RELAY_API_KEY and binds deposits only through quoted request ids", async () => {
    const requestId = randomRequestId();
    const deposit = randomSolanaSignature();
    mock.rpc.relayRequests.set(deposit, [{ id: randomRequestId(), status: "success", data: { inTxs: [{ txHash: deposit }] } }]);
    assert.equal((await relayAdapter.poll?.(settlingStep(requestId, deposit), Date.now()))?.status, "settling");
    assert.deepEqual(relayCalls.map((call) => call.path), ["/intents/status/v3"]);
    assert.equal(relayCalls.some((call) => call.path.startsWith("/requests")), false);
  });

  it("looks deposits up through /requests/v3 with the API key and ignores entries without the deposit", async () => {
    configureRelayApiKey("test-relay-key");
    const requestId = randomRequestId();
    const deposit = randomSolanaSignature();
    // An entry that does not list the deposit among its origin transactions is not attributed to it.
    mock.rpc.relayRequests.set(deposit, [{ id: randomRequestId(), status: "success", recipient: OTHER_EVM_ADDRESS, data: { inTxs: [{ txHash: randomSolanaSignature() }] } }]);
    assert.equal((await relayAdapter.poll?.(settlingStep(requestId, deposit), Date.now()))?.status, "settling");
    const lookup = relayCalls.find((call) => call.path === "/requests/v3");
    assert.equal(lookup?.apiKey, "test-relay-key");
    assert.equal(lookup?.query.get("depositTxHash"), deposit);
    // A request listing the deposit with another recipient is a mismatch.
    mock.rpc.relayRequests.set(deposit, [{ id: requestId, status: "success", recipient: OTHER_EVM_ADDRESS, data: { inTxs: [{ txHash: deposit }] } }]);
    const result = await relayAdapter.poll?.(settlingStep(requestId, deposit), Date.now());
    assert.equal(result?.status === "failed" ? result.failure.code : result?.status, "SETTLEMENT_MISMATCH");
  });
});
