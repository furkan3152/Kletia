/**
 * Arbitrum natural-language clauses and deterministic Arbitrum intent parsing.
 */
import { IntentSchema, type ParsedIntent } from "./schema.js";
import {
  hasExplicitTransactionNegation,
  hasNonExecutionSpeechAct,
} from "./speechActs.js";
import {
  detectRiskTolerance,
  extractSlippagePercent,
} from "./baseExtraction.js";
import {
  bindPrivateFieldSlots,
  deterministicIntent,
  hasOrderedIntentConnector,
  isDeterministicPortfolioRead,
  type NaturalWorkflowStep,
  preparePrivateFieldSlots,
  splitOrderedIntentClauses,
} from "./clauses.js";
import {
  ARC_NATURAL_AMOUNT,
  ARC_WIDGET_ADDRESS,
  normalizeScaledArcAmount,
} from "./arcClauses.js";

export type ArbitrumNaturalClause =
  | { readonly status: "matched"; readonly step: NaturalWorkflowStep }
  | { readonly status: "invalid"; readonly question: string }
  | { readonly status: "unmatched" };

export function parseArbitrumNaturalClause(
  clause: string,
  previousOutput?: string,
): ArbitrumNaturalClause {
  const capacityRequest =
    /(?:\b(?:how\s+much|maximum|max|capacity|available|safe(?:ly)?)\b[^,;:.!?\n]{0,100}\b(?:borrow|loan)\b|\b(?:borrow|loan)\b[^,;:.!?\n]{0,100}\b(?:capacity|maximum|max|available|safe(?:ly)?))\b/iu.test(
      clause,
    );
  const mentionedAssets = [
    ...new Set(
      Array.from(
        clause.matchAll(/(?:^|[^\p{L}\p{N}_])(USDC|WETH|ETH|ARB)(?=$|[^\p{L}\p{N}_])/giu),
        (match) => match[1].toUpperCase(),
      ),
    ),
  ];
  if (capacityRequest) {
    if (mentionedAssets.length !== 1) {
      return {
        status: "invalid",
        question: "Which Arbitrum asset should I use for the read-only borrow-capacity calculation: USDC, WETH, ETH, or ARB?",
      };
    }
    return {
      status: "matched",
      step: {
        action: "borrow_capacity",
        network: "arbitrum",
        tokenIn: mentionedAssets[0],
        amount: "0",
        protocol: "aave-v3",
      },
    };
  }

  let match = new RegExp(
    `^(?:buy|satın\\s+al|satin\\s+al)\\s+(USDC|WETH|ETH|ARB)\\s+(?:with|using|for|ile)\\s+${ARC_NATURAL_AMOUNT}\\s+(USDC|WETH|ETH|ARB)(?:\\s+on\\s+Arbitrum(?:\\s+One)?)?$`,
    "iu",
  ).exec(clause);
  if (match) {
    const tokenOut = match[1].toUpperCase();
    const tokenIn = match[4].toUpperCase();
    if (tokenIn === tokenOut) {
      return { status: "invalid", question: "Arbitrum swap input and output assets must be different." };
    }
    if (tokenIn === "ETH" || tokenOut === "ETH") {
      return {
        status: "invalid",
        question: "Arbitrum swaps use WETH rather than native ETH. Replace ETH with WETH to continue.",
      };
    }
    return {
      status: "matched",
      step: {
        action: "swap",
        network: "arbitrum",
        tokenIn,
        tokenOut,
        amount: normalizeScaledArcAmount(match[2], match[3]),
        amountSource: "explicit",
        protocol: "uniswap-v3",
      },
    };
  }

  match = new RegExp(
    `^(?:swap|convert|exchange|trade|takasla|çevir|cevir|sell|sat)\\s+${ARC_NATURAL_AMOUNT}\\s+(USDC|WETH|ETH|ARB)\\s+(?:to|into|for|->)\\s+(USDC|WETH|ETH|ARB)(?:\\s+on\\s+Arbitrum(?:\\s+One)?)?(?:\\s+with\\s+(?:maximum\\s+)?\\d+(?:[.,]\\d+)?%\\s+slippage)?$`,
    "iu",
  ).exec(clause);
  if (match) {
    const tokenIn = match[3].toUpperCase();
    const tokenOut = match[4].toUpperCase();
    if (tokenIn === tokenOut) {
      return { status: "invalid", question: "Arbitrum swap input and output assets must be different." };
    }
    if (tokenIn === "ETH" || tokenOut === "ETH") {
      return {
        status: "invalid",
        question: "Arbitrum swaps use WETH rather than native ETH. Replace ETH with WETH to continue.",
      };
    }
    return {
      status: "matched",
      step: {
        action: "swap",
        network: "arbitrum",
        tokenIn,
        tokenOut,
        amount: normalizeScaledArcAmount(match[1], match[2]),
        amountSource: "explicit",
        protocol: "uniswap-v3",
      },
    };
  }

  match = /^(?:swap|convert|exchange|trade|takasla|çevir|cevir)\s+(?:it|all(?:\s+of\s+it)?|the\s+(?:result|output))\s+(?:to|into|for|->)\s+(USDC|WETH|ETH|ARB)(?:\s+on\s+Arbitrum(?:\s+One)?)?$/iu.exec(
    clause,
  );
  if (match) {
    const tokenOut = match[1].toUpperCase();
    if (!previousOutput) {
      return { status: "invalid", question: "The preceding step must produce an asset before its output can be swapped." };
    }
    if (previousOutput === "ETH" || tokenOut === "ETH") {
      return {
        status: "invalid",
        question: "Arbitrum swaps use WETH rather than native ETH. Replace ETH with WETH to continue.",
      };
    }
    return {
      status: "matched",
      step: {
        action: "swap",
        network: "arbitrum",
        tokenIn: previousOutput,
        tokenOut,
        amount: "MAX",
        amountSource: "previous_output",
        protocol: "uniswap-v3",
      },
    };
  }

  match = new RegExp(
    `^(lend|supply|deposit|withdraw|borrow|repay)\\s+${ARC_NATURAL_AMOUNT}\\s+(USDC|WETH|ETH|ARB)(?:\\s+(?:to|from|on|in)\\s+(Aave(?:\\s+V3)?|Compound(?:\\s+(?:III|V3))?|Comet))?(?:\\s+on\\s+Arbitrum(?:\\s+One)?)?$`,
    "iu",
  ).exec(clause);
  if (match) {
    const requested = match[1].toLowerCase();
    const action = (
      requested === "supply" || requested === "deposit" ? "lend" : requested
    ) as NaturalWorkflowStep["action"];
    const tokenIn = match[4].toUpperCase();
    const compound = /\b(?:compound|comet)\b/iu.test(match[5] || clause);
    if (tokenIn === "ETH") {
      return {
        status: "invalid",
        question: "Use WETH for reviewed Arbitrum DeFi execution; native ETH is not substituted silently.",
      };
    }
    if (compound && action === "borrow") {
      return {
        status: "invalid",
        question: "Compound III borrow execution is not reviewed in this release. Use Aave V3 or request read-only capacity.",
      };
    }
    return {
      status: "matched",
      step: {
        action,
        network: "arbitrum",
        tokenIn,
        amount: normalizeScaledArcAmount(match[2], match[3]),
        amountSource: "explicit",
        protocol: compound ? "compound-v3" : "aave-v3",
      },
    };
  }

  match = /^(?:lend|supply|deposit|put|place|yatır|yatir)\s+(?:it|all(?:\s+of\s+it)?|the\s+(?:result|output)|(?:all|the)\s+(?:resulting|received|output|swapped)\s+(USDC|WETH|ARB))(?:\s+(?:to|on|in)\s+(?:Aave(?:\s+V3)?))?(?:\s+on\s+Arbitrum(?:\s+One)?)?$/iu.exec(
    clause,
  );
  if (match) {
    const explicitAsset = match[1]?.toUpperCase();
    if (!previousOutput || (explicitAsset && explicitAsset !== previousOutput)) {
      return {
        status: "invalid",
        question: "The Aave supply asset must exactly match the immediately preceding workflow output.",
      };
    }
    return {
      status: "matched",
      step: {
        action: "lend",
        network: "arbitrum",
        tokenIn: previousOutput,
        amount: "MAX",
        amountSource: "previous_output",
        protocol: "aave-v3",
      },
    };
  }

  match = /^(?:lend|supply|deposit|put|place|yatır|yatir)\s+(?:the\s+)?(USDC|WETH|ARB)(?:\s+(?:to|on|in)\s+(?:Aave(?:\s+V3)?))?(?:\s+on\s+Arbitrum(?:\s+One)?)?$/iu.exec(
    clause,
  );
  if (match) {
    const tokenIn = match[1].toUpperCase();
    if (!previousOutput) {
      return {
        status: "invalid",
        question: `Enter the exact ${tokenIn} amount to supply to Aave.`,
      };
    }
    if (previousOutput !== tokenIn) {
      return {
        status: "invalid",
        question:
          "The Aave supply asset must exactly match the immediately preceding workflow output.",
      };
    }
    return {
      status: "matched",
      step: {
        action: "lend",
        network: "arbitrum",
        tokenIn,
        amount: "MAX",
        amountSource: "previous_output",
        protocol: "aave-v3",
      },
    };
  }

  return { status: "unmatched" };
}

