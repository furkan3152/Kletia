import { randomBytes } from "node:crypto";
import {
  erc20Abi,
  formatUnits,
  getAddress,
  parseUnits,
  type Address,
} from "viem";

import type { ParsedIntent } from "../../../ai/parser.js";
import { basePublicClient } from "../../../config/client.js";
import { normalizeBaseProtocolId } from "../protocols.js";
import {
  BASE_MAINNET_CHAIN_ID,
  BaseIntentV2PlanError,
  NATIVE_TOKEN_SENTINEL,
  buildBaseIntentV2SwapPlan,
  decodeUniV3PackedPath,
  resolveBaseSwapExecutionConfig,
  type BaseIntentV2DeploymentEvidence,
  type BaseIntentV2SwapPlan,
  type IntentV2ExecutionConfig,
  type ReviewedBaseIntentV2ExactInputRoute,
  type ReviewedUniV2ExactInputRoute,
  type ReviewedUniV3ExactInputRoute,
} from "./routerV2.js";
import { KLETIA_INTENT_ROUTER_V2_ABI } from "./routerV2Abis.js";
import { validateBaseIntentV2Runtime } from "./routerV2Runtime.js";
import {
  BASE_SWAP_QUOTE_COLLECTION_POLICY,
  collectBaseSwapQuotes,
} from "./swapQuoteCollector.js";
import {
  assertBaseProtocolConstraintCompatibility,
  isBaseProtocolExcluded,
} from "../protocolConstraints.js";
import {
  SWAP_QUOTE_SOURCES,
  parseSlippageBps,
} from "../routingPolicy.js";
import {
  xRaySimulate,
  type XRaySimulationResult,
} from "../security.js";
import { getAddressSafe } from "../utils.js";

const V2_INTENT_TTL_SECONDS = 5n * 60n;
const MAX_NONCE_ATTEMPTS = 8;
const PROTOCOL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/u;
const DECIMAL_ATOMIC_PATTERN = /^(?:0|[1-9]\d*)$/u;

type UnknownRecord = Record<string, unknown>;

export interface BaseIntentV2SwapIntegrationDependencies {
  readonly validateRuntime: (
    config: IntentV2ExecutionConfig,
  ) => Promise<BaseIntentV2DeploymentEvidence>;
  readonly collectQuotes: (
    intent: ParsedIntent,
    userAddress: string,
  ) => Promise<unknown>;
  readonly blockTimestamp: (blockNumber: bigint) => Promise<bigint>;
  readonly selectUnusedNonce: (
    router: Address,
    owner: Address,
  ) => Promise<bigint>;
  readonly tokenDecimals: (token: Address) => Promise<number>;
  readonly simulate: (
    plan: BaseIntentV2SwapPlan,
    owner: Address,
    routeName: string,
  ) => Promise<XRaySimulationResult>;
}

export interface BaseIntentV2SwapCoverage {
  readonly policyVersion:
    | "kletia_base_intent_v2_typed_adapter_v1"
    | "kletia_base_intent_v2_typed_adapter_v2";
  readonly runtimeValidationStatus: "validated";
  readonly observedAtBlock: string;
  readonly quotedRouteCount: number;
  readonly typedAdapterMatchedRouteCount: number;
  readonly compiledRouteCount: number;
  readonly simulatedRouteCount: number;
  readonly eligibleRouteCount: number;
  readonly unsupportedQuoteCount: number;
  readonly sharedExclusiveNonce: string;
  readonly rankingMetric: "simulation_then_guaranteed_net_minimum";
  readonly noLegacyFallback: true;
}

export interface BaseIntentV2CompiledRoute extends BaseIntentV2SwapPlan {
  readonly name: string;
  readonly action: "swap";
  readonly protocolId: string;
  readonly expectedOutput: string;
  readonly routePath: string;
  readonly amountOut: bigint;
  readonly quotedAmountOut: bigint;
  readonly quoteSource: "standard_amm" | "v3_amm";
  readonly network: "base";
  readonly approvalPolicy: "explicit";
  readonly callerSemantics: "explicit_recipient";
  readonly feeRouterCompatible: false;
  readonly simulationStatus: "passed" | "deferred_until_approval";
  readonly quoteExpiresAt: number;
}

