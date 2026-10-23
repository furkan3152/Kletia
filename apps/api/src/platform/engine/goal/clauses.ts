/**
 * The Goal reader's clause splitter. The strict grammar splits only where
 * a verb follows "and" or a comma; this splitter runs on the clarify path
 * only, on a clause the strict reader could not read, and also splits:
 *
 * - sequence words: "after that", "afterwards", "and then", "then", ";", ". ";
 * - ellipsis: "and" followed by an amount or an asset with no verb
 *   ("send 5 USDC to A and 5 USDC to B"): the piece inherits the verb;
 * - "and" followed by an earn marker ("... and earn yield").
 *
 * It never splits inside a number ("one hundred and five") or an address.
 */
import { VERB_LEXICON } from "./lexicon.js";

export interface ClausePiece {
  readonly text: string;
  /** How the piece joins the one before: "and" pieces without a verb inherit it (F7). */
  readonly joinedBy: "start" | "and" | "then";
}

const SEQUENCE = /\s*(?:;|\.\s+|,?\s+(?:and\s+)?(?:after\s+that|afterwards|after\s+which|and\s+then|then)\s+)\s*/iu;
const VERB_WORDS = new Set(Object.keys(VERB_LEXICON).map((phrase) => phrase.split(" ")[0] as string));
/** An amount starting a piece ("5 USDC to B", "$5", ".5", "half"); never an address ("0x...", base58). */
const NUMBER_START = /^(?:\$?(?:\d[\d,]*(?:\.\d+)?|\.\d+)(?:k|%)?(?:\s|$)|half\b|all\b|a\s+(?:third|quarter|half)\b|everything\b|max\b)/iu;
/** A typed or spelled amount ("1", "1.5", "one"): what "and a half" may follow. */
const AMOUNT_WORD = /^(?:\$?\d[\d,]*(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred)$/iu;
/** A name or an address where a recipient goes ("vitalik.eth", "toly.sns", "0x...", a base58 key). */
const RECIPIENT_WORD = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:eth|sns|sol)|0x[0-9a-f]{40}|[1-9a-hj-np-z]{32,44})$/iu;
const NUMBER_WORD = /^(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|hundred|thousand)$/iu;

/** Splits on "and" when what follows starts a new clause (a verb, an amount, an earn marker). */
function splitAnd(text: string): ClausePiece[] {
  const parts = text.split(/\s*,?\s+and\s+/iu);
  const out: ClausePiece[] = [];
  for (const [index, part] of parts.entries()) {
    const previous = parts[index - 1];
    const first = (part.split(/\s+/u)[0] ?? "").toLowerCase();
    const lastBefore = (previous?.split(/\s+/u).at(-1) ?? "").toLowerCase();
    // "pay toly.sns 0.1 sol and vitalik.eth 1 usdc": a recipient followed by its own amount starts the next payment.
    const payee = RECIPIENT_WORD.test(first) && NUMBER_START.test(part.split(/\s+/u).slice(1).join(" "));
    const same = /^the\s+same(?:\s+amount)?\s+to\s/iu.test(part);
    const startsClause = VERB_WORDS.has(first) || NUMBER_START.test(part) || ["earn", "make", "put"].includes(first) || payee || same;
    // "one hundred and five": never a clause boundary.
    const inNumber = NUMBER_WORD.test(lastBefore) && NUMBER_WORD.test(first);
    // "1 and a half sol", "1 sol and a half": the amount's own half (the lexer reads it, or refuses it), never a new clause.
    const words = previous?.split(/\s+/u) ?? [];
    const half = /^a\s+half\b/iu.test(part) && words.slice(-2).some((word) => AMOUNT_WORD.test(word));
    if (index === 0 || !startsClause || inNumber || half) {
      if (index === 0 || out.length === 0) out.push({ text: part, joinedBy: "start" });
      else {
        const last = out.pop() as ClausePiece;
        out.push({ text: `${last.text} and ${part}`, joinedBy: last.joinedBy });
      }
      continue;
    }
    out.push({ text: part, joinedBy: "and" });
  }
  return out;
}

/**
 * ", put 10 of it in kamino": a comma followed by a goal verb starts the next step. A funding phrase
 * (", pay with ...", ", using ...") is never a new step: it belongs to the clause before it.
 */
function splitCommas(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/\s*,\s+/u)) {
    const words = part.split(/\s+/u).map((word) => word.toLowerCase());
    const first = words[0] ?? "";
    const funding = first === "pay" && (words[1] === "with" || words[1] === "using");
    // ", 4 usdc to jesse.base.eth": an amount after a comma is the next piece of a list (it inherits the verb).
    const listed = /^(?:\$?\d|\.\d)/u.test(part) && NUMBER_START.test(part);
    if (out.length > 0 && ((!VERB_WORDS.has(first) && !listed) || funding)) out[out.length - 1] = `${out[out.length - 1]}, ${part}`;
    else out.push(part);
  }
  return out;
}

/** The pieces of one clause, in order (at most `max`; null when there are more). */
export function splitGoalClauses(clause: string, max: number): ClausePiece[] | null {
  const pieces: ClausePiece[] = [];
  // Sequence words split into ordered steps ("then"); a comma before a verb or an amount splits a list ("and").
  const sequence = clause.split(SEQUENCE).map((part) => part.trim()).filter((part) => part.length > 0)
    .flatMap((part, at) => splitCommas(part).map((piece, position) => ({ text: piece.trim(), joined: position > 0 ? ("and" as const) : at > 0 ? ("then" as const) : ("start" as const) })))
    .filter((part) => part.text.length > 0);
  for (const [index, part] of sequence.entries()) {
    // A clause that opens with a sequence word ("after that swap it", after a split on "then") is the next step.
    const sequenced = index === 0 && /^(?:and\s+)?(?:after\s+that|afterwards)\s+/iu.test(part.text);
    const split = splitAnd(part.text.replace(/^(?:(?:and\s+)?(?:after\s+that|afterwards)|first|firstly|and)\s+/iu, ""));
    if (sequenced) {
      split.forEach((piece, position) => pieces.push(position === 0 ? { text: piece.text, joinedBy: "then" } : piece));
      continue;
    }
    split.forEach((piece, position) => pieces.push(position === 0 && index > 0 ? { text: piece.text, joinedBy: part.joined === "and" ? "and" : "then" } : piece));
  }
  return pieces.length > max ? null : pieces;
}
