/**
 * Generic route normalisation and the public result envelope builders.
 */
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { NETWORKS, type NetworkId } from "../../config/networks.js";
import {
  isArcAppKitExecutionPlan,
  isArcAppKitResultBinding,
} from "../../../networks/arc/appKit.js";
import type {
  IntentV2ExecutionConfig,
} from "../../../networks/base/intent/routerV2.js";
import {
  IntentResponseError,
  type ResultLike,
  type RouteLike,
} from "./types.js";
import { KLETIA_FEE_ROUTER } from "./constants.js";
import {
  checkedAddress,
  checkedApprovals,
  checkedCalldata,
  checkedPolicyTargets,
  checkedQuoteExpiry,
  decimalValue,
  isRecord,
  sameAddress,
  sameHex,
} from "./checks.js";
import {
  assertArcExternalEntityResolutionBinding,
  assertGenericEntityResolutionBinding,
  checkedEntityResolution,
  clampToRecipientResolutionExpiry,
} from "./entityResolution.js";
import {
  checkedV2Decimal,
  resolveActiveV2Config,
  v2ResponseError,
} from "./v2Checks.js";
import {
  createLaunchFactoryV2Envelope,
  hasLaunchFactoryV2Marker,
  launchV2ResponseError,
  resolveActiveLaunchV2Config,
} from "./launchV2.js";
import {
  createBaseIntentV2Envelope,
  hasBaseIntentV2Marker,
} from "./v2Envelope.js";

function isCanonicalWrappedNativePrimitive(
  rawResult: ResultLike,
  config: IntentV2ExecutionConfig,
): boolean {
  try {
    if (
      !Array.isArray(rawResult.allRoutes) ||
      rawResult.allRoutes.length !== 1 ||
      !isRecord(rawResult.allRoutes[0])
    ) {
      return false;
    }
    const route = rawResult.allRoutes[0];
    const target = getAddress(
      String(rawResult.targetContract || rawResult.target),
    );
    const router = getAddress(String(route.router || route.targetContract));
    if (
      !sameAddress(target, config.deployment.wrappedNative) ||
      !sameAddress(router, config.deployment.wrappedNative) ||
      route.simulationStatus !== "passed" ||
      (Array.isArray(rawResult.approvals) &&
        rawResult.approvals.length !== 0) ||
      (Array.isArray(route.approvals) && route.approvals.length !== 0)
    ) {
      return false;
    }
    const calldata = checkedCalldata(
      rawResult.calldata,
      "transaction.calldata",
    );
    const routeCalldata = checkedCalldata(route.calldata, "route.calldata");
    const amountInWei = checkedV2Decimal(
      decimalValue(rawResult.amountInWei, "transaction.amountInWei"),
      false,
    ).value;
    const value = decimalValue(rawResult.value, "transaction.value");
    const routeValue = decimalValue(route.value, "route.value");
    if (
      !sameHex(calldata, routeCalldata) ||
      value !== routeValue ||
      rawResult.winner !== route.name ||
      rawResult.tokenInAddress !== undefined
    ) {
      return false;
    }
    const depositCalldata = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "deposit",
          stateMutability: "payable",
          inputs: [],
          outputs: [],
        },
      ] as const,
      functionName: "deposit",
    });
    const withdrawCalldata = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "withdraw",
          stateMutability: "nonpayable",
          inputs: [{ name: "wad", type: "uint256" }],
          outputs: [],
        },
      ] as const,
      functionName: "withdraw",
      args: [amountInWei],
    });
    if (rawResult.isNativeIn === true) {
      return (
        value === amountInWei.toString() && sameHex(calldata, depositCalldata)
      );
    }
    return (
      rawResult.isNativeIn === false &&
      value === "0" &&
      sameHex(calldata, withdrawCalldata)
    );
  } catch {
    return false;
  }
}

