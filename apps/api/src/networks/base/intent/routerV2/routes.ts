/**
 * Reviewed route checks: adapters, Uniswap V3 packed paths, route shape,
 * intent times and fee policy.
 */
import { encodeAbiParameters, type Address, type Hex } from "viem";
import {
  BASE_MAINNET_CHAIN_ID,
  HEX_PATTERN,
  MAX_INTENT_TTL_SECONDS,
  MAX_ROUTER_FEE_BPS,
  NATIVE_TOKEN_SENTINEL,
  PROTOCOL_ID_PATTERN,
  REVIEWED_UNI_V2_ROUTE_KEYS,
  REVIEWED_UNI_V3_ROUTE_KEYS,
  UINT48_MAX,
  V3_ADDRESS_BYTES,
  V3_FEE_BYTES,
  V3_FEE_DENOMINATOR,
  V3_MAX_PATH_BYTES,
  V3_MIN_PATH_BYTES,
  V3_NEXT_HOP_BYTES,
} from "./constants.js";
import {
  type BaseIntentV2AdapterEvidence,
  type BaseIntentV2DeploymentEvidence,
  BaseIntentV2PlanError,
  type BaseSwapExecutionConfig,
  type BuildBaseIntentV2SwapPlanInput,
  type IntentV2ExecutionConfig,
  type ReviewedBaseIntentV2ExactInputRoute,
  type ReviewedUniV2ExactInputRoute,
  type ReviewedUniV3ExactInputRoute,
} from "./types.js";
import {
  checkedRouteAddress,
  checkedRouteUint,
  routeError,
  sameAddress,
} from "./config.js";

export function requireIntentV2Config(
  config: BaseSwapExecutionConfig,
): IntentV2ExecutionConfig {
  if (config.mode !== "intent_v2") {
    routeError("BASE_INTENT_V2_ROUTE_UNSUPPORTED");
  }
  return config;
}

function findRouteAdapter(
  deployment: BaseIntentV2DeploymentEvidence,
  route: ReviewedBaseIntentV2ExactInputRoute,
): BaseIntentV2AdapterEvidence {
  const protocolId =
    typeof route.protocolId === "string" ? route.protocolId : "";
  const match = deployment.adapters.find(
    (candidate) =>
      candidate.kind === route.kind &&
      candidate.protocolId === protocolId &&
      sameAddress(candidate.adapter, route.adapter) &&
      sameAddress(candidate.target, route.target) &&
      sameAddress(candidate.spender, route.spender),
  );
  if (!match) routeError();
  return match;
}

export interface DecodedUniV3PackedPath {
  readonly packedPath: Hex;
  readonly tokens: readonly Address[];
  readonly fees: readonly number[];
}

/**
 * Decodes only the canonical Uniswap V3 forward exact-input path layout.
 * It rejects arbitrary bytes, repeated/zero tokens, invalid fees and more than
 * four pools before any value can become signed adapter data.
 */
export function decodeUniV3PackedPath(value: unknown): DecodedUniV3PackedPath {
  if (typeof value !== "string" || !HEX_PATTERN.test(value)) {
    routeError();
  }
  const packedPath = value.toLowerCase() as Hex;
  const raw = packedPath.slice(2);
  const byteLength = raw.length / 2;
  if (
    byteLength < V3_MIN_PATH_BYTES ||
    byteLength > V3_MAX_PATH_BYTES ||
    (byteLength - V3_ADDRESS_BYTES) % V3_NEXT_HOP_BYTES !== 0
  ) {
    routeError();
  }

  const hopCount = (byteLength - V3_ADDRESS_BYTES) / V3_NEXT_HOP_BYTES;
  const tokens: Address[] = [];
  const fees: number[] = [];
  const seenTokens = new Set<string>();
  const readAddress = (byteOffset: number): Address =>
    checkedRouteAddress(
      `0x${raw.slice(byteOffset * 2, (byteOffset + V3_ADDRESS_BYTES) * 2)}`,
    );
  const addToken = (token: Address): void => {
    const key = token.toLowerCase();
    if (seenTokens.has(key)) routeError();
    seenTokens.add(key);
    tokens.push(token);
  };

  addToken(readAddress(0));
  let cursor = V3_ADDRESS_BYTES;
  for (let hop = 0; hop < hopCount; hop += 1) {
    const fee = Number.parseInt(
      raw.slice(cursor * 2, (cursor + V3_FEE_BYTES) * 2),
      16,
    );
    if (!Number.isSafeInteger(fee) || fee <= 0 || fee >= V3_FEE_DENOMINATOR) {
      routeError();
    }
    fees.push(fee);
    addToken(readAddress(cursor + V3_FEE_BYTES));
    cursor += V3_NEXT_HOP_BYTES;
  }
  if (tokens.length !== fees.length + 1) routeError();
  return { packedPath, tokens, fees };
}

