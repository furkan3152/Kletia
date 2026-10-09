/**
 * `eth_simulateV1` client and the simulated block of a custom contract call.
 *
 * One block, run from the user's address with `traceTransfers: true` and
 * `validation: false`:
 *
 *   [input balance, output balance, (reset-approve,) approve, call,
 *    input balance, output balance, allowance]
 *
 * The balance and allowance reads catch tokens whose events do not tell the
 * whole story; the traced native transfers (pseudo-logs from 0xEeee…) show
 * value moves. Simulation only goes to capability-probed endpoints; an RPC
 * error (not a revert) tries the next one; when none answers the result is
 * `unavailable` and the caller decides (plan warns, prepare refuses).
 */
import { decodeErrorResult, encodeFunctionData, erc20Abi, getAddress, toHex, type Hex } from "viem";
import type { EvmNetworkKey } from "../chains/evm.js";
import { demoteSimulationEndpoint, jsonRpc, simulationEndpoints } from "./simulationRpc.js";

export interface SimulatedLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}

export interface SimulationCall {
  readonly from: string;
  readonly to: string;
  readonly data: string;
  readonly value?: bigint;
}

export interface SimulatedCallResult {
  readonly status: "success" | "reverted";
  readonly returnData: string;
  readonly gasUsed: bigint;
  readonly logs: readonly SimulatedLog[];
  /** Revert message (decoded Error(string) / Panic / node message) when reverted. */
  readonly error?: string;
}

/** State overrides: per address `balance` (wei) and/or `stateDiff` (slot → 32-byte word). */
export type StateOverrides = Readonly<Record<string, { readonly balance?: bigint; readonly stateDiff?: Readonly<Record<string, string>> }>>;

export type EvmSimulation =
  | { readonly status: "ok"; readonly block: bigint; readonly calls: readonly SimulatedCallResult[]; readonly endpoint: string }
  | { readonly status: "unavailable"; readonly reason: string };

function isHex(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/u.test(value);
}

function overridesJson(overrides: StateOverrides | undefined): Record<string, unknown> | undefined {
  if (!overrides || Object.keys(overrides).length === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const [address, entry] of Object.entries(overrides)) {
    out[getAddress(address)] = {
      ...(entry.balance !== undefined ? { balance: toHex(entry.balance) } : {}),
      ...(entry.stateDiff ? { stateDiff: entry.stateDiff } : {}),
    };
  }
  return out;
}

/** Human revert reason from simulateV1 error data (Error(string), Panic(uint256)) or the node message. */
export function revertReason(error: { message?: unknown; data?: unknown } | undefined, returnData?: string): string {
  const data = isHex(error?.data) ? error.data : isHex(returnData) ? returnData : undefined;
  if (data && data.length >= 10) {
    try {
      const decoded = decodeErrorResult({ data: data as Hex });
      const arg = decoded.args?.[0];
      if (decoded.errorName === "Error" && typeof arg === "string") return `execution reverted: ${arg.slice(0, 200)}`;
      if (decoded.errorName === "Panic" && typeof arg === "bigint") return `execution reverted: panic 0x${arg.toString(16)}`;
    } catch {
      // A custom error the ABI does not know: fall back to the node's message.
    }
  }
  const message = typeof error?.message === "string" ? error.message : "execution reverted";
  return message.replace(/[\r\n]+/gu, " ").slice(0, 240);
}

function parseLogs(value: unknown): SimulatedLog[] | null {
  if (!Array.isArray(value)) return null;
  const logs: SimulatedLog[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const log = entry as { address?: unknown; topics?: unknown; data?: unknown };
    if (typeof log.address !== "string" || !Array.isArray(log.topics) || !isHex(log.data)) return null;
    if (log.topics.some((topic) => !isHex(topic))) return null;
    logs.push({ address: log.address.toLowerCase(), topics: (log.topics as string[]).map((topic) => topic.toLowerCase()), data: log.data });
  }
  return logs;
}

/** Parses one simulateV1 block; null when the shape is not what the spec says (treated as an RPC failure). */
export function parseSimulatedBlock(result: unknown, expectedCalls: number): { block: bigint; calls: SimulatedCallResult[] } | null {
  if (!Array.isArray(result) || result.length < 1) return null;
  const block = result[0] as { number?: unknown; calls?: unknown };
  if (!isHex(block.number) || !Array.isArray(block.calls) || block.calls.length !== expectedCalls) return null;
  const calls: SimulatedCallResult[] = [];
  for (const entry of block.calls) {
    if (typeof entry !== "object" || entry === null) return null;
    const call = entry as { status?: unknown; returnData?: unknown; gasUsed?: unknown; logs?: unknown; error?: { message?: unknown; data?: unknown } };
    const logs = parseLogs(call.logs ?? []);
    if (logs === null || (call.status !== "0x1" && call.status !== "0x0")) return null;
    const returnData = isHex(call.returnData) ? call.returnData : "0x";
    const gasUsed = isHex(call.gasUsed) && call.gasUsed.length > 2 ? BigInt(call.gasUsed) : 0n;
    calls.push({
      status: call.status === "0x1" ? "success" : "reverted",
      returnData,
      gasUsed,
      logs,
      ...(call.status === "0x0" ? { error: revertReason(call.error, returnData) } : {}),
    });
  }
  return { block: BigInt(block.number), calls };
}

