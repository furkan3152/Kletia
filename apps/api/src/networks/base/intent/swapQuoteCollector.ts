import { erc20Abi, parseUnits, type Address, type Hex } from "viem";

import type { ParsedIntent } from "../../../ai/parser.js";
import { publicClient } from "../../../config/client.js";
import { getAerodromeRoutes } from "../dex/aerodrome.js";
import { getUniswapAndV2Routes } from "../dex/standardAmm.js";
import { getV3Routes } from "../dex/v3Amm.js";
import {
  SWAP_QUOTE_SOURCES,
  parseSlippageBps,
  summarizeQuoteCoverage,
  type SwapQuoteCoverage,
  type SwapQuoteSource,
} from "../../../intent/routingPolicy.js";
import {
  applyBaseProtocolExclusions,
  assertBaseProtocolConstraintCompatibility,
  assertProtocolExclusionsLeaveEligibleRoutes,
  type ProtocolExclusionEvidence,
} from "../../../intent/protocolConstraints.js";
import { checkTokenSecurity } from "../../../intent/security.js";
import { getAddressSafe } from "../../../intent/utils.js";

export const BASE_SWAP_QUOTE_COLLECTION_POLICY =
  "kletia_base_swap_quote_collection_v1" as const;

export type BaseSwapQuoteExecutionProfile =
  "legacy_direct" | "intent_router_v2";

export interface BaseSwapQuoteCandidate {
  readonly name: string;
  readonly protocolId: string;
  readonly amountOut: bigint;
  readonly expectedOutput: string;
  readonly routePath: string;
  readonly router: Address;
  readonly calldata?: Hex;
  readonly quoteSource: SwapQuoteSource;
  readonly quoteStatus: "quoted";
  readonly [key: string]: unknown;
}

export interface BaseSwapQuoteCollection {
  readonly status: "success";
  readonly quoteCollectionPolicyVersion: typeof BASE_SWAP_QUOTE_COLLECTION_POLICY;
  readonly executionProfile: BaseSwapQuoteExecutionProfile;
  readonly amountInWei: string;
  readonly amountResolution:
    | {
        readonly mode: "exact_input";
        readonly requestedAmount: string;
        readonly inputDecimals: number;
      }
    | {
        readonly mode: "max_balance_snapshot";
        readonly requestedAmount: "MAX";
        readonly inputDecimals: number;
        readonly observedBalanceAtomic: string;
        readonly nativeGasReserveAtomic: string;
      };
  readonly tokenInAddress: Address;
  readonly tokenOutAddress: Address;
  readonly isNativeIn: boolean;
  readonly isNativeOut: boolean;
  readonly value: string;
  readonly allRoutes: readonly BaseSwapQuoteCandidate[];
  readonly quoteCoverage: SwapQuoteCoverage;
  readonly protocolExclusionEvidence: ProtocolExclusionEvidence;
}

function quoteCollectionError(code: string, message: string): Error {
  return Object.assign(new Error(message), {
    code,
    statusCode: 400,
  });
}

function checkedQuoteCandidate(
  value: unknown,
  quoteSource: SwapQuoteSource,
  executionProfile: BaseSwapQuoteExecutionProfile,
): BaseSwapQuoteCandidate | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const route = value as Record<string, unknown>;
  if (
    typeof route.name !== "string" ||
    route.name.trim().length === 0 ||
    typeof route.protocolId !== "string" ||
    route.protocolId.trim().length === 0 ||
    typeof route.amountOut !== "bigint" ||
    route.amountOut <= 0n ||
    typeof route.expectedOutput !== "string" ||
    typeof route.routePath !== "string" ||
    typeof route.router !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/u.test(route.router) ||
    (executionProfile === "legacy_direct" &&
      (typeof route.calldata !== "string" ||
        !/^0x(?:[0-9a-fA-F]{2})+$/u.test(route.calldata)))
  ) {
    return null;
  }

  const { calldata: sourceCalldata, ...quoteEvidence } = route;
  return {
    ...quoteEvidence,
    name: route.name.trim(),
    protocolId: route.protocolId,
    amountOut: route.amountOut,
    expectedOutput: route.expectedOutput,
    routePath: route.routePath,
    router: route.router as Address,
    ...(executionProfile === "legacy_direct"
      ? { calldata: sourceCalldata as Hex }
      : {}),
    quoteSource,
    quoteStatus: "quoted",
  };
}

function collectSourceRoutes(
  result: PromiseSettledResult<readonly unknown[]>,
  source: SwapQuoteSource,
  executionProfile: BaseSwapQuoteExecutionProfile,
): BaseSwapQuoteCandidate[] {
  if (result.status !== "fulfilled") return [];
  return result.value.flatMap((route) => {
    const checked = checkedQuoteCandidate(route, source, executionProfile);
    return checked ? [checked] : [];
  });
}