function v2Error(
  code:
    | "BASE_INTENT_V2_NO_ELIGIBLE_ROUTE"
    | "BASE_INTENT_V2_NONCE_UNAVAILABLE"
    | "BASE_INTENT_V2_CONSTRAINT_UNSUPPORTED"
    | "BASE_INTENT_V2_SIMULATION_FAILED",
): never {
  throw new BaseIntentV2PlanError(code);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function checkedUserAddress(value: string): Address {
  try {
    return getAddress(value);
  } catch {
    return v2Error("BASE_INTENT_V2_CONSTRAINT_UNSUPPORTED");
  }
}

function checkedPositiveAtomic(value: unknown): bigint {
  if (typeof value !== "string" || !DECIMAL_ATOMIC_PATTERN.test(value)) {
    return v2Error("BASE_INTENT_V2_NO_ELIGIBLE_ROUTE");
  }
  const amount = BigInt(value);
  if (amount === 0n) {
    return v2Error("BASE_INTENT_V2_NO_ELIGIBLE_ROUTE");
  }
  return amount;
}

function assertSupportedSwapConstraints(
  intent: ParsedIntent,
  owner: Address,
): void {
  if (
    intent.maxGas !== undefined ||
    intent.maxPriceImpactBps !== undefined ||
    intent.maxFee !== undefined ||
    intent.riskTolerance !== undefined ||
    intent.timeHorizonDays !== undefined ||
    (intent.objective !== undefined &&
      intent.objective !== "best_output" &&
      intent.objective !== "best_rate")
  ) {
    v2Error("BASE_INTENT_V2_CONSTRAINT_UNSUPPORTED");
  }

  if (intent.recipient !== undefined) {
    let recipient: Address;
    try {
      recipient = getAddress(intent.recipient);
    } catch {
      return v2Error("BASE_INTENT_V2_CONSTRAINT_UNSUPPORTED");
    }
    if (!sameAddress(recipient, owner)) {
      v2Error("BASE_INTENT_V2_CONSTRAINT_UNSUPPORTED");
    }
  }
}

function checkedPath(value: unknown): readonly Address[] | null {
  if (!Array.isArray(value)) return null;
  try {
    return value.map((token) => getAddress(String(token)));
  } catch {
    return null;
  }
}

function reviewedRouteFromQuote(
  value: unknown,
  deployment: BaseIntentV2DeploymentEvidence,
  amountIn: bigint,
  tokenIn: Address,
  tokenOut: Address,
  slippageBps: number,
  allowMultiStep: boolean | undefined,
): {
  readonly source: UnknownRecord;
  readonly reviewed: ReviewedBaseIntentV2ExactInputRoute;
} | null {
  if (!isRecord(value)) return null;
  const isUniV2 = value.quoteSource === SWAP_QUOTE_SOURCES.standardAmm;
  const isUniV3 = value.quoteSource === SWAP_QUOTE_SOURCES.v3Amm;
  if (!isUniV2 && !isUniV3) {
    return null;
  }
  if (value.quoteStatus !== "quoted") {
    return null;
  }
  if (
    typeof value.protocolId !== "string" ||
    !PROTOCOL_ID_PATTERN.test(value.protocolId)
  ) {
    return null;
  }

  let target: Address;
  try {
    target = getAddress(String(value.router));
  } catch {
    return null;
  }
  if (typeof value.amountOut !== "bigint" || value.amountOut <= 0n) {
    return null;
  }

  const adapterKind = isUniV2
    ? "uniswap_v2_compatible"
    : "uniswap_v3_swaprouter02";
  if (
    isUniV3 &&
    (value.typedAdapterKind !== adapterKind ||
      value.quoteExecutionProfile !== "intent_router_v2_quote" ||
      value.calldata !== undefined)
  ) {
    return null;
  }
  const adapter = deployment.adapters.find(
    (candidate) =>
      candidate.kind === adapterKind &&
      candidate.enabled === true &&
      candidate.protocolId === value.protocolId &&
      sameAddress(candidate.target, target) &&
      sameAddress(candidate.spender, target),
  );
  if (!adapter) return null;

  if (isUniV3) {
    let decodedPath: ReturnType<typeof decodeUniV3PackedPath>;
    try {
      decodedPath = decodeUniV3PackedPath(value.packedPath);
    } catch {
      return null;
    }
    if (allowMultiStep === false && decodedPath.tokens.length !== 2) {
      return null;
    }
    return {
      source: value,
      reviewed: {
        kind: "uniswap_v3_swaprouter02",
        reviewStatus: "reviewed",
        quoteStatus: "quoted",
        chainId: BASE_MAINNET_CHAIN_ID,
        protocolId: adapter.protocolId,
        adapter: adapter.adapter,
        target: adapter.target,
        spender: adapter.spender,
        tokenIn,
        tokenOut,
        amountIn,
        quotedAmountOut: value.amountOut,
        slippageBps,
        packedPath: decodedPath.packedPath,
      } satisfies ReviewedUniV3ExactInputRoute,
    };
  }

  const path = checkedPath(value.path);
  if (!path || (allowMultiStep === false && path.length !== 2)) {
    return null;
  }

  return {
    source: value,
    reviewed: {
      kind: "uniswap_v2_compatible",
      reviewStatus: "reviewed",
      quoteStatus: "quoted",
      chainId: BASE_MAINNET_CHAIN_ID,
      protocolId: adapter.protocolId,
      adapter: adapter.adapter,
      target: adapter.target,
      spender: adapter.spender,
      tokenIn,
      tokenOut,
      amountIn,
      quotedAmountOut: value.amountOut,
      slippageBps,
      path,
    } satisfies ReviewedUniV2ExactInputRoute,
  };
}

function checkedBlockTimestamp(value: unknown): bigint {
  if (typeof value !== "bigint" || value <= 0n) {
    return v2Error("BASE_INTENT_V2_NO_ELIGIBLE_ROUTE");
  }
  return value;
}

function checkedMinimumOutput(
  minimumOutput: string | undefined,
  decimals: number,
): bigint | undefined {
  if (minimumOutput === undefined) return undefined;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    return v2Error("BASE_INTENT_V2_CONSTRAINT_UNSUPPORTED");
  }
  try {
    const value = parseUnits(minimumOutput, decimals);
    if (value <= 0n) {
      return v2Error("BASE_INTENT_V2_CONSTRAINT_UNSUPPORTED");
    }
    return value;
  } catch {
    return v2Error("BASE_INTENT_V2_CONSTRAINT_UNSUPPORTED");
  }
}

