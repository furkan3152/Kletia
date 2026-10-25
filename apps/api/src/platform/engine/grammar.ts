/**
 * Deterministic natural-language intent grammar. Text is split into clauses
 * and each clause must match exactly one known sentence shape; anything else
 * is refused with INTENT_UNSUPPORTED and example phrases. No model is
 * involved and nothing is guessed: when a network cannot be inferred from
 * the text, the previous clause, `defaultNetwork` or the caller's accounts,
 * the clause is refused.
 *
 * The modules live in ./grammar/.
 */
export * from "./grammar/examples.js";
export {
  BRIDGE_VENUES,
  BRIDGE_WORDS,
  EVM_STAKING_NETWORK,
  EVM_STAKING_TOKENS,
  EXIT_GUIDES,
  GRAMMAR_VENUE_WORDS,
  LENDING_VENUES,
  LENDING_WORDS,
  LIQUID_STAKING_TOKENS,
  NATIVE_STAKE_PROTOCOL,
  NATIVE_STAKE_PROVIDER,
  NATIVE_STAKE_WORDS,
  SWAP_VENUES,
  SWAP_VENUE_WORDS,
  isGrammarVenueWord,
  l2StakeAlternatives,
  vaultOfVenueWord,
} from "./grammar/venues.js";
export type { L2StakeAlternatives, VenueWord } from "./grammar/venues.js";
export { MissingSourceError, resolveNetworkName } from "./grammar/types.js";
export type { GrammarContext, GrammarResult } from "./grammar/types.js";
export {
  ADDRESS,
  AMOUNT,
  ASSET,
  ASSET_NETWORK_WORDS,
  KEYWORD_GUARD,
  LST_WORDS,
  NAME,
  NETWORK,
  NETWORK_WORDS,
  NEUTRAL_MOVE_VERBS,
  ON_NETWORK,
  SENTENCE_FRAGMENTS,
  SOLANA_PAY_PROTOCOL,
  VAULT,
  VERBS,
  assetOrNetworkRefusal,
  swapFilterProvider,
  swapFilterWords,
} from "./grammar/patterns.js";
export { normalizeText, splitClauses } from "./grammar/clauses.js";
export { BORROW_VERBS, borrowRefusal, readVenueNames } from "./grammar/venueNames.js";
export { matchContractPhrase } from "./grammar/contractPhrases.js";
export type { ContractPhraseMatch } from "./grammar/contractPhrases.js";
export { EVM_TRANSFER_NETWORKS, SWAP_NETWORKS } from "./grammar/inference.js";
export * from "./grammar/compile.js";
