/**
 * Offline chain and venues for the asset-change preview tests: a small EVM
 * world behind `eth_simulateV1` (multi-block, shared state, state overrides,
 * traced native transfers), `eth_gasPrice`, `eth_getBalance`, `eth_call`
 * (balances with overrides, Arbitrum's NodeInterface), the OP-stack
 * GasPriceOracle, and Solana `simulateTransaction` / `getBalance` with
 * scripted answers. Venue stubs plan with their transactions (like the
 * built-in adapters' plan-time previews) and opt in to prepare-time
 * simulation. Nothing here reaches a network.
 */
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, encodeFunctionResult, erc20Abi, getAddress, pad, parseAbi, toHex, type Hex } from "viem";
import {
  applySlippage,
  CHAINS,
  type EvmTransactionRequest,
  type IntentStep,
  type NetworkKey,
  type StepEvidence,
} from "@kletia/core";
import { assetAmount, sameAsset } from "../assets.js";
import type { AdapterAction, PlannedStep, PreparedPayload, ProtocolAdapter, VerifyContext } from "../adapters/types.js";
import { resetBalanceSlots } from "../contracts/balanceSlots.js";
import { resetSimulationEndpoints } from "../contracts/simulationRpc.js";
import { configurePreviewPricer, resetPreviews, resetPreviewSimulationCaches } from "../preview/index.js";
import { configurePlatform } from "../service.js";
import { MemoryIntentStore } from "../store.js";
import { installRpcRouter, RpcError, storageKey, type RpcRouter } from "./contractHarness.js";

export const USER = "0x4f183e308f24c81c05303821AD025812fBFd807D";
export const FRIEND = "0x1111111111111111111111111111111111111111";
export const STRANGER = "0x2222222222222222222222222222222222222222";
export const USDC = { base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", optimism: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" } as const;
export const WETH_ARBITRUM = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
/** Pinned Relay contracts (VENUE_CONTRACTS): approvals to them pass the spender invariant. */
export const RELAY_DEPOSITORY = "0x4cD00E387622C35bDDB9b4c962C136462338BC31";
export const RELAY_ROUTER = "0xb92fe925DC43a0ECdE6c8b1a2709c170Ec4fFf4f";
export const GAS_PRICE_ORACLE = "0x420000000000000000000000000000000000000F";
export const NODE_INTERFACE = "0x00000000000000000000000000000000000000C8";
const PROBE_ACCOUNT = "0x00000000000000000000000000000000c1e7a001";
const NATIVE_EMITTER = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const APPROVAL_TOPIC = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
export const SIM_URL = "https://preview-sim.test";

export const VENUE_ABI = parseAbi([
  "function deposit(address token, uint256 amount, bytes32 id)",
  "function swap(address tokenIn, uint256 amountIn, address tokenOut, uint256 minOut)",
  "function sweep(address token, uint256 amount)",
]);
const GPO_ABI = parseAbi(["function getL1Fee(bytes) view returns (uint256)"]);
const NODE_INTERFACE_ABI = parseAbi([
  "function gasEstimateL1Component(address to, bool contractCreation, bytes data) payable returns (uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)",
]);

export interface PreviewWorld {
  /** ERC-20 balances `${token}:${owner}` (lower case). */
  readonly balances: Map<string, bigint>;
  readonly allowances: Map<string, bigint>;
  readonly native: Map<string, bigint>;
  /** Balance slot of every token (solidity mapping 9, like USDC). */
  readonly slot: number;
  gasPrice: bigint;
  /** GasPriceOracle.getL1Fee answer (wei). */
  l1Fee: bigint;
  /** NodeInterface: L1 gas units and base fee. */
  arbitrumL1Gas: bigint;
  arbitrumBaseFee: bigint;
  /** Swap rate: output units per input unit × 1e12 (6 → 18 decimals). */
  swapRate: bigint;
  /** Extra units the depository pulls beyond the amount (I2), and an extra approval it grants (I4). */
  depositExtraPull: bigint;
  depositApproves: string | null;
  /** eth_simulateV1 answers with an RPC error. */
  simulateDown: boolean;
  /** eth_simulateV1 requests (probes excluded). */
  readonly simulations: { readonly url: string; readonly blocks: unknown[] }[];
  /** Solana simulateTransaction answer factory (null: RPC error). */
  solanaSimulation: ((params: unknown[]) => unknown) | null;
  readonly solanaRequests: unknown[][];
  blockNumber: bigint;
}