export async function collectBaseSwapQuotes(
  intent: ParsedIntent,
  userAddress: string,
  executionProfile: BaseSwapQuoteExecutionProfile,
): Promise<BaseSwapQuoteCollection> {
  if (!intent.tokenIn || !intent.tokenOut) {
    throw quoteCollectionError(
      "SWAP_TOKEN_PAIR_REQUIRED",
      "Swap input and output tokens must both be explicit.",
    );
  }

  const tokenInSymbol = intent.tokenIn.trim();
  const tokenOutSymbol = intent.tokenOut.trim();
  const normalizedTokenInSymbol = tokenInSymbol.toUpperCase();
  const normalizedTokenOutSymbol = tokenOutSymbol.toUpperCase();
  if (
    (normalizedTokenInSymbol === "ETH" &&
      normalizedTokenOutSymbol === "WETH") ||
    (normalizedTokenInSymbol === "WETH" && normalizedTokenOutSymbol === "ETH")
  ) {
    throw quoteCollectionError(
      "SWAP_WRAPPED_NATIVE_PRIMITIVE_REQUIRED",
      "ETH/WETH conversion must use the bounded wrapped-native primitive.",
    );
  }

  const excludedProtocolIds = assertBaseProtocolConstraintCompatibility(
    intent.protocol,
    intent.excludedProtocols,
  );
  const tokenInAddress = getAddressSafe(tokenInSymbol);
  const tokenOutAddress = getAddressSafe(tokenOutSymbol);
  if (!tokenInAddress || !tokenOutAddress) {
    throw quoteCollectionError(
      "SWAP_TOKEN_UNSUPPORTED",
      `Unsupported token pair: ${tokenInSymbol}/${tokenOutSymbol}`,
    );
  }

  await Promise.all([
    checkTokenSecurity(tokenInAddress),
    checkTokenSecurity(tokenOutAddress),
  ]);

  const isNativeIn = normalizedTokenInSymbol === "ETH";
  const isNativeOut = normalizedTokenOutSymbol === "ETH";
  const decimalsIn = isNativeIn
    ? 18
    : await publicClient.readContract({
        address: tokenInAddress,
        abi: erc20Abi,
        functionName: "decimals",
      });
  const decimalsOut = isNativeOut
    ? 18
    : await publicClient.readContract({
        address: tokenOutAddress,
        abi: erc20Abi,
        functionName: "decimals",
      });

  const requestedAmount = intent.amount?.trim() || "0";
  const maxRequested = requestedAmount.toUpperCase() === "MAX";
  let amountInWei = maxRequested ? 0n : parseUnits(requestedAmount, decimalsIn);
  const balance = isNativeIn
    ? await publicClient.getBalance({
        address: userAddress as Address,
      })
    : await publicClient.readContract({
        address: tokenInAddress,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [userAddress as Address],
      });
  if (maxRequested) {
    const gasReserve = parseUnits("0.001", 18);
    amountInWei = isNativeIn
      ? balance > gasReserve
        ? balance - gasReserve
        : 0n
      : balance;
  }
  if (amountInWei <= 0n || balance < amountInWei) {
    throw new Error(
      "KEE_ERROR|INSUFFICIENT_FUNDS|Insufficient Balance|" +
        "Insufficient balance. Not enough tokens in wallet. " +
        "Direct the user to fund their wallet. [SHOW_ONRAMP]",
    );
  }

  const deadline = BigInt(Math.floor(Date.now() / 1_000) + 60 * 20);
  const slippageBps = parseSlippageBps(intent.slippage);
  const [aerodromeResult, standardAmmResult, v3Result] =
    await Promise.allSettled([
      getAerodromeRoutes(
        amountInWei,
        tokenInAddress,
        tokenOutAddress,
        tokenInSymbol,
        tokenOutSymbol,
        isNativeIn,
        userAddress,
        deadline,
        decimalsOut,
        slippageBps,
      ),
      getUniswapAndV2Routes(
        amountInWei,
        tokenInAddress,
        tokenOutAddress,
        tokenInSymbol,
        tokenOutSymbol,
        isNativeIn,
        userAddress,
        deadline,
        decimalsOut,
        slippageBps,
      ),
      getV3Routes(
        amountInWei,
        tokenInAddress,
        tokenOutAddress,
        tokenInSymbol,
        tokenOutSymbol,
        isNativeIn,
        userAddress,
        deadline,
        decimalsOut,
        slippageBps,
        {
          executionProfile:
            executionProfile === "intent_router_v2"
              ? "intent_router_v2_quote"
              : "legacy_direct",
        },
      ),
    ]);
  const coverageInputs = [
    {
      source: SWAP_QUOTE_SOURCES.aerodrome,
      result: aerodromeResult,
    },
    {
      source: SWAP_QUOTE_SOURCES.standardAmm,
      result: standardAmmResult,
    },
    {
      source: SWAP_QUOTE_SOURCES.v3Amm,
      result: v3Result,
    },
  ] as const;
  const quoteCoverage = summarizeQuoteCoverage(coverageInputs);
  const routes = coverageInputs.flatMap(({ source, result }) =>
    collectSourceRoutes(result, source, executionProfile),
  );
  const protocolExclusionResult = applyBaseProtocolExclusions(
    routes,
    excludedProtocolIds,
  );
  assertProtocolExclusionsLeaveEligibleRoutes(
    protocolExclusionResult.evidence,
    "Swap",
  );

  return {
    status: "success",
    quoteCollectionPolicyVersion: BASE_SWAP_QUOTE_COLLECTION_POLICY,
    executionProfile,
    amountInWei: amountInWei.toString(),
    amountResolution: maxRequested
      ? {
          mode: "max_balance_snapshot",
          requestedAmount: "MAX",
          inputDecimals: decimalsIn,
          observedBalanceAtomic: balance.toString(),
          nativeGasReserveAtomic: isNativeIn
            ? parseUnits("0.001", 18).toString()
            : "0",
        }
      : {
          mode: "exact_input",
          requestedAmount,
          inputDecimals: decimalsIn,
        },
    tokenInAddress,
    tokenOutAddress,
    isNativeIn,
    isNativeOut,
    value: isNativeIn ? amountInWei.toString() : "0",
    allRoutes: protocolExclusionResult.routes,
    quoteCoverage,
    protocolExclusionEvidence: protocolExclusionResult.evidence,
  };
}
