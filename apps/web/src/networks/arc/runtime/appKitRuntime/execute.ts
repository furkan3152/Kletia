/**
 * Quotes, executes and retries an Arc App Kit plan.
 */
import { getAddress, parseUnits } from "viem";
import type { Connector } from "wagmi";
import type { BridgeResult, SwapResult } from "@circle-fin/app-kit";
import type { ArcAppKitExecutionPlan } from "../../../../shared/types";
import {
  type ArcAppKitExecutionResult,
  type ArcAppKitQuote,
  arcExplorerUrl,
  assertArcAppKitPlan,
  assertTransactionHash,
  type BridgePlan,
  bridgeRecovery,
  recoveryKey,
  tokenDecimals,
  TX_HASH,
} from "./plan";
import {
  arcAppKitPlanFingerprint,
  clearJournal,
  readJournal,
  writeJournal,
} from "./journal";
import {
  assertBridgeEstimateMatchesPlan,
  assertBridgeResultMatchesPlan,
  assertSwapEstimateMatchesPlan,
  assertSwapResultMatchesPlan,
  bridgeParams,
  createRuntime,
  feeText,
  formatBridgeExecutionResult,
  swapParams,
} from "./checks";

export async function quoteArcAppKitPlan(
  connector: Connector,
  expectedAddress: string,
  plan: ArcAppKitExecutionPlan,
): Promise<ArcAppKitQuote> {
  assertArcAppKitPlan(plan);
  const { kit, adapter } = await createRuntime(connector, expectedAddress);
  const base = {
    operation: plan.operation,
    planFingerprint: arcAppKitPlanFingerprint(plan),
    expectedAddress: getAddress(expectedAddress),
    provider: "Circle App Kit" as const,
    environment: "testnet" as const,
    observedAt: new Date().toISOString(),
  };

  if (plan.operation === "swap") {
    const estimate = await kit.estimateSwap(swapParams(plan, adapter));
    assertSwapEstimateMatchesPlan(estimate, plan, expectedAddress);
    const estimatedOutput = estimate.estimatedOutput.amount;
    if (
      plan.minimumOutput &&
      parseUnits(estimatedOutput, tokenDecimals(plan.tokenOut)) <
        parseUnits(plan.minimumOutput, tokenDecimals(plan.tokenOut))
    ) {
      throw new Error(
        `Live output ${plan.minimumOutput} does not meet the user limit under ${plan.tokenOut}.`,
      );
    }
    return {
      ...base,
      headline: `${plan.amount} ${plan.tokenIn} → approximately ${estimatedOutput} ${plan.tokenOut}`,
      estimatedOutput: `${estimatedOutput} ${plan.tokenOut}`,
      minimumOutput: `${estimate.stopLimit.amount} ${plan.tokenOut}`,
      fees: (estimate.fees || []).map(
        (fee) => `${fee.amount} ${String(fee.token)} (${fee.type})`,
      ),
      feeDisclosure:
        "If the provider fee item is absent, this does not guarantee zero gas; the wallet separately displays the final gas amount. The production kit key is not embedded in the client; anonymous SDK quota may apply.",
    };
  }

  if (plan.operation === "send") {
    const estimate = await kit.estimateSend({
      from: { adapter, chain: "Arc_Testnet" },
      to: getAddress(plan.recipient),
      amount: plan.amount,
      token: plan.token,
    });
    if (
      estimate.gas < 0n ||
      estimate.gasPrice < 0n ||
      !/^\d+$/.test(estimate.fee)
    ) {
      throw new Error("Circle Send gas estimate could not be verified.");
    }
    return {
      ...base,
      headline: `${plan.amount} ${plan.token} → ${getAddress(plan.recipient)}`,
      fees: [feeText(estimate.fee, "USDC gas", 18) as string],
      feeDisclosure:
        "Arc gas is paid with native USDC; the displayed gas is an estimate and the wallet approval determines the final amount.",
    };
  }

  const estimate = await kit.estimateBridge(bridgeParams(plan, adapter));
  assertBridgeEstimateMatchesPlan(estimate, plan, expectedAddress);
  const protocolFees = estimate.fees.map(
    (fee) => `${fee.amount as string} ${fee.token} (${fee.type})`,
  );
  const gasFees = estimate.gasFees.map(
    (fee) =>
      `${(fee.fees as { fee: string }).fee} ${fee.token} gas / ` +
      `${String(fee.blockchain)} (${fee.name})`,
  );
  return {
    ...base,
    headline:
      `${plan.amount} USDC → ${plan.destinationChain} ` +
      `(${plan.transferSpeed}, Circle Forwarder)`,
    fees: [...protocolFees, ...gasFees],
    feeDisclosure:
      `${plan.maxFee ? `${plan.maxFee} USDC SDK burn fee cap applied.` : ""}` +
      "Protocol/forwarder fees and network gas are separate items; Kletia will not execute if the fee estimate is uncertain or incomplete.",
  };
}

