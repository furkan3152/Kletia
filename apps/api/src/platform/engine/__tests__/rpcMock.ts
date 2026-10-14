/**
 * In-process `fetch` double for chain and provider reads: EVM JSON-RPC
 * (viem), Solana JSON-RPC (@solana/kit) and the Relay HTTP API. Tests
 * register canned chain state; any request the mock does not know fails the
 * test loudly instead of reaching the network.
 *
 * Also the oracle seam of the swap price guards (`installSwapOracle`):
 * Chainlink answers by feed, every L2 sequencer up, and wstETH's
 * stEthPerToken(), served through the policy pricing transport (never fetch).
 */
import { encodeFunctionResult, parseAbi, type Hex } from "viem";
import type { IntentStep } from "@kletia/core";
import { SEQUENCER_UPTIME_FEEDS, WSTETH_ETHEREUM, type ChainlinkFeed } from "../policy/feeds.js";
import { configurePolicyPricing } from "../policy/pricing.js";

export interface EvmTxFixture {
  readonly hash: string;
  readonly from: string;
  readonly to: string | null;
  readonly input: string;
  readonly value: bigint;
  readonly chainId: number;
  readonly status: "success" | "reverted";
  readonly blockNumber: bigint;
  /** Unix seconds; null makes the block read fail. */
  readonly timestamp: number | null;
  readonly logs?: readonly { address: string; topics: readonly string[]; data: string }[];
}

export interface TokenBalanceFixture {
  readonly accountIndex: number;
  readonly mint: string;
  readonly owner: string;
  readonly amount: string;
}

export interface SolanaTxFixture {
  readonly signature: string;
  readonly confirmationStatus: "processed" | "confirmed" | "finalized";
  readonly err?: unknown;
  /** Omit to make getTransaction return null (body not readable). */
  readonly body?: {
    readonly accountKeys: readonly string[];
    readonly programIndexes: readonly number[];
    readonly blockTime: number;
    readonly fee: number;
    readonly preBalances: readonly number[];
    readonly postBalances: readonly number[];
    readonly preTokenBalances?: readonly TokenBalanceFixture[];
    readonly postTokenBalances?: readonly TokenBalanceFixture[];
  };
}

export interface RpcMock {
  readonly evm: Map<string, EvmTxFixture>;
  /** Native balances by `${address lowercase}@${block number}` (eth_getBalance; unknown entries fail the read). */
  readonly evmBalances: Map<string, bigint>;
  readonly solana: Map<string, SolanaTxFixture>;
  /** Relay `/requests/v3?depositTxHash=` (keyed; and legacy `/requests/v2?hash=`) responses by deposit hash. */
  readonly relayRequests: Map<string, unknown[]>;
  /** Relay `/intents/status/v3` (and legacy v2) responses by request id. */
  readonly relayStatus: Map<string, unknown>;
  /** Relay `/quote` response factory. */
  relayQuote: ((body: Record<string, unknown>) => unknown) | null;
  /** `simulateTransaction` error (null simulates successfully). */
  simulationError: unknown;
  /** `eth_gasPrice` answer (wei); null makes the read fail. */
  gasPrice: bigint | null;
  /** Solana `getMinimumBalanceForRentExemption` answers by data size (unknown sizes fail the read). */
  readonly solanaRent: Map<number, number>;
  /** Solana `getBalance` lamports by address (unknown addresses fail the read). */
  readonly solanaLamports: Map<string, number>;
  /** Solana `getTokenAccountsByOwner` token amounts by `${owner}:${mint}` (unknown pairs answer no accounts). */
  readonly solanaTokenAccounts: Map<string, readonly string[]>;
  readonly unknown: string[];
  restore(): void;
}