/**
 * Simulates `calls` in one block from the latest state. Never throws for RPC
 * trouble: tries every probed endpoint in order and reports `unavailable`
 * when none could simulate.
 */
export async function simulateEvmCalls(
  network: EvmNetworkKey,
  request: { readonly calls: readonly SimulationCall[]; readonly overrides?: StateOverrides },
): Promise<EvmSimulation> {
  const endpoints = await simulationEndpoints(network);
  if (endpoints.length === 0) return { status: "unavailable", reason: `No simulation endpoint for ${network} passed the capability probe.` };
  const overrides = overridesJson(request.overrides);
  const params = [
    {
      blockStateCalls: [
        {
          ...(overrides ? { stateOverrides: overrides } : {}),
          calls: request.calls.map((call) => ({
            from: getAddress(call.from),
            to: getAddress(call.to),
            data: call.data,
            ...(call.value && call.value > 0n ? { value: toHex(call.value) } : {}),
          })),
        },
      ],
      traceTransfers: true,
      validation: false,
    },
    "latest",
  ];
  let reason = "every simulation endpoint failed";
  for (const url of endpoints) {
    try {
      const outcome = await jsonRpc(url, "eth_simulateV1", params);
      if (!outcome.ok) {
        reason = `simulation RPC error ${outcome.error.code}`;
        continue;
      }
      const parsed = parseSimulatedBlock(outcome.result, request.calls.length);
      if (!parsed) {
        reason = "malformed simulation response";
        demoteSimulationEndpoint(url);
        continue;
      }
      return { status: "ok", block: parsed.block, calls: parsed.calls, endpoint: url };
    } catch {
      reason = "simulation endpoint unreachable";
      demoteSimulationEndpoint(url);
    }
  }
  return { status: "unavailable", reason };
}

/* ------------------------------------------------------- the call block */

export interface ContractCallBlockInput {
  readonly account: string;
  /** Who receives the declared output (the account unless the entry allows any recipient). */
  readonly recipient: string;
  /** ERC-20 input token (null: native or no input). */
  readonly inputToken: string | null;
  /** ERC-20 output token (null: no declared output). */
  readonly outputToken: string | null;
  /** The pinned approval spender of an ERC-20 input (allowance read after the call, which must be 0). */
  readonly spender: string | null;
  /** Reset-approve and approve calls, in order (already encoded). */
  readonly approvals: readonly SimulationCall[];
  readonly call: SimulationCall;
}

export interface ContractCallBlock {
  readonly calls: readonly SimulationCall[];
  readonly index: {
    readonly inputBefore: number | null;
    readonly outputBefore: number | null;
    readonly approvals: readonly number[];
    readonly call: number;
    readonly inputAfter: number | null;
    readonly outputAfter: number | null;
    readonly allowanceAfter: number | null;
  };
}

function balanceRead(from: string, token: string, owner: string): SimulationCall {
  return { from, to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [getAddress(owner)] }) };
}

/** Builds the simulated block: reads, approvals, the call, reads, allowance. */
export function buildContractCallBlock(input: ContractCallBlockInput): ContractCallBlock {
  const calls: SimulationCall[] = [];
  const push = (call: SimulationCall) => {
    calls.push(call);
    return calls.length - 1;
  };
  const inputBefore = input.inputToken ? push(balanceRead(input.account, input.inputToken, input.account)) : null;
  const outputBefore = input.outputToken ? push(balanceRead(input.account, input.outputToken, input.recipient)) : null;
  const approvals = input.approvals.map((approval) => push(approval));
  const call = push(input.call);
  const inputAfter = input.inputToken ? push(balanceRead(input.account, input.inputToken, input.account)) : null;
  const outputAfter = input.outputToken ? push(balanceRead(input.account, input.outputToken, input.recipient)) : null;
  const allowanceAfter = input.inputToken && input.spender
    ? push({
        from: input.account,
        to: input.inputToken,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [getAddress(input.account), getAddress(input.spender)] }),
      })
    : null;
  return { calls, index: { inputBefore, outputBefore, approvals, call, inputAfter, outputAfter, allowanceAfter } };
}

/** The uint256 a successful read returned, or null. */
export function readUint(result: SimulatedCallResult | undefined): bigint | null {
  if (!result || result.status !== "success" || !/^0x[0-9a-fA-F]{64}$/u.test(result.returnData)) return null;
  return BigInt(result.returnData);
}
