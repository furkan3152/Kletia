/**
 * Offline chain doubles for the custom contract tests (BYOC): a JSON-RPC
 * router over `fetch`, a small EVM world (ERC-20 tokens with a configurable
 * balance slot, an ERC-4626 style vault with switchable misbehaviour) that
 * answers eth_call, multicall, eth_simulateV1 (state overrides, traced native
 * transfers), code / storage / proof reads and landed receipts, plus Solana
 * RPC handlers. Any request nobody handles fails the test loudly.
 */
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  erc20Abi,
  getAddress,
  keccak256,
  multicall3Abi,
  pad,
  parseAbi,
  toHex,
  type Abi,
  type Hex,
} from "viem";
import { contractDefinitionHash, validateContractDefinition, type ContractDefinition, type ContractVerification, type EvmContractPins, type SolanaProgramPin } from "@kletia/core";
import { configureContractDirectory, type ActionTransport, type ContractDirectory, type ContractPhrase, type RegisteredContract } from "../contracts/directory.js";
import { resetBalanceSlots } from "../contracts/balanceSlots.js";
import { resetPinCache } from "../contracts/pins.js";
import { resetSimulationEndpoints } from "../contracts/simulationRpc.js";
import { resetProgramPinCache } from "../contracts/solanaActions.js";

/* ------------------------------------------------------------- router */

export class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: string) {
    super(message);
  }
}

export type RpcHandler = (params: unknown[], url: string) => unknown;

