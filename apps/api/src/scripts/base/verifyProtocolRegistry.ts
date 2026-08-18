import { getAddress, parseAbi, type Address } from "viem";
import { basePublicClient } from "../../shared/config/client.js";
import {
  AAVE_V3_BASE,
  BASE_ERC4626_VAULTS,
  BASE_STAKING_CONTRACTS,
  BASE_SWAP_EXPANSION_CANDIDATES,
  BASE_TOKEN_REGISTRY,
  COMPOUND_V3_BASE,
  MOONWELL_BASE,
} from "../../networks/base/protocols.js";
import { ROUTERS } from "../../networks/base/contracts.js";
import { discoverLiquidityPools } from "../../networks/base/dex/liquidityPools.js";
import { getLendingOpportunities } from "../../networks/base/lending/markets.js";
import {
  BASE_FEE_ROUTER,
  BASE_FEE_ROUTER_DEPLOYMENT_BLOCK,
  BASE_FEE_ROUTER_DIRECT_ONLY_TARGETS,
  BASE_FEE_ROUTER_EXPECTED_FEE_BPS,
  BASE_FEE_ROUTER_EXPECTED_OWNER,
  BASE_FEE_ROUTER_EXPECTED_TREASURY,
  BASE_FEE_ROUTER_EXPANSION_TARGETS,
  BASE_FEE_ROUTER_FORBIDDEN_TARGETS,
  BASE_FEE_ROUTER_HELD_SWAP_TARGETS,
  BASE_FEE_ROUTER_REQUIRED_TARGETS,
  BASE_FEE_ROUTER_STALE_TARGETS,
  assertFeeRouterPolicyIsInternallyConsistent,
  type FeeRouterPolicyTarget,
} from "../../networks/base/security/feeRouterPolicy.js";

const BASE_BLOCKSCOUT_LOGS_API = "https://base.blockscout.com/api";
const TARGET_APPROVED_TOPIC =
  "0x1544fe18ad8a1b607a5147fee4bed9273c6c8c53b721318602ef311de4f4c939";
const BLOCKSCOUT_LOG_CAP = 1_000;

const AAVE_DATA_ABI = parseAbi([
  "function getReserveConfigurationData(address asset) view returns (uint256 decimals,uint256 ltv,uint256 liquidationThreshold,uint256 liquidationBonus,uint256 reserveFactor,bool usageAsCollateralEnabled,bool borrowingEnabled,bool stableBorrowRateEnabled,bool isActive,bool isFrozen)",
]);
const UNDERLYING_ABI = parseAbi([
  "function underlying() view returns (address)",
]);
const COMET_ABI = parseAbi(["function baseToken() view returns (address)"]);
const ERC4626_ABI = parseAbi(["function asset() view returns (address)"]);
const FEE_ROUTER_ABI = parseAbi([
  "function approvedTargets(address target) view returns (bool)",
  "function owner() view returns (address)",
  "function feeTreasury() view returns (address)",
  "function feeBasisPoints() view returns (uint256)",
  "function paused() view returns (bool)",
]);
const V2_ROUTER_IDENTITY_ABI = parseAbi([
  "function factory() view returns (address)",
  "function WETH() view returns (address)",
]);
const AERODROME_ROUTER_IDENTITY_ABI = parseAbi([
  "function defaultFactory() view returns (address)",
  "function factoryRegistry() view returns (address)",
]);
const AERODROME_FACTORY_REGISTRY_ABI = parseAbi([
  "function isPoolFactoryApproved(address factory) view returns (bool)",
]);

async function mapBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const output: R[] = new Array(items.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        output[index] = await worker(items[index]);
      }
    }),
  );
  return output;
}

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

async function feeRouterApproval(target: Address, blockNumber: bigint) {
  return basePublicClient.readContract({
    address: BASE_FEE_ROUTER,
    abi: FEE_ROUTER_ABI,
    functionName: "approvedTargets",
    args: [target],
    blockNumber,
  });
}

