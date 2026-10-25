/**
 * Polygon holdings list USDC.e (Polymarket's collateral) next to the listed
 * assets: a wallet holding 250 USDC and 250 USDC.e shows both. Runs against a
 * stubbed Polygon client (no network).
 *
 *   cd apps/api && node --import tsx --test src/platform/engine/__tests__/heldOnlyHoldings.test.ts
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { POLYMARKET_POLYGON } from "@kletia/core";

import { evmClient } from "../chains/evm.js";
import { readEvmHoldings } from "../portfolio.js";

const OWNER = "0x8e34897f35891e8de1dad2801dcd0660865f76fe";
const USDC_POLYGON = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";

it("Polygon holdings include USDC.e at par, apart from native USDC", async (context) => {
  const client = evmClient("polygon");
  context.mock.method(client, "getBalance", async () => 50n * 10n ** 18n);
  context.mock.method(client, "multicall", async ({ contracts }: { contracts: { address: string }[] }) =>
    contracts.map((contract) => {
      const address = contract.address.toLowerCase();
      if (address === USDC_POLYGON || address === POLYMARKET_POLYGON.usdce.toLowerCase()) return { status: "success", result: 250_000_000n };
      return { status: "success", result: 0n };
    }),
  );
  const holdings = await readEvmHoldings("polygon", OWNER);
  const bySymbol = new Map(holdings.map((holding) => [holding.symbol, holding]));
  assert.equal(bySymbol.get("USDC")?.formatted, "250");
  const usdce = bySymbol.get("USDC.e");
  assert.ok(usdce, "USDC.e is listed");
  assert.equal(usdce.formatted, "250");
  assert.equal(usdce.usd, 250);
  assert.equal(usdce.priceSource, "usd-par");
  assert.equal(usdce.asset, `eip155:137/erc20:${POLYMARKET_POLYGON.usdce}`);
  // Listed once, as its own asset.
  assert.equal(holdings.filter((holding) => holding.symbol === "USDC.e").length, 1);
});