const hex = (value: bigint | number) => `0x${value.toString(16)}`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function evmResult(mock: RpcMock, method: string, params: unknown[]): unknown {
  const key = typeof params[0] === "string" ? params[0].toLowerCase() : "";
  switch (method) {
    case "eth_chainId":
      return "0xa4b1";
    case "eth_getTransactionByHash": {
      const tx = mock.evm.get(key);
      if (!tx) return null;
      return {
        hash: tx.hash,
        from: tx.from,
        to: tx.to,
        input: tx.input,
        value: hex(tx.value),
        chainId: hex(tx.chainId),
        blockNumber: hex(tx.blockNumber),
        blockHash: `0x${"ab".repeat(32)}`,
        nonce: "0x1",
        gas: "0x5208",
        gasPrice: "0x1",
        maxFeePerGas: "0x1",
        maxPriorityFeePerGas: "0x1",
        type: "0x2",
        transactionIndex: "0x0",
        v: "0x0",
        r: `0x${"11".repeat(32)}`,
        s: `0x${"22".repeat(32)}`,
        yParity: "0x0",
        accessList: [],
      };
    }
    case "eth_getTransactionReceipt": {
      const tx = mock.evm.get(key);
      if (!tx) return null;
      return {
        transactionHash: tx.hash,
        from: tx.from,
        to: tx.to,
        status: tx.status === "success" ? "0x1" : "0x0",
        blockNumber: hex(tx.blockNumber),
        blockHash: `0x${"ab".repeat(32)}`,
        transactionIndex: "0x0",
        gasUsed: "0x5208",
        cumulativeGasUsed: "0x5208",
        effectiveGasPrice: "0x1",
        contractAddress: null,
        type: "0x2",
        logsBloom: `0x${"00".repeat(256)}`,
        logs: (tx.logs ?? []).map((log, index) => ({
          ...log,
          blockNumber: hex(tx.blockNumber),
          blockHash: `0x${"ab".repeat(32)}`,
          transactionHash: tx.hash,
          transactionIndex: "0x0",
          logIndex: hex(index),
          removed: false,
        })),
      };
    }
    case "eth_getBlockByNumber": {
      const number = BigInt(String(params[0]));
      const tx = [...mock.evm.values()].find((entry) => entry.blockNumber === number);
      if (!tx || tx.timestamp === null) throw new Error("block unavailable");
      return {
        number: hex(number),
        hash: `0x${"ab".repeat(32)}`,
        parentHash: `0x${"cd".repeat(32)}`,
        timestamp: hex(tx.timestamp),
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
    case "eth_gasPrice":
      if (mock.gasPrice === null) throw new Error("gas price unavailable");
      return hex(mock.gasPrice);
    case "eth_getBalance": {
      const balance = mock.evmBalances.get(`${key}@${BigInt(String(params[1]))}`);
      if (balance === undefined) throw new Error("balance unavailable");
      return hex(balance);
    }
    default:
      throw new Error(`unmocked EVM method ${method}`);
  }
}

function tokenBalances(entries: readonly TokenBalanceFixture[] | undefined) {
  return (entries ?? []).map((entry) => ({
    accountIndex: entry.accountIndex,
    mint: entry.mint,
    owner: entry.owner,
    programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    uiTokenAmount: { amount: entry.amount, decimals: 6, uiAmount: null, uiAmountString: entry.amount },
  }));
}

function solanaResult(mock: RpcMock, method: string, params: unknown[]): unknown {
  switch (method) {
    case "getSignatureStatuses": {
      const signatures = params[0] as string[];
      return {
        context: { slot: 100 },
        value: signatures.map((signature) => {
          const tx = mock.solana.get(signature);
          if (!tx) return null;
          return {
            slot: 99,
            confirmations: null,
            err: tx.err ?? null,
            status: tx.err ? { Err: tx.err } : { Ok: null },
            confirmationStatus: tx.confirmationStatus,
          };
        }),
      };
    }
    case "getTransaction": {
      const tx = mock.solana.get(params[0] as string);
      if (!tx?.body) return null;
      const body = tx.body;
      return {
        slot: 99,
        blockTime: body.blockTime,
        version: 0,
        meta: {
          err: tx.err ?? null,
          status: tx.err ? { Err: tx.err } : { Ok: null },
          fee: body.fee,
          preBalances: body.preBalances,
          postBalances: body.postBalances,
          preTokenBalances: tokenBalances(body.preTokenBalances),
          postTokenBalances: tokenBalances(body.postTokenBalances),
          loadedAddresses: { writable: [], readonly: [] },
          innerInstructions: [],
          logMessages: [],
          rewards: [],
          computeUnitsConsumed: 1000,
        },
        transaction: {
          signatures: [tx.signature],
          message: {
            accountKeys: body.accountKeys,
            header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
            recentBlockhash: "11111111111111111111111111111111",
            instructions: body.programIndexes.map((programIdIndex) => ({ programIdIndex, accounts: [], data: "", stackHeight: null })),
          },
        },
      };
    }
    case "simulateTransaction":
      return { context: { slot: 100 }, value: { err: mock.simulationError, logs: [], accounts: null, unitsConsumed: 1000, returnData: null } };
    case "getMinimumBalanceForRentExemption": {
      const lamports = mock.solanaRent.get(Number(params[0]));
      if (lamports === undefined) throw new Error("rent unavailable");
      return lamports;
    }
    case "getBalance": {
      const lamports = mock.solanaLamports.get(String(params[0]));
      if (lamports === undefined) throw new Error("balance unavailable");
      return { context: { slot: 100 }, value: lamports };
    }
    case "getTokenAccountsByOwner": {
      const owner = String(params[0]);
      const mint = String((params[1] as { mint?: unknown } | undefined)?.mint ?? "");
      const amounts = mock.solanaTokenAccounts.get(`${owner}:${mint}`) ?? [];
      return {
        context: { slot: 100 },
        value: amounts.map((amount, index) => ({
          pubkey: `${index + 1}`.padStart(32, "1"),
          account: { data: { parsed: { info: { mint, owner, tokenAmount: { amount } } }, program: "spl-token" }, executable: false, lamports: 2_039_280, owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
        })),
      };
    }
    default:
      throw new Error(`unmocked Solana method ${method}`);
  }
}

export function installRpcMock(): RpcMock {
  const original = globalThis.fetch;
  const mock: RpcMock = {
    evm: new Map(),
    evmBalances: new Map(),
    solana: new Map(),
    relayRequests: new Map(),
    relayStatus: new Map(),
    relayQuote: null,
    simulationError: null,
    gasPrice: null,
    solanaRent: new Map(),
    solanaLamports: new Map(),
    solanaTokenAccounts: new Map(),
    unknown: [],
    restore: () => {
      globalThis.fetch = original;
    },
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const bodyText = typeof init?.body === "string" ? init.body : init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : "";
    if (url.includes("relay.link")) {
      const parsed = new URL(url);
      if (parsed.pathname === "/requests/v2") {
        return json({ requests: mock.relayRequests.get(parsed.searchParams.get("hash") ?? "") ?? [] });
      }
      if (parsed.pathname === "/intents/status/v2") {
        const status = mock.relayStatus.get(parsed.searchParams.get("requestId") ?? "");
        return status ? json(status) : json({ status: "waiting" });
      }
      if (parsed.pathname === "/requests/v3") {
        // Like the live API: v3 refuses requests without an API key.
        if (!new Headers(init?.headers).get("x-api-key")) {
          return json({ code: "FST_ERR_VALIDATION", message: "headers must have required property 'x-api-key'" }, 400);
        }
        return json({ requests: mock.relayRequests.get(parsed.searchParams.get("depositTxHash") ?? "") ?? [] });
      }
      if (parsed.pathname === "/intents/status/v3") {
        const status = mock.relayStatus.get(parsed.searchParams.get("requestId") ?? "");
        return status ? json(status) : json({ status: "unknown" });
      }
      if (parsed.pathname === "/quote" && mock.relayQuote) {
        return json(mock.relayQuote(JSON.parse(bodyText) as Record<string, unknown>));
      }
      mock.unknown.push(url);
      return json({ message: "unmocked" }, 500);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      mock.unknown.push(url);
      return json({ message: "unmocked" }, 500);
    }
    const answer = (request: { id: unknown; method: string; params?: unknown[] }) => {
      try {
        const result = request.method.startsWith("eth_")
          ? evmResult(mock, request.method, request.params ?? [])
          : solanaResult(mock, request.method, request.params ?? []);
        return { jsonrpc: "2.0", id: request.id, result };
      } catch (error) {
        mock.unknown.push(`${request.method}: ${(error as Error).message}`);
        return { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: (error as Error).message } };
      }
    };
    return json(Array.isArray(payload) ? payload.map(answer) : answer(payload as { id: unknown; method: string; params?: unknown[] }));
  }) as typeof fetch;
  return mock;
}

/** Minimal prepared step for verification tests. */
export function preparedStep(overrides: Partial<IntentStep> & Pick<IntentStep, "network" | "chain" | "account">): IntentStep {
  return {
    id: "s1",
    index: 0,
    kind: "transfer",
    title: "test step",
    protocol: "erc20-transfer",
    mode: "wallet",
    dependsOn: [],
    status: "submitted",
    evidence: [],
    ...overrides,
  };
}

/* ------------------------------------------------------------ swap oracle */

const ORACLE_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function stEthPerToken() view returns (uint256)",
]);

