/**
 * In-process EVM contract state for the lending adapter tests: eth_call
 * (direct and through Multicall3 `aggregate3`, which the Base / Arbitrum
 * clients batch view reads into), eth_estimateGas, balances and blocks.
 * Contracts are registered by address with an ABI and per-function handlers;
 * a handler throws `Revert` to revert. Transaction / receipt reads fall
 * through to rpcMock's fixtures, so a test can plan, prepare, land the
 * prepared payload with chosen logs and verify it.
 */
import {
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  decodeFunctionData,
  erc20Abi,
  getAddress,
  multicall3Abi,
  type Abi,
  type AbiEvent,
  type Hex,
} from "viem";
import { findAssetBySymbol, getYieldVenue, type EvmTransactionRequest, type NetworkKey } from "@kletia/core";
import { resolveAsset } from "../assets.js";
import { WETH_ABI } from "../adapters/lending/common.js";
import { installRpcMock, type RpcMock } from "./rpcMock.js";
import { EVM_ADDRESS, randomEvmHash } from "./helpers.js";

export const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
export const MAX = (1n << 256n) - 1n;

export class Revert extends Error {
  constructor(readonly data: Hex = "0x") {
    super("execution reverted");
  }
}

export function revertWith(abi: Abi, errorName: string): Revert {
  return new Revert(encodeErrorResult({ abi, errorName } as never));
}

export interface CallContext {
  readonly from?: string;
  readonly value: bigint;
  readonly block: string;
}

// Handlers receive decoded ABI arguments; their shapes are per function.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Handler = (args: readonly any[], call: CallContext) => unknown;

export interface ContractCall {
  readonly to: string;
  readonly functionName: string;
  readonly args: readonly unknown[];
  readonly from?: string;
  readonly direct: boolean;
}

export interface LendingChain {
  readonly rpc: RpcMock;
  /** Every contract function the adapters called (direct eth_call or inside a multicall). */
  readonly calls: ContractCall[];
  /** Calls the mock could not answer. */
  readonly unknown: string[];
  gasEstimate: bigint | Revert;
  readonly nativeBalances: Map<string, bigint>;
  latestBlock: bigint;
  latestTimestamp: number;
  contract(address: string, abi: Abi, handlers: Record<string, Handler>): void;
  restore(): void;
}

const hex = (value: bigint | number) => `0x${value.toString(16)}`;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

