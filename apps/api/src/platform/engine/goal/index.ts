/**
 * The Goal reader: a clause the strict slot reader could not read is
 * normalised, split (F7), lexed and read by frames into Goals. Each piece
 * is first offered to the strict reader again (after normalisation, "hey
 * could you move 25 USDC from base over to solana" is a strict sentence);
 * otherwise its Goal is lowered to slots when it maps one-to-one onto verb
 * steps (lower.ts).
 *
 * A Goal that only the solver can place becomes a goal step (`WorkStep.goal`),
 * which the policy solves each turn (clarify/goals.ts). Goal steps are on by
 * default; `configureGoalSteps(false)` turns them off (the clause is then
 * refused: the reader never plans a guess).
 */
import { GOAL_LIMITS, normalizeMessage, scanClosedClass, SENTENCE_VERBS, type Goal, type ThreadCorrection } from "@kletia/core";
import { splitClauses } from "../grammar.js";
import { COMMENTARY_RULES, spellNumbers } from "./amounts.js";
import type { Slot, WorkStep } from "../clarify/types.js";
import { splitGoalClauses } from "./clauses.js";
import { readFrame, type ReadGoal } from "./frames.js";
import { lex, normalizeClause, type Token } from "./lexer.js";
import { lowerGoal } from "./lower.js";
import { canonicalOn, family, recipientFamily } from "../clarify/catalog.js";
import { resolveNetworkName } from "../grammar.js";

export {
  amountInWords, commentaryAgrees, commentaryOf, COMMENTARY_RULES, fractionBps, fractionDecimal, groupedThousands, renderAmount, readNumber, spellNumbers,
  toThreadAmount, type AmountCommentary,
} from "./amounts.js";
export { lex, normalizeClause, symbolTypoCandidates, type Token } from "./lexer.js";
export { readFrame, type GoalNotes, type ReadGoal } from "./frames.js";
export { lowerGoal } from "./lower.js";
export { splitGoalClauses } from "./clauses.js";

/** "rent: send 500 USDC ...": one to three words, then a colon and a space (never "solana:...", "eip155:..."). */
const LABEL = /^(?<label>[a-z][a-z'-]{0,23}(?:\s+[a-z][a-z'-]{0,23}){0,2})\s*:\s+(?<rest>\S.*)$/iu;

/**
 * A leading label ("rent:", "diversify:") is a note, never part of the
 * sentence: it is dropped when none of its words names an asset, network,
 * venue, amount, recipient or connector. A label that is a verb ("rebalance:
 * half my USDC ...") is kept when the rest has no verb of its own (the Goal
 * reader reads the colon as a pause).
 */
export function stripLabel(text: string): { text: string; label?: string } {
  const match = LABEL.exec(text);
  if (!match?.groups) return { text };
  const label = match.groups.label as string;
  const rest = (match.groups.rest as string).trim();
  const words = lex(normalizeClause(label));
  if (words.length === 0 || words.some((token) => token.t !== "NOISE" && token.t !== "ASSET?" && token.t !== "VERB")) return { text };
  // A label never hides a closed-class word ("dont groceries:", "maybe rent:"): the sentence is read with it (I12).
  if (scanClosedClass(label.toLowerCase()).length > 0) return { text };
  const restVerb = lex(normalizeClause(rest))[0]?.t === "VERB" || Object.hasOwn(SENTENCE_VERBS, (rest.split(/\s+/u)[0] ?? "").toLowerCase());
  if (words.some((token) => token.t === "VERB") && !restVerb) return { text };
  return { text: rest, label };
}

let goalStepsEnabled = true;

/** Whether unsolved goals become goal steps (on by default; tests pass `false`, then `null` to restore the default). */
export function configureGoalSteps(enabled: boolean | null): void {
  goalStepsEnabled = enabled ?? true;
}