export interface RpcRouter {
  readonly handlers: Map<string, RpcHandler>;
  /** Raw response bodies by method (Solana fixtures with integers beyond 2^53). */
  readonly raw: Map<string, (params: unknown[], url: string) => string | null>;
  readonly calls: { readonly url: string; readonly method: string; readonly params: unknown[] }[];
  readonly unknown: string[];
  restore(): void;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, (_key, value: unknown) => (typeof value === "bigint" ? toHex(value) : value)), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function installRpcRouter(): RpcRouter {
  const original = globalThis.fetch;
  const router: RpcRouter = {
    handlers: new Map(),
    raw: new Map(),
    calls: [],
    unknown: [],
    restore: () => {
      globalThis.fetch = original;
    },
  };
  const answer = (request: { id: unknown; method: string; params?: unknown[] }, url: string): string => {
    const params = request.params ?? [];
    router.calls.push({ url, method: request.method, params });
    const raw = router.raw.get(request.method)?.(params, url);
    if (raw !== null && raw !== undefined) return raw.replace(/"id":\s*\d+/u, `"id":${JSON.stringify(request.id)}`);
    const handler = router.handlers.get(request.method);
    if (!handler) {
      router.unknown.push(`${request.method} @ ${url}`);
      return JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `unmocked ${request.method}` } });
    }
    try {
      const result = handler(params, url);
      return JSON.stringify({ jsonrpc: "2.0", id: request.id, result }, (_key, value: unknown) => (typeof value === "bigint" ? toHex(value) : value));
    } catch (error) {
      if (error instanceof RpcError) {
        return JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: error.code, message: error.message, ...(error.data ? { data: error.data } : {}) } });
      }
      router.unknown.push(`${request.method}: ${(error as Error).message}`);
      return JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: (error as Error).message } });
    }
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const bodyText = typeof init?.body === "string" ? init.body : "";
    let payload: unknown;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      router.unknown.push(`non-JSON-RPC ${url}`);
      return json({ message: "unmocked" }, 500);
    }
    if (Array.isArray(payload)) {
      const parts = payload.map((entry) => answer(entry as { id: unknown; method: string; params?: unknown[] }, url));
      return new Response(`[${parts.join(",")}]`, { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(answer(payload as { id: unknown; method: string; params?: unknown[] }, url), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return router;
}

/* ------------------------------------------------------------ EVM world */

export const USER = "0x4f183e308f24c81c05303821AD025812fBFd807D";
export const OTHER = "0x1111111111111111111111111111111111111111";
export const VAULT = "0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183";
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const OTHER_TOKEN = "0x2222222222222222222222222222222222222222";
export const NATIVE_EMITTER = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";

export const VAULT_ABI = parseAbi([
  "function deposit(uint256 assets,address receiver) returns (uint256 shares)",
  "function balanceOf(address account) view returns (uint256)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function supportsInterface(bytes4 id) view returns (bool)",
  "event Deposit(address indexed sender,address indexed owner,uint256 assets,uint256 shares)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);

export interface TokenConfig {
  readonly symbol: string;
  readonly decimals: number;
  /** Balance mapping slot and layout (USDC: 9, solidity). */
  readonly slot: number;
  readonly layout: "solidity" | "vyper";
}

export interface LogEntry {
  readonly address: string;
  readonly topics: string[];
  readonly data: string;
}

/** Vault misbehaviour switches (each breaks one refusal rule). */
export interface VaultBehaviour {
  /** Assets pulled per deposit = assets + extraPull. */
  extraPull: bigint;
  /** Also moves this many OTHER_TOKEN units out of the depositor (needs no allowance in the mock). */
  stealOther: bigint;
  /** Shares minted per asset unit (numerator / 1e6 for 6-decimal assets). */
  sharesPerAsset: bigint;
  /** Mint no shares. */
  noShares: boolean;
  /** Emit the Deposit event with this owner instead of the receiver. */
  depositOwner: string | null;
  /** Revert every deposit with this message. */
  revert: string | null;
  /** Credit shares without a Transfer event. */
  silentMint: boolean;
}

export interface EvmWorld {
  readonly tokens: Map<string, TokenConfig>;
  readonly balances: Map<string, bigint>;
  readonly allowances: Map<string, bigint>;
  readonly native: Map<string, bigint>;
  readonly code: Map<string, string>;
  readonly storage: Map<string, string>;
  readonly vault: VaultBehaviour;
  blockNumber: bigint;
  timestamp: number;
  gasPrice: bigint;
  proofs: boolean;
  /** Simulation URLs that answer with an RPC error / fail at transport level. */
  readonly simulateErrors: Set<string>;
  simulateCount: number;
  /** Landed transactions by hash (lower case). */
  readonly landed: Map<string, { tx: Record<string, unknown>; receipt: Record<string, unknown>; block: bigint; timestamp: number }>;
  /** Code / storage per block override for pins-at-block reads: `${block}:${address}`. */
  readonly codeAt: Map<string, string>;
}

const key = (...parts: string[]) => parts.map((part) => part.toLowerCase()).join(":");

export function storageKey(owner: string, token: TokenConfig): string {
  return token.layout === "solidity"
    ? keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [getAddress(owner), BigInt(token.slot)])).toLowerCase()
    : keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }], [BigInt(token.slot), getAddress(owner)])).toLowerCase();
}

interface Overrides {
  readonly stateDiff: Map<string, Map<string, bigint>>;
}

interface ExecState {
  readonly balances: Map<string, bigint>;
  readonly allowances: Map<string, bigint>;
  readonly native: Map<string, bigint>;
  readonly overrides: Overrides;
}

function balanceOf(world: EvmWorld, state: ExecState, token: string, owner: string): bigint {
  const config = world.tokens.get(token.toLowerCase());
  const id = key(token, owner);
  if (state.balances.has(id)) return state.balances.get(id) as bigint;
  if (config) {
    const diff = state.overrides.stateDiff.get(token.toLowerCase())?.get(storageKey(owner, config));
    if (diff !== undefined) return diff;
  }
  return world.balances.get(id) ?? 0n;
}

function setBalance(state: ExecState, token: string, owner: string, value: bigint): void {
  state.balances.set(key(token, owner), value);
}

function allowanceOf(world: EvmWorld, state: ExecState, token: string, owner: string, spender: string): bigint {
  const id = key(token, owner, spender);
  return state.allowances.get(id) ?? world.allowances.get(id) ?? 0n;
}