function assertQuoteAmountResolution(
  value: unknown,
  requestedIntentAmount: string | undefined,
  inputDecimals: number,
  isNativeIn: boolean,
  amountIn: bigint,
): void {
  if (
    !isRecord(value) ||
    !Number.isInteger(inputDecimals) ||
    inputDecimals < 0 ||
    inputDecimals > 255
  ) {
    return v2Error("BASE_INTENT_V2_NO_ELIGIBLE_ROUTE");
  }
  const requested = requestedIntentAmount?.trim();
  if (!requested) {
    return v2Error("BASE_INTENT_V2_NO_ELIGIBLE_ROUTE");
  }

  if (requested.toUpperCase() !== "MAX") {
    if (
      value.mode !== "exact_input" ||
      value.requestedAmount !== requested ||
      value.inputDecimals !== inputDecimals ||
      Object.keys(value).some(
        (key) => !["mode", "requestedAmount", "inputDecimals"].includes(key),
      )
    ) {
      return v2Error("BASE_INTENT_V2_NO_ELIGIBLE_ROUTE");
    }
    try {
      if (parseUnits(requested, inputDecimals) !== amountIn) {
        return v2Error("BASE_INTENT_V2_NO_ELIGIBLE_ROUTE");
      }
    } catch {
      return v2Error("BASE_INTENT_V2_NO_ELIGIBLE_ROUTE");
    }
    return;
  }

  if (
    value.mode !== "max_balance_snapshot" ||
    value.requestedAmount !== "MAX" ||
    value.inputDecimals !== inputDecimals ||
    typeof value.observedBalanceAtomic !== "string" ||
    !DECIMAL_ATOMIC_PATTERN.test(value.observedBalanceAtomic) ||
    typeof value.nativeGasReserveAtomic !== "string" ||
    !DECIMAL_ATOMIC_PATTERN.test(value.nativeGasReserveAtomic) ||
    Object.keys(value).some(
      (key) =>
        ![
          "mode",
          "requestedAmount",
          "inputDecimals",
          "observedBalanceAtomic",
          "nativeGasReserveAtomic",
        ].includes(key),
    )
  ) {
    return v2Error("BASE_INTENT_V2_NO_ELIGIBLE_ROUTE");
  }
  const balance = BigInt(value.observedBalanceAtomic);
  const reserve = BigInt(value.nativeGasReserveAtomic);
  const expectedReserve = isNativeIn ? parseUnits("0.001", 18) : 0n;
  const resolved = isNativeIn
    ? balance > reserve
      ? balance - reserve
      : 0n
    : balance;
  if (reserve !== expectedReserve || resolved !== amountIn) {
    return v2Error("BASE_INTENT_V2_NO_ELIGIBLE_ROUTE");
  }
}

