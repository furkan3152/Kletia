/**
 * Arc natural-language clause grammar and amount normalisation.
 */
import { IntentSchema, type ParsedIntent } from "./schema.js";
import {
  deterministicIntent,
  type NaturalWorkflowStep,
  splitOrderedIntentClauses,
} from "./clauses.js";

export const ARC_WIDGET_AMOUNT = "(\\d+(?:\\.\\d+)?)";
export const ARC_WIDGET_ADDRESS = "(0x[0-9a-fA-F]{40})";
export const ARC_NATURAL_AMOUNT = "(\\d+(?:[.,]\\d+)?)(?:\\s*(thousand|million|billion|bin|milyon|milyar))?";

export function canonicalArcAppKitToken(token: string): string {
  return token.toUpperCase() === "CIRBTC" ? "cirBTC" : token.toUpperCase();
}

export function normalizeScaledArcAmount(raw: string, scale?: string): string {
  const normalized = raw.replace(",", ".");
  const [wholeRaw, fractionRaw = ""] = normalized.split(".");
  const zeros = (() => {
    switch (String(scale || "").toLowerCase()) {
      case "thousand":
      case "bin":
        return 3;
      case "million":
      case "milyon":
        return 6;
      case "billion":
      case "milyar":
        return 9;
      default:
        return 0;
    }
  })();
  const digits = `${wholeRaw}${fractionRaw}`.replace(/^0+(?=\d)/u, "") || "0";
  const shift = zeros - fractionRaw.length;
  const expanded = shift >= 0
    ? `${digits}${"0".repeat(shift)}`
    : `${digits.slice(0, Math.max(0, digits.length + shift)) || "0"}.${digits
        .slice(digits.length + shift)
        .padStart(Math.max(0, -shift), "0")}`;
  const [whole, fraction = ""] = expanded.split(".");
  const trimmedFraction = fraction.replace(/0+$/u, "");
  return trimmedFraction ? `${whole}.${trimmedFraction}` : whole;
}

type ArcNaturalClause =
  | { readonly status: "matched"; readonly step: NaturalWorkflowStep }
  | { readonly status: "invalid"; readonly question: string }
  | { readonly status: "unmatched" };