function eventLog(address: string, abi: Abi, eventName: string, args: Record<string, unknown>): LogEntry {
  const event = abi.find((item) => item.type === "event" && item.name === eventName);
  if (!event || event.type !== "event") throw new Error(`no event ${eventName}`);
  const indexed = Object.fromEntries(event.inputs.filter((input) => input.indexed).map((input) => [input.name, args[input.name as string]]));
  const topics = encodeEventTopics({ abi: [event], eventName, args: indexed } as never) as string[];
  const rest = event.inputs.filter((input) => !input.indexed);
  return { address: address.toLowerCase(), topics, data: encodeAbiParameters(rest, rest.map((input) => args[input.name as string])) };
}

export function transferLog(token: string, from: string, to: string, value: bigint): LogEntry {
  return eventLog(token, erc20Abi as unknown as Abi, "Transfer", { from, to, value });
}

export function approvalLog(token: string, owner: string, spender: string, value: bigint): LogEntry {
  return eventLog(token, erc20Abi as unknown as Abi, "Approval", { owner, spender, value });
}

export function depositLog(vault: string, sender: string, owner: string, assets: bigint, shares: bigint): LogEntry {
  return eventLog(vault, VAULT_ABI as unknown as Abi, "Deposit", { sender, owner, assets, shares });
}

class Revert extends Error {}

interface CallResult {
  readonly status: "0x1" | "0x0";
  readonly returnData: string;
  readonly logs: LogEntry[];
  readonly gasUsed: bigint;
  readonly error?: { code: number; message: string; data: string };
}

function errorData(message: string): string {
  const encoded = encodeAbiParameters([{ type: "string" }], [message]);
  return `0x08c379a0${encoded.slice(2)}`;
}

