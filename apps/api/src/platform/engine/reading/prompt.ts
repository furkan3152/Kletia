/**
 * Prompts of the reading layer (design A.7.2, A.7.7): one rules text, and per
 * family a variant with its own few-shot examples in its own order, so the
 * families do not share examples. The variant id is part of every recording
 * key; changing a prompt invalidates the recordings.
 *
 * The prompts carry no wallet, balance, history, id, address or name, and no
 * project contract alias; only Kletia's rules and masked examples.
 */
import { READING_KINDS, READING_OPS } from "./schema.js";

const RULES = [
  "You read one instruction for a crypto wallet. It is given as a numbered token list; <amount_N> and <word_N> are placeholders.",
  "Answer with JSON only, matching the schema. Never write a value: cite tokens by span [start, end) (end exclusive).",
  `kind is one of ${READING_KINDS.join(", ")}; op (optional) is one of ${READING_OPS.join(", ")} and must be the verb said.`,
  "verb: the span of the verb words. spend: what is given up (asset, amount, network after 'from').",
  "want: what is received (asset, amount for a target, network after 'to', venue to deposit or stake into).",
  "position: the venue money is withdrawn from. on: a network said with 'on' or 'in' for the whole instruction. prefer: cheapest/fastest/safest word.",
  "Each token belongs to at most one field. Do not guess: if any part is unclear, a payment to someone, a question, a condition or several actions, answer {\"verdict\":\"unclear\"}.",
  "Put a field name in unsure when you are not certain of it.",
].join("\n");

interface Example {
  readonly tokens: string;
  readonly answer: string;
}

const EXAMPLES_A: readonly Example[] = [
  { tokens: "0:into 1:eth 2:swap 3:my 4:<amount_1> 5:usdc 6:on 7:base", answer: '{"verdict":"reading","goal":{"kind":"convert","op":"swap","verb":[2,3],"spend":{"asset":[5,6],"amount":[3,5]},"want":{"asset":[0,2]},"on":[6,8]}}' },
  { tokens: "0:aave 1:on 2:arbitrum 3:deposit 4:<amount_1> 5:usdc", answer: '{"verdict":"reading","goal":{"kind":"earn","op":"deposit","verb":[3,4],"spend":{"asset":[5,6],"amount":[4,5]},"want":{"venue":[0,1]},"on":[1,3]}}' },
  { tokens: "0:<word_1> 1:<amount_1> 2:usdc 3:to 4:base", answer: '{"verdict":"unclear"}' },
];

const EXAMPLES_B: readonly Example[] = [
  { tokens: "0:to 1:arbitrum 2:bridge 3:<amount_1> 4:usdc 5:from 6:base", answer: '{"verdict":"reading","goal":{"kind":"relocate","op":"bridge","verb":[2,3],"spend":{"asset":[4,5],"amount":[3,4],"network":[5,7]},"want":{"network":[0,2]}}}' },
  { tokens: "0:with 1:usdc 2:buy 3:<amount_1> 4:sol 5:on 6:solana", answer: '{"verdict":"reading","goal":{"kind":"acquire","op":"swap","verb":[2,3],"spend":{"asset":[0,2]},"want":{"asset":[4,5],"amount":[3,4]},"on":[5,7]}}' },
  { tokens: "0:swap 1:<amount_1> 2:eth 3:if 4:<word_1>", answer: '{"verdict":"unclear"}' },
];

export interface PromptVariant {
  readonly id: string;
  readonly system: string;
}

function variant(id: string, examples: readonly Example[]): PromptVariant {
  const shots = examples.map((example) => `Tokens: ${example.tokens}\nAnswer: ${example.answer}`).join("\n\n");
  return { id, system: `${RULES}\n\nExamples:\n\n${shots}` };
}

/** Family 0 (primary), 1 (cross-check), 2 (hedge): disjoint examples, different order. */
export const READING_VARIANTS: readonly PromptVariant[] = Object.freeze([
  variant("r2-a1", EXAMPLES_A),
  variant("r2-b1", EXAMPLES_B),
  variant("r2-c1", [...EXAMPLES_B].reverse()),
]);

export function readingUser(maskedText: string): string {
  return `Tokens: ${maskedText}\nAnswer:`;
}

const ANSWER_RULES = [
  "A person answered a multiple-choice question in their own words. The answer is a numbered token list; <word_N> is a placeholder.",
  "Pick the one option id the answer clearly names, citing the answer tokens that name it as evidence [start, end).",
  "If no option is clearly named, answer {\"option\":null}. Answer with JSON only.",
].join("\n");

export const ANSWER_VARIANTS: readonly PromptVariant[] = Object.freeze([
  { id: "a1-a", system: ANSWER_RULES },
  { id: "a1-b", system: `${ANSWER_RULES}\nNever pick an option the answer only hints at.` },
  { id: "a1-c", system: `${ANSWER_RULES}\nWhen unsure, the option is null.` },
]);

export function answerUser(maskedText: string, options: readonly { id: string; label: string }[]): string {
  return `Options:\n${options.map((option) => `- ${option.id}: ${option.label}`).join("\n")}\nAnswer tokens: ${maskedText}\nJSON:`;
}