async function feeRouterPolicyApprovals(
  targets: readonly FeeRouterPolicyTarget[],
  blockNumber: bigint,
) {
  return mapBounded(targets, 4, async ({ id, target, reason }) => ({
    id,
    target,
    reason,
    approved: await feeRouterApproval(target, blockNumber),
  }));
}

type BlockscoutApprovalLog = {
  address: string;
  blockNumber: string;
  data: string;
  topics: Array<string | null>;
  transactionHash: string;
};

async function fetchBlockscoutApprovalLogs(
  fromBlock: bigint,
  toBlock: bigint,
): Promise<BlockscoutApprovalLog[]> {
  const query = new URLSearchParams({
    module: "logs",
    action: "getLogs",
    fromBlock: fromBlock.toString(),
    toBlock: toBlock.toString(),
    address: BASE_FEE_ROUTER,
    topic0: TARGET_APPROVED_TOPIC,
  });
  const response = await fetch(`${BASE_BLOCKSCOUT_LOGS_API}?${query}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`Base Blockscout log HTTP ${response.status}.`);
  }
  const body = (await response.json()) as {
    status?: string;
    message?: string;
    result?: unknown;
  };
  if (!Array.isArray(body.result)) {
    if (String(body.result || "").toLowerCase().includes("no records")) {
      return [];
    }
    throw new Error(
      `Base Blockscout log response invalid: ${body.message || "unknown"}.`,
    );
  }
  if (body.result.length < BLOCKSCOUT_LOG_CAP) {
    return body.result as BlockscoutApprovalLog[];
  }
  if (fromBlock === toBlock) {
    throw new Error("Base Blockscout single-block log cap reached.");
  }
  const midpoint = (fromBlock + toBlock) / 2n;
  const [left, right] = await Promise.all([
    fetchBlockscoutApprovalLogs(fromBlock, midpoint),
    fetchBlockscoutApprovalLogs(midpoint + 1n, toBlock),
  ]);
  return [...left, ...right];
}

async function scanFeeRouterApprovalHistory(toBlock: bigint) {
  const logs = await fetchBlockscoutApprovalLogs(
    BASE_FEE_ROUTER_DEPLOYMENT_BLOCK,
    toBlock,
  );
  const finalEventState = new Map<
    string,
    {
      target: Address;
      approved: boolean;
      blockNumber: bigint;
      transactionHash: `0x${string}`;
    }
  >();
  for (const log of logs) {
    const blockNumber = BigInt(log.blockNumber);
    const targetTopic = log.topics?.[1] || "";
    if (
      getAddress(log.address) !== BASE_FEE_ROUTER ||
      log.topics?.[0]?.toLowerCase() !== TARGET_APPROVED_TOPIC ||
      !/^0x[0-9a-f]{64}$/iu.test(targetTopic) ||
      !/^0x[0-9a-f]{64}$/iu.test(log.data) ||
      !/^0x[0-9a-f]{64}$/iu.test(log.transactionHash) ||
      blockNumber < BASE_FEE_ROUTER_DEPLOYMENT_BLOCK ||
      blockNumber > toBlock
    ) {
      throw new Error("Base Blockscout returned a malformed approval log.");
    }
    const approvedWord = BigInt(log.data);
    if (approvedWord !== 0n && approvedWord !== 1n) {
      throw new Error("Base Blockscout returned a non-boolean approval state.");
    }
    const target = getAddress(`0x${targetTopic.slice(-40)}`);
    finalEventState.set(target.toLowerCase(), {
      target,
      approved: approvedWord === 1n,
      blockNumber,
      transactionHash: log.transactionHash as `0x${string}`,
    });
  }

  return { logs, finalEventState };
}

async function main() {
  assertFeeRouterPolicyIsInternallyConsistent();
  const blockNumber = await basePublicClient.getBlockNumber();
  const tokenFor = (symbol: keyof typeof BASE_TOKEN_REGISTRY) =>
    BASE_TOKEN_REGISTRY[symbol].address;
  const currentSwapTargets = [
    ROUTERS.AERO_V1,
    ROUTERS.AERO_SLIPSTREAM,
    ROUTERS.UNI_V2,
    ROUTERS.UNI_V3,
    ROUTERS.ALIEN_BASE,
    ROUTERS.PANCAKE_V2,
    ROUTERS.PANCAKE_SMART_ROUTER,
    ROUTERS.SUSHI_V2,
    ROUTERS.BASESWAP,
    ROUTERS.SWAPBASED,
  ];
  const executionTargets = [
    AAVE_V3_BASE.pool,
    ...MOONWELL_BASE.markets.map(({ market }) => market),
    ...COMPOUND_V3_BASE.markets.map(({ comet }) => comet),
    ...BASE_ERC4626_VAULTS.map(({ vault }) => vault),
    ...Object.values(BASE_STAKING_CONTRACTS),
    ...currentSwapTargets,
    ...BASE_SWAP_EXPANSION_CANDIDATES.map(({ target }) => target),
  ];
  const uniqueTargets = [
    ...new Map(
      executionTargets.map((target) => [target.toLowerCase(), target]),
    ).values(),
  ];
  const failures: string[] = [];

  const [
    feeRouterCode,
    feeRouterOwner,
    feeRouterTreasury,
    feeRouterFeeBps,
    feeRouterPaused,
    approvalHistory,
  ] = await Promise.all([
    basePublicClient.getCode({
      address: BASE_FEE_ROUTER,
      blockNumber,
    }),
    basePublicClient.readContract({
      address: BASE_FEE_ROUTER,
      abi: FEE_ROUTER_ABI,
      functionName: "owner",
      blockNumber,
    }),
    basePublicClient.readContract({
      address: BASE_FEE_ROUTER,
      abi: FEE_ROUTER_ABI,
      functionName: "feeTreasury",
      blockNumber,
    }),
    basePublicClient.readContract({
      address: BASE_FEE_ROUTER,
      abi: FEE_ROUTER_ABI,
      functionName: "feeBasisPoints",
      blockNumber,
    }),
    basePublicClient.readContract({
      address: BASE_FEE_ROUTER,
      abi: FEE_ROUTER_ABI,
      functionName: "paused",
      blockNumber,
    }),
    scanFeeRouterApprovalHistory(blockNumber),
  ]);
  if (!feeRouterCode || feeRouterCode === "0x") {
    failures.push(`FEE_ROUTER_NO_RUNTIME_CODE:${BASE_FEE_ROUTER}`);
  }
  if (!sameAddress(feeRouterOwner, BASE_FEE_ROUTER_EXPECTED_OWNER)) {
    failures.push(`FEE_ROUTER_OWNER_MISMATCH:${feeRouterOwner}`);
  }
  if (!sameAddress(feeRouterTreasury, BASE_FEE_ROUTER_EXPECTED_TREASURY)) {
    failures.push(`FEE_ROUTER_TREASURY_MISMATCH:${feeRouterTreasury}`);
  }
  if (feeRouterFeeBps !== BASE_FEE_ROUTER_EXPECTED_FEE_BPS) {
    failures.push(`FEE_ROUTER_FEE_MISMATCH:${feeRouterFeeBps}`);
  }
  if (feeRouterPaused) failures.push("FEE_ROUTER_PAUSED");

  const codeChecks = await mapBounded(uniqueTargets, 4, async (target) => {
    const code = await basePublicClient.getCode({ address: target });
    const ok = Boolean(code && code !== "0x");
    if (!ok) failures.push(`NO_RUNTIME_CODE:${target}`);
    return { target, ok, byteLength: ok ? (code!.length - 2) / 2 : 0 };
  });

  const v2RouterIdentityChecks = await mapBounded(
    [
      ROUTERS.UNI_V2,
      ROUTERS.ALIEN_BASE,
      ROUTERS.PANCAKE_V2,
      ROUTERS.SUSHI_V2,
      ROUTERS.BASESWAP,
      ROUTERS.SWAPBASED,
    ],
    3,
    async (router) => {
      const [factory, weth] = await Promise.all([
        basePublicClient.readContract({
          address: router,
          abi: V2_ROUTER_IDENTITY_ABI,
          functionName: "factory",
        }),
        basePublicClient.readContract({
          address: router,
          abi: V2_ROUTER_IDENTITY_ABI,
          functionName: "WETH",
        }),
      ]);
      const factoryCode = await basePublicClient.getCode({
        address: factory,
      });
      const factoryHasCode = Boolean(factoryCode && factoryCode !== "0x");
      const canonicalWeth = sameAddress(weth, BASE_TOKEN_REGISTRY.WETH.address);
      if (!factoryHasCode) {
        failures.push(`V2_ROUTER_FACTORY_NO_CODE:${router}:${factory}`);
      }
      if (!canonicalWeth) {
        failures.push(`V2_ROUTER_WETH_MISMATCH:${router}:${weth}`);
      }
      return {
        router,
        factory,
        weth,
        factoryHasCode,
        canonicalWeth,
      };
    },
  );

  const [aerodromeDefaultFactory, aerodromeFactoryRegistry] = await Promise.all(
    [
      basePublicClient.readContract({
        address: ROUTERS.AERO_V1,
        abi: AERODROME_ROUTER_IDENTITY_ABI,
        functionName: "defaultFactory",
      }),
      basePublicClient.readContract({
        address: ROUTERS.AERO_V1,
        abi: AERODROME_ROUTER_IDENTITY_ABI,
        functionName: "factoryRegistry",
      }),
    ],
  );
  const aerodromeFactoryApproved = await basePublicClient.readContract({
    address: aerodromeFactoryRegistry,
    abi: AERODROME_FACTORY_REGISTRY_ABI,
    functionName: "isPoolFactoryApproved",
    args: [ROUTERS.AERO_FACTORY],
  });
  if (!sameAddress(aerodromeDefaultFactory, ROUTERS.AERO_FACTORY)) {
    failures.push(
      `AERODROME_DEFAULT_FACTORY_MISMATCH:${aerodromeDefaultFactory}`,
    );
  }
  if (!aerodromeFactoryApproved) {
    failures.push(`AERODROME_FACTORY_NOT_APPROVED:${ROUTERS.AERO_FACTORY}`);
  }

  const aaveChecks = await mapBounded(
    AAVE_V3_BASE.reserves,
    3,
    async ({ token }) => {
      const configuration = await basePublicClient.readContract({
        address: AAVE_V3_BASE.protocolDataProvider,
        abi: AAVE_DATA_ABI,
        functionName: "getReserveConfigurationData",
        args: [tokenFor(token)],
      });
      const active = configuration[8];
      if (!active) failures.push(`AAVE_RESERVE_INACTIVE:${token}`);
      return { token, active, frozen: configuration[9] };
    },
  );

  const moonwellChecks = await mapBounded(
    MOONWELL_BASE.markets,
    3,
    async ({ token, market }) => {
      const underlying = await basePublicClient.readContract({
        address: market,
        abi: UNDERLYING_ABI,
        functionName: "underlying",
      });
      const ok = sameAddress(underlying, tokenFor(token));
      if (!ok) failures.push(`MOONWELL_UNDERLYING_MISMATCH:${token}`);
      return { token, market, underlying, ok };
    },
  );

  const compoundChecks = await mapBounded(
    COMPOUND_V3_BASE.markets,
    3,
    async ({ token, comet }) => {
      const baseToken = await basePublicClient.readContract({
        address: comet,
        abi: COMET_ABI,
        functionName: "baseToken",
      });
      const ok = sameAddress(baseToken, tokenFor(token));
      if (!ok) failures.push(`COMPOUND_BASE_TOKEN_MISMATCH:${token}`);
      return { token, comet, baseToken, ok };
    },
  );

  const vaultChecks = await mapBounded(
    BASE_ERC4626_VAULTS,
    3,
    async ({ id, token, vault }) => {
      const asset = await basePublicClient.readContract({
        address: vault,
        abi: ERC4626_ABI,
        functionName: "asset",
      });
      const ok = sameAddress(asset, tokenFor(token));
      if (!ok) failures.push(`ERC4626_ASSET_MISMATCH:${id}`);
      return { id, token, vault, asset, ok };
    },
  );

  const [requiredAllowlist, forbiddenAllowlist] = await Promise.all([
    feeRouterPolicyApprovals(BASE_FEE_ROUTER_REQUIRED_TARGETS, blockNumber),
    feeRouterPolicyApprovals(BASE_FEE_ROUTER_FORBIDDEN_TARGETS, blockNumber),
  ]);
  for (const { id, target, approved } of requiredAllowlist) {
    if (!approved) {
      failures.push(`FEE_ROUTER_REQUIRED_TARGET_NOT_APPROVED:${id}:${target}`);
    }
  }
  for (const { id, target, approved } of forbiddenAllowlist) {
    if (approved) {
      failures.push(`FEE_ROUTER_FORBIDDEN_TARGET_APPROVED:${id}:${target}`);
    }
  }

  const requiredTargetSet = new Set(
    BASE_FEE_ROUTER_REQUIRED_TARGETS.map(({ target }) => target.toLowerCase()),
  );
  const historicalTargets = [...approvalHistory.finalEventState.values()];
  const historicalMappings = await mapBounded(
    historicalTargets,
    4,
    async ({ target, approved: eventApproved, ...event }) => ({
      target,
      eventApproved,
      mappingApproved: await feeRouterApproval(target, blockNumber),
      ...event,
    }),
  );
  for (const { target, eventApproved, mappingApproved } of historicalMappings) {
    if (mappingApproved !== eventApproved) {
      failures.push(
        `FEE_ROUTER_EVENT_STATE_MISMATCH:${target}:${eventApproved}:${mappingApproved}`,
      );
    }
    if (mappingApproved && !requiredTargetSet.has(target.toLowerCase())) {
      failures.push(`FEE_ROUTER_UNEXPECTED_ACTIVE_TARGET:${target}`);
    }
  }
  const historicalTargetSet = new Set(
    historicalTargets.map(({ target }) => target.toLowerCase()),
  );
  for (const { id, target } of BASE_FEE_ROUTER_REQUIRED_TARGETS) {
    if (!historicalTargetSet.has(target.toLowerCase())) {
      failures.push(
        `FEE_ROUTER_REQUIRED_TARGET_MISSING_HISTORY:${id}:${target}`,
      );
    }
  }
  const [usdcSupply, usdcBorrow, liquidityPools] = await Promise.all([
    getLendingOpportunities("USDC", undefined, "balanced", "supply"),
    getLendingOpportunities("USDC", undefined, "balanced", "borrow"),
    discoverLiquidityPools(
      BASE_TOKEN_REGISTRY.USDC.address,
      BASE_TOKEN_REGISTRY.AERO.address,
    ),
  ]);
  const liquidityTargets = [
    ...new Map(
      liquidityPools
        .flatMap(({ router, factory, pool }) => [router, factory, pool])
        .map((target) => [target.toLowerCase(), target]),
    ).values(),
  ];
  const liquidityCodeChecks = await mapBounded(
    liquidityTargets,
    4,
    async (target) => {
      const code = await basePublicClient.getCode({ address: target });
      const ok = Boolean(code && code !== "0x");
      if (!ok) {
        failures.push(`NO_LIQUIDITY_RUNTIME_CODE:${target}`);
      }
      return {
        target,
        ok,
        byteLength: ok ? (code!.length - 2) / 2 : 0,
      };
    },
  );

  console.log(
    JSON.stringify(
      {
        status: failures.length === 0 ? "verified" : "failed",
        chainId: 8453,
        blockNumber: blockNumber.toString(),
        observedAt: new Date().toISOString(),
        counts: {
          runtimeCodeTargets: codeChecks.length,
          v2RouterIdentityChecks: v2RouterIdentityChecks.length,
          aaveReserves: aaveChecks.length,
          moonwellMarkets: moonwellChecks.length,
          compoundComets: compoundChecks.length,
          erc4626Vaults: vaultChecks.length,
          stakingTargets: Object.keys(BASE_STAKING_CONTRACTS).length,
          discoveredUsdcAeroPools: liquidityPools.length,
          liquidityRuntimeCodeTargets: liquidityCodeChecks.length,
        },
        feeRouter: {
          address: BASE_FEE_ROUTER,
          deploymentBlock: BASE_FEE_ROUTER_DEPLOYMENT_BLOCK.toString(),
          state: {
            owner: feeRouterOwner,
            expectedOwner: BASE_FEE_ROUTER_EXPECTED_OWNER,
            treasury: feeRouterTreasury,
            expectedTreasury: BASE_FEE_ROUTER_EXPECTED_TREASURY,
            feeBps: feeRouterFeeBps.toString(),
            expectedFeeBps: BASE_FEE_ROUTER_EXPECTED_FEE_BPS.toString(),
            paused: feeRouterPaused,
            runtimeByteLength:
              feeRouterCode && feeRouterCode !== "0x"
                ? (feeRouterCode.length - 2) / 2
                : 0,
          },
          approvalHistory: {
            fromBlock: BASE_FEE_ROUTER_DEPLOYMENT_BLOCK.toString(),
            toBlock: blockNumber.toString(),
            eventCount: approvalHistory.logs.length,
            historicalTargetCount: historicalMappings.length,
            activeTargets: historicalMappings
              .filter(({ mappingApproved }) => mappingApproved)
              .map(({ target }) => target),
          },
          requiredTargets: requiredAllowlist,
          heldSwapTargets: forbiddenAllowlist.filter(({ id }) =>
            BASE_FEE_ROUTER_HELD_SWAP_TARGETS.some(
              (target) => target.id === id,
            ),
          ),
          staleTargets: forbiddenAllowlist.filter(({ id }) =>
            BASE_FEE_ROUTER_STALE_TARGETS.some((target) => target.id === id),
          ),
          expansionTargets: forbiddenAllowlist.filter(({ id }) =>
            BASE_FEE_ROUTER_EXPANSION_TARGETS.some(
              (target) => target.id === id,
            ),
          ),
          directOnlyTargets: forbiddenAllowlist.filter(({ id }) =>
            BASE_FEE_ROUTER_DIRECT_ONLY_TARGETS.some(
              (target) => target.id === id,
            ),
          ),
          note: "The release policy is exact: only requiredTargets may be true. Discovery, lending, vault, staking, stale and expansion targets must remain false.",
        },
        swapIdentity: {
          v2Routers: v2RouterIdentityChecks,
          aerodrome: {
            router: ROUTERS.AERO_V1,
            configuredFactory: ROUTERS.AERO_FACTORY,
            defaultFactory: aerodromeDefaultFactory,
            factoryRegistry: aerodromeFactoryRegistry,
            factoryApproved: aerodromeFactoryApproved,
          },
        },
        liveUsdcComparison: {
          supply: usdcSupply.opportunities.map((opportunity) => ({
            protocolId: opportunity.protocolId,
            name: opportunity.name,
            rateBps: opportunity.supplyRateBps,
          })),
          borrow: usdcBorrow.opportunities.map((opportunity) => ({
            protocolId: opportunity.protocolId,
            name: opportunity.name,
            rateBps: opportunity.borrowRateBps,
          })),
        },
        liveUsdcAeroLiquidity: {
          observedBlock: liquidityPools[0]?.observedBlock.toString() ?? null,
          pools: liquidityPools.map((pool) => ({
            protocolId: pool.protocolId,
            name: pool.protocolName,
            router: pool.router,
            factory: pool.factory,
            pool: pool.pool,
            stable: pool.stable,
            reserveUsdcAtomic: pool.reserveA.toString(),
            reserveAeroAtomic: pool.reserveB.toString(),
            unavailableSourceCount: pool.unavailableSourceCount,
          })),
          note: "Factory-bound reserve snapshot only; no fee APR, future yield or impermanent-loss projection is inferred.",
        },
        failures,
      },
      null,
      2,
    ),
  );

  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      status: "unavailable",
      name: error instanceof Error ? error.name : "UnknownError",
      code:
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : undefined,
    }),
  );
  process.exitCode = 1;
});
