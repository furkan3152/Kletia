/**
 * Live check of the Rule Book's price oracle (policy design §5.1, §15 live
 * dry run item 1). Read-only `eth_call`s and HTTP GETs: every Chainlink proxy
 * answers its description and decimals and a fresh round; Jupiter prices
 * every registry Solana mint with its liquidity floor; every mainnet
 * registry asset gets a conservative price.
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
import { CHAINLINK_FEEDS, CHAINLINK_GRACE_SECONDS, JUPITER_MINTS } from "../../policy/feeds.js";
import { configurePolicyPricing, policyPrice, quoteUsdNumber, readPriceSource } from "../../policy/pricing.js";

const LIVE = process.env.KLETIA_LIVE === "1";
const ABI = parseAbi([
  "function description() view returns (string)",
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
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
    for (const asset of ASSETS.filter((entry) => CHAINS[entry.network].environment !== "testnet")) {
      const quote = await policyPrice({ asset: asset.id, symbol: asset.symbol, decimals: asset.decimals, network: asset.network });
      rows.push(`${asset.network.padEnd(9)} ${asset.symbol.padEnd(8)} ${quote ? quoteUsdNumber(quote).toPrecision(8) : "UNPRICED"} sources=${quote?.readings.length ?? 0}${quote?.floored ? " floored" : ""}${quote?.warnings.length ? ` ${quote.warnings.join(" ")}` : ""}`);
      assert.ok(quote, `${asset.symbol} on ${asset.network} is priced`);
    }
    console.log(rows.join("\n"));
  });
});
