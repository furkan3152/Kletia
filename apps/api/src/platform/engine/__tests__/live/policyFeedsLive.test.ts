/**
 * Live check of the Rule Book's price oracle (policy design §5.1, §15 live
 * dry run item 1). Read-only `eth_call`s and HTTP GETs: every Chainlink proxy
 * answers its description and decimals and a fresh round; the L2 sequencer
 * uptime feeds report up past their grace period; the liquid staking prices
 * derive from their feeds; Jupiter prices every registry Solana mint with its
 * liquidity floor; every mainnet registry asset with a venue route gets a
 * conservative price.
 *
 *   KLETIA_LIVE=1 node --import tsx --test src/platform/engine/__tests__/live/policyFeedsLive.test.ts
 *
 * Skipped unless KLETIA_LIVE=1. Nothing is signed or sent.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import { ASSETS, CHAINS } from "@kletia/core";
import { rawEthCall } from "../../chains/evm.js";
import { CHAINLINK_FEEDS, CHAINLINK_GRACE_SECONDS, DERIVED_FEEDS, JUPITER_MINTS, SEQUENCER_GRACE_SECONDS, SEQUENCER_UPTIME_FEEDS, WSTETH_ETHEREUM } from "../../policy/feeds.js";
import { configurePolicyPricing, policyPrice, quoteUsdNumber, readPriceSource } from "../../policy/pricing.js";

const LIVE = process.env.KLETIA_LIVE === "1";
const ABI = parseAbi([
  "function description() view returns (string)",
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function stEthPerToken() view returns (uint256)",
]);

describe("policy price feeds (live)", { skip: !LIVE }, () => {
  it("reads every Chainlink proxy: description, on-chain decimals and a round within its heartbeat", async () => {
    configurePolicyPricing(null);
    const now = Math.floor(Date.now() / 1000);
    const rows: string[] = [];
    for (const [name, feed] of Object.entries(CHAINLINK_FEEDS)) {
      const call = async (functionName: "description" | "decimals" | "latestRoundData") => {
        const data = await rawEthCall(feed.network, feed.address, encodeFunctionData({ abi: ABI, functionName }));
        assert.ok(data, `${name}.${functionName}() answered`);
        return decodeFunctionResult({ abi: ABI, functionName, data });
      };
      const description = (await call("description")) as string;
      const decimals = Number(await call("decimals"));
      const [, answer, , updatedAt] = (await call("latestRoundData")) as readonly [bigint, bigint, bigint, bigint, bigint];
      const age = Math.max(0, now - Number(updatedAt));
      rows.push(`${feed.network.padEnd(9)} ${feed.address} ${description.padEnd(14)} dec=${decimals} price=${(Number(answer) / 10 ** decimals).toPrecision(8)} age=${age}s hb=${feed.heartbeatSeconds}s`);
      assert.equal(description, feed.description, `${name} description`);
      assert.ok(answer > 0n, `${name} answer`);
      assert.ok(age <= feed.heartbeatSeconds + CHAINLINK_GRACE_SECONDS, `${name} is fresh (${age}s)`);
      const reading = await readPriceSource(feed);
      assert.ok(reading, `${name} is a fresh oracle reading`);
    }
    console.log(rows.join("\n"));
  });

  it("reads the Arbitrum, OP and Base sequencer uptime feeds: up, and past the restart grace", async () => {
    const now = Math.floor(Date.now() / 1000);
    const rows: string[] = [];
    for (const feed of Object.values(SEQUENCER_UPTIME_FEEDS)) {
      const call = async (functionName: "description" | "latestRoundData") => {
        const data = await rawEthCall(feed.network, feed.address, encodeFunctionData({ abi: ABI, functionName }));
        assert.ok(data, `${feed.network} uptime feed ${functionName}() answered`);
        return decodeFunctionResult({ abi: ABI, functionName, data });
      };
      const description = (await call("description")) as string;
      const [, answer, startedAt] = (await call("latestRoundData")) as readonly [bigint, bigint, bigint, bigint, bigint];
      const upFor = now - Number(startedAt);
      rows.push(`${feed.network.padEnd(9)} ${feed.address} ${description} status=${answer === 0n ? "up" : "DOWN"} since=${upFor}s`);
      assert.equal(description, feed.description);
      assert.equal(answer, 0n, `${feed.network} sequencer is up`);
      assert.ok(upFor > SEQUENCER_GRACE_SECONDS, `${feed.network} is past the ${SEQUENCER_GRACE_SECONDS} s grace`);
    }
    console.log(rows.join("\n"));
  });

  it("derives wstETH, rETH and weETH prices from the LST feeds", async () => {
    configurePolicyPricing(null);
    const rate = await rawEthCall("ethereum", WSTETH_ETHEREUM, encodeFunctionData({ abi: ABI, functionName: "stEthPerToken" }));
    assert.ok(rate);
    const stEthPerToken = decodeFunctionResult({ abi: ABI, functionName: "stEthPerToken", data: rate }) as bigint;
    const rows = [`wstETH.stEthPerToken() = ${Number(stEthPerToken) / 1e18}`];
    const eth = await policyPrice({ asset: ASSETS.find((entry) => entry.network === "ethereum" && entry.symbol === "ETH")!.id, symbol: "ETH", decimals: 18, network: "ethereum" });
    assert.ok(eth);
    for (const [symbol, feed] of [["wstETH", DERIVED_FEEDS.wstethUsd], ["rETH", DERIVED_FEEDS.rethUsd], ["weETH", DERIVED_FEEDS.weethUsd]] as const) {
      const reading = await readPriceSource(feed);
      assert.ok(reading, `${symbol} derived reading`);
      const descriptor = ASSETS.find((entry) => entry.network === "ethereum" && entry.symbol === symbol)!;
      const quote = await policyPrice({ asset: descriptor.id, symbol, decimals: 18, network: "ethereum" });
      assert.ok(quote, `${symbol} is priced`);
      const ratio = quoteUsdNumber(quote) / quoteUsdNumber(eth);
      rows.push(`${symbol.padEnd(7)} ${quoteUsdNumber(quote).toFixed(2)} USD (${ratio.toFixed(4)} ETH) age=${Math.floor(Date.now() / 1000) - reading.observedAt}s`);
      // Liquid staking tokens trade at or above 1 ETH and well below 2 ETH.
      assert.ok(ratio > 0.98 && ratio < 1.5, `${symbol} is ${ratio} ETH`);
    }
    console.log(rows.join("\n"));
  });

  it("prices every registry Solana mint through Jupiter above the liquidity floor", async () => {
    configurePolicyPricing(null);
    const rows: string[] = [];
    for (const [name, mint] of Object.entries(JUPITER_MINTS)) {
      const reading = await readPriceSource({ kind: "jupiter", mint });
      rows.push(`${name.padEnd(8)} ${mint} ${reading ? (Number(reading.usd18 / 10n ** 12n) / 1e6).toPrecision(8) : "unpriced"}`);
      assert.ok(reading, `${name} (${mint}) is priced with liquidity and a recent slot`);
    }
    console.log(rows.join("\n"));
  });

  it("gives every mainnet registry asset a conservative price", async () => {
    configurePolicyPricing(null);
    const rows: string[] = [];
    // Transfer-only assets (USDbC) have no venue route and no price source of their own.
    for (const asset of ASSETS.filter((entry) => CHAINS[entry.network].environment !== "testnet" && !entry.transferOnly)) {
      const quote = await policyPrice({ asset: asset.id, symbol: asset.symbol, decimals: asset.decimals, network: asset.network });
      rows.push(`${asset.network.padEnd(9)} ${asset.symbol.padEnd(8)} ${quote ? quoteUsdNumber(quote).toPrecision(8) : "UNPRICED"} sources=${quote?.readings.length ?? 0}${quote?.floored ? " floored" : ""}${quote?.warnings.length ? ` ${quote.warnings.join(" ")}` : ""}`);
      assert.ok(quote, `${asset.symbol} on ${asset.network} is priced`);
    }
    console.log(rows.join("\n"));
  });
});