function parseDeterministicArbitrumWorkflowIntent(prompt: string): ParsedIntent | null {
  const clauses = splitOrderedIntentClauses(prompt);
  if (clauses.length < 2 || clauses.length > 8) return null;
  const steps: NaturalWorkflowStep[] = [];
  let previousOutput: string | undefined;
  for (const clause of clauses) {
    const parsed = parseArbitrumNaturalClause(clause, previousOutput);
    if (parsed.status === "unmatched") return null;
    if (parsed.status === "invalid") {
      return IntentSchema.parse({
        isComplete: false,
        action: "workflow",
        amount: "0",
        question: parsed.question,
        message: parsed.question,
      });
    }
    steps.push(parsed.step);
    previousOutput = parsed.step.tokenOut;
  }
  const first = steps[0];
  return deterministicIntent({
    action: "workflow",
    tokenIn: first.tokenIn,
    tokenOut: first.tokenOut,
    amount: first.amount || "0",
    allowMultiStep: true,
    workflowSteps: steps,
    message: `Preparing ${steps.length} ordered Arbitrum checkpoints. Each money-moving step remains separately approved.`,
  });
}

/** High-confidence Arbitrum grammar for ordinary and staged user goals. */
function parsePreparedDeterministicArbitrumIntent(
  userPrompt: string,
): ParsedIntent | null {
  const prompt = preparePrivateFieldSlots(userPrompt)
    .trim()
    .replace(/[.!]+$/u, "");
  if (!prompt || prompt.length > 2_000) return null;
  if (hasExplicitTransactionNegation(prompt) || hasNonExecutionSpeechAct(prompt)) {
    return null;
  }

  const finish = (intent: ParsedIntent | null): ParsedIntent | null =>
    bindPrivateFieldSlots(intent, userPrompt);

  if (isDeterministicPortfolioRead(prompt)) {
    return finish(deterministicIntent({
      action: "portfolio",
      amount: "0",
      message: "Reading the live Arbitrum portfolio.",
    }));
  }

  const transfer = new RegExp(
    `^(?:send|pay|transfer|gönder|gonder|öde|ode|aktar)\\s+${ARC_NATURAL_AMOUNT}\\s+(USDC|WETH|ETH|ARB)(?:\\s+on\\s+Arbitrum(?:\\s+One)?)?\\s+(?:to|->)\\s*(${ARC_WIDGET_ADDRESS})$`,
    "iu",
  ).exec(prompt);
  if (transfer) {
    return finish(deterministicIntent({
      action: "transfer",
      tokenIn: transfer[3].toUpperCase(),
      amount: normalizeScaledArcAmount(transfer[1], transfer[2]),
      recipient: transfer[5],
      message: "Preparing the reviewed Arbitrum transfer.",
    }));
  }

  const incompleteTransfer = new RegExp(
    `^(?:send|pay|transfer|gönder|gonder|öde|ode|aktar)\\s+${ARC_NATURAL_AMOUNT}\\s+(USDC|WETH|ETH|ARB)(?:\\s+on\\s+Arbitrum(?:\\s+One)?)?$`,
    "iu",
  ).exec(prompt);
  if (incompleteTransfer) {
    return finish(IntentSchema.parse({
      isComplete: false,
      action: "transfer",
      tokenIn: incompleteTransfer[3].toUpperCase(),
      amount: normalizeScaledArcAmount(incompleteTransfer[1], incompleteTransfer[2]),
      question: "Which EVM address should receive this Arbitrum transfer?",
      message: "Add the recipient address to continue.",
    }));
  }

  const workflow = parseDeterministicArbitrumWorkflowIntent(prompt);
  if (workflow) return finish(workflow);
  if (hasOrderedIntentConnector(prompt)) return null;

  const natural = parseArbitrumNaturalClause(prompt);
  if (natural.status === "invalid") {
    return finish(IntentSchema.parse({
      isComplete: false,
      action: "chat",
      amount: "0",
      question: natural.question,
      message: natural.question,
    }));
  }
  if (natural.status === "matched") {
    const step = natural.step;
    return finish(deterministicIntent({
      action: step.action,
      tokenIn: step.tokenIn,
      tokenOut: step.tokenOut,
      amount: step.amount || "0",
      protocol: step.protocol,
      objective: step.action === "swap"
        ? "best_output"
        : step.action === "borrow"
          ? "lowest_borrow_cost"
          : step.action === "lend"
            ? "best_rate"
            : undefined,
      riskTolerance: detectRiskTolerance(prompt),
      slippage: step.action === "swap" ? extractSlippagePercent(prompt) || "1" : undefined,
      message: `Preparing the reviewed Arbitrum ${step.action.replace(/_/gu, " ")} route.`,
    }));
  }

  if (/\b(?:compare|best\s+(?:yield|rate)|yield|apy|apr|rates?|karşılaştır|karsilastir|getiri|faiz)\b/iu.test(prompt)) {
    const assets = Array.from(
      prompt.matchAll(/(?:^|[^\p{L}\p{N}_])(USDC|WETH|ARB)(?=$|[^\p{L}\p{N}_])/giu),
      (match) => match[1].toUpperCase(),
    );
    return deterministicIntent({
      action: "yield_compare",
      tokenIn: [...new Set(assets)][0] || "USDC",
      amount: "0",
      objective: "best_rate",
      riskTolerance: detectRiskTolerance(prompt),
      message: "Comparing live reviewed Arbitrum lending rates.",
    });
  }

  return null;
}

export function parseDeterministicArbitrumIntent(
  userPrompt: string,
): ParsedIntent | null {
  const parserPrompt = preparePrivateFieldSlots(userPrompt);
  return bindPrivateFieldSlots(
    parsePreparedDeterministicArbitrumIntent(parserPrompt),
    userPrompt,
  );
}
