/**
 * Wallet facts (holdings.ts): read budgets, the overall deadline, the 15 s
 * cache, unknown is never zero, preview accounts are never read, only the
 * request's own accounts are read, and the default RPC readers through an
 * in-process fetch double.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { PREVIEW_ACCOUNT_IDS, SOLANA_USDC_MINT, type AccountId, type NetworkKey } from "@kletia/core";
import {
  configureHoldingsReaders,
  knownAmount,
  MAX_BALANCE_READS,
  readFacts,
  resetHoldingsCaches,
  type FactNeed,
  type HoldingsReaders,
} from "../holdings.js";
import { installRpcMock } from "./rpcMock.js";
import { ACCOUNTS, EVM_ADDRESS, OTHER_EVM_ADDRESS, SOL_ADDRESS } from "./helpers.js";

const accounts = ACCOUNTS as AccountId[];

interface Spy {
  readonly readers: Partial<HoldingsReaders>;
  readonly calls: string[];
}

function spy(overrides: Partial<HoldingsReaders> = {}): Spy {
  const calls: string[] = [];
  const readers: Partial<HoldingsReaders> = {
    evmBalance: async (network, owner, token) => {
      calls.push(`evm:${network}:${owner}:${token ?? "native"}`);
      return 1_000_000n;
    },
    solanaBalance: async (network, owner, mint) => {
      calls.push(`sol:${network}:${owner}:${mint ?? "native"}`);
      return 2_000_000n;
    },
    gasPrice: async (network) => {
      calls.push(`gas:${network}`);
      return 10_000_000n;
    },
    solanaRent: async (network, bytes) => {
      calls.push(`rent:${network}:${bytes}`);
      return bytes === 0 ? 890_880n : 2_039_280n;
    },
    solanaTokenAccountExists: async (network, owner, mint) => {
      calls.push(`ata:${network}:${owner}:${mint}`);
      return false;
    },
    resolveName: async (name, network) => {
      calls.push(`name:${network}:${name}`);
      return { address: OTHER_EVM_ADDRESS, protocol: "ens" };
    },
    ...overrides,
  };
  return { readers, calls };
}

beforeEach(() => resetHoldingsCaches());
afterEach(() => configureHoldingsReaders(null));

describe("holdings: what is read", () => {
  it("reads EVM and Solana balances of the request's own accounts, natives and registry tokens", async () => {
    const reads = spy();
    configureHoldingsReaders(reads.readers);
    const facts = await readFacts(accounts, [
      { kind: "balance", network: "base", asset: "USDC" },
      { kind: "balance", network: "arbitrum", asset: "ETH" },
      { kind: "balance", network: "solana", asset: "SOL" },
      { kind: "balance", network: "solana", asset: "USDC" },
    ]);
    assert.deepEqual(facts.balances.map((fact) => [fact.network, fact.symbol, fact.status, fact.amount, fact.formatted]), [
      ["base", "USDC", "known", "1000000", "1"],
      ["arbitrum", "ETH", "known", "1000000", "0.000000000001"],
      ["solana", "SOL", "known", "2000000", "0.002"],
      ["solana", "USDC", "known", "2000000", "2"],
    ]);
    assert.deepEqual(reads.calls, [
      `evm:base:${EVM_ADDRESS}:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`,
      `evm:arbitrum:${EVM_ADDRESS}:native`,
      `sol:solana:${SOL_ADDRESS}:native`,
      `sol:solana:${SOL_ADDRESS}:${SOLANA_USDC_MINT}`,
    ]);
    assert.equal(facts.reads, 4);
  });

  it("reads gas prices, Solana rent, token-account existence and names", async () => {
    const reads = spy();
    configureHoldingsReaders(reads.readers);
    const facts = await readFacts(accounts, [
      { kind: "gasPrice", network: "base" },
      { kind: "gasPrice", network: "solana" },
      { kind: "solanaRent", network: "solana" },
      { kind: "tokenAccount", network: "solana", mint: SOLANA_USDC_MINT },
      { kind: "name", name: "Vitalik.eth", network: "ethereum" },
    ]);
    assert.deepEqual(facts.gasPrices, [{ network: "base", status: "known", weiPerGas: "10000000" }, { network: "solana", status: "skipped", reason: "Not an EVM network." }]);
    assert.deepEqual(facts.rent, [{ network: "solana", status: "known", walletLamports: "890880", tokenAccountLamports: "2039280" }]);
    assert.deepEqual(facts.tokenAccounts, [{ network: "solana", owner: SOL_ADDRESS, mint: SOLANA_USDC_MINT, status: "known", exists: false }]);
    assert.deepEqual(facts.names, [{ name: "vitalik.eth", network: "ethereum", status: "known", address: OTHER_EVM_ADDRESS, protocol: "ens" }]);
  });

  it("reads only the request's own accounts", async () => {
    const reads = spy();
    configureHoldingsReaders(reads.readers);
    const facts = await readFacts(accounts, [
      { kind: "balance", network: "base", asset: "USDC", owner: OTHER_EVM_ADDRESS },
      { kind: "balance", network: "base", asset: "USDC", owner: EVM_ADDRESS.toLowerCase() },
      { kind: "balance", network: "base", asset: "USDC" },
    ]);
    assert.equal(facts.balances[0]?.status, "skipped");
    assert.equal(facts.balances[1]?.status, "known", "the same address in another case is the own account");
    assert.equal(reads.calls.length, 1, "one read: the duplicate and the cache share it");
  });
});

describe("holdings: budgets, deadline and cache", () => {
  it("makes at most 8 balance reads and 2 name reads per call; the rest is unknown", async () => {
    const reads = spy();
    configureHoldingsReaders(reads.readers);
    const networks: NetworkKey[] = ["base", "arbitrum", "ethereum", "optimism", "polygon"];
    const needs: FactNeed[] = [
      ...networks.map((network) => ({ kind: "balance" as const, network, asset: "USDC" })),
      ...["base", "arbitrum", "ethereum", "optimism"].map((network) => ({ kind: "balance" as const, network: network as NetworkKey, asset: "ETH" })),
      { kind: "name", name: "a.eth", network: "ethereum" },
      { kind: "name", name: "b.eth", network: "ethereum" },
      { kind: "name", name: "c.eth", network: "ethereum" },
    ];
    const facts = await readFacts(accounts, needs);
    const statuses = facts.balances.map((fact) => fact.status);
    assert.equal(statuses.filter((status) => status === "known").length, MAX_BALANCE_READS);
    assert.equal(statuses[8], "unknown");
    assert.equal(facts.balances[8]?.reason, "Read budget exhausted.");
    assert.equal(facts.balances[8]?.amount, undefined, "unknown is never zero");
    assert.deepEqual(facts.names.map((fact) => fact.status), ["known", "known", "unknown"]);
    const smaller = await readFacts(accounts, [{ kind: "balance", network: "solana", asset: "SOL" }, { kind: "balance", network: "solana", asset: "USDC" }], { balances: 1 });
    assert.deepEqual(smaller.balances.map((fact) => fact.status), ["known", "unknown"]);
  });

  it("caches a balance for 15 s per account, network and asset (cache hits cost no budget)", async () => {
    const reads = spy();
    configureHoldingsReaders(reads.readers);
    await readFacts(accounts, [{ kind: "balance", network: "base", asset: "USDC" }]);
    const again = await readFacts(accounts, [{ kind: "balance", network: "base", asset: "USDC" }], { balances: 0 });
    assert.equal(again.balances[0]?.status, "known");
    assert.equal(again.reads, 0);
    assert.equal(reads.calls.length, 1);
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 15_001;
      await readFacts(accounts, [{ kind: "balance", network: "base", asset: "USDC" }]);
    } finally {
      Date.now = realNow;
    }
    assert.equal(reads.calls.length, 2, "expired after 15 s");
  });

  it("reports a failed or late read as unknown, never zero", async () => {
    configureHoldingsReaders(spy({
      evmBalance: async () => {
        throw new Error("rpc down");
      },
      solanaBalance: () => new Promise<bigint>(() => undefined),
    }).readers);
    const started = Date.now();
    const facts = await readFacts(accounts, [{ kind: "balance", network: "base", asset: "USDC" }, { kind: "balance", network: "solana", asset: "SOL" }], { deadlineMs: 200 });
    assert.ok(Date.now() - started < 1_500, "the deadline bounds the call");
    for (const fact of facts.balances) {
      assert.equal(fact.status, "unknown");
      assert.equal(fact.amount, undefined);
      assert.equal(knownAmount(fact), null);
    }
  });

  it("never caps the deadline above 3 s", async () => {
    configureHoldingsReaders(spy({ solanaBalance: () => new Promise<bigint>(() => undefined) }).readers);
    const started = Date.now();
    const facts = await readFacts(accounts, [{ kind: "balance", network: "solana", asset: "SOL" }], { deadlineMs: 60_000 });
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 2_900 && elapsed < 4_500, `took ${elapsed} ms`);
    assert.equal(facts.balances[0]?.status, "unknown");
  });

  it("marks an unlisted asset unknown without a read", async () => {
    const reads = spy();
    configureHoldingsReaders(reads.readers);
    const facts = await readFacts(accounts, [{ kind: "balance", network: "base", asset: "NOPE" }]);
    assert.equal(facts.balances[0]?.status, "unknown");
    assert.equal(reads.calls.length, 0);
  });
});

describe("holdings: preview accounts", () => {
  it("never reads preview (demo) accounts", async () => {
    const reads = spy();
    configureHoldingsReaders(reads.readers);
    const facts = await readFacts([...PREVIEW_ACCOUNT_IDS], [
      { kind: "balance", network: "base", asset: "USDC" },
      { kind: "balance", network: "arbitrum", asset: "ETH" },
      { kind: "balance", network: "solana", asset: "SOL" },
      { kind: "tokenAccount", network: "solana", mint: SOLANA_USDC_MINT },
    ]);
    assert.deepEqual(facts.balances.map((fact) => fact.status), ["skipped", "skipped", "skipped"]);
    assert.equal(facts.tokenAccounts[0]?.status, "skipped");
    assert.equal(facts.preview, true);
    assert.deepEqual(reads.calls, []);
  });
});

describe("holdings: default RPC readers", () => {
  it("reads Solana balances, token accounts and rent over JSON-RPC (fetch double)", async () => {
    configureHoldingsReaders(null);
    const mock = installRpcMock();
    const original = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { id: unknown; method: string; params: unknown[] };
      seen.push(body.method);
      const answer = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json" } });
      if (body.method === "getBalance") return answer({ context: { slot: 1 }, value: 123_456 });
      if (body.method === "getTokenAccountsByOwner") {
        return answer({
          context: { slot: 1 },
          value: [{ pubkey: "x", account: { data: { parsed: { info: { mint: SOLANA_USDC_MINT, tokenAmount: { amount: "2500000", decimals: 6 } } } } } }],
        });
      }
      if (body.method === "getMinimumBalanceForRentExemption") return answer(body.params[0] === 0 ? 650_240 : 1_488_440);
      return original(input, init);
    }) as typeof fetch;
    try {
      const facts = await readFacts(accounts, [
        { kind: "balance", network: "solana", asset: "SOL" },
        { kind: "balance", network: "solana", asset: "USDC" },
        { kind: "solanaRent", network: "solana" },
        { kind: "tokenAccount", network: "solana", mint: SOLANA_USDC_MINT },
      ]);
      assert.equal(facts.balances[0]?.amount, "123456");
      assert.equal(facts.balances[1]?.formatted, "2.5");
      assert.deepEqual(facts.rent[0], { network: "solana", status: "known", walletLamports: "650240", tokenAccountLamports: "1488440" });
      assert.equal(facts.tokenAccounts[0]?.exists, true);
      assert.ok(seen.includes("getMinimumBalanceForRentExemption"));
    } finally {
      globalThis.fetch = original;
      mock.restore();
    }
  });
});
