/**
 * The relaxed slot reader: each clause of a message is matched by the
 * grammar's own sentence shapes with every slot optional, so "swap SOL to
 * USDC" reads as a swap with no amount instead of a refusal. Fragments come
 * from grammar.ts (SENTENCE_FRAGMENTS and the venue words); keyword typos
 * are corrected only when exactly one word is close; contract aliases go
 * through the grammar's matchContractPhrase.
 *
 * The modules live in ./slots/.
 */
export { KEYWORD_VOCABULARY } from "./slots/shapes.js";
export type { ParsedSentence } from "./slots/shapes.js";
export { parseAmountText } from "./slots/clauses.js";
export { readCashtags } from "./slots/binding.js";
export * from "./slots/parseSentence.js";