const key = (...parts: string[]) => parts.map((part) => part.toLowerCase()).join(":");

interface State {
  readonly balances: Map<string, bigint>;
  readonly allowances: Map<string, bigint>;
  readonly native: Map<string, bigint>;
  readonly diffs: Map<string, Map<string, bigint>>;
}

function balanceOf(world: PreviewWorld, state: State, token: string, owner: string): bigint {
  const id = key(token, owner);
  if (state.balances.has(id)) return state.balances.get(id) as bigint;
  const diff = state.diffs.get(token.toLowerCase())?.get(storageKey(owner, { symbol: "", decimals: 6, slot: world.slot, layout: "solidity" }));
  if (diff !== undefined) return diff;
  return world.balances.get(id) ?? 0n;
}

function nativeOf(world: PreviewWorld, state: State, owner: string): bigint {
  return state.native.get(owner.toLowerCase()) ?? world.native.get(owner.toLowerCase()) ?? 0n;
}

function log(address: string, topics: string[], value: bigint) {
  return { address: address.toLowerCase(), topics, data: pad(toHex(value)) };
}

const word = (address: string) => pad(address.toLowerCase() as Hex);

class Revert extends Error {}

function transfer(world: PreviewWorld, state: State, token: string, from: string, to: string, amount: bigint, logs: unknown[]): void {
  const balance = balanceOf(world, state, token, from);
  if (balance < amount) throw new Revert("ERC20: transfer amount exceeds balance");
  state.balances.set(key(token, from), balance - amount);
  state.balances.set(key(token, to), balanceOf(world, state, token, to) + amount);
  logs.push(log(token, [TRANSFER_TOPIC, word(from), word(to)], amount));
}

function pull(world: PreviewWorld, state: State, token: string, owner: string, spender: string, amount: bigint, logs: unknown[]): void {
  const allowance = state.allowances.get(key(token, owner, spender)) ?? world.allowances.get(key(token, owner, spender)) ?? 0n;
  if (allowance < amount) throw new Revert("ERC20: transfer amount exceeds allowance");
  state.allowances.set(key(token, owner, spender), allowance - amount);
  transfer(world, state, token, owner, spender, amount, logs);
}

const TOKENS = new Set([...Object.values(USDC), WETH_ARBITRUM].map((address) => address.toLowerCase()));