export function installLendingChain(): LendingChain {
  const rpc = installRpcMock();
  const delegate = globalThis.fetch;
  const contracts = new Map<string, { abi: Abi; handlers: Record<string, Handler> }>();
  const chain: LendingChain = {
    rpc,
    calls: [],
    unknown: [],
    gasEstimate: 100_000n,
    nativeBalances: new Map(),
    latestBlock: 50_000_000n,
    latestTimestamp: Math.floor(Date.now() / 1000),
    contract(address, abi, handlers) {
      contracts.set(address.toLowerCase(), { abi, handlers });
    },
    restore() {
      rpc.restore();
    },
  };
  // viem reads native balances through Multicall3.getEthBalance when multicall batching is on.
  contracts.set(MULTICALL3, {
    abi: multicall3Abi as unknown as Abi,
    handlers: { getEthBalance: ([owner]) => chain.nativeBalances.get(String(owner).toLowerCase()) ?? 0n },
  });

  const run = (to: string, data: Hex, call: CallContext, direct: boolean): Hex => {
    const contract = contracts.get(to.toLowerCase());
    if (!contract) {
      chain.unknown.push(`no contract ${to} (${data.slice(0, 10)})`);
      throw new Error(`no contract at ${to}`);
    }
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: contract.abi, data });
    } catch {
      chain.unknown.push(`${to}: unknown selector ${data.slice(0, 10)}`);
      throw new Error("unknown selector");
    }
    const handler = contract.handlers[decoded.functionName];
    if (!handler) {
      chain.unknown.push(`${to}: unhandled ${decoded.functionName}`);
      throw new Error(`unhandled ${decoded.functionName}`);
    }
    const args = (decoded.args ?? []) as readonly unknown[];
    chain.calls.push({ to: to.toLowerCase(), functionName: decoded.functionName, args, ...(call.from ? { from: call.from } : {}), direct });
    const result = handler(args, call);
    return encodeFunctionResult({ abi: contract.abi, functionName: decoded.functionName, result } as never);
  };

  const ethCall = (params: unknown[]): Hex => {
    const tx = params[0] as { to: string; data?: Hex; input?: Hex; from?: string; value?: string };
    const block = typeof params[1] === "string" ? params[1] : "latest";
    const data = (tx.data ?? tx.input ?? "0x") as Hex;
    const call: CallContext = { ...(tx.from ? { from: tx.from } : {}), value: tx.value ? BigInt(tx.value) : 0n, block };
    if (tx.to.toLowerCase() === MULTICALL3 && data.startsWith("0x82ad56cb")) {
      const decoded = decodeFunctionData({ abi: multicall3Abi, data });
      if (decoded.functionName !== "aggregate3") throw new Error(`multicall ${decoded.functionName}`);
      const results = (decoded.args[0] as readonly { target: string; callData: Hex }[]).map((inner) => {
        try {
          return { success: true, returnData: run(inner.target, inner.callData, { value: 0n, block }, false) };
        } catch (error) {
          if (error instanceof Revert) return { success: false, returnData: error.data };
          return { success: false, returnData: "0x" as Hex };
        }
      });
      return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results });
    }
    return run(tx.to, data, call, true);
  };

  const answer = (method: string, params: unknown[], url: string): { result: unknown } | { error: { code: number; message: string; data?: Hex } } | null => {
    try {
      switch (method) {
        case "eth_chainId":
          // Platform-network clients attest the chain id before any read.
          return { result: hex(chainIdForUrl(url)) };
        case "eth_call":
          return { result: ethCall(params) };
        case "eth_estimateGas":
          if (chain.gasEstimate instanceof Revert) throw chain.gasEstimate;
          return { result: hex(chain.gasEstimate) };
        case "eth_gasPrice":
          return { result: hex(1_000_000n) };
        case "eth_getBalance":
          return { result: hex(chain.nativeBalances.get(String(params[0]).toLowerCase()) ?? 0n) };
        case "eth_blockNumber":
          return { result: hex(chain.latestBlock) };
        case "eth_getBlockByNumber": {
          const tag = String(params[0]);
          const number = tag === "latest" ? chain.latestBlock : BigInt(tag);
          if (tag !== "latest" && [...rpc.evm.values()].some((tx) => tx.blockNumber === number)) return null;
          return { result: syntheticBlock(number, chain.latestTimestamp - Number(chain.latestBlock - number) * 2) };
        }
        default:
          return null;
      }
    } catch (error) {
      if (error instanceof Revert) return { error: { code: 3, message: "execution reverted", data: error.data } };
      return { error: { code: -32603, message: (error as Error).message } };
    }
  };

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const bodyText = typeof init?.body === "string" ? init.body : "";
    let payload: unknown;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      return delegate(input, init);
    }
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const one = async (request: { id: unknown; method: string; params?: unknown[] }) => {
      const mine = answer(request.method, request.params ?? [], url);
      if (mine) return { jsonrpc: "2.0", id: request.id, ...mine };
      const response = await delegate(input, { ...init, body: JSON.stringify(request) });
      return response.json();
    };
    if (Array.isArray(payload)) return json(await Promise.all(payload.map(one)));
    if (typeof payload === "object" && payload !== null && "method" in payload) return json(await one(payload as { id: unknown; method: string; params?: unknown[] }));
    return delegate(input, init);
  }) as typeof fetch;
  return chain;
}

function chainIdForUrl(url: string): number {
  if (/ethereum|cloudflare-eth|eth\.drpc/u.test(url)) return 1;
  if (/optimism/u.test(url)) return 10;
  if (/polygon|matic/u.test(url)) return 137;
  if (/base/u.test(url)) return 8453;
  return 42161;
}

function syntheticBlock(number: bigint, timestamp: number) {
  return {
    number: hex(number),
    hash: `0x${"ab".repeat(32)}`,
    parentHash: `0x${"cd".repeat(32)}`,
    timestamp: hex(timestamp),
    nonce: "0x0000000000000000",
    difficulty: "0x0",
    gasLimit: "0x1",
    gasUsed: "0x1",
    miner: "0x0000000000000000000000000000000000000000",
    extraData: "0x",
    baseFeePerGas: "0x1",
    transactions: [],
    uncles: [],
    size: "0x1",
    logsBloom: `0x${"00".repeat(256)}`,
    sha3Uncles: `0x${"00".repeat(32)}`,
    stateRoot: `0x${"00".repeat(32)}`,
    receiptsRoot: `0x${"00".repeat(32)}`,
    transactionsRoot: `0x${"00".repeat(32)}`,
    mixHash: `0x${"00".repeat(32)}`,
    totalDifficulty: "0x0",
  };
}