function normalizeRoute(
  route: RouteLike,
  fallback: {
    name: string;
    action: string;
    router: Address;
    calldata: Hex;
    value: string;
    approvals: unknown[];
    approvalPolicy: "explicit" | "legacy_inferred";
    isNativeIn: boolean;
    network: NetworkId;
    chainId: number;
    requestId: string;
    userAddress: Address;
    quoteExpiresAt: number;
  },
  useFallbackTransaction = false,
) {
  const rawRouter = useFallbackTransaction
    ? fallback.router
    : route.router || route.targetContract;
  const rawCalldata = useFallbackTransaction
    ? fallback.calldata
    : route.calldata;
  if (!rawRouter || !rawCalldata) {
    throw new IntentResponseError(
      "INVALID_ROUTE",
      "Each transaction route must explicitly include its own router and calldata fields.",
    );
  }
  const router = checkedAddress(
    fallback.network,
    String(rawRouter),
    fallback.action,
  );
  const calldata = checkedCalldata(
    rawCalldata,
    "route.calldata",
    fallback.action === "transfer" && fallback.isNativeIn,
  );
  const routeValue =
    route.value ?? (fallback.isNativeIn ? fallback.value : "0");
  const hasExplicitRouteApprovals = Array.isArray(route.approvals);
  const inheritsFallback =
    useFallbackTransaction ||
    router.toLowerCase() === fallback.router.toLowerCase();
  const approvalPolicy = hasExplicitRouteApprovals
    ? "explicit"
    : inheritsFallback
      ? fallback.approvalPolicy
      : "legacy_inferred";
  const rawApprovals = Array.isArray(route.approvals)
    ? route.approvals
    : inheritsFallback
      ? fallback.approvals
      : [];
  const approvals = checkedApprovals(rawApprovals, router);
  const executionMode =
    route.executionMode === undefined
      ? undefined
      : route.executionMode === "direct" ||
          route.executionMode === "kletia_fee_router"
        ? route.executionMode
        : (() => {
            throw new IntentResponseError(
              "INVALID_EXECUTION_MODE",
              "Base route executionMode value is unrecognized.",
            );
          })();
  if (
    router === KLETIA_FEE_ROUTER &&
    (executionMode === "direct" || route.feeRouterCompatible === false)
  ) {
    throw new IntentResponseError(
      "FEE_ROUTER_CALLER_SEMANTICS_MISMATCH",
      "Direct user position route cannot be executed through Kletia Fee Router.",
    );
  }
  const simulationReturnPolicy =
    route.simulationReturnPolicy === undefined
      ? undefined
      : route.simulationReturnPolicy === "uint256_zero"
        ? route.simulationReturnPolicy
        : (() => {
            throw new IntentResponseError(
              "INVALID_SIMULATION_RETURN_POLICY",
              "Route carries an unrecognized protocol return-data policy.",
            );
          })();

  return {
    ...route,
    name: String(route.name || route.protocol || fallback.name),
    action: fallback.action,
    router,
    calldata,
    value: decimalValue(routeValue, "route.value"),
    approvals,
    approvalPolicy,
    ...(executionMode ? { executionMode } : {}),
    ...(simulationReturnPolicy ? { simulationReturnPolicy } : {}),
    policyTargets: checkedPolicyTargets(
      route.policyTargets,
      fallback.network,
      fallback.action,
    ),
    network: fallback.network,
    chainId: fallback.chainId,
    requestId: fallback.requestId,
    userAddress: fallback.userAddress,
    quoteExpiresAt: checkedQuoteExpiry(
      route.quoteExpiresAt,
      fallback.quoteExpiresAt,
      "route.quoteExpiresAt",
    ),
  };
}

