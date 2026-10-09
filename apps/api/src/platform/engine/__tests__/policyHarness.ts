/**
 * Test seam for the Rule Book engine: a scripted price market (Chainlink
 * feeds by `eth_call`, Jupiter Price v3, the Solana slot), an in-memory key
 * tree with rule books (the chain source), and the reference gate over the
 * memory ports, installed on the engine.
 */
import { encodeFunctionResult, parseAbi, type Hex } from "viem";
import { policyHash, validatePolicy, type PolicyDefaults, type PolicyDocument } from "@kletia/core";
import { configurePolicyGate } from "../policy/gate.js";
import { configurePolicyPricing } from "../policy/pricing.js";
import { CHAINLINK_FEEDS, JUPITER_MINTS } from "../policy/feeds.js";
import { configurePolicyReads } from "../policy/execution.js";
import { MemoryApprovalStore, MemoryDecisionLog, MemorySpendLedger } from "../policy/memory.js";
import { createRuleBookGate, type RuleBookGate } from "../policy/ruleBookGate.js";
import type { PolicyChainLevel, PolicyChainSnapshot, PolicyChainSource } from "../policy/ports.js";
import type { EvmNetworkKey } from "../chains/evm.js";

/* ------------------------------------------------------------------ market */

const FEED_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

export interface FakeFeed {
  readonly decimals: number;
  readonly answer: bigint;
  /** Unix seconds. */
  readonly updatedAt: number;
}

export interface FakeJupiterEntry {
  readonly usdPrice: number;
  readonly liquidity: number;
  readonly blockId: number;
}

export interface FakeMarket {
  /** `${network}:${address lowercase}` → feed; "revert" makes the call revert, "throw" fails the RPC. */
  readonly chainlink: Map<string, FakeFeed | "revert" | "throw">;
  readonly jupiter: Map<string, FakeJupiterEntry>;
  slot: bigint | null;
  /** Unix ms of the pricer's clock. */
  now: number;
  /** Delay (ms) of every source read (timeouts). */
  delayMs: number;
  readonly calls: { ethCall: number; jupiter: number; slot: number };
}

export function feedKey(feed: { readonly network: EvmNetworkKey; readonly address: string }): string {
  return `${feed.network}:${feed.address.toLowerCase()}`;
}

/** A fresh feed answering `usd` (8 decimals unless told otherwise). */
export function feed(usd: number, options: { readonly decimals?: number; readonly ageSeconds?: number; readonly now?: number } = {}): FakeFeed {
  const decimals = options.decimals ?? 8;
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const answer = BigInt(Math.round(usd * 1e6)) * 10n ** BigInt(decimals) / 1_000_000n;
  return { decimals, answer, updatedAt: now - (options.ageSeconds ?? 60) };
}

export function installMarket(): FakeMarket {
  const market: FakeMarket = {
    chainlink: new Map(),
    jupiter: new Map(),
    slot: 400_000_000n,
    now: Date.now(),
    delayMs: 0,
    calls: { ethCall: 0, jupiter: 0, slot: 0 },
  };
  const delay = () => (market.delayMs > 0 ? new Promise((resolve) => setTimeout(resolve, market.delayMs)) : Promise.resolve());
  configurePolicyPricing({
    ethCall: async (network, to, data) => {
      market.calls.ethCall += 1;
      await delay();
      const entry = market.chainlink.get(`${network}:${to.toLowerCase()}`);
      if (entry === undefined || entry === "revert") return null;
      if (entry === "throw") throw new Error("rpc down");
      if (data.startsWith("0x313ce567")) return encodeFunctionResult({ abi: FEED_ABI, functionName: "decimals", result: entry.decimals }) as Hex;
      return encodeFunctionResult({ abi: FEED_ABI, functionName: "latestRoundData", result: [1n, entry.answer, BigInt(entry.updatedAt), BigInt(entry.updatedAt), 1n] }) as Hex;
    },
    jupiterPrices: async (mints) => {
      market.calls.jupiter += 1;
      await delay();
      return Object.fromEntries(mints.flatMap((mint) => {
        const entry = market.jupiter.get(mint);
        return entry ? [[mint, { ...entry, decimals: 6 }]] : [];
      }));
    },
    solanaSlot: async () => {
      market.calls.slot += 1;
      await delay();
      if (market.slot === null) throw new Error("slot unavailable");
      return market.slot;
    },
    now: () => market.now,
  });
  return market;
}

/** Jupiter entry with deep liquidity at the current slot. */
export function jupiter(market: FakeMarket, usdPrice: number, overrides: Partial<FakeJupiterEntry> = {}): FakeJupiterEntry {
  return { usdPrice, liquidity: 50_000_000, blockId: Number(market.slot ?? 0n) - 10, ...overrides };
}

