import type { ParsedIntent } from "../../shared/ai/parser.js";
import { getAddress, isAddressEqual } from "viem";
import { NETWORKS, arcPublicClient } from "../../shared/config/networks.js";
import {
  ArcPlanError,
  dispatchArcAction,
  getArcPortfolio,
} from "./handlers.js";
import { buildArcAppKitPlan } from "./appKit.js";
import {
  assertOfficialArcCallPlan,
  buildAtomicUsdcPayoutPlan,
  buildOfficialMemoPaymentPlan,
  type ArcOfficialTransactionPlan,
} from "./officialExtensions.js";
import { emitAgentLog } from "../../shared/observability/agentLog.js";

async function prepareOfficialArcPlan(
  plan: ArcOfficialTransactionPlan,
  action: "official_memo_send" | "atomic_payout",
  userAddress: string,
) {
  const user = getAddress(userAddress);
  assertOfficialArcCallPlan(plan);
  if (!isAddressEqual(plan.policyEvidence.executionAccount, user)) {
    throw new ArcPlanError(
      "ARC_OFFICIAL_EXTENSION_ACCOUNT_MISMATCH",
      "Official Arc extension plan is not linked to the active execution account.",
    );
  }
  const [userCode, targetCode] = await Promise.all([
    arcPublicClient.getBytecode({ address: user }),
    arcPublicClient.getBytecode({ address: plan.router }),
  ]);
  if (userCode && userCode !== "0x") {
    throw new ArcPlanError(
      "ARC_OFFICIAL_EXTENSION_EOA_REQUIRED",
      "Direct EOA wallet is required for Arc Memo and Multicall3From original-sender semantics.",
    );
  }
  if (!targetCode || targetCode === "0x") {
    throw new ArcPlanError(
      "ARC_OFFICIAL_EXTENSION_CODE_MISSING",
      "Bytecode verification failed for official Arc extension address.",
      502,
    );
  }

  const [, gasEstimate] = await Promise.all([
    arcPublicClient.call({
      account: user,
      to: plan.router,
      data: plan.calldata,
      value: 0n,
    }),
    arcPublicClient.estimateGas({
      account: user,
      to: plan.router,
      data: plan.calldata,
      value: 0n,
    }),
  ]);

  assertOfficialArcCallPlan(plan);

  return {
    ...plan,
    action,
    actionType: action,
    winner: plan.name,
    winnerMessage: `${plan.expectedOutput}. Official Arc extension call simulated on live RPC.`,
    simulation: {
      status: "simulated" as const,
      finalTransactionSimulated: true,
      requiresPostApprovalSimulation: false,
      gasEstimate: gasEstimate.toString(),
    },
    allRoutes: [
      {
        name: plan.name,
        router: plan.router,
        calldata: plan.calldata,
        value: plan.value,
        expectedOutput: plan.expectedOutput,
        approvals: plan.approvals,
        policyEvidence: plan.policyEvidence,
      },
    ],
  };
}

export async function executeArcEngine(
  intent: ParsedIntent,
  userAddress: string,
  _originalPrompt = "",
  msgId = "",
) {
  if (intent.action === "chat") {
    return { status: "question", action: "chat", message: intent.message };
  }

  if (intent.action === "portfolio") {
    return getArcPortfolio(userAddress);
  }

  if (intent.action === "open_widget") {
    const widgetTarget = String(intent.tokenIn || "").toLowerCase();
    if (!NETWORKS.arc.widgets.includes(widgetTarget)) {
      throw new ArcPlanError(
        "ARC_WIDGET_NOT_AVAILABLE",
        `Widget "${widgetTarget}" is not available on Arc Testnet.`,
      );
    }
    return {
      status: "success",
      action: "open_widget",
      widgetTarget: "arc",
      subTarget: widgetTarget === "arc" ? undefined : widgetTarget,
      winnerMessage: intent.message || "Opening the Arc dashboard.",
    };
  }

  if (
    intent.action === "stable_swap" ||
    intent.action === "appkit_send" ||
    intent.action === "appkit_bridge"
  ) {
    emitAgentLog(
      userAddress,
      msgId,
      `Arc Circle App Kit planner started. Action: ${intent.action}`,
      "arc",
    );
    const result = buildArcAppKitPlan(intent, msgId);
    emitAgentLog(
      userAddress,
      msgId,
      "Arc Circle App Kit plan bound to testnet policy and explicit wallet approval.",
      "arc",
    );
    return result;
  }

  if (intent.action === "official_memo_send") {
    emitAgentLog(
      userAddress,
      msgId,
      "Arc official Memo payment compiler started.",
      "arc",
    );
    const plan = buildOfficialMemoPaymentPlan({
      user: userAddress,
      recipient: String(intent.recipient || ""),
      amount: String(intent.amount || ""),
      reference: String(intent.memo || intent.name || ""),
      requestId: msgId,
    });
    return prepareOfficialArcPlan(plan, "official_memo_send", userAddress);
  }

  if (intent.action === "atomic_payout") {
    emitAgentLog(
      userAddress,
      msgId,
      "Arc official Multicall3From atomic payout compiler started.",
      "arc",
    );
    const plan = buildAtomicUsdcPayoutPlan({
      user: userAddress,
      payouts: (intent.transfers || []).map((transfer) => ({
        recipient: transfer.recipient,
        amount: transfer.amount,
      })),
    });
    return prepareOfficialArcPlan(plan, "atomic_payout", userAddress);
  }

  emitAgentLog(
    userAddress,
    msgId,
    `Arc planner started. Action: ${intent.action}`,
    "arc",
  );
  const result = await dispatchArcAction(intent, userAddress);
  emitAgentLog(
    userAddress,
    msgId,
    `Arc plan ready. Final simulation: ${result.simulation?.status}`,
    "arc",
  );
  return { ...result, actionType: intent.action };
}