/** Executes one call against the world (state changes go to `state`). */
export function execute(world: EvmWorld, state: ExecState, call: { from: string; to: string; data: string; value?: bigint }): CallResult {
  const logs: LogEntry[] = [];
  const to = call.to.toLowerCase();
  const from = call.from.toLowerCase();
  const value = call.value ?? 0n;
  try {
    if (value > 0n) {
      const balance = state.native.get(from) ?? world.native.get(from) ?? 0n;
      if (balance < value) throw new Revert("insufficient funds for value");
      state.native.set(from, balance - value);
      state.native.set(to, (state.native.get(to) ?? world.native.get(to) ?? 0n) + value);
      logs.push({ address: NATIVE_EMITTER, topics: transferLog(NATIVE_EMITTER, from, to, value).topics, data: pad(toHex(value)) });
    }
    if (call.data === "0x" || call.data === "") return { status: "0x1", returnData: "0x", logs, gasUsed: 21_000n };
    const token = world.tokens.get(to);
    if (token) {
      const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data as Hex });
      const args = decoded.args as readonly unknown[];
      const result = (functionName: string, output: unknown) => encodeFunctionResult({ abi: erc20Abi, functionName, result: output } as never);
      switch (decoded.functionName) {
        case "balanceOf":
          return { status: "0x1", returnData: result("balanceOf", balanceOf(world, state, to, args[0] as string)), logs, gasUsed: 30_000n };
        case "allowance":
          return { status: "0x1", returnData: result("allowance", allowanceOf(world, state, to, args[0] as string, args[1] as string)), logs, gasUsed: 31_000n };
        case "symbol":
          return { status: "0x1", returnData: result("symbol", token.symbol), logs, gasUsed: 25_000n };
        case "name":
          return { status: "0x1", returnData: result("name", token.symbol), logs, gasUsed: 25_000n };
        case "decimals":
          return { status: "0x1", returnData: result("decimals", token.decimals), logs, gasUsed: 25_000n };
        case "approve": {
          const [spender, amount] = args as [string, bigint];
          state.allowances.set(key(to, from, spender), amount);
          logs.push(approvalLog(to, from, spender, amount));
          return { status: "0x1", returnData: result("approve", true), logs, gasUsed: 55_437n };
        }
        default:
          throw new Revert(`unsupported token call ${decoded.functionName}`);
      }
    }
    if (to === VAULT.toLowerCase()) {
      const decoded = decodeFunctionData({ abi: VAULT_ABI, data: call.data as Hex });
      const args = decoded.args as readonly unknown[];
      const result = (functionName: string, output: unknown) => encodeFunctionResult({ abi: VAULT_ABI, functionName, result: output } as never);
      switch (decoded.functionName) {
        case "balanceOf":
          return { status: "0x1", returnData: result("balanceOf", balanceOf(world, state, to, args[0] as string)), logs, gasUsed: 24_301n };
        case "symbol":
          return { status: "0x1", returnData: result("symbol", "steakUSDC"), logs, gasUsed: 25_000n };
        case "name":
          return { status: "0x1", returnData: result("name", "Steakhouse USDC"), logs, gasUsed: 25_000n };
        case "decimals":
          return { status: "0x1", returnData: result("decimals", 18), logs, gasUsed: 25_000n };
        case "supportsInterface":
          throw new Revert("no ERC-165");
        case "deposit": {
          const behaviour = world.vault;
          if (behaviour.revert) throw new Revert(behaviour.revert);
          const [assets, receiver] = args as [bigint, string];
          const pulled = assets + behaviour.extraPull;
          const allowance = allowanceOf(world, state, USDC_BASE, from, VAULT);
          if (allowance < pulled) throw new Revert("ERC20: transfer amount exceeds allowance");
          const balance = balanceOf(world, state, USDC_BASE, from);
          if (balance < pulled) throw new Revert("ERC20: transfer amount exceeds balance");
          state.allowances.set(key(USDC_BASE, from, VAULT), allowance - pulled);
          setBalance(state, USDC_BASE, from, balance - pulled);
          setBalance(state, USDC_BASE, VAULT, balanceOf(world, state, USDC_BASE, VAULT) + pulled);
          logs.push(transferLog(USDC_BASE, from, VAULT, pulled));
          if (behaviour.stealOther > 0n) {
            setBalance(state, OTHER_TOKEN, from, balanceOf(world, state, OTHER_TOKEN, from) - behaviour.stealOther);
            logs.push(transferLog(OTHER_TOKEN, from, VAULT, behaviour.stealOther));
          }
          const shares = behaviour.noShares ? 0n : (assets * behaviour.sharesPerAsset);
          if (shares > 0n) {
            setBalance(state, VAULT, receiver, balanceOf(world, state, VAULT, receiver) + shares);
            if (!behaviour.silentMint) logs.push(transferLog(VAULT, "0x0000000000000000000000000000000000000000", receiver, shares));
          }
          logs.push(depositLog(VAULT, from, behaviour.depositOwner ?? receiver, assets, shares));
          return { status: "0x1", returnData: result("deposit", shares), logs, gasUsed: 379_971n };
        }
        default:
          throw new Revert(`unsupported vault call ${decoded.functionName}`);
      }
    }
    throw new Revert(`no contract at ${to}`);
  } catch (error) {
    if (!(error instanceof Revert)) throw error;
    return { status: "0x0", returnData: "0x", logs: [], gasUsed: 50_000n, error: { code: 3, message: `execution reverted: ${error.message}`, data: errorData(error.message) } };
  }
}

function freshState(overrides?: Overrides): ExecState {
  return { balances: new Map(), allowances: new Map(), native: new Map(), overrides: overrides ?? { stateDiff: new Map() } };
}

function readOverrides(raw: unknown, state: ExecState): void {
  if (typeof raw !== "object" || raw === null) return;
  for (const [address, entry] of Object.entries(raw as Record<string, { balance?: string; stateDiff?: Record<string, string> }>)) {
    if (entry.balance) state.native.set(address.toLowerCase(), BigInt(entry.balance));
    if (entry.stateDiff) {
      const diffs = state.overrides.stateDiff.get(address.toLowerCase()) ?? new Map<string, bigint>();
      for (const [slot, word] of Object.entries(entry.stateDiff)) diffs.set(slot.toLowerCase(), BigInt(word));
      state.overrides.stateDiff.set(address.toLowerCase(), diffs);
    }
  }
}

export interface EvmHarness {
  readonly router: RpcRouter;
  readonly world: EvmWorld;
  /** Lands prepared transactions (executing them against the world) and returns their hashes. */
  land(transactions: readonly { from: string; to: string; data: string; value: string; chainId: number }[], options?: { logs?: (index: number, logs: LogEntry[]) => LogEntry[]; status?: "success" | "reverted" }): string[];
  restore(): void;
}