export function createIntentResultEnvelope(
  rawResult: ResultLike,
  network: NetworkId,
  requestId: string,
  userAddress: string,
  trustedEntityResolution?: unknown,
) {
  const action = String(
    rawResult.actionType ||
      rawResult.action ||
      (isRecord(trustedEntityResolution)
        ? trustedEntityResolution.action
        : isRecord(rawResult.entityResolution)
          ? rawResult.entityResolution.action
          : "") ||
      "",
  );
  const rawTarget = rawResult.targetContract || rawResult.target;
  const isTransaction =
    typeof rawTarget === "string" && typeof rawResult.calldata === "string";

  let normalizedUser: Address;
  try {
    normalizedUser = getAddress(userAddress);
  } catch {
    throw new IntentResponseError(
      "INVALID_USER_ADDRESS",
      "User address in the response envelope is invalid.",
    );
  }

  const entityResolution = checkedEntityResolution(
    trustedEntityResolution === undefined
      ? rawResult.entityResolution
      : trustedEntityResolution,
    {
      network,
      action,
      requestId,
      userAddress: normalizedUser,
    },
  );
  if (network === "arc") {
    assertArcExternalEntityResolutionBinding(
      entityResolution,
      rawResult,
      action,
    );
  }

  if (rawResult.executionKind === "circle_app_kit") {
    if (
      network !== "arc" ||
      !isArcAppKitExecutionPlan(rawResult.executionPlan) ||
      !isArcAppKitResultBinding(rawResult, requestId)
    ) {
      throw new IntentResponseError(
        "INVALID_EXTERNAL_EXECUTION_PLAN",
        "Circle App Kit plan can only be used in a verified Arc Testnet context.",
      );
    }
    return {
      ...rawResult,
      ...(entityResolution ? { entityResolution } : {}),
      status: "success",
      network: "arc" as const,
      chainId: NETWORKS.arc.chainId,
      requestId,
      userAddress: normalizedUser,
      quoteExpiresAt: clampToRecipientResolutionExpiry(
        checkedQuoteExpiry(
          rawResult.quoteExpiresAt,
          Date.now() + 2 * 60 * 1000,
          "execution.quoteExpiresAt",
        ),
        entityResolution,
      ),
    };
  }

  const hasLaunchV2Marker = hasLaunchFactoryV2Marker(rawResult);
  if (hasLaunchV2Marker) {
    if (network !== "base" || action !== "deploy_token" || !isTransaction) {
      return launchV2ResponseError();
    }
    assertGenericEntityResolutionBinding(entityResolution, rawResult, action);
    return createLaunchFactoryV2Envelope(
      rawResult,
      requestId,
      normalizedUser,
      resolveActiveLaunchV2Config(),
      entityResolution,
    );
  }

  if (
    network === "base" &&
    action === "deploy_token" &&
    process.env.BASE_TOKEN_DEPLOYMENT_MODE?.trim() === "launch_v2"
  ) {
    return launchV2ResponseError();
  }

  const hasV2Marker = hasBaseIntentV2Marker(rawResult);
  if (hasV2Marker) {
    if (network !== "base" || action !== "swap" || !isTransaction) {
      return v2ResponseError();
    }
    return createBaseIntentV2Envelope(
      rawResult,
      requestId,
      normalizedUser,
      resolveActiveV2Config(),
      entityResolution,
    );
  }

  if (
    network === "base" &&
    action === "swap" &&
    process.env.BASE_SWAP_EXECUTION_MODE?.trim() === "intent_v2"
  ) {
    const config = resolveActiveV2Config();
    if (
      !isTransaction ||
      !isCanonicalWrappedNativePrimitive(rawResult, config)
    ) {
      return v2ResponseError();
    }
  }

  if (!isTransaction) {
    return {
      ...rawResult,
      ...(entityResolution ? { entityResolution } : {}),
      status: String(rawResult.status || "success"),
      network,
      chainId: NETWORKS[network].chainId,
      requestId,
      userAddress: normalizedUser,
      quoteExpiresAt: null,
    };
  }

  assertGenericEntityResolutionBinding(entityResolution, rawResult, action);

  if (!action.trim()) {
    throw new IntentResponseError(
      "INVALID_TRANSACTION_ACTION",
      "Transaction response must carry an action bound to the network-target policy.",
    );
  }

  const targetContract = checkedAddress(network, rawTarget, action);
  const calldata = checkedCalldata(
    rawResult.calldata,
    "transaction.calldata",
    action === "transfer" && rawResult.isNativeIn === true,
  );
  const value = decimalValue(
    rawResult.value ?? rawResult.amountInWei ?? "0",
    "transaction.value",
  );
  const quoteExpiresAt = checkedQuoteExpiry(
    rawResult.quoteExpiresAt,
    Date.now() + 5 * 60 * 1000,
    "transaction.quoteExpiresAt",
  );
  const fallback = {
    name: String(rawResult.winner || action || "Kletia route"),
    action,
    router: targetContract,
    calldata,
    value,
    approvals: checkedApprovals(rawResult.approvals, targetContract),
    approvalPolicy: Array.isArray(rawResult.approvals)
      ? ("explicit" as const)
      : ("legacy_inferred" as const),
    isNativeIn: rawResult.isNativeIn === true,
    network,
    chainId: NETWORKS[network].chainId,
    requestId,
    userAddress: normalizedUser,
    quoteExpiresAt,
  };
  const suppliedRoutes = Array.isArray(rawResult.allRoutes)
    ? rawResult.allRoutes
    : [];
  const normalizedRoutes =
    suppliedRoutes.length > 0
      ? suppliedRoutes.map((route) => normalizeRoute(route, fallback))
      : [normalizeRoute({}, fallback, true)];
  const allRoutes = normalizedRoutes.map((route) => ({
    ...route,
    quoteExpiresAt: clampToRecipientResolutionExpiry(
      route.quoteExpiresAt,
      entityResolution,
    ),
  }));
  const effectiveQuoteExpiresAt = Math.min(
    clampToRecipientResolutionExpiry(quoteExpiresAt, entityResolution),
    ...allRoutes.map((route) => route.quoteExpiresAt),
  );

  return {
    ...rawResult,
    ...(entityResolution ? { entityResolution } : {}),
    status: "success",
    action,
    actionType: action,
    targetContract,
    calldata,
    value,
    approvals: fallback.approvals,
    allRoutes,
    network,
    chainId: NETWORKS[network].chainId,
    requestId,
    userAddress: normalizedUser,
    quoteExpiresAt: effectiveQuoteExpiresAt,
  };
}

export function createVerifiedIntentResultEnvelope(
  rawResult: ResultLike,
  network: NetworkId,
  requestId: string,
  userAddress: string,
  trustedEntityResolution: unknown,
) {
  if (!isRecord(trustedEntityResolution)) {
    throw new IntentResponseError(
      "ENTITY_RESOLUTION_REQUIRED",
      "Production execution envelope cannot be created without central entity resolution proof.",
    );
  }
  return createIntentResultEnvelope(
    rawResult,
    network,
    requestId,
    userAddress,
    trustedEntityResolution,
  );
}