export function validateRouteShape(
  route: ReviewedBaseIntentV2ExactInputRoute,
  deployment: BaseIntentV2DeploymentEvidence,
): {
  readonly route: ReviewedBaseIntentV2ExactInputRoute;
  readonly adapter: BaseIntentV2AdapterEvidence;
  readonly normalizedTokenIn: Address;
  readonly normalizedTokenOut: Address;
  readonly routeTokens: readonly Address[];
  readonly adapterData: Hex;
  readonly adapterDataEncoding:
    "abi_address_array_v1" | "uniswap_v3_packed_path_v1";
} {
  const runtimeRoute = route as unknown as Record<string, unknown>;
  if (
    !route ||
    (route.kind !== "uniswap_v2_compatible" &&
      route.kind !== "uniswap_v3_swaprouter02") ||
    route.reviewStatus !== "reviewed" ||
    route.quoteStatus !== "quoted" ||
    Object.keys(runtimeRoute).some(
      (key) =>
        !(
          route.kind === "uniswap_v2_compatible"
            ? REVIEWED_UNI_V2_ROUTE_KEYS
            : REVIEWED_UNI_V3_ROUTE_KEYS
        ).has(key),
    )
  ) {
    routeError("BASE_INTENT_V2_ROUTE_UNSUPPORTED");
  }
  if (route.chainId !== BASE_MAINNET_CHAIN_ID) routeError();
  const adapter = checkedRouteAddress(route.adapter);
  const target = checkedRouteAddress(route.target);
  const spender = checkedRouteAddress(route.spender);
  const tokenIn = checkedRouteAddress(route.tokenIn, true);
  const tokenOut = checkedRouteAddress(route.tokenOut, true);
  if (sameAddress(tokenIn, tokenOut)) routeError();
  if (
    typeof route.protocolId !== "string" ||
    !PROTOCOL_ID_PATTERN.test(route.protocolId)
  ) {
    routeError();
  }
  const amountIn = checkedRouteUint(route.amountIn);
  const quotedAmountOut = checkedRouteUint(route.quotedAmountOut);
  if (amountIn === 0n || quotedAmountOut === 0n) routeError();
  if (
    !Number.isInteger(route.slippageBps) ||
    route.slippageBps < 1 ||
    route.slippageBps > 5_000
  ) {
    routeError();
  }
  const normalizedTokenIn =
    tokenIn === NATIVE_TOKEN_SENTINEL ? deployment.wrappedNative : tokenIn;
  const normalizedTokenOut =
    tokenOut === NATIVE_TOKEN_SENTINEL ? deployment.wrappedNative : tokenOut;
  if (sameAddress(normalizedTokenIn, normalizedTokenOut)) {
    routeError();
  }

  if (route.kind === "uniswap_v2_compatible") {
    if (
      !Array.isArray(route.path) ||
      route.path.length < 2 ||
      route.path.length > 5
    ) {
      routeError();
    }
    const path = route.path.map((token) => checkedRouteAddress(token));
    const pathTokens = new Set<string>();
    for (const pathToken of path) {
      const key = pathToken.toLowerCase();
      if (pathTokens.has(key)) routeError();
      pathTokens.add(key);
    }
    if (
      !sameAddress(path[0], normalizedTokenIn) ||
      !sameAddress(path[path.length - 1], normalizedTokenOut)
    ) {
      routeError();
    }
    const normalizedRoute: ReviewedUniV2ExactInputRoute = {
      kind: "uniswap_v2_compatible",
      reviewStatus: "reviewed",
      quoteStatus: "quoted",
      chainId: BASE_MAINNET_CHAIN_ID,
      protocolId: route.protocolId,
      adapter,
      target,
      spender,
      tokenIn,
      tokenOut,
      amountIn,
      quotedAmountOut,
      slippageBps: route.slippageBps,
      path,
    };
    return {
      route: normalizedRoute,
      adapter: findRouteAdapter(deployment, normalizedRoute),
      normalizedTokenIn,
      normalizedTokenOut,
      routeTokens: path,
      adapterData: encodeAbiParameters([{ type: "address[]" }], [path]),
      adapterDataEncoding: "abi_address_array_v1",
    };
  }

  const decodedPath = decodeUniV3PackedPath(route.packedPath);
  if (
    !sameAddress(decodedPath.tokens[0], normalizedTokenIn) ||
    !sameAddress(
      decodedPath.tokens[decodedPath.tokens.length - 1],
      normalizedTokenOut,
    )
  ) {
    routeError();
  }
  const normalizedRoute: ReviewedUniV3ExactInputRoute = {
    kind: "uniswap_v3_swaprouter02",
    reviewStatus: "reviewed",
    quoteStatus: "quoted",
    chainId: BASE_MAINNET_CHAIN_ID,
    protocolId: route.protocolId,
    adapter,
    target,
    spender,
    tokenIn,
    tokenOut,
    amountIn,
    quotedAmountOut,
    slippageBps: route.slippageBps,
    packedPath: decodedPath.packedPath,
  };
  return {
    route: normalizedRoute,
    adapter: findRouteAdapter(deployment, normalizedRoute),
    normalizedTokenIn,
    normalizedTokenOut,
    routeTokens: decodedPath.tokens,
    adapterData: decodedPath.packedPath,
    adapterDataEncoding: "uniswap_v3_packed_path_v1",
  };
}