export interface SwapOracle {
  /** USD (or ETH ratio) answer per feed, keyed `${network}:${address lowercase}`; delete a key to make the feed unreadable. */
  readonly answers: Map<string, number>;
  /** wstETH.stEthPerToken() (18 decimals). */
  stEthPerToken: bigint;
  /** Unix ms of the pricer's clock. */
  now: number;
  set(feed: ChainlinkFeed, value: number): void;
  restore(): void;
}

/**
 * Prices the swap guard reads: each listed Chainlink feed answers `value`
 * (8 decimals, fresh), every L2 sequencer reports up for two hours, Jupiter
 * and the Solana slot are unavailable. Restored with `restore()`.
 */
export function installSwapOracle(feeds: readonly (readonly [ChainlinkFeed, number])[] = []): SwapOracle {
  const key = (feed: { readonly network: string; readonly address: string }) => `${feed.network}:${feed.address.toLowerCase()}`;
  const oracle: SwapOracle = {
    answers: new Map(feeds.map(([feed, value]) => [key(feed), value])),
    stEthPerToken: 1_200_000_000_000_000_000n,
    now: Date.now(),
    set(feed, value) {
      oracle.answers.set(key(feed), value);
    },
    restore() {
      configurePolicyPricing(null);
    },
  };
  const sequencers = new Set(Object.values(SEQUENCER_UPTIME_FEEDS).map((feed) => key(feed)));
  configurePolicyPricing({
    ethCall: async (network, to, data) => {
      const id = `${network}:${to.toLowerCase()}`;
      const seconds = BigInt(Math.floor(oracle.now / 1000));
      if (id === `ethereum:${WSTETH_ETHEREUM.toLowerCase()}`) {
        return encodeFunctionResult({ abi: ORACLE_ABI, functionName: "stEthPerToken", result: oracle.stEthPerToken }) as Hex;
      }
      if (sequencers.has(id)) {
        return encodeFunctionResult({ abi: ORACLE_ABI, functionName: "latestRoundData", result: [1n, 0n, seconds - 7_200n, seconds - 7_200n, 1n] }) as Hex;
      }
      const value = oracle.answers.get(id);
      if (value === undefined) return null;
      if (data.startsWith("0x313ce567")) return encodeFunctionResult({ abi: ORACLE_ABI, functionName: "decimals", result: 8 }) as Hex;
      const answer = BigInt(Math.round(value * 1e8));
      return encodeFunctionResult({ abi: ORACLE_ABI, functionName: "latestRoundData", result: [1n, answer, seconds - 30n, seconds - 30n, 1n] }) as Hex;
    },
    jupiterPrices: async () => ({}),
    solanaSlot: async () => {
      throw new Error("no Solana slot in swap tests");
    },
    now: () => oracle.now,
  });
  return oracle;
}