export function parseArcNaturalClause(
  clause: string,
  previousOutput?: string,
): ArcNaturalClause {
  if (
    /(?:\b(?:how\s+much|maximum|max|capacity|available|safe(?:ly)?)\b[^,;:.!?\n]{0,100}\b(?:borrow|loan)\b|\b(?:borrow|loan)\b[^,;:.!?\n]{0,100}\b(?:capacity|maximum|max|available|safe(?:ly)?))\b/iu.test(
      clause,
    )
  ) {
    return {
      status: "invalid",
      question:
        "Arc Kletia Lending does not expose a reviewed read-only safe borrow limit yet. Enter an exact USDC borrow amount, or stop the workflow after supplying KLET collateral.",
    };
  }

  let match = new RegExp(
    `^(?:buy|satın\\s+al|satin\\s+al)\\s+(?:native\\s+)?(USDC|KLET)\\s+(?:with|using|for|ile)\\s+${ARC_NATURAL_AMOUNT}\\s+(?:native\\s+)?(USDC|KLET)(?:\\s+on\\s+Arc(?:\\s+Testnet)?)?$`,
    "iu",
  ).exec(clause);
  if (match) {
    const tokenOut = match[1].toUpperCase();
    const tokenIn = match[4].toUpperCase();
    if (tokenIn === tokenOut) {
      return {
        status: "invalid",
        question: "Arc swap input and output assets must be different.",
      };
    }
    return {
      status: "matched",
      step: {
        action: "swap",
        network: "arc",
        tokenIn,
        tokenOut,
        amount: normalizeScaledArcAmount(match[2], match[3]),
        amountSource: "explicit",
      },
    };
  }

  match = new RegExp(
    `^(swap|convert|exchange|trade|takasla|çevir|cevir|sell|sat)\\s+${ARC_NATURAL_AMOUNT}\\s+(?:native\\s+)?(USDC|KLET)(?:\\s+(?:to|into|for|->)\\s+(?:native\\s+)?(USDC|KLET))?(?:\\s+on\\s+Arc(?:\\s+Testnet)?)?$`,
    "iu",
  ).exec(clause);
  if (match) {
    const verb = match[1].toLowerCase();
    const tokenIn = match[4].toUpperCase();
    const explicitTokenOut = match[5]?.toUpperCase();
    const tokenOut = explicitTokenOut ||
      (["sell", "sat"].includes(verb)
        ? tokenIn === "KLET" ? "USDC" : "KLET"
        : undefined);
    if (!tokenOut) {
      return {
        status: "invalid",
        question: "Which Arc asset should the swap receive: USDC or KLET?",
      };
    }
    if (tokenIn === tokenOut) {
      return {
        status: "invalid",
        question: "Arc swap input and output assets must be different.",
      };
    }
    return {
      status: "matched",
      step: {
        action: "swap",
        network: "arc",
        tokenIn,
        tokenOut,
        amount: normalizeScaledArcAmount(match[2], match[3]),
        amountSource: "explicit",
      },
    };
  }

  match = new RegExp(
    `^(lend|deposit|supply|put|place|yatır|yatir)(?:\\s+${ARC_NATURAL_AMOUNT})?\\s+(?:(?:all|the|resulting|received|output|swapped)\\s+)*(?:native\\s+)?(USDC|KLET)(?:\\s+as\\s+collateral)?(?:\\s+on\\s+Arc(?:\\s+Testnet)?)?$`,
    "iu",
  ).exec(clause);
  if (match) {
    const tokenIn = match[4].toUpperCase();
    if (tokenIn !== "KLET") {
      return {
        status: "invalid",
        question:
          "Arc Kletia Lending accepts KLET as collateral, not USDC. Swap USDC to KLET first or choose a different Arc action.",
      };
    }
    const hasExplicitAmount = Boolean(match[2]);
    if (!hasExplicitAmount && previousOutput !== "KLET") {
      return {
        status: "invalid",
        question: "Enter the exact KLET amount to supply as Arc lending collateral.",
      };
    }
    return {
      status: "matched",
      step: {
        action: "lend",
        network: "arc",
        tokenIn,
        amount: hasExplicitAmount
          ? normalizeScaledArcAmount(match[2], match[3])
          : "MAX",
        amountSource: hasExplicitAmount ? "explicit" : "previous_output",
        protocol: "kletia",
      },
    };
  }

  if (
    /^(?:lend|deposit|supply|put|place|yatır|yatir)\s+(?:it|all(?:\s+of\s+it)?|the\s+(?:result|output))$/iu.test(
      clause,
    )
  ) {
    if (previousOutput !== "KLET") {
      return {
        status: "invalid",
        question:
          "The previous Arc step must produce KLET before its output can be supplied as lending collateral.",
      };
    }
    return {
      status: "matched",
      step: {
        action: "lend",
        network: "arc",
        tokenIn: "KLET",
        amount: "MAX",
        amountSource: "previous_output",
        protocol: "kletia",
      },
    };
  }

  const financialActions = [
    { pattern: "borrow|borç\\s+al", action: "borrow", asset: "USDC" },
    { pattern: "repay|borç\\s+öde|geri\\s+öde", action: "repay", asset: "USDC" },
    { pattern: "stake", action: "stake", asset: "USDC" },
    { pattern: "unstake", action: "unstake", asset: "USDC" },
  ] as const;
  for (const definition of financialActions) {
    match = new RegExp(
      `^(?:${definition.pattern})\\s+${ARC_NATURAL_AMOUNT}\\s+(?:native\\s+)?(USDC|KLET)(?:\\s+on\\s+Arc(?:\\s+Testnet)?)?$`,
      "iu",
    ).exec(clause);
    if (!match) continue;
    const tokenIn = match[3].toUpperCase();
    if (tokenIn !== definition.asset) {
      return {
        status: "invalid",
        question: `${definition.action} on Arc requires ${definition.asset}; ${tokenIn} was not substituted automatically.`,
      };
    }
    return {
      status: "matched",
      step: {
        action: definition.action,
        network: "arc",
        tokenIn,
        amount: normalizeScaledArcAmount(match[1], match[2]),
        amountSource: "explicit",
        protocol: "kletia",
      },
    };
  }
  return { status: "unmatched" };
}

/**
 * Compose an unambiguous Arc swap followed by a collateral deposit without
 * sending the user's prompt to a semantic provider. The second step is bound
 * to the first step's exact output asset; a mismatched or omitted economic
 * dependency remains on the clarification path.
 */
export function parseDeterministicArcWorkflowIntent(
  prompt: string,
): ParsedIntent | null {
  const clauses = splitOrderedIntentClauses(prompt);
  if (clauses.length < 2 || clauses.length > 8) return null;

  const steps: NaturalWorkflowStep[] = [];
  let previousOutput: string | undefined;
  for (const clause of clauses) {
    const parsed = parseArcNaturalClause(clause, previousOutput);
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
    message:
      `Preparing ${steps.length} ordered Arc checkpoints. Every money-moving step requires a separate wallet approval.`,
  });
}
