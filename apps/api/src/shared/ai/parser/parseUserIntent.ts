/**
 * The public parser entry point: deterministic grammars first, then the
 * optional model fallback.
 */
import { NETWORKS, type NetworkId } from "../../config/networks.js";
import {
  IntentDisclosureConsentRequiredError,
  IntentParserError,
  IntentSchema,
  type IntentSemanticPlannerMode,
  type ParsedIntent,
} from "./schema.js";
import {
  arcActionSupportsMax,
  hasSafeExplicitAmount,
  normalizeAssetMention,
  normalizeParsedAction,
  REQUIRED_AMOUNT_ACTIONS,
} from "./actions.js";
import {
  hasExplicitTransactionNegation,
  hasNonExecutionSpeechAct,
} from "./speechActs.js";
import { hasPromptBoundAction } from "./promptEvidence.js";
import {
  baseExecutionConstraintFailure,
  buildPromptBindingText,
  conflictingBaseActions,
  promptBindingFailure,
} from "./promptConstraints.js";
import { enforcePromptBoundIntent } from "./promptEnforcement.js";
import { parseDeterministicArcIntent } from "./arcIntent.js";
import { parseDeterministicArbitrumIntent } from "./arbitrumIntent.js";
import { parseDeterministicBaseIntent } from "./baseWorkflow.js";
import {
  buildSystemPrompt,
  compactStructuredIntent,
  structuredIntentResponseFormat,
} from "./structuredOutput.js";

