/**
 * The smoothed rates and TVL the unnamed "best yield" and "stake" choices rank
 * on. A rate is the realised growth of the venue's own index (Aave liquidity
 * index, Comet supply index, mToken exchange rate, vault share price, LST rate)
 * between the block about a week ago and the latest block; unreadable history
 * gives null, never 0.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { erc20Abi, parseAbi, type Abi } from "viem";
import { nativeAssetId } from "@kletia/core";
import { indexGrowthApy, NOMINAL_BLOCK_SECONDS, SMOOTHED_APY_WINDOW_SECONDS, tvlUsdOf } from "../adapters/lending/common.js";
import { pinned, readStakingMetrics, tokenOf } from "../adapters/staking/common.js";
import { lidoVenue } from "../adapters/staking/lido.js";
import { listStakingMetrics } from "../adapters/staking/index.js";
import { configureScoreFacts } from "../routing/score.js";
import { TEST_SCORE_FACTS } from "./helpers.js";
import { installLendingChain, type LendingChain } from "./lendingChain.js";

let chain: LendingChain;
const INDEX = "0x00000000000000000000000000000000000c0de1";
const INDEX_ABI = parseAbi(["function index() view returns (uint256)"]);

beforeEach(() => {
  chain = installLendingChain();
  configureScoreFacts(TEST_SCORE_FACTS);
});

afterEach(() => {
  chain.restore();
  configureScoreFacts(null);
});

/** An index contract answering `now` at the latest block and `past` at any earlier one. */
function indexContract(now: bigint, past: bigint): void {
  const latest = `0x${chain.latestBlock.toString(16)}`;
  chain.contract(INDEX, INDEX_ABI as unknown as Abi, { index: (_args, call) => (call.block === "latest" || call.block === latest ? now : past) });
}

async function readIndex(blockNumber: bigint): Promise<bigint> {
  const { evmClient } = await import("../chains/evm.js");
  return evmClient("base").readContract({ address: INDEX, abi: INDEX_ABI, functionName: "index", blockNumber });
}

describe("indexGrowthApy", () => {
  it("annualises the growth between the latest block and the block about a week ago", async () => {
    indexContract(1_001_000_000_000_000_000n, 10n ** 18n);
    const result = await indexGrowthApy("base", readIndex);
    assert.ok(result);
    assert.equal(result.window, SMOOTHED_APY_WINDOW_SECONDS, "Base's synthetic blocks are 2 s apart");
    const expected = 1.001 ** (31_536_000 / SMOOTHED_APY_WINDOW_SECONDS) - 1;
    assert.ok(Math.abs(result.apy - expected) < 1e-6, `${result.apy} vs ${expected}`);
    assert.equal(NOMINAL_BLOCK_SECONDS.base, 2);
  });

  it("gives null, never zero, when the index shrank or history cannot be read", async () => {
    indexContract(10n ** 18n, 1_001_000_000_000_000_000n);
    assert.equal(await indexGrowthApy("base", readIndex), null, "an index that fell is not a rate");
    await assert.rejects(indexGrowthApy("base", async () => {
      throw new Error("missing trie node");
    }));
  });
});

describe("tvlUsdOf", () => {
  it("values an underlying amount at par for USD stablecoins and at the score's prices otherwise; unpriced is null", async () => {
    assert.equal(await tvlUsdOf({ asset: "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6, amount: "1234560000", formatted: "1234.56" }), 1_234.56);
    assert.equal(await tvlUsdOf({ asset: nativeAssetId("ethereum"), symbol: "ETH", decimals: 18, amount: "2000000000000000000", formatted: "2" }), 5_000);
    configureScoreFacts({ ...TEST_SCORE_FACTS, nativeUsd: async () => null, assetUsd: async () => null });
    assert.equal(await tvlUsdOf({ asset: nativeAssetId("ethereum"), symbol: "ETH", decimals: 18, amount: "1", formatted: "0.000000000000000001" }), null);
    assert.equal(await tvlUsdOf(null), null);
  });
});

describe("liquid-staking metrics", () => {
  function mockLido(now: bigint, past: bigint, supply: bigint): void {
    const latest = `0x${chain.latestBlock.toString(16)}`;
    const token = tokenOf(lidoVenue);
    chain.contract(token, [...erc20Abi, ...parseAbi(["function getStETHByWstETH(uint256) view returns (uint256)"])] as unknown as Abi, {
      totalSupply: () => supply,
      getStETHByWstETH: ([units], call) => ((units as bigint) * (call.block === "latest" || call.block === latest ? now : past)) / 10n ** 18n,
    });
  }

  it("reads the LST's own ETH rate a week apart (net of the protocol fee) and values the supply in USD", async () => {
    // wstETH: 1.2 stETH now, 1.19945 at the past block; 3,000,000 wstETH outstanding.
    mockLido(1_200_000_000_000_000_000n, 1_199_450_000_000_000_000n, 3_000_000n * 10n ** 18n);
    const metrics = await readStakingMetrics(lidoVenue);
    assert.equal(metrics.provider, "lido");
    assert.equal(metrics.lst, "wstETH");
    // The mock's blocks are 2 s apart, so the 7-day block distance of Ethereum (12 s) spans a shorter window here:
    // the rate is annualised over the window actually read from the two blocks.
    assert.ok(metrics.apyWindowSeconds !== null && metrics.apyWindowSeconds >= 86_400, String(metrics.apyWindowSeconds));
    const expected = (1.2 / 1.19945) ** (31_536_000 / (metrics.apyWindowSeconds ?? 1)) - 1;
    assert.ok(metrics.smoothedApy !== null && Math.abs(metrics.smoothedApy - expected) < 1e-6, `${metrics.smoothedApy} vs ${expected}`);
    assert.equal(metrics.tvlUsd, 3_000_000 * 1.2 * 2_500, "supply x rate x the ETH price");
    assert.ok(pinned("lido", lidoVenue.tokenRole));
  });

  it("lists every provider, with nulls for one whose reads fail", async () => {
    mockLido(1_200_000_000_000_000_000n, 1_199_450_000_000_000_000n, 10n ** 18n);
    const listing = await listStakingMetrics();
    assert.deepEqual(listing.map((entry) => entry.provider), ["lido", "rocket-pool", "etherfi", "stader", "mantle-lsp", "frax-ether"]);
    assert.ok(listing[0]?.smoothedApy !== null);
    assert.ok(listing.slice(1).every((entry) => entry.smoothedApy === null && entry.tvlUsd === null), "unmocked providers are unknown, not zero");
  });
});
