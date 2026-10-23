/**
 * The reader's L0 pass over each clause (intent design A.2 L0 and L3 tier 1,
 * invariant I12): what a clause says that the reader may never drop,
 * correct, ignore or send to a model without a named rule consuming it.
 *
 * - `openerOf`: a question ("should i ...") or a polite command opener
 *   ("can you ...") at the start of a message, read before the normaliser
 *   strips "can you".
 * - `clauseRecord`: the closed-class record of one clause (never-drop words,
 *   unit words after a number, unsupported networks and lane qualifiers,
 *   look-alike symbols), with spans, from the shared word lists.
 * - `unsupportedNetwork`: NETWORK_UNSUPPORTED naming the phrase ("Kletia does
 *   not run on Arbitrum Nova.").
 * - `dropFillers`: the reviewed fillers dropped (listed in the "Ignored"
 *   chip), with the exceptions that keep one (next to an amount, right after
 *   a network word, before an asset, inside a longer phrase); connector and
 *   filler spellings that are lexicon entries ("w/", "in2", "thru", "frm").
 * - `unconsumed` / `closedClassError`: after a clause is read, every
 *   closed-class word must have been consumed by a rule the reader applied,
 *   else the clause is refused with its family's message.
 *
 * Words only; nothing here reads the network or the wallet.
 */
import {
  ASSETS,
  CLAUSE_FINAL_POLITENESS,
  CLOSED_CLASS_REFUSAL_OF,
  CLOSED_CLASS_RULES,
  lookalikeFamilyOf,
  POLITE_OPENERS,
  QUESTION_OPENERS,
  REVIEWED_FILLERS,
  scanClosedClass,
  UNSUPPORTED_NETWORKS,
  type ClosedClassHit,
  type FillerEntry,
} from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { closedClassRefusal } from "../clarify/copy.js";
import { knownSymbol } from "../clarify/catalog.js";
import type { ClosedClassRecord } from "../clarify/types.js";
import { ASSET_NETWORK_WORDS, isGrammarVenueWord, resolveNetworkName } from "../grammar.js";

/* ------------------------------------------------------------ openers */

/** Greetings and fillers a message may start with before its opener ("hey can you ..."). */
const GREETING = /^(?:(?:hey\s+kletia|hey|hi|hello|yo|ok\s+so|okay\s+so|ok|okay|so|gm|um|uh|kletia)[\s,!.]+)+/u;
const byLength = (list: readonly string[]) => [...list].sort((a, b) => b.length - a.length);
const POLITE = byLength(POLITE_OPENERS);
const QUESTION = byLength(QUESTION_OPENERS);
const startsWithPhrase = (text: string, phrase: string) => text === phrase || text.startsWith(`${phrase} `) || text.startsWith(`${phrase},`);

export interface Opener {
  readonly kind: "question" | "polite";
  readonly phrase: string;
}

/**
 * The opener of a message as typed (design A.2 questions vs commands): a
 * polite command ("can you swap ...", "could you please ...") or a question
 * ("should i ...", "what is ...", "is it ..."). Read before normalisation
 * strips "can you". Null for an ordinary command.
 */
export function openerOf(text: string): Opener | null {
  const value = text.toLowerCase().replace(/\s+/gu, " ").trim().replace(GREETING, "");
  const polite = POLITE.find((phrase) => startsWithPhrase(value, phrase));
  if (polite) return { kind: "polite", phrase: polite };
  const question = QUESTION.find((phrase) => startsWithPhrase(value, phrase));
  return question ? { kind: "question", phrase: question } : null;
}

/* ------------------------------------------------------------- record */

const LISTED: ReadonlySet<string> = new Set(ASSETS.map((asset) => asset.symbol.toUpperCase()));

/**
 * A scanned hit that is part of a name or an address ("ink.eth", "nova.sol",
 * "blast-fund.eth"): never a network or a closed-class word.
 */
function insideName(text: string, hit: ClosedClassHit): boolean {
  const before = text[hit.start - 1] ?? " ";
  const after = text.slice(hit.end, hit.end + 2);
  return /[.\-_]/u.test(before) || /^[.\-_][a-z0-9]/u.test(after);
}

/** "i'd like 5 USDC", "i would like 2 SOL": a verb phrase, not the approximation "like 50". */
function likeVerb(text: string, hit: ClosedClassHit): boolean {
  return hit.phrase === "like" && /\b(?:i'?d|id|i\s+would|would|we'?d|i)\s+$/u.test(text.slice(0, hit.start));
}

/**
 * The closed-class record of one clause (design A.2 L0): every never-drop,
 * unit and network phrase with its span in the clause, the message's opener
 * (first clause only) and typed symbols of a look-alike family that are not
 * exactly a listed symbol ("steth", "wsol", "usdc.e").
 */
