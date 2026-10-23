/**
 * Reviewed words that may leave the server in a masked clause (design A.7.2,
 * B11): common function and finance words that never identify a person.
 * Anything else that is not Kletia vocabulary is sent as `<word_N>`.
 *
 * `READING_FILLERS`: words a reading may leave uncovered (gate 3); every other
 * word must lie in the evidence span of a field.
 */
const FUNCTION_WORDS = [
  "a", "an", "the", "i", "me", "my", "mine", "we", "our", "us", "you", "your", "it", "its", "this", "that", "these", "those",
  "is", "am", "are", "was", "be", "been", "being", "do", "does", "did", "have", "has", "had", "will", "would", "shall", "should",
  "can", "could", "may", "might", "must", "of", "at", "by", "about", "over", "under", "up", "down", "out", "off", "back",
  "here", "there", "now", "today", "soon", "right", "away", "asap", "again", "too", "very", "really", "so", "all", "some",
  "any", "each", "every", "both", "only", "just", "also", "please", "pls", "plz", "kindly", "thanks", "thank", "ok", "okay",
  "yes", "no", "not", "like", "want", "wanna", "gonna", "need", "lets", "let", "go", "make", "get", "put", "use", "using",
  "via", "through", "thru", "across", "between", "onto", "into", "from", "to", "for", "with", "without", "on", "in", "as",
  "than", "more", "less", "most", "least", "much", "many", "few", "little", "bit", "quick", "quickly", "fast", "real", "new",
  "old", "same", "other", "another", "own", "wallet", "account", "balance", "funds", "money", "cash", "coins", "coin",
  "tokens", "token", "crypto", "stack", "bag", "bags", "position", "positions", "pool", "vault", "yield", "interest", "apy",
  "rate", "rates", "fee", "fees", "gas", "network", "chain", "mainnet", "bridge", "swap", "trade", "convert", "exchange",
  "stake", "staking", "deposit", "withdraw", "lend", "lending", "supply", "earn", "send", "move", "buy", "sell", "hold",
  "safe", "safely", "cheap", "cheaply", "cheapest", "fastest", "best", "highest", "lowest", "good", "better", "cool", "nice",
  "hey", "hi", "hello", "yo", "gm", "um", "uh", "hmm", "well", "then", "next", "first", "last", "once", "twice", "whole",
];

export const EGRESS_WORDS: ReadonlySet<string> = new Set(FUNCTION_WORDS);

/** Words a reading may leave uncovered: politeness and emphasis only, never a word that changes what is done. */
export const READING_FILLERS: ReadonlySet<string> = new Set(["please", "pls", "plz", "kindly", "just", "quick", "real", "really", "hey", "hi", "hello", "yo", "gm", "ok", "okay", "thanks"]);