export async function parseUserIntent(
  userPrompt: string,
  conversationHistory: any[] = [],
  network: NetworkId = "base",
  options: {
    readonly semanticPlanner?: IntentSemanticPlannerMode;
    /**
     * Emitted immediately before a semantic-provider request is started. The
     * caller uses this to report actual prompt disclosure instead of assuming
     * every `ai_assisted` request reached the provider. No prompt value is
     * passed to the callback.
     */
    readonly onSemanticProviderRequest?: () => void;
  } = {},
): Promise<ParsedIntent> {
  const originalUserPrompt = userPrompt;
  const bindingText = buildPromptBindingText(
    originalUserPrompt,
    conversationHistory,
  );
  if (network === "arbitrum") {
    const readOnlyIntent = parseDeterministicArbitrumIntent(userPrompt);
    if (readOnlyIntent) {
      return readOnlyIntent.isComplete
        ? enforcePromptBoundIntent(readOnlyIntent, bindingText, network)
        : readOnlyIntent;
    }
  }
  if (hasExplicitTransactionNegation(userPrompt)) {
    return {
      isComplete: false,
      action: "chat",
      message:
        "An explicit negative transaction request was detected; no transaction route was prepared.",
      question: "",
      amount: "0",
      durationInDays: 0,
    };
  }
  if (hasNonExecutionSpeechAct(userPrompt)) {
    return {
      isComplete: false,
      action: "chat",
      message:
        "An informational or hypothetical question was detected; no transaction route was prepared due to lack of an explicit execution request.",
      question: "",
      amount: "0",
      durationInDays: 0,
    };
  }
  if (
    network === "arc" &&
    /\[(?:AMOUNT|SLIPPAGE|MINIMUM_OUTPUT|RECIPIENT_ADDRESS|PUBLIC_REFERENCE)\]/i.test(
      userPrompt,
    )
  ) {
    return {
      isComplete: false,
      action: "chat",
      message:
        "You must replace the bracketed amount, limit, recipient, and reference fields in the Arc template with actual values; no route was prepared.",
      question: "",
      amount: "0",
      durationInDays: 0,
    };
  }
  if (network === "base") {
    const constraintFailure = baseExecutionConstraintFailure(bindingText);
    if (constraintFailure) {
      return promptBindingFailure(constraintFailure);
    }
    const requestedActions = conflictingBaseActions(bindingText);
    if (
      requestedActions.length > 1 &&
      !hasPromptBoundAction("workflow", bindingText)
    ) {
      return promptBindingFailure(
        "Multiple financial actions cannot be safely reduced to a single intent in one message; you must send transactions separately or as a clear, approved plan.",
      );
    }
    const deterministic = parseDeterministicBaseIntent(userPrompt);
    if (deterministic) {
      return enforcePromptBoundIntent(deterministic, bindingText, network);
    }
  } else if (network === "arc") {
    const deterministic = parseDeterministicArcIntent(userPrompt);
    if (deterministic) return deterministic;
  }
  if ((options.semanticPlanner ?? "deterministic_only") === "deterministic_only") {
    throw new IntentDisclosureConsentRequiredError(network);
  }
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new IntentParserError("Intent parsing service is not configured.");
  }
  const networkConfig = NETWORKS[network];

  // Short replies to the last assistant question are completed deterministically.
  if (conversationHistory.length > 0) {
    const lastMsg = conversationHistory[conversationHistory.length - 1];
    if (lastMsg.role === "assistant" && typeof lastMsg.content === "string") {
      const lc = lastMsg.content.toLowerCase();
      if (
        lc.includes("extend duration") ||
        lc.includes("which name's duration")
      ) {
        if (
          userPrompt.toLowerCase().includes(".base.eth") ||
          userPrompt.split(" ").length === 1
        ) {
          userPrompt = `${userPrompt} extend duration`;
        }
      } else if (
        lc.includes("want to interact") ||
        lc.includes("want to buy") ||
        lc.includes("which name to buy") ||
        lc.includes("that you want to transact with") ||
        lc.includes("that you want to buy") ||
        lc.includes("hangi ismi almak")
      ) {
        if (
          userPrompt.toLowerCase().includes(".base.eth") ||
          userPrompt.split(" ").length === 1
        ) {
          userPrompt = `${userPrompt} buy`;
        }
      } else if (lc.includes("borrow")) {
        const prevUserMsg = conversationHistory
          .slice()
          .reverse()
          .find((m: any) => m.role === "user");
        let protocolMatch = "";
        if (prevUserMsg) {
          const prevLc = prevUserMsg.content.toLowerCase();
          if (prevLc.includes("aave")) protocolMatch = " from aave";
          if (prevLc.includes("moonwell")) protocolMatch = " from moonwell";
        }
        userPrompt = `${userPrompt}${protocolMatch} borrow`;
      } else if (lc.includes("lend")) {
        const prevUserMsg = conversationHistory
          .slice()
          .reverse()
          .find((m: any) => m.role === "user");
        let protocolMatch = "";
        if (prevUserMsg) {
          const prevLc = prevUserMsg.content.toLowerCase();
          if (prevLc.includes("aave")) protocolMatch = " from aave";
          if (prevLc.includes("moonwell")) protocolMatch = " from moonwell";
        }
        userPrompt = `${userPrompt}${protocolMatch} lend`;
      }
    }
  }

  const systemPrompt = buildSystemPrompt(network);

  const messages = [
    { role: "system", content: systemPrompt },
    ...conversationHistory,
    { role: "user", content: `<<<${userPrompt}>>>` },
  ];

  try {
    options.onSemanticProviderRequest?.();
    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://kletia.com",
          "X-Title": "Kletia Omni-Engine",
        },
        body: JSON.stringify({
          model:
            process.env.OPENROUTER_INTENT_MODEL?.trim() ||
            "openai/gpt-4o-2024-08-06",
          messages: messages,
          temperature: 0.1,
          max_tokens: 1_800,
          response_format: structuredIntentResponseFormat(network),
          provider: {
            require_parameters: true,
          },
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );

    if (!response.ok) throw new Error(`API Rejected: ${response.status}`);

    const data = await response.json();
    const responseContent = data?.choices?.[0]?.message?.content;
    if (typeof responseContent !== "string" || !responseContent.trim()) {
      throw new Error("Intent provider returned an empty response.");
    }
    let cleanContent = responseContent.trim();

    cleanContent = cleanContent
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();

    // Provider output remains untrusted until the final IntentSchema.parse.
    // `any` is intentionally confined to this compatibility-normalization
    // block because legacy action handlers still mutate individual fields.
    let parsedJson: any;
    try {
      // Accept only one complete JSON object.
      const jsonMatch = cleanContent.match(/^\{[\s\S]*\}$/);
      if (jsonMatch) {
        parsedJson = compactStructuredIntent(JSON.parse(jsonMatch[0]));
      } else {
        // If the model wrapped JSON in prose, inspect the outermost braces once.
        const firstBrace = cleanContent.indexOf("{");
        const lastBrace = cleanContent.lastIndexOf("}");
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
          parsedJson = compactStructuredIntent(
            JSON.parse(cleanContent.substring(firstBrace, lastBrace + 1)),
          );
        } else {
          parsedJson = compactStructuredIntent(JSON.parse(cleanContent));
        }
      }
    } catch (e) {
      console.error("[AI JSON PARSE FAILED]", {
        network,
        responseLength: cleanContent.length,
      });
      throw new Error("AI broke the format, could you please try again?");
    }

    parsedJson.action = normalizeParsedAction(parsedJson.action, network);
    if (parsedJson.action === "greet") parsedJson.action = "chat";

    if (!networkConfig.intentActions.includes(parsedJson.action)) {
      parsedJson = {
        ...parsedJson,
        isComplete: true,
        action: "unknown",
        message: `This action is not supported on ${networkConfig.displayName}.`,
      };
    }

    if (
      parsedJson.action === "open_widget" &&
      (!parsedJson.tokenIn ||
        !networkConfig.widgets.includes(
          String(parsedJson.tokenIn).toLowerCase(),
        ))
    ) {
      parsedJson = {
        ...parsedJson,
        isComplete: true,
        action: "unknown",
        message: `This widget is not available on ${networkConfig.displayName}.`,
      };
    }

    console.log("[AI INTENT PARSED]", {
      network,
      action: parsedJson.action,
      isComplete: parsedJson.isComplete === true,
    });

    if (parsedJson.action === "chat") {
      return {
        isComplete: false,
        action: "chat",
        message: parsedJson.message || "Hello, how can I help you?",
        question: "",
        amount: "0",
        durationInDays: 0,
      };
    }

    if (
      network === "base" &&
      (parsedJson.action === "basename_register" ||
        parsedJson.action === "basename_renew")
    ) {
      if (!parsedJson.tokenIn || parsedJson.tokenIn.trim() === "") {
        return {
          isComplete: false,
          action: "chat",
          message:
            parsedJson.message ||
            "Could you specify which .base.eth name you want to interact with buddy?",
          question: "",
          amount: "0",
          durationInDays: 0,
        };
      }
      parsedJson = {
        ...parsedJson,
        isComplete: true,
        message: parsedJson.message || "Preparing Base Name transaction.",
        question: "",
        amount: "0",
        durationInDays: parsedJson.durationInDays || 365,
        tokenIn: String(parsedJson.tokenIn).toLowerCase(),
      };
    }

    if (parsedJson.isComplete) {
      const singleAssetActions = [
        "withdraw",
        "borrow",
        "repay",
        "stake",
        "unstake",
        "lend",
        "claim",
        "bridge",
        "lending_deposit",
        "lending_withdraw",
        "lending_borrow",
        "lending_repay",
      ];

      if (
        singleAssetActions.includes(parsedJson.action) &&
        !parsedJson.tokenIn &&
        parsedJson.tokenOut
      ) {
        parsedJson.tokenIn = parsedJson.tokenOut;
        parsedJson.tokenOut = undefined;
      }

      if (
        parsedJson.action !== "allora_prediction" &&
        parsedJson.action !== "deploy_token" &&
        parsedJson.action !== "open_widget" &&
        parsedJson.action !== "basename_register" &&
        parsedJson.action !== "basename_renew"
      ) {
        parsedJson.tokenIn = normalizeAssetMention(parsedJson.tokenIn);
        parsedJson.tokenOut = normalizeAssetMention(parsedJson.tokenOut);
        parsedJson.collateralToken = normalizeAssetMention(
          parsedJson.collateralToken,
        );
        parsedJson.borrowToken = normalizeAssetMention(parsedJson.borrowToken);
      }

      const amountText = String(parsedJson.amount ?? "0").trim();
      parsedJson.amount =
        amountText.toUpperCase() === "MAX" ? "MAX" : amountText;
    }

    if (
      parsedJson.isComplete &&
      parsedJson.action === "workflow" &&
      Array.isArray(parsedJson.workflowSteps) &&
      parsedJson.workflowSteps.length > 0
    ) {
      const fundingStep = parsedJson.workflowSteps.find(
        (step: { tokenIn?: unknown; amount?: unknown }) =>
          typeof step.tokenIn === "string" &&
          step.tokenIn.trim().length > 0 &&
          typeof step.amount === "string" &&
          step.amount.trim().length > 0,
      );
      parsedJson.tokenIn = fundingStep?.tokenIn;
      parsedJson.amount = fundingStep?.amount;
      parsedJson.tokenOut = parsedJson.workflowSteps.find(
        (step: { tokenOut?: unknown }) =>
          typeof step.tokenOut === "string" && step.tokenOut.trim().length > 0,
      )?.tokenOut;
      // The Base workflow resolver treats the top-level asset as funding
      // metadata. Per-step outputs remain exact inside workflowSteps; copying
      // one to the top level creates a contradictory, unused asset role.
      if (network === "base") delete parsedJson.tokenOut;
      if (!fundingStep || parsedJson.workflowSteps.length < 2) {
        parsedJson.isComplete = false;
        parsedJson.question =
          "A staged intent requires at least two ordered steps and an explicit source asset and amount.";
        parsedJson.message = parsedJson.question;
      }
    }

    if (
      network === "arc" &&
      parsedJson.isComplete &&
      String(parsedJson.amount || "").toUpperCase() === "MAX" &&
      REQUIRED_AMOUNT_ACTIONS.arc.has(parsedJson.action) &&
      !arcActionSupportsMax(parsedJson.action, parsedJson.tokenIn)
    ) {
      parsedJson.isComplete = false;
      parsedJson.question =
        "This Arc transaction does not safely resolve MAX amount; you must specify a clear and positive amount.";
      parsedJson.message = parsedJson.question;
    }

    if (
      parsedJson.isComplete &&
      REQUIRED_AMOUNT_ACTIONS[network].has(parsedJson.action) &&
      !hasSafeExplicitAmount(parsedJson.amount)
    ) {
      parsedJson.isComplete = false;
      parsedJson.question =
        "The transaction amount must be a positive decimal number usable without modification; for example, 1.5.";
      parsedJson.message = parsedJson.question;
    }

    if (network === "arc" && parsedJson.isComplete) {
      const missingField =
        parsedJson.action === "stable_swap" &&
        (!parsedJson.tokenIn || !parsedJson.tokenOut)
          ? "You must specify input and output tokens for stable swap."
          : parsedJson.action === "appkit_send" && !parsedJson.recipient
            ? "You must specify the recipient address for App Kit transfer."
            : parsedJson.action === "appkit_bridge" &&
                (!parsedJson.recipient || !parsedJson.destinationChain)
              ? "You must specify the testnet target network and recipient address for bridge."
              : parsedJson.action === "official_memo_send" &&
                  (!parsedJson.recipient ||
                    !(parsedJson.memo || parsedJson.name))
                ? "For official memo payment, you must specify a recipient and a short, public reference without personal data."
                : parsedJson.action === "atomic_payout" &&
                    (!Array.isArray(parsedJson.transfers) ||
                      parsedJson.transfers.length === 0)
                  ? "For atomic payout, you must specify at least one recipient and amount."
                  : "";
      if (missingField) {
        parsedJson.isComplete = false;
        parsedJson.question = missingField;
        parsedJson.message = missingField;
      }
    }

    if (network === "base" && parsedJson.isComplete) {
      const missingField =
        parsedJson.action === "x402_discover" &&
        (!parsedJson.serviceQuery || !parsedJson.maxPayment)
          ? "For x402 service discovery, you must specify what you need and your maximum USDC payment per request."
          : parsedJson.action === "x402_request" &&
              (!parsedJson.url || !parsedJson.method || !parsedJson.maxPayment)
            ? "For x402 requests, you must specify a full HTTPS URL, GET or POST method, and the maximum USDC payment."
            : parsedJson.action === "x402_request" &&
                String(parsedJson.method).toUpperCase() === "POST" &&
                !parsedJson.requestBody
              ? "For POST x402 requests, you must specify the JSON object to be sent."
              : parsedJson.action === "workflow" &&
                  (!Array.isArray(parsedJson.workflowSteps) ||
                    parsedJson.workflowSteps.length < 2 ||
                    !parsedJson.tokenIn ||
                    !parsedJson.amount)
                ? "A workflow requires at least two ordered steps plus an explicit source asset and amount."
              : "";
      if (missingField) {
        parsedJson.isComplete = false;
        parsedJson.question = missingField;
        parsedJson.message = missingField;
      }
    }

    return enforcePromptBoundIntent(
      IntentSchema.parse(parsedJson),
      bindingText,
      network,
    );
  } catch (error: any) {
    console.error("[KLETIA PARSER FAILED]", {
      name: error instanceof Error ? error.name : "UnknownError",
      code: typeof error?.code === "string" ? error.code : undefined,
    });
    if (error instanceof IntentParserError) throw error;
    throw new IntentParserError();
  }
}