const PROXY_SLOT_COUNT = 6;

export function installEvmHarness(): EvmHarness {
  const router = installRpcRouter();
  const world: EvmWorld = {
    tokens: new Map([
      [USDC_BASE.toLowerCase(), { symbol: "USDC", decimals: 6, slot: 9, layout: "solidity" as const }],
      [OTHER_TOKEN.toLowerCase(), { symbol: "OTH", decimals: 18, slot: 0, layout: "solidity" as const }],
    ]),
    balances: new Map(),
    allowances: new Map(),
    native: new Map(),
    code: new Map([
      [VAULT.toLowerCase(), "0x6080604052"],
      [USDC_BASE.toLowerCase(), "0x60806040"],
    ]),
    storage: new Map(),
    vault: { extraPull: 0n, stealOther: 0n, sharesPerAsset: 906_050_000_000n, noShares: false, depositOwner: null, revert: null, silentMint: false },
    blockNumber: 52_376_674n,
    timestamp: Math.floor(Date.now() / 1000),
    gasPrice: 1_000_000n,
    proofs: true,
    simulateErrors: new Set(),
    simulateCount: 0,
    landed: new Map(),
    codeAt: new Map(),
  };
  void PROXY_SLOT_COUNT;
  const codeOf = (address: string, block?: string) => {
    if (block && block !== "latest") {
      const at = world.codeAt.get(`${BigInt(block)}:${address.toLowerCase()}`);
      if (at !== undefined) return at;
    }
    return world.code.get(address.toLowerCase()) ?? "0x";
  };
  const ethCall = (tx: { from?: string; to: string; data?: string; input?: string }, state: ExecState): string => {
    const data = tx.data ?? tx.input ?? "0x";
    if (tx.to.toLowerCase() === MULTICALL3 && data.startsWith("0x82ad56cb")) {
      const decoded = decodeFunctionData({ abi: multicall3Abi, data: data as Hex });
      const results = (decoded.args[0] as readonly { target: string; callData: Hex }[]).map((inner) => {
        const result = execute(world, state, { from: tx.from ?? "0x0000000000000000000000000000000000000000", to: inner.target, data: inner.callData });
        return { success: result.status === "0x1", returnData: result.returnData as Hex };
      });
      return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results });
    }
    const result = execute(world, state, { from: tx.from ?? "0x0000000000000000000000000000000000000000", to: tx.to, data });
    if (result.status !== "0x1") throw new RpcError(3, result.error?.message ?? "execution reverted", result.error?.data);
    return result.returnData;
  };
  const chainIdFor = (url: string) => (/arbitrum/u.test(url) ? 42161 : /optimism/u.test(url) ? 10 : /polygon/u.test(url) ? 137 : /ethereum|eth\./u.test(url) ? 1 : 8453);
  const handlers: Record<string, RpcHandler> = {
    eth_chainId: (_params, url) => toHex(chainIdFor(url)),
    eth_blockNumber: () => toHex(world.blockNumber),
    eth_gasPrice: () => toHex(world.gasPrice),
    eth_getBalance: ([address]) => toHex(world.native.get(String(address).toLowerCase()) ?? 0n),
    eth_getCode: ([address, block]) => codeOf(String(address), String(block)),
    eth_getStorageAt: ([address, slot, block]) => {
      const at = block && block !== "latest" ? world.storage.get(`${BigInt(String(block))}:${String(address).toLowerCase()}:${String(slot).toLowerCase()}`) : undefined;
      return at ?? world.storage.get(`${String(address).toLowerCase()}:${String(slot).toLowerCase()}`) ?? `0x${"0".repeat(64)}`;
    },
    eth_getProof: ([address, , block]) => {
      if (!world.proofs) throw new RpcError(-32000, "no state found");
      const code = codeOf(String(address), String(block));
      return { address, codeHash: code === "0x" ? `0x${"0".repeat(64)}` : keccak256(code as Hex), accountProof: [], balance: "0x0", nonce: "0x0", storageHash: `0x${"0".repeat(64)}`, storageProof: [] };
    },
    eth_call: ([tx, , overrides]) => {
      const state = freshState();
      readOverrides(overrides, state);
      return ethCall(tx as { to: string; data?: string; from?: string }, state);
    },
    eth_simulateV1: ([request], url) => {
      world.simulateCount += 1;
      if (world.simulateErrors.has(url)) throw new RpcError(-32601, "the method eth_simulateV1 does not exist/is not available");
      const body = request as { blockStateCalls: { stateOverrides?: unknown; calls: { from: string; to: string; data?: string; value?: string }[] }[] };
      const state = freshState();
      return body.blockStateCalls.map((block, index) => {
        readOverrides(block.stateOverrides, state);
        return {
          number: toHex(world.blockNumber + 1n + BigInt(index)),
          hash: `0x${"ab".repeat(32)}`,
          timestamp: toHex(world.timestamp),
          gasLimit: "0x1c9c380",
          gasUsed: "0x0",
          calls: block.calls.map((call) => {
            const result = execute(world, state, { from: call.from, to: call.to, data: call.data ?? "0x", value: call.value ? BigInt(call.value) : 0n });
            return {
              returnData: result.returnData,
              logs: result.logs.map((log, logIndex) => ({ ...log, logIndex: toHex(logIndex), blockNumber: toHex(world.blockNumber + 1n), transactionHash: `0x${"cd".repeat(32)}` })),
              gasUsed: toHex(result.gasUsed),
              status: result.status,
              ...(result.error ? { error: result.error } : {}),
            };
          }),
        };
      });
    },
    eth_getTransactionByHash: ([hash]) => {
      const entry = world.landed.get(String(hash).toLowerCase());
      return entry ? entry.tx : null;
    },
    eth_getTransactionReceipt: ([hash]) => {
      const entry = world.landed.get(String(hash).toLowerCase());
      return entry ? entry.receipt : null;
    },
    eth_getBlockByNumber: ([tag]) => {
      const number = tag === "latest" ? world.blockNumber : BigInt(String(tag));
      const landed = [...world.landed.values()].find((entry) => entry.block === number);
      return {
        number: toHex(number),
        hash: `0x${"ab".repeat(32)}`,
        parentHash: `0x${"cd".repeat(32)}`,
        timestamp: toHex(landed?.timestamp ?? world.timestamp),
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
    },
  };
  for (const [method, handler] of Object.entries(handlers)) router.handlers.set(method, handler);
  let counter = 0;
  return {
    router,
    world,
    land(transactions, options = {}) {
      return transactions.map((transaction, index) => {
        counter += 1;
        const hash = `0x${(counter + 0x1000).toString(16).padStart(64, "0")}`;
        const block = world.blockNumber + 10n + BigInt(index);
        const state = freshState();
        const result = execute(world, state, { from: transaction.from, to: transaction.to, data: transaction.data, value: BigInt(transaction.value) });
        for (const [id, value] of state.balances) world.balances.set(id, value);
        for (const [id, value] of state.allowances) world.allowances.set(id, value);
        const logs = (options.logs ? options.logs(index, result.logs) : result.logs).filter((log) => log.address !== NATIVE_EMITTER);
        const status = options.status ?? (result.status === "0x1" ? "success" : "reverted");
        const timestamp = Math.floor(Date.now() / 1000) + 5;
        world.landed.set(hash, {
          block,
          timestamp,
          tx: {
            hash, from: transaction.from, to: transaction.to, input: transaction.data, value: toHex(BigInt(transaction.value)), chainId: toHex(transaction.chainId),
            blockNumber: toHex(block), blockHash: `0x${"ab".repeat(32)}`, nonce: "0x1", gas: "0x5208", gasPrice: "0x1", maxFeePerGas: "0x1", maxPriorityFeePerGas: "0x1",
            type: "0x2", transactionIndex: "0x0", v: "0x0", r: `0x${"11".repeat(32)}`, s: `0x${"22".repeat(32)}`, yParity: "0x0", accessList: [],
          },
          receipt: {
            transactionHash: hash, from: transaction.from, to: transaction.to, status: status === "success" ? "0x1" : "0x0", blockNumber: toHex(block),
            blockHash: `0x${"ab".repeat(32)}`, transactionIndex: "0x0", gasUsed: "0x5208", cumulativeGasUsed: "0x5208", effectiveGasPrice: "0x1",
            contractAddress: null, type: "0x2", logsBloom: `0x${"00".repeat(256)}`,
            logs: logs.map((log, logIndex) => ({ ...log, blockNumber: toHex(block), blockHash: `0x${"ab".repeat(32)}`, transactionHash: hash, transactionIndex: "0x0", logIndex: toHex(logIndex), removed: false })),
          },
        });
        return hash;
      });
    },
    restore() {
      router.restore();
    },
  };
}

