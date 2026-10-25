/**
 * Deterministic Base workflows (ordered clauses, bridges) and the public
 * Base entry point.
 */
import { IntentSchema, type ParsedIntent } from "./schema.js";
import {
  baseExecutionConstraintFailure,
  conflictingBaseActions,
  promptBindingFailure,
} from "./promptConstraints.js";
import { attachExplicitBaseExecutionConstraints } from "./baseExtraction.js";
import {
  bindPrivateFieldSlots,
  deterministicIntent,
  type NaturalWorkflowStep,
  preparePrivateFieldSlots,
  splitOrderedIntentClauses,
} from "./clauses.js";
import { parseRawDeterministicBaseIntent } from "./baseIntent.js";
import {
  type ArbitrumNaturalClause,
  parseArbitrumNaturalClause,
} from "./arbitrumIntent.js";

export function parseDeterministicBaseIntent(
  userPrompt: string,
): ParsedIntent | null {
  const parserPrompt = preparePrivateFieldSlots(userPrompt);
  if (baseExecutionConstraintFailure(parserPrompt)) return null;
  const workflow = parseDeterministicBaseWorkflowIntent(parserPrompt);
  if (workflow) {
    const constrained = workflow.isComplete
      ? attachExplicitBaseExecutionConstraints(workflow, parserPrompt)
      : workflow;
    return bindPrivateFieldSlots(constrained, userPrompt);
  }
  if (conflictingBaseActions(parserPrompt).length > 1) {
    return promptBindingFailure(
      "I found multiple money-moving actions, but not a complete reviewed Base to Arbitrum sequence. State the steps in order and include an explicit bridge, or send the Base actions separately.",
    );
  }
  const intent = parseRawDeterministicBaseIntent(parserPrompt);
  return bindPrivateFieldSlots(
    intent
      ? attachExplicitBaseExecutionConstraints(intent, parserPrompt)
      : null,
    userPrompt,
  );
}

function parseBaseBridgeWorkflowClause(
  clause: string,
  previousOutput?: string,
): ArbitrumNaturalClause {
  let match = /^(?:bridge|move|köprüle|koprule)\s+(\d+(?:[.,]\d+)?)\s+(USDC|WETH|ETH)(?:\s+from\s+Base)?\s+to\s+Arbitrum(?:\s+One)?(?:\s+using\s+Across)?$/iu.exec(
    clause,
  );
  if (match) {
    return {
      status: "matched",
      step: {
        action: "bridge",
        network: "base",
        tokenIn: match[2].toUpperCase(),
        amount: match[1].replace(",", "."),
        amountSource: "explicit",
        destinationChain: "arbitrum",
        protocol: "across",
      },
    };
  }
  match = /^(?:bridge|move|köprüle|koprule)\s+(?:it|all(?:\s+of\s+it)?|the\s+(?:result|output))\s+to\s+Arbitrum(?:\s+One)?(?:\s+using\s+Across)?$/iu.exec(
    clause,
  );
  if (match) {
    if (!previousOutput || !["USDC", "WETH", "ETH"].includes(previousOutput)) {
      return {
        status: "invalid",
        question: "The reviewed bridge must immediately follow a Base step that produces USDC, WETH, or ETH.",
      };
    }
    return {
      status: "matched",
      step: {
        action: "bridge",
        network: "base",
        tokenIn: previousOutput,
        amount: "MAX",
        amountSource: "previous_output",
        destinationChain: "arbitrum",
        protocol: "across",
      },
    };
  }
  return { status: "unmatched" };
}

function parseDeterministicBaseWorkflowIntent(prompt: string): ParsedIntent | null {
  const clauses = splitOrderedIntentClauses(prompt);
  if (clauses.length < 2 || clauses.length > 8) return null;
  const steps: NaturalWorkflowStep[] = [];
  let previousOutput: string | undefined;
  let crossedToArbitrum = false;

  for (const clause of clauses) {
    if (!crossedToArbitrum) {
      const bridge = parseBaseBridgeWorkflowClause(clause, previousOutput);
      if (bridge.status === "invalid") {
        return IntentSchema.parse({
          isComplete: false,
          action: "workflow",
          amount: "0",
          question: bridge.question,
          message: bridge.question,
        });
      }
      if (bridge.status === "matched") {
        steps.push(bridge.step);
        previousOutput = bridge.step.tokenIn;
        crossedToArbitrum = true;
        continue;
      }

      const baseIntent = parseRawDeterministicBaseIntent(clause);
      if (!baseIntent || !baseIntent.isComplete) return null;
      if (baseIntent.action !== "swap") {
        return promptBindingFailure(
          "Reviewed Base staged execution currently supports a Base swap followed by an explicit Arbitrum bridge. Run other same-chain Base actions separately.",
        );
      }
      const step: NaturalWorkflowStep = {
        action: "swap",
        network: "base",
        tokenIn: baseIntent.tokenIn,
        tokenOut: baseIntent.tokenOut,
        amount: baseIntent.amount,
        amountSource: baseIntent.amount === "MAX" ? "wallet_balance" : "explicit",
        protocol: baseIntent.protocol,
        objective: baseIntent.objective,
      };
      steps.push(step);
      previousOutput = step.tokenOut;
      continue;
    }

    const downstream = parseArbitrumNaturalClause(clause, previousOutput);
    if (downstream.status === "unmatched") return null;
    if (downstream.status === "invalid") {
      return IntentSchema.parse({
        isComplete: false,
        action: "workflow",
        amount: "0",
        question: downstream.question,
        message: downstream.question,
      });
    }
    steps.push(downstream.step);
    previousOutput = downstream.step.tokenOut;
  }

  if (!crossedToArbitrum) {
    return promptBindingFailure(
      "Multiple Base actions are not yet one reviewed staged executor. Run them separately, or add an explicit Base to Arbitrum bridge when that is your intended route.",
    );
  }
  if (steps.length < 2) return null;
  const first = steps[0];
  return deterministicIntent({
    action: "workflow",
    tokenIn: first.tokenIn,
    amount: first.amount || "0",
    allowMultiStep: true,
    workflowSteps: steps,
    message: `Preparing ${steps.length} reviewed Base to Arbitrum checkpoints. Cross-chain execution is staged, not globally atomic.`,
  });
}