function execute(world: PreviewWorld, state: State, call: { from: string; to: string; data?: string; value?: string }) {
  const logs: unknown[] = [];
  const from = call.from.toLowerCase();
  const to = call.to.toLowerCase();
  const value = call.value ? BigInt(call.value) : 0n;
  const data = (call.data ?? "0x") as Hex;
  try {
    if (value > 0n) {
      const balance = nativeOf(world, state, from);
      if (balance < value) throw new Revert("insufficient funds for transfer");
      state.native.set(from, balance - value);
      state.native.set(to, nativeOf(world, state, to) + value);
      logs.push(log(NATIVE_EMITTER, [TRANSFER_TOPIC, word(from), word(to)], value));
    }
    if (data === "0x") return { status: "0x1", returnData: "0x", logs, gasUsed: toHex(21_000n) };
    if (to === GAS_PRICE_ORACLE.toLowerCase()) {
      return { status: "0x1", returnData: encodeFunctionResult({ abi: GPO_ABI, functionName: "getL1Fee", result: world.l1Fee }), logs, gasUsed: toHex(30_000n) };
    }
    if (TOKENS.has(to)) {
      const decoded = decodeFunctionData({ abi: erc20Abi, data });
      const args = decoded.args as readonly unknown[];
      switch (decoded.functionName) {
        case "balanceOf":
          return { status: "0x1", returnData: encodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", result: balanceOf(world, state, to, args[0] as string) }), logs, gasUsed: toHex(30_990n) };
        case "allowance": {
          const allowance = state.allowances.get(key(to, args[0] as string, args[1] as string)) ?? world.allowances.get(key(to, args[0] as string, args[1] as string)) ?? 0n;
          return { status: "0x1", returnData: encodeFunctionResult({ abi: erc20Abi, functionName: "allowance", result: allowance }), logs, gasUsed: toHex(31_000n) };
        }
        case "approve": {
          const [spender, amount] = args as [string, bigint];
          state.allowances.set(key(to, from, spender), amount);
          logs.push(log(to, [APPROVAL_TOPIC, word(from), word(spender)], amount));
          return { status: "0x1", returnData: encodeFunctionResult({ abi: erc20Abi, functionName: "approve", result: true }), logs, gasUsed: toHex(55_437n) };
        }
        case "transfer": {
          const [recipient, amount] = args as [string, bigint];
          transfer(world, state, to, from, recipient, amount, logs);
          return { status: "0x1", returnData: encodeFunctionResult({ abi: erc20Abi, functionName: "transfer", result: true }), logs, gasUsed: toHex(45_000n) };
        }
        default:
          throw new Revert(`unsupported token call ${decoded.functionName}`);
      }
    }
    if (to === RELAY_DEPOSITORY.toLowerCase() || to === RELAY_ROUTER.toLowerCase()) {
      const decoded = decodeFunctionData({ abi: VENUE_ABI, data });
      if (decoded.functionName === "deposit") {
        const [token, amount] = decoded.args as readonly [string, bigint, Hex];
        pull(world, state, token, from, to, amount, logs);
        // A misbehaving venue (or token) that takes more than it was approved for.
        if (world.depositExtraPull > 0n) transfer(world, state, token, from, to, world.depositExtraPull, logs);
        if (world.depositApproves) {
          state.allowances.set(key(token, from, world.depositApproves), 1n);
          logs.push(log(token, [APPROVAL_TOPIC, word(from), word(world.depositApproves)], 1n));
        }
        return { status: "0x1", returnData: "0x", logs, gasUsed: toHex(48_770n) };
      }
      if (decoded.functionName === "swap") {
        const [tokenIn, amountIn, tokenOut, minOut] = decoded.args as readonly [string, bigint, string, bigint];
        pull(world, state, tokenIn, from, to, amountIn, logs);
        const out = amountIn * world.swapRate;
        if (out < minOut) throw new Revert("slippage");
        state.balances.set(key(tokenOut, to), balanceOf(world, state, tokenOut, to) + out);
        transfer(world, state, tokenOut, to, from, out, logs);
        return { status: "0x1", returnData: "0x", logs, gasUsed: toHex(120_000n) };
      }
      throw new Revert("unsupported venue call");
    }
    throw new Revert(`no contract at ${to}`);
  } catch (error) {
    if (!(error instanceof Revert)) throw error;
    const message = encodeAbiParameters([{ type: "string" }], [error.message]);
    return { status: "0x0", returnData: "0x", logs: [], gasUsed: toHex(50_000n), error: { code: 3, message: `execution reverted: ${error.message}`, data: `0x08c379a0${message.slice(2)}` } };
  }
}

function readOverrides(raw: unknown, state: State): void {
  if (typeof raw !== "object" || raw === null) return;
  for (const [address, entry] of Object.entries(raw as Record<string, { balance?: string; stateDiff?: Record<string, string> }>)) {
    if (entry.balance) state.native.set(address.toLowerCase(), BigInt(entry.balance));
    if (entry.stateDiff) {
      const diffs = state.diffs.get(address.toLowerCase()) ?? new Map<string, bigint>();
      for (const [slot, value] of Object.entries(entry.stateDiff)) diffs.set(slot.toLowerCase(), BigInt(value));
      state.diffs.set(address.toLowerCase(), diffs);
    }
  }
}

const fresh = (): State => ({ balances: new Map(), allowances: new Map(), native: new Map(), diffs: new Map() });

export interface PreviewChain {
  readonly router: RpcRouter;
  readonly world: PreviewWorld;
  restore(): void;
}

/** Installs the offline chain and points every EVM network's simulation endpoints at it. */
export function installPreviewChain(): PreviewChain {
  const router = installRpcRouter();
  const world: PreviewWorld = {
    balances: new Map(),
    allowances: new Map(),
    native: new Map(),
    slot: 9,
    gasPrice: 6_000_000n,
    l1Fee: 1_363_490_454n,
    arbitrumL1Gas: 800n,
    arbitrumBaseFee: 20_000_000n,
    swapRate: 400_000_000n,
    depositExtraPull: 0n,
    depositApproves: null,
    simulateDown: false,
    simulations: [],
    solanaSimulation: null,
    solanaRequests: [],
    blockNumber: 52_381_200n,
  };
  router.handlers.set("eth_simulateV1", ([request], url) => {
    const body = request as { blockStateCalls: { stateOverrides?: unknown; calls: { from: string; to: string; data?: string; value?: string }[] }[] };
    const probe = body.blockStateCalls.length === 1 && body.blockStateCalls[0]?.calls[0]?.from.toLowerCase() === PROBE_ACCOUNT;
    if (!probe) world.simulations.push({ url, blocks: body.blockStateCalls });
    if (world.simulateDown) throw new RpcError(-32601, "the method eth_simulateV1 does not exist/is not available");
    const state = fresh();
    return body.blockStateCalls.map((block, index) => {
      readOverrides(block.stateOverrides, state);
      return {
        number: toHex(world.blockNumber + 1n + BigInt(index)),
        hash: `0x${"ab".repeat(32)}`,
        baseFeePerGas: "0x0",
        calls: block.calls.map((call) => execute(world, state, call)),
      };
    });
  });
  router.handlers.set("eth_gasPrice", () => toHex(world.gasPrice));
  router.handlers.set("eth_getBalance", ([address]) => toHex(world.native.get(String(address).toLowerCase()) ?? 0n));
  router.handlers.set("eth_createAccessList", () => ({ accessList: [], gasUsed: "0x0" }));
  router.handlers.set("eth_call", ([tx, , overrides]) => {
    const call = tx as { from?: string; to: string; data?: string };
    if (call.to.toLowerCase() === NODE_INTERFACE.toLowerCase()) {
      return encodeFunctionResult({ abi: NODE_INTERFACE_ABI, functionName: "gasEstimateL1Component", result: [world.arbitrumL1Gas, world.arbitrumBaseFee, 1n] });
    }
    const state = fresh();
    readOverrides(overrides, state);
    const result = execute(world, state, { from: call.from ?? "0x0000000000000000000000000000000000000000", to: call.to, ...(call.data ? { data: call.data } : {}) });
    if (result.status !== "0x1") throw new RpcError(3, "execution reverted");
    return result.returnData;
  });
  router.handlers.set("simulateTransaction", (params) => {
    world.solanaRequests.push(params);
    if (!world.solanaSimulation) throw new RpcError(-32000, "simulation unavailable");
    return world.solanaSimulation(params);
  });
  router.handlers.set("getBalance", () => ({ context: { slot: 1 }, value: 0 }));
  resetSimulationEndpoints();
  resetBalanceSlots();
  resetPreviewSimulationCaches();
  for (const network of ["BASE", "ARBITRUM", "ETHEREUM", "OPTIMISM", "POLYGON", "ARC", "ARBITRUM_SEPOLIA"]) {
    process.env[`KLETIA_SIMULATION_RPC_URLS_${network}`] = SIM_URL;
  }
  return {
    router,
    world,
    restore() {
      router.restore();
      resetSimulationEndpoints();
      for (const network of ["BASE", "ARBITRUM", "ETHEREUM", "OPTIMISM", "POLYGON", "ARC", "ARBITRUM_SEPOLIA"]) {
        delete process.env[`KLETIA_SIMULATION_RPC_URLS_${network}`];
      }
    },
  };
}

export function fund(world: PreviewWorld, token: string, owner: string, amount: bigint): void {
  world.balances.set(key(token, owner), amount);
}

/* ------------------------------------------------------------- venues */

export const calls = { plan: 0, prepare: 0 };

function evmTx(action: AdapterAction, to: string, data: string, value = "0", description = "test"): EvmTransactionRequest {
  return { vm: "evm", network: action.network, chainId: CHAINS[action.network].evmChainId as number, from: getAddress(action.account.address), to: getAddress(to), data, value, description };
}

function records(transactions: readonly EvmTransactionRequest[]): PreparedPayload["records"] {
  return transactions.map((transaction) => ({ vm: "evm" as const, network: transaction.network, to: transaction.to, description: transaction.description }));
}

const verify = async (context: VerifyContext) => ({
  status: "confirmed" as const,
  evidence: context.references.map((reference): StepEvidence => ({ kind: "receipt", network: context.step.network, reference, observedAt: new Date(context.now).toISOString(), detail: "stub confirmed" })),
});

/** What the transfer venue encodes (tests may tamper with it). */
export const venue = {
  /** Multiplier (bps) the bridge applies to its quoted output at prepare (10000 = unchanged). */
  bridgeOutputBps: 10_000n,
  /** Extra amount the transfer stub sends at prepare (a payload that moves more than the step). */
  transferExtra: 0n,
};

function transferTransactions(action: AdapterAction, extra = 0n): EvmTransactionRequest[] {
  const amount = BigInt(action.amount) + extra;
  return action.input.isNative
    ? [evmTx(action, action.recipient.address, "0x", amount.toString())]
    : [evmTx(action, action.input.address as string, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [getAddress(action.recipient.address), amount] }))];
}

