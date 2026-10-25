/**
 * The entry point: parseSentence (and keep phrases, which re-enter it).
 */
import {
  normalizeMessage,
  scanClosedClass,
  screenText,
  SENTENCE_VERBS,
} from "@kletia/core";
import { PlatformError } from "../../../errors.js";
import { readVenueNames, splitClauses } from "../../grammar.js";
import type { ContractPhrase } from "../../contracts/directory.js";
import {
  hasQuestionMark,
  questionRefusal,
  readOnlyRates,
  readOnlyRatesRefusal,
} from "../../readOnly.js";
import {
  abstractClause,
  EXACT_OF_PREVIOUS,
  normalizeClause,
  readClause,
  spellNumbers,
  stripLabel,
} from "../../goal/index.js";
import { amountInWords, groupedThousands } from "../../goal/amounts.js";
import {
  clauseRecord,
  closedClassError,
  consumable,
  dropFillers,
  nonLatinRefusal,
  openerOf,
  unconsumed,
  unsupportedNetwork,
} from "../../goal/closedClass.js";
import { CLOSED_CLASS_COPY } from "../copy.js";
import { isUsdWord } from "../catalog.js";
import type { Kind, UnreadClause, WorkStep } from "../types.js";
import type { Goal, ThreadCorrection, ThreadKeep } from "@kletia/core";
import {
  notUnderstood,
  type ParsedSentence,
  REFUSAL_EXAMPLES,
} from "./shapes.js";
import {
  correctClause,
  MAX_CORRECTIONS,
  parseClause,
  parseContractClause,
} from "./clauses.js";
import {
  eachRecipients,
  inMessageCorrection,
  keepPhrase,
  type KeepPhrase,
  keepRefusal,
  questionForm,
} from "./phrases.js";
import {
  bindOfPrevious,
  bindRest,
  chainImplicit,
  destinationOf,
  flagAssetTypo,
  keywordCorrection,
  neutralDestination,
  outputOf,
  pairingRefusal,
  PARALLEL_LISTS,
  paysSomeoneElse,
  pluralReference,
  previousPaidRefusal,
  readCashtags,
  recipientAsToken,
  spendsPrevious,
  stepRules,
  vagueClause,
} from "./binding.js";

/**
 * "keep N [token] [on network] [for gas]" limits the step it belongs to, and
 * "the rest" after it is all of the holding but what is kept:
 * - "keep 0.05 eth on base for gas and swap the rest to usdc": the swap spends
 *   all of the ETH on Base but 0.05 (confirmed, the keep is on the step);
 * - "swap 100 usdc to eth on base and keep 20 usdc": the swap keeps 20 USDC
 *   back (the policy checks both fit);
 * - "..., keep 50 and deposit the rest": the rest of a previous output less a
 *   kept amount is asked, never guessed;
 * - "... swap 10 of them to eth and keep the rest": nothing to do.
 */
