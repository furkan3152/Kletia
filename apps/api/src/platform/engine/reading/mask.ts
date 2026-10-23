/**
 * Model-assisted reading (design A.7.1, A.7.2): the deterministic pre-filter
 * and the allowlist masking of one unread clause.
 *
 * - `prefilter`: refuses (no provider call) a clause whose closed-class
 *   record holds anything, a look-alike symbol, a question, a raw address or
 *   name, a reference to an earlier step, a vague or reworded amount, more
 *   than one goal, or an egress pattern ("@", "://", "www.", phone-like).
 * - `maskClause`: the clause as a numbered token list built from Kletia's own
 *   lexer. A word leaves the server only when it is Kletia vocabulary
 *   (verbs, connectors, networks, venues, listed symbols, reviewed fillers)
 *   or a reviewed egress word; every amount becomes `<amount_N>`, every other
 *   word `<word_N>`. More than 3 `<word_N>` refuses egress.
 *
 * The masked list is the only text a provider ever sees; the lexer tokens stay
 * on the server and every value of a reading is taken from them (gates.ts).
 */
import { createHash } from "node:crypto";
import type { UnreadClause } from "../clarify/types.js";
import { lex, normalizeClause, type Token } from "../goal/lexer.js";
import { EGRESS_WORDS, READING_FILLERS } from "./egressWords.js";

/** At most this many tokens per clause are sent. */
export const MAX_MASKED_TOKENS = 24;
/** At most this many `<word_N>` placeholders before egress is refused. */
export const MAX_UNKNOWN_WORDS = 3;

export type PrefilterCode =
  | "closed_class"
  | "lookalike"
  | "question"
  | "egress_pattern"
  | "recipient"
  | "reference"
  | "amount_form"
  | "segments"
  | "no_verb"
  | "unsupported_token"
  | "too_long"
  | "unknown_words";

export interface MaskedToken {
  /** Position in the numbered list. */
  readonly i: number;
  /** What is sent for it. */
  readonly sent: string;
  /** Kletia's lexer token (never sent). */
  readonly token: Token;
}

export interface MaskedClause {
  readonly tokens: readonly MaskedToken[];
  /** "0:swap 1:<amount_1> 2:usdc ..." */
  readonly text: string;
  /** sha256 of `text` (cache and consent binding). */
  readonly hash: string;
}

export type MaskOutcome = { readonly ok: true; readonly masked: MaskedClause } | { readonly ok: false; readonly code: PrefilterCode };

const EGRESS_PATTERN = /@|:\/\/|www\.|\+?\d[\d\s().-]{7,}\d/iu;
const SEGMENT_PATTERN = /[,;]|\b(?:and|then|after|before|also|plus)\b/iu;
const SAFE_WORD = /^[a-z][a-z']{0,23}$/u;

/** Words a token carries as typed (lexer `raw`, connector word, or the clause slice). */
function rawOf(token: Token, text: string): string {
  if ("raw" in token && typeof token.raw === "string") return token.raw;
  if (token.t === "CONN") return token.word;
  return text.slice(token.span[0], token.span[1]);
}

function refused(code: PrefilterCode): MaskOutcome {
  return { ok: false, code };
}

/** The pre-filter and the masking in one pass (the pre-filter first: nothing is built for a refused clause). */
export function maskClause(clause: UnreadClause): MaskOutcome {
  const record = clause.closedClass;
  if (record.hits.length > 0) return refused("closed_class");
  if (record.lookalikes.length > 0) return refused("lookalike");
  if (record.questionMark || record.opener || /\?/u.test(clause.text)) return refused("question");
  if (EGRESS_PATTERN.test(clause.text)) return refused("egress_pattern");
  if (SEGMENT_PATTERN.test(clause.text)) return refused("segments");
  const normalized = normalizeClause(clause.text);
  const tokens = lex(normalized);
  if (tokens.length === 0) return refused("no_verb");
  if (tokens.length > MAX_MASKED_TOKENS) return refused("too_long");
  const masked: MaskedToken[] = [];
  let amounts = 0;
  let unknown = 0;
  let verbs = 0;
  for (const token of tokens) {
    const raw = rawOf(token, normalized).toLowerCase();
    let sent: string;
    switch (token.t) {
      case "ADDRESS":
      case "NAME":
        return refused("recipient");
      case "HOLDER":
        if (token.holder !== "self") return refused("recipient");
        sent = raw;
        break;
      case "REF":
        return refused("reference");
      case "VAGUE":
      case "WEIGHTS":
        return refused("amount_form");
      case "AMOUNT":
        // A reworded, unit, grouped or derived amount keeps its deterministic rules: never offered to a model.
        if (token.rewritten || token.unit || token.rule || token.commentary || token.derived || /[,_]/u.test(token.raw)) return refused("amount_form");
        if (token.sel.t !== "exact" && token.sel.t !== "max" && token.sel.t !== "portion") return refused("amount_form");
        amounts += 1;
        sent = token.sel.t === "exact" ? `<amount_${amounts}>` : raw;
        break;
      case "ASSET":
        if (token.network) return refused("unsupported_token");
        sent = token.symbol.toLowerCase();
        break;
      case "ASSET?":
      case "CLASS":
        return refused("unsupported_token");
      case "NETWORK":
        if (token.generic) return refused("unsupported_token");
        sent = raw;
        break;
      case "VERB":
        verbs += 1;
        sent = raw;
        break;
      case "CONN":
        if (token.digit || token.rule) return refused("unsupported_token");
        sent = token.word;
        break;
      case "VENUE":
        if (token.venue.best) return refused("unsupported_token");
        sent = raw;
        break;
      case "NOISE":
        if (SAFE_WORD.test(raw) && (EGRESS_WORDS.has(raw) || READING_FILLERS.has(raw))) sent = raw;
        else {
          unknown += 1;
          sent = `<word_${unknown}>`;
        }
        break;
      default:
        // POSS, DET, WORK, POSITION, PREFER, WALLET: Kletia's own words.
        sent = raw;
    }
    if (!/^[a-z0-9<>_' .-]{1,32}$/u.test(sent)) return refused("unsupported_token");
    masked.push({ i: masked.length, sent, token });
  }
  if (verbs === 0) return refused("no_verb");
  if (unknown > MAX_UNKNOWN_WORDS) return refused("unknown_words");
  const text = masked.map((entry) => `${entry.i}:${entry.sent}`).join(" ");
  return { ok: true, masked: { tokens: masked, text, hash: `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}` } };
}
