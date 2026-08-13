import {
  parseUnits,
  erc20Abi,
  encodeFunctionData,
  getAddress,
  parseAbi,
  type Address,
} from "viem";
import type { ParsedIntent } from "../ai/parser.js";
import { publicClient } from "../config/client.js";
import { getPortfolio } from "../networks/base/portfolio/viewer.js";
import { handleBaseName } from "../networks/base/intent/basename.js";
import { handleTokenDeployment } from "../networks/base/creator/token.js";
import { handleNftMint } from "../networks/base/creator/nft.js";

import {
  applyKletiaFee,
  feePolicyActionForIntent,
} from "../networks/base/intent/feeManager.js";
import { xRaySimulate } from "./security.js";
import {
  handleSmartSwap,
  handleDeFiBanking,
  handleStaking,
  handleLiquidStaking,
  handleLiquidity,
  handleBridge,
  handleYieldCompare,
} from "./handlers.js";

import KletiaSmartRouterABI from "../networks/arc/KletiaSmartRouter.abi.json" with { type: "json" };
import {
  assertBaseX402PaymentPromptBinding,
  buildBaseMcpX402Plan,
  discoverBaseX402Services,
  type BaseX402ChallengeEvidence,
} from "../networks/base/intent/x402.js";
import { buildSwapRankingEvidence, rankSwapRoutes } from "./routingPolicy.js";
import { resolveConfiguredBaseSwapExecution } from "../networks/base/config/intentRouterV2Environment.js";
import { executeBaseIntentV2Swap } from "../networks/base/intent/routerV2Integration.js";
import { agentLogRoom, emitAgentLog } from "../observability/agentLog.js";

export { agentLogRoom, emitAgentLog } from "../observability/agentLog.js";

const KLETIA_ROUTER_ADDRESS = getAddress(
  "0x8214b00F49Da60684ce4B2C0b16dDB8a29d777cf",
);
const KLETIA_ROUTER_ABI = KletiaSmartRouterABI;
const KLETIA_ROUTER_GUARD_ABI = parseAbi([
  "function approvedTargets(address target) view returns (bool)",
]);
const BASE_AMOUNT_ACTIONS = new Set([
  "swap",
  "add_liquidity",
  "remove_liquidity",
  "stake",
  "liquid_stake",
  "liquid_unstake",
  "borrow",
  "lend",
  "repay",
  "withdraw",
  "bridge",
  "deploy_token",
  "mint_nft",
]);
const ALLORA_ASSETS = ["BTC", "ETH"] as const;
const ALLORA_TIMEOUT_MS = 8_000;

function assertExplicitPositiveAmount(action: string, amount: unknown) {
  if (!BASE_AMOUNT_ACTIONS.has(action)) return;
  const normalized = String(amount ?? "").trim();
  const isMax = normalized.toUpperCase() === "MAX";
  const isPositiveDecimal =
    /^(?:\d+\.?\d*|\.\d+)$/.test(normalized) &&
    Number.isFinite(Number(normalized)) &&
    Number(normalized) > 0;
  if (!isMax && !isPositiveDecimal) {
    throw Object.assign(
      new Error(
        "İşlem için pozitif bir miktar veya açıkça MAX belirtilmelidir.",
      ),
      { code: "AMOUNT_REQUIRED", statusCode: 400 },
    );
  }
}

async function settleWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        try {
          results[index] = {
            status: "fulfilled",
            value: await worker(items[index]),
          };
        } catch (reason) {
          results[index] = { status: "rejected", reason };
        }
      }
    }),
  );
  return results;
}