function readWithKeep(keep: KeepPhrase, phrases: readonly ContractPhrase[], previousExists: boolean, offset: number, previousStep: WorkStep | undefined): ParsedSentence {
  const entry = keep.amount ? { amount: { t: "exact" as const, value: keep.amount }, ...(keep.asset ? { asset: keep.asset } : {}), ...(keep.network ? { network: keep.network } : {}) } : undefined;
  const head = keep.before ? parseSentence(keep.before, phrases, previousExists, offset, previousStep) : null;
  const last = head?.steps[head.steps.length - 1] ?? previousStep;
  if (keep.rest) {
    // "keep the rest": a no-op only after a step with an exact amount.
    if (keep.after || !head || last?.amount?.v.t !== "exact") throw keepRefusal("Kletia could not tell what \"keep the rest\" keeps. Give each step its amount.");
    return head;
  }
  if (!keep.after) {
    if (!head || !last || !entry) throw keepRefusal("Say which step keeps the amount back, for example \"swap 100 USDC to ETH on base and keep 20 USDC\".");
    last.keep = [...(last.keep ?? []), entry].slice(0, 4);
    return head;
  }
  if (!head && !previousExists) {
    // "keep 0.05 eth on base for gas and swap the rest to usdc": the rest of that holding, the keep on the step.
    if (!keep.asset || !/(?:^|\s)the\s+rest(?:\s|$)/iu.test(keep.after)) throw keepRefusal("Say which token the rest is, for example \"keep 0.05 ETH on base for gas and swap the rest to USDC\".");
    const said = keep.after.replace(/(?:^|\s)the\s+rest(?=\s|$)/iu, ` all my ${keep.asset.toLowerCase()}`).trim() + (keep.network && !/\s(?:on|in|from)\s/iu.test(keep.after) ? ` on ${keep.network}` : "");
    const tail = parseSentence(said, phrases, false, offset, undefined);
    const step = tail.steps[0];
    if (!step || tail.steps.length !== 1 || step.from?.v.toUpperCase() !== keep.asset) throw keepRefusal("Kletia could not apply what you keep to that step. Give the amount to use.");
    step.keep = [entry as ThreadKeep];
    if (keep.asset === "ETH" || keep.asset === "SOL" || keep.asset === "POL") {
      // A native token kept "for gas" is the fee reserve itself: until the decision layer counts it as the reserve,
      // the amount is asked (two reserves would not be the rest the person meant).
      delete step.amount;
      return tail;
    }
    step.source = "C";
    step.readAs = [...(step.readAs ?? []), { slot: "amount", rule: "keep:rest", to: `All but ${keep.amount} ${keep.asset}`.slice(0, 40) }].slice(0, 4);
    return tail;
  }
  // "..., keep 50 and deposit the rest into aave": what is left of the previous output is asked.
  const tail = parseSentence(keep.after, phrases, true, offset + (head?.steps.length ?? 0), last);
  const first = tail.steps[0];
  if (first && first.amount?.v.t === "previous" && first.amount.v.bps === 10_000) {
    delete first.amount;
    // The token and network are still the previous output's: only how much is asked.
    const asset = last ? outputOf(last) : undefined;
    const landing = last ? destinationOf(last) : undefined;
    if (asset && !first.from && !first.usdFrom && !isUsdWord(asset)) first.from = { v: asset, by: "derived", prov: { rule: "previous-output" } };
    if (landing && !first.network) first.network = { v: landing, by: "derived", prov: { rule: "previous-output" } };
  }
  else if (!head || !last || !entry) throw keepRefusal("Say which step keeps the amount back.");
  else last.keep = [...(last.keep ?? []), entry].slice(0, 4);
  return { steps: [...(head?.steps ?? []), ...tail.steps], corrections: [...(head?.corrections ?? []), ...tail.corrections] };
}

/**
 * A message as slots for every clause (1 to 8); unique keyword typos are
 * corrected (R9, R10). `previousStep` is the thread's last step when the
 * message continues a task (an appended clause): "it" after a step that pays
 * someone else is refused there too.
 *
 * Before any word is dropped or corrected (I12): the text is
 * screened (Unicode forms, emoji, homoglyph letters), the opener is read
 * (a question is refused; a polite command is planned only as a confirm),
 * cashtags are read, and each clause gets its closed-class record. An
 * unsupported network or lane qualifier refuses NETWORK_UNSUPPORTED; a
 * never-drop word no rule of this reader consumes refuses the clause with its
 * family's message; reviewed fillers are dropped and listed ("Ignored").
 */
/** Options of `parseSentence`: readings proposed for clauses the reader could not read, by clause index. */
export interface SentenceOptions {
  readonly readings?: ReadonlyMap<number, readonly Goal[]>;
}

/**
 * The refusal for unread clauses carries them (index, text, closed-class record) on a non-enumerable
 * property, so the decision layer can offer them to the reading layer; it is never serialised.
 */
function unreadRefusal(unread: readonly UnreadClause[]): PlatformError {
  const error = notUnderstood((unread[0] as UnreadClause).text);
  Object.defineProperty(error, "unreadClauses", { value: unread, enumerable: false, writable: false, configurable: false });
  return error;
}