export function clauseRecord(clause: string, opener?: Opener | null): ClosedClassRecord {
  const lower = clause.toLowerCase();
  const hits = scanClosedClass(lower).filter((hit) => !insideName(lower, hit) && !likeVerb(lower, hit));
  const lookalikes: { typed: string; family: string; start: number; end: number }[] = [];
  for (const match of lower.matchAll(/[a-z0-9][a-z0-9.\-]*[a-z0-9]|[a-z]/gu)) {
    const typed = match[0];
    const family = lookalikeFamilyOf(typed);
    if (!family || LISTED.has(typed.toUpperCase())) continue;
    const start = match.index ?? 0;
    lookalikes.push({ typed: clause.slice(start, start + typed.length).slice(0, 16), family: family.id, start, end: start + typed.length });
  }
  return { questionMark: false, ...(opener ? { opener } : {}), hits, lookalikes };
}

/* ------------------------------------------------------------ networks */

const NETWORK_TITLES: Readonly<Record<string, string>> = Object.freeze({
  base: "Base", arbitrum: "Arbitrum", arb: "Arbitrum", ethereum: "Ethereum", eth: "Ethereum", optimism: "Optimism", op: "OP",
  polygon: "Polygon", solana: "Solana", sol: "Solana", arc: "Arc", bnb: "BNB", avalanche: "Avalanche", linea: "Linea", scroll: "Scroll",
  blast: "Blast", zksync: "zkSync",
});
const title = (word: string) => NETWORK_TITLES[word] ?? `${word.charAt(0).toUpperCase()}${word.slice(1)}`;

/** The networks Kletia runs on, for the refusal. */
export const SUPPORTED_NETWORKS_TEXT =
  "It runs on Base, Arbitrum One, Ethereum, OP Mainnet, Polygon PoS and Solana; test networks: Arc Testnet, Arbitrum Sepolia and Solana Devnet.";

/** How a refusal names an unsupported network or qualified network ("Arbitrum Nova", "Base Sepolia", "Solana Testnet"). */
function networkName(phrase: string): string {
  const listed = UNSUPPORTED_NETWORKS[phrase];
  if (listed) return listed.name;
  return phrase.split(" ").map(title).join(" ");
}

/**
 * NETWORK_UNSUPPORTED for the first unsupported network or lane qualifier
 * of a clause ("arbitrum nova", "base sepolia", "solana testnet", "arc
 * mainnet"), or null. A word right after a network word is never dropped,
 * so a qualifier is never read away (red-team A8).
 */
export function unsupportedNetwork(record: ClosedClassRecord, path = "text"): PlatformError | null {
  const hit = record.hits.find((entry) => entry.category === "network");
  if (!hit) return null;
  const name = networkName(hit.phrase);
  return new PlatformError(
    "NETWORK_UNSUPPORTED",
    `Kletia does not run on ${name}. ${SUPPORTED_NETWORKS_TEXT}`,
    422,
    [{ path, message: "Not a network Kletia runs on." }],
    undefined,
    { network: name },
  );
}

/* ------------------------------------------------------------- fillers */

/** A word that names a network (or a network-or-asset word: "sol", "op"), for the after-network rule. */
export function isNetworkWord(word: string): boolean {
  const lower = word.toLowerCase();
  return resolveNetworkName(lower) !== null || Object.hasOwn(ASSET_NETWORK_WORDS, lower) ||
    ["mainnet", "devnet", "testnet", "sepolia", "l1", "mainnet-beta", "one", "pos"].includes(lower);
}

