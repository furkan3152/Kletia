/**
 * Binds a model-produced intent to what the prompt actually says.
 */
import type { NetworkId } from "../../config/networks.js";
import { normalizeBaseProtocolId } from "../../../networks/base/protocols.js";
import type { ParsedIntent } from "./schema.js";
import { REQUIRED_AMOUNT_ACTIONS } from "./actions.js";
import {
  hasPromptBoundAction,
  hasPromptBoundAddress,
  hasPromptBoundBaseAction,
  hasPromptBoundBasePrimaryAmount,
  hasPromptBoundJsonObject,
  hasPromptBoundPrimaryAmount,
  hasPromptBoundTransfer,
  hasPromptBoundUrl,
  LLM_EXECUTABLE_ACTIONS,
  normalizePromptDecimal,
} from "./promptEvidence.js";
import {
  explicitDeployTokenIdentity,
  explicitlyAllowsUncuratedX402,
  explicitMaxGas,
  explicitMaxPriceImpactBps,
  explicitMemoReferences,
  explicitPaymentCaps,
  explicitSlippage,
  explicitTokenLaunchId,
  explicitTransferSpeed,
  hasPromptBoundAmountForAsset,
  hasPromptBoundAsset,
  hasPromptBoundBasename,
  hasPromptBoundDestination,
  hasPromptBoundFee,
  hasPromptBoundMinimumOutput,
  hasPromptBoundRecipientIdentity,
  hasPromptBoundWorkflow,
  isExplicitlyExcludedProtocol,
  normalizedPromptIdentity,
  promptBindingFailure,
} from "./promptConstraints.js";
import {
  detectRiskTolerance,
  extractBaseProtocol,
  extractExplicitlyExcludedBaseProtocols,
} from "./baseExtraction.js";
import { extractDurationInDays, hasOrderedIntentConnector } from "./clauses.js";

