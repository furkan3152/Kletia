/**
 * Question forms, keep phrases, in-message corrections and per-recipient
 * phrasing.
 */
import { scanClosedClass, type NetworkKey } from "@kletia/core";
import { PlatformError } from "../../../errors.js";
import { ASSET_NETWORK_WORDS, resolveNetworkName } from "../../grammar.js";
import { readOnlyRates } from "../../readOnly.js";
import { openerOf } from "../../goal/closedClass.js";
import { knownSymbol } from "../catalog.js";
import { ADDR, REFUSAL_EXAMPLES } from "./shapes.js";
import { parseAmountText } from "./clauses.js";

/* ----------------------------------------------------------- questions */

/** "what's the best yield for my usdc", "best yield for 200 usdc on arbitrum": a yield question about one holding. */
const YIELD_QUESTION = /^(?:(?:what(?:'s|s| is)|which is|where(?:'s| is))\s+)?(?:the\s+)?(?:best|highest|top)\s+(?:yield|apy|rate|interest(?:\s+rate)?)\s+(?:for|on)\s+(?<object>(?:my\s+)?(?:\$?\d[\d,]*(?:\.\d+)?\s+)?[a-z][a-z0-9.]{1,15}(?:\s+(?:on|in)\s+[a-z][a-z -]{1,24})?)$/iu;
/** The imperatives that act on the answer of a yield question ("put it there", "go"). */
const ANSWER_IMPERATIVE = /^(?:(?:ok|okay|then|so|and|please|pls|plz)\s+)*(?:go|go for it|do it|put it there|put it in there|deposit it there|put them there|lets go|let's go)(?:\s+(?:please|pls|plz|thanks|thx))?$/iu;
/** "what is the cheapest way to <command>": a command asked as a question (confirmed, never planned as typed). */
const WAY_QUESTION = /^(?:(?:what(?:'s|s| is)|which is)\s+)?(?:the\s+)?(?:cheapest|fastest|best|easiest|quickest)\s+way\s+to\s+(?<command>\S.*)$/iu;

interface QuestionForm {
  /** The instruction Kletia reads instead of the question, from the person's own words. */
  readonly text: string;
  /** The rule that turned the question into that instruction. */
  readonly rule: "question:trailing" | "question:yieldAnswer" | "question:way";
}

/**
 * Questions vs commands. Returns the instruction a question stands for (always
 * confirmed as the solved plan: every step is `questionForm`), or null when the
 * message is not one of these shapes (the caller refuses a question as before):
 * - "swap 0.01 eth to usdc on base?", "can you swap 1 sol to usdc?": the
 *   command before a trailing "?" (an advice or hypothetical opener is refused);
 * - "what's the best yield for my usdc? put it there", "best yield for 200
 *   usdc on arbitrum, go": a deposit into the best-ranked venue, only when the
 *   imperative passes the never-drop check ("... don't put it there yet" is
 *   refused);
 * - "what is the cheapest way to send 50 usdc to alice.eth": the command.
 */
export function questionForm(raw: string): QuestionForm | null {
  const text = raw.replace(/\s+/gu, " ").trim();
  const mark = text.search(/[?¿？﹖⸮]/u);
  const head = (mark >= 0 ? text.slice(0, mark) : text).trim();
  const tail = mark >= 0 ? text.slice(mark).replace(/^[?¿？﹖⸮!.\s]+/u, "").trim() : "";
  const label = /^[a-z][a-z' -]{0,23}:\s+/iu.exec(head);
  const body = label && scanClosedClass(label[0].toLowerCase()).length === 0 ? head.slice(label[0].length) : head;
  const yieldQuestion = (question: string, imperative: string): QuestionForm | null => {
    const match = YIELD_QUESTION.exec(question.replace(/[,.!]+$/u, "").trim());
    if (!match?.groups) return null;
    const command = imperative.replace(/[.!]+$/u, "").trim();
    // The imperative must carry no closed-class word ("don't put it there yet" is not an instruction).
    if (!ANSWER_IMPERATIVE.test(command) || scanClosedClass(command.toLowerCase()).length > 0) return null;
    return { text: `deposit ${match.groups.object} into the best yield`, rule: "question:yieldAnswer" };
  };
  if (tail) {
    if (/[?¿？﹖⸮]/u.test(tail)) return null;
    return yieldQuestion(body, tail);
  }
  // "best yield for 200 usdc on arbitrum, go": the imperative after a comma.
  const comma = /^(?<question>.+?),\s*(?<imperative>[^,]+)$/u.exec(body);
  if (comma?.groups && mark < 0) {
    const read = yieldQuestion(comma.groups.question as string, comma.groups.imperative as string);
    if (read) return read;
  }
  const way = WAY_QUESTION.exec(body.replace(/[.!]+$/u, "").trim());
  if (way?.groups) return { text: way.groups.command as string, rule: "question:way" };
  if (mark < 0) return null;
  // A trailing "?" on a command: never ready, only a confirm of the solved plan; an advice opener stays a question.
  if (openerOf(body)?.kind === "question" || readOnlyRates(body)) return null;
  return { text: body, rule: "question:trailing" };
}

/* ------------------------------------------------------------- keep */

const KEEP_SYMBOL = "(?!(?:on|in|for|and|then|the)\\b)(?<asset>[a-z][a-z0-9.]{1,15})";
/** "keep 0.05 eth on base for gas", "keep 50", "keep the rest": a constraint of a step, never a step. */
const KEEP = new RegExp(
  `(?:^|\\s*,\\s*(?:and\\s+)?|\\s+and\\s+|\\s+then\\s+)keep\\s+(?:(?<rest>the\\s+rest)|(?<amount>\\$?\\d[\\d,]*(?:\\.\\d+)?|\\.\\d+)(?:\\s+${KEEP_SYMBOL})?(?:\\s+(?:on|in)\\s+(?<network>[a-z][a-z-]*(?:\\s+(?:one|mainnet|pos|sepolia|devnet|testnet))?))?(?:\\s+for\\s+gas)?)(?=\\s*(?:[,;.]|$)|\\s+(?:and|then)\\s+)`,
  "iu",
);

export interface KeepPhrase {
  readonly before: string;
  readonly after: string;
  readonly rest: boolean;
  readonly amount?: string;
  readonly asset?: string;
  readonly network?: NetworkKey;
}

export function keepRefusal(message: string): PlatformError {
  return new PlatformError("INTENT_UNSUPPORTED", message, 422, [{ path: "text", message: "What to keep could not be applied." }], REFUSAL_EXAMPLES);
}

/** The one "keep ..." phrase of a message, split out of it (two or more are refused: which step each limits is a guess). */
export function keepPhrase(text: string): KeepPhrase | null {
  const match = KEEP.exec(text);
  if (!match?.groups) return null;
  const after = text.slice(match.index + match[0].length).replace(/^\s*(?:[,;.]\s*)?(?:and\s+|then\s+)*/iu, "").trim();
  const before = text.slice(0, match.index).trim().replace(/[,;.]+$/u, "").trim();
  if (KEEP.test(after) || /(?:^|\s)keep\s/iu.test(before)) throw keepRefusal("Say what to keep once, for one step, for example \"keep 0.05 ETH on base for gas and swap the rest to USDC\".");
  const g = match.groups;
  if (g.rest) return { before, after, rest: true };
  const amount = parseAmountText(g.amount as string, false);
  if (amount.t !== "exact" || amount.usd) throw keepRefusal("Say how much to keep as a number of tokens, for example \"keep 0.05 ETH\".");
  if (g.asset && !knownSymbol(g.asset)) return null;
  const network = g.network ? resolveNetworkName(g.network) : null;
  if (g.network && !network) return null;
  return { before, after, rest: false, amount: amount.value, ...(g.asset ? { asset: g.asset.toUpperCase() } : {}), ...(network ? { network } : {}) };
}

/* ------------------------------------------- in-message corrections */

/** "no wait, 3 sol", "actually make it 0.5", "sorry, I meant arbitrum": a correction at the end of the message. */
const IN_MESSAGE_CORRECTION = /^(?<message>.+?)(?:\s*[,.;!]\s*|\s+)(?:no\s+wait|wait\s+no|wait|no|actually|sorry|oops)(?:\s*,)?\s+(?:i\s+meant\s+|i\s+mean\s+|make\s+it\s+|change\s+it\s+to\s+|it'?s\s+)?(?<value>[^,;!?]+?)[.!]?$/iu;
const NUMBER_TOKEN = /^(?:\$?\d[\d,]*(?:\.\d+)?|\.\d+)$/u;
const SPELLED = /^(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|thousand|half|quarter|third|all|max|everything)$/iu;

function editAmbiguous(what: string): PlatformError {
  return new PlatformError("INTENT_UNSUPPORTED", `Kletia could not tell which ${what} your correction changes. Send the corrected instruction on its own, for example "swap 3 SOL to USDC".`, 422,
    [{ path: "text", message: "The correction has more than one possible target." }], REFUSAL_EXAMPLES);
}

/**
 * A correction applies only when the message has exactly one slot of its type
 * (one amount, one network, one recipient); otherwise it is refused
 * (EDIT_TARGET_AMBIGUOUS in words). The corrected message is source C:
 * confirmed as the solved plan, with a "Read as" item naming the change.
 */
export function inMessageCorrection(text: string): { text: string; from: string; to: string; slot: string } | null {
  const match = IN_MESSAGE_CORRECTION.exec(text.trim());
  if (!match?.groups) return null;
  const message = (match.groups.message as string).trim();
  const value = (match.groups.value as string).trim();
  const words = message.split(/\s+/u);
  const clean = (word: string) => word.replace(/[,;.!]+$/u, "");
  const parts = value.split(/\s+/u);
  // An amount, optionally with its token: "3 sol", "0.5".
  if (NUMBER_TOKEN.test(parts[0] ?? "") && parts.length <= 2) {
    const at = words.flatMap((word, index) => (NUMBER_TOKEN.test(clean(word)) ? [index] : []));
    if (at.length !== 1 || words.some((word) => SPELLED.test(clean(word)))) throw editAmbiguous("amount");
    const index = at[0] as number;
    const symbol = parts[1];
    if (symbol && clean(words[index + 1] ?? "").toLowerCase() !== symbol.toLowerCase()) throw editAmbiguous("amount");
    const from = clean(words[index] as string);
    const next = [...words];
    next[index] = parts[0] as string;
    return { text: next.join(" "), from, to: parts[0] as string, slot: "amount" };
  }
  // A network: "arbitrum", "on arbitrum".
  const named = value.replace(/^(?:on|in)\s+/iu, "");
  const network = /^[a-z][a-z -]*$/iu.test(named) ? resolveNetworkName(named) : null;
  if (network && !Object.hasOwn(ASSET_NETWORK_WORDS, value.toLowerCase())) {
    const at = words.flatMap((word, index) => (/^[a-z][a-z-]*$/iu.test(clean(word)) && resolveNetworkName(clean(word)) && !Object.hasOwn(ASSET_NETWORK_WORDS, clean(word).toLowerCase()) ? [index] : []));
    if (at.length !== 1) throw editAmbiguous("network");
    const index = at[0] as number;
    const next = [...words];
    next[index] = value.replace(/^(?:on|in)\s+/iu, "");
    return { text: next.join(" "), from: clean(words[index] as string), to: next[index] as string, slot: "network" };
  }
  // A recipient: "bob.eth", "to bob.eth".
  const recipient = value.replace(/^to\s+/iu, "");
  if (new RegExp(`^${ADDR}$`, "iu").test(recipient)) {
    const at = words.flatMap((word, index) => (new RegExp(`^${ADDR}$`, "iu").test(clean(word)) ? [index] : []));
    if (at.length !== 1) throw editAmbiguous("recipient");
    const index = at[0] as number;
    const next = [...words];
    next[index] = recipient;
    return { text: next.join(" "), from: clean(words[index] as string), to: recipient, slot: "recipient" };
  }
  return null;
}

/* ----------------------------------------------- several recipients */

const RECIPIENT = "(?:[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:eth|sns|sol)|0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})";
/** "send 10 usdc each to alice.eth and bob.eth [on base]", "send 10 usdc to alice.eth and bob.eth each [on base]". */
const EACH = new RegExp(
  `^(?<verb>send|pay|transfer|give|tip)\\s+(?<amount>\\S+\\s+[a-z][a-z0-9.]{0,15})\\s+(?:each\\s+to\\s+(?<a>${RECIPIENT})\\s+and\\s+(?<b>${RECIPIENT})|to\\s+(?<c>${RECIPIENT})\\s+and\\s+(?<d>${RECIPIENT})\\s+(?:each|apiece|a\\s+piece))(?<rest>\\s+(?:on|from)\\s+[a-z][a-z -]{1,24})?$`,
  "iu",
);
/** "send 10 usdc to alice.eth and bob.eth": one amount, two recipients, no "each". */
const TWO_RECIPIENTS = new RegExp(`(?:^|\\s)to\\s+${RECIPIENT}\\s+and\\s+${RECIPIENT}(?=\\s|$)`, "iu");

/**
 * "N <token> each to A and B" is one payment of N per recipient (stated);
 * without "each" it is refused, because N each and N shared are different
 * payments to other people (RECIPIENT_EACH in words).
 */
export function eachRecipients(text: string): string | null {
  const match = EACH.exec(text.trim());
  if (!match?.groups) {
    if (TWO_RECIPIENTS.test(text)) {
      throw new PlatformError("INTENT_UNSUPPORTED", "Kletia does not guess whether each recipient gets that amount or they share it. Say \"send 10 USDC each to alice.eth and bob.eth\", or give each recipient its own amount.", 422,
        [{ path: "text", message: "One amount for two recipients." }], REFUSAL_EXAMPLES);
    }
    return null;
  }
  const g = match.groups;
  const rest = g.rest ?? "";
  return `${g.verb} ${g.amount} to ${g.a ?? g.c}${rest} and ${g.amount} to ${g.b ?? g.d}${rest}`;
}
