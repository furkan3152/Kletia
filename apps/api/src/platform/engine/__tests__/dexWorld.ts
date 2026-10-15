/**
 * In-process contract state of one pinned concentrated-liquidity deployment
 * (Uniswap V3 dialect incl. PancakeSwap V3 and Uniswap V3 on Arbitrum
 * Sepolia, or Algebra / Camelot), on top of lendingChain's eth_call mock.
 * Used by dexPancake, dexAlgebra and dexTestnet.
 */
import { getAddress, zeroAddress, type Abi, type Address } from "viem";
import type { DexDeployment } from "@kletia/core";
import {
  ALGEBRA_FACTORY_ABI,
  ALGEBRA_QUOTER_ABI,
  ALGEBRA_ROUTER_ABI,
  PINS_ABI,
  POOL_ABI,
  SWAP_ROUTER02_ABI,
  UNISWAP_FACTORY_ABI,
  UNISWAP_QUOTER_ABI,
} from "../adapters/dex/concentrated.js";
import { Revert, type LendingChain } from "./lendingChain.js";

export interface DexWorld {
  readonly deployment: DexDeployment;
  /** Pool by unordered pair and tier (Algebra: tier 0). */
  readonly pools: Map<string, Address>;
  /** Factory each pool reports (defaults to the pin). */
  readonly poolFactory: Map<string, string>;
  /** amountOut by `${tokenIn}:${tokenOut}:${tier}`; missing: the quoter reverts. */
  readonly quotes: Map<string, bigint>;
  /** amountOut by encoded path (lower case). */
  readonly paths: Map<string, bigint>;
  /** What the router, quoter and factory report (each defaults to the pin). */
  readonly reported: {
    routerFactory: string;
    routerWrapped: string;
    routerDeployer: string;
    quoterFactory: string;
    quoterWrapped: string;
    quoterDeployer: string;
    factoryDeployer: string;
  };
}

export const pairKey = (a: string, b: string, tier: number) => [a.toLowerCase(), b.toLowerCase()].sort().join(":") + `:${tier}`;
export const quoteKey = (a: string, b: string, tier: number) => `${a.toLowerCase()}:${b.toLowerCase()}:${tier}`;

let poolCounter = 0;

/** Mocks the deployment's factory, quoter and router. */
export function mockDex(chain: LendingChain, deployment: DexDeployment): DexWorld {
  const deployer = deployment.poolDeployer ?? zeroAddress;
  const world: DexWorld = {
    deployment,
    pools: new Map(),
    poolFactory: new Map(),
    quotes: new Map(),
    paths: new Map(),
    reported: {
      routerFactory: deployment.factory,
      routerWrapped: deployment.wrappedNative,
      routerDeployer: deployer,
      quoterFactory: deployment.factory,
      quoterWrapped: deployment.wrappedNative,
      quoterDeployer: deployer,
      factoryDeployer: deployer,
    },
  };
  const quoted = (tokenIn: string, tokenOut: string, tier: number): bigint => {
    const out = world.quotes.get(quoteKey(tokenIn, tokenOut, tier));
    if (out === undefined || !world.pools.has(pairKey(tokenIn, tokenOut, tier))) throw new Revert();
    return out;
  };
  const pathOut = (path: unknown): bigint => {
    const out = world.paths.get(String(path).toLowerCase());
    if (out === undefined) throw new Revert();
    return out;
  };
  if (deployment.dialect === "algebra") {
    chain.contract(deployment.factory, [...PINS_ABI, ...ALGEBRA_FACTORY_ABI] as unknown as Abi, {
      poolByPair: ([a, b]) => world.pools.get(pairKey(String(a), String(b), 0)) ?? zeroAddress,
      poolDeployer: () => world.reported.factoryDeployer,
    });
    chain.contract(deployment.quoter as string, [...PINS_ABI, ...ALGEBRA_QUOTER_ABI] as unknown as Abi, {
      factory: () => world.reported.quoterFactory,
      WNativeToken: () => world.reported.quoterWrapped,
      poolDeployer: () => world.reported.quoterDeployer,
      quoteExactInputSingle: ([tokenIn, tokenOut]) => [quoted(String(tokenIn), String(tokenOut), 0), 100],
      quoteExactInput: ([path]) => [pathOut(path), [100, 100]],
    });
    chain.contract(deployment.router, [...PINS_ABI, ...ALGEBRA_ROUTER_ABI] as unknown as Abi, {
      factory: () => world.reported.routerFactory,
      WNativeToken: () => world.reported.routerWrapped,
      poolDeployer: () => world.reported.routerDeployer,
      multicall: () => [],
    });
    return world;
  }
  chain.contract(deployment.factory, [...PINS_ABI, ...UNISWAP_FACTORY_ABI] as unknown as Abi, {
    getPool: ([a, b, fee]) => world.pools.get(pairKey(String(a), String(b), Number(fee))) ?? zeroAddress,
    poolDeployer: () => world.reported.factoryDeployer,
  });
  chain.contract(deployment.quoter as string, [...PINS_ABI, ...UNISWAP_QUOTER_ABI] as unknown as Abi, {
    factory: () => world.reported.quoterFactory,
    WETH9: () => world.reported.quoterWrapped,
    deployer: () => world.reported.quoterDeployer,
    quoteExactInputSingle: ([params]) => {
      const { tokenIn, tokenOut, fee } = params as { tokenIn: string; tokenOut: string; fee: number };
      return [quoted(tokenIn, tokenOut, fee), 0n, 1, 90_000n];
    },
    quoteExactInput: ([path]) => [pathOut(path), [], [], 160_000n],
  });
  chain.contract(deployment.router, [...PINS_ABI, ...SWAP_ROUTER02_ABI] as unknown as Abi, {
    factory: () => world.reported.routerFactory,
    WETH9: () => world.reported.routerWrapped,
    deployer: () => world.reported.routerDeployer,
    multicall: () => [],
  });
  return world;
}

/** Adds a pool the factory returns (reporting the pinned factory unless overridden) and its quotes both ways. */
export function addPool(chain: LendingChain, world: DexWorld, a: string, b: string, tier: number, out?: { readonly ab?: bigint; readonly ba?: bigint }): Address {
  poolCounter += 1;
  const pool = getAddress(`0x${(0xcafe00000 + poolCounter).toString(16).padStart(40, "0")}`);
  world.pools.set(pairKey(a, b, tier), pool);
  chain.contract(pool, POOL_ABI as unknown as Abi, { factory: () => world.poolFactory.get(pool.toLowerCase()) ?? world.deployment.factory });
  if (out?.ab !== undefined) world.quotes.set(quoteKey(a, b, tier), out.ab);
  if (out?.ba !== undefined) world.quotes.set(quoteKey(b, a, tier), out.ba);
  return pool;
}