export function enforcePromptBoundIntent(
  intent: ParsedIntent,
  bindingText: string,
  network: NetworkId,
): ParsedIntent {
  if (!intent.isComplete) return intent;

  const actionNeedsBinding =
    LLM_EXECUTABLE_ACTIONS.has(intent.action) ||
    new Set([
      "allora_prediction",
      "portfolio",
      "open_widget",
      "yield_compare",
      "borrow_capacity",
      "agent_action",
      "x402_discover",
    ]).has(intent.action);
  if (
    intent.action === "workflow" &&
    !hasPromptBoundWorkflow(intent, bindingText, network)
  ) {
    return promptBindingFailure(
      "The ordered workflow could not be matched step-by-step to the actions, assets and explicit amounts in this message. State each step in execution order without adding an unsupported operation.",
    );
  }
  if (
    actionNeedsBinding &&
    intent.action !== "workflow" &&
    !(network === "base"
      ? hasPromptBoundBaseAction(intent.action, bindingText)
      : hasPromptBoundAction(intent.action, bindingText))
  ) {
    return promptBindingFailure(
      "Transaction or tool type could not be verified with the explicit action in the user message; you must clearly restate what to do.",
    );
  }

  let grounded: ParsedIntent = { ...intent };
  if (
    REQUIRED_AMOUNT_ACTIONS[network].has(intent.action) &&
    !(network === "base"
      ? hasPromptBoundBasePrimaryAmount(intent, bindingText)
      : hasPromptBoundPrimaryAmount(intent, bindingText, network))
  ) {
    return promptBindingFailure(
      "Transaction amount could not be verified with the input asset and explicit amount in the user message; you must restate the amount along with the token.",
    );
  }

  const assetFields = [
    ["input asset", "tokenIn", intent.tokenIn],
    ["output asset", "tokenOut", intent.tokenOut],
    ["collateral asset", "collateralToken", intent.collateralToken],
    ["debt asset", "borrowToken", intent.borrowToken],
  ] as const;
  for (const [label, role, value] of assetFields) {
    if (
      value !== undefined &&
      !(
        label === "input asset" &&
        (intent.action === "basename_register" ||
          intent.action === "basename_renew" ||
          intent.action === "open_widget" ||
          intent.action === "liquid_stake")
      ) &&
      !(label === "output asset" && intent.action === "memo_send") &&
      !hasPromptBoundAsset(value, bindingText, network, role, intent)
    ) {
      return promptBindingFailure(
        `${label} could not be explicitly confirmed in the user message.`,
      );
    }
  }
  const basenameRecipientActions = new Set([
    "appkit_send",
    "appkit_bridge",
    "memo_send",
    "official_memo_send",
  ]);
  const recipientValues = [
    {
      value: intent.recipient,
      allowBasename: basenameRecipientActions.has(intent.action),
    },
    {
      value:
        intent.action === "memo_send" && !intent.recipient
          ? intent.tokenOut
          : undefined,
      allowBasename: true,
    },
  ].filter(({ value }) => value !== undefined);
  if (
    recipientValues.some(
      ({ value, allowBasename }) =>
        !(allowBasename
          ? hasPromptBoundRecipientIdentity(value, bindingText)
          : hasPromptBoundAddress(value, bindingText)),
    )
  ) {
    return promptBindingFailure(
      "Recipient or contract address could not be verified in the current user message; you must explicitly rewrite the address.",
    );
  }

  if (
    intent.transfers &&
    intent.transfers.some(
      ({ recipient, amount }) =>
        !hasPromptBoundTransfer(recipient, amount, bindingText),
    )
  ) {
    return promptBindingFailure(
      "Each recipient and amount in the atomic payment must appear together in the user text.",
    );
  }

  if (
    intent.secondaryAmount !== undefined &&
    !hasPromptBoundAmountForAsset(
      intent.secondaryAmount,
      intent.tokenOut,
      bindingText,
      network,
    )
  ) {
    return promptBindingFailure(
      "Secondary liquidity amount could not be verified together with the output asset in the user message.",
    );
  }
  if (
    intent.minimumOutput !== undefined &&
    !hasPromptBoundMinimumOutput(
      intent.minimumOutput,
      intent.tokenOut,
      bindingText,
      network,
    )
  ) {
    return promptBindingFailure(
      "Minimum output could not be verified with the explicit limit and output asset in the user message.",
    );
  }
  if (
    intent.maxFee !== undefined &&
    !hasPromptBoundFee(intent.maxFee, bindingText)
  ) {
    return promptBindingFailure(
      "Maximum fee could not be verified with the explicit fee cap in the user message.",
    );
  }

  const promptSlippage = explicitSlippage(bindingText);
  const intentSlippage =
    intent.slippage === undefined
      ? null
      : normalizePromptDecimal(intent.slippage);
  if (
    (promptSlippage !== null && intentSlippage !== promptSlippage) ||
    (promptSlippage === null &&
      intentSlippage !== null &&
      intentSlippage !== "1")
  ) {
    return promptBindingFailure(
      "Slippage value must exactly match the explicit percentage in the user message.",
    );
  }
  if (intent.action === "swap" || intent.action === "stable_swap") {
    grounded = {
      ...grounded,
      slippage: promptSlippage || "1",
    };
  }

  if (intent.destinationChain) {
    if (
      !hasPromptBoundDestination(intent.destinationChain, bindingText, network)
    ) {
      return promptBindingFailure(
        "Destination network could not be explicitly verified in the user message.",
      );
    }
  }

  if (intent.action === "memo_send" || intent.action === "official_memo_send") {
    const references = explicitMemoReferences(bindingText);
    const providedReferences = [intent.memo, intent.name]
      .map((value) => String(value ?? "").trim())
      .filter(Boolean);
    if (
      providedReferences.length === 0 ||
      providedReferences.some((value) => !references.has(value))
    ) {
      return promptBindingFailure(
        "Memo/reference must exactly match the explicit value in the user message.",
      );
    }
  }

  if (
    (intent.action === "x402_request" || intent.action === "x402_discover") &&
    !explicitPaymentCaps(bindingText).has(
      normalizePromptDecimal(intent.maxPayment) || "",
    )
  ) {
    return promptBindingFailure(
      "x402 maximum USDC payment cap must exactly match the value in the user message.",
    );
  }
  if (
    intent.action === "x402_request" &&
    !hasPromptBoundUrl(intent.url, bindingText)
  ) {
    return promptBindingFailure(
      "x402 URL must exactly match the full HTTPS URL in the user message.",
    );
  }
  if (intent.action === "x402_request") {
    const explicitMethod = /\bPOST\b/iu.test(bindingText)
      ? "POST"
      : /\bGET\b/iu.test(bindingText)
        ? "GET"
        : null;
    const method = String(intent.method || "").toUpperCase();
    const expectedMethod = explicitMethod || "GET";
    if (method !== expectedMethod) {
      return promptBindingFailure(
        "x402 HTTP method must exactly match the GET/POST method in the user message.",
      );
    }
    if (
      method === "POST" &&
      (intent.requestBody === undefined ||
        !hasPromptBoundJsonObject(intent.requestBody, bindingText))
    ) {
      return promptBindingFailure(
        "x402 POST JSON body must exactly match the object in the user message.",
      );
    }
    if (method !== "POST" && intent.requestBody !== undefined) {
      return promptBindingFailure(
        "A JSON body unauthorized by the user cannot be added to a GET x402 request.",
      );
    }
    grounded = { ...grounded, method: expectedMethod };
  }
  if (intent.action === "x402_discover") {
    grounded = {
      ...grounded,
      curatedOnly: !explicitlyAllowsUncuratedX402(bindingText),
    };
  }

  if (
    (intent.action === "basename_register" ||
      intent.action === "basename_renew") &&
    !hasPromptBoundBasename(intent.tokenIn, bindingText)
  ) {
    return promptBindingFailure(
      "Base Name could not be explicitly verified in the user message.",
    );
  }

  if (intent.action === "deploy_token") {
    const identity = explicitDeployTokenIdentity(bindingText);
    const explicitLaunchId = explicitTokenLaunchId(bindingText);
    if (
      !identity ||
      normalizedPromptIdentity(intent.name) !==
        normalizedPromptIdentity(identity.name) ||
      String(intent.symbol || "")
        .trim()
        .toUpperCase() !== identity.symbol
    ) {
      return promptBindingFailure(
        "Token name and symbol must exactly match the deploy identity in the user message.",
      );
    }
    if (
      intent.launchId !== undefined &&
      (explicitLaunchId === null || intent.launchId !== explicitLaunchId)
    ) {
      return promptBindingFailure(
        "Token launch ID must exactly match the explicit value in the user message.",
      );
    }
    grounded = {
      ...grounded,
      name: identity.name,
      symbol: identity.symbol,
      ...(explicitLaunchId === null
        ? { launchId: undefined }
        : { launchId: explicitLaunchId }),
    };
  }

  const promptDuration = extractDurationInDays(bindingText);
  const suppliedDuration =
    intent.durationInDays === undefined
      ? undefined
      : Number(intent.durationInDays);
  if (
    intent.action === "basename_register" ||
    intent.action === "basename_renew"
  ) {
    const expectedDuration = promptDuration ?? 365;
    if (
      suppliedDuration !== undefined &&
      suppliedDuration !== expectedDuration
    ) {
      return promptBindingFailure(
        "Base Name duration must exactly match the day/month/year value in the user message.",
      );
    }
    grounded = { ...grounded, durationInDays: expectedDuration };
  } else if (intent.action === "stake") {
    const expectedDuration =
      promptDuration ?? (network === "base" ? 30 : undefined);
    if (
      suppliedDuration !== undefined &&
      suppliedDuration > 0 &&
      (expectedDuration === undefined || suppliedDuration !== expectedDuration)
    ) {
      return promptBindingFailure(
        "Stake duration must exactly match the explicit duration in the user message.",
      );
    }
    grounded = {
      ...grounded,
      durationInDays: expectedDuration,
    };
  } else if (
    suppliedDuration !== undefined &&
    suppliedDuration > 0 &&
    (promptDuration === undefined || suppliedDuration !== promptDuration)
  ) {
    return promptBindingFailure(
      "Transaction duration could not be verified against the explicit duration in the user message.",
    );
  }

  if (intent.action === "appkit_bridge") {
    const speed = explicitTransferSpeed(bindingText) || "SLOW";
    if (
      intent.transferSpeed !== undefined &&
      String(intent.transferSpeed).toUpperCase() !== speed
    ) {
      return promptBindingFailure(
        "App Kit transfer speed must exactly match the FAST/SLOW choice in the user message.",
      );
    }
    if (speed === "FAST" && intent.maxFee === undefined) {
      return promptBindingFailure(
        "An explicit maximum fee cap is required from the user for FAST App Kit transfers.",
      );
    }
    grounded = { ...grounded, transferSpeed: speed };
  }

  if (intent.timeHorizonDays !== undefined) {
    if (promptDuration !== intent.timeHorizonDays) {
      return promptBindingFailure(
        "Time horizon must exactly match the explicit duration in the user message.",
      );
    }
  }
  const promptMaxGas = explicitMaxGas(bindingText);
  const intentMaxGas =
    intent.maxGas === undefined ? null : normalizePromptDecimal(intent.maxGas);
  if (
    (intent.maxGas !== undefined && intentMaxGas === null) ||
    promptMaxGas !== intentMaxGas
  ) {
    return promptBindingFailure(
      "Maximum gas value must exactly match the explicit gas cap in the user message.",
    );
  }
  if (promptMaxGas !== null) {
    grounded = { ...grounded, maxGas: promptMaxGas };
  }

  const promptMaxPriceImpactBps = explicitMaxPriceImpactBps(bindingText);
  const intentMaxPriceImpactBps = intent.maxPriceImpactBps ?? null;
  if (promptMaxPriceImpactBps !== intentMaxPriceImpactBps) {
    return promptBindingFailure(
      "Maximum price impact could not be verified against the explicit limit in the user message.",
    );
  }
  if (promptMaxPriceImpactBps !== null) {
    grounded = {
      ...grounded,
      maxPriceImpactBps: promptMaxPriceImpactBps,
    };
  }
  if (network === "base") {
    const excludedProtocols =
      extractExplicitlyExcludedBaseProtocols(bindingText);
    const expected = new Set(excludedProtocols);
    if (
      intent.excludedProtocols?.some(
        (protocol) =>
          !expected.has(normalizeBaseProtocolId(protocol) || protocol),
      )
    ) {
      return promptBindingFailure(
        "Each excluded protocol must be explicitly specified in the user message.",
      );
    }
    grounded = {
      ...grounded,
      excludedProtocols:
        excludedProtocols.length > 0 ? excludedProtocols : undefined,
    };
  } else if (
    intent.excludedProtocols?.some(
      (protocol) => !isExplicitlyExcludedProtocol(protocol, bindingText),
    )
  ) {
    return promptBindingFailure(
      "Each excluded protocol must be explicitly specified in the user message.",
    );
  }
  if (
    intent.allowMultiStep === true &&
    !hasOrderedIntentConnector(bindingText) &&
    !/\b(?:multi[-\s]?step|multiple\s+steps|çok\s+adımlı|cok\s+adimli)\b/iu.test(bindingText)
  ) {
    return promptBindingFailure(
      "Multi-step route authorization must be explicitly granted in the user message.",
    );
  }

  if (network === "base" && intent.protocol) {
    const explicitProtocol = extractBaseProtocol(bindingText);
    const structuralStakeProtocol =
      intent.action === "stake"
        ? String(intent.tokenIn || "").toUpperCase() === "WELL"
          ? "moonwell-safety-module"
          : String(intent.tokenIn || "").toUpperCase() === "SEAM"
            ? "seamless-staking"
            : String(intent.tokenIn || "").toUpperCase() === "AERO"
              ? "aerodrome"
              : undefined
        : undefined;
    if (
      structuralStakeProtocol &&
      (String(intent.protocol).trim().toLowerCase() ===
        structuralStakeProtocol ||
        normalizeBaseProtocolId(String(intent.protocol)) ===
          structuralStakeProtocol)
    ) {
      grounded = {
        ...grounded,
        protocol: structuralStakeProtocol,
      };
    } else if (!explicitProtocol) {
      // An unrequested model-selected protocol would silently collapse
      // the aggregator search to one venue. Leave it open instead.
      grounded = { ...grounded, protocol: undefined };
    } else if (
      normalizeBaseProtocolId(String(intent.protocol)) !== explicitProtocol
    ) {
      grounded = { ...grounded, protocol: explicitProtocol };
    }
  }

  const riskTolerance = detectRiskTolerance(bindingText);
  const objective =
    intent.action === "swap" || intent.action === "stable_swap"
      ? "best_output"
      : intent.action === "borrow" || intent.action === "lending_borrow"
        ? "lowest_borrow_cost"
        : intent.action === "lend"
          ? "best_rate"
          : intent.action === "yield_compare"
            ? /\b(?:borrow|loan)\b|borç|kredi/iu.test(bindingText)
              ? "lowest_borrow_cost"
              : /\b(?:lowest\s+risk|en\s+düşük\s+risk|en\s+dusuk\s+risk)\b/iu.test(
                    bindingText,
                  )
                ? "lowest_risk"
                : "best_rate"
            : intent.objective;

  return {
    ...grounded,
    objective,
    riskTolerance,
  };
}
