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
import { ASSETS, CHAINS, UNIT_WORDS, type AmountSel, type AmountUnit, type AssetClass, type NetworkKey, type UnitWord } from "@kletia/core";
import { GRAMMAR_VENUE_WORDS, NAME, resolveNetworkName } from "../grammar.js";
import { bridgeProtocol, dexProtocol, isUsdWord, knownSymbol, lendingProtocol, providerFromWord } from "../clarify/catalog.js";
import { distance } from "../clarify/fuzzy.js";
import { add, multiply } from "../clarify/decimal.js";
import { DOT_THOUSANDS, fractionBps, fractionDecimal, numberWordsValue, readNumber, readPercent, shiftDecimal, type AmountCommentary } from "./amounts.js";
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
  APPROXIMATION_BEFORE,
  APPROXIMATION_AFTER,
  REFERENCE_WORDS,
  VAGUE_QUANTITIES,
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
  /**
   * `readAs`: how a rewritten amount reads back in its chip ("half a sol" -> "0.5 SOL").
   * `unit` / `rule`: the unit or multiplier word applied ("1.5 k" -> 1500, rule "unit:thousand"), shown as a
   * "Read as" item instead of a correction.
   */
  /**
   * `commentary`: a side remark checked against the stated amount ("1 SOL worth $150", "150 sol (half my stack)").
   * `derived`: arithmetic the person wrote ("10 + 5"): a derived reading, confirmed (source C).
   */
  | {
    readonly t: "AMOUNT"; readonly sel: AmountSel; readonly raw: string; readonly rewritten?: true; readonly readAs?: string; readonly unit?: AmountUnit;
    readonly rule?: string; readonly commentary?: AmountCommentary; readonly derived?: "arithmetic"; readonly span: Span;
  }
  /**
   * An amount said only roughly ("around 3", "~3", "3ish", "a couple of", "1 or 2"): the side has an
   * amount nobody may guess, so it is asked. `rule`: the closed-class rule that consumed the word.
   */
  | { readonly t: "VAGUE"; readonly raw: string; readonly rule?: string; readonly rules?: readonly string[]; readonly span: Span }
  /** Rebalance weights ("50/50", "60/40", "40/30/30": whole numbers summing to 100), read only with a rebalance verb. */
  | { readonly t: "WEIGHTS"; readonly weights: readonly number[]; readonly raw: string; readonly span: Span }
  | { readonly t: "ASSET"; readonly symbol: string; readonly raw: string; readonly network?: NetworkKey; readonly venue?: VenueReading; readonly span: Span }
  /** An unknown symbol within one edit of listed symbols ("SLO"): ASSET_TYPO. */
  | { readonly t: "ASSET?"; readonly raw: string; readonly candidates: readonly string[]; readonly span: Span }
  | { readonly t: "CLASS"; readonly cls: AssetClass; readonly raw: string; readonly span: Span }
  /** `generic`: "mainnet" or "l1" alone, read as Ethereum only when the clause is EVM-family. */
  | { readonly t: "NETWORK"; readonly network: NetworkKey; readonly raw: string; readonly generic?: true; readonly span: Span }
  | { readonly t: "VENUE"; readonly venue: VenueReading; readonly raw: string; readonly span: Span }
  | { readonly t: "ADDRESS"; readonly value: string; readonly span: Span }
  | { readonly t: "NAME"; readonly value: string; readonly span: Span }
  | { readonly t: "HOLDER"; readonly holder: "self" | "selfOther" | "nickname"; readonly raw: string; readonly span: Span }
  | { readonly t: "VERB"; readonly verb: VerbEntry; readonly raw: string; readonly span: Span }
  /**
   * `rule`: a closed-class rule the connector consumed ("over to" -> "connector:over").
   * `digit`: "2" / "4" read as "to" / "for" ("send .1 eth 2 alice.eth"): a correction, confirmed (source C).
   */
  | { readonly t: "CONN"; readonly word: string; readonly rule?: string; readonly digit?: string; readonly span: Span }
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
  for (const [phrase, word] of Object.entries(CONNECTOR_VARIANTS)) {
    add(phrase, (_raw, span) => ({ t: "CONN", word, ...(phrase.startsWith("over ") ? { rule: "connector:over" } : {}), span }));
  }
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

/* ------------------------------------------------------------ units */

/** US dollar stablecoins a "cents" amount may be paid in. */
const CENT_STABLES: ReadonlySet<string> = new Set(["USDC", "USDT", "DAI", "PYUSD", "USDS", "USDBC", "USDT0"]);
/** The symbols an asset-implying unit may be followed by ("1000 sats of cbbtc"). */
const UNIT_ASSETS: Readonly<Record<string, readonly string[]>> = Object.freeze({ BTC: ["BTC", "CBBTC", "WBTC"], ETH: ["ETH", "WETH"], SOL: ["SOL"] });
/** Glued multipliers ("1.5k", "2m", "3bn", "1mm"). */
const GLUED_UNIT = /^(\$?)(\d+(?:\.\d+)?)(k|mm|m|bn)(\$?)$/u;
const exponentOf = (factor: string) => (factor.startsWith("0.") ? -(factor.length - 2) : factor.length - 1);

