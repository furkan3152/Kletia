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
const NUMBER_WORD = /^(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|hundred|thousand)$/iu;

/** Splits on "and" when what follows starts a new clause (a verb, an amount, an earn marker). */
function splitAnd(text: string): ClausePiece[] {
  const parts = text.split(/\s*,?\s+and\s+/iu);
  const out: ClausePiece[] = [];
  for (const [index, part] of parts.entries()) {
    const previous = parts[index - 1];
    const first = (part.split(/\s+/u)[0] ?? "").toLowerCase();
    const lastBefore = (previous?.split(/\s+/u).at(-1) ?? "").toLowerCase();
    const startsClause = VERB_WORDS.has(first) || NUMBER_START.test(part) || ["earn", "make", "put"].includes(first);
    // "one hundred and five": never a clause boundary.
    const inNumber = NUMBER_WORD.test(lastBefore) && NUMBER_WORD.test(first);
    if (index === 0 || !startsClause || inNumber) {
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

/** The pieces of one clause, in order (at most `max`; null when there are more). */
export function splitGoalClauses(clause: string, max: number): ClausePiece[] | null {
  const pieces: ClausePiece[] = [];
  const sequence = clause.split(SEQUENCE).map((part) => part.trim()).filter((part) => part.length > 0);
  for (const [index, part] of sequence.entries()) {
    const split = splitAnd(part.replace(/^(?:first|firstly|and)\s+/iu, ""));
    split.forEach((piece, position) => pieces.push(position === 0 && index > 0 ? { text: piece.text, joinedBy: "then" } : piece));
  }
  return pieces.length > max ? null : pieces;
}