export function parseSentence(said: string, phrases: readonly ContractPhrase[], previousExists = false, offset = 0, previousStep?: WorkStep, sentence: SentenceOptions = {}): ParsedSentence {
  // The data dashboard's "Move here" sentence: the amount placeholder is dropped (asked) and a full venue name read.
  const raw = readVenueNames(said);
  // A question is never planned as typed ("swap 0.01 ETH to USDC on base?"): it is read only as the instruction it
  // stands for, and every step is confirmed as the solved plan (questionForm); anything else is refused.
  const asked = questionForm(raw);
  if (asked) {
    const read = parseSentence(asked.text, phrases, previousExists, offset, previousStep, sentence);
    // A goal only the solver can place ("exit my aave position?") does not carry the confirm through its expansion
    // yet: refused as a question, never ready (fail closed).
    if (read.steps.some((step) => step.kind === undefined)) throw questionRefusal(normalizeMessage(raw), REFUSAL_EXAMPLES);
    for (const step of read.steps) step.questionForm = true;
    return read;
  }
  if (hasQuestionMark(raw)) throw questionRefusal(normalizeMessage(raw), REFUSAL_EXAMPLES);
  if (PARALLEL_LISTS.test(raw.trim())) throw pairingRefusal();
  const each = eachRecipients(raw);
  if (each) {
    const read = parseSentence(each, phrases, previousExists, offset, previousStep, sentence);
    for (const step of read.steps) if (step.amount) step.amount = { ...step.amount, prov: { ...step.amount.prov, rule: "deliverEach" } };
    return read;
  }
  const keep = keepPhrase(raw);
  if (keep) return readWithKeep(keep, phrases, previousExists, offset, previousStep);
  const edit = inMessageCorrection(raw);
  if (edit) {
    const read = parseSentence(edit.text, phrases, previousExists, offset, previousStep, sentence);
    const target = read.steps.find((step) => (edit.slot === "amount" ? step.amount : edit.slot === "network" ? step.network ?? step.toNetwork : step.recipient)) ?? read.steps[0];
    for (const step of read.steps) step.source = "C";
    if (target) target.readAs = [...(target.readAs ?? []), { slot: edit.slot, rule: "correction:inMessage", from: edit.from.slice(0, 16), to: `${edit.to} (you corrected ${edit.from})`.slice(0, 40) }].slice(0, 4);
    return { steps: read.steps, corrections: [...read.corrections, { field: `actions[${offset + Math.max(0, read.steps.indexOf(target as WorkStep))}].${edit.slot}`, from: edit.from.slice(0, 16), to: edit.to.slice(0, 64), material: true }] };
  }
  const screened = screenText(raw);
  if (screened.nonLatin) throw nonLatinRefusal();
  // "should i swap ...", "what if i ...": a question, never a plan; "can you swap ...": a command asked politely (confirmed).
  const opener = openerOf(screened.text);
  if (opener?.kind === "question") {
    const rates = readOnlyRates(screened.text);
    if (rates) throw readOnlyRatesRefusal(rates, REFUSAL_EXAMPLES);
    throw new PlatformError("INTENT_UNSUPPORTED", CLOSED_CLASS_COPY.question, 422, [{ path: "text", message: "A question, not an instruction." }], REFUSAL_EXAMPLES);
  }
  // Compound number words ("twenty five") become digits first; single ones are the core normaliser's.
  const labelled = stripLabel(normalizeMessage(spellNumbers(readCashtags(screened.text), 2)));
  const text = labelled.text;
  if (!text) throw new PlatformError("INTENT_UNSUPPORTED", "The message is empty.", 422);
  const extraVerbs = phrases.flatMap((phrase) => phrase.verbs);
  const clauses = splitClauses(text, extraVerbs);
  if (clauses.length === 0 || clauses.length > 8) throw new PlatformError("INTENT_UNSUPPORTED", "Say what should happen in one to eight steps.", 422);
  const steps: WorkStep[] = [];
  // The label is kept only as a note (a non-material ".text" correction, never shown as a chip or read as a slot).
  const corrections: ThreadCorrection[] = labelled.label ? [{ field: `actions[${offset}].text`, from: labelled.label.slice(0, 16), to: "note", material: false }] : [];
  let emoji = screened.emoji > 0;
  const unreadClauses: UnreadClause[] = [];
  clauses.forEach((original, clauseIndex) => {
    const index = steps.length + offset;
    const previous = previousExists || steps.length > 0;
    // The closed-class record comes first, before any word is dropped or corrected.
    const record = clauseRecord(original, steps.length === 0 ? opener : null);
    const network = unsupportedNetwork(record, `actions[${index}].network`);
    if (network) throw network;
    const lower = original.toLowerCase();
    const blocked = record.hits.find((hit) => !consumable(lower, hit));
    if (blocked) throw closedClassError(blocked);
    const fillers = dropFillers(original);
    const clause = fillers.text;
    // A clause of fillers only ("please,") says nothing.
    if (!clause || /^[,.!\s]*$/u.test(clause)) return;
    const correctionsBefore = corrections.length;
    const ambiguous = neutralDestination(clause);
    if (ambiguous) throw ambiguous;
    const plural = steps.length > 0 ? pluralReference(clause, steps, index) : null;
    if (plural) throw plural;
    // L1 (the relaxed sentence shapes) consumes no closed-class word: a clause that holds one is read by the Goal reader only.
    // An abstract goal or idiom ("prepare 100 usdc on optimism", "fund alice.eth with ...") is read whole by the Goal reader.
    const shapes = record.hits.length === 0 && !abstractClause(normalizeClause(clause));
    // "stake something": the vague noun is read before the filler pass drops it.
    let parsed = shapes ? parseContractClause(clause, phrases, index, previous) ?? vagueClause(clause, false) ?? vagueClause(original, false) ?? parseClause(clause, previous) : null;
    let fixed: ReturnType<typeof correctClause> | undefined;
    if (!parsed && shapes) {
      fixed = correctClause(clause, index);
      // More than two keyword corrections in one clause is a guess, not a reading.
      if (fixed.corrections.filter((entry) => entry.material).length > MAX_CORRECTIONS) fixed = { text: clause, corrections: [] };
      parsed = parseClause(fixed.text, previous);
      if (parsed) corrections.push(...fixed.corrections);
      if (!parsed && fixed.verbCandidates) {
        // R9: only verbs that make the rest of the clause read are candidates; one left is a correction,
        // except from an English word ("bend 5 USDC to vitalik.eth" is not corrected to send: it is refused).
        const rest = fixed.text.split(/\s+/u).slice(1).join(" ");
        const fitting = fixed.verbCandidates.filter((verb) => parseClause(`${verb} ${rest}`, previous) !== null);
        const kinds = [...new Set(fitting.map((verb) => SENTENCE_VERBS[verb] as Kind))];
        if (kinds.length === 1 && !fixed.verbEnglish) {
          parsed = parseClause(`${fitting[0]} ${rest}`, previous);
          corrections.push(...fixed.corrections, { field: `actions[${index}].kind`, from: (clause.split(/\s+/u)[0] ?? "").slice(0, 16), to: fitting[0] as string, material: true });
        } else if (kinds.length > 1) {
          const probe = parseClause(`${fitting[0]} ${rest}`, previous) as WorkStep;
          delete probe.kind;
          probe.kindCandidates = kinds;
          parsed = probe;
        }
      }
    }
    let read: WorkStep[] = parsed ? [parsed] : [];
    const applied = new Set<string>();
    let unsized: readonly WorkStep[] = [];
    let rest: readonly WorkStep[] = [];
    let ofPrevious: readonly WorkStep[] = parsed && previous && EXACT_OF_PREVIOUS.test(clause) ? [parsed] : [];
    if (!parsed) {
      // The Goal reader, only when the strict reader (with typo correction) found nothing.
      const prior = steps.length > 0 ? steps[steps.length - 1] : previousStep;
      const options = {
        previousExists: previous,
        index,
        strict: (piece: string, before: boolean) => (scanClosedClass(piece).length === 0 ? parseClause(piece, before) : null),
        ...(prior ? { previousStep: prior } : {}),
        paysOther: paysSomeoneElse,
      };
      let reading = readClause(clause, options);
      // Keyword typos may help the Goal reader too, but never a corrected verb: "unstake" is not "stake".
      if (!reading && fixed && fixed.text !== clause && !fixed.corrections.some((entry) => entry.field.endsWith(".kind")) && !fixed.verbCandidates) {
        reading = readClause(fixed.text, options);
        if (reading) corrections.push(...fixed.corrections);
      }
      if (!reading) {
        // A unit or an approximation the reading could not apply says so ("50 cents of eth", "almost all my sol").
        const unread = record.hits.find((hit) => hit.category === "unit" || hit.category === "approximation");
        if (unread) throw closedClassError(unread);
        const vague = shapes ? vagueClause(clause, true) : null;
        if (vague) read = [vague];
        else {
          // A reading proposed for this clause (model-assisted, source M) stands in for it; it is solved
          // and confirmed like any goal step. Otherwise the clause is recorded as unread and the message refused.
          const given = sentence.readings?.get(clauseIndex);
          if (!given || given.length === 0) {
            unreadClauses.push({ index: clauseIndex, text: clause, closedClass: record });
            return;
          }
          read = given.map((goal: Goal): WorkStep => ({ goal, goalRead: { lowered: false }, modelRead: true, source: "M" }));
        }
      } else {
        corrections.push(...reading.corrections);
        read = reading.steps;
        for (const rule of reading.rules) applied.add(rule);
        unsized = reading.unsized;
        ofPrevious = reading.ofPrevious;
        rest = reading.rest;
      }
    }
    // I12: every closed-class word of the clause was consumed by a rule this reading applied.
    for (const step of read) for (const rule of stepRules(step)) applied.add(rule);
    const left = unconsumed(record, original, applied);
    if (left) throw closedClassError(left);
    const corrected = corrections.slice(correctionsBefore).some(keywordCorrection);
    const ignored = [...fillers.ignored, ...(emoji ? ["emoji"] : [])];
    emoji = false;
    read.forEach((step, position) => {
      const at = index + position;
      const before = steps.length > 0 ? steps[steps.length - 1] : previousStep;
      if (!unsized.includes(step)) chainImplicit(step, previous || position > 0, before);
      // "send 10 usdc to vitalik.eth and swap 5 of it": that output is someone else's.
      if (paysSomeoneElse(before) && (spendsPrevious(step) || ofPrevious.includes(step))) throw previousPaidRefusal(at);
      if (ofPrevious.includes(step)) bindOfPrevious(step, before, at);
      if (rest.includes(step)) bindRest(step, before, at);
      if (recipientAsToken(step)) throw notUnderstood(clause);
      flagAssetTypo(step);
      const amount = step.amount?.v;
      if (amount?.t === "exact" && amount.raw && /^\$?\d+,\d{1,2}$/u.test(amount.raw)) {
        corrections.push({ field: `actions[${at}].amount`, from: amount.raw.slice(0, 16), to: amount.value, material: true });
      }
      // "send 2,500 usdc to ...": a grouped amount paid to someone else is always read back in words.
      if (amount?.t === "exact" && groupedThousands(amount.raw) && paysSomeoneElse(step) && !(step.readAs ?? []).some((item) => item.slot === "amount")) {
        const words = amountInWords(amount.value);
        const shown = `${amount.raw}${step.from ? ` ${step.from.v.toUpperCase()}` : ""}`;
        const to = words && shown.length + words.length + 3 <= 64 ? `${shown} (${words})` : shown;
        step.readAs = [...(step.readAs ?? []), { slot: "amount", rule: "format:grouped", to }].slice(0, 4);
      }
      // What the reader recorded for the decision layer: corrections, the question form, the ignored words.
      if (corrected) step.source = "C";
      if (opener?.kind === "polite") step.questionForm = true;
      if (position === 0 && ignored.length > 0) step.ignored = [...ignored];
      const rules = stepRules(step);
      const hits = record.hits.filter((hit) => hit.rules.some((rule) => rules.has(rule)));
      if (hits.length > 0 || record.lookalikes.length > 0 || (record.opener && position === 0)) step.closedClass = { ...record, hits };
      steps.push(step);
    });
  });
  if (unreadClauses.length > 0) throw unreadRefusal(unreadClauses);
  if (steps.length === 0) throw notUnderstood(text);
  if (steps.length > 8) throw new PlatformError("INTENT_UNSUPPORTED", "Say what should happen in one to eight steps.", 422);
  return { steps, corrections };
}