function plannedTransfer(action: AdapterAction): PlannedStep {
  const amount = assetAmount(action.input, action.amount);
  return {
    protocol: action.input.isNative ? "system-transfer" : "erc20-transfer",
    title: `Send ${action.input.symbol}`,
    mode: "wallet",
    input: amount,
    expectedOutput: amount,
    minimumOutput: amount,
    estimatedSeconds: 10,
    settlement: { kind: "same-network" },
    warnings: [],
    transactionCount: 1,
    slippageBps: action.slippageBps,
    preview: { transactions: transferTransactions(action), expiresAt: Math.floor(Date.now() / 1000) + 600 },
  };
}

export const previewTransfer: ProtocolAdapter = {
  id: "erc20-transfer",
  protocols: ["erc20-transfer", "system-transfer"],
  label: "Preview transfer",
  previewAtPrepare: true,
  supports: (route) => route.kind === "transfer" && CHAINS[route.network].vm === "evm" && route.network === route.destinationNetwork,
  plan: async (action) => {
    calls.plan += 1;
    return plannedTransfer(action);
  },
  prepare: async ({ action }) => {
    calls.prepare += 1;
    const plan = plannedTransfer(action);
    const transactions = transferTransactions(action, venue.transferExtra);
    return { transactions, records: records(transactions), input: plan.input, expectedOutput: plan.expectedOutput, minimumOutput: plan.minimumOutput, warnings: [] };
  },
  verify,
};