const NUMBER_LIKE = /^(?:\$?\d|\.\d|~\d)/u;
const NUMBER_WORDS = new Set(["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "twenty", "fifty", "hundred", "thousand", "half", "quarter"]);
const isAmountWord = (word: string | undefined) => word !== undefined && (NUMBER_LIKE.test(word) || NUMBER_WORDS.has(word.toLowerCase()));

/** Reviewed fillers by their words, longest first. */
const FILLERS: readonly (FillerEntry & { readonly words: readonly string[] })[] = [...REVIEWED_FILLERS]
  .map((entry) => ({ ...entry, words: entry.phrase.split(" ") }))
  .sort((a, b) => b.words.length - a.words.length || b.phrase.length - a.phrase.length);
const POLITENESS: ReadonlySet<string> = new Set([...CLAUSE_FINAL_POLITENESS, "thank you", "thanks a lot", "thx in advance", "thanks in advance"]);
/** Words that make "u" part of a longer phrase ("can u"). */
const U_PHRASE = new Set(["can", "could", "would", "will"]);
/** Words that make "like" a verb ("i'd like"). */
const LIKE_VERB = new Set(["id", "i'd", "i", "would", "we'd", "wed"]);

/**
 * Connector and filler spellings that are reviewed lexicon entries, not
 * corrections (design A.2 L2): they name no token, amount, network or venue.
 */
const SPELLINGS: Readonly<Record<string, string>> = Object.freeze({ in2: "into", thru: "through", frm: "from", "4rm": "from", "w/": "with" });

/** Single words a stretched spelling may stand for ("pleaseeee", "sooo", "thxxx"). */
const STRETCHABLE: ReadonlySet<string> = new Set([
  ...FILLERS.filter((entry) => entry.words.length === 1).map((entry) => entry.phrase),
  "so", "ok", "hey", "hi", "yo", "thanks", "pls", "plz", "please",
]);

/** "pleaseeee" -> "please", "sooo" -> "so": only into a reviewed filler or greeting, never into another word. */
export function unstretch(word: string): string {
  const lower = word.toLowerCase();
  if (!/([a-z])\1\1/u.test(lower)) return word;
  for (const keep of [1, 2]) {
    const candidate = lower.replace(/([a-z])\1{2,}/gu, (_run, letter: string) => letter.repeat(keep));
    if (STRETCHABLE.has(candidate)) return candidate;
  }
  return word;
}

export interface FillerPass {
  /** The clause without the dropped fillers, with lexicon spellings read ("w/" -> "with"). */
  readonly text: string;
  /** The fillers dropped, as listed, for the non-material "Ignored" chip. */
  readonly ignored: readonly string[];
  /** Politeness dropped (shown nowhere: it never carries meaning and was always dropped silently). */
  readonly polite: readonly string[];
}

/**
 * Drops the reviewed fillers of one clause (design A.2 L3 tier 1, I12). A
 * filler is kept (and the clause is then not read) when it sits next to an
 * amount ("like 50", "some 50"), right after a network word ("on base lol"),
 * before an asset ("w usdc" means with), inside a longer phrase ("can u",
 * "i'd like"), or before a correction ("actually 3"). Clause-final
 * politeness is dropped anywhere at the end. "w/" and "w" before a venue or
 * an asset read as "with"; "in2", "thru", "frm" as their connectors.
 */
export function dropFillers(clause: string): FillerPass {
  // Commas and "!" are pauses: their own words here, so "gm!" and "usdc, thx" read as words.
  let words = clause.replace(/(?<!\d),(?!\d)|!/gu, " , ").split(" ").filter((word) => word.length > 0).map(unstretch);
  const trimPauses = () => {
    while (words[0] === ",") words.shift();
    while (words[words.length - 1] === ",") words.pop();
  };
  trimPauses();
  // Lexicon spellings first: they are connectors, not fillers.
  words = words.flatMap((word) => {
    const lower = word.toLowerCase();
    const glued = /^w\/(\S+)$/iu.exec(word);
    if (glued) return ["with", glued[1] as string];
    const spelled = SPELLINGS[lower];
    return spelled ? [spelled] : [word];
  });
  words = words.map((word, index) => {
    if (word.toLowerCase() !== "w") return word;
    const next = words[index + 1];
    return next !== undefined && (knownSymbol(next) || isGrammarVenueWord(next.toLowerCase())) ? "with" : word;
  });
  const ignored: string[] = [];
  const polite: string[] = [];
  const lowerAt = (index: number) => (words[index] ?? "").toLowerCase();

  /** Whether the filler at [start, end) may be dropped where it is. */
  const droppable = (entry: (typeof FILLERS)[number], start: number, end: number): boolean => {
    const before = start > 0 ? words[start - 1] : undefined;
    const after = words[end];
    const atEnd = end === words.length;
    const finalPolite = atEnd && POLITENESS.has(entry.phrase);
    if (!finalPolite) {
      if (isAmountWord(before) || isAmountWord(after)) return false;
      if (before !== undefined && isNetworkWord(before)) return false;
    }
    if (entry.phrase === "w" && after !== undefined && knownSymbol(after)) return false;
    if (entry.phrase === "u" && before !== undefined && U_PHRASE.has(before.toLowerCase())) return false;
    if (entry.phrase === "like" && before !== undefined && LIKE_VERB.has(before.toLowerCase())) return false;
    if (entry.phrase === "actually" && (isAmountWord(after) || /^(?:make|i|sorry)$/iu.test(after ?? ""))) return false;
    return true;
  };

  const record = (entry: (typeof FILLERS)[number]) => (POLITENESS.has(entry.phrase) ? polite : ignored).push(entry.phrase);
  const matchAt = (entry: (typeof FILLERS)[number], start: number) =>
    start + entry.words.length <= words.length && entry.words.every((word, offset) => lowerAt(start + offset) === word);

  for (let guard = 0; guard < 16; guard += 1) {
    let changed = false;
    // Clause start.
    for (const entry of FILLERS) {
      if (entry.position === "end" || !matchAt(entry, 0) || !droppable(entry, 0, entry.words.length)) continue;
      // A clause of fillers only keeps its last word for the caller to see.
      words = words.slice(entry.words.length);
      trimPauses();
      record(entry);
      changed = true;
      break;
    }
    // Clause end.
    for (const entry of FILLERS) {
      const start = words.length - entry.words.length;
      if (entry.position === "start" || start < 0 || !matchAt(entry, start) || !droppable(entry, start, words.length)) continue;
      words = words.slice(0, start);
      trimPauses();
      record(entry);
      changed = true;
      break;
    }
    if (!changed) break;
  }
  // Anywhere else.
  for (let index = 0; index < words.length; index += 1) {
    const entry = FILLERS.find((candidate) => candidate.position === "any" && matchAt(candidate, index) && droppable(candidate, index, index + candidate.words.length));
    if (!entry) continue;
    words.splice(index, entry.words.length);
    record(entry);
    index -= 1;
  }
  trimPauses();
  const tidy = words.join(" ").replace(/(?:\s*,)+/gu, ",").replace(/(?<!\d),(?=\S)|,(?=\D)(?=\S)/gu, ", ").trim();
  return { text: tidy, ignored, polite };
}

/* --------------------------------------------------------- consumption */

/** True when the hit lies inside a match of the rule's context pattern (rules without one: anywhere). */
function covered(ruleId: string, text: string, hit: ClosedClassHit): boolean {
  const rule = CLOSED_CLASS_RULES[ruleId];
  if (!rule) return false;
  if (!rule.context) return true;
  const pattern = new RegExp(rule.context.source, "giu");
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start <= hit.start && start + match[0].length >= hit.end) return true;
  }
  return false;
}

