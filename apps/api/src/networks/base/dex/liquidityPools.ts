import { getAddress, zeroAddress, type Address } from "viem";
import { basePublicClient } from "../../../shared/config/client.js";
import { ROUTERS } from "../contracts.js";
import { AERO_FACTORY_ABI, UNI_FACTORY_ABI } from "./constants.js";

const ROUTER_FACTORY_ABI = [
  {
    inputs: [],
    name: "factory",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export const LIQUIDITY_POOL_ABI = [
  {
    inputs: [],
    name: "token0",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "token1",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "getReserves",
    outputs: [
      { name: "reserve0", type: "uint112" },
      { name: "reserve1", type: "uint112" },
      { name: "blockTimestampLast", type: "uint32" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "totalSupply",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export interface LiquidityPoolSnapshot {
  readonly protocolId:
    | "aerodrome"
    | "uniswap"
    | "alienbase"
    | "pancakeswap"
    | "sushiswap"
    | "baseswap"
    | "swapbased";
  readonly protocolName: string;
  readonly router: Address;
  readonly factory: Address;
  readonly pool: Address;
  readonly kind: "aerodrome" | "v2";
  readonly stable: boolean;
  readonly tokenA: Address;
  readonly tokenB: Address;
  readonly reserveA: bigint;
  readonly reserveB: bigint;
  readonly totalSupply: bigint;
  readonly observedAt: string;
  readonly observedBlock: bigint;
  readonly discoveryAttemptCount: number;
  readonly unavailableSourceCount: number;
  readonly absentPoolCount: number;
}

class LiquidityPoolAbsentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiquidityPoolAbsentError";
  }
}

const V2_LIQUIDITY_ROUTERS = [
  {
    protocolId: "uniswap",
    protocolName: "Uniswap V2",
    router: ROUTERS.UNI_V2,
  },
  {
    protocolId: "alienbase",
    protocolName: "Alien Base",
    router: ROUTERS.ALIEN_BASE,
  },
  {
    protocolId: "pancakeswap",
    protocolName: "PancakeSwap V2",
    router: ROUTERS.PANCAKE_V2,
  },
  {
    protocolId: "sushiswap",
    protocolName: "SushiSwap V2",
    router: ROUTERS.SUSHI_V2,
  },
  {
    protocolId: "baseswap",
    protocolName: "BaseSwap",
    router: ROUTERS.BASESWAP,
  },
  {
    protocolId: "swapbased",
    protocolName: "SwapBased",
    router: ROUTERS.SWAPBASED,
  },
] as const;

async function readPool(
  input: Omit<
    LiquidityPoolSnapshot,
    | "tokenA"
    | "tokenB"
    | "reserveA"
    | "reserveB"
    | "totalSupply"
    | "observedAt"
    | "observedBlock"
    | "discoveryAttemptCount"
    | "unavailableSourceCount"
    | "absentPoolCount"
  >,
  tokenA: Address,
  tokenB: Address,
  observedBlock: bigint,
): Promise<LiquidityPoolSnapshot> {
  const [token0, token1, reserves, totalSupply] = await Promise.all([
    basePublicClient.readContract({
      address: input.pool,
      abi: LIQUIDITY_POOL_ABI,
      functionName: "token0",
      blockNumber: observedBlock,
    }),
    basePublicClient.readContract({
      address: input.pool,
      abi: LIQUIDITY_POOL_ABI,
      functionName: "token1",
      blockNumber: observedBlock,
    }),
    basePublicClient.readContract({
      address: input.pool,
      abi: LIQUIDITY_POOL_ABI,
      functionName: "getReserves",
      blockNumber: observedBlock,
    }),
    basePublicClient.readContract({
      address: input.pool,
      abi: LIQUIDITY_POOL_ABI,
      functionName: "totalSupply",
      blockNumber: observedBlock,
    }),
  ]);
  const exactForward =
    token0.toLowerCase() === tokenA.toLowerCase() &&
    token1.toLowerCase() === tokenB.toLowerCase();
  const exactReverse =
    token0.toLowerCase() === tokenB.toLowerCase() &&
    token1.toLowerCase() === tokenA.toLowerCase();
  if (!exactForward && !exactReverse) {
    throw new Error("Liquidity pool token binding does not match the request.");
  }
  if (reserves[0] <= 0n || reserves[1] <= 0n || totalSupply <= 0n) {
    throw new Error("Liquidity pool has no active reserves.");
  }

  return {
    ...input,
    tokenA,
    tokenB,
    reserveA: exactForward ? reserves[0] : reserves[1],
    reserveB: exactForward ? reserves[1] : reserves[0],
    totalSupply,
    observedAt: new Date().toISOString(),
    observedBlock,
    discoveryAttemptCount: 0,
    unavailableSourceCount: 0,
    absentPoolCount: 0,
  };
}

async function settleTasksBounded<T>(
  tasks: readonly (() => Promise<T>)[],
  concurrency: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
      while (nextIndex < tasks.length) {
        const index = nextIndex++;
        try {
          results[index] = {
            status: "fulfilled",
            value: await tasks[index](),
          };
        } catch (reason) {
          results[index] = { status: "rejected", reason };
        }
      }
    }),
  );
  return results;
}

export async function discoverLiquidityPools(
  tokenAInput: Address,
  tokenBInput: Address,
): Promise<LiquidityPoolSnapshot[]> {
  const tokenA = getAddress(tokenAInput);
  const tokenB = getAddress(tokenBInput);
  if (tokenA === tokenB) return [];
  let observedBlock: bigint;
  try {
    observedBlock = await basePublicClient.getBlockNumber();
  } catch {
    throw Object.assign(
      new Error(
        "Base liquidity discovery could not pin a live block snapshot.",
      ),
      {
        code: "LIQUIDITY_DISCOVERY_UNAVAILABLE",
        statusCode: 503,
      },
    );
  }

  const tasks: Array<() => Promise<LiquidityPoolSnapshot>> = [];
  for (const stable of [false, true] as const) {
    tasks.push(async () => {
      const poolResult = await basePublicClient.readContract({
        address: ROUTERS.AERO_FACTORY,
        abi: AERO_FACTORY_ABI,
        functionName: "getPool",
        args: [tokenA, tokenB, stable],
        blockNumber: observedBlock,
      });
      if (poolResult === zeroAddress) {
        throw new LiquidityPoolAbsentError("Aerodrome pool does not exist.");
      }
      const pool = getAddress(poolResult);
      return readPool(
        {
          protocolId: "aerodrome",
          protocolName: `Aerodrome ${stable ? "Stable" : "Volatile"}`,
          router: ROUTERS.AERO_V1,
          factory: ROUTERS.AERO_FACTORY,
          pool,
          kind: "aerodrome",
          stable,
        },
        tokenA,
        tokenB,
        observedBlock,
      );
    });
  }

  for (const definition of V2_LIQUIDITY_ROUTERS) {
    tasks.push(async () => {
      const factoryResult = await basePublicClient.readContract({
        address: definition.router,
        abi: ROUTER_FACTORY_ABI,
        functionName: "factory",
        blockNumber: observedBlock,
      });
      const factory = getAddress(factoryResult);
      const poolResult = await basePublicClient.readContract({
        address: factory,
        abi: UNI_FACTORY_ABI,
        functionName: "getPair",
        args: [tokenA, tokenB],
        blockNumber: observedBlock,
      });
      if (poolResult === zeroAddress) {
        throw new LiquidityPoolAbsentError(
          `${definition.protocolName} pool does not exist.`,
        );
      }
      const pool = getAddress(poolResult);
      return readPool(
        {
          ...definition,
          factory,
          pool,
          kind: "v2",
          stable: false,
        },
        tokenA,
        tokenB,
        observedBlock,
      );
    });
  }

  const settled = await settleTasksBounded(tasks, 4);
  const pools = settled.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  const absentPoolCount = settled.filter(
    (result) =>
      result.status === "rejected" &&
      result.reason instanceof LiquidityPoolAbsentError,
  ).length;
  const unavailableSourceCount =
    settled.length - pools.length - absentPoolCount;
  if (pools.length === 0 && unavailableSourceCount > 0) {
    throw Object.assign(
      new Error(
        "Base liquidity discovery could not validate any factory-bound pool because one or more RPC or binding reads failed.",
      ),
      {
        code: "LIQUIDITY_DISCOVERY_UNAVAILABLE",
        statusCode: 503,
      },
    );
  }
  const uniquePools = [
    ...new Map(
      pools.map((pool) => [
        `${pool.router.toLowerCase()}:${pool.pool.toLowerCase()}:${pool.stable}`,
        pool,
      ]),
    ).values(),
  ];
  return uniquePools.map((pool) => ({
    ...pool,
    discoveryAttemptCount: tasks.length,
    unavailableSourceCount,
    absentPoolCount,
  }));
}