export function checkedIntentTimes(input: BuildBaseIntentV2SwapPlanInput): {
  readonly nonce: bigint;
  readonly issuedAt: bigint;
  readonly validAfter: bigint;
  readonly deadline: bigint;
  readonly now: bigint;
} {
  try {
    const nonce = checkedRouteUint(input.nonce);
    const issuedAt = checkedRouteUint(input.issuedAt, UINT48_MAX);
    const validAfter = checkedRouteUint(input.validAfter, UINT48_MAX);
    const deadline = checkedRouteUint(input.deadline, UINT48_MAX);
    const now = checkedRouteUint(input.now, UINT48_MAX);
    if (
      issuedAt === 0n ||
      issuedAt > now ||
      issuedAt > validAfter ||
      validAfter > deadline ||
      deadline <= now ||
      deadline - issuedAt > MAX_INTENT_TTL_SECONDS
    ) {
      throw new BaseIntentV2PlanError("BASE_INTENT_V2_TIME_INVALID");
    }
    return {
      nonce,
      issuedAt,
      validAfter,
      deadline,
      now,
    };
  } catch (error) {
    if (
      error instanceof BaseIntentV2PlanError &&
      error.code === "BASE_INTENT_V2_TIME_INVALID"
    ) {
      throw error;
    }
    throw new BaseIntentV2PlanError("BASE_INTENT_V2_TIME_INVALID");
  }
}

export function checkedFeePolicy(maxFeeBps: unknown, observedFeeBps: number): number {
  if (
    !Number.isInteger(maxFeeBps) ||
    Number(maxFeeBps) < observedFeeBps ||
    Number(maxFeeBps) > MAX_ROUTER_FEE_BPS
  ) {
    throw new BaseIntentV2PlanError("BASE_INTENT_V2_FEE_INVALID");
  }
  return Number(maxFeeBps);
}
