/**
 * The Goal reader's normaliser and lexer.
 *
 * `normalizeClause` extends the grammar's normalisation (it never replaces
 * it): fillers and politeness at either end, arrows ("->", "=>", ">", "→"),
 * stray punctuation and glued forms ("swap1", "1SOL"). `lex` then turns the
 * clause into typed tokens, each with its span in the normalised text, so a
 * correction or a placeholder can point at exactly what was typed.
 *
 * Nothing here reads the network. Unknown words become NOISE tokens; the
 * frames refuse a clause that has any (fail closed).
 */
import { ASSETS, type AmountSel, type AssetClass, type NetworkKey } from "@kletia/core";
import { GRAMMAR_VENUE_WORDS, NAME, resolveNetworkName } from "../grammar.js";
import { bridgeProtocol, dexProtocol, isUsdWord, knownSymbol, lendingProtocol, providerFromWord } from "../clarify/catalog.js";
import { distance } from "../clarify/fuzzy.js";
import { numberWordsValue, readNumber, readPercent } from "./amounts.js";
import {
  ALL_BUT_PHRASES,
  BEST_VENUE_PHRASES,
  CLASS_WORDS,
  CONNECTOR_VARIANTS,
  CONNECTORS,
  FILLER_WORDS,
  HOLDER_WORDS,
  LEADING_FILLERS,
  MAX_PHRASES,
  NETWORK_ALIASES,
  NUMBER_SCALES,
  NUMBER_TENS,
  NUMBER_UNITS,
  PORTION_WORDS,
  PREFERENCE_PHRASES,
  REFERENCE_WORDS,
  TOKEN_UNIT_FRACTIONS,
  TRAILING_FILLERS,
  USD_UNITS,
  VERB_LEXICON,
  VERB_PHRASES,
  WORK_PHRASES,
  type VerbEntry,
} from "./lexicon.js";

export type Span = readonly [start: number, end: number];

/** Venue readings of one word: a word may name a lending venue, a staking provider, a DEX and a bridge at once ("jupiter"). */
export interface VenueReading {
  readonly lending?: string;
  readonly provider?: string;
  readonly dex?: string;
  readonly bridge?: string;
  /** "the best yield", "safe": the solver picks the venue. */
  readonly best?: true;
}

export type Token =
  /** `readAs`: how a rewritten amount reads back in its chip ("half a sol" -> "0.5 SOL"). */
  | { readonly t: "AMOUNT"; readonly sel: AmountSel; readonly raw: string; readonly rewritten?: true; readonly readAs?: string; readonly span: Span }
  | { readonly t: "ASSET"; readonly symbol: string; readonly raw: string; readonly network?: NetworkKey; readonly venue?: VenueReading; readonly span: Span }
  /** An unknown symbol within one edit of listed symbols ("SLO"): ASSET_TYPO. */
  | { readonly t: "ASSET?"; readonly raw: string; readonly candidates: readonly string[]; readonly span: Span }
  | { readonly t: "CLASS"; readonly cls: AssetClass; readonly raw: string; readonly span: Span }
  | { readonly t: "NETWORK"; readonly network: NetworkKey; readonly raw: string; readonly span: Span }
  | { readonly t: "VENUE"; readonly venue: VenueReading; readonly raw: string; readonly span: Span }
  | { readonly t: "ADDRESS"; readonly value: string; readonly span: Span }
  | { readonly t: "NAME"; readonly value: string; readonly span: Span }
  | { readonly t: "HOLDER"; readonly holder: "self" | "selfOther" | "nickname"; readonly raw: string; readonly span: Span }
  | { readonly t: "VERB"; readonly verb: VerbEntry; readonly raw: string; readonly span: Span }
  | { readonly t: "CONN"; readonly word: string; readonly span: Span }
  | { readonly t: "POSS"; readonly span: Span }
  /** "the", "a": meaningful only before an asset after a previous step ("bridge the USDC"). */
  | { readonly t: "DET"; readonly span: Span }
  | { readonly t: "REF"; readonly raw: string; readonly span: Span }
  | { readonly t: "WORK"; readonly span: Span }
  /** "position", "positions": the venue named is where the money sits now. */
  | { readonly t: "POSITION"; readonly span: Span }
  | { readonly t: "PREFER"; readonly prefer: "cheapest" | "fastest" | "safest"; readonly span: Span }
  /** "wallet", "account" after "my <network>": the person's own account on that network ("fund my arbitrum wallet"). */
  | { readonly t: "WALLET"; readonly span: Span }
  | { readonly t: "NOISE"; readonly raw: string; readonly span: Span };

