/**
 * Message normalisation shared by the API, SDK, widget and web: arrows
 * become " to ", quotes and trailing punctuation go, polite prefixes and
 * suffixes are dropped and number words up to "a thousand" become digits. `NETWORK_WORDS` is the alternation of
 * network words the follow-up grammar reads.
 *
 * The word lists that decide what may be dropped, corrected or never read
 * without a rule live in wordLists.ts.
 *
 * `screenText` is the reader's first pass, run on the text as typed before
 * anything else: Unicode compatibility forms, invisible and direction
 * characters, arrows, fancy quotes and dashes, emoji (removed and counted,
 * never meaning) and repeated punctuation; it reports a word with
 * letters outside the Latin script (a homoglyph such as Cyrillic "С" inside
 * "USDС") so the reader can refuse instead of reading a look-alike.
 */

const NUMBER_WORDS: Readonly<Record<string, string>> = Object.freeze({
  one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12", fifteen: "15", twenty: "20", thirty: "30", forty: "40", fifty: "50", hundred: "100",
  "a hundred": "100", "one hundred": "100", "a thousand": "1000", "one thousand": "1000",
});
/**
 * A number word directly before a portion word stays a word ("two thirds",
 * "three quarters", "one half"): the reader reads the portion, never the
 * number 2 or 3.
 */
const PORTION_AFTER = "(?!\\s+(?:thirds?|quarters?|halves|half|fifths?|tenths?)\\b)";
const NUMBER_WORD_PATTERNS = Object.entries(NUMBER_WORDS)
  .sort((a, b) => b[0].length - a[0].length)
  .map(([word, digits]) => [new RegExp(`(^|\\s)${word}(?=\\s)${PORTION_AFTER}`, "giu"), digits] as const);

/** Number words `normalizeMessage` spells as digits (whole words before a space). */
export const SPELLED_NUMBER_WORDS: Readonly<Record<string, string>> = NUMBER_WORDS;

/**
 * Message normalisation shared with the engine: arrows become " to ", quotes
 * and trailing punctuation go, polite prefixes and suffixes are dropped and
 * number words up to "a thousand" become digits.
 */
export function normalizeMessage(text: string): string {
  let value = text
    .replace(/[→➡]|->|=>/gu, " to ")
    .replace(/[“”"']/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[.!?]+$/u, "")
    .trim();
  const prefix = /^(?:please|pls|kletia,?|i want to|id like to|i would like to|can you|could you|lets)\s+/iu;
  while (prefix.test(value)) value = value.replace(prefix, "");
  value = value.replace(/(?:,?\s+(?:please|pls|thanks|thank you|thx))+$/iu, "").trim();
  for (const [pattern, digits] of NUMBER_WORD_PATTERNS) value = value.replace(pattern, `$1${digits}`);
  return value;
}

/** Network words of the follow-up grammar, as one regular-expression alternation (longest first). */
export const NETWORK_WORDS =
  "arbitrum[\\s-]+sepolia|arb[\\s-]+sepolia|solana[\\s-]+devnet|solana[\\s-]+mainnet|arbitrum[\\s-]+one|arc[\\s-]+testnet|base[\\s-]+mainnet|" +
  "ethereum[\\s-]+mainnet|op[\\s-]+mainnet|optimism[\\s-]+mainnet|polygon[\\s-]+pos|polygon[\\s-]+mainnet|mainnet-beta|" +
  "base|arbitrum|arb|arc|solana|sol|devnet|ethereum|optimism|polygon|matic|op";

/* ------------------------------------------------------------ screen */

/** Zero-width characters, word joiners and byte-order marks (removed). */
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/gu;
/** Direction marks and embeddings (removed: they can reorder what is shown). */
const BIDI = /[\u200E\u200F\u202A-\u202E\u2066-\u2069\u061C]/gu;
/** Control characters other than tab and line breaks (removed); tab and line breaks become spaces. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
/** Arrow characters (with an optional emoji variation selector) read as " to ". */
const ARROWS = /[\u2192\u27A1\u27F6\u21D2\u2794\u279C\u279D\u279E\u27F9\u21A6\u2B95\u21E8\u2799\u279B\u27A4\u27BE][\uFE0E\uFE0F]?/gu;
/** Emoji and pictographs (removed and counted), with their skin-tone, keycap and variation marks. */
const EMOJI = /(?:\p{Extended_Pictographic}[\uFE0E\uFE0F]?[\u{1F3FB}-\u{1F3FF}]?|[\u{1F3FB}-\u{1F3FF}\u{1F1E6}-\u{1F1FF}\u20E3])[\uFE0E\uFE0F]?/gu;
const LETTER = /\p{L}/u;
const LATIN_OR_MARK = /^[\p{Script=Latin}\p{M}]$/u;

export interface ScreenedText {
  /** The text with Unicode forms, punctuation and emoji tidied (words, numbers, addresses and names unchanged). */
  readonly text: string;
  /** How many emoji or pictographs were removed (never read as meaning). */
  readonly emoji: number;
  /** The first word holding a letter outside the Latin script ("USDС" with a Cyrillic С), at most 24 characters. */
  readonly nonLatin?: string;
}

/**
 * The reader's first pass over a message as typed: NFKC;
 * invisible, direction and control characters removed; arrows read as "to";
 * fancy quotes and dashes as plain ones; "…" and "..." as a pause; emoji
 * removed and counted; "!!" and ",," collapsed. Question marks are kept
 * (a question is never planned as typed). Words are otherwise unchanged.
 */
export function screenText(raw: string): ScreenedText {
  let emoji = 0;
  let text = raw
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(BIDI, "")
    .replace(/[\t\r\n]+/gu, " ")
    .replace(CONTROL, "")
    .replace(ARROWS, " to ")
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u0060\u00B4]/gu, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/gu, '"')
    .replace(/[\u2010-\u2015\u2212]/gu, "-")
    .replace(/\u2026|\.{3,}/gu, " ")
    .replace(EMOJI, () => {
      emoji += 1;
      return " ";
    })
    .replace(/[\uFE0E\uFE0F]/gu, "")
    .replace(/!{2,}/gu, "!")
    .replace(/,{2,}/gu, ",")
    .replace(/\s+/gu, " ")
    .trim();
  text = text.replace(/\s+([,!])/gu, "$1");
  const nonLatin = text.split(" ").find((word) => [...word].some((char) => LETTER.test(char) && !LATIN_OR_MARK.test(char)));
  return { text, emoji, ...(nonLatin ? { nonLatin: nonLatin.slice(0, 24) } : {}) };
}
