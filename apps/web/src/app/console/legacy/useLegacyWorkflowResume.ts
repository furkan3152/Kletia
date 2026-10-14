/**
 * Resumes a stored legacy cross-chain workflow (`/api/workflows/resume` and
 * `/advance`, HMAC-sealed plan) once the wallet that started it is
 * connected, moved unchanged from the old console shell (`App.tsx`). A
 * pending on-chain checkpoint is never dropped on a transient error.
 */
import { useEffect } from "react";
import { useAccount } from "wagmi";
import { NETWORKS } from "../../../shared/config/networks";
import { BACKEND_URL } from "../../../shared/config/runtime";
import { isBaseMcpX402Plan, isBaseX402ChallengeEvidence, type IntentResponse } from "../../../shared/types";
import { useAppStore } from "../../../shared/state/useAppStore";
import { normalizeWalletHistoryOwner } from "../../../shared/state/walletHistoryPolicy";
import { currentEpochMs } from "../../../shared/utils/time";
import { isIntentEntityResolution, responseIntentAction } from "../../../shared/security/entityResolution";
import { isWorkflowPlanV1, isWorkflowToken } from "../../../shared/security/workflowBoundary";
import { getErrorMessage } from "./legacyHelpers";

export function useLegacyWorkflowResume(): void {
  const { address, status: accountStatus } = useAccount();
  const addMessage = useAppStore((state) => state.addMessage);
  const workflowResume = useAppStore((state) => state.workflowResume);
  const setWorkflowResume = useAppStore((state) => state.setWorkflowResume);
  const clearWorkflowResume = useAppStore((state) => state.clearWorkflowResume);

  useEffect(() => {
    if (
      accountStatus !== "connected" ||
      !address ||
      !workflowResume ||
      workflowResume.walletAddress !== normalizeWalletHistoryOwner(address)
    ) {
      return;
    }
    if (workflowResume.expiresAt <= currentEpochMs()) {
      clearWorkflowResume();
      return;
    }
    const alreadyHydrated = Object.values(
      useAppStore.getState().messagesByNetwork,
    )
      .flat()
      .some(
        (message) =>
          message.intentData?.workflowToken === workflowResume.workflowToken,
      );
    if (alreadyHydrated) return;

    const controller = new AbortController();
    void (async () => {
      try {
        const hasPendingCheckpoint = Boolean(workflowResume.pendingCheckpoint);
        const response = await fetch(
          `${BACKEND_URL}/api/workflows/${hasPendingCheckpoint ? "advance" : "resume"}`,
          {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workflowToken: workflowResume.workflowToken,
            userAddress: address,
            ...(workflowResume.pendingCheckpoint
              ? {
                  txHash: workflowResume.pendingCheckpoint.txHash,
                  ...(workflowResume.pendingCheckpoint.authorizationNonce
                    ? {
                        authorizationNonce:
                          workflowResume.pendingCheckpoint.authorizationNonce,
                      }
                    : {}),
                }
              : {}),
          }),
          signal: controller.signal,
          },
        );
        const body = (await response.json().catch(() => null)) as null | {
          success?: boolean;
          message?: string;
          workflowPlan?: unknown;
          workflowToken?: unknown;
          execution?: unknown;
        };
        if (!response.ok || body?.success !== true) {
          throw new Error(body?.message || "Workflow resume was rejected.");
        }
        if (
          !isWorkflowToken(body.workflowToken) ||
          !isWorkflowPlanV1(body.workflowPlan, {
            requestId: workflowResume.requestId,
            userAddress: address,
            nowMs: currentEpochMs(),
          })
        ) {
          throw new Error("Resumed workflow failed its wallet and HMAC boundary.");
        }
        const plan = body.workflowPlan;
        const token = body.workflowToken;
        const current = plan.steps[plan.currentStepIndex];
        const terminal =
          plan.currentStepIndex === plan.steps.length - 1 &&
          ["confirmed", "filled", "ready", "failed", "refunded"].includes(
            current.status,
          );
        if (terminal) {
          clearWorkflowResume();
        } else {
          setWorkflowResume({
            workflowId: plan.workflowId,
            requestId: plan.requestId,
            workflowToken: token,
            walletAddress: normalizeWalletHistoryOwner(address)!,
            expiresAt: plan.expiresAt,
          });
        }

        let intentData: IntentResponse;
        if (body.execution && typeof body.execution === "object") {
          const execution = body.execution as IntentResponse;
          const action = responseIntentAction(execution);
          const commonExecutionMismatch =
            execution.status !== "success" ||
            execution.network !== current.network ||
            execution.chainId !== current.chainId ||
            execution.requestId !== plan.requestId ||
            execution.userAddress?.toLowerCase() !== address.toLowerCase() ||
            !action;
          const dataPurchaseMismatch =
            current.action === "data_purchase" &&
            (execution.provider !== "Base MCP" ||
              execution.approvalRequired !== true ||
              !isBaseMcpX402Plan(execution.mcpPlan) ||
              !isBaseX402ChallengeEvidence(
                execution.challengeEvidence,
                execution.mcpPlan,
                address,
              ));
          const transactionMismatch =
            current.action !== "data_purchase" &&
            (!execution.allRoutes?.length ||
              !isIntentEntityResolution(execution.entityResolution, {
                network: current.network,
                chainId: current.chainId,
                requestId: plan.requestId,
                userAddress: address,
                action: action || "",
              }));
          if (
            commonExecutionMismatch ||
            dataPurchaseMismatch ||
            transactionMismatch
          ) {
            throw new Error("Resumed execution failed its network and entity boundary.");
          }
          intentData = {
            ...execution,
            executionKind: "workflow_plan_v1",
            workflowPlan: plan,
            workflowToken: token,
          };
        } else {
          intentData = {
            status: "success",
            action: "workflow",
            executionKind: "workflow_plan_v1",
            network: current.network,
            chainId: current.chainId,
            requestId: plan.requestId,
            userAddress: address,
            workflowPlan: plan,
            workflowToken: token,
          };
        }
        addMessage({
          id: `${plan.workflowId}:resume:${current.id}`,
          role: "kletia",
          text: body.message || "Workflow checkpoint restored.",
          intentData,
          selectedRouteIndex: intentData.allRoutes?.length ? 0 : undefined,
          terminalLogs: [],
          network: current.network,
          chainId: current.chainId,
          walletAddress: address,
          requestId: plan.requestId,
        });
      } catch (error) {
        if ((error as Error).name === "AbortError") return;
        // A pending onchain checkpoint is deliberately retained. Clearing it
        // after a transient API failure could cause a settled x402 payment to
        // be prepared and signed again.
        if (!workflowResume.pendingCheckpoint) clearWorkflowResume();
        addMessage({
          id: `workflow-resume-error:${workflowResume.workflowId}`,
          role: "kletia",
          text: `Workflow could not be restored safely: ${getErrorMessage(error)}`,
          network: "base",
          chainId: NETWORKS.base.chainId,
          walletAddress: address,
          requestId: workflowResume.requestId,
        });
      }
    })();
    return () => controller.abort();
  }, [
    accountStatus,
    address,
    addMessage,
    clearWorkflowResume,
    setWorkflowResume,
    workflowResume,
  ]);
}

/** Mount point for the lazily loaded engine chunk: resumes a stored workflow, renders nothing. */
export function LegacyWorkflowResume(): null {
  useLegacyWorkflowResume();
  return null;
}
