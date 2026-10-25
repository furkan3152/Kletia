/**
 * Advances and resumes a sealed workflow.
 */
import { getAddress, type Address, type Hex } from "viem";
import { NETWORKS } from "../../shared/config/networks.js";
import type { MutableWorkflowPlan } from "./plan.js";
import { controlled, openWorkflowToken, sealWorkflowPlan } from "./token.js";
import { prepareWorkflowExecution } from "./compile.js";
import {
  readAcrossStatus,
  verifyAcrossDestinationOutput,
  verifyDataPurchaseSettlement,
  verifyTransaction,
} from "./verify.js";

export async function advanceWorkflow(input: {
  workflowToken: unknown;
  userAddress: unknown;
  txHash?: unknown;
  authorizationNonce?: unknown;
}) {
  const plan = openWorkflowToken(input.workflowToken) as MutableWorkflowPlan;
  let userAddress: Address;
  try { userAddress = getAddress(String(input.userAddress)); } catch {
    throw controlled("WORKFLOW_WALLET_INVALID", "Workflow wallet is invalid.");
  }
  if (userAddress !== getAddress(plan.userAddress)) {
    throw controlled("WORKFLOW_WALLET_MISMATCH", "Workflow belongs to a different wallet.", 409);
  }
  const current = plan.steps[plan.currentStepIndex];
  let txHash = current.txHash;
  if (input.txHash !== undefined) {
    if (typeof input.txHash !== "string" || !/^0x[0-9a-f]{64}$/iu.test(input.txHash)) {
      throw controlled("WORKFLOW_TX_HASH_INVALID", "Transaction hash is invalid.");
    }
    txHash = input.txHash as Hex;
    if (current.action === "data_purchase") {
      const authorizationNonce = await verifyDataPurchaseSettlement(
        txHash,
        current,
        userAddress,
        input.authorizationNonce,
      );
      plan.steps[plan.currentStepIndex] = {
        ...current,
        status: "confirmed",
        txHash,
        authorizationNonce,
      };
    } else {
      const actualOutput = await verifyTransaction(
        current.network,
        txHash,
        current,
        userAddress,
      );
      plan.steps[plan.currentStepIndex] = {
        ...current,
        status: "confirmed",
        txHash,
        ...(actualOutput !== undefined
          ? { actualOutputAtomic: actualOutput.toString() }
          : {}),
      };
    }
  }
  const confirmed = plan.steps[plan.currentStepIndex];
  if (!txHash) {
    throw controlled("WORKFLOW_TX_REQUIRED", "The current workflow step has not been submitted.");
  }

  if (confirmed.action === "bridge" || confirmed.action === "gas_acquire") {
    let status: Awaited<ReturnType<typeof readAcrossStatus>>;
    try {
      status = await readAcrossStatus(txHash);
    } catch (error) {
      const candidate = error as { statusCode?: unknown };
      if (Number(candidate.statusCode) < 500) throw error;
      plan.steps[plan.currentStepIndex] = {
        ...confirmed,
        status: "indeterminate",
        txHash,
      };
      return {
        workflowPlan: plan,
        workflowToken: sealWorkflowPlan(plan),
        execution: null,
        retryableStatusCheck: true,
        message:
          "The source transaction is confirmed, but Across lifecycle evidence is temporarily unavailable. No transaction was retried; refresh this checkpoint later.",
      };
    }
    if (status.status === "pending" || status.status === "received") {
      plan.steps[plan.currentStepIndex] = { ...confirmed, status: "submitted", txHash };
      return {
        workflowPlan: plan,
        workflowToken: sealWorkflowPlan(plan),
        execution: null,
        message: "Across deposit is confirmed on Base and is still waiting for destination fill.",
      };
    }
    if (status.status === "expired" || status.status === "refunded") {
      plan.steps[plan.currentStepIndex] = {
        ...confirmed,
        status: status.status === "refunded" ? "refunded" : "failed",
        txHash,
      };
      return {
        workflowPlan: plan,
        workflowToken: sealWorkflowPlan(plan),
        execution: null,
        message: status.status === "refunded"
          ? "Across reports that the deposit was refunded."
          : "Across reports that the deposit expired and is eligible for refund.",
      };
    }
    if (!status.fillTxHash) {
      throw controlled("ACROSS_FILL_EVIDENCE_MISSING", "Across reported filled without a destination transaction hash.", 502);
    }
    const actualOutput = confirmed.action === "bridge"
      ? await verifyAcrossDestinationOutput(
          confirmed,
          status.fillTxHash,
          userAddress,
        )
      : BigInt(confirmed.expectedOutputAtomic || "0");
    plan.steps[plan.currentStepIndex] = {
      ...confirmed,
      status: "filled",
      txHash,
      fillTxHash: status.fillTxHash,
      actualOutputAtomic: actualOutput.toString(),
    };
  } else {
    plan.steps[plan.currentStepIndex] = { ...confirmed, status: "confirmed", txHash };
  }

  const nextIndex = plan.currentStepIndex + 1;
  if (nextIndex >= plan.steps.length) {
    return {
      workflowPlan: plan,
      workflowToken: sealWorkflowPlan(plan),
      execution: null,
      message: "Workflow completed with every submitted step verified onchain.",
    };
  }
  plan.currentStepIndex = nextIndex;
  const next = plan.steps[nextIndex];
  const execution = await prepareWorkflowExecution(plan, next, userAddress);
  if (
    execution &&
    typeof execution === "object" &&
    "readOnlyResult" in execution &&
    execution.readOnlyResult === true
  ) {
    return {
      workflowPlan: plan,
      workflowToken: sealWorkflowPlan(plan),
      execution: null,
      message:
        typeof execution.message === "string"
          ? execution.message
          : "The final read-only workflow result is ready; no transaction was created.",
    };
  }
  return {
    workflowPlan: plan,
    workflowToken: sealWorkflowPlan(plan),
    execution,
    message: `Workflow step ${next.order} is ready for explicit ${NETWORKS[next.network].displayName} wallet approval.`,
  };
}