/** USDC $1 (Chainlink on Ethereum, Base, Arbitrum and Jupiter), ETH and SOL at the given prices. */
export function standardPrices(market: FakeMarket, prices: { readonly eth?: number; readonly sol?: number; readonly usdc?: number } = {}): void {
  const eth = prices.eth ?? 3_000;
  const sol = prices.sol ?? 150;
  const usdc = prices.usdc ?? 1;
  const now = market.now;
  for (const entry of [CHAINLINK_FEEDS.usdcUsdEthereum, CHAINLINK_FEEDS.usdcUsdBase, CHAINLINK_FEEDS.usdcUsdArbitrum]) market.chainlink.set(feedKey(entry), feed(usdc, { now }));
  for (const entry of [CHAINLINK_FEEDS.ethUsdEthereum, CHAINLINK_FEEDS.ethUsdBase, CHAINLINK_FEEDS.ethUsdArbitrum, CHAINLINK_FEEDS.ethUsdOptimism, CHAINLINK_FEEDS.ethUsdPolygon]) {
    market.chainlink.set(feedKey(entry), feed(eth, { now }));
  }
  market.jupiter.set(JUPITER_MINTS.usdc, jupiter(market, usdc));
  market.jupiter.set(JUPITER_MINTS.wsol, jupiter(market, sol));
  market.jupiter.set(JUPITER_MINTS.weth, jupiter(market, eth));
  market.jupiter.set(JUPITER_MINTS.jitosol, jupiter(market, sol * 1.2));
}

/* --------------------------------------------------------------- key tree */

export const PROJECT_ID = "prj_00000000000000000000aaaa";
export const ROOT_KEY = "key_000000000000000000000001";
export const AGENT_KEY = "key_000000000000000000000002";
export const AGENT_B_KEY = "key_000000000000000000000003";
export const CHILD_KEY = "key_000000000000000000000004";

interface KeyEntry {
  parent: string | null;
  agent: boolean;
  active: boolean;
  policy: PolicyDocument | null;
  version: number;
}

/** Validates a rule book (canonical form), failing the test on issues. */
export function ruleBook(document: Record<string, unknown>, defaults: PolicyDefaults = "project"): PolicyDocument {
  const result = validatePolicy({ schema: "kletia.policy/v1", ...document }, { defaults });
  if (!result.ok) throw new Error(`invalid test rule book: ${JSON.stringify(result.issues)}`);
  return result.value;
}

export class FakeChains implements PolicyChainSource {
  readonly keys = new Map<string, KeyEntry>();
  project: PolicyDocument | null = null;
  projectVersion = 1;
  fail = false;
  reads = 0;

  constructor() {
    this.keys.set(ROOT_KEY, { parent: null, agent: false, active: true, policy: null, version: 0 });
  }

  addAgent(id: string, parent: string, policy: PolicyDocument | null): void {
    this.keys.set(id, { parent, agent: true, active: true, policy, version: policy ? 1 : 0 });
  }

  setPolicy(id: string, policy: PolicyDocument | null): void {
    const key = this.keys.get(id);
    if (!key) throw new Error(`unknown key ${id}`);
    key.policy = policy;
    key.version += 1;
  }

  setProject(policy: PolicyDocument | null): void {
    this.project = policy;
    this.projectVersion += 1;
  }

  revoke(id: string): void {
    const key = this.keys.get(id);
    if (key) key.active = false;
  }

  async chain(ownerKeyId: string): Promise<PolicyChainSnapshot | undefined> {
    this.reads += 1;
    if (this.fail) throw new Error("policy store down");
    const own = this.keys.get(ownerKeyId);
    if (!own) return undefined;
    const path: string[] = [];
    for (let id: string | null = ownerKeyId; id !== null; id = this.keys.get(id)?.parent ?? null) path.unshift(id);
    const level = (id: string): PolicyChainLevel => {
      const key = this.keys.get(id) as KeyEntry;
      return {
        scope: "key",
        id,
        defaults: key.agent ? "agent" : "project",
        policy: key.policy,
        version: key.policy ? key.version : null,
        hash: key.policy ? policyHash(key.policy) : null,
      };
    };
    return {
      projectId: PROJECT_ID,
      ownerKeyId,
      lineage: path.slice(0, -1),
      keyActive: path.every((id) => this.keys.get(id)?.active === true),
      levels: [
        { scope: "project", id: PROJECT_ID, defaults: "project", policy: this.project, version: this.project ? this.projectVersion : null, hash: this.project ? policyHash(this.project) : null },
        ...path.map(level),
      ],
    };
  }
}

/* ----------------------------------------------------------------- gate */

export interface RuleBookWorld {
  readonly chains: FakeChains;
  readonly ledger: MemorySpendLedger;
  readonly approvals: MemoryApprovalStore;
  readonly decisions: MemoryDecisionLog;
  readonly gate: RuleBookGate;
  readonly market: FakeMarket;
  /** Pending nonce the chain reads report. */
  nonce: bigint;
  /** Solana block height the chain reads report. */
  height: bigint;
}

/** Installs the reference gate over memory ports, a scripted market and chain reads. */
export function installRuleBook(): RuleBookWorld {
  const chains = new FakeChains();
  const ledger = new MemorySpendLedger();
  const approvals = new MemoryApprovalStore();
  const decisions = new MemoryDecisionLog();
  const gate = createRuleBookGate({ chains, ledger, approvals, decisions, approvalUrl: (id) => `https://kletia.test/approve#${id}` });
  const market = installMarket();
  standardPrices(market);
  const world: RuleBookWorld = { chains, ledger, approvals, decisions, gate, market, nonce: 7n, height: 500n };
  configurePolicyReads({ pendingNonce: async () => world.nonce, solanaBlockHeight: async () => world.height });
  configurePolicyGate(gate);
  return world;
}

export function removeRuleBook(): void {
  configurePolicyGate(null);
  configurePolicyPricing(null);
  configurePolicyReads(null);
}