export interface ReadClauseOptions {
  /** A step comes before this clause (earlier clause or thread). */
  readonly previousExists: boolean;
  /** The action index of this clause's first step (for correction fields). */
  readonly index: number;
  /** The strict slot reader for one normalised piece (slots.ts parseClause). */
  readonly strict: (text: string, previousExists: boolean) => WorkStep | null;
  /** The step before this clause (earlier clause or thread), when known. */
  readonly previousStep?: WorkStep;
  /** True for a step whose output goes to someone else: a piece after it is never chained to that output implicitly. */
  readonly paysOther?: (step: WorkStep) => boolean;
}

export interface ClauseReading {
  readonly steps: WorkStep[];
  readonly corrections: ThreadCorrection[];
  /** The Goals the frames read (lowered or not), in step order; strict pieces have none. */
  readonly goals: readonly Goal[];
  /** Closed-class rules the reading applied ("order:then", "connector:over", "amountVague:approx", "unit:thousand", ...). */
  readonly rules: readonly string[];
  /** Steps whose amount was said only roughly: never chained to a previous output (their amount is asked). */
  readonly unsized: readonly WorkStep[];
  /** Steps that spend an exact amount of the previous output's token ("send 20 of it"): the caller binds the token. */
  readonly ofPrevious: readonly WorkStep[];
  /** Steps that spend "the rest": the caller resolves what it is the rest of. */
  readonly rest: readonly WorkStep[];
}

/**
 * A unit or multiplier reading ("1.5 k" -> 1500 USDC) on the step that
 * carries the amount: the amount keeps what was typed and its unit, the slot
 * names the rule, and the step gets a "Read as" item.
 */
function markAmountForm(steps: readonly WorkStep[], form: NonNullable<ReadGoal["notes"]["amountForm"]>): void {
  const step = steps.find((entry) => entry.amount !== undefined) ?? steps[0];
  if (!step) return;
  if (step.amount) {
    const value = step.amount.v;
    step.amount = {
      ...step.amount,
      v: value.t === "exact" ? { ...value, raw: form.raw.slice(0, 40), rewritten: true, ...(form.unit ? { unit: form.unit } : {}) } : value,
      prov: { ...step.amount.prov, rule: form.rule },
    };
  }
  const item = { slot: "amount", rule: form.rule, from: form.raw.slice(0, 16), to: form.readAs.slice(0, 40) };
  step.readAs = [...(step.readAs ?? []), item].slice(0, 4);
}

/**
 * What else the amount form asks of the steps:
 * arithmetic the person wrote is a derived reading (source C: a one-click
 * confirm "Read as 15 USDC (10 + 5)"); a side remark on the stated amount
 * ("worth $150", "(half my stack)") is recorded as a "Read as" item whose
 * rule names it (`commentary:usd` / `commentary:portion`, read back with
 * `commentaryOf`) and confirmed until the decision layer has checked it
 * against prices and holdings.
 */
function markDerived(steps: readonly WorkStep[], notes: ReadGoal["notes"]): void {
  const step = steps.find((entry) => entry.amount !== undefined) ?? steps[0];
  if (!step) return;
  if (notes.derived) step.source = "C";
  const remark = notes.commentary;
  if (!remark) return;
  const amount = step.amount?.v;
  const stated = amount?.t === "exact" ? `${amount.value}${step.from ? ` ${step.from.v.toUpperCase()}` : ""}` : "the amount";
  const item = { slot: "amount", rule: COMMENTARY_RULES[remark.kind], from: remark.raw.slice(0, 16), to: stated.slice(0, 40) };
  step.readAs = [...(step.readAs ?? []), item].slice(0, 4);
  step.source = "C";
}

/** "bridge 0.05 of it", "deposit 60 of them": an exact amount followed by a reference to the previous output. */
export const EXACT_OF_PREVIOUS = /^\S+\s+(?:\$?\d[\d,]*(?:\.\d+)?|\.\d+)\s+of\s+(?:it|them|that|those|the\s+output|the\s+proceeds)(?:\s|$)/iu;

