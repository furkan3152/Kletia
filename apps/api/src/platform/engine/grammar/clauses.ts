/**
 * Text normalisation, clause splitting and clause matching into drafts.
 */
import {
  CHAINS,
  getProtocol,
  type NetworkKey,
  type ProtocolId,
} from "@kletia/core";
import { unsupported } from "../../errors.js";
import { readOnlyRates, readOnlyRatesRefusal } from "../readOnly.js";
import { GRAMMAR_EXAMPLES } from "./examples.js";
import {
  BRIDGE_VENUES,
  EVM_STAKING_TOKENS,
  evmStakingToken,
  EXIT_GUIDES,
  LENDING_VENUES,
  NATIVE_STAKE_PROTOCOL,
  SWAP_VENUES,
  VAULT_PROTOCOLS,
  vaultOfVenueWord,
  type VenueWord,
} from "./venues.js";
import {
  type AmountPhrase,
  clauseError,
  type Draft,
  resolveNetworkName,
} from "./types.js";
import {
  ASSET_NETWORK_WORDS,
  assetOrNetworkRefusal,
  NEUTRAL_MOVE_VERBS,
  PATTERNS,
  SOLANA_PAY_PROTOCOL,
  swapFilterProvider,
  VERBS,
} from "./patterns.js";
import {
  BORROW_VERBS,
  borrowRefusal,
  LENDING_NAMES,
  venuelessDeposit,
} from "./venueNames.js";

/**
 * The text the grammar reads: arrows become " to ", quotes and trailing
 * punctuation go, polite prefixes ("please", "can you") and trailing
 * courtesies ("please", "thanks") are dropped.
 */