/* ------------------------------------------------------- registrations */

export const OWNER_KEY = "key_owner";
export const SIBLING_KEY = "key_sibling";
export const STRANGER_KEY = "key_stranger";

/** The design's §3.1 registration body (Steakhouse USDC on Base as "Acme vault"). */
export function vaultDefinitionBody(overrides: Record<string, unknown> = {}, action: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    vm: "evm",
    network: "base",
    address: VAULT,
    integrator: { name: "Acme Yield", website: "https://acme.example" },
    abi: [
      { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ name: "assets", type: "uint256" }, { name: "receiver", type: "address" }], outputs: [{ name: "shares", type: "uint256" }] },
      {
        type: "event",
        name: "Deposit",
        anonymous: false,
        inputs: [
          { name: "sender", type: "address", indexed: true },
          { name: "owner", type: "address", indexed: true },
          { name: "assets", type: "uint256", indexed: false },
          { name: "shares", type: "uint256", indexed: false },
        ],
      },
    ],
    actions: [{
      id: "deposit",
      label: "Deposit into Acme USDC vault",
      function: "deposit(uint256,address)",
      args: ["$amount", "$account"],
      input: { token: "USDC", approval: { spender: "$self" } },
      output: { token: "$self", toleranceBps: 10 },
      events: [{ event: "Deposit", emitter: "$self", where: { owner: "$account", assets: "$amount" }, output: "shares" }],
      phrases: { verbs: ["deposit", "supply"], aliases: ["acme vault", "acme"] },
      limits: { maxAmount: "25000" },
      ...action,
    }],
    ...overrides,
  };
}

