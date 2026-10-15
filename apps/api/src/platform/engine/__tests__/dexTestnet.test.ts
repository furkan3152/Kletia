/**
 * Testnet guard mode of the concentrated-liquidity swaps (round 7 protocols
 * design 3.1, package P1): Uniswap V3 on Arbitrum Sepolia trades test tokens
 * without a market price, so the Chainlink band is replaced by a 1 % slippage
 * cap and a mandatory warning. The bypass exists only for a deployment
 * flagged `testnet` on a testnet network: every mainnet deployment goes
 * through the oracle, and a `testnet` flag on a mainnet network is refused.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { decodeFunctionData, erc20Abi, getAddress, type Hex } from "viem";
import { CHAINS, DEX_DEPLOYMENTS, dexDeploymentsFor, type EvmTransactionRequest } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { resetDexCaches, SWAP_ROUTER02_ABI } from "../adapters/dex/concentrated.js";
import { dexPriceGuard, TESTNET_MAX_SLIPPAGE_BPS, TESTNET_PRICE_WARNING, testnetPriceMode } from "../adapters/dex/oracleGuard.js";
import { uniswapV3Adapter } from "../adapters/dex/uniswapV3.js";
import { candidateAdapters, configureAdapters } from "../adapters/registry.js";
import type { ProtocolAdapter } from "../adapters/types.js";
import { resolveAsset } from "../assets.js";
import { configurePlatform, createIntent, prepareStep } from "../service.js";
import { MemoryIntentStore } from "../store.js";
import { addPool, mockDex } from "./dexWorld.js";
import { ACCOUNT, installLendingChain, mockToken, setBalance, tokenAddress, type LendingChain } from "./lendingChain.js";
import { installSwapOracle, type SwapOracle } from "./rpcMock.js";

const SEPOLIA = dexDeploymentsFor("arbitrum-sepolia", "uniswap-v3")[0]!;
const ROUTER = getAddress(SEPOLIA.router);
const USDC = getAddress(tokenAddress("arbitrum-sepolia", "USDC"));
const WETH = getAddress(tokenAddress("arbitrum-sepolia", "WETH"));
const ACCOUNTS = [`eip155:421614:${ACCOUNT}`];
const uniswap = uniswapV3Adapter as ProtocolAdapter;

let chain: LendingChain;
let oracle: SwapOracle;

beforeEach(() => {
  chain = installLendingChain();
  resetDexCaches();
  // No feed at all: a testnet swap must not need one.
  oracle = installSwapOracle([]);
  const usdc = mockToken(chain, USDC, { symbol: "USDC", decimals: 6 });
  mockToken(chain, WETH, { symbol: "WETH", decimals: 18 });
  setBalance(usdc, ACCOUNT, 1_000_000_000n);
  chain.nativeBalances.set(ACCOUNT.toLowerCase(), 10n ** 18n);
  configurePlatform({ store: new MemoryIntentStore(), adapters: [uniswap] });
});

afterEach(() => {
  chain.restore();
  oracle.restore();
  configureAdapters(null);
});

function swap(from: string, to: string, amount: string, constraints: Record<string, unknown> = {}) {
  return createIntent({ actions: [{ kind: "swap", network: "arbitrum-sepolia", from, to, amount }], accounts: ACCOUNTS, constraints });
}

describe("testnet guard mode: only a testnet deployment on a testnet network", () => {
  it("no mainnet deployment is flagged testnet, and none takes the bypass", () => {
    const mainnet = DEX_DEPLOYMENTS.filter((deployment) => CHAINS[deployment.network].environment === "mainnet");
    assert.ok(mainnet.length >= 13, `${mainnet.length} mainnet deployments`);
    for (const deployment of mainnet) {
      assert.notEqual(deployment.testnet, true, deployment.id);
      assert.equal(testnetPriceMode(deployment), false, deployment.id);
    }
    for (const deployment of DEX_DEPLOYMENTS.filter((entry) => entry.testnet === true)) {
      assert.equal(CHAINS[deployment.network].environment, "testnet", deployment.id);
      assert.equal(testnetPriceMode(deployment), true, deployment.id);
    }
  });

  it("refuses the bypass for a testnet flag on every mainnet network (VENUE_UNVERIFIED), even before any price is read", async () => {
    const usdc = await resolveAsset("arbitrum", "USDC");
    const weth = await resolveAsset("arbitrum", "WETH");
    for (const deployment of DEX_DEPLOYMENTS.filter((entry) => CHAINS[entry.network].environment === "mainnet")) {
      const forged = { ...deployment, testnet: true as const };
      assert.throws(() => testnetPriceMode(forged), (error: PlatformError) => error.code === "VENUE_UNVERIFIED", deployment.id);
      await assert.rejects(dexPriceGuard(forged, usdc, 1_000_000n, weth, 1n), (error: PlatformError) => error.code === "VENUE_UNVERIFIED", deployment.id);
    }
  });

  it("an unflagged deployment on a testnet network still goes through the oracle (PRICE_UNAVAILABLE)", async () => {
    const usdc = await resolveAsset("arbitrum-sepolia", "USDC");
    const weth = await resolveAsset("arbitrum-sepolia", "WETH");
    const { testnet: _flag, ...unflagged } = SEPOLIA;
    await assert.rejects(dexPriceGuard(unflagged, usdc, 1_000_000n, weth, 1n), (error: PlatformError) => error.code === "PRICE_UNAVAILABLE");
  });
});

describe("Uniswap V3 on Arbitrum Sepolia", () => {
  it("is a candidate for test-token swaps on Arbitrum Sepolia", async () => {
    configureAdapters(null);
    const route = { kind: "swap" as const, network: "arbitrum-sepolia" as const, destinationNetwork: "arbitrum-sepolia" as const, input: await resolveAsset("arbitrum-sepolia", "USDC"), output: await resolveAsset("arbitrum-sepolia", "ETH") };
    assert.ok(candidateAdapters(route, undefined).some((adapter) => adapter.id === "uniswap-v3"));
  });

  it("plans without an oracle, carries the test-token warning and keeps an on-chain floor", async () => {
    const world = mockDex(chain, SEPOLIA);
    const pool = addPool(chain, world, USDC, WETH, 500, { ab: 999_499_999_999_504n });
    const graph = await swap("USDC", "ETH", "1");
    const step = graph.steps[0]!;
    assert.equal(step.protocol, "uniswap-v3");
    assert.equal(step.expectedOutput?.amount, "999499999999504");
    assert.equal(step.minimumOutput?.amount, ((999_499_999_999_504n * 9_950n) / 10_000n).toString(), "default 0.5 % is under the 1 % cap");
    assert.ok((step.warnings ?? []).includes(TESTNET_PRICE_WARNING), (step.warnings ?? []).join(" | "));
    assert.match((step.warnings ?? []).join(" "), new RegExp(`arbitrum-sepolia:uniswap-v3:v3\\), 0\\.05 % pool, ${pool}`, "u"));
    assert.ok(oracle.answers.size === 0);
  });

  it("caps slippage at 1 % for test tokens", async () => {
    const world = mockDex(chain, SEPOLIA);
    addPool(chain, world, USDC, WETH, 500, { ab: 1_000_000_000_000_000n });
    const graph = await swap("USDC", "WETH", "1", { maxSlippageBps: 300 });
    const step = graph.steps[0]!;
    assert.equal(TESTNET_MAX_SLIPPAGE_BPS, 100);
    assert.equal(step.minimumOutput?.amount, ((1_000_000_000_000_000n * 9_900n) / 10_000n).toString());
    assert.match((step.warnings ?? []).join(" "), /Slippage capped at 1 % for Uniswap V3 test-token swaps/u);
  });

  it("prepares an exact approval of the pinned Sepolia SwapRouter02 and the swap on chain 421614", async () => {
    const world = mockDex(chain, SEPOLIA);
    addPool(chain, world, USDC, WETH, 500, { ab: 1_000_000_000_000_000n });
    const graph = await swap("USDC", "WETH", "1");
    const { payload } = await prepareStep(graph.id, "s1");
    const transactions = payload.transactions as EvmTransactionRequest[];
    assert.equal(transactions.length, 2);
    assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: transactions[0]?.data as Hex }).args, [ROUTER, 1_000_000n]);
    assert.equal(transactions[1]?.to, ROUTER);
    assert.equal(transactions[1]?.chainId, 421614);
    assert.equal(decodeFunctionData({ abi: SWAP_ROUTER02_ABI, data: transactions[1]?.data as Hex }).functionName, "multicall");
  });
});