/** "2 m sol", "2m eth", "2 m msol": "m" right before an m-symbol family (mSOL, mETH) may be either; never read. */
function mAmbiguous(unit: UnitWord, following: string | undefined): boolean {
  if (!unit.ambiguousBeforeM || following === undefined) return false;
  const lower = following.toLowerCase();
  if (lower === "sol" || lower === "eth") return LISTED.some((symbol) => symbol.toUpperCase() === `M${lower.toUpperCase()}`);
  return lower.startsWith("m") && knownSymbol(lower);
}

/** The listed spelling of the token after an amount (for the "Read as" text), or undefined. */
function symbolAfter(cursor: Cursor, at: number): { readonly symbol: string; readonly at: number } | undefined {
  let index = at;
  if ((cursor.words[index] ?? "").toLowerCase() === "of") index += 1;
  const word = cursor.words[index];
  if (word === undefined || ADDRESS_WORD.test(word) || !knownSymbol(word)) return undefined;
  return { symbol: listedSpelling(word), at: index };
}

/**
 * A number followed by a unit or multiplier word: "1.5 k", "1.5k", "2 million",
 * "50 cents", "1000 sats", "20 gwei", "5000 lamports", "50 bps of my USDC".
 * [token(s), words used], or null when the word after the number is no unit. A
 * unit no rule applies to ("2 m sol", "50 cents of eth", "50 bps" with no
 * holding) is NOISE: the clause is not read, never read without its unit.
 */
function readUnitAmount(cursor: Cursor, index: number, number: string, dollar: boolean, raw: string, unitWord: string, used: number): [Token[], number] | null {
  const unit = UNIT_WORDS[unitWord.toLowerCase()];
  if (!unit) return null;
  const end = index + used;
  const span = spanOf(cursor, index, end);
  const typed = cursor.words.slice(index, end).join(" ").slice(0, 40);
  const noise: [Token[], number] = [[{ t: "NOISE", raw: typed, span }], used];
  const rule = `unit:${unit.unit}`;
  const following = cursor.words[end];
  if (mAmbiguous(unit, following)) return noise;
  const shifted = shiftDecimal(number, exponentOf(unit.factor));
  const value = shifted ? readNumber(shifted)?.value : undefined;
  if (unit.needs === "holding") {
    // "50 bps of my USDC", "25 bps of it": a share of a holding or of the previous output.
    const bps = Number(number);
    const of = (cursor.words[end] ?? "").toLowerCase() === "of" && /^(?:my|it|them|that|the|our)$/u.test((cursor.words[end + 1] ?? "").toLowerCase());
    if (dollar || !Number.isInteger(bps) || bps < 1 || bps > 10_000 || !of) return noise;
    return [[{ t: "AMOUNT", sel: { t: "portion", bps }, raw: typed, rewritten: true, readAs: `${bps / 100}%`, unit: unit.unit, rule, span }], used];
  }
  if (!value) return noise;
  if (unit.needs === "usd") {
    // "50 cents", "50 cents of USDC": dollars, paid in a dollar stablecoin.
    const after = symbolAfter(cursor, end);
    if (after && !CENT_STABLES.has(after.symbol.toUpperCase())) return noise;
    if (after) return [[{ t: "AMOUNT", sel: { t: "exact", value }, raw: typed, rewritten: true, readAs: `${value} ${after.symbol}`, unit: unit.unit, rule, span }], used];
    if (following !== undefined && knownSymbol(following)) return noise;
    return [[{ t: "AMOUNT", sel: { t: "usd", value }, raw: typed, rewritten: true, readAs: `$${value}`, unit: unit.unit, rule, span }], used];
  }
  if (unit.asset) {
    // "1000 sats", "20 gwei of eth": the unit names its token; another token after it is a contradiction.
    if (dollar) return noise;
    const family = UNIT_ASSETS[unit.asset] as readonly string[];
    const after = symbolAfter(cursor, end);
    if (after && !family.includes(after.symbol.toUpperCase())) return noise;
    if (!after && following !== undefined && knownSymbol(following)) return noise;
    const amount: Token = { t: "AMOUNT", sel: { t: "exact", value }, raw: typed, rewritten: true, readAs: `${value} ${after?.symbol ?? unit.asset}`, unit: unit.unit, rule, span };
    if (after) return [[amount], used];
    const unitSpan = spanOf(cursor, end - 1, end);
    return [[amount, { t: "ASSET", symbol: unit.asset, raw: unitWord, span: unitSpan }], used];
  }
  // A multiplier: "1.5 k USDC", "$2m", "1 million dollars".
  const usdAfter = !dollar && USD_UNITS.has((following ?? "").toLowerCase());
  const total = usdAfter ? used + 1 : used;
  const totalSpan = spanOf(cursor, index, index + total);
  const words = cursor.words.slice(index, index + total).join(" ").slice(0, 40);
  if (dollar || usdAfter) return [[{ t: "AMOUNT", sel: { t: "usd", value }, raw: words, rewritten: true, readAs: `$${value}`, unit: unit.unit, rule, span: totalSpan }], total];
  const after = symbolAfter(cursor, end);
  void raw;
  return [[{ t: "AMOUNT", sel: { t: "exact", value }, raw: typed, rewritten: true, readAs: after ? `${value} ${after.symbol}` : value, unit: unit.unit, rule, span }], used];
}