export const PLAIN_PINS = (code = "0x6080604052"): EvmContractPins => ({
  codeHash: keccak256(code as Hex),
  codeSize: (code.length - 2) / 2,
  proxy: null,
  addresses: [],
  blockNumber: "52376674",
  checkedAt: "2026-10-09T10:00:00.000Z",
});

export interface Registration {
  id: string;
  ownerKeyId: string;
  projectId: string | null;
  status: RegisteredContract["status"];
  activeRevision: number | null;
  activatesAt: string | null;
  definition: ContractDefinition;
  definitionHash: string;
  pins: EvmContractPins | readonly SolanaProgramPin[];
  verification: ContractVerification;
  createdAt: string;
  visibility: "private" | "project";
}

export async function registrationOf(body: unknown, options: Partial<Registration> = {}): Promise<Registration> {
  const validated = validateContractDefinition(body);
  if (!validated.ok) throw new Error(`invalid test definition: ${JSON.stringify(validated.issues)}`);
  return {
    id: "ct_0123456789abcdef01234567",
    ownerKeyId: OWNER_KEY,
    projectId: "proj_1",
    status: "active",
    activeRevision: 1,
    activatesAt: null,
    definition: validated.value,
    definitionHash: await contractDefinitionHash(validated.value),
    pins: validated.value.vm === "evm" ? PLAIN_PINS() : [],
    verification: { source: { status: "exact_match", provider: "sourcify", checkedAt: "2026-10-09T10:00:00.000Z" }, domain: { verified: true, checkedAt: "2026-10-09T10:00:00.000Z" } },
    createdAt: "2026-10-09T10:00:00.000Z",
    visibility: (validated.value.visibility as "private" | "project") ?? "private",
    ...options,
  };
}