export function normalizeText(text: string): string {
  let value = text
    .replace(/[→➡]|->|=>/gu, " to ")
    .replace(/[“”"']/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[.!?]+$/u, "")
    .trim();
  const prefix = /^(?:please|pls|kletia,?|i want to|i'?d like to|i would like to|can you|could you|let's|lets)\s+/iu;
  while (prefix.test(value)) value = value.replace(prefix, "");
  value = value.replace(/(?:,?\s+(?:please|pls|thanks|thank\s+you|thx))+$/iu, "").replace(/[,.!?]+$/u, "").trim();
  return value;
}

export function splitClauses(text: string, extraVerbs: readonly string[] = []): string[] {
  const verbs = [...VERBS, ...extraVerbs.filter((verb) => /^[a-z]{2,16}$/u.test(verb) && !VERBS.includes(verb))];
  // ", pay with 100 usdc from base" / ", using ..." is the funding of the clause before, never a new step.
  const verbLookahead = `(?!pay\\s+(?:with|using)\\b)(?=(?:${verbs.join("|")})\\b)`;
  return text
    .split(/\s*;\s*|\s*,?\s+and\s+then\s+|\s*,\s*then\s+|\s+then\s+/iu)
    .flatMap((part) => part.split(new RegExp(`\\s*,?\\s+and\\s+${verbLookahead}|\\s*,\\s*${verbLookahead}`, "iu")))
    .map((part) => part.trim().replace(/^(?:and|also)\s+/iu, "").replace(/[,.]+$/u, "").trim())
    .filter((part) => part.length > 0);
}

export function parseAmount(raw: string, clause: string): AmountPhrase {
  const value = raw.trim().toLowerCase().replace(/\s+/gu, " ");
  const percent = /^(\d{1,3}(?:\.\d{1,2})?)%$/u.exec(value);
  if (percent) {
    const bps = Math.round(Number(percent[1]) * 100);
    if (bps <= 0 || bps > 10_000) throw clauseError(clause, "A percentage must be between 0 and 100.");
    return { type: "previous", portionBps: bps };
  }
  if (value === "half") return { type: "previous", portionBps: 5_000 };
  if (value === "quarter" || value === "a quarter") return { type: "previous", portionBps: 2_500 };
  if (["all", "max", "everything"].includes(value)) return { type: "previous", portionBps: 10_000, whole: true };
  if (["it", "them", "that"].includes(value)) return { type: "previous", portionBps: 10_000 };
  const usd = value.startsWith("$");
  let numeric = value.replace(/^\$/u, "");
  if (numeric.includes(",")) {
    // Commas are accepted only as thousands separators ("1,250.5"). "1,5" (a decimal comma) is refused, never read as 15.
    if (!/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u.test(numeric)) {
      throw clauseError(clause, `"${raw}" is ambiguous; use a dot for decimals (e.g. "1.5").`);
    }
    numeric = numeric.replace(/,/gu, "");
  }
  if (numeric.startsWith(".")) numeric = `0${numeric}`;
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(numeric) || /^0(?:\.0+)?$/u.test(numeric)) {
    throw clauseError(clause, `"${raw}" is not a positive amount.`);
  }
  return { type: "exact", value: numeric, usd };
}

export function networkFromGroup(raw: string | undefined, clause: string): NetworkKey | undefined {
  if (!raw) return undefined;
  const network = resolveNetworkName(raw);
  if (!network) throw clauseError(clause, `Unknown network "${raw}".`);
  return network;
}

function venueProtocol(raw: string | undefined, venues: readonly VenueWord[], clause: string): ProtocolId {
  const value = (raw ?? "").trim();
  const entry = venues.find((candidate) => candidate.pattern.test(value));
  if (!entry) throw clauseError(clause, `Unknown venue "${value.slice(0, 32)}".`);
  return entry.protocol;
}

/** A swap's venue filter as a draft: Jupiter on Solana with the encoded filter as the provider. */
function swapFilterDraft(groups: Record<string, string | undefined>, network: NetworkKey | undefined, clause: string): Partial<Draft> {
  const provider = swapFilterProvider(groups, network, clause);
  return provider ? { protocol: "jupiter", provider, network: network ?? "solana" } : {};
}

function lendingDraft(clause: string, kind: "deposit" | "withdraw", groups: Record<string, string | undefined>, amount: AmountPhrase, network: NetworkKey | undefined): Draft {
  const protocol = venueProtocol(groups.venue, LENDING_VENUES, clause);
  const exitGuide = kind === "withdraw" && !(getProtocol(protocol)?.kinds ?? []).includes("withdraw") ? EXIT_GUIDES[protocol] : undefined;
  if (exitGuide) throw clauseError(clause, exitGuide);
  const named = vaultOfVenueWord(protocol, groups.venue);
  const said = groups.vault?.toLowerCase();
  if (said && named && said !== named) throw clauseError(clause, `"${groups.venue}" is the ${named} venue; it cannot also be "${said}".`);
  const vault = said ?? named;
  if (vault && !VAULT_PROTOCOLS.includes(protocol)) {
    throw clauseError(clause, `Only Morpho, Spark Savings, Yearn, Kamino and Sky venues are named; say "${kind === "deposit" ? "into" : "from"} ${groups.venue ?? "the venue"}" without "${vault}".`);
  }
  // Bare "spark" names two protocols: the default (Spark Savings) is used and the alternative named.
  const bareSpark = protocol === "spark-savings" && /^spark$/iu.test((groups.venue ?? "").trim()) && !vault;
  return {
    clause,
    kind,
    amount,
    ...(groups.a ? { from: groups.a } : {}),
    protocol,
    ...(vault ? { venue: vault } : {}),
    ...(network ? { network } : {}),
    explicit: network !== undefined,
    ...(bareSpark ? { warnings: [`"spark" was read as Spark Savings; say "sparklend" to ${kind === "deposit" ? "lend on" : "withdraw from"} SparkLend instead.`] } : {}),
  };
}

function stakeDraft(clause: string, groups: Record<string, string | undefined>, amount: AmountPhrase, network: NetworkKey | undefined): Draft {
  const asset = groups.a?.toLowerCase();
  const word = groups.lst?.toLowerCase().replace(/[\s-]+/gu, " ");
  const evm = evmStakingToken(word);
  if (evm || asset === "eth") {
    if (asset === "sol") throw clauseError(clause, `${evm?.provider ?? "That provider"} stakes ETH on Ethereum, not SOL.`);
    if (word && !evm) throw clauseError(clause, `"${groups.lst}" stakes SOL on Solana, not ETH.`);
    return {
      clause,
      kind: "stake",
      amount,
      from: "ETH",
      lst: word ?? "lido",
      protocol: (evm ?? EVM_STAKING_TOKENS.lido)?.protocol as ProtocolId,
      ...(network ? { network } : {}),
      explicit: network !== undefined,
    };
  }
  return {
    clause,
    kind: "stake",
    amount,
    ...(asset ? { from: "SOL" } : {}),
    ...(word ? { lst: word } : {}),
    ...(network ? { network } : {}),
    explicit: network !== undefined,
  };
}

export function matchClause(clause: string): Draft {
  for (const pattern of PATTERNS) {
    const match = pattern.regex.exec(clause);
    if (!match?.groups) continue;
    const groups = match.groups;
    const amount = parseAmount(groups.amt ?? "", clause);
    const network = networkFromGroup(groups.net, clause);
    switch (pattern.kind) {
      case "swap":
      case "buy":
        return {
          clause,
          kind: "swap",
          amount,
          ...(groups.a ? { from: groups.a } : {}),
          ...(groups.b ? { to: groups.b } : {}),
          ...(network ? { network } : {}),
          ...(groups.dex ? { protocol: venueProtocol(groups.dex, SWAP_VENUES, clause) } : {}),
          ...swapFilterDraft(groups, network, clause),
          explicit: network !== undefined,
        };
      case "bridge": {
        // "move 10 USDC to op": a token or a network. Read as the network only after "from <network>" or with "as <token>".
        const said = clause.split(/\s+/u)[0]?.toLowerCase() ?? "";
        if (NEUTRAL_MOVE_VERBS.includes(said) && !groups.n1 && !groups.b && groups.n2 && Object.hasOwn(ASSET_NETWORK_WORDS, groups.n2.toLowerCase())) {
          const what = groups.amt && groups.a && /^[\d.,$]+$/u.test(groups.amt) ? `${groups.amt} ${groups.a.toUpperCase()}` : undefined;
          throw assetOrNetworkRefusal(clause, said, groups.n2, what);
        }
        const source = networkFromGroup(groups.n1, clause);
        const destination = networkFromGroup(groups.n2, clause);
        return {
          clause,
          kind: "bridge",
          amount,
          ...(groups.a ? { from: groups.a } : {}),
          ...(groups.b ? { to: groups.b } : {}),
          ...(source ? { network: source } : {}),
          ...(destination ? { toNetwork: destination } : {}),
          ...(groups.bridge ? { protocol: venueProtocol(groups.bridge, BRIDGE_VENUES, clause) } : {}),
          explicit: source !== undefined,
        };
      }
      case "transfer":
        if (groups.pay && network && CHAINS[network].vm !== "svm") throw clauseError(clause, `Solana Pay runs on Solana, not on ${CHAINS[network].name}.`);
        return {
          clause,
          kind: "transfer",
          amount,
          ...(groups.a ? { from: groups.a } : {}),
          ...(groups.addr ? { recipient: groups.addr } : {}),
          ...(network ? { network } : groups.pay ? { network: "solana" as const } : {}),
          ...(groups.pay ? { protocol: SOLANA_PAY_PROTOCOL } : {}),
          explicit: network !== undefined || (groups.addr ?? "").includes(":"),
        };
      case "stake":
        return stakeDraft(clause, groups, amount, network);
      case "native-stake":
        return {
          clause,
          kind: "stake",
          amount,
          ...(groups.a ? { from: "SOL" } : {}),
          native: groups.vote ? { vote: groups.vote } : {},
          protocol: NATIVE_STAKE_PROTOCOL,
          ...(network ? { network } : {}),
          explicit: network !== undefined,
        };
      case "deposit":
      case "withdraw":
        return lendingDraft(clause, pattern.kind, groups, amount, network);
      default:
        break;
    }
  }
  const verb = clause.split(/\s+/u)[0]?.toLowerCase() ?? "";
  if (BORROW_VERBS.includes(verb)) throw borrowRefusal(clause, verb);
  const venueless = venuelessDeposit(clause);
  if (venueless) throw venueless;
  const rates = readOnlyRates(clause);
  if (rates) throw readOnlyRatesRefusal(rates, GRAMMAR_EXAMPLES);
  const reason = VERBS.includes(verb)
    ? `"${clause.slice(0, 120)}" does not match a supported "${verb}" sentence.`
    : `"${verb.slice(0, 32)}" is not a supported action.`;
  throw unsupported(
    `${reason} Supported actions: swap, buy, bridge/move, send/transfer/pay, stake (SOL, or ETH on Ethereum), deposit/supply/lend into and withdraw from ${LENDING_NAMES}.`,
    GRAMMAR_EXAMPLES,
    [{ path: "text", message: `Could not interpret "${clause.slice(0, 120)}".` }],
  );
}