function compareCompiledRoutes(
  left: BaseIntentV2CompiledRoute,
  right: BaseIntentV2CompiledRoute,
): number {
  if (left.simulationStatus !== right.simulationStatus) {
    return left.simulationStatus === "passed" ? -1 : 1;
  }
  if (left.amountOut !== right.amountOut) {
    return left.amountOut > right.amountOut ? -1 : 1;
  }
  const protocolOrder = left.protocolId.localeCompare(right.protocolId);
  if (protocolOrder !== 0) return protocolOrder;
  const adapterKindOrder = left.adapterKind.localeCompare(right.adapterKind);
  if (adapterKindOrder !== 0) return adapterKindOrder;
  return left.adapterData.localeCompare(right.adapterData);
}

function reviewedTokenPath(
  route: ReviewedBaseIntentV2ExactInputRoute,
): readonly Address[] {
  return route.kind === "uniswap_v2_compatible"
    ? route.path
    : decodeUniV3PackedPath(route.packedPath).tokens;
}

function quoteExpiryFromDeadline(deadline: bigint): number {
  const milliseconds = deadline * 1_000n;
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) {
    return v2Error("BASE_INTENT_V2_NO_ELIGIBLE_ROUTE");
  }
  return Number(milliseconds);
}

function normalizeExecutionConfig(
  configured: IntentV2ExecutionConfig,
  deployment: BaseIntentV2DeploymentEvidence,
): IntentV2ExecutionConfig {
  const resolved = resolveBaseSwapExecutionConfig(
    {
      BASE_SWAP_EXECUTION_MODE: "intent_v2",
      KLETIA_INTENT_ROUTER_V2_ADDRESS: configured.router,
    },
    deployment,
  );
  if (resolved.mode !== "intent_v2") {
    return v2Error("BASE_INTENT_V2_NO_ELIGIBLE_ROUTE");
  }
  return resolved;
}

export async function selectUnusedBaseIntentV2Nonce(
  router: Address,
  owner: Address,
  isNonceUsed: (
    router: Address,
    owner: Address,
    nonce: bigint,
  ) => Promise<boolean>,
  nextNonce: () => bigint = () =>
    BigInt(`0x${randomBytes(32).toString("hex")}`),
): Promise<bigint> {
  const attempted = new Set<bigint>();
  try {
    for (let attempt = 0; attempt < MAX_NONCE_ATTEMPTS; attempt += 1) {
      const nonce = nextNonce();
      if (nonce < 0n || nonce > (1n << 256n) - 1n || attempted.has(nonce)) {
        continue;
      }
      attempted.add(nonce);
      if (!(await isNonceUsed(router, owner, nonce))) {
        return nonce;
      }
    }
  } catch {
    return v2Error("BASE_INTENT_V2_NONCE_UNAVAILABLE");
  }
  return v2Error("BASE_INTENT_V2_NONCE_UNAVAILABLE");
}

