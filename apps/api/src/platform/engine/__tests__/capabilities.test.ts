/**
 * The capability index (core `capabilityIndex`, protocols design 3.0) agrees
 * with the live adapter registry: every row whose protocol has a wired
 * adapter is a route that adapter supports (deposit / withdraw rows of every
 * yield venue, swap rows of the pinned DEXs, stake rows of the EVM LSTs), and
 * a row's protocol never executes where the registry lists no row.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHAINS,
  capabilityIndex,
  findAssetBySymbol,
  type CapabilityRow,
  type NetworkKey,
} from "@kletia/core";
import { ADAPTERS } from "../adapters/registry.js";
import type { AdapterRoute, ProtocolAdapter } from "../adapters/types.js";
import { resolvedFromDescriptor, type ResolvedAsset } from "../assets.js";
import { EVM_STAKING_TOKENS } from "../grammar.js";

function asset(network: NetworkKey, symbol: string): ResolvedAsset {
  const descriptor = findAssetBySymbol(network, symbol);
  assert.ok(descriptor, `${network} ${symbol}`);
  return resolvedFromDescriptor(descriptor);
}

function adaptersOf(row: CapabilityRow): ProtocolAdapter[] {
  return ADAPTERS.filter((adapter) => adapter.id === row.protocol);
}

/** A representative route of a row, or null when the row has no simple same-network shape. */
function routeOf(row: CapabilityRow): AdapterRoute | null {
  const native = CHAINS[row.network].nativeAsset.symbol;
  if (row.kind === "deposit" || row.kind === "withdraw") {
    const input = asset(row.network, row.asset as string);
    return { kind: row.kind, network: row.network, destinationNetwork: row.network, input, output: input };
  }
  if (row.kind === "swap" && CHAINS[row.network].vm === "evm") {
    const tokenIn = row.asset ?? "USDC";
    const tokenOut = row.asset === null ? native : tokenIn === "USDC" ? "USDT" : "USDC";
    return { kind: "swap", network: row.network, destinationNetwork: row.network, input: asset(row.network, tokenIn), output: asset(row.network, tokenOut) };
  }
  if (row.kind === "stake" && row.network === "ethereum") {
    // The token the grammar says the protocol mints (Lido: wstETH, Rocket Pool: rETH, ...).
    const minted = Object.values(EVM_STAKING_TOKENS).find((entry) => entry.protocol === row.protocol);
    assert.ok(minted, `${row.protocol} mints a registry asset`);
    return { kind: "stake", network: "ethereum", destinationNetwork: "ethereum", input: asset("ethereum", "ETH"), output: asset("ethereum", minted.symbol) };
  }
  return null;
}

describe("capability index vs the adapter registry", () => {
  it("every deposit / withdraw row of a wired protocol is a route its adapter supports", () => {
    const rows = capabilityIndex().filter((row) => (row.kind === "deposit" || row.kind === "withdraw") && adaptersOf(row).length > 0);
    assert.ok(rows.length >= 100, `${rows.length} lending rows`);
    for (const row of rows) {
      const route = routeOf(row);
      assert.ok(route);
      assert.ok(adaptersOf(row).some((adapter) => adapter.supports(route)), `${row.protocol} ${row.kind} ${row.asset} on ${row.network} (${row.venueId})`);
    }
    // The round-7 rows that land live with this package (protocols design 3.2).
    for (const venue of ["ethereum:aave-v3:usdt", "arbitrum:compound-v3:usdt0", "polygon:morpho:compound-usdt", "ethereum:morpho:steakhouse-eth", "arbitrum-sepolia:aave-v3:usdc"]) {
      assert.ok(rows.some((row) => row.venueId === venue), venue);
    }
  });

  it("every EVM swap row of a wired DEX and every Ethereum stake row of a wired LST is supported", () => {
    const rows = capabilityIndex().filter((row) =>
      ((row.kind === "swap" && CHAINS[row.network].vm === "evm") || (row.kind === "stake" && row.network === "ethereum")) &&
      adaptersOf(row).length > 0 && row.protocol !== "relay");
    assert.ok(rows.some((row) => row.protocol === "uniswap-v3") && rows.some((row) => row.protocol === "lido"));
    for (const row of rows) {
      const route = routeOf(row);
      assert.ok(route, `${row.protocol} ${row.kind} ${row.network}`);
      assert.ok(adaptersOf(row).some((adapter) => adapter.supports(route)), `${row.protocol} ${row.kind} on ${row.network}`);
    }
  });

  it("a wired lending adapter supports no venue the index does not list", () => {
    for (const adapter of ADAPTERS) {
      const rows = capabilityIndex(undefined, "deposit").filter((row) => row.protocol === adapter.id);
      if (rows.length === 0) continue;
      for (const network of Object.keys(CHAINS) as NetworkKey[]) {
        if (CHAINS[network].vm !== "evm") continue;
        for (const symbol of ["USDC", "USDT", "USDT0", "WETH", "wstETH", "cbETH", "cbBTC", "DAI"]) {
          const descriptor = findAssetBySymbol(network, symbol);
          if (!descriptor || descriptor.symbol !== symbol) continue;
          const input = resolvedFromDescriptor(descriptor);
          const supported = adapter.supports({ kind: "deposit", network, destinationNetwork: network, input, output: input });
          const listed = rows.some((row) => row.network === network && row.asset === symbol);
          assert.equal(supported, listed, `${adapter.id} deposit ${symbol} on ${network}`);
        }
      }
    }
  });
});
