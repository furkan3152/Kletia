/**
 * Shared deterministic helpers: portfolio reads, ordered clause splitting,
 * private field slots, durations and basename intents.
 */
import { IntentSchema, type ParsedIntent } from "./schema.js";

export function deterministicIntent(
  fields: Omit<ParsedIntent, "isComplete" | "message"> & {
    message: string;
  },
): ParsedIntent {
  return IntentSchema.parse({
    isComplete: true,
    ...fields,
  });
}

const PORTFOLIO_WORDS =
  /\b(?:portfolio|balances?|positions?|holdings|portföy|portfoy|bakiye|pozisyonlar?)\b/iu;

/**
 * Base forms of the console's money-moving verbs, English and Turkish, with
 * Unicode-aware word edges (a leading "ç" or "ö" is a letter here, unlike in
 * `\b`). Read phrases such as "staking positions" or "lending balance" do
 * not contain them.
 */
const MONEY_MOVING_VERB =
  /(?<![\p{L}\p{N}_])(?:withdraw|remove|repay|unstake|claim|deposit|stake|swap|send|pay|transfer|lend|borrow|bridge|add|buy|sell|supply|move|convert|exchange|trade|close|exit|redeem|migrate|wrap|unwrap|mint|launch|register|renew|approve|provide|rebalance|liquidate|çek|cek|yatır|yatir|gönder|gonder|öde|ode|aktar|takas|köprüle|koprule)(?![\p{L}\p{N}_])/iu;

/**
 * A deterministic portfolio read: the prompt names a portfolio, balance,
 * position or holdings and no money-moving verb. "withdraw my whole aave
 * position on base" or "send my USDC balance to 0x…" is an action and must
 * never be answered with a portfolio read.
 */
export function isDeterministicPortfolioRead(prompt: string): boolean {
  return PORTFOLIO_WORDS.test(prompt) && !MONEY_MOVING_VERB.test(prompt);
}

export type NaturalWorkflowStep = NonNullable<ParsedIntent["workflowSteps"]>[number];

/**
 * Keep ordered intent wording consistent across Base, Arc and Arbitrum. A
 * connector is a security boundary: once the user writes one, no network
 * parser may silently prepare only the first clause.
 */
export function splitOrderedIntentClauses(prompt: string): string[] {
  return prompt
    .split(
      /\s*(?:,\s*(?=(?:swap|convert|exchange|trade|buy|sell|bridge|move|send|lend|deposit|supply|borrow|repay|stake|unstake|withdraw)\b)|,?\s*\b(?:and\s+then|then|after\s+that|after\s+this|afterwards|next)\b|,?\s*\bafter\b(?=\s+(?:swap|convert|exchange|trade|buy|sell|bridge|move|send|lend|deposit|supply|borrow|repay|stake|unstake|withdraw)\b)|,?\s*\bafter\s+(?:buying|selling|swapping|bridging|moving|sending|supplying|lending|depositing|staking|withdrawing|borrowing|repaying)\b|,?\s*(?:sonra|ardından|ardindan))\s*/iu,
    )
    .map((clause) => clause.trim())
    .filter(Boolean);
}

const PRIVATE_AMOUNT_SLOT = /\[\[\s*private\s+amount\s*\]\]/iu;
const PRIVATE_AMOUNT_SLOT_GLOBAL = /\[\[\s*private\s+amount\s*\]\]/giu;
const PRIVATE_RECIPIENT_SLOT = /\[\[\s*private\s+recipient\s*\]\]/iu;
const PRIVATE_RECIPIENT_SLOT_GLOBAL = /\[\[\s*private\s+recipient\s*\]\]/giu;
const PRIVATE_AMOUNT_PARSE_SENTINEL = "0.000001";
const PRIVATE_RECIPIENT_PARSE_SENTINEL =
  "0x000000000000000000000000000000000000dEaD";

/**
 * Private composer placeholders describe the transaction structure without
 * disclosing the economic value. Feed non-executable sentinels through the
 * ordinary deterministic grammar, then remove them before returning the
 * intent. This keeps ordered actions out of the semantic-model fallback while
 * making it impossible to compile a money-moving route before the browser
 * supplies the private fields.
 */
export function preparePrivateFieldSlots(prompt: string): string {
  return prompt
    .replace(PRIVATE_AMOUNT_SLOT_GLOBAL, PRIVATE_AMOUNT_PARSE_SENTINEL)
    .replace(PRIVATE_RECIPIENT_SLOT_GLOBAL, PRIVATE_RECIPIENT_PARSE_SENTINEL);
}

