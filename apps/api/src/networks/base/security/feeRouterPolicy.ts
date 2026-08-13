import { getAddress, type Address } from "viem";
import {
  AAVE_V3_BASE,
  BASE_ERC4626_VAULTS,
  BASE_STAKING_CONTRACTS,
  BASE_SWAP_EXPANSION_CANDIDATES,
  COMPOUND_V3_BASE,
  MOONWELL_BASE,
  MORPHO_BLUE_BASE,
} from "../protocols.js";
import { ROUTERS } from "../contracts.js";

export interface FeeRouterPolicyTarget {
  readonly id: string;
  readonly target: Address;
  readonly reason: string;
}

export const BASE_FEE_ROUTER = getAddress(
  "0x8214b00f49da60684ce4b2c0b16ddb8a29d777cf",
);
export const BASE_FEE_ROUTER_DEPLOYMENT_BLOCK = 47_558_397n;
export const BASE_FEE_ROUTER_EXPECTED_OWNER = getAddress(
  "0xff3a3cfc42d27e85dba9ea85f0bfec34bd632f9a",
);
export const BASE_FEE_ROUTER_EXPECTED_TREASURY = BASE_FEE_ROUTER_EXPECTED_OWNER;
export const BASE_FEE_ROUTER_EXPECTED_FEE_BPS = 10n;

export const BASE_ACROSS_SPOKE_POOL = getAddress(
  "0x09aea4b2242abc8bb4bb78d537a67a245a7bec64",
);

export const BASE_FEE_ROUTER_REQUIRED_TARGETS = [
  {
    id: "aerodrome-v1-router",
    target: ROUTERS.AERO_V1,
    reason: "Legacy swap route with explicit recipient binding.",
  },
  {
    id: "aerodrome-slipstream-router",
    target: ROUTERS.AERO_SLIPSTREAM,
    reason: "Legacy swap route with explicit recipient binding.",
  },
  {
    id: "uniswap-v3-swap-router02",
    target: ROUTERS.UNI_V3,
    reason: "Legacy swap route with selector and recipient validation.",
  },
  {
    id: "uniswap-v2-router02",
    target: ROUTERS.UNI_V2,
    reason: "Legacy swap route with explicit recipient binding.",
  },
  {
    id: "alienbase-router",
    target: ROUTERS.ALIEN_BASE,
    reason: "Legacy swap route with explicit recipient binding.",
  },
  {
    id: "pancakeswap-v2-router",
    target: ROUTERS.PANCAKE_V2,
    reason: "Legacy swap route with explicit recipient binding.",
  },
  {
    id: "pancakeswap-smart-router",
    target: ROUTERS.PANCAKE_SMART_ROUTER,
    reason: "Legacy swap route with selector and recipient validation.",
  },
  {
    id: "across-v3-spoke-pool",
    target: BASE_ACROSS_SPOKE_POOL,
    reason: "Base bridge route with quote and recipient binding.",
  },
] as const satisfies readonly FeeRouterPolicyTarget[];

export const BASE_FEE_ROUTER_HELD_SWAP_TARGETS = [
  {
    id: "sushiswap-v2-router02",
    target: ROUTERS.SUSHI_V2,
    reason: "Held for a typed adapter; V1 is address-only.",
  },
  {
    id: "baseswap-router",
    target: ROUTERS.BASESWAP,
    reason: "Discovery-only until route-specific binding tests pass.",
  },
  {
    id: "swapbased-router",
    target: ROUTERS.SWAPBASED,
    reason: "Discovery-only until route-specific binding tests pass.",
  },
] as const satisfies readonly FeeRouterPolicyTarget[];

export const BASE_FEE_ROUTER_STALE_TARGETS = [
  {
    id: "stale-moonwell-weth-market",
    target: getAddress("0x628ff693d22751d3691740560fcfec11e03a3a95"),
    reason: "Stale Moonwell market address.",
  },
  {
    id: "stale-moonwell-cbbtc-market",
    target: getAddress("0xcc970d2bb6cb7d9e0eebb17c7674251214a3d0ae"),
    reason: "Stale Moonwell market address.",
  },
  {
    id: "sushiswap-v2-factory-not-router",
    target: getAddress("0x71524b4f93c58fcbf659783284e38825f0622859"),
    reason: "Factory address cannot be an executable swap router target.",
  },
] as const satisfies readonly FeeRouterPolicyTarget[];

export const BASE_FEE_ROUTER_EXPANSION_TARGETS =
  BASE_SWAP_EXPANSION_CANDIDATES.map(({ id, target, integrationStatus }) => ({
    id: `expansion:${id}`,
    target,
    reason: `Not production-enabled (${integrationStatus}).`,
  })) satisfies readonly FeeRouterPolicyTarget[];

export const BASE_FEE_ROUTER_DIRECT_ONLY_TARGETS = [
  {
    id: "direct:aave-v3-pool",
    target: AAVE_V3_BASE.pool,
    reason: "Direct lending ownership semantics.",
  },
  ...MOONWELL_BASE.markets.map(({ token, market }) => ({
    id: `direct:moonwell:${token.toLowerCase()}`,
    target: market,
    reason: "Direct lending ownership semantics.",
  })),
  ...COMPOUND_V3_BASE.markets.map(({ token, comet }) => ({
    id: `direct:compound-v3:${token.toLowerCase()}`,
    target: comet,
    reason: "Direct lending ownership semantics.",
  })),
  ...BASE_ERC4626_VAULTS.map(({ id, vault }) => ({
    id: `direct:erc4626:${id}`,
    target: vault,
    reason: "Direct vault receiver/ownership semantics.",
  })),
  ...Object.entries(BASE_STAKING_CONTRACTS).map(([id, target]) => ({
    id: `direct:staking:${id}`,
    target,
    reason: "Direct staking ownership semantics.",
  })),
  {
    id: "direct:morpho-blue-core",
    target: MORPHO_BLUE_BASE.core,
    reason: "Exact MarketParams binding is unavailable in V1.",
  },
] satisfies readonly FeeRouterPolicyTarget[];

export const BASE_FEE_ROUTER_FORBIDDEN_TARGETS = [
  ...BASE_FEE_ROUTER_HELD_SWAP_TARGETS,
  ...BASE_FEE_ROUTER_STALE_TARGETS,
  ...BASE_FEE_ROUTER_EXPANSION_TARGETS,
  ...BASE_FEE_ROUTER_DIRECT_ONLY_TARGETS,
] satisfies readonly FeeRouterPolicyTarget[];

export function assertFeeRouterPolicyIsInternallyConsistent(): void {
  const required = new Set<string>();
  for (const { id, target } of BASE_FEE_ROUTER_REQUIRED_TARGETS) {
    const key = target.toLowerCase();
    if (required.has(key)) {
      throw new Error(`DUPLICATE_REQUIRED_FEE_ROUTER_TARGET:${id}:${target}`);
    }
    required.add(key);
  }

  const forbidden = new Set<string>();
  for (const { id, target } of BASE_FEE_ROUTER_FORBIDDEN_TARGETS) {
    const key = target.toLowerCase();
    if (required.has(key)) {
      throw new Error(`CONFLICTING_FEE_ROUTER_TARGET:${id}:${target}`);
    }
    if (forbidden.has(key)) {
      throw new Error(`DUPLICATE_FORBIDDEN_FEE_ROUTER_TARGET:${id}:${target}`);
    }
    forbidden.add(key);
  }
}