export async function resumeWorkflow(input: {
  workflowToken: unknown;
  userAddress: unknown;
}) {
  const plan = openWorkflowToken(input.workflowToken) as MutableWorkflowPlan;
  let userAddress: Address;
  try {
    userAddress = getAddress(String(input.userAddress));
  } catch {
    throw controlled("WORKFLOW_WALLET_INVALID", "Workflow wallet is invalid.");
  }
  if (userAddress !== getAddress(plan.userAddress)) {
    throw controlled(
      "WORKFLOW_WALLET_MISMATCH",
      "Workflow belongs to a different wallet.",
      409,
    );
  }
  const current = plan.steps[plan.currentStepIndex];
  if (current.txHash) {
    return advanceWorkflow({
      workflowToken: input.workflowToken,
      userAddress,
    });
  }
  if (current.status !== "awaiting_signature" && current.status !== "planned") {
    throw controlled(
      "WORKFLOW_RESUME_STATE_INVALID",
      "Workflow cannot be resumed from its current checkpoint.",
      409,
    );
  }
  const execution = await prepareWorkflowExecution(plan, current, userAddress);
  if (
    execution &&
    typeof execution === "object" &&
    "readOnlyResult" in execution &&
    execution.readOnlyResult === true
  ) {
    return {
      workflowPlan: plan,
      workflowToken: sealWorkflowPlan(plan),
      execution: null,
      message:
        typeof execution.message === "string"
          ? execution.message
          : "The read-only workflow result is ready; no transaction was created.",
    };
  }
  return {
    workflowPlan: plan,
    workflowToken: sealWorkflowPlan(plan),
    execution,
    message: `Workflow step ${current.order} was re-quoted for explicit wallet approval.`,
  };
}