function createDefaultDependencies(): BaseIntentV2SwapIntegrationDependencies {
  return {
    validateRuntime: (config) =>
      validateBaseIntentV2Runtime(config, basePublicClient),
    collectQuotes: (intent, userAddress) =>
      collectBaseSwapQuotes(intent, userAddress, "intent_router_v2"),
    blockTimestamp: async (blockNumber) => {
      const block = await basePublicClient.getBlock({
        blockNumber,
      });
      return block.timestamp;
    },
    selectUnusedNonce: (router, owner) =>
      selectUnusedBaseIntentV2Nonce(
        router,
        owner,
        async (checkedRouter, checkedOwner, nonce) =>
          basePublicClient.readContract({
            address: checkedRouter,
            abi: KLETIA_INTENT_ROUTER_V2_ABI,
            functionName: "isNonceUsed",
            args: [checkedOwner, nonce],
          }),
      ),
    tokenDecimals: async (token) =>
      basePublicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "decimals",
      }),
    simulate: (plan, owner, routeName) =>
      xRaySimulate(
        plan.router,
        plan.calldata,
        owner,
        plan.value,
        `Kletia Intent Router V2 → ${routeName}`,
        plan.approvals.map((approval) => ({
          addr: approval.token,
          amt: approval.amount,
        })),
      ),
  };
}