/** The bridge quotes 99.96 % of the amount, guaranteed down to its slippage. */
function bridgeOutput(action: AdapterAction): { expected: string; minimum: string } {
  const expected = (BigInt(action.amount) * 9_996n) / 10_000n;
  return { expected: expected.toString(), minimum: applySlippage(expected.toString(), action.slippageBps) };
}

function bridgeTransactions(action: AdapterAction): EvmTransactionRequest[] {
  const id = pad(toHex(BigInt(action.amount)));
  return [
    evmTx(action, action.input.address as string, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [getAddress(RELAY_DEPOSITORY), BigInt(action.amount)] }), "0", "approve"),
    evmTx(action, RELAY_DEPOSITORY, encodeFunctionData({ abi: VENUE_ABI, functionName: "deposit", args: [getAddress(action.input.address as string), BigInt(action.amount), id] }), "0", "deposit"),
  ];
}

function plannedBridge(action: AdapterAction, bps = 10_000n): PlannedStep {
  const { expected, minimum } = bridgeOutput(action);
  return {
    protocol: "relay",
    title: `Bridge ${action.input.symbol}`,
    mode: "wallet",
    input: assetAmount(action.input, action.amount),
    expectedOutput: assetAmount(action.output, ((BigInt(expected) * bps) / 10_000n).toString()),
    minimumOutput: assetAmount(action.output, ((BigInt(minimum) * bps) / 10_000n).toString()),
    estimatedSeconds: 31,
    settlement: { kind: "cross-network", destinationNetwork: action.destinationNetwork, expectedSeconds: 16 },
    warnings: [],
    quoteId: `0x${"12".repeat(32)}`,
    transactionCount: 2,
    slippageBps: action.slippageBps,
    preview: {
      transactions: bridgeTransactions(action),
      approvalSpender: RELAY_DEPOSITORY.toLowerCase(),
      venueFees: [{ kind: "venue", label: "Relay relayer fee", usd: 0.03, paid: "deducted", certainty: "quoted" }],
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    },
  };
}

