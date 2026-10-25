/**
 * Normalises semantic workflow steps, same-network and cross-network.
 */
import type { ParsedIntent } from "../../shared/ai/parser.js";
import { NETWORKS, type NetworkId } from "../../shared/config/networks.js";
import { workflowActionAllowed, type WorkflowSemanticStep } from "./plan.js";
import { controlled } from "./token.js";

function normalizeSameChainWorkflowSteps(
  intent: ParsedIntent,
  activeNetwork: "arc" | "arbitrum",
): WorkflowSemanticStep[] {
  if (!intent.workflowSteps || intent.workflowSteps.length < 2) {
    throw controlled(
      "WORKFLOW_STEPS_REQUIRED",
      "A multi-step workflow requires at least two explicitly ordered actions.",
    );
  }
  const actionForNetwork = (action: string) => {
    if (activeNetwork !== "arc") return action;
    return ({
      lend: "lending_deposit",
      withdraw: "lending_withdraw",
      borrow: "lending_borrow",
      repay: "lending_repay",
    } as Record<string, string>)[action] || action;
  };
  const requested = intent.workflowSteps.map((step) => ({
    ...step,
    network: step.network || activeNetwork,
    action: actionForNetwork(step.action),
    tokenIn: step.tokenIn?.toUpperCase(),
    tokenOut: step.tokenOut?.toUpperCase(),
  }));
  if (requested.some((step) => step.network !== activeNetwork)) {
    throw controlled(
      "WORKFLOW_LANE_MISMATCH",
      `A ${NETWORKS[activeNetwork].displayName} workflow cannot silently execute a step on another network.`,
    );
  }
  return requested.map((step, index) => {
    if (!workflowActionAllowed(activeNetwork, step.action)) {
      throw controlled(
        "WORKFLOW_STEP_UNSUPPORTED",
        `${step.action} is not available in reviewed ${NETWORKS[activeNetwork].displayName} staged execution.`,
        409,
      );
    }
    if (!step.amount && step.action !== "borrow_capacity") {
      throw controlled("WORKFLOW_AMOUNT_REQUIRED", `Amount is missing for ${step.action}.`);
    }
    const previous = index > 0 ? requested[index - 1] : undefined;
    const previousAsset = String(previous?.tokenOut || "").toUpperCase();
    const inputAsset = String(step.tokenIn || "").toUpperCase();
    const requestedPreviousOutput =
      step.amountSource === "previous_output" ||
      (String(step.amount || "").toUpperCase() === "MAX" && previousAsset === inputAsset);
    if (index === 0 && requestedPreviousOutput) {
      throw controlled(
        "WORKFLOW_PREVIOUS_OUTPUT_INVALID",
        "The first workflow step cannot consume a previous output.",
      );
    }
    if (requestedPreviousOutput && (!previousAsset || previousAsset !== inputAsset)) {
      throw controlled(
        "WORKFLOW_PREVIOUS_ASSET_MISMATCH",
        "A workflow step may consume the preceding output only when both assets match exactly.",
        409,
      );
    }
    const amountSource = requestedPreviousOutput
      ? "previous_output"
      : step.amountSource ||
        (String(step.amount || "").toUpperCase() === "MAX"
          ? "wallet_balance"
          : "explicit");
    if (
      activeNetwork === "arc" &&
      step.action === "lending_deposit" &&
      inputAsset !== "KLET"
    ) {
      throw controlled(
        "WORKFLOW_ARC_LENDING_ASSET_INVALID",
        "Arc staged lending collateral deposits require KLET; the workflow will not substitute another asset.",
        409,
      );
    }
    return {
      id: `step-${index + 1}`,
      order: index + 1,
      action: step.action,
      network: activeNetwork,
      chainId: NETWORKS[activeNetwork].chainId,
      tokenIn: step.tokenIn,
      tokenOut: step.tokenOut,
      amount: requestedPreviousOutput ? "MAX" : step.amount || "0",
      amountSource,
      protocol: step.protocol,
      destinationChain: step.destinationChain,
      objective: step.objective,
      dependsOn: index === 0 ? [] : [`step-${index}`],
      status: index === 0 ? "awaiting_signature" : "planned",
    } satisfies WorkflowSemanticStep;
  });
}