export async function executeBaseIntentV2Swap(
  intent: ParsedIntent,
  userAddress: string,
  configured: IntentV2ExecutionConfig,
  dependencies: BaseIntentV2SwapIntegrationDependencies = createDefaultDependencies(),
) {
  const owner = checkedUserAddress(userAddress);
  assertSupportedSwapConstraints(intent, owner);
  const excludedProtocolIds = assertBaseProtocolConstraintCompatibility(
    intent.protocol,
    intent.excludedProtocols,
  );

  const freshDeployment = await dependencies.validateRuntime(configured);
  const executionConfig = normalizeExecutionConfig(configured, freshDeployment);
  const observedTimestamp = checkedBlockTimestamp(
    await dependencies.blockTimestamp(freshDeployment.observedAtBlock),
  );

  const rawResult = await dependencies.collectQuotes({ ...intent }, owner);
  if (
    !isRecord(rawResult) ||
    rawResult.status !== "success" ||
    rawResult.quoteCollectionPolicyVersion !==
      BASE_SWAP_QUOTE_COLLECTION_POLICY ||
    rawResult.executionProfile !== "intent_router_v2" ||
    !Array.isArray(rawResult.allRoutes)
  ) {
    return v2Error("BASE_INTENT_V2_NO_ELIGIBLE_ROUTE");
  }

  const amountIn = checkedPositiveAtomic(rawResult.amountInWei);
  const isNativeIn = intent.tokenIn?.trim().toUpperCase() === "ETH";
  const isNativeOut = intent.tokenOut?.trim().toUpperCase() === "ETH";
  if (
    rawResult.isNativeIn !== isNativeIn ||
    rawResult.isNativeOut !== isNativeOut
  ) {
    return v2Error("BASE_INTENT_V2_NO_ELIGIBLE_ROUTE");
  }
  let quotedTokenIn: Address;
  let quotedTokenOut: Address;
  try {
    quotedTokenIn = getAddress(String(rawResult.tokenInAddress));
    quotedTokenOut = getAddress(String(rawResult.tokenOutAddress));
  } catch {
    return v2Error("BASE_INTENT_V2_NO_ELIGIBLE_ROUTE");
  }
  const intendedTokenIn = getAddressSafe(intent.tokenIn);
  const intendedTokenOut = getAddressSafe(intent.tokenOut);
  if (
    !intendedTokenIn ||
    !intendedTokenOut ||
    !sameAddress(quotedTokenIn, intendedTokenIn) ||
    !sameAddress(quotedTokenOut, intendedTokenOut) ||
    (isNativeIn &&
      !sameAddress(quotedTokenIn, freshDeployment.wrappedNative)) ||
    (isNativeOut && !sameAddress(quotedTokenOut, freshDeployment.wrappedNative))
  ) {
    return v2Error("BASE_INTENT_V2_NO_ELIGIBLE_ROUTE");
  }
  const inputDecimals = isNativeIn
    ? 18
    : await dependencies.tokenDecimals(quotedTokenIn);
  assertQuoteAmountResolution(
    rawResult.amountResolution,
    intent.amount,
    inputDecimals,
    isNativeIn,
    amountIn,
  );
  const tokenIn = isNativeIn ? NATIVE_TOKEN_SENTINEL : quotedTokenIn;
  const tokenOut = isNativeOut ? NATIVE_TOKEN_SENTINEL : quotedTokenOut;
  const outputDecimals = isNativeOut
    ? 18
    : await dependencies.tokenDecimals(tokenOut);
  const minimumNetAmountOut = checkedMinimumOutput(
    intent.minimumOutput,
    outputDecimals,
  );
  const slippageBps = parseSlippageBps(intent.slippage);

  const requestedProtocol =
    intent.protocol && intent.protocol !== "unknown"
      ? normalizeBaseProtocolId(intent.protocol)
      : null;
  const reviewedQuotes = rawResult.allRoutes
    .map((route) =>
      reviewedRouteFromQuote(
        route,
        freshDeployment,
        amountIn,
        tokenIn,
        tokenOut,
        slippageBps,
        intent.allowMultiStep,
      ),
    )
    .filter((route): route is NonNullable<typeof route> => route !== null)
    .filter(
      ({ reviewed }) =>
        !isBaseProtocolExcluded(reviewed.protocolId, excludedProtocolIds) &&
        (requestedProtocol === null ||
          reviewed.protocolId === requestedProtocol),
    );
  if (reviewedQuotes.length === 0) {
    return v2Error("BASE_INTENT_V2_NO_ELIGIBLE_ROUTE");
  }

  const nonce = await dependencies.selectUnusedNonce(
    executionConfig.router,
    owner,
  );
  const deadline = observedTimestamp + V2_INTENT_TTL_SECONDS;
  const quoteExpiresAt = quoteExpiryFromDeadline(deadline);

  const compiled = reviewedQuotes.map(({ source, reviewed }) => {
    const plan = buildBaseIntentV2SwapPlan({
      executionConfig,
      route: reviewed,
      owner,
      recipient: owner,
      nonce,
      issuedAt: observedTimestamp,
      validAfter: observedTimestamp,
      deadline,
      now: observedTimestamp,
      executor: owner,
      maxFeeBps: freshDeployment.feeBps,
      minimumNetAmountOut,
    });
    const routeName =
      typeof source.name === "string" && source.name.trim().length > 0
        ? source.name.trim()
        : reviewed.protocolId;
    const routePath =
      typeof source.routePath === "string" && source.routePath.trim().length > 0
        ? source.routePath.trim()
        : reviewedTokenPath(reviewed).join(" → ");
    const netMinimum = BigInt(plan.economics.netMinimumAmountOut);
    return {
      source,
      plan,
      routeName,
      routePath,
      netMinimum,
      protocolId: reviewed.protocolId,
      quotedAmountOut: reviewed.quotedAmountOut,
      expectedOutput:
        `Minimum net ${formatUnits(
          netMinimum,
          outputDecimals,
        )} ${intent.tokenOut || "output token"} ` +
        `(fee cap ${plan.economics.maxFeeBps} bps included)`,
    };
  });

  const simulationResults = await Promise.allSettled(
    compiled.map(async (candidate) => ({
      candidate,
      simulation: await dependencies.simulate(
        candidate.plan,
        owner,
        candidate.routeName,
      ),
    })),
  );
  const eligibleRoutes: BaseIntentV2CompiledRoute[] = [];
  for (const result of simulationResults) {
    if (result.status === "rejected") continue;
    const { candidate, simulation } = result.value;
    const deferred =
      simulation.deferredUntilApproval === true &&
      candidate.plan.approvals.length > 0;
    if (!simulation.success && !deferred) continue;

    eligibleRoutes.push({
      ...candidate.plan,
      name: candidate.routeName,
      action: "swap",
      protocolId: candidate.protocolId,
      expectedOutput: candidate.expectedOutput,
      routePath: candidate.routePath,
      amountOut: candidate.netMinimum,
      quotedAmountOut: candidate.quotedAmountOut,
      quoteSource:
        candidate.plan.adapterKind === "uniswap_v3_swaprouter02"
          ? "v3_amm"
          : "standard_amm",
      network: "base",
      approvals: candidate.plan.approvals.map((approval) => ({
        ...approval,
        symbol: intent.tokenIn,
      })),
      approvalPolicy: "explicit",
      callerSemantics: "explicit_recipient",
      feeRouterCompatible: false,
      simulationStatus: simulation.success
        ? "passed"
        : "deferred_until_approval",
      quoteExpiresAt,
    });
  }
  eligibleRoutes.sort(compareCompiledRoutes);
  if (eligibleRoutes.length === 0) {
    return v2Error("BASE_INTENT_V2_SIMULATION_FAILED");
  }

  const winner = eligibleRoutes[0];
  const coverage: BaseIntentV2SwapCoverage = {
    policyVersion: reviewedQuotes.some(
      ({ reviewed }) => reviewed.kind === "uniswap_v3_swaprouter02",
    )
      ? "kletia_base_intent_v2_typed_adapter_v2"
      : "kletia_base_intent_v2_typed_adapter_v1",
    runtimeValidationStatus: "validated",
    observedAtBlock: freshDeployment.observedAtBlock.toString(),
    quotedRouteCount: rawResult.allRoutes.length,
    typedAdapterMatchedRouteCount: reviewedQuotes.length,
    compiledRouteCount: compiled.length,
    simulatedRouteCount: simulationResults.length,
    eligibleRouteCount: eligibleRoutes.length,
    unsupportedQuoteCount: rawResult.allRoutes.length - reviewedQuotes.length,
    sharedExclusiveNonce: nonce.toString(),
    rankingMetric: "simulation_then_guaranteed_net_minimum",
    noLegacyFallback: true,
  };

  return {
    status: "success",
    winner: winner.name,
    expectedOutput: winner.expectedOutput,
    routePath: winner.routePath,
    targetContract: winner.router,
    calldata: winner.calldata,
    tokenInAddress: isNativeIn ? undefined : winner.intent.tokenIn,
    amountInWei: winner.intent.amountIn,
    isNativeIn,
    value: winner.value,
    approvals: winner.approvals,
    allRoutes: eligibleRoutes,
    quoteExpiresAt,
    intentRouterV2Coverage: coverage,
    quoteCoverage: rawResult.quoteCoverage,
    protocolExclusionEvidence: rawResult.protocolExclusionEvidence,
    rankingEvidence: {
      policyVersion: "base_intent_v2_net_floor_v1",
      stage: "final_routes_after_intent_v2_runtime_and_simulation",
      primaryMetric: "guaranteed_net_minimum_amount_out",
      direction: "descending",
      eligibleRouteCount: eligibleRoutes.length,
      simulationPassedCount: eligibleRoutes.filter(
        ({ simulationStatus }) => simulationStatus === "passed",
      ).length,
      deferredUntilApprovalCount: eligibleRoutes.filter(
        ({ simulationStatus }) =>
          simulationStatus === "deferred_until_approval",
      ).length,
      gasCostNormalized: false,
      executionLatencyNormalized: false,
      limitation:
        "Routes are ranked by executable simulation evidence and the signed minimum net output after the exact fee cap. Gas is disclosed separately and is not converted into the output asset.",
      rankedRoutes: eligibleRoutes.map((route, index) => ({
        rank: index + 1,
        protocolId: route.protocolId,
        name: route.name,
        guaranteedNetMinimumAtomic: route.economics.netMinimumAmountOut,
        quotedGrossAmountAtomic: route.economics.quotedGrossAmountOut,
        simulationStatus: route.simulationStatus,
      })),
    },
    winnerMessage:
      `🏆 **Kletia Intent Router V2:** ${winner.name}\n` +
      `🔒 **Signed minimum net output:** ${winner.expectedOutput}\n\n` +
      "> The route is bound to one reviewed typed adapter, current Base bytecode evidence, an exclusive unordered nonce, a five-minute deadline and an exact fee cap.",
  };
}