export const previewBridge: ProtocolAdapter = {
  id: "relay",
  protocols: ["relay"],
  label: "Preview bridge",
  previewAtPrepare: true,
  supports: (route) => {
    if (route.kind === "bridge") return route.network !== route.destinationNetwork && CHAINS[route.network].vm === "evm" && route.input.group !== undefined && route.input.group === route.output.group;
    return route.kind === "swap" && route.network === "arbitrum" && route.destinationNetwork === "arbitrum" && !sameAsset(route.input, route.output);
  },
  plan: async (action) => {
    calls.plan += 1;
    return action.kind === "swap" ? plannedSwap(action) : plannedBridge(action);
  },
  prepare: async ({ action }) => {
    calls.prepare += 1;
    const plan = action.kind === "swap" ? plannedSwap(action) : plannedBridge(action, venue.bridgeOutputBps);
    const transactions = action.kind === "swap" ? swapTransactions(action) : bridgeTransactions(action);
    return {
      transactions,
      records: records(transactions),
      input: plan.input,
      expectedOutput: plan.expectedOutput,
      minimumOutput: plan.minimumOutput,
      ...(action.kind === "bridge" ? { trackingId: `0x${"34".repeat(32)}` } : {}),
      warnings: [],
    };
  },
  verify,
  poll: async (step: IntentStep) => ({
    status: "settled" as const,
    evidence: [{ kind: "settlement", network: step.settlement?.destinationNetwork as NetworkKey, reference: `0x${"56".repeat(32)}`, observedAt: new Date().toISOString(), detail: "stub fill" }],
    ...(step.minimumOutput ? { actualOutput: step.minimumOutput } : {}),
  }),
};

function swapTransactions(action: AdapterAction): EvmTransactionRequest[] {
  const out = BigInt(action.amount) * 400_000_000n;
  return [
    evmTx(action, action.input.address as string, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [getAddress(RELAY_ROUTER), BigInt(action.amount)] }), "0", "approve"),
    evmTx(action, RELAY_ROUTER, encodeFunctionData({ abi: VENUE_ABI, functionName: "swap", args: [getAddress(action.input.address as string), BigInt(action.amount), getAddress(action.output.address as string), BigInt(applySlippage(out.toString(), action.slippageBps))] }), "0", "swap"),
  ];
}

function plannedSwap(action: AdapterAction): PlannedStep {
  const out = (BigInt(action.amount) * 400_000_000n).toString();
  return {
    protocol: "relay",
    title: `Swap ${action.input.symbol} to ${action.output.symbol}`,
    mode: "wallet",
    input: assetAmount(action.input, action.amount),
    expectedOutput: assetAmount(action.output, out),
    minimumOutput: assetAmount(action.output, applySlippage(out, action.slippageBps)),
    estimatedSeconds: 10,
    settlement: { kind: "same-network" },
    warnings: [],
    transactionCount: 2,
    slippageBps: action.slippageBps,
    preview: { transactions: swapTransactions(action), approvalSpender: RELAY_ROUTER.toLowerCase(), expiresAt: Math.floor(Date.now() / 1000) + 600 },
  };
}

export const PREVIEW_ADAPTERS: readonly ProtocolAdapter[] = [previewTransfer, previewBridge];

/** Fixed display prices: USDC $1, ETH and WETH $2,500. */
export function installPrices(): void {
  configurePreviewPricer({
    price: async (asset) => (asset.includes("/slip44:60") || asset.toLowerCase().includes(WETH_ARBITRUM.toLowerCase()) ? 2_500 : /erc20:/u.test(asset) ? 1 : null),
  });
}

/** Fresh store, preview venues, prices, caches and counters. */
export function resetPreviewEngine(): MemoryIntentStore {
  const store = new MemoryIntentStore();
  configurePlatform({ store, adapters: PREVIEW_ADAPTERS });
  resetPreviews();
  installPrices();
  calls.plan = 0;
  calls.prepare = 0;
  venue.bridgeOutputBps = 10_000n;
  venue.transferExtra = 0n;
  delete process.env.KLETIA_PREVIEW_ENFORCE;
  return store;
}

export const ACCOUNT_BASE = `eip155:8453:${USER}`;
export const ACCOUNT_ARBITRUM = `eip155:42161:${USER}`;