export async function executeArcAppKitPlan(
  connector: Connector,
  expectedAddress: string,
  plan: ArcAppKitExecutionPlan,
): Promise<ArcAppKitExecutionResult> {
  assertArcAppKitPlan(plan);
  const { kit, adapter, isRetryableError, isUserCancellationError } =
    await createRuntime(connector, expectedAddress);
  const existingJournal = readJournal(plan, expectedAddress);
  if (existingJournal) {
    throw new Error(
      "This App Kit intent has already been executed. To avoid double-spend risk, a new source transaction was not initiated.",
    );
  }
  if (
    !writeJournal(plan, expectedAddress, {
      state: "started",
      consumed: false,
      statusMessage:
        "Waiting for wallet signature/broadcast result; this trace cannot be restarted.",
    })
  ) {
    throw new Error(
      "Secure execution log could not be created. App Kit will not run without double-spend protection.",
    );
  }

  if (plan.operation === "swap") {
    let result: SwapResult;
    try {
      result = await kit.swap(swapParams(plan, adapter));
    } catch (error) {
      if (isUserCancellationError(error)) {
        clearJournal(plan, expectedAddress);
        throw new Error("Wallet signature was cancelled by the user.", {
          cause: error,
        });
      }
      const blocked: ArcAppKitExecutionResult = {
        state: "blocked",
        consumed: true,
        statusMessage:
          "Swap execution was interrupted by an unknown error after signature/broadcast. Do not resend the same intent without chain verification.",
        steps: [],
      };
      writeJournal(plan, expectedAddress, blocked);
      return blocked;
    }
    try {
      assertSwapResultMatchesPlan(result, plan, expectedAddress);
    } catch {
      const blocked: ArcAppKitExecutionResult = {
        state: "blocked",
        consumed: true,
        statusMessage:
          "Swap provider result could not be re-verified against the signed intent. Check your transaction hash in the wallet; do not resend the intent.",
        txHash: TX_HASH.test(result.txHash) ? result.txHash : undefined,
        steps: [],
      };
      writeJournal(plan, expectedAddress, blocked);
      return blocked;
    }
    const state =
      result.progress.status === "DONE"
        ? "success"
        : result.progress.status === "PENDING"
          ? "pending"
          : "blocked";
    const executionResult: ArcAppKitExecutionResult = {
      state,
      consumed: true,
      statusMessage:
        state === "success"
          ? "Arc stable swap completed on-chain."
          : state === "pending"
            ? "Swap source transaction sent but SDK status is not yet finalized. Do not resend the same intent."
            : "Swap source transaction sent but provider did not confirm terminal success. Do not resend the same intent.",
      txHash: result.txHash,
      explorerUrl: arcExplorerUrl(result.txHash),
      steps: [
        {
          name: "Arc stable swap",
          state: result.progress.status,
          txHash: result.txHash,
          explorerUrl: arcExplorerUrl(result.txHash),
        },
      ],
    };
    writeJournal(plan, expectedAddress, executionResult);
    return executionResult;
  }

  if (plan.operation === "send") {
    let result: Awaited<ReturnType<typeof kit.send>>;
    try {
      result = await kit.send({
        from: { adapter, chain: "Arc_Testnet" },
        to: getAddress(plan.recipient),
        amount: plan.amount,
        token: plan.token,
      });
    } catch (error) {
      if (isUserCancellationError(error)) {
        clearJournal(plan, expectedAddress);
        throw new Error("Wallet signature was cancelled by the user.", {
          cause: error,
        });
      }
      const blocked: ArcAppKitExecutionResult = {
        state: "blocked",
        consumed: true,
        statusMessage:
          "Send execution was interrupted by an unknown error after signature/broadcast. Do not resend the same intent without chain verification.",
        steps: [],
      };
      writeJournal(plan, expectedAddress, blocked);
      return blocked;
    }
    const submitted = Boolean(result.txHash) || Boolean(result.batchId);
    if (result.state !== "success" || !result.txHash) {
      if (!submitted) {
        clearJournal(plan, expectedAddress);
        throw new Error("Circle App Kit Send stopped before being sent on-chain.");
      }
      const blocked: ArcAppKitExecutionResult = {
        state: "blocked",
        consumed: true,
        statusMessage:
          "Send transaction may have been broadcast but success was not confirmed. Do not resend the same intent.",
        txHash:
          result.txHash && TX_HASH.test(result.txHash)
            ? result.txHash
            : undefined,
        steps: [],
      };
      writeJournal(plan, expectedAddress, blocked);
      return blocked;
    }
    try {
      assertTransactionHash(result.txHash, "Circle Send");
    } catch {
      const blocked: ArcAppKitExecutionResult = {
        state: "blocked",
        consumed: true,
        statusMessage:
          "Send result could not be verified. Review wallet history and do not resend the same intent.",
        steps: [],
      };
      writeJournal(plan, expectedAddress, blocked);
      return blocked;
    }
    const executionResult: ArcAppKitExecutionResult = {
      state: "success",
      consumed: true,
      statusMessage: "Arc Send completed on-chain.",
      txHash: result.txHash,
      explorerUrl: arcExplorerUrl(result.txHash),
      steps: [
        {
          name: result.name,
          state: result.state,
          txHash: result.txHash,
          explorerUrl: arcExplorerUrl(result.txHash),
          batched: result.batched,
          batchId: result.batchId,
        },
      ],
    };
    writeJournal(plan, expectedAddress, executionResult);
    return executionResult;
  }

  let result: BridgeResult;
  try {
    result = await kit.bridge(bridgeParams(plan, adapter));
  } catch (error) {
    if (isUserCancellationError(error)) {
      clearJournal(plan, expectedAddress);
      throw new Error("Wallet signature was cancelled by the user.", {
        cause: error,
      });
    }
    const blocked: ArcAppKitExecutionResult = {
      state: "blocked",
      consumed: true,
      statusMessage:
        "Bridge execution was interrupted by an unknown error after signing/broadcasting. Do not reburn the same intent before chain confirmation.",
      steps: [],
    };
    writeJournal(plan, expectedAddress, blocked);
    return blocked;
  }
  const likelySubmitted =
    result.state !== "error" ||
    result.steps.some((step) => Boolean(step.txHash) || Boolean(step.batchId));
  try {
    assertBridgeResultMatchesPlan(result, plan, expectedAddress);
  } catch {
    if (!likelySubmitted) {
      clearJournal(plan, expectedAddress);
      throw new Error(
        "Circle bridge result did not match the intent; execution halted due to missing source transaction proof.",
      );
    }
    const blocked: ArcAppKitExecutionResult = {
      state: "blocked",
      consumed: true,
      statusMessage:
        "Bridge provider result could not be re-verified with the intent. Do not resend the same source intent.",
      steps: [],
    };
    writeJournal(plan, expectedAddress, blocked);
    return blocked;
  }
  const failedStep = result.steps.find((step) => step.state === "error");
  const retryable = Boolean(
    failedStep?.error && isRetryableError(failedStep.error),
  );
  const executionResult = formatBridgeExecutionResult(result, retryable);
  if (result.state === "error" && !executionResult.consumed) {
    clearJournal(plan, expectedAddress);
    throw new Error(
      "Circle bridge stopped without sending a source transaction; you may refresh the live estimate.",
    );
  }
  if (executionResult.state === "recoverable") {
    bridgeRecovery.set(recoveryKey(plan.traceId, expectedAddress), {
      result,
      plan,
      expectedAddress: getAddress(expectedAddress),
    });
  } else {
    bridgeRecovery.delete(recoveryKey(plan.traceId, expectedAddress));
  }
  writeJournal(plan, expectedAddress, executionResult);
  return executionResult;
}