/** A number with a unit at `index` ("1.5 k", "1.5k", "$2m", "50 cents"): the token(s) and words used, or null. */
function readUnitAt(cursor: Cursor, index: number): [Token[], number] | null {
  const word = cursor.words[index] as string;
  const lower = word.toLowerCase();
  const glued = GLUED_UNIT.exec(lower);
  if (glued) {
    const dollar = glued[1] === "$" || glued[4] === "$";
    return readUnitAmount(cursor, index, glued[2] as string, dollar, word, glued[3] as string, 1);
  }
  const dollar = lower.startsWith("$") || lower.endsWith("$");
  const number = readNumber(lower.replace(/^\$|\$$/gu, ""));
  const next = cursor.words[index + 1];
  if (!number || number.rewritten || next === undefined || !Object.hasOwn(UNIT_WORDS, next.toLowerCase())) return null;
  // "1 thousand" after a digit is a multiplier; number words ("five thousand") are read as words.
  return readUnitAmount(cursor, index, number.value, dollar, word, next, 2);
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
  // "usd 50": fifty dollars, as "$50" (AMT025).
  if (lower === "usd" && /^\d+(?:\.\d+)?$/u.test(next)) {
    const said = readNumber(next);
    if (said && !said.rewritten && !DOT_THOUSANDS.test(next)) return [{ t: "AMOUNT", sel: { t: "usd", value: said.value }, raw: cursor.words.slice(index, index + 2).join(" "), span: spanOf(cursor, index, index + 2) }, 2];
  }
  const dollar = lower.startsWith("$") || lower.endsWith("$");
  const number = readNumber(lower.replace(/^\$|\$$/gu, ""));
  // "1 000 usdc": thousands groups with spaces are one number, read back in a "Read as" item.
  const spaced = number && !dollar && !number.raw ? spacedThousands(cursor, index, lower) : null;
  if (spaced) {
    const raw = cursor.words.slice(index, index + spaced.used).join(" ");
    const after = symbolAfter(cursor, index + spaced.used);
    return [{ t: "AMOUNT", sel: { t: "exact", value: spaced.value }, raw, rewritten: true, readAs: after ? `${spaced.value} ${after.symbol}` : spaced.value, rule: "number:spaced", span: spanOf(cursor, index, index + spaced.used) }, spaced.used];
  }
  // "1.000.000", "1.000,50": European thousands, one reading, a material "Read as" item.
  if (number?.rewritten && number.raw && /^\d{1,3}\./u.test(number.raw)) {
    const after = symbolAfter(cursor, index + 1);
    return [{ t: "AMOUNT", sel: dollar ? { t: "usd", value: number.value } : { t: "exact", value: number.value }, raw: number.raw, rewritten: true, readAs: after && !dollar ? `${number.value} ${after.symbol}` : dollar ? `$${number.value}` : number.value, rule: "format:european", span: spanOf(cursor, index, index + 1) }, 1];
  }
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
  // "mainnet" and "l1" alone: Ethereum when the clause is EVM-family (decided once the clause is lexed).
  if (lower === "mainnet" || lower === "l1") return { t: "NETWORK", network: "ethereum", raw, generic: true, span };
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

const NUMBERISH = /^(?:\$?\d|\.\d|~)/u;
const APPROX_PHRASES: readonly (readonly string[])[] = APPROXIMATION_BEFORE.map((phrase) => phrase.split(" ")).sort((a, b) => b.length - a.length);
const APPROX_AFTER: readonly (readonly string[])[] = APPROXIMATION_AFTER.map((phrase) => phrase.split(" ")).sort((a, b) => b.length - a.length);
const VAGUE_PHRASES: readonly (readonly string[])[] = VAGUE_QUANTITIES.map((phrase) => phrase.split(" ")).sort((a, b) => b.length - a.length);
const BRIDGE_WORD = /^(?:li\.?fi|debridge|dln|relay|across|cctp)$/u;

function phraseAt(words: readonly string[], index: number, phrases: readonly (readonly string[])[]): readonly string[] | undefined {
  return phrases.find((phrase) => index + phrase.length <= words.length && phrase.every((word, offset) => (words[index + offset] as string).toLowerCase() === word));
}

/** An amount at `index` with its unit, if any: the tokens and words used, or null. */
function amountTokensAt(cursor: Cursor, index: number): [Token[], number] | null {
  const unit = readUnitAt(cursor, index);
  if (unit) return unit;
  const amount = readAmountAt(cursor, index);
  return amount ? [[amount[0]], amount[1]] : null;
}

/**
 * An amount said only roughly at `index`: "around 3", "~3", "3ish", "close to
 * 2", "1 or 2", "a couple of", "a few". A VAGUE token and the words used, or
 * null. The number is never read as the amount: the policy asks for it.
 */
function vagueAt(cursor: Cursor, index: number): [Token, number] | null {
  const words = cursor.words;
  const word = (words[index] as string).toLowerCase();
  const quantity = phraseAt(words, index, VAGUE_PHRASES);
  if (quantity) {
    return [{ t: "VAGUE", raw: words.slice(index, index + quantity.length).join(" "), span: spanOf(cursor, index, index + quantity.length) }, quantity.length];
  }
  // "~3", "3ish", "3-ish"
  const glued = /^~\$?\d|^\$?\d+(?:\.\d+)?-?ish$/u.test(word);
  if (glued) return [{ t: "VAGUE", raw: words[index] as string, rule: "amountVague:approx", span: spanOf(cursor, index, index + 1) }, 1];
  // "around 3", "close to 2 sol"
  const approx = phraseAt(words, index, APPROX_PHRASES);
  if (approx && NUMBERISH.test(words[index + approx.length] ?? "")) {
    const amount = amountTokensAt(cursor, index + approx.length);
    if (amount) {
      let used = approx.length + amount[1];
      // "like 1 or 2 sol": the approximation and the choice of two numbers, both asked (REF033).
      const or = (words[index + used] ?? "").toLowerCase() === "or" && NUMBERISH.test(words[index + used + 1] ?? "") ? amountTokensAt(cursor, index + used + 1) : null;
      if (or) used += 1 + or[1];
      return [{ t: "VAGUE", raw: words.slice(index, index + used).join(" "), rule: "amountVague:approx", ...(or ? { rules: ["amountVague:or"] } : {}), span: spanOf(cursor, index, index + used) }, used];
    }
  }
  // "1 or 2", "3 ish"
  if (NUMBERISH.test(word)) {
    const first = amountTokensAt(cursor, index);
    if (first && first[0].length === 1) {
      const at = index + first[1];
      const next = (words[at] ?? "").toLowerCase();
      if (next === "ish") return [{ t: "VAGUE", raw: words.slice(index, at + 1).join(" "), rule: "amountVague:approx", span: spanOf(cursor, index, at + 1) }, at + 1 - index];
      if (next === "or" && NUMBERISH.test(words[at + 1] ?? "")) {
        const second = amountTokensAt(cursor, at + 1);
        if (second) {
          const used = at + 1 + second[1] - index;
          return [{ t: "VAGUE", raw: words.slice(index, index + used).join(" "), rule: "amountVague:or", span: spanOf(cursor, index, index + used) }, used];
        }
      }
    }
  }
  return null;
}

/** "3 sol or so", "50 usdc give or take": an approximation after an amount (and its token) makes that amount VAGUE. */
function approximateAfter(tokens: Token[], cursor: Cursor, index: number): number {
  const phrase = phraseAt(cursor.words, index, APPROX_AFTER);
  if (!phrase) return 0;
  const last = tokens[tokens.length - 1];
  const amountAt = last?.t === "AMOUNT" ? tokens.length - 1 : last?.t === "ASSET" && tokens[tokens.length - 2]?.t === "AMOUNT" ? tokens.length - 2 : -1;
  const amount = tokens[amountAt];
  if (amount?.t !== "AMOUNT" || (amount.sel.t !== "exact" && amount.sel.t !== "usd")) return 0;
  tokens[amountAt] = { t: "VAGUE", raw: amount.raw, rule: "amountVague:approx", span: amount.span };
  return phrase.length;
}

/* --------------------------------------------------------- amount forms */

/** Words after a portion that show it is a share of something ("half my sol", "half of it", "half the usdc"). */
const PORTION_EVIDENCE: ReadonlySet<string> = new Set(["my", "our", "of", "the", "it", "them", "that", "those", "this", "position", "positions"]);
/** What a portion said of "my ..." in a side remark may be a share of ("(half my stack)"). */
const HOLDING_WORDS: ReadonlySet<string> = new Set(["stack", "bag", "bags", "holdings", "holding", "balance", "position", "stash", "funds", "wallet"]);
/** Connectors after "1 sol and a half" that end the amount ("... to usdc", "... on base"); never "of". */
const HALF_ENDS: ReadonlySet<string> = new Set([...CONNECTORS.filter((word) => !word.includes(" ") && word !== "of")]);
const ARITHMETIC_OPERATORS: Readonly<Record<string, "add" | "multiply">> = Object.freeze({ "+": "add", plus: "add", x: "multiply", "*": "multiply", times: "multiply" });
/** An amount as typed with nothing rewritten (arithmetic and "and a half" build only on these). */
const plainExact = (token: Token | undefined): token is Extract<Token, { t: "AMOUNT" }> & { sel: { t: "exact"; value: string } } =>
  token?.t === "AMOUNT" && token.sel.t === "exact" && !token.rewritten && !token.rule && !token.commentary && !token.derived && /^(?:\d+(?:\.\d+)?)$/u.test(token.raw);
const symbolWord = (word: string | undefined): boolean => word !== undefined && !ADDRESS_WORD.test(word) && knownSymbol(word);

/** "1 000", "12 500 000.50": thousands groups separated by spaces, read as one number (a material "Read as" item). */
function spacedThousands(cursor: Cursor, index: number, first: string): { value: string; used: number } | null {
  if (!/^[1-9]\d{0,2}$/u.test(first)) return null;
  let digits = first;
  let at = index + 1;
  let fraction = "";
  while (at < cursor.words.length) {
    const group = /^(\d{3})(?:\.(\d+))?$/u.exec(cursor.words[at] as string);
    if (!group) break;
    digits += group[1] as string;
    at += 1;
    if (group[2]) {
      fraction = group[2];
      break;
    }
  }
  if (at === index + 1) return null;
  const value = readNumber(fraction ? `${digits}.${fraction}` : digits)?.value;
  return value ? { value, used: at - index } : null;
}

/**
 * Slash forms: "a/b" only with integers 1 <= a < b <= 10, as a portion after
 * "of my" / "my" / "of it" ("1/4 of my sol") or as token units before a symbol
 * ("1/2 sol", "1/2 of a sol"); whole numbers summing to exactly 100 ("50/50",
 * "40/30/30") are rebalance weights. Every other slash form is NOISE: the
 * clause is not read.
 */
function slashAt(cursor: Cursor, index: number): [Token, number] | null {
  const word = cursor.words[index] as string;
  if (!/^\d+(?:\/\d+)+$/u.test(word)) return null;
  const span = spanOf(cursor, index, index + 1);
  const noise: [Token, number] = [{ t: "NOISE", raw: word, span }, 1];
  const parts = word.split("/").map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return noise;
  if (parts.length >= 2 && parts.length <= 8 && parts.every((part) => part >= 1) && parts.reduce((sum, part) => sum + part, 0) === 100 && !word.split("/").some((part) => part.startsWith("0"))) {
    return [{ t: "WEIGHTS", weights: parts, raw: word, span }, 1];
  }
  if (parts.length !== 2) return noise;
  const [numerator, denominator] = parts as [number, number];
  const lower = (at: number) => (cursor.words[at] ?? "").toLowerCase();
  const next = lower(index + 1);
  if ((next === "of" && PORTION_EVIDENCE.has(lower(index + 2)) && lower(index + 2) !== "of") || next === "my" || next === "our") {
    const bps = fractionBps(numerator, denominator);
    return bps === null ? noise : [{ t: "AMOUNT", sel: { t: "portion", bps }, raw: word, rule: "fraction:portion", span }, 1];
  }
  const unitAt = next === "of" && UNIT_ARTICLES.has(lower(index + 2)) ? index + 3 : index + 1;
  const unit = cursor.words[unitAt];
  if (!symbolWord(unit)) return noise;
  const value = fractionDecimal(numerator, denominator);
  if (!value) return noise;
  const raw = cursor.words.slice(index, unitAt + 1).join(" ").slice(0, 40);
  return [{ t: "AMOUNT", sel: { t: "exact", value }, raw, rewritten: true, readAs: `${value} ${listedSpelling(unit as string)}`, rule: "fraction:units", span: spanOf(cursor, index, unitAt) }, unitAt - index];
}

/**
 * "1 and a half sol", "1 sol and a half":
 * the amount before it plus 0.5, only when "and a half" is followed by the
 * token (after a bare number), or by the end of the clause, a connector or
 * the same token (after "<amount> <token>"); never by "of", "my" or another
 * token. Returns the words used (the amount token is rewritten in place), 0
 * when the words are not "and a half", or -1 when they are but no rule reads
 * them (the caller pushes NOISE: the clause is not read).
 */
function andAHalf(tokens: Token[], cursor: Cursor, index: number): number {
  const lower = (at: number) => (cursor.words[at] ?? "").toLowerCase();
  if (lower(index) !== "and" || lower(index + 1) !== "a" || lower(index + 2) !== "half") return 0;
  const last = tokens[tokens.length - 1];
  const halfEnd = spanOf(cursor, index, index + 3)[1];
  const integer = (token: Extract<Token, { t: "AMOUNT" }>) => /^\d+$/u.test(token.sel.t === "exact" ? token.sel.value : "");
  if (plainExact(last) && integer(last)) {
    // "1 and a half sol": the token follows.
    const unit = cursor.words[index + 3];
    if (!symbolWord(unit)) return -1;
    const value = add(last.sel.value, "0.5");
    tokens[tokens.length - 1] = { t: "AMOUNT", sel: { t: "exact", value }, raw: `${last.raw} and a half`, rewritten: true, readAs: `${value} ${listedSpelling(unit as string)}`, rule: "fraction:andAHalf", span: [last.span[0], halfEnd] };
    return 3;
  }
  const amount = tokens[tokens.length - 2];
  if (last?.t !== "ASSET" || !plainExact(amount) || !integer(amount)) return -1;
  const after = cursor.words[index + 3];
  const same = after !== undefined && after.toUpperCase() === last.symbol.toUpperCase();
  if (after !== undefined && !same && !HALF_ENDS.has(after.toLowerCase())) return -1;
  const value = add(amount.sel.value, "0.5");
  tokens[tokens.length - 2] = { t: "AMOUNT", sel: { t: "exact", value }, raw: `${amount.raw} ${last.raw} and a half`.slice(0, 40), rewritten: true, readAs: `${value} ${listedSpelling(last.symbol)}`, rule: "fraction:andAHalf", span: amount.span };
  return same ? 4 : 3;
}

/** "$150", "150$", "150 usd", "150 dollars": a dollar figure at `at` (value and words used), or null. */
function dollarsAt(cursor: Cursor, at: number): { usd: string; used: number } | null {
  const word = (cursor.words[at] ?? "").toLowerCase();
  const glued = /^\$(\d+(?:\.\d+)?)$|^(\d+(?:\.\d+)?)\$$/u.exec(word);
  if (glued) {
    const value = readNumber((glued[1] ?? glued[2]) as string);
    return value && !value.rewritten ? { usd: value.value, used: 1 } : null;
  }
  const number = readNumber(word);
  if (!number || number.rewritten || !USD_UNITS.has((cursor.words[at + 1] ?? "").toLowerCase())) return null;
  return { usd: number.value, used: 2 };
}

/**
 * A side remark after "<amount> <token>" (AMO032, AMT058): "worth $150"
 * (not "worth of": that is the worth phrase) or a parenthesis holding a
 * dollar figure ("(about $150)" is still refused by the closed-class scan)
 * or a portion of a holding ("(half my stack)"). The stated amount is kept;
 * the remark is recorded on it for the decision layer's cross-check.
 * Returns the words used, 0 when this is no remark, -1 when it is one no
 * rule reads (NOISE).
 */
function commentaryAt(tokens: Token[], cursor: Cursor, index: number): number {
  const word = cursor.words[index] as string;
  const lower = word.toLowerCase();
  const amountAt = tokens[tokens.length - 1]?.t === "ASSET" ? tokens.length - 2 : -1;
  const amount = tokens[amountAt];
  const stated = amount?.t === "AMOUNT" && amount.sel.t === "exact" && !amount.commentary && !amount.derived;
  if (lower === "worth") {
    const dollars = dollarsAt(cursor, index + 1);
    if (!dollars || (cursor.words[index + 1 + dollars.used] ?? "").toLowerCase() === "of") return 0;
    if (!stated) return -1;
    const raw = cursor.words.slice(index, index + 1 + dollars.used).join(" ").slice(0, 40);
    tokens[amountAt] = { ...amount, commentary: { kind: "usd", usd: dollars.usd, raw } };
    return 1 + dollars.used;
  }
  if (!word.startsWith("(")) return 0;
  let close = -1;
  for (let at = index; at < Math.min(cursor.words.length, index + 6); at += 1) {
    if ((cursor.words[at] as string).endsWith(")")) {
      close = at;
      break;
    }
  }
  if (close === -1 || !stated) return -1;
  const inner = cursor.words.slice(index, close + 1).join(" ").replace(/^\(|\)$/gu, "").trim().toLowerCase();
  const words = inner.split(/\s+/u).filter((entry) => entry.length > 0);
  const used = close + 1 - index;
  const raw = inner.slice(0, 40);
  const record = (commentary: AmountCommentary) => {
    tokens[amountAt] = { ...amount, commentary };
    return used;
  };
  // "(worth $150)", "($150)", "(150 usd)"
  const start = words[0] === "worth" ? 1 : 0;
  const inside: Cursor = { words, starts: words.map(() => 0) };
  const dollars = dollarsAt(inside, start);
  if (dollars && start + dollars.used === words.length) return record({ kind: "usd", usd: dollars.usd, raw });
  // "(half my stack)", "(a third of my sol)", "(25% of my bag)"
  const portion = PORTION_PHRASES.find((phrase) => phrase.every((entry, offset) => words[offset] === entry));
  const percent = portion ? null : readPercent(words[0] ?? "");
  const bps = portion ? (PORTION_WORDS[portion.join(" ")] as number) : percent;
  if (bps === null || bps === undefined) return -1;
  let at = portion ? portion.length : 1;
  if (words[at] === "of") at += 1;
  if (words[at] !== "my" && words[at] !== "our") return -1;
  const what = words[at + 1];
  const symbol = tokens[tokens.length - 1] as Extract<Token, { t: "ASSET" }>;
  if (at + 2 !== words.length || what === undefined || !(HOLDING_WORDS.has(what) || what.toUpperCase() === symbol.symbol.toUpperCase())) return -1;
  return record({ kind: "portion", bps, raw });
}

/**
 * Arithmetic the person wrote (source C): "10 + 5 usdc", "10 usdc + 5 usdc", "2
 * x 50 usdc". One AMOUNT with the result, the typed sum as its raw form and
 * `derived: "arithmetic"` (a one-click confirm "Read as 15 USDC (10 + 5)"). Two
 * different tokens, or an operator between anything else, stay NOISE.
 */
function arithmetic(tokens: Token[]): Token[] {
  const out: Token[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const left = tokens[index];
    if (!plainExact(left)) {
      out.push(left as Token);
      continue;
    }
    const leftAsset = tokens[index + 1]?.t === "ASSET" ? (tokens[index + 1] as Extract<Token, { t: "ASSET" }>) : undefined;
    const opAt = index + (leftAsset ? 2 : 1);
    const op = tokens[opAt];
    const kind = op?.t === "NOISE" ? ARITHMETIC_OPERATORS[op.raw.toLowerCase()] : undefined;
    const right = tokens[opAt + 1];
    if (!kind || !plainExact(right) || (kind === "multiply" && leftAsset)) {
      out.push(left);
      continue;
    }
    const rightAsset = tokens[opAt + 2]?.t === "ASSET" ? (tokens[opAt + 2] as Extract<Token, { t: "ASSET" }>) : undefined;
    if (leftAsset && rightAsset && leftAsset.symbol.toUpperCase() !== rightAsset.symbol.toUpperCase()) {
      out.push(left);
      continue;
    }
    const value = kind === "add" ? add(left.sel.value, right.sel.value) : multiply(left.sel.value, right.sel.value);
    const asset = leftAsset ?? rightAsset;
    if (!value || !/^(?:0|[1-9]\d{0,29})(?:\.\d{1,30})?$/u.test(value) || /^0(?:\.0+)?$/u.test(value)) {
      out.push(left);
      continue;
    }
    const raw = `${left.sel.value} ${kind === "add" ? "+" : "x"} ${right.sel.value}`;
    const end = (rightAsset ?? right).span[1];
    out.push({ t: "AMOUNT", sel: { t: "exact", value }, raw, rewritten: true, readAs: asset ? `${value} ${listedSpelling(asset.symbol)}` : value, rule: `arithmetic:${kind}`, derived: "arithmetic", span: [left.span[0], end] });
    if (asset) out.push(asset);
    index = opAt + (rightAsset ? 2 : 1);
  }
  return out;
}

/** A filler word that may not be dropped where it is (next to an amount, right after a network word): NOISE. */
function fillerKept(cursor: Cursor, index: number, tokens: readonly Token[]): boolean {
  const lower = (cursor.words[index] as string).toLowerCase();
  if (lower === "worth") return false;
  const before = cursor.words[index - 1];
  const after = cursor.words[index + 1];
  if ((before !== undefined && NUMBERISH.test(before)) || (after !== undefined && NUMBERISH.test(after))) return true;
  const last = tokens[tokens.length - 1];
  return last?.t === "NETWORK" || (last?.t === "ASSET" && last.network !== undefined && tokens[tokens.length - 2]?.t !== "AMOUNT");
}

/** Symbols listed on an EVM network and not on Solana ("ETH", "WETH", "ARB"): evidence a clause is EVM-family. */
function evmOnly(symbol: string): boolean {
  const upper = symbol.toUpperCase();
  const on = ASSETS.filter((asset) => asset.symbol.toUpperCase() === upper);
  return on.length > 0 && on.every((asset) => CHAINS[asset.network]?.vm === "evm");
}
function solanaOnly(symbol: string): boolean {
  const upper = symbol.toUpperCase();
  const on = ASSETS.filter((asset) => asset.symbol.toUpperCase() === upper);
  return on.length > 0 && on.every((asset) => CHAINS[asset.network]?.vm !== "evm");
}

/**
 * Network words read by the clause around them:
 * "mainnet" / "l1" alone are Ethereum only when the clause is EVM-family (an
 * EVM-only token, a .eth name or a 0x address, and nothing Solana-only);
 * otherwise NOISE, so the clause is not read. "on eth" after the clause's
 * token is Ethereum the network.
 */
function placeNetworkWords(tokens: Token[]): Token[] {
  const evm = tokens.some((token) => (token.t === "ASSET" && evmOnly(token.symbol)) || (token.t === "NAME" && token.value.endsWith(".eth")) || (token.t === "ADDRESS" && token.value.startsWith("0x")));
  const svm = tokens.some((token) => (token.t === "ASSET" && solanaOnly(token.symbol)) || (token.t === "NAME" && /\.(?:sns|sol)$/u.test(token.value)) || (token.t === "ADDRESS" && !token.value.startsWith("0x")) ||
    (token.t === "NETWORK" && !token.generic && CHAINS[token.network].vm !== "evm"));
  return tokens.map((token, index) => {
    if (token.t === "NETWORK" && token.generic) return evm && !svm ? token : { t: "NOISE", raw: token.raw, span: token.span };
    if (token.t !== "ASSET" || token.symbol.toLowerCase() !== "eth") return token;
    const before = tokens[index - 1];
    const placed = before?.t === "CONN" && (before.word === "on" || before.word === "in");
    const assetBefore = tokens.slice(0, index - 1).some((entry) => entry.t === "ASSET" || entry.t === "CLASS");
    return placed && assetBefore && index === tokens.length - 1 ? { t: "NETWORK", network: "ethereum", raw: token.raw, span: token.span } : token;
  });
}

/**
 * Digit-as-word: "2" / "4" right after a complete amount and token, before a
 * recipient, a network or a verb ("send .1 eth 2 alice.eth", "50 usdc 2
 * base"), is "to" / "for". Never before a token symbol ("swap 1 sol 2 usdc"
 * keeps both numbers). Marked as a correction: the reading is confirmed, never
 * planned silently.
 */
function digitWords(tokens: Token[]): Token[] {
  return tokens.map((token, index) => {
    if (token.t !== "AMOUNT" || token.sel.t !== "exact" || (token.raw !== "2" && token.raw !== "4")) return token;
    const asset = tokens[index - 1];
    const amount = tokens[index - 2];
    const next = tokens[index + 1];
    if (asset?.t !== "ASSET" || amount?.t !== "AMOUNT") return token;
    if (!next || !(next.t === "NAME" || next.t === "ADDRESS" || next.t === "NETWORK" || next.t === "VERB")) return token;
    return { t: "CONN", word: token.raw === "2" ? "to" : "for", digit: token.raw, span: token.span } satisfies Token;
  });
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
    // "3 sol or so": the amount before it was approximate.
    const approximate = approximateAfter(tokens, cursor, index);
    if (approximate > 0) {
      index += approximate;
      continue;
    }
    // "around 3", "~3", "1 or 2", "a couple of": an amount nobody may guess.
    const vague = vagueAt(cursor, index);
    if (vague) {
      tokens.push(vague[0]);
      index += vague[1];
      continue;
    }
    // "all but 0.1", "everything except 0.5"
    const allBut = ALL_BUT_PHRASES.find((phrase) => words.slice(index, index + 2).join(" ").toLowerCase() === phrase);
    if (allBut) {
      const kept = index + 2 < words.length ? readAmountAt(cursor, index + 2) : null;
      if (kept && kept[0].t === "AMOUNT" && kept[0].sel.t === "exact") {
        const used = 2 + kept[1];
        tokens.push({ t: "AMOUNT", sel: { t: "allBut", keep: kept[0].sel.value }, raw: words.slice(index, index + used).join(" "), ...(allBut.endsWith("except") ? { rule: "allBut:except" } : {}), span: spanOf(cursor, index, index + used) });
        index += used;
        continue;
      }
    }
    // "1.5 k", "2 million", "50 cents", "1000 sats": the unit is applied, never dropped.
    const unit = readUnitAt(cursor, index);
    if (unit) {
      tokens.push(...unit[0]);
      index += unit[1];
      continue;
    }
    // "over relay": a spelling of "via" before a bridge word.
    if ((words[index] as string).toLowerCase() === "over" && BRIDGE_WORD.test((words[index + 1] ?? "").toLowerCase())) {
      tokens.push({ t: "CONN", word: "via", rule: "connector:over", span: spanOf(cursor, index, index + 1) });
      index += 1;
      continue;
    }
    // Token-unit fractions before portions: "half a sol" is 0.5 SOL, not half the balance.
    const fraction = tokenUnitFraction(cursor, index);
    if (fraction) {
      tokens.push(fraction[0]);
      index += fraction[1];
      continue;
    }
    // "1/4 of my sol", "1/2 sol", "50/50": slash forms by their rule, anything else unread.
    const slash = slashAt(cursor, index);
    if (slash) {
      tokens.push(slash[0]);
      index += slash[1];
      continue;
    }
    // "1 and a half sol", "1 sol and a half": the amount before it is rewritten in place.
    const half = andAHalf(tokens, cursor, index);
    if (half !== 0) {
      if (half < 0) tokens.push({ t: "NOISE", raw: "and a half", span: spanOf(cursor, index, index + 3) });
      index += half < 0 ? 3 : half;
      continue;
    }
    // "1 SOL worth $150", "150 sol (half my stack)": a side remark on the stated amount, kept for the cross-check.
    const remark = commentaryAt(tokens, cursor, index);
    if (remark !== 0) {
      if (remark < 0) tokens.push({ t: "NOISE", raw: (words[index] as string).slice(0, 40), span: spanOf(cursor, index, index + 1) });
      index += remark < 0 ? 1 : remark;
      continue;
    }
    // Portion words before numbers: "two thirds" is 6667 bps, not the number 2.
    const portion = PORTION_PHRASES.find((phrase) => index + phrase.length <= words.length && words.slice(index, index + phrase.length).join(" ").toLowerCase() === phrase.join(" "));
    if (portion) {
      const raw = words.slice(index, index + portion.length).join(" ");
      const span = spanOf(cursor, index, index + portion.length);
      // Portion evidence: "half sol" with no my / of / the / it may be 0.5 SOL or half
      // the balance. The amount is asked, never guessed.
      const next = words[index + portion.length];
      const bare = next !== undefined && !PORTION_EVIDENCE.has(next.toLowerCase()) && (symbolWord(next) || networkOf(next) !== null || isUsdWord(next.toLowerCase()) || Object.hasOwn(CLASS_WORDS, next.toLowerCase()));
      tokens.push(bare ? { t: "VAGUE", raw, rule: "portion:unclear", span } : { t: "AMOUNT", sel: { t: "portion", bps: PORTION_WORDS[portion.join(" ")] as number }, raw, span });
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
    if (FILLER_WORDS.has((words[index] as string).toLowerCase()) && fillerKept(cursor, index, tokens)) {
      tokens.push({ t: "NOISE", raw: words[index] as string, span: spanOf(cursor, index, index + 1) });
      index += 1;
      continue;
    }
    const token = readWord(cursor, index);
    if (token) tokens.push(token.t === "NOISE" && ownWallet(tokens, token.raw) ? { t: "WALLET", span: token.span } : token);
    index += 1;
  }
  return placeNetworkWords(digitWords(arithmetic(tokens)));
}