/** "over relay", "over across": a connector spelling of "via" before a bridge word (consumed with "over to"). */
const OVER_BRIDGE = /\bover\s+(?:li\.?fi|debridge|dln|relay|across|cctp)\b/u;

/**
 * Whether a rule the reader applied consumes this hit: the rule is one the
 * hit names, and its context covers the hit. Network hits are never
 * consumed here (they refuse first).
 */
export function consumes(applied: ReadonlySet<string>, text: string, hit: ClosedClassHit): boolean {
  if (hit.category === "network") return false;
  const lower = text.toLowerCase();
  return hit.rules.some((id) => {
    if (!applied.has(id) || id.startsWith("refuse:")) return false;
    if (id === "connector:over" && OVER_BRIDGE.test(lower.slice(hit.start))) return true;
    return covered(id, lower, hit);
  });
}

/** The first closed-class hit no applied rule consumed, or null. */
export function unconsumed(record: ClosedClassRecord, text: string, applied: ReadonlySet<string>): ClosedClassHit | null {
  return record.hits.find((hit) => hit.category !== "network" && !consumes(applied, text, hit)) ?? null;
}

/** Whether a rule this reader implements could consume the hit in this text (for the refusal of a clause it could not read). */
export function consumable(text: string, hit: ClosedClassHit): boolean {
  return consumes(new Set(READER_RULES), text, hit);
}

/** The closed-class rules this reader applies (others are refused until their package reads them). */
export const READER_RULES: readonly string[] = Object.freeze([
  "order:then", "connector:over", "allBut:except", "amountVague:approx", "amountVague:or",
  "unit:thousand", "unit:million", "unit:billion", "unit:cents", "unit:sats", "unit:gwei", "unit:wei", "unit:lamports", "unit:bps",
]);

/** The refusal of an unconsumed closed-class word: its family's message (Kletia's words; the text is never echoed). */
export function closedClassError(hit: ClosedClassHit): PlatformError {
  if (hit.category === "network") return closedClassRefusal("limit");
  return closedClassRefusal(hit.category === "unit" ? "unit" : CLOSED_CLASS_REFUSAL_OF[hit.category]);
}

/** A refusal for a word with letters outside the Latin script (a homoglyph risk). */
export function nonLatinRefusal(): PlatformError {
  return new PlatformError(
    "INTENT_UNSUPPORTED",
    "Kletia reads plain Latin letters only: a word in this message has letters from another alphabet that can look like Latin ones. Retype it, for example \"swap 1 ETH to USDC on Base\".",
    422,
    [{ path: "text", message: "Letters outside the Latin alphabet." }],
  );
}