export async function retryArcAppKitBridge(
  connector: Connector,
  expectedAddress: string,
  plan: BridgePlan,
): Promise<ArcAppKitExecutionResult> {
  assertArcAppKitPlan(plan);
  const key = recoveryKey(plan.traceId, expectedAddress);
  const recovery = bridgeRecovery.get(key);
  if (
    !recovery ||
    recovery.expectedAddress !== getAddress(expectedAddress) ||
    arcAppKitPlanFingerprint(recovery.plan) !== arcAppKitPlanFingerprint(plan)
  ) {
    throw new Error(
      "Safe SDK retry context not found in this browser session. Do not restart the source bridge; review recorded transaction steps.",
    );
  }
  const { kit, adapter, isRetryableError, isUserCancellationError } =
    await createRuntime(connector, expectedAddress);
  assertBridgeResultMatchesPlan(recovery.result, plan, expectedAddress);
  const failedStep = recovery.result.steps.find(
    (step) => step.state === "error",
  );
  if (!failedStep?.error || !isRetryableError(failedStep.error)) {
    throw new Error(
      "Circle bridge error is not retryable by the official SDK.",
    );
  }
  if (
    !writeJournal(plan, expectedAddress, {
      state: "started",
      consumed: true,
      statusMessage:
        "Bridge is continuing with the official SDK, preserving completed source steps.",
    })
  ) {
    throw new Error("Bridge retry log could not be safely updated.");
  }

  let result: BridgeResult;
  try {
    result = await kit.retryBridge(recovery.result, {
      from: adapter,
      to: undefined,
    });
  } catch (error) {
    if (isUserCancellationError(error)) {
      const previous = formatBridgeExecutionResult(recovery.result, true);
      writeJournal(plan, expectedAddress, previous);
      throw new Error(
        "Bridge continuation signature was cancelled by the user.",
        {
          cause: error,
        },
      );
    }
    const blocked: ArcAppKitExecutionResult = {
      state: "blocked",
      consumed: true,
      statusMessage:
        "Bridge retry call was interrupted in an uncertain state. Source burn was not restarted; check chain and forwarder status.",
      steps: [],
    };
    writeJournal(plan, expectedAddress, blocked);
    return blocked;
  }
  try {
    assertBridgeResultMatchesPlan(result, plan, expectedAddress);
  } catch {
    const blocked: ArcAppKitExecutionResult = {
      state: "blocked",
      consumed: true,
      statusMessage:
        "Bridge retry result could not be verified against the original intent. Source burn was not restarted.",
      steps: [],
    };
    writeJournal(plan, expectedAddress, blocked);
    return blocked;
  }
  const nextFailedStep = result.steps.find((step) => step.state === "error");
  const retryable = Boolean(
    nextFailedStep?.error && isRetryableError(nextFailedStep.error),
  );
  const executionResult = formatBridgeExecutionResult(result, retryable);
  if (executionResult.state === "recoverable") {
    bridgeRecovery.set(key, {
      result,
      plan,
      expectedAddress: getAddress(expectedAddress),
    });
  } else {
    bridgeRecovery.delete(key);
  }
  writeJournal(plan, expectedAddress, executionResult);
  return executionResult;
}