export function normalizeWorkflowSteps(
  intent: ParsedIntent,
  activeNetwork: NetworkId = "base",
): WorkflowSemanticStep[] {
  if (activeNetwork === "arc" || activeNetwork === "arbitrum") {
    return normalizeSameChainWorkflowSteps(intent, activeNetwork);
  }
  if (!intent.workflowSteps || intent.workflowSteps.length < 2) {
    throw controlled(
      "WORKFLOW_STEPS_REQUIRED",
      "A multi-step workflow requires at least two explicitly ordered actions.",
    );
  }
  const requested = intent.workflowSteps.map((step) => ({ ...step }));
  const bridgeIndex = requested.findIndex((step) => step.action === "bridge");
  const normalized = requested.map((step, index) => {
    const normalizeDeFiAsset = (value: string | undefined) =>
      String(value || "").trim().toUpperCase() === "ETH" ? "WETH" : value;
    const inferredBaseSwap =
      step.action === "swap" && bridgeIndex >= 0 && index < bridgeIndex;
    return {
      ...step,
      network: step.network ||
        (step.action === "bridge" ||
        step.action === "gas_acquire" ||
        step.action === "x402_request" ||
        step.action === "data_purchase" ||
        inferredBaseSwap
          ? "base"
          : "arbitrum"),
      tokenIn:
        step.action === "gas_acquire" ? step.tokenIn : normalizeDeFiAsset(step.tokenIn),
      tokenOut:
        step.action === "gas_acquire" ? step.tokenOut : normalizeDeFiAsset(step.tokenOut),
    };
  });

  // If the selected lending representation differs from the Across output,
  // insert a deterministic Arbitrum swap. This is based on adjacent asset
  // identities, not on a hard-coded prompt sentence.
  const normalizedBridgeIndex = normalized.findIndex((step) => step.action === "bridge");
  if (normalizedBridgeIndex >= 0) {
    const bridge = normalized[normalizedBridgeIndex];
    const nextFinancialIndex = normalized.findIndex(
      (step, index) =>
        index > normalizedBridgeIndex &&
        step.network === "arbitrum" &&
        ["lend", "withdraw", "borrow", "borrow_capacity", "repay"].includes(step.action),
    );
    const target = nextFinancialIndex >= 0 ? normalized[nextFinancialIndex].tokenIn : undefined;
    const bridgeAsset = String(bridge.tokenIn || "").toUpperCase();
    if (
      target &&
      bridgeAsset &&
      String(target).toUpperCase() !== bridgeAsset &&
      !normalized.slice(normalizedBridgeIndex + 1, nextFinancialIndex).some(
        (step) => step.action === "swap" &&
          String(step.tokenOut || "").toUpperCase() === String(target).toUpperCase(),
      )
    ) {
      normalized.splice(normalizedBridgeIndex + 1, 0, {
        action: "swap",
        network: "arbitrum",
        tokenIn: bridgeAsset,
        tokenOut: String(target).toUpperCase(),
        amount: "MAX",
        amountSource: "previous_output",
        objective: "best_output",
        protocol: "uniswap-v3",
      });
    }
  }
  if (normalized.length > 8) {
    throw controlled("WORKFLOW_STEP_LIMIT", "The expanded workflow exceeds the eight-step safety limit.");
  }

  return normalized.map((step, index) => {
    const network: "base" | "arc" | "arbitrum" =
      step.network as "base" | "arc" | "arbitrum";
    if (network === "arc") {
      throw controlled(
        "WORKFLOW_NETWORK_UNSUPPORTED",
        "Arc Testnet cannot be mixed with Base/Arbitrum Mainnet capital workflows.",
      );
    }
    const action = step.action === "x402_request" ? "data_purchase" : step.action;
    if (action === "data_purchase") {
      if (
        index !== 0 ||
        network !== "base" ||
        !step.url ||
        step.method !== "GET" ||
        !step.maxPayment
      ) {
        throw controlled(
          "WORKFLOW_DATA_PURCHASE_INVALID",
          "A workflow data purchase must be the first Base step with an explicit HTTPS URL, GET method, and USDC cap.",
        );
      }
    }
    if (action === "gas_acquire") {
      if (
        network !== "base" ||
        String(step.tokenIn || "").toUpperCase() !== "USDC" ||
        String(step.tokenOut || "").toUpperCase() !== "ETH" ||
        step.destinationChain !== "arbitrum" ||
        !step.amount ||
        !step.maxPayment
      ) {
        throw controlled(
          "WORKFLOW_GAS_ACQUISITION_INVALID",
          "Gas acquisition requires Base USDC, an exact Arbitrum ETH output, and an explicit maximum USDC spend.",
        );
      }
    } else if (action === "bridge") {
      if (
        network !== "base" ||
        step.destinationChain !== "arbitrum" ||
        !["USDC", "WETH"].includes(String(step.tokenIn || "").toUpperCase())
      ) {
        throw controlled(
          "WORKFLOW_BRIDGE_UNSUPPORTED",
          "The workflow bridge supports reviewed Base USDC or WETH routes to Arbitrum through Across.",
        );
      }
    } else if (action === "swap" && network === "base") {
      if (
        !step.tokenIn ||
        !step.tokenOut ||
        !["USDC", "WETH"].includes(String(step.tokenOut).toUpperCase())
      ) {
        throw controlled(
          "WORKFLOW_SWAP_ASSETS_REQUIRED",
          "The Base cross-chain swap requires explicit input and a reviewed USDC or WETH bridge output.",
        );
      }
    } else if (action !== "data_purchase" && network !== "arbitrum") {
      throw controlled(
        "WORKFLOW_STEP_NETWORK_INVALID",
        `${step.action} must execute on Arbitrum after the bridge step.`,
      );
    }
    if (!step.amount && action !== "data_purchase" && action !== "borrow_capacity") {
      throw controlled("WORKFLOW_AMOUNT_REQUIRED", `Amount is missing for ${action}.`);
    }
    const previous = index > 0 ? normalized[index - 1] : undefined;
    const consumesPreviousOutput =
      previous !== undefined &&
      String(previous.tokenOut || previous.tokenIn || "").toUpperCase() ===
        String(step.tokenIn || "").toUpperCase() &&
      (String(step.amount || "").toUpperCase() === "MAX" ||
        (step.amountSource === undefined && previous.action === "swap"));
    const amountSource = step.amountSource ||
      (consumesPreviousOutput
        ? "previous_output"
        : String(step.amount || "").toUpperCase() === "MAX"
          ? "wallet_balance"
          : "explicit");
    return {
      id: `step-${index + 1}`,
      order: index + 1,
      action,
      network,
      chainId: NETWORKS[network].chainId as 8453 | 42161,
      tokenIn: step.tokenIn,
      tokenOut: step.tokenOut,
      amount: step.amount || step.maxPayment || "0",
      amountSource,
      protocol: step.protocol,
      destinationChain: step.destinationChain,
      objective: step.objective,
      url: step.url,
      method: step.method,
      maxPayment: step.maxPayment,
      dependsOn: index === 0 ? [] : [`step-${index}`],
      status: index === 0 && action !== "borrow_capacity" ? "awaiting_signature" : "planned",
    };
  });
}
