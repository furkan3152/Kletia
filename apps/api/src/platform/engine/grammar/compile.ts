/**
 * The entry point: compileIntentText.
 */
import {
  ASSETS,
  CHAINS,
  findAssetBySymbol,
  isEvmAddress,
  isSolanaAddress,
  lookalikeFamilyOf,
  MAX_INTENT_ACTIONS,
  parseAccountId,
  scanClosedClass,
  screenText,
  UNSUPPORTED_NETWORKS,
  type IntentActionSpec,
  type NetworkKey,
} from "@kletia/core";
import { PlatformError, unsupported } from "../../errors.js";
import { hasQuestionMark, questionRefusal } from "../readOnly.js";
import { GRAMMAR_EXAMPLES } from "./examples.js";
import {
  clauseError,
  type GrammarContext,
  type GrammarResult,
} from "./types.js";
import { matchClause, normalizeText, splitClauses } from "./clauses.js";
import { readVenueNames } from "./venueNames.js";
import { cachedMatcher, matchWithMatcher } from "./contractPhrases.js";
import {
  type InferenceContext,
  inferNetwork,
  toActionSpec,
} from "./inference.js";

/**
 * The strict reader's first screen: letters outside the Latin script are
 * refused (a homoglyph such as Cyrillic "С" in "USDС"), and a network Kletia
 * does not run on, or a lane qualifier it has no lane for ("arbitrum nova",
 * "base sepolia", "solana testnet"), refuses NETWORK_UNSUPPORTED naming it
 * instead of a generic refusal.
 */
function screenStrict(text: string): string {
  const screened = screenText(text);
  if (screened.nonLatin) {
    throw unsupported("Kletia reads plain Latin letters only: a word in this text has letters from another alphabet that can look like Latin ones.", GRAMMAR_EXAMPLES);
  }
  const lower = screened.text.toLowerCase();
  const hit = scanClosedClass(lower).find((entry) => entry.category === "network" && !/[.\-_]/u.test(lower[entry.start - 1] ?? " ") && !/^[.\-_][a-z0-9]/u.test(lower.slice(entry.end, entry.end + 2)));
  if (hit) {
    const name = UNSUPPORTED_NETWORKS[hit.phrase]?.name ?? hit.phrase.split(" ").map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(" ");
    throw new PlatformError(
      "NETWORK_UNSUPPORTED",
      `Kletia does not run on ${name}. It runs on Base, Arbitrum One, Ethereum, OP Mainnet, Polygon PoS and Solana; test networks: Arc Testnet, Arbitrum Sepolia and Solana Devnet.`,
      422,
      [{ path: "text", message: "Not a network Kletia runs on." }],
      undefined,
      { network: name },
    );
  }
  return screened.text;
}

/** Compiles intent text into structured actions, or throws INTENT_UNSUPPORTED (MissingSourceError for a bridge without a source). */
/** True when `symbol` is a token Kletia lists on `network`, by its symbol or a reviewed alias (USDT -> USDT0). */
function listedOn(network: NetworkKey, symbol: string): boolean {
  return CHAINS[network].nativeAsset.symbol.toUpperCase() === symbol.trim().toUpperCase() || findAssetBySymbol(network, symbol) !== null;
}

/** True when `symbol` is exactly the symbol of a token Kletia lists on `network` (no alias). */
function listedExactly(network: NetworkKey, symbol: string): boolean {
  const wanted = symbol.trim().toUpperCase();
  return CHAINS[network].nativeAsset.symbol.toUpperCase() === wanted
    || ASSETS.some((asset) => asset.network === network && asset.symbol.toUpperCase() === wanted);
}

/**
 * Look-alike symbols: a typed symbol of a look-alike family
 * ("wsol", "stsol") that Kletia does not list on a Solana network, by symbol or
 * reviewed alias, is never searched for by name on the strict path (a search
 * could return the sibling or an unrelated token); it is refused so the
 * person names the token exactly.
 */
function refuseLookalike(clause: string, action: IntentActionSpec): void {
  const sides: [string | undefined, NetworkKey][] = [
    [action.from, action.network],
    [action.to, action.toNetwork ?? action.network],
  ];
  for (const [symbol, network] of sides) {
    // EVM symbols resolve only from the registry; Solana symbols Kletia does not list are searched by name.
    if (!symbol || CHAINS[network].vm !== "svm" || isEvmAddress(symbol) || isSolanaAddress(symbol)) continue;
    const family = lookalikeFamilyOf(symbol);
    if (!family || listedOn(network, symbol)) continue;
    const listed = family.members.filter((member) => listedExactly(network, member));
    const hint = listed.length > 0 ? ` Kletia lists ${listed.join(", ")} on ${CHAINS[network].name}.` : "";
    throw clauseError(clause, `"${symbol}" is not a token Kletia lists on ${CHAINS[network].name}, and it is not read as a similar token.${hint} Write the exact symbol.`);
  }
}

export function compileIntentText(text: string, context: GrammarContext = {}): GrammarResult {
  const normalizedText = normalizeText(readVenueNames(screenStrict(text)));
  if (!normalizedText) throw unsupported("The intent text is empty.", GRAMMAR_EXAMPLES);
  // A question is never planned as typed ("swap 0.01 ETH to USDC on base?"): normalizeText strips the mark, so check first.
  if (hasQuestionMark(text)) throw questionRefusal(normalizedText, GRAMMAR_EXAMPLES);
  const matcher = context.contracts && context.contracts.length > 0 ? cachedMatcher(context.contracts) : null;
  const clauses = splitClauses(normalizedText, matcher ? matcher.phrases.flatMap((phrase) => phrase.verbs) : []);
  if (clauses.length === 0) throw unsupported("The intent text is empty.", GRAMMAR_EXAMPLES);
  if (clauses.length > MAX_INTENT_ACTIONS) {
    throw unsupported(`An intent may contain at most ${MAX_INTENT_ACTIONS} actions.`, GRAMMAR_EXAMPLES);
  }
  const accountNetworks = (context.accounts ?? [])
    .map((account) => parseAccountId(account)?.chain.key)
    .filter((network): network is NetworkKey => network !== undefined);
  const inference: InferenceContext = {
    ...(context.defaultNetwork ? { defaultNetwork: context.defaultNetwork } : {}),
    accountNetworks,
  };
  const actions: IntentActionSpec[] = [];
  const explicitNetwork: boolean[] = [];
  const warnings: string[] = [];
  let previousDestination: NetworkKey | undefined;
  clauses.forEach((clause, index) => {
    const contract = matcher ? matchWithMatcher(clause, matcher, previousDestination, index) : null;
    if (contract && "gap" in contract) throw clauseError(clause, contract.message);
    let action: IntentActionSpec;
    if (contract) {
      action = contract.action;
      explicitNetwork.push(contract.explicit);
    } else {
      const draft = matchClause(clause);
      const network = inferNetwork(draft, previousDestination, inference);
      warnings.push(...(draft.warnings ?? []));
      action = toActionSpec(draft, network, index, warnings);
      explicitNetwork.push(draft.explicit);
    }
    refuseLookalike(clause, action);
    actions.push(action);
    previousDestination = action.toNetwork ?? action.network;
  });
  return {
    actions,
    normalizedText: clauses.join(", then "),
    clauses,
    confidence: 0.95,
    explicitNetwork,
    warnings: [...new Set(warnings)],
  };
}
