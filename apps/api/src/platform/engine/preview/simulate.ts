/**
 * Simulation I/O of the asset-change preview (asset-preview design §5.2-5.4,
 * §6.1): one multi-block `eth_simulateV1` per EVM network job
 * (`traceTransfers: true`, `validation: false`) to the capability-probed
 * endpoints, `eth_gasPrice` (cached 12 s per network), Arbitrum's L1
 * component through `NodeInterface.gasEstimateL1Component` by parallel
 * `eth_call` (cached 30 s per calldata), balance overrides for funds in
 * flight, and Solana `simulateTransaction` with balances, token balances,
 * inner instructions and the post states of the user's token accounts.
 *
 * Read-only: nothing here signs or sends a transaction. Solana requests
 * never carry an override field (Agave has none and silently ignores unknown
 * fields, so code must not rely on one existing; F4).
 */
import { createHash } from "node:crypto";
import { decodeFunctionResult, encodeFunctionData, erc20Abi, getAddress, pad, toHex, type Hex } from "viem";
import { CHAINS, getAsset, type SolanaTransactionRequest } from "@kletia/core";
import type { EvmNetworkKey } from "../chains/evm.js";
import { simulateSolanaTransactionDetailed, type DetailedSolanaSimulation } from "../chains/solana.js";
import { balanceOverride } from "../contracts/balanceSlots.js";
import { parseSimulatedBlock, type SimulatedCallResult, type StateOverrides } from "../contracts/simulateEvm.js";
import { demoteSimulationEndpoint, jsonRpc, simulationEndpoints } from "../contracts/simulationRpc.js";
import { staticKeysOf } from "../contracts/solanaActions.js";
import type { SolanaNetworkKey } from "../../../networks/solana/index.js";
import { getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";
import { ARBITRUM_NETWORKS, NODE_INTERFACE, NODE_INTERFACE_ABI, type EvmBlockPlan, type EvmJob } from "./jobs.js";

const GAS_PRICE_TTL_MS = 12_000;
const L1_TTL_MS = 30_000;
const RESULT_TTL_MS = 12_000;
const MAX_CACHE = 2_000;

export interface SimulatedBlock {
  readonly plan: EvmBlockPlan;
  readonly calls: readonly SimulatedCallResult[];
  /** Funds overridden for this block (asset id, amount), when it assumed a parent's output. */
  readonly overridden: { readonly asset: string; readonly amount: string } | null;
  /** The block assumed funds but no override location is known: its numbers are not simulated with them. */
  readonly overrideMissing: boolean;
}

export type SimulatedJob =
  | {
      readonly status: "ok";
      readonly job: EvmJob;
      readonly block: bigint;
      /** Host of the endpoint that answered. */
      readonly endpoint: string;
      readonly blocks: readonly SimulatedBlock[];
      /** Wei per gas from eth_gasPrice; null when unreadable. */
      readonly gasPrice: bigint | null;
      /** Arbitrum: L1 fee (wei) per transaction of each block (`${stepId}:${index}`). */
      readonly arbitrumL1: ReadonlyMap<string, bigint>;
      readonly at: number;
    }
  | { readonly status: "unavailable"; readonly job: EvmJob; readonly reason: string };

/* ------------------------------------------------------------------ caches */

function remember<V>(map: Map<string, { value: V; at: number }>, key: string, value: V): V {
  map.delete(key);
  map.set(key, { value, at: Date.now() });
  while (map.size > MAX_CACHE) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  return value;
}

function recall<V>(map: Map<string, { value: V; at: number }>, key: string, ttlMs: number): V | undefined {
  const entry = map.get(key);
  return entry && Date.now() - entry.at < ttlMs ? entry.value : undefined;
}

const gasPrices = new Map<string, { value: bigint; at: number }>();
const l1Components = new Map<string, { value: bigint | null; at: number }>();
const results = new Map<string, { value: { block: bigint; endpoint: string; raw: unknown[] }; at: number }>();

/** Clears every preview simulation cache (tests). */
export function resetPreviewSimulationCaches(): void {
  gasPrices.clear();
  l1Components.clear();
  results.clear();
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

function hexQuantity(value: unknown): bigint | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]+$/u.test(value) ? BigInt(value) : null;
}

