/**
 * Read-only questions ("show live Aave rates", "compare yield on base").
 * Kletia plans transactions; a rate question plans nothing and needs no
 * wallet. It is still refused as INTENT_UNSUPPORTED, but with `details`
 * that point to the public, keyless read that answers it (GET /v1/venues),
 * so a client can show the rates instead of a failure.
 */
import { CHAINS, FOLLOW_UP_VENUE_WORDS, type NetworkKey, type ProtocolId } from "@kletia/core";
import { PlatformError, type PlatformIssue } from "../errors.js";
import { resolveNetworkName } from "./grammar.js";

/** Words that make a sentence a question about rates rather than an action. */
const RATE_WORDS = /\b(?:rates?|apys?|aprs?|yields?|interest|returns?)\b/iu;
/** Words a rate question starts with or contains instead of an action verb. */
const ASK_WORDS = /^(?:show|list|compare|check|what|whats|what's|which|where|how|get|see|view|tell|find|best|current|live|top)\b/iu;

/** EVM lending protocols GET /v1/venues lists (it reads EVM venues only). */
const VENUE_PROTOCOLS: ReadonlySet<ProtocolId> = new Set<ProtocolId>(["aave-v3", "compound-v3", "morpho", "moonwell"]);

export interface ReadOnlyRates {
  readonly read: "venues";
  /** The keyless read that answers it, with its query. */
  readonly path: "/v1/venues";
  readonly query: { readonly protocol?: ProtocolId; readonly network?: NetworkKey };
}

/** The rate read a sentence asks for, or null when it is not a rate question. */
export function readOnlyRates(text: string): ReadOnlyRates | null {
  const sentence = text.trim().toLowerCase().replace(/[?.!]+$/u, "");
  if (!sentence || sentence.length > 200 || !RATE_WORDS.test(sentence) || !ASK_WORDS.test(sentence)) return null;
  const words = sentence.split(/\s+/u);
  let protocol: ProtocolId | undefined;
  let network: NetworkKey | undefined;
  for (let index = 0; index < words.length; index += 1) {
    const pair = `${words[index]} ${words[index + 1] ?? ""}`.trim();
    const venue = FOLLOW_UP_VENUE_WORDS[pair] ?? FOLLOW_UP_VENUE_WORDS[words[index] as string];
    if (!protocol && venue?.role === "lending") protocol = venue.protocol;
    const named = resolveNetworkName(words[index] as string) ?? (words[index + 1] ? resolveNetworkName(pair) : null);
    if (!network && named && CHAINS[named].vm === "evm") network = named;
  }
  return {
    read: "venues",
    path: "/v1/venues",
    query: {
      ...(protocol && VENUE_PROTOCOLS.has(protocol) ? { protocol } : {}),
      ...(network ? { network } : {}),
    },
  };
}

/** Question marks in any script ("?", fullwidth "？", small "﹖", inverted "¿", reversed "⸮"). */
const QUESTION_MARK = /[?¿？﹖⸮]/u;

/**
 * True when the text holds a question mark anywhere: such a message is a
 * question and is never planned as typed, even when the words read as an
 * instruction ("swap 0.01 ETH to USDC on base?"). Checked on the text as typed,
 * before any normaliser strips punctuation.
 */
export function hasQuestionMark(text: string): boolean {
  return QUESTION_MARK.test(text);
}

/**
 * INTENT_UNSUPPORTED for a message with a question mark: the rate read when
 * it asks for rates, otherwise a request to say it as an instruction. The
 * words are never planned (a question is not a confirmed instruction).
 */
export function questionRefusal(text: string, hints: readonly string[]): PlatformError {
  const rates = readOnlyRates(text);
  if (rates) return readOnlyRatesRefusal(rates, hints, [{ path: "text", message: "A question, not an instruction." }]);
  const said = text.trim().replace(/[?¿？﹖⸮]+/gu, "").replace(/\s+/gu, " ").trim().slice(0, 80);
  return new PlatformError(
    "INTENT_UNSUPPORTED",
    `Kletia reads "${said}" as a question, and it plans only instructions. To plan it, send it as an instruction without the question mark, for example "swap 1 SOL to USDC".`,
    422,
    [{ path: "text", message: "A question, not an instruction." }],
    hints,
  );
}

/** INTENT_UNSUPPORTED for a rate question: says where the rates are, with `details` a client can act on. */
export function readOnlyRatesRefusal(rates: ReadOnlyRates, hints: readonly string[], issues?: readonly PlatformIssue[]): PlatformError {
  const query = new URLSearchParams(rates.query as Record<string, string>).toString();
  return new PlatformError(
    "INTENT_UNSUPPORTED",
    `That is a question about rates, and Kletia plans transactions. Live lending rates need no wallet: GET ${rates.path}${query ? `?${query}` : ""}. To earn them, say for example "deposit 100 USDC into aave on base".`,
    422,
    issues ?? [{ path: "text", message: "A read-only question, not an action." }],
    hints,
    { readOnly: rates.read, path: rates.path, query: rates.query },
  );
}