/** "send the same to bob.base.eth" (the verb inherited), "the same amount to bob.eth on base". */
const SAME_TO = /^(?:(?:send|pay|transfer|give|tip)\s+)?the\s+same(?:\s+amount)?\s+to\s+(?<recipient>\S+)(?:\s+on\s+(?<network>[a-z][a-z -]{1,24}))?$/iu;

/**
 * "the same to bob": amount, token and network of the payment before, to a
 * new recipient. Only after a payment with an exact amount and a token; the
 * network is copied only when the new recipient can receive there (its family),
 * else it stays open for the policy to ask. Always source C (one-click confirm).
 */
function sameAs(before: WorkStep, recipient: string, network: string | undefined): WorkStep | null {
  if (before.kind?.v !== "transfer" || !before.recipient || before.amount?.v.t !== "exact" || (!before.from && !before.usdFrom)) return null;
  if (!/^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:eth|sns|sol)|0x[0-9a-f]{40}|[1-9a-hj-np-z]{32,44})$/iu.test(recipient)) return null;
  const said = network ? resolveNetworkName(network) : null;
  if (network && !said) return null;
  const step: WorkStep = {
    kind: { v: "transfer", by: "user" },
    recipient: { v: recipient, by: "user" },
    amount: { v: before.amount.v, by: "derived", prov: { rule: "same-as-previous" } },
    ...(before.from ? { from: { v: before.from.v, by: "derived" as const, prov: { rule: "same-as-previous" } } } : {}),
    ...(before.usdFrom ? { usdFrom: true } : {}),
    source: "C",
  };
  const kind = recipientFamily(recipient);
  const copied = before.network?.v;
  if (said) step.network = { v: said, by: "user" };
  else if (copied && kind !== "caip" && (kind === null ? !/\.(?:sns|sol)$/iu.test(recipient) && family(copied) === "eip155" : family(copied) === kind)) {
    step.network = { v: copied, by: "derived", prov: { rule: "same-as-previous" } };
  }
  const amount = before.amount.v;
  step.readAs = [{ slot: "amount", rule: "same-as-previous", to: `${amount.value}${before.from ? ` ${before.from.v.toUpperCase()}` : ""} (the same)`.slice(0, 40) }];
  return step;
}

/** "buy 100 usdc worth of sol": "worth" is the connector that says which side the dollars are on. */
const WORTH_SAID = /^(?:buy|purchase|get|get\s+me)\s+\$?\d[\d,]*(?:\.\d+)?\s+(?:usdc|usdt|pyusd|dai|usdbc|usdt0|usds)\s+worth\s+of\s+\S+/iu;