/** Remaining milliseconds before `deadline` (at least 250 ms so a request can still be tried). */
function remaining(deadline: number): number {
  return Math.max(250, deadline - Date.now());
}

/* --------------------------------------------------------------- overrides */

async function rpcAt(network: EvmNetworkKey, method: string, params: readonly unknown[], deadline: number): Promise<unknown> {
  for (const url of await simulationEndpoints(network)) {
    try {
      const outcome = await jsonRpc(url, method, params, remaining(deadline));
      if (outcome.ok) return outcome.result;
    } catch {
      // Try the next endpoint.
    }
  }
  return null;
}

/**
 * Override giving `owner` its current balance plus the assumed `amount` of
 * the asset (design §5.3). Native-view tokens (registry flag, Arc USDC) go
 * through the native balance, scaled; other ERC-20s through the discovered
 * balance slot. Null when no location is known.
 */
export async function fundsOverride(
  network: EvmNetworkKey,
  owner: string,
  asset: { readonly asset: string; readonly decimals: number },
  amount: bigint,
  deadline: number,
): Promise<StateOverrides | null> {
  const listed = getAsset(asset.asset);
  const token = asset.asset.includes("/erc20:") ? asset.asset.slice(asset.asset.indexOf("/erc20:") + 7) : null;
  if (token === null) {
    const current = hexQuantity(await rpcAt(network, "eth_getBalance", [getAddress(owner), "latest"], deadline));
    if (current === null) return null;
    return { [getAddress(owner)]: { balance: current + amount } };
  }
  const read = await rpcAt(network, "eth_call", [{ to: getAddress(token), data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [getAddress(owner)] }) }, "latest"], deadline);
  const current = typeof read === "string" && /^0x[0-9a-fA-F]{64}$/u.test(read) ? BigInt(read) : null;
  if (current === null) return null;
  if (listed?.nativeBalanceView) {
    const nativeBalance = hexQuantity(await rpcAt(network, "eth_getBalance", [getAddress(owner), "latest"], deadline));
    if (nativeBalance === null) return null;
    const scale = 10n ** BigInt(Math.max(0, CHAINS[network].nativeAsset.decimals - asset.decimals));
    return { [getAddress(owner)]: { balance: nativeBalance + amount * scale } };
  }
  return balanceOverride(network, token, owner, current + amount);
}

function mergeOverrides(target: Record<string, { balance?: bigint; stateDiff?: Record<string, string> }>, next: StateOverrides): void {
  for (const [address, entry] of Object.entries(next)) {
    const key = getAddress(address);
    const existing = target[key] ?? {};
    target[key] = {
      ...existing,
      ...(entry.balance !== undefined ? { balance: entry.balance } : {}),
      ...(entry.stateDiff ? { stateDiff: { ...(existing.stateDiff ?? {}), ...entry.stateDiff } } : {}),
    };
  }
}

function overridesJson(overrides: StateOverrides): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [address, entry] of Object.entries(overrides)) {
    out[getAddress(address)] = {
      ...(entry.balance !== undefined ? { balance: toHex(entry.balance) } : {}),
      ...(entry.stateDiff ? { stateDiff: Object.fromEntries(Object.entries(entry.stateDiff).map(([slot, value]) => [slot, pad(value as Hex)])) } : {}),
    };
  }
  return out;
}

/* ------------------------------------------------------------- gas prices */

async function gasPriceOf(network: EvmNetworkKey, endpoint: string, deadline: number): Promise<bigint | null> {
  const cached = recall(gasPrices, network, GAS_PRICE_TTL_MS);
  if (cached !== undefined) return cached;
  try {
    const outcome = await jsonRpc(endpoint, "eth_gasPrice", [], remaining(deadline));
    const value = outcome.ok ? hexQuantity(outcome.result) : null;
    return value === null ? null : remember(gasPrices, network, value);
  } catch {
    return null;
  }
}

