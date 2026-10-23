/**
 * Message normalisation shared by the API, SDK, widget and web: arrows
 * become " to ", quotes and trailing punctuation go, polite prefixes and
 * suffixes are dropped and number words up to "a thousand" become digits. `NETWORK_WORDS` is the alternation of
 * network words the follow-up grammar reads.
 *
 * The word lists that decide what may be dropped, corrected or never read
 * without a rule live in wordLists.ts.
 */

const NUMBER_WORDS: Readonly<Record<string, string>> = Object.freeze({
  one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12", fifteen: "15", twenty: "20", thirty: "30", forty: "40", fifty: "50", hundred: "100",
  "a hundred": "100", "one hundred": "100", "a thousand": "1000", "one thousand": "1000",
});
const NUMBER_WORD_PATTERNS = Object.entries(NUMBER_WORDS)
  .sort((a, b) => b[0].length - a[0].length)
  .map(([word, digits]) => [new RegExp(`(^|\\s)${word}(?=\\s)`, "giu"), digits] as const);

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