/** "i want sol on solana, pay with 100 usdc from base": the funding phrase reads as "with ..." of the same goal. */
function fundingClause(text: string): string {
  return text
    .replace(/\s*,\s*(?:and\s+)?(?:pay(?:ing)?\s+(?:with|using)|using|with)\s+/iu, " with ")
    // "move 100 usdc from optimism to solana and receive sol": the token received is the token wanted.
    .replace(/\s+and\s+receive\s+(?<asset>[a-z][a-z0-9.]{0,15})$/iu, " as $<asset>")
    // "use 50 usdc from arbitrum to buy sol": the funding of a buy, said first.
    .replace(/^use\s+(?<funds>.+?)\s+to\s+(?<verb>buy|purchase|get)\s+(?<wanted>.+)$/iu, "$<verb> $<wanted> with $<funds>")
    // "i want my 1 sol as usdc on base": that amount converted.
    .replace(/^(?:i\s+want|i'?d\s+like)\s+(?:my\s+)?(?<amount>\$?\d[\d,]*(?:\.\d+)?\s+[a-z][a-z0-9.]{0,15})\s+as\s+(?<rest>.+)$/iu, "turn $<amount> into $<rest>");
}

/**
 * "all my sol except 2", "everything of my usdc but 10": the all-but
 * amount said around the token, read like "all except 2 of my sol" (the
 * lexer's adjacent form, rule allBut:except).
 */
const ALL_BUT_AROUND = /(?<=^|\s)(?<all>all|everything)\s+(?:of\s+)?(?<my>my\s+)?(?<asset>[a-z][a-z0-9.]{0,15})\s+(?<word>except|but)\s+(?<keep>\d[\d,]*(?:\.\d+)?|\.\d+)(?=\s|$)/iu;

function nonAdjacentAllBut(text: string): string {
  return text.replace(ALL_BUT_AROUND, (_match, ...args) => {
    const groups = args[args.length - 1] as Record<string, string | undefined>;
    return `${groups.all} ${groups.word} ${groups.keep} of ${groups.my ?? ""}${groups.asset}`.replace(/\s+/gu, " ");
  });
}

const VERB_START = (tokens: readonly Token[]) => tokens[0]?.t === "VERB";

/** The first word of a piece when it is a verb the strict reader knows (for F7 inheritance). */
function leadingVerb(text: string, tokens: readonly Token[]): string | undefined {
  const first = tokens[0];
  if (first?.t !== "VERB") return undefined;
  return text.slice(first.span[0], first.span[1]);
}

/** F7: an ellipsis piece without an asset reuses the previous step's; a network said only on the last piece applies to the group. */
function shareEllipsis(group: WorkStep[]): void {
  if (group.length < 2) return;
  for (let index = 1; index < group.length; index += 1) {
    const step = group[index] as WorkStep;
    const before = group[index - 1] as WorkStep;
    if (!step.from && !step.usdFrom && before.from && step.amount?.v.t === "exact") step.from = { ...before.from } as Slot<string>;
  }
  const last = group[group.length - 1] as WorkStep;
  if (last.network?.by === "user") {
    for (const step of group.slice(0, -1)) {
      // Only to pieces whose token is listed there ("swap 1 sol to usdc and 0.1 eth to usdc on base": SOL is not on Base).
      const listed = !step.from || canonicalOn(last.network.v, step.from.v) !== null;
      if (!step.network && step.kind?.v === last.kind?.v && listed) step.network = { v: last.network.v, by: "user" };
    }
  }
}

/**
 * One clause read by the Goal reader: its steps (strict pieces and lowered
 * goals, plus goal steps when they are on), or null when any piece cannot be
 * read (the caller refuses the clause, as today). A clause of fillers only
 * ("please") reads as no steps; the caller refuses a message with none.
 */
export function readClause(clause: string, options: ReadClauseOptions): ClauseReading | null {
  const pieces = splitGoalClauses(clause, GOAL_LIMITS.maxGoals);
  if (!pieces || pieces.length === 0) return null;
  const steps: WorkStep[] = [];
  const corrections: ThreadCorrection[] = [];
  const goals: Goal[] = [];
  const rules = new Set<string>();
  const unsized: WorkStep[] = [];
  const ofPrevious: WorkStep[] = [];
  const rest: WorkStep[] = [];
  let verbWord: string | undefined;
  let group: WorkStep[] = [];
  for (const piece of pieces) {
    // "..., after that send ...", "...; then ...": the sequence word was read as step order.
    if (piece.joinedBy === "then") rules.add("order:then");
    const previousExists = options.previousExists || steps.length > 0;
    let text = normalizeClause(nonAdjacentAllBut(fundingClause(piece.text)));
    // A piece of fillers only ("please," before the sentence) says nothing.
    if (!text) continue;
    let tokens = lex(text);
    if (piece.joinedBy === "and" && !VERB_START(tokens) && verbWord && tokens[0]?.t !== "WORK") {
      text = `${verbWord} ${text}`;
      tokens = lex(text);
    } else {
      if (group.length > 0) shareEllipsis(group);
      group = [];
    }
    verbWord = leadingVerb(text, tokens) ?? verbWord;
    // "... and the same to bob.base.eth": a copy of the payment before, confirmed (source C, I13 by reference).
    const same = SAME_TO.exec(text);
    if (same?.groups) {
      const before = steps.length > 0 ? steps[steps.length - 1] : options.previousStep;
      const copy = before ? sameAs(before, same.groups.recipient as string, same.groups.network) : null;
      if (!copy) return null;
      steps.push(copy);
      group = [];
      continue;
    }
    // "send .1 eth 2 alice.eth": a digit read as a word is a correction (confirmed, source C).
    for (const token of tokens) {
      if (token.t === "CONN" && token.digit) corrections.push({ field: `actions[${options.index + steps.length}].text`, from: token.digit, to: token.word, material: true });
    }
    const strict = options.strict(text, previousExists);
    if (strict) {
      if (previousExists && EXACT_OF_PREVIOUS.test(text)) ofPrevious.push(strict);
      steps.push(strict);
      group.push(strict);
      continue;
    }
    const before = steps.length > 0 ? steps[steps.length - 1] : options.previousStep;
    const chainable = !(before && options.paysOther?.(before));
    const worthSaid = WORTH_SAID.test(piece.text);
    const read: ReadGoal | null = readFrame(tokens, { previousExists, index: goals.length, ...(chainable ? {} : { chainable: false }), ...(worthSaid ? { worthSaid } : {}) });
    if (!read) return null;
    for (const rule of read.notes.rules) rules.add(rule);
    goals.push(read.goal);
    const lowered = lowerGoal(read, { previousExists });
    if (lowered) {
      if (read.notes.rewritten) {
        corrections.push({ field: `actions[${options.index + steps.length}].amount`, from: read.notes.rewritten.from, to: read.notes.rewritten.to, material: true });
      }
      if (read.notes.amountForm) markAmountForm(lowered, read.notes.amountForm);
      markDerived(lowered, read.notes);
      if (read.notes.vague) unsized.push(...lowered);
      if (read.notes.ofPreviousExact && lowered[0]) ofPrevious.push(lowered[0]);
      if (read.notes.rest && lowered[0]) rest.push(lowered[0]);
      steps.push(...lowered);
      group.push(...lowered);
      continue;
    }
    if (!goalStepsEnabled) return null;
    // A rough amount on a goal only the solver can place is not read: the clause asks for an exact amount instead.
    if (read.notes.vague) return null;
    // "the rest" on a goal only the solver can place is not read: the clause is refused, never a guess.
    if (read.notes.rest) return null;
    const step: WorkStep = { goal: read.goal, goalRead: { lowered: false, ...(read.notes.orderOnly ? { orderOnly: true } : {}), ...(read.notes.possessive ? { possessive: true } : {}) } };
    if (read.notes.amountForm) markAmountForm([step], read.notes.amountForm);
    markDerived([step], read.notes);
    steps.push(step);
    group = [];
  }
  if (group.length > 0) shareEllipsis(group);
  if (steps.length > GOAL_LIMITS.maxGoals) return null;
  return { steps, corrections, goals, rules: [...rules], unsized, ofPrevious, rest };
}

/**
 * Every piece of a message read by the frames alone (no strict reader, no
 * lowering): one ReadGoal per piece, or null for a piece the frames cannot
 * read. For tests, the eval and the solver's thread memory.
 */
export function readGoals(message: string, previousExists = false): (ReadGoal | null)[] {
  const out: (ReadGoal | null)[] = [];
  let index = 0;
  for (const clause of splitClauses(stripLabel(normalizeMessage(spellNumbers(message, 2))).text)) {
    let verbWord: string | undefined;
    for (const piece of splitGoalClauses(clause, GOAL_LIMITS.maxGoals) ?? []) {
      let text = normalizeClause(piece.text);
      if (!text) continue;
      let tokens = lex(text);
      if (piece.joinedBy === "and" && !VERB_START(tokens) && verbWord && tokens[0]?.t !== "WORK") {
        text = `${verbWord} ${text}`;
        tokens = lex(text);
      }
      verbWord = leadingVerb(text, tokens) ?? verbWord;
      out.push(readFrame(tokens, { previousExists: previousExists || index > 0, index }));
      index += 1;
    }
  }
  return out;
}