export async function handleAlloraPrediction(
  asset: string,
  userAddress: string,
) {
  const normalizedAsset = asset.trim().toUpperCase();
  if (
    !ALLORA_ASSETS.includes(normalizedAsset as (typeof ALLORA_ASSETS)[number])
  ) {
    throw Object.assign(
      new Error("Allora observations are available only for BTC and ETH."),
      { code: "ALLORA_ASSET_UNSUPPORTED", statusCode: 400 },
    );
  }

  const apiKey = process.env.ALLORA_API_KEY?.trim();
  if (!apiKey) {
    throw Object.assign(new Error("Live prediction service is unavailable."), {
      code: "ALLORA_UNAVAILABLE",
      statusCode: 503,
    });
  }

  emitAgentLog(
    userAddress,
    "sys",
    `Fetching a 5-minute ${normalizedAsset} observation from Allora...`,
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ALLORA_TIMEOUT_MS);

  try {
    const response = await fetch(
      `https://api.allora.network/v2/allora/consumer/price/ethereum-11155111/${normalizedAsset}/5m`,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          "x-api-key": apiKey,
        },
        signal: controller.signal,
      },
    );
    const payload: unknown = await response.json();
    const root =
      typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : null;
    const nestedData =
      typeof root?.data === "object" &&
      root.data !== null &&
      !Array.isArray(root.data)
        ? (root.data as Record<string, unknown>)
        : null;
    const rawInference = nestedData?.inference_data ?? root?.inference_data;
    const inference =
      typeof rawInference === "object" &&
      rawInference !== null &&
      !Array.isArray(rawInference)
        ? (rawInference as Record<string, unknown>)
        : null;
    const rawPrice = inference?.network_inference_normalized;
    const predictedPrice =
      typeof rawPrice === "string" || typeof rawPrice === "number"
        ? Number(rawPrice)
        : Number.NaN;

    if (
      !response.ok ||
      !root ||
      root.status === false ||
      !Number.isFinite(predictedPrice) ||
      predictedPrice <= 0
    ) {
      throw new Error("INVALID_ALLORA_RESPONSE");
    }

    return {
      status: "success",
      action: "allora_prediction",
      winnerMessage:
        `🔮 Allora Network 5-minute **${normalizedAsset}** price observation: ` +
        `**$${predictedPrice.toFixed(2)}**.\n\n` +
        "This is a model inference for information only, not a buy/sell recommendation.",
    };
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    console.error(`[Allora] Intent observation failed (${errorName}).`);
    throw Object.assign(
      new Error("Live prediction data is temporarily unavailable."),
      { code: "ALLORA_PROVIDER_ERROR", statusCode: 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function executeKletiaEngine(
  intent: ParsedIntent,
  userAddress: string,
  originalPrompt: string = "",
  msgId: string = "",
  baseX402Challenge?: BaseX402ChallengeEvidence,
) {
  try {
    if (intent.action === "portfolio") return await getPortfolio(userAddress);

    if (intent.action === "chat") {
      return { status: "question", message: intent.message };
    }

    if (intent.action === "agent_action") {
      return {
        status: "question",
        action: "agent_action",
        message:
          "Resmî Base MCP handoff paneli hazır. OAuth ve get_wallets doğrulamasını desteklenen ajan istemcinde tamamla; Kletia hiçbir cüzdanı sahiplenmez veya işlemi kendisi yürütmez.",
        winnerMessage:
          "Base MCP handoff hazır; bağlantı, cüzdan seçimi ve her işlem onayı resmî istemcide kalır.",
      };
    }

    if (intent.action === "allora_prediction") {
      return await handleAlloraPrediction(intent.tokenIn || "ETH", userAddress);
    }

    if (intent.action === "open_widget") {
      return {
        status: "success",
        action: "open_widget",
        widgetTarget: intent.tokenIn,
        winnerMessage: intent.message || "İlgili modülü açıyorum...",
      };
    }

    if (intent.action === "x402_discover") {
      assertBaseX402PaymentPromptBinding(intent.maxPayment, originalPrompt);
      emitAgentLog(
        userAddress,
        msgId,
        "Coinbase CDP Bazaar Base x402 discovery started.",
      );
      return await discoverBaseX402Services({
        query: intent.serviceQuery,
        maxPayment: intent.maxPayment,
        curatedOnly: intent.curatedOnly !== false,
      });
    }

    if (intent.action === "x402_request") {
      emitAgentLog(
        userAddress,
        msgId,
        "Base MCP x402 approval plan compiler started.",
      );
      return buildBaseMcpX402Plan(
        intent,
        msgId,
        originalPrompt,
        baseX402Challenge,
        userAddress,
      );
    }

    if (intent.action === "yield_compare") {
      return await handleYieldCompare(intent);
    }

    let action = intent.action.toLowerCase();
    if (action === "addliquidity") action = "add_liquidity";
    if (action === "removeliquidity") action = "remove_liquidity";
    if (action === "liquidstake") action = "liquid_stake";
    if (action === "liquidunstake") action = "liquid_unstake";

    const workingIntent: ParsedIntent = { ...intent };
    const originalGrossAmountStr = workingIntent.amount || "0";
    assertExplicitPositiveAmount(action, originalGrossAmountStr);

    const tokenInSymbol = workingIntent.tokenIn?.trim().toUpperCase();
    const tokenOutSymbol = workingIntent.tokenOut?.trim().toUpperCase();
    const isWrappedNativeConversion =
      action === "swap" &&
      ((tokenInSymbol === "ETH" && tokenOutSymbol === "WETH") ||
        (tokenInSymbol === "WETH" && tokenOutSymbol === "ETH"));
    const swapExecutionConfig =
      action === "swap"
        ? resolveConfiguredBaseSwapExecution(process.env)
        : null;
    const useIntentRouterV2 =
      swapExecutionConfig?.mode === "intent_v2" && !isWrappedNativeConversion;
    const feeApplication = useIntentRouterV2
      ? {
          netAmountStr: originalGrossAmountStr,
          feeData: null,
        }
      : await applyKletiaFee(
          workingIntent.tokenIn || "ETH",
          originalGrossAmountStr,
          userAddress,
          feePolicyActionForIntent(
            action,
            workingIntent.tokenIn,
            workingIntent.tokenOut,
          ),
        );
    const { netAmountStr, feeData } = feeApplication;
    workingIntent.amount = netAmountStr;
    emitAgentLog(
      userAddress,
      msgId,
      `🛡️ Kletia Engine başlatıldı. Action: ${action}`,
    );

    let result: any;
    switch (action) {
      case "swap":
        result =
          swapExecutionConfig?.mode === "intent_v2" &&
          !isWrappedNativeConversion
            ? await executeBaseIntentV2Swap(
                workingIntent,
                userAddress,
                swapExecutionConfig,
              )
            : await handleSmartSwap(workingIntent, userAddress);
        break;
      case "lend":
      case "borrow":
      case "repay":
      case "withdraw":
        result = await handleDeFiBanking(workingIntent, userAddress);
        break;
      case "stake":
        result = await handleStaking(workingIntent, userAddress);
        break;
      case "liquid_stake":
      case "liquid_unstake":
        result = await handleLiquidStaking(workingIntent, userAddress);
        break;
      case "add_liquidity":
      case "remove_liquidity":
        result = await handleLiquidity(workingIntent, userAddress);
        break;
      case "bridge":
        result = await handleBridge(workingIntent, userAddress);
        break;
      case "basename_register":
      case "basename_renew":
        result = await handleBaseName(workingIntent, userAddress);
        const sim = await xRaySimulate(
          result.targetContract as `0x${string}`,
          result.calldata as `0x${string}`,
          userAddress,
          result.amountInWei,
          result.winner,
        );
        if (!sim.success) {
          const simulationError =
            typeof sim.error === "object" && sim.error !== null
              ? (sim.error as Record<string, unknown>)
              : null;
          const simulationDetail =
            typeof simulationError?.shortMessage === "string"
              ? simulationError.shortMessage
              : "Reverted";
          throw new Error(
            `Ağ Kuralları İhlali: Bu işlem ağ tarafından reddediliyor. Detay: ${simulationDetail}`,
          );
        }
        break;
      case "deploy_token":
        emitAgentLog(userAddress, msgId, `🛠️ Token fabrikası hazırlanıyor...`);
        const tokenResult = await handleTokenDeployment(
          userAddress,
          workingIntent.name,
          workingIntent.symbol,
          originalGrossAmountStr,
          workingIntent.launchId,
          workingIntent.recipient,
        );
        result = {
          ...tokenResult,
          targetContract: tokenResult.target,
          amountInWei: tokenResult.value.toString(),
          winner:
            "executionMode" in tokenResult &&
            tokenResult.executionMode === "kletia_launch_factory_v2"
              ? "Kletia Launch Factory V2"
              : "Kletia Token Factory",
        };
        const deploymentSimulation = await xRaySimulate(
          result.targetContract,
          result.calldata,
          userAddress,
          result.amountInWei,
          result.winner,
        );
        if (!deploymentSimulation.success) {
          throw Object.assign(
            new Error(
              "Token deployment transaction failed live Base simulation.",
            ),
            {
              code: "TOKEN_DEPLOYMENT_SIMULATION_FAILED",
              statusCode: 400,
            },
          );
        }
        break;
      case "mint_nft":
        await handleNftMint(
          userAddress,
          workingIntent.tokenIn,
          originalGrossAmountStr,
        );
        throw new Error("Unreachable NFT mint state.");
      default:
        throw new Error(`Desteklenmeyen İşlem: ${intent.action}`);
    }

    emitAgentLog(
      userAddress,
      msgId,
      `✅ Motor işlemi tamamladı. X-Ray onayı bekleniyor...`,
    );
    result.actionType = action;

    if (
      feeData &&
      result.status === "success" &&
      !(result.winner && result.winner.includes("WETH Contract"))
    ) {
      const isNative = feeData.isNative;
      const decimals = isNative
        ? 18
        : await publicClient.readContract({
            address: feeData.tokenAddress as `0x${string}`,
            abi: erc20Abi,
            functionName: "decimals",
          });

      let grossAmountWei = 0n;
      if (originalGrossAmountStr.toUpperCase() === "MAX") {
        grossAmountWei = BigInt(result.amountInWei) + BigInt(feeData.amountWei);
      } else {
        grossAmountWei = parseUnits(originalGrossAmountStr, decimals);
      }

      const rawRoutes: Array<Record<string, any>> = Array.isArray(
        result.allRoutes,
      )
        ? (result.allRoutes as Array<Record<string, any>>)
        : [];
      if (rawRoutes.length === 0) {
        throw Object.assign(
          new Error("Fee router requires an explicit executable route."),
          { code: "FEE_ROUTER_ROUTE_REQUIRED", statusCode: 400 },
        );
      }

      const compatibleRoutes = rawRoutes.filter(
        (route) =>
          route.executionMode !== "direct" &&
          route.feeRouterCompatible !== false &&
          route.execution?.feeRouterCompatible !== false,
      );
      const uniqueTargets: Address[] = [
        ...new Map<string, Address>(
          compatibleRoutes.map((route) => {
            const target = getAddress(String(route.router));
            return [target.toLowerCase(), target] as const;
          }),
        ).values(),
      ];
      const targetChecks = await Promise.all(
        uniqueTargets.map(async (target) => {
          try {
            const approved = await publicClient.readContract({
              address: KLETIA_ROUTER_ADDRESS,
              abi: KLETIA_ROUTER_GUARD_ABI,
              functionName: "approvedTargets",
              args: [target],
            });
            return [target.toLowerCase(), approved === true] as const;
          } catch {
            return [target.toLowerCase(), false] as const;
          }
        }),
      );
      const approvedTargetMap = new Map(targetChecks);
      const wrappedCandidates: any[] = [];
      for (const route of compatibleRoutes) {
        const routeApprovals = Array.isArray(route.approvals)
          ? route.approvals
          : [];
        const declaredInputs = [
          [route.primaryTokenAddress, route.primaryAmountInWei],
          [route.secondaryTokenAddress, route.secondaryAmountInWei],
        ].filter((input) => input[0] && BigInt(input[1] || "0") > 0n);
        if (routeApprovals.length > 1 || declaredInputs.length > 1) {
          continue;
        }

        const targetProtocol = getAddress(route.router);
        const targetCalldata = route.calldata as `0x${string}`;
        const approvedTarget =
          approvedTargetMap.get(targetProtocol.toLowerCase()) === true;
        if (!approvedTarget) continue;

        const wrappedCalldata = isNative
          ? encodeFunctionData({
              abi: KLETIA_ROUTER_ABI,
              functionName: "executeETH",
              args: [targetProtocol, targetCalldata],
            })
          : encodeFunctionData({
              abi: KLETIA_ROUTER_ABI,
              functionName: "executeERC20",
              args: [
                feeData.tokenAddress as `0x${string}`,
                grossAmountWei,
                targetProtocol,
                targetCalldata,
              ],
            });
        const approvals = isNative
          ? []
          : [
              {
                token: feeData.tokenAddress,
                spender: KLETIA_ROUTER_ADDRESS,
                amount: grossAmountWei.toString(),
                symbol: workingIntent.tokenIn,
                calldata: encodeFunctionData({
                  abi: erc20Abi,
                  functionName: "approve",
                  args: [KLETIA_ROUTER_ADDRESS, grossAmountWei],
                }),
                required: true,
              },
            ];
        wrappedCandidates.push({
          ...route,
          underlyingRouter: targetProtocol,
          underlyingCalldata: targetCalldata,
          router: KLETIA_ROUTER_ADDRESS,
          calldata: wrappedCalldata,
          value: isNative ? grossAmountWei.toString() : "0",
          approvals,
          executionMode: "kletia_fee_router",
          callerSemantics: "explicit_recipient",
          feeRouterCompatible: true,
          policyTargets: [targetProtocol],
          expectedOutput: `${route.expectedOutput || result.expectedOutput} (Includes %0.1 Kletia Fee)`,
        });
      }
      const wrappedRoutes: any[] = [];
      const wrappedSimulationResults = await settleWithConcurrency(
        wrappedCandidates,
        4,
        async (wrappedRoute) => ({
          wrappedRoute,
          simulation: await xRaySimulate(
            KLETIA_ROUTER_ADDRESS,
            wrappedRoute.calldata,
            userAddress,
            wrappedRoute.value,
            `Kletia Fee Router → ${wrappedRoute.name}`,
            isNative
              ? []
              : [
                  {
                    addr: feeData.tokenAddress,
                    amt: grossAmountWei.toString(),
                  },
                ],
          ),
        }),
      );
      for (const simulationResult of wrappedSimulationResults) {
        if (simulationResult.status === "rejected") continue;
        const { wrappedRoute, simulation } = simulationResult.value;
        if (simulation.success || simulation.deferredUntilApproval) {
          wrappedRoutes.push({
            ...wrappedRoute,
            simulationStatus: simulation.success
              ? "passed"
              : "deferred_until_approval",
          });
        }
      }

      result.feeRouterCoverage = {
        requestedRouteCount: rawRoutes.length,
        compatibleRouteCount: compatibleRoutes.length,
        approvedRouteCount: wrappedCandidates.length,
        unapprovedTargetCount: targetChecks.filter(([, approved]) => !approved)
          .length,
        unapprovedTargets: targetChecks
          .filter(([, approved]) => !approved)
          .map(([target]) => getAddress(target)),
        simulatedRouteCount: wrappedSimulationResults.length,
        eligibleRouteCount: wrappedRoutes.length,
      };

      if (wrappedRoutes.length === 0) {
        throw Object.assign(
          new Error(
            "No route passed the Kletia fee-router allowlist and simulation.",
          ),
          { code: "FEE_ROUTER_UNAVAILABLE", statusCode: 400 },
        );
      }

      const finalRoutes =
        result.rankingEvidence &&
        wrappedRoutes.every(
          (route) =>
            typeof route.amountOut === "bigint" &&
            (route.simulationStatus === "passed" ||
              route.simulationStatus === "deferred_until_approval"),
        )
          ? rankSwapRoutes(wrappedRoutes)
          : wrappedRoutes;
      const wrappedWinner = finalRoutes[0];
      result.allRoutes = finalRoutes;
      result.winner = wrappedWinner.name;
      result.targetContract = wrappedWinner.router;
      result.calldata = wrappedWinner.calldata;
      result.value = wrappedWinner.value;
      result.approvals = wrappedWinner.approvals;
      result.tokenInAddress = isNative ? undefined : feeData.tokenAddress;
      result.isNativeIn = isNative;
      result.amountInWei = grossAmountWei.toString();
      result.expectedOutput = wrappedWinner.expectedOutput;
      if (result.rankingEvidence) {
        result.rankingEvidence = buildSwapRankingEvidence(
          finalRoutes,
          result.rankingEvidence.protocolRestriction || undefined,
          "final_routes_after_fee_router_allowlist_and_simulation",
        );
      }
    }

    return result;
  } catch (error) {
    throw error;
  }
}