/* -------------------------------------------------------- normaliser */

const byLength = (list: readonly string[]) => [...list].sort((a, b) => b.length - a.length);
const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/ /gu, "\\s+");
const LEADING = new RegExp(`^(?:${byLength(LEADING_FILLERS).map(escape).join("|")})(?:\\s+|$)`, "iu");
const TRAILING = new RegExp(`(?:^|\\s+)(?:${byLength(TRAILING_FILLERS).map(escape).join("|")})$`, "iu");
const ADDRESS_WORD = /^(?:0x[0-9a-fA-F]{40}|(?:eip155|solana):\S+|[1-9A-HJ-NP-Za-km-z]{32,44})$/u;
const NAME_WORD = new RegExp(`^${NAME}$`, "iu");

/**
 * The clause as the lexer reads it. Addresses, names and decimals are kept
 * byte for byte; only connective punctuation, arrows and fillers change.
 */
export function normalizeClause(clause: string): string {
  let text = clause
    .replace(/[→➡⇒]|->|=>|-->/gu, " to ")
    .replace(/(?<=\S)\s*>\s*(?=\S)|\s+>\s+/gu, " to ")
    .replace(/[“”"`]/gu, "")
    .replace(/[’']/gu, "")
    .replace(/[?!]+/gu, " ")
    .replace(/(?<!\d),|,(?!\d)/gu, " ")
    .replace(/[:;]+/gu, " ")
    .replace(/\.(?=\s|$)/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  text = text.split(" ").flatMap(unglue).join(" ");
  for (let guard = 0; guard < 8; guard += 1) {
    const before = text;
    text = text.replace(LEADING, "").replace(TRAILING, "").trim();
    if (text === before) break;
  }
  return text;
}

/** "swap1" -> "swap 1", "1SOL" -> "1 SOL", "50bucks" -> "50 bucks"; never inside addresses, names or known symbols ("1INCH"). */
function unglue(word: string): string[] {
  if (ADDRESS_WORD.test(word) || NAME_WORD.test(word) || knownSymbol(word)) return [word];
  const verbFirst = /^([a-z]+)(\d+(?:\.\d+)?)$/iu.exec(word);
  if (verbFirst && Object.hasOwn(VERB_LEXICON, (verbFirst[1] as string).toLowerCase())) return [verbFirst[1] as string, verbFirst[2] as string];
  const numberFirst = /^(\$?\d+(?:\.\d+)?)([a-z][a-z0-9]*)$/iu.exec(word);
  if (numberFirst) {
    const unit = numberFirst[2] as string;
    if (/^(?:k|e\d+)$/iu.test(unit)) return [word];
    if (knownSymbol(unit) || USD_UNITS.has(unit.toLowerCase()) || unit.toLowerCase() === "percent") return [numberFirst[1] as string, unit];
  }
  return [word];
}

/* ------------------------------------------------------------- lexer */

interface Phrase {
  readonly words: readonly string[];
  readonly make: (raw: string, span: Span) => Token | null;
}

const NETWORK_PHRASES: readonly string[] = [
  "arbitrum sepolia", "arb sepolia", "solana devnet", "solana mainnet", "arbitrum one", "arc testnet", "base mainnet", "ethereum mainnet", "op mainnet",
  "optimism mainnet", "polygon pos", "polygon mainnet", ...Object.keys(NETWORK_ALIASES),
];

function networkOf(raw: string): NetworkKey | null {
  const lower = raw.toLowerCase();
  const alias = NETWORK_ALIASES[lower];
  return (alias ? resolveNetworkName(alias) : null) ?? resolveNetworkName(lower);
}

function venueOf(raw: string): VenueReading | null {
  const lower = raw.toLowerCase();
  if (!GRAMMAR_VENUE_WORDS.includes(lower)) return null;
  const lending = lendingProtocol(lower) ?? undefined;
  const provider = providerFromWord(lower)?.id;
  const dex = dexProtocol(lower) ?? undefined;
  const bridge = bridgeProtocol(lower) ?? undefined;
  if (!lending && !provider && !dex && !bridge) return null;
  return { ...(lending ? { lending } : {}), ...(provider ? { provider } : {}), ...(dex ? { dex } : {}), ...(bridge ? { bridge } : {}) };
}

const LISTED: readonly string[] = [...new Set(ASSETS.map((asset) => asset.symbol))];

/** Listed symbols within one edit (a transposition counts as one) of an unknown token of 3+ letters. */
export function symbolTypoCandidates(raw: string): string[] {
  if (raw.length < 3 || !/^[a-z][a-z0-9]{2,11}$/iu.test(raw) || knownSymbol(raw)) return [];
  const upper = raw.toUpperCase();
  return LISTED.filter((symbol) => symbol.length >= 3 && distance(upper, symbol.toUpperCase()) === 1);
}

/** Multi-word phrases, longest first; each yields one token or null (not this reading). */
const PHRASES: readonly Phrase[] = (() => {
  const list: Phrase[] = [];
  const add = (phrase: string, make: Phrase["make"]) => list.push({ words: phrase.split(" "), make });
  for (const [phrase, holder] of Object.entries(HOLDER_WORDS)) if (phrase.includes(" ")) add(phrase, (raw, span) => ({ t: "HOLDER", holder, raw, span }));
  for (const [phrase, prefer] of Object.entries(PREFERENCE_PHRASES)) add(phrase, (_raw, span) => ({ t: "PREFER", prefer, span }));
  for (const phrase of BEST_VENUE_PHRASES) add(phrase, (raw, span) => ({ t: "VENUE", venue: { best: true }, raw, span }));
  for (const phrase of WORK_PHRASES) add(phrase, (_raw, span) => ({ t: "WORK", span }));
  for (const phrase of VERB_PHRASES) {
    const verb = VERB_LEXICON[phrase] as VerbEntry;
    add(phrase, (raw, span) => ({ t: "VERB", verb, raw, span }));
  }
  for (const phrase of GRAMMAR_VENUE_WORDS) {
    if (!phrase.includes(" ")) continue;
    add(phrase, (raw, span) => {
      const venue = venueOf(phrase);
      return venue ? { t: "VENUE", venue, raw, span } : null;
    });
  }
  for (const phrase of NETWORK_PHRASES) {
    add(phrase, (raw, span) => {
      const network = networkOf(phrase);
      return network ? { t: "NETWORK", network, raw, span } : null;
    });
  }
  for (const phrase of CONNECTORS) if (phrase.includes(" ")) add(phrase, (_raw, span) => ({ t: "CONN", word: phrase, span }));
  for (const [phrase, word] of Object.entries(CONNECTOR_VARIANTS)) add(phrase, (_raw, span) => ({ t: "CONN", word, span }));
  for (const phrase of REFERENCE_WORDS) add(phrase, (raw, span) => ({ t: "REF", raw, span }));
  for (const [phrase, bps] of Object.entries(PORTION_WORDS)) add(phrase, (raw, span) => ({ t: "AMOUNT", sel: { t: "portion", bps }, raw, span }));
  for (const phrase of MAX_PHRASES) add(phrase, (raw, span) => ({ t: "AMOUNT", sel: { t: "max" }, raw, span }));
  return list.sort((a, b) => b.words.length - a.words.length || b.words.join(" ").length - a.words.join(" ").length);
})();

/** PHRASES by their first word (longest first within each), so the lexer tries only the phrases that can start here. */
const PHRASES_BY_FIRST: ReadonlyMap<string, readonly Phrase[]> = (() => {
  const map = new Map<string, Phrase[]>();
  for (const phrase of PHRASES) {
    const first = phrase.words[0] as string;
    const list = map.get(first) ?? [];
    list.push(phrase);
    map.set(first, list);
  }
  return map;
})();

const PORTION_PHRASES: readonly (readonly string[])[] = Object.keys(PORTION_WORDS).map((phrase) => phrase.split(" ")).sort((a, b) => b.length - a.length);
const FRACTION_PHRASES: readonly (readonly string[])[] = Object.keys(TOKEN_UNIT_FRACTIONS).map((phrase) => phrase.split(" ")).sort((a, b) => b.length - a.length);
const UNIT_ARTICLES: ReadonlySet<string> = new Set(["a", "an"]);

/** The listed spelling of a symbol typed in any case ("jitosol" -> "JitoSOL"). */
function listedSpelling(raw: string): string {
  const upper = raw.toUpperCase();
  return LISTED.find((symbol) => symbol.toUpperCase() === upper) ?? upper;
}

/**
 * "half a sol", "half an eth", "a quarter of a sol", "three quarters of an
 * eth": a portion word, an optional "of", "a"/"an" and a token is that many
 * token units, never a share of the balance. The AMOUNT covers the words up to
 * the article; the token after it is read as usual. A fraction with no exact
 * decimal ("a third of a sol"), or a portion of "a dollar" / "a stablecoin", is
 * NOISE: the clause is not read rather than guessed. Null when the words are
 * not this shape ("half my sol", "half of it", "half the sol" stay portions).
 */
function tokenUnitFraction(cursor: Cursor, index: number): [Token, number] | null {
  const words = cursor.words;
  const lower = (at: number) => (words[at] ?? "").toLowerCase();
  const phrase = FRACTION_PHRASES.find((entry) => index + entry.length <= words.length && words.slice(index, index + entry.length).join(" ").toLowerCase() === entry.join(" "));
  if (!phrase) return null;
  let at = index + phrase.length;
  if (lower(at) === "of") at += 1;
  if (!UNIT_ARTICLES.has(lower(at))) return null;
  const unit = words[at + 1];
  if (unit === undefined) return null;
  const unitLower = unit.toLowerCase();
  const token = knownSymbol(unit) && !ADDRESS_WORD.test(unit);
  const money = isUsdWord(unitLower) || Object.hasOwn(CLASS_WORDS, unitLower) || USD_UNITS.has(unitLower);
  if (!token && !money) return null;
  const used = at + 1 - index;
  const span = spanOf(cursor, index, at + 1);
  const raw = words.slice(index, at + 2).join(" ").slice(0, 40);
  const value = TOKEN_UNIT_FRACTIONS[phrase.join(" ")];
  if (!token || value === null || value === undefined) return [{ t: "NOISE", raw, span }, used];
  return [{ t: "AMOUNT", sel: { t: "exact", value }, raw, rewritten: true, readAs: `${value} ${listedSpelling(unit)}`, span }, used];
}
const CONNECTOR_SET: ReadonlySet<string> = new Set(CONNECTORS.filter((word) => !word.includes(" ")));
const isNumberWord = (word: string) => Object.hasOwn(NUMBER_UNITS, word) || Object.hasOwn(NUMBER_TENS, word) || Object.hasOwn(NUMBER_SCALES, word);

interface Cursor {
  readonly words: readonly string[];
  readonly starts: readonly number[];
}

function spanOf(cursor: Cursor, from: number, to: number): Span {
  const start = cursor.starts[from] as number;
  const last = to - 1;
  return [start, (cursor.starts[last] as number) + (cursor.words[last] as string).length];
}

/** A number (with an optional "$" or dollar unit) at `index`: [token, words used], or null. */
function readAmountAt(cursor: Cursor, index: number): [Token, number] | null {
  const word = cursor.words[index] as string;
  const lower = word.toLowerCase();
  const next = (cursor.words[index + 1] ?? "").toLowerCase();
  const percent = readPercent(lower) ?? (next === "percent" || next === "pct" ? readPercent(`${lower}%`) : null);
  if (percent !== null) {
    const used = readPercent(lower) !== null ? 1 : 2;
    return [{ t: "AMOUNT", sel: { t: "portion", bps: percent }, raw: cursor.words.slice(index, index + used).join(" "), span: spanOf(cursor, index, index + used) }, used];
  }
  const dollar = lower.startsWith("$") || lower.endsWith("$");
  const number = readNumber(lower.replace(/^\$|\$$/gu, ""));
  if (number) {
    const unit = !dollar && USD_UNITS.has(next);
    const used = unit ? 2 : 1;
    const sel: AmountSel = dollar || unit ? { t: "usd", value: number.value } : { t: "exact", value: number.value };
    const raw = cursor.words.slice(index, index + used).join(" ");
    return [{ t: "AMOUNT", sel, raw: number.raw && !dollar && !unit ? number.raw : raw, ...(number.rewritten ? { rewritten: true as const } : {}), span: spanOf(cursor, index, index + used) }, used];
  }
  if (isNumberWord(lower) || (lower === "a" && Object.hasOwn(NUMBER_SCALES, next))) {
    let end = index + 1;
    while (end < cursor.words.length) {
      const following = (cursor.words[end] as string).toLowerCase();
      if (isNumberWord(following)) end += 1;
      else if (following === "and" && Object.hasOwn(NUMBER_SCALES, (cursor.words[end - 1] as string).toLowerCase()) && isNumberWord((cursor.words[end + 1] ?? "").toLowerCase())) end += 1;
      else break;
    }
    const value = numberWordsValue(cursor.words.slice(index, end).map((entry) => entry.toLowerCase()));
    if (value === null) return null;
    const unit = USD_UNITS.has((cursor.words[end] ?? "").toLowerCase());
    const used = end - index + (unit ? 1 : 0);
    return [{ t: "AMOUNT", sel: unit ? { t: "usd", value: String(value) } : { t: "exact", value: String(value) }, raw: cursor.words.slice(index, index + used).join(" "), span: spanOf(cursor, index, index + used) }, used];
  }
  return null;
}

function readWord(cursor: Cursor, index: number): Token | null {
  const raw = cursor.words[index] as string;
  const lower = raw.toLowerCase();
  const span = spanOf(cursor, index, index + 1);
  if (ADDRESS_WORD.test(raw) && !knownSymbol(raw)) return { t: "ADDRESS", value: raw, span };
  if (NAME_WORD.test(raw)) return { t: "NAME", value: lower, span };
  if (lower === "my" || lower === "our") return { t: "POSS", span };
  if (lower === "the" || lower === "a" || lower === "an") return { t: "DET", span };
  if (lower === "position" || lower === "positions") return { t: "POSITION", span };
  if (Object.hasOwn(HOLDER_WORDS, lower)) return { t: "HOLDER", holder: HOLDER_WORDS[lower] as "self" | "selfOther" | "nickname", raw, span };
  if (Object.hasOwn(VERB_LEXICON, lower)) return { t: "VERB", verb: VERB_LEXICON[lower] as VerbEntry, raw, span };
  if (CONNECTOR_SET.has(lower)) return { t: "CONN", word: lower, span };
  if (isUsdWord(lower) || Object.hasOwn(CLASS_WORDS, lower)) return { t: "CLASS", cls: CLASS_WORDS[lower] ?? "usd-stable", raw, span };
  const network = networkOf(lower);
  const venue = venueOf(lower);
  if (knownSymbol(raw) || /^(?:eip155|solana):\S+$/u.test(raw)) {
    return { t: "ASSET", symbol: raw, raw, ...(network ? { network } : {}), ...(venue ? { venue } : {}), span };
  }
  if (network) return { t: "NETWORK", network, raw, span };
  if (venue) return { t: "VENUE", venue, raw, span };
  if (FILLER_WORDS.has(lower)) return null;
  const typo = symbolTypoCandidates(raw);
  if (typo.length > 0) return { t: "ASSET?", raw, candidates: typo, span };
  return { t: "NOISE", raw, span };
}

const WALLET_WORDS: ReadonlySet<string> = new Set(["wallet", "account", "address"]);

/** "my arbitrum wallet", "my sol account": a wallet word right after "my" and a network word. */
function ownWallet(before: readonly Token[], raw: string): boolean {
  if (!WALLET_WORDS.has(raw.toLowerCase())) return false;
  const place = before[before.length - 1];
  const networkWord = place?.t === "NETWORK" || (place?.t === "ASSET" && place.network !== undefined);
  return networkWord && before[before.length - 2]?.t === "POSS";
}

/** The clause's tokens (fillers dropped). The clause should come from `normalizeClause`. */
export function lex(text: string): Token[] {
  const words = text.length > 0 ? text.split(" ") : [];
  const starts: number[] = [];
  let offset = 0;
  for (const word of words) {
    starts.push(offset);
    offset += word.length + 1;
  }
  const cursor: Cursor = { words, starts };
  const tokens: Token[] = [];
  let index = 0;
  while (index < words.length) {
    // "all but 0.1", "everything except 0.5"
    const allBut = ALL_BUT_PHRASES.find((phrase) => words.slice(index, index + 2).join(" ").toLowerCase() === phrase);
    if (allBut) {
      const kept = index + 2 < words.length ? readAmountAt(cursor, index + 2) : null;
      if (kept && kept[0].t === "AMOUNT" && kept[0].sel.t === "exact") {
        const used = 2 + kept[1];
        tokens.push({ t: "AMOUNT", sel: { t: "allBut", keep: kept[0].sel.value }, raw: words.slice(index, index + used).join(" "), span: spanOf(cursor, index, index + used) });
        index += used;
        continue;
      }
    }
    // Token-unit fractions before portions: "half a sol" is 0.5 SOL, not half the balance.
    const fraction = tokenUnitFraction(cursor, index);
    if (fraction) {
      tokens.push(fraction[0]);
      index += fraction[1];
      continue;
    }
    // Portion words before numbers: "two thirds" is 6667 bps, not the number 2.
    const portion = PORTION_PHRASES.find((phrase) => index + phrase.length <= words.length && words.slice(index, index + phrase.length).join(" ").toLowerCase() === phrase.join(" "));
    if (portion) {
      const raw = words.slice(index, index + portion.length).join(" ");
      tokens.push({ t: "AMOUNT", sel: { t: "portion", bps: PORTION_WORDS[portion.join(" ")] as number }, raw, span: spanOf(cursor, index, index + portion.length) });
      index += portion.length;
      continue;
    }
    const amount = readAmountAt(cursor, index);
    if (amount) {
      tokens.push(amount[0]);
      index += amount[1];
      continue;
    }
    let matched = false;
    for (const phrase of PHRASES_BY_FIRST.get((words[index] as string).toLowerCase()) ?? []) {
      const size = phrase.words.length;
      if (index + size > words.length) continue;
      const slice = words.slice(index, index + size);
      if (slice.join(" ").toLowerCase() !== phrase.words.join(" ")) continue;
      const token = phrase.make(slice.join(" "), spanOf(cursor, index, index + size));
      if (!token) continue;
      tokens.push(token);
      index += size;
      matched = true;
      break;
    }
    if (matched) continue;
    const token = readWord(cursor, index);
    if (token) tokens.push(token.t === "NOISE" && ownWallet(tokens, token.raw) ? { t: "WALLET", span: token.span } : token);
    index += 1;
  }
  return tokens;
}