/** An in-memory directory with the scoping rules of the design (owner, or same project with visibility project). */
export class MemoryDirectory implements ContractDirectory {
  readonly registrations = new Map<string, Registration>();
  readonly anomalies: { id: string; reason: string; detail: string }[] = [];
  readonly spends: { owner: string; usd: number }[] = [];
  readonly projects = new Map<string, string>([[OWNER_KEY, "proj_1"], [SIBLING_KEY, "proj_1"], [STRANGER_KEY, "proj_2"]]);
  spendCap = Number.POSITIVE_INFINITY;
  deny = new Set<string>();
  actionTransport: ActionTransport = {
    get: async () => {
      throw new Error("no transport");
    },
    post: async () => {
      throw new Error("no transport");
    },
  };

  add(registration: Registration): Registration {
    this.registrations.set(registration.id, registration);
    return registration;
  }

  private canUse(registration: Registration, ownerKeyId: string): boolean {
    if (registration.ownerKeyId === ownerKeyId) return true;
    return registration.visibility === "project" && registration.projectId !== null && this.projects.get(ownerKeyId) === registration.projectId;
  }

  async resolve(ownerKeyId: string, reference: string, network?: string): Promise<RegisteredContract | null> {
    for (const registration of this.registrations.values()) {
      if (!this.canUse(registration, ownerKeyId)) continue;
      if (registration.id === reference) return registration;
      const aliases = registration.definition.actions.flatMap((action) => action.phrases?.aliases ?? []);
      if (aliases.includes(reference) && (!network || registration.definition.network === network)) return registration;
    }
    return null;
  }

  async phrases(ownerKeyId: string): Promise<readonly ContractPhrase[]> {
    return [...this.registrations.values()]
      .filter((registration) => this.canUse(registration, ownerKeyId))
      .flatMap((registration) => registration.definition.actions.filter((action) => action.phrases).map((action) => ({
        contract: registration.id,
        entry: action.id,
        network: registration.definition.network,
        vm: registration.definition.vm,
        verbs: action.phrases?.verbs ?? [],
        aliases: action.phrases?.aliases ?? [],
        spends: action.input !== undefined,
      })));
  }

  async current(id: string): Promise<RegisteredContract | null> {
    return this.registrations.get(id) ?? null;
  }

  async usableBy(id: string, ownerKeyId: string): Promise<boolean> {
    const registration = this.registrations.get(id);
    return registration ? this.canUse(registration, ownerKeyId) : false;
  }

  denied(network: string, target: string): string | null {
    return this.deny.has(`${network}:${target.toLowerCase()}`) ? "on the test deny list" : null;
  }

  async reportAnomaly(id: string, reason: string, detail: string): Promise<void> {
    this.anomalies.push({ id, reason, detail });
    const registration = this.registrations.get(id);
    if (registration) registration.status = "suspended";
  }

  async recordSpend(owner: string, usd: number): Promise<void> {
    const total = this.spends.filter((entry) => entry.owner === owner).reduce((sum, entry) => sum + entry.usd, 0) + usd;
    if (total > this.spendCap) {
      const { PlatformError } = await import("../../errors.js");
      throw new PlatformError("CONTRACT_SPEND_LIMIT", "Daily cap reached.", 422);
    }
    this.spends.push({ owner, usd });
  }
}

/** Fresh directory installed in the engine, every contract cache cleared, simulation endpoints pointed at test URLs. */
export function installDirectory(): MemoryDirectory {
  const directory = new MemoryDirectory();
  configureContractDirectory(directory);
  resetContractCaches();
  return directory;
}

export const SIM_URLS = ["https://sim-a.test", "https://sim-b.test"];

export function resetContractCaches(): void {
  resetSimulationEndpoints();
  resetBalanceSlots();
  resetPinCache();
  resetProgramPinCache();
  for (const network of ["BASE", "ARBITRUM", "ETHEREUM", "OPTIMISM", "POLYGON", "ARC", "ARBITRUM_SEPOLIA"]) {
    process.env[`KLETIA_SIMULATION_RPC_URLS_${network}`] = SIM_URLS.join(",");
  }
}

export { erc20Abi };