/* --------------------------------------------------------------- tokens */

export interface TokenState {
  balances: Map<string, bigint>;
  allowances: Map<string, bigint>;
  totalSupply: bigint;
  symbol: string;
  decimals: number;
}

const key = (...parts: string[]) => parts.map((part) => part.toLowerCase()).join(":");

/** An ERC-20 (plus WETH deposit/withdraw) with mutable balances and allowances. */
export function mockToken(chain: LendingChain, address: string, init: Partial<TokenState> & Pick<TokenState, "symbol" | "decimals">): TokenState {
  const state: TokenState = { balances: new Map(), allowances: new Map(), totalSupply: 0n, ...init };
  chain.contract(address, [...erc20Abi, ...WETH_ABI] as unknown as Abi, {
    balanceOf: ([owner]) => state.balances.get(String(owner).toLowerCase()) ?? 0n,
    allowance: ([owner, spender]) => state.allowances.get(key(String(owner), String(spender))) ?? 0n,
    totalSupply: () => state.totalSupply,
    symbol: () => state.symbol,
    decimals: () => state.decimals,
  });
  return state;
}

export function setBalance(token: TokenState, owner: string, amount: bigint): void {
  token.balances.set(owner.toLowerCase(), amount);
}

export function setAllowance(token: TokenState, owner: string, spender: string, amount: bigint): void {
  token.allowances.set(key(owner, spender), amount);
}

/* ----------------------------------------------------------------- logs */

export interface LogFixture {
  readonly address: string;
  readonly topics: string[];
  readonly data: string;
}

/** Encodes an event log (indexed args in topics, the rest ABI-encoded in data). */
export function eventLog(address: string, abi: Abi, eventName: string, args: Record<string, unknown>): LogFixture {
  const event = abi.find((item): item is AbiEvent => item.type === "event" && item.name === eventName);
  if (!event) throw new Error(`no event ${eventName}`);
  const indexed = Object.fromEntries(event.inputs.filter((input) => input.indexed).map((input) => [input.name, args[input.name as string]]));
  const topics = encodeEventTopics({ abi: [event], eventName, args: indexed } as never) as string[];
  const rest = event.inputs.filter((input) => !input.indexed);
  const data = encodeAbiParameters(rest, rest.map((input) => args[input.name as string]));
  return { address: address.toLowerCase(), topics, data };
}

export function transferLog(token: string, from: string, to: string, value: bigint): LogFixture {
  return eventLog(token, erc20Abi as unknown as Abi, "Transfer", { from, to, value });
}

/** Lands every prepared transaction (success unless overridden) with the given logs, returning their hashes. */
export function landPrepared(
  chain: LendingChain,
  transactions: readonly EvmTransactionRequest[],
  logs: readonly (readonly LogFixture[])[],
  overrides: { status?: "success" | "reverted"; timestamp?: number } = {},
): string[] {
  return transactions.map((transaction, index) => {
    const hash = randomEvmHash();
    chain.rpc.evm.set(hash.toLowerCase(), {
      hash,
      from: transaction.from,
      to: transaction.to,
      input: transaction.data,
      value: BigInt(transaction.value),
      chainId: transaction.chainId,
      status: overrides.status ?? "success",
      blockNumber: chain.latestBlock + 10n + BigInt(index),
      timestamp: overrides.timestamp ?? Math.floor(Date.now() / 1000) + 5,
      logs: [...(logs[index] ?? [])],
    });
    return hash;
  });
}

/* -------------------------------------------------------------- fixtures */

export const ACCOUNT = getAddress(EVM_ADDRESS);
export const ACCOUNTS_BASE = [`eip155:8453:${EVM_ADDRESS}`];

export function venue<T = ReturnType<typeof getYieldVenue>>(id: string): NonNullable<T> {
  const found = getYieldVenue(id);
  if (!found) throw new Error(`no venue ${id}`);
  return found as unknown as NonNullable<T>;
}

export function tokenAddress(network: NetworkKey, symbol: string): string {
  const asset = findAssetBySymbol(network, symbol);
  if (!asset?.address) throw new Error(`no ${symbol} on ${network}`);
  return asset.address;
}

export { resolveAsset };
