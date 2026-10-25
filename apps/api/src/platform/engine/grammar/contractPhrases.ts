/**
 * Registered contract phrases.
 */
import { CHAINS, type IntentActionSpec, type NetworkKey } from "@kletia/core";
import type { ContractPhrase } from "../contracts/directory.js";
import { type AmountPhrase, clauseError } from "./types.js";
import { AMOUNT, ASSET, ON_NETWORK } from "./patterns.js";
import { networkFromGroup, normalizeText, parseAmount } from "./clauses.js";

/* ------------------------------------------------- contract clauses (BYOC) */

const CONTRACT_SUFFIX = "(?:\\s+(?:vault|pool|contract|program))?";
const CONTRACT_CONNECTOR = "(?:into|to|in|on|at|with|via|using|through|from|out\\s+of)";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/ /gu, "\\s+");
}

interface ContractMatcher {
  readonly regex: RegExp;
  readonly phrases: readonly ContractPhrase[];
}

/** One regex over every verb and alias the key's registrations declare (longest alternatives first). */
function contractMatcher(phrases: readonly ContractPhrase[]): ContractMatcher | null {
  const verbs = [...new Set(phrases.flatMap((phrase) => phrase.verbs))].filter((verb) => /^[a-z]{2,16}$/u.test(verb));
  const aliases = [...new Set(phrases.flatMap((phrase) => phrase.aliases))].filter((alias) => alias.length > 1);
  if (verbs.length === 0 || aliases.length === 0) return null;
  const byLength = (a: string, b: string) => b.length - a.length;
  const regex = new RegExp(
    `^(?<verb>${verbs.sort(byLength).map(escapeRegex).join("|")})\\s+` +
      `(?:${AMOUNT}(?:\\s+${ASSET("a")})?\\s+|(?:my\\s+)?(?<obj>[a-z][a-z0-9.-]{0,31})\\s+)?` +
      `${CONTRACT_CONNECTOR}\\s+(?:the\\s+|my\\s+)?(?<alias>${aliases.sort(byLength).map(escapeRegex).join("|")})${CONTRACT_SUFFIX}${ON_NETWORK}?$`,
    "iu",
  );
  return { regex, phrases };
}

/**
 * What a contract clause reads as: the action, a gap the user can fill (the
 * amount of a spending entry; the network of an alias registered on several
 * networks), or null when the clause names no registered alias.
 */
export type ContractPhraseMatch =
  | { readonly action: IntentActionSpec; readonly explicit: boolean }
  | { readonly gap: "amount"; readonly message: string }
  | { readonly gap: "network"; readonly networks: readonly NetworkKey[]; readonly message: string };

export function matchWithMatcher(clause: string, matcher: ContractMatcher, previousDestination: NetworkKey | undefined, index: number): ContractPhraseMatch | null {
  const match = matcher.regex.exec(clause);
  if (!match?.groups) return null;
  const groups = match.groups;
  const verb = (groups.verb ?? "").toLowerCase();
  const alias = (groups.alias ?? "").toLowerCase().replace(/\s+/gu, " ");
  const network = networkFromGroup(groups.net, clause);
  const named = matcher.phrases.filter((phrase) => phrase.aliases.includes(alias));
  const byVerb = named.filter((phrase) => phrase.verbs.includes(verb));
  if (byVerb.length === 0) {
    const verbs = [...new Set(named.flatMap((phrase) => phrase.verbs))];
    throw clauseError(clause, `"${alias}" accepts ${verbs.map((entry) => `"${entry}"`).join(", ")}, not "${verb}".`);
  }
  let candidates = network ? byVerb.filter((phrase) => phrase.network === network) : byVerb;
  if (candidates.length === 0) {
    throw clauseError(clause, `"${alias}" is registered on ${[...new Set(byVerb.map((phrase) => CHAINS[phrase.network].name))].join(", ")}, not ${CHAINS[network as NetworkKey].name}.`);
  }
  const distinct = (list: readonly ContractPhrase[]) => new Set(list.map((phrase) => `${phrase.contract}#${phrase.entry}`)).size;
  if (distinct(candidates) > 1 && previousDestination) {
    const onPrevious = candidates.filter((phrase) => phrase.network === previousDestination);
    if (onPrevious.length > 0) candidates = onPrevious;
  }
  if (distinct(candidates) > 1) {
    const networks = [...new Set(candidates.map((phrase) => phrase.network))];
    return {
      gap: "network",
      networks,
      message: `"${alias}" names several registered actions (${networks.map((entry) => CHAINS[entry].name).join(", ")}); add "on <network>".`,
    };
  }
  const phrase = candidates[0] as ContractPhrase;
  const raw = groups.amt;
  let amount: AmountPhrase | null = raw ? parseAmount(raw, clause) : null;
  if (!phrase.spends) {
    if (amount) throw clauseError(clause, `"${verb} … ${alias}" spends nothing; leave out the amount.`);
  } else if (!amount) {
    return { gap: "amount", message: `Say how much to ${verb}, e.g. "${verb} 100 ${groups.obj ?? "USDC"} into ${alias}".` };
  }
  if (amount?.type === "previous" && index === 0) {
    throw clauseError(clause, "\"all\", \"half\", \"it\" and percentages refer to a previous step; give an explicit amount.");
  }
  let from = groups.a;
  if (amount?.type === "exact" && amount.usd) {
    if (from && !["USDC", "USDT", "PYUSD", "DAI"].includes(from.toUpperCase())) throw clauseError(clause, "A $ amount must be paid in a USD stablecoin.");
    from = from ?? "USDC";
  }
  const params: Record<string, string | number | boolean> = {};
  if (amount?.type === "previous" && amount.portionBps !== 10_000) params.portionBps = amount.portionBps;
  amount = amount ?? null;
  return {
    action: {
      kind: phrase.vm === "evm" ? "call" : "action",
      network: phrase.network,
      contract: phrase.contract,
      entry: phrase.entry,
      ...(from ? { from } : {}),
      ...(amount ? { amount: amount.type === "exact" ? amount.value : "max" } : {}),
      ...(Object.keys(params).length > 0 ? { params } : {}),
    },
    explicit: network !== undefined,
  };
}

const matcherCache = new WeakMap<readonly ContractPhrase[], ContractMatcher | null>();

export function cachedMatcher(phrases: readonly ContractPhrase[]): ContractMatcher | null {
  if (!matcherCache.has(phrases)) matcherCache.set(phrases, contractMatcher(phrases));
  return matcherCache.get(phrases) ?? null;
}

/**
 * A clause naming a registered alias: `<verb> [<amount> [<asset>]] <connector>
 * [the|my] <alias> [vault|pool|contract|program] [on <network>]`. Ambiguous
 * aliases are settled by `on <network>`, then by the previous step's
 * destination network; otherwise the network is a gap. A spending entry
 * without an amount is an amount gap. Returns null when the clause names no
 * alias (built-in sentences then apply unchanged); throws for what a
 * question cannot fix (a verb the registration does not accept, a network it
 * is not registered on, an amount on a non-spending entry).
 */
export function matchContractPhrase(
  clause: string,
  phrases: readonly ContractPhrase[],
  options: { readonly previousDestination?: NetworkKey; readonly index?: number } = {},
): ContractPhraseMatch | null {
  const matcher = phrases.length > 0 ? cachedMatcher(phrases) : null;
  if (!matcher) return null;
  return matchWithMatcher(normalizeText(clause), matcher, options.previousDestination, options.index ?? 0);
}