/** Arbitrum L1 component of one transaction (wei): NodeInterface l1Gas × baseFee; null when unreadable. */
async function arbitrumL1Fee(network: EvmNetworkKey, endpoint: string, transaction: { readonly from: string; readonly to: string; readonly data: string }, deadline: number): Promise<bigint | null> {
  const key = `${network}:${createHash("sha256").update(`${transaction.to.toLowerCase()}:${transaction.data.toLowerCase()}`).digest("hex")}`;
  const cached = recall(l1Components, key, L1_TTL_MS);
  if (cached !== undefined) return cached;
  try {
    const data = encodeFunctionData({ abi: NODE_INTERFACE_ABI, functionName: "gasEstimateL1Component", args: [getAddress(transaction.to), false, transaction.data as Hex] });
    const outcome = await jsonRpc(endpoint, "eth_call", [{ from: getAddress(transaction.from), to: NODE_INTERFACE, data }, "latest"], remaining(deadline));
    if (!outcome.ok || typeof outcome.result !== "string") return remember(l1Components, key, null);
    const [l1Gas, baseFee] = decodeFunctionResult({ abi: NODE_INTERFACE_ABI, functionName: "gasEstimateL1Component", data: outcome.result as Hex });
    return remember(l1Components, key, BigInt(l1Gas) * BigInt(baseFee));
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------- EVM jobs */

function resultKey(network: string, blocks: readonly { calls: readonly unknown[]; stateOverrides?: unknown }[]): string {
  return createHash("sha256").update(JSON.stringify([network, blocks])).digest("hex");
}

/**
 * Simulates one network job. Never throws for RPC trouble: every probed
 * endpoint is tried in order and the job is `unavailable` when none answers
 * before `deadline` (unix ms). Answers are cached 12 s unless `fresh`.
 */
export async function simulateEvmJob(job: EvmJob, deadline: number, options: { readonly fresh?: boolean } = {}): Promise<SimulatedJob> {
  const endpoints = await simulationEndpoints(job.network);
  if (endpoints.length === 0) return { status: "unavailable", job, reason: `No simulation endpoint for ${CHAINS[job.network].name} passed the capability probe.` };
  const overridden: (SimulatedBlock["overridden"])[] = [];
  const missing: boolean[] = [];
  const blocks: { calls: unknown[]; stateOverrides?: Record<string, unknown> }[] = [];
  for (const block of job.blocks) {
    let overrides: StateOverrides | null = null;
    if (block.assumeFunds) {
      overrides = await fundsOverride(job.network, block.owner, block.assumeFunds.asset, BigInt(block.assumeFunds.amount), deadline).catch(() => null);
    }
    overridden.push(block.assumeFunds && overrides ? { asset: block.assumeFunds.asset.asset, amount: block.assumeFunds.amount } : null);
    missing.push(block.assumeFunds !== null && overrides === null);
    const merged: Record<string, { balance?: bigint; stateDiff?: Record<string, string> }> = {};
    if (overrides) mergeOverrides(merged, overrides);
    blocks.push({
      ...(Object.keys(merged).length > 0 ? { stateOverrides: overridesJson(merged) } : {}),
      calls: block.calls.map((call) => ({
        from: getAddress(call.from),
        to: getAddress(call.to),
        data: call.data,
        ...(call.value && call.value > 0n ? { value: toHex(call.value) } : {}),
      })),
    });
  }
  const key = resultKey(job.network, blocks);
  // Prepare simulates exactly what the wallet will sign against current state: never a cached answer.
  let answer = options.fresh ? undefined : recall(results, key, RESULT_TTL_MS);
  let reason = "every simulation endpoint failed";
  if (!answer) {
    for (const url of endpoints) {
      if (Date.now() >= deadline) {
        reason = "simulation timed out";
        break;
      }
      try {
        const outcome = await jsonRpc(url, "eth_simulateV1", [{ blockStateCalls: blocks, traceTransfers: true, validation: false }, "latest"], remaining(deadline));
        if (!outcome.ok) {
          reason = `simulation RPC error ${outcome.error.code}`;
          continue;
        }
        if (!Array.isArray(outcome.result) || outcome.result.length !== blocks.length) {
          reason = "malformed simulation response";
          demoteSimulationEndpoint(url);
          continue;
        }
        const first = outcome.result[0] as { number?: unknown };
        const number = hexQuantity(first?.number);
        if (number === null) {
          reason = "malformed simulation response";
          demoteSimulationEndpoint(url);
          continue;
        }
        answer = remember(results, key, { block: number, endpoint: url, raw: outcome.result as unknown[] });
        break;
      } catch (error) {
        reason = (error as Error)?.name === "TimeoutError" ? "simulation timed out" : "simulation endpoint unreachable";
        if (reason !== "simulation timed out") demoteSimulationEndpoint(url);
      }
    }
  }
  if (!answer) return { status: "unavailable", job, reason };
  const parsed: SimulatedBlock[] = [];
  for (const [index, plan] of job.blocks.entries()) {
    const block = parseSimulatedBlock([answer.raw[index]], plan.calls.length);
    if (!block) return { status: "unavailable", job, reason: "malformed simulation response" };
    parsed.push({ plan, calls: block.calls, overridden: overridden[index] ?? null, overrideMissing: missing[index] ?? false });
  }
  const endpoint = answer.endpoint;
  const [gasPrice, arbitrumL1] = await Promise.all([
    gasPriceOf(job.network, endpoint, deadline),
    (async () => {
      const fees = new Map<string, bigint>();
      if (!ARBITRUM_NETWORKS.includes(job.network)) return fees;
      await Promise.all(job.blocks.flatMap((plan) =>
        plan.source.transactions.map(async (transaction, position) => {
          if (transaction.vm !== "evm") return;
          const fee = await arbitrumL1Fee(job.network, endpoint, transaction, deadline);
          if (fee !== null) fees.set(`${plan.step.id}:${position}`, fee);
        })));
      return fees;
    })(),
  ]);
  return { status: "ok", job, block: answer.block, endpoint: host(endpoint), blocks: parsed, gasPrice, arbitrumL1, at: Date.now() };
}

/* ------------------------------------------------------------------ Solana */

/** Writable non-signer static accounts of a wire transaction (post states are requested for them). */
export function writableStaticAccounts(base64: string): string[] {
  try {
    const bytes = Uint8Array.from(getBase64Encoder().encode(base64));
    const message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(bytes).messageBytes);
    const keys = message.staticAccounts.map(String);
    const header = message.header;
    const signers = header.numSignerAccounts;
    const readonlyUnsigned = header.numReadonlyNonSignerAccounts;
    return keys.slice(signers, keys.length - readonlyUnsigned);
  } catch {
    return [];
  }
}

export interface SimulatedSolanaStep {
  readonly status: "ok";
  readonly simulation: DetailedSolanaSimulation;
  /** Accounts whose post states were requested (index-aligned with `simulation.accounts`). */
  readonly requested: readonly string[];
  readonly endpoint: string;
  readonly at: number;
}

/** Simulates one Solana transaction of a step (sigVerify off, fresh blockhash, no overrides). */
export async function simulateSolanaStep(
  network: SolanaNetworkKey,
  transaction: SolanaTransactionRequest,
  endpoint: string,
): Promise<SimulatedSolanaStep | { readonly status: "unavailable"; readonly reason: string }> {
  let staticKeys: string[];
  try {
    staticKeys = staticKeysOf(transaction.transaction);
  } catch {
    return { status: "unavailable", reason: "the transaction could not be decoded" };
  }
  const requested = writableStaticAccounts(transaction.transaction).slice(0, 64);
  const simulation = await simulateSolanaTransactionDetailed(network, transaction.transaction, staticKeys, requested);
  if (!simulation) return { status: "unavailable", reason: "the Solana RPC could not simulate" };
  // Without balances the effect cannot be read: unavailable, never "nothing moves".
  if (simulation.error === null && (simulation.preBalances === null || simulation.postBalances === null)) {
    return { status: "unavailable", reason: "the Solana RPC returned no balances" };
  }
  return { status: "ok", simulation, requested, endpoint, at: Date.now() };
}

/** Sums the gas of a block's own transactions (not the reads). */
export function blockGasUsed(block: SimulatedBlock): bigint {
  return block.plan.index.transactions.reduce((total, at) => total + (block.calls[at]?.gasUsed ?? 0n), 0n);
}

/** OP-stack L1 fee (wei) read inside the block, summed over the step's transactions; null when unreadable. */
export function blockOpStackL1Fee(block: SimulatedBlock): bigint | null {
  if (block.plan.index.l1Fees.length === 0) return null;
  let total = 0n;
  for (const at of block.plan.index.l1Fees) {
    const call = block.calls[at];
    if (!call || call.status !== "success" || !/^0x[0-9a-fA-F]{64}$/u.test(call.returnData)) return null;
    total += BigInt(call.returnData);
  }
  return total;
}