export function bindPrivateFieldSlots(
  intent: ParsedIntent | null,
  originalPrompt: string,
): ParsedIntent | null {
  if (!intent) return null;
  const hasPrivateAmount = PRIVATE_AMOUNT_SLOT.test(originalPrompt);
  const hasPrivateRecipient = PRIVATE_RECIPIENT_SLOT.test(originalPrompt);
  if (!hasPrivateAmount && !hasPrivateRecipient) return intent;

  const sourceClauses = splitOrderedIntentClauses(originalPrompt);
  const workflowSteps = intent.workflowSteps?.map((step, index) => {
    const sourceClause = sourceClauses[index] || originalPrompt;
    if (
      step.amountSource === "explicit" &&
      PRIVATE_AMOUNT_SLOT.test(sourceClause)
    ) {
      return { ...step, amount: "0" };
    }
    return step;
  });
  const missing = [
    hasPrivateAmount ? "amount" : undefined,
    hasPrivateRecipient ? "recipient" : undefined,
  ].filter((value): value is string => Boolean(value));
  const slotQuestion = `Enter the private ${missing.join(
    " and ",
  )} in the secure local field before route compilation.`;
  const existingQuestion = intent.isComplete ? "" : intent.question?.trim();

  return IntentSchema.parse({
    ...intent,
    isComplete: false,
    amount: hasPrivateAmount
      ? workflowSteps?.[0]?.amount || "0"
      : intent.amount,
    secondaryAmount:
      hasPrivateAmount && intent.secondaryAmount === PRIVATE_AMOUNT_PARSE_SENTINEL
        ? "0"
        : intent.secondaryAmount,
    minimumOutput:
      hasPrivateAmount && intent.minimumOutput === PRIVATE_AMOUNT_PARSE_SENTINEL
        ? "0"
        : intent.minimumOutput,
    maxPayment:
      hasPrivateAmount && intent.maxPayment === PRIVATE_AMOUNT_PARSE_SENTINEL
        ? "0"
        : intent.maxPayment,
    recipient: hasPrivateRecipient ? undefined : intent.recipient,
    tokenOut:
      hasPrivateRecipient && intent.tokenOut === PRIVATE_RECIPIENT_PARSE_SENTINEL
        ? undefined
        : intent.tokenOut,
    transfers: hasPrivateAmount || hasPrivateRecipient
      ? intent.transfers?.map((transfer) => ({
          ...transfer,
          amount:
            hasPrivateAmount &&
            transfer.amount === PRIVATE_AMOUNT_PARSE_SENTINEL
              ? "0"
              : transfer.amount,
          recipient:
            hasPrivateRecipient &&
            transfer.recipient === PRIVATE_RECIPIENT_PARSE_SENTINEL
              ? ""
              : transfer.recipient,
        }))
      : intent.transfers,
    workflowSteps,
    question: existingQuestion
      ? `${slotQuestion} ${existingQuestion}`
      : slotQuestion,
    message:
      "The ordered intent was resolved locally. Private fields remain on this device and no transaction is prepared until they are entered.",
  });
}

export function hasOrderedIntentConnector(prompt: string): boolean {
  return splitOrderedIntentClauses(prompt).length > 1;
}

export function extractDurationInDays(prompt: string): number | undefined {
  const match =
    /(\d+)\s*(days?|months?|years?|gün(?:lük|lüğüne)?|ay(?:lık|lığına)?|yıl(?:lık|lığına)?)(?![a-zçğıöşü])/iu.exec(
      prompt,
    );
  if (!match) return undefined;

  const value = Number(match[1]);
  if (!Number.isSafeInteger(value) || value <= 0) return undefined;
  const unit = match[2].toLocaleLowerCase("tr-TR");
  const days = /^(?:years?|yıl)/iu.test(unit)
    ? value * 365
    : /^(?:months?|ay)/iu.test(unit)
      ? value * 30
      : value;
  return Number.isSafeInteger(days) ? days : undefined;
}

export function parseDeterministicBasenameIntent(prompt: string): ParsedIntent | null {
  const nameMatch =
    /(?:^|[^a-z0-9-])([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.base\.eth(?=$|[^a-z0-9.])/i.exec(
      prompt,
    );
  if (!nameMatch) return null;

  const lower = prompt.toLocaleLowerCase("tr-TR");
  const renewRequested = /\b(?:renew|extend)\b|yenile|uzat/iu.test(lower);
  const registerRequested =
    /\b(?:register|buy|purchase)\b|satın\s+al|kaydet|kayıt\s+et/iu.test(lower);
  // Ambiguous or negated commands remain on the normal clarification/LLM
  // path instead of manufacturing a transaction intent.
  if (
    renewRequested === registerRequested ||
    /\b(?:do not|don't|not)\b.{0,24}(?:register|renew|extend)|(?:yenileme|uzatma|kaydetme|satın\s+alma)\b/iu.test(
      lower,
    )
  ) {
    return null;
  }

  const action = renewRequested ? "basename_renew" : "basename_register";
  return deterministicIntent({
    action,
    tokenIn: nameMatch[1].toLowerCase(),
    amount: "0",
    durationInDays: extractDurationInDays(prompt) ?? 365,
    message:
      action === "basename_renew"
        ? "Preparing the Base Name renewal."
        : "Preparing the Base Name registration.",
  });
}
