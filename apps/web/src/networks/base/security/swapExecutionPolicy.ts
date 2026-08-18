import { encodeFunctionData, getAddress, isAddress } from "viem";
import {
  hasBaseIntentV2Marker,
  isBaseIntentRouterV2ResponseBinding,
  type IntentResponse,
} from "../../../shared/types";

export type BaseSwapExecutionPolicy = "legacy_v1" | "intent_v2";

const BASE_CHAIN_ID = 8_453;
const BASE_WRAPPED_NATIVE = getAddress(
  "0x4200000000000000000000000000000000000006",
);
const POSITIVE_DECIMAL_PATTERN = /^[1-9]\d*$/u;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)$/u;

const sameAddress = (left: unknown, right: unknown): boolean =>
  typeof left === "string" &&
  typeof right === "string" &&
  isAddress(left) &&
  isAddress(right) &&
  getAddress(left) === getAddress(right);

const sameHex = (left: unknown, right: unknown): boolean =>
  typeof left === "string" &&
  typeof right === "string" &&
  left.toLowerCase() === right.toLowerCase();

const resolvedAction = (response: IntentResponse): string | undefined => {
  const action = response.action?.trim();
  const actionType = response.actionType?.trim();
  if (action && actionType && action !== actionType) return undefined;
  return actionType || action;
};

export const resolveBaseSwapExecutionPolicy = (
  value: unknown,
): BaseSwapExecutionPolicy => {
  if (value === "legacy_v1" || value === "intent_v2") return value;
  throw new Error(
    "VITE_BASE_SWAP_EXECUTION_MODE must be exactly legacy_v1 or intent_v2.",
  );
};

export const isBaseSwapExecutionResponse = (
  response: IntentResponse,
): boolean =>
  response.network === "base" &&
  response.chainId === BASE_CHAIN_ID &&
  (response.action?.trim() === "swap" ||
    response.actionType?.trim() === "swap" ||
    response.allRoutes?.some((route) => route.action?.trim() === "swap") ===
      true);

export const isCanonicalBaseWrappedNativeResponse = (
  response: IntentResponse,
): boolean => {
  const routes = response.allRoutes;
  if (
    response.status !== "success" ||
    response.network !== "base" ||
    response.chainId !== BASE_CHAIN_ID ||
    resolvedAction(response) !== "swap" ||
    hasBaseIntentV2Marker(response) ||
    (response.executionMode !== undefined &&
      response.executionMode !== "direct") ||
    !Array.isArray(routes) ||
    routes.length !== 1
  ) {
    return false;
  }

  const route = routes[0];
  const amountInWei = response.amountInWei;
  const value = response.value;
  const expiry = response.quoteExpiresAt;
  if (
    route.action !== "swap" ||
    route.network !== "base" ||
    route.chainId !== BASE_CHAIN_ID ||
    (route.executionMode !== undefined && route.executionMode !== "direct") ||
    route.simulationStatus !== "passed" ||
    !sameAddress(response.targetContract, BASE_WRAPPED_NATIVE) ||
    !sameAddress(route.router, BASE_WRAPPED_NATIVE) ||
    !sameHex(response.calldata, route.calldata) ||
    typeof amountInWei !== "string" ||
    !POSITIVE_DECIMAL_PATTERN.test(amountInWei) ||
    typeof value !== "string" ||
    !DECIMAL_PATTERN.test(value) ||
    route.value !== value ||
    response.tokenInAddress !== undefined ||
    response.winner !== route.name ||
    response.expectedOutput !== route.expectedOutput ||
    response.routePath !== route.routePath ||
    typeof response.requestId !== "string" ||
    response.requestId.length === 0 ||
    route.requestId !== response.requestId ||
    !sameAddress(response.userAddress, route.userAddress) ||
    typeof expiry !== "number" ||
    !Number.isSafeInteger(expiry) ||
    expiry <= 0 ||
    route.quoteExpiresAt !== expiry ||
    !Array.isArray(response.approvals) ||
    response.approvals.length !== 0 ||
    !Array.isArray(route.approvals) ||
    route.approvals.length !== 0 ||
    !Array.isArray(route.policyTargets) ||
    route.policyTargets.length !== 0 ||
    response.intentRouterV2Coverage !== undefined ||
    response.quoteCoverage !== undefined ||
    response.rankingEvidence !== undefined
  ) {
    return false;
  }

  const amount = BigInt(amountInWei);
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
    args: [amount],
  });

  return response.isNativeIn === true
    ? value === amountInWei && sameHex(response.calldata, depositCalldata)
    : response.isNativeIn === false &&
        value === "0" &&
        sameHex(response.calldata, withdrawCalldata);
};

export const isBaseSwapResponseAllowedForExecutionPolicy = (
  response: IntentResponse,
  policy: BaseSwapExecutionPolicy,
): boolean => {
  if (!isBaseSwapExecutionResponse(response)) return false;

  if (policy === "intent_v2") {
    return (
      isBaseIntentRouterV2ResponseBinding(response) ||
      isCanonicalBaseWrappedNativeResponse(response)
    );
  }

  return !hasBaseIntentV2Marker(response);
};
