/**
 * The relaxed slot reader (clarify design §4.2): each clause of a message is
 * matched by the grammar's own sentence shapes with every slot optional, so
 * "swap SOL to USDC" reads as a swap with no amount instead of a refusal.
 * Fragments come from grammar.ts (SENTENCE_FRAGMENTS and the venue words);
 * keyword typos are corrected only when exactly one word is close (§4.3);
 * contract aliases go through the grammar's matchContractPhrase (§4.11).
 */
import { normalizeMessage, SENTENCE_VERBS, type NetworkKey, type ThreadAmount } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import {
  BORROW_VERBS,
  borrowRefusal,
  BRIDGE_WORDS,
  GRAMMAR_VENUE_WORDS,
  LENDING_WORDS,
  LST_WORDS,
  matchContractPhrase,
  NAME,
  NETWORK_WORDS,
  resolveNetworkName,
  splitClauses,
  SWAP_VENUE_WORDS,
  VAULT,
  VERBS,
  NATIVE_STAKE_PROTOCOL,
} from "../grammar.js";
import type { ContractPhrase } from "../contracts/directory.js";
import { candidates } from "./fuzzy.js";
import { readOnlyRates, readOnlyRatesRefusal } from "../readOnly.js";
import { readClause, spellNumbers, stripLabel, symbolTypoCandidates } from "../goal/index.js";
import {
  bridgeProtocol,
  dexProtocol,
  isUsdWord,
  knownSymbol,
  lendingProtocol,
  providerFromWord,
  stakeProvider,
  USD_ORDER,
} from "./catalog.js";
import type { Kind, Slot, WorkStep } from "./types.js";
import type { ThreadCorrection } from "@kletia/core";

const AMT =
  "(?<amt>\\d{1,3}(?:\\.\\d{1,2})?%|\\$\\d[\\d,]*(?:\\.\\d+)?|\\d[\\d,]*(?:\\.\\d+)?|\\.\\d+|all|max|everything|it|them|that|half|a\\s+quarter|quarter)";
const OF = "(?:\\s+of\\s+(?:it|them|that|the\\s+output|the\\s+proceeds))?";
const GUARD = "(?!(?:to|for|into|onto|with|using|from|on|as|via|in|at|my|of)\\b)";
const SYM = (name: string) => `${GUARD}(?<${name}>(?:eip155|solana):\\S+|[A-Za-z0-9$][\\w.\\-]{0,63})`;
const NET = (name: string) => `(?<${name}>${NETWORK_WORDS})`;
const ADDR = `(?:0x[0-9a-fA-F]{40}|(?:eip155|solana):\\S+|${NAME}|[1-9A-HJ-NP-Za-km-z]{32,44})`;
const MY = "(?:(?:of\\s+)?(?<my>my)\\s+)?";
const ON = `(?:\\s+(?:on|in)\\s+${NET("net")})?`;
const DEX = `(?:\\s+(?:via|using|through|with)\\s+(?<dex>${SWAP_VENUE_WORDS}))?`;
/** A swap names its network and venue in either order. */
const SWAP_SUFFIXES = [`${ON}${DEX}`, `${DEX}${ON}`];

const rx = (source: string) => new RegExp(source, "iu");

const SHAPES: readonly { shape: "usdSwap" | "earn" | "swap" | "buy" | "bridge" | "transfer" | "transferLabel" | "stake" | "deposit" | "withdraw"; regex: RegExp }[] = [
  ...SWAP_SUFFIXES.map((suffix) => ({
    shape: "usdSwap" as const,
    regex: rx(`^(?<verb>swap|convert|trade|exchange|sell)\\s+(?<usd>\\$\\d[\\d,]*(?:\\.\\d+)?)\\s+(?:of|worth\\s+of)\\s+${MY}${SYM("a")}(?:\\s+(?:to|for|into)\\s+${SYM("b")})?${suffix}$`),
  })),
  { shape: "earn", regex: rx(`^(?:earn|get)\\s+(?:yield|interest)\\s+(?:on|with|from)\\s+(?:${AMT}\\s+)?${MY}${SYM("a")}${ON}$`) },
  ...SWAP_SUFFIXES.map((suffix) => ({
    shape: "swap" as const,
    regex: rx(`^(?<verb>swap|convert|trade|exchange|sell)(?:\\s+${AMT}${OF})?\\s*${MY}(?:${SYM("a")})?(?:\\s+(?:to|for|into)\\s+${SYM("b")})?${suffix}$`),
  })),
  ...SWAP_SUFFIXES.map((suffix) => ({
    shape: "buy" as const,
    regex: rx(`^(?<verb>buy|get|purchase)(?:\\s+me)?(?:\\s+some)?\\s+${SYM("b")}(?:\\s+(?:with|using)(?:\\s+${AMT}${OF})?\\s*${MY}(?:${SYM("a")})?)?${suffix}$`),
  })),
  {
    shape: "bridge",
    regex: rx(
      `^(?<verb>bridge|move|send|transfer|port)(?:\\s+${AMT}${OF})?\\s*${MY}(?:${SYM("a")})?(?:\\s+from\\s+${NET("n1")})?(?:\\s+(?:to|into|onto)\\s+${NET("n2")})?` +
        `(?:\\s+(?:as|into|for)\\s+${SYM("b")})?(?:\\s+(?:via|using|through|with|over)\\s+(?<bridge>${BRIDGE_WORDS}))?$`,
    ),
  },
  { shape: "transfer", regex: rx(`^(?<verb>send|transfer|pay)(?:\\s+${AMT}${OF})?\\s*${MY}(?:${SYM("a")})?(?:\\s+to\\s+(?<rcpt>${ADDR}))?${ON}$`) },
  {
    shape: "transferLabel",
    regex: rx(`^(?<verb>send|transfer|pay)(?:\\s+${AMT}${OF})?\\s*${MY}(?:${SYM("a")})?\\s+to\\s+(?<label>(?:my\\s+)?[a-z][a-z0-9-]{1,40}(?:\\s+[a-z][a-z0-9-]{1,20})?)${ON}$`),
  },
  {
    shape: "stake",
    regex: rx(`^stake(?:\\s+${AMT}${OF})?\\s*${MY}(?:(?<a>sol|eth))?(?:\\s+(?<natively>natively)|\\s+(?:with|via|on|using|into|to|as|at)\\s+(?<lst>${LST_WORDS}))?${ON}$`),
  },
  {
    shape: "deposit",
    regex: rx(
      `^(?<verb>deposit|supply|lend|put|place|invest)(?:\\s+${AMT}${OF})?\\s*${MY}(?:${SYM("a")})?(?:\\s+(?:into|to|on|in|at|with)\\s+(?:the\\s+)?(?<venue>${LENDING_WORDS})(?:\\s+${VAULT})?(?:\\s+vault)?)?${ON}$`,
    ),
  },
  {
    shape: "withdraw",
    regex: rx(
      `^(?<verb>withdraw|redeem)(?:\\s+${AMT}${OF})?\\s*${MY}(?:${SYM("a")})?\\s+(?:from|out\\s+of)\\s+(?:my\\s+)?(?:the\\s+)?(?<venue>${LENDING_WORDS})(?:\\s+${VAULT})?(?:\\s+(?:vault|position))?${ON}$`,
    ),
  },
];

/* ------------------------------------------------------- vocabularies */

const VERB_VOCAB: readonly string[] = VERBS;
const CONNECTOR_VOCAB = ["from", "into", "onto", "with", "using", "through", "then"];
const NETWORK_VOCAB = ["base", "arbitrum", "ethereum", "optimism", "polygon", "solana", "devnet", "sepolia", "mainnet"];
/** Single venue and provider words of the grammar ("aave", "kamino", "jito", "uniswap", ...). */
const VENUE_VOCAB: readonly string[] = [...new Set(GRAMMAR_VENUE_WORDS.flatMap((word) => word.split(/[\s.-]+/u)).filter((word) => /^[a-z]{4,}$/u.test(word)))]
  .filter((word) => !["vault", "vaults", "lend", "earn", "lending", "savings", "pool"].includes(word));
const FILLER = new Set([
  "my", "the", "of", "all", "half", "max", "everything", "it", "them", "that", "some", "me", "a", "an", "quarter", "instead", "and", "to", "on", "in",
  "at", "as", "for", "via", "vault", "position", "yield", "interest", "lend", "earn", "v3", "out", "savings", "pool",
]);

/** Reads an amount word: exact, a share of the previous output, or a share of the balance (first steps). */
export function parseAmountText(raw: string, previousExists: boolean): ThreadAmount & { usd?: boolean } {
  const value = raw.trim().toLowerCase().replace(/\s+/gu, " ");
  const percent = /^(\d{1,3}(?:\.\d{1,2})?)%$/u.exec(value);
  const share = (bps: number): ThreadAmount => (previousExists ? { t: "previous", bps } : { t: "balance", bps });
  if (percent) {
    const bps = Math.round(Number(percent[1]) * 100);
    if (bps <= 0 || bps > 10_000) throw new PlatformError("INTENT_UNSUPPORTED", "A percentage must be between 0 and 100.", 422);
    return share(bps);
  }
  if (value === "half") return share(5_000);
  if (value === "quarter" || value === "a quarter") return share(2_500);
  if (["all", "max", "everything"].includes(value)) return share(10_000);
  if (["it", "them", "that"].includes(value)) {
    if (!previousExists) throw new PlatformError("INTENT_UNSUPPORTED", "\"it\" refers to a previous step; give an amount.", 422);
    return { t: "previous", bps: 10_000 };
  }
  const usd = value.startsWith("$");
  let numeric = value.replace(/^\$/u, "");
  const raw40 = value.slice(0, 40);
  if (/^\d+,\d{1,2}$/u.test(numeric)) return { t: "exact", value: numeric.replace(",", "."), raw: raw40, ...(usd ? { usd } : {}) };
  if (numeric.includes(",")) {
    if (!/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u.test(numeric)) {
      throw new PlatformError("INTENT_UNSUPPORTED", "That amount is not clear; use a dot for decimals (for example 1.5).", 422);
    }
    numeric = numeric.replace(/,/gu, "");
  }
  if (numeric.startsWith(".")) numeric = `0${numeric}`;
  if (!/^(?:0|[1-9]\d{0,29})(?:\.\d{1,30})?$/u.test(numeric) || /^0(?:\.0+)?$/u.test(numeric)) {
    throw new PlatformError("INTENT_UNSUPPORTED", "The amount is not a positive number.", 422);
  }
  return { t: "exact", value: numeric, ...(value !== numeric ? { raw: raw40 } : {}), ...(usd ? { usd } : {}) };
}

function slot<T>(v: T, by: Slot<T>["by"] = "user"): Slot<T> {
  return { v, by };
}

function assetToken(raw: string | undefined): { symbol?: string; usd?: boolean } {
  if (!raw) return {};
  if (isUsdWord(raw)) return { usd: true };
  return { symbol: raw };
}

/** Stores a parsed amount: "$25" of a non-dollar token is a USD amount, "$25" alone pays in a stablecoin. */
function amountSlot(step: WorkStep, amount: ThreadAmount & { usd?: boolean }): void {
  if (amount.t === "exact" && amount.usd) {
    const { usd: _usd, ...plain } = amount;
    if (step.from && !USD_ORDER.includes(step.from.v.toUpperCase())) step.amount = slot({ t: "usd", value: plain.value });
    else {
      step.amount = slot(plain);
      if (!step.from) step.usdFrom = true;
    }
    return;
  }
  step.amount = slot(amount);
}

function network(raw: string | undefined): NetworkKey | null {
  return raw ? resolveNetworkName(raw) : null;
}

/** Words a contract phrase is said in: the first registered alias the clause names (longest first). */
function contractWords(clause: string, phrases: readonly ContractPhrase[]): { alias: string; verb: string } | null {
  const lower = clause.toLowerCase().replace(/\s+/gu, " ");
  const verb = lower.split(" ", 1)[0] ?? "";
  const aliases = [...new Set(phrases.flatMap((phrase) => phrase.aliases))].sort((a, b) => b.length - a.length);
  const alias = aliases.find((entry) => new RegExp(`(?:^|\\s)${entry.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?:\\s|$)`, "u").test(lower));
  return alias && /^[a-z]{2,16}$/u.test(verb) ? { alias, verb } : null;
}

/** A contract clause (bring-your-own-contract alias) as slots, or null when the clause names no registered alias. */
function parseContractClause(clause: string, phrases: readonly ContractPhrase[], index: number, previousExists: boolean): WorkStep | null {
  if (phrases.length === 0) return null;
  const match = matchContractPhrase(clause, phrases, { index });
  if (!match) return null;
  const words = contractWords(clause, phrases);
  if (!words) return null;
  const step: WorkStep = { contract: slot(`${words.alias}#${words.verb}`) };
  const amountMatch = new RegExp(`^\\S+\\s+${AMT}(?:\\s+(?<a>[A-Za-z][\\w.-]{0,63}))?\\s`, "iu").exec(clause);
  const objectMatch = /^\S+\s+(?:my\s+)?(?<obj>[a-z][a-z0-9.-]{0,31})\s+(?:into|to|in|on|at|with|via|using|through|from|out\s+of)\s/iu.exec(clause);
  if ("action" in match) {
    step.kind = slot(match.action.kind as Kind);
    step.network = slot(match.action.network, match.explicit ? "user" : "derived");
    if (match.action.from) step.from = slot(match.action.from);
  } else {
    step.kind = slot(phrases.find((phrase) => phrase.aliases.includes(words.alias))?.vm === "svm" ? "action" : "call");
    const symbol = amountMatch?.groups?.a ?? (amountMatch ? undefined : objectMatch?.groups?.obj);
    if (symbol && knownSymbol(symbol)) step.from = slot(symbol);
  }
  const named = new RegExp(`\\s(?:on|in)\\s+${NET("net")}$`, "iu").exec(clause)?.groups?.net;
  const said = network(named);
  if (said) step.network = slot(said);
  if (amountMatch?.groups?.amt) amountSlot(step, parseAmountText(amountMatch.groups.amt, previousExists));
  return step;
}

/** Step kinds where "my X" with no number is all of it (F8 in the strict reader). */
const POSSESSIVE_WHOLE: ReadonlySet<Kind> = new Set(["stake", "deposit", "withdraw"]);

/**
 * F8 in the strict reader: "stake my SOL", "earn yield on my USDC", "withdraw
 * my USDC from aave" mean all of it. Only for moves between the wallet and a
 * venue (stake, deposit, withdraw), which keep the same asset in the person's
 * control; a swap, bridge or transfer of "my SOL" still asks how much (clarify
 * corpus B02): converting or paying out a whole holding is never read from a
 * possessive alone. A first step only (after a step, "my SOL" might mean the
 * balance or the step's output) and only when the asset itself is named.
 * "my USDC from aave" is the whole position; a wallet holding is marked
 * `possessive` and the policy makes it all of it only when one network holds
 * the asset (or the sentence names the network), else it asks how much (D4).
 */
function possessiveWhole(step: WorkStep, g: Record<string, string | undefined>, previousExists: boolean): void {
  if (!g.my || !g.a || previousExists || step.amount || !step.kind || !POSSESSIVE_WHOLE.has(step.kind.v)) return;
  if (step.kind.v === "withdraw") step.amount = slot({ t: "position", bps: 10_000 });
  else step.possessive = true;
}

/** One clause as slots, or null when no relaxed shape matches. */
function parseClause(clause: string, previousExists: boolean): WorkStep | null {
  for (const { shape, regex } of SHAPES) {
    const match = regex.exec(clause);
    if (!match?.groups) continue;
    const g = match.groups;
    const verb = (g.verb ?? shape).toLowerCase();
    const out: WorkStep = {};
    const a = assetToken(g.a);
    if (a.symbol) out.from = slot(a.symbol);
    if (a.usd) out.usdFrom = true;
    const b = assetToken(g.b);
    const net = network(g.net);
    if (net) out.network = slot(net);
    switch (shape) {
      case "usdSwap":
        out.kind = slot("swap");
        if (verb === "sell") out.sell = true;
        out.amount = slot({ t: "usd", value: (g.usd as string).replace(/[$,]/gu, "") });
        if (b.symbol) out.to = slot(b.symbol);
        if (b.usd) out.usdTo = true;
        if (g.dex) {
          const protocol = dexProtocol(g.dex);
          if (protocol) out.protocol = slot(protocol);
        }
        return out;
      case "earn":
        out.kind = slot("deposit");
        if (g.amt) amountSlot(out, parseAmountText(g.amt, previousExists));
        else possessiveWhole(out, g, previousExists);
        return out;
      case "swap":
        if (!g.amt && !g.a) continue;
        out.kind = slot("swap");
        if (verb === "sell") out.sell = true;
        if (b.symbol) out.to = slot(b.symbol);
        if (b.usd) out.usdTo = true;
        break;
      case "buy":
        out.kind = slot("swap");
        out.buy = true;
        if (b.symbol) out.to = slot(b.symbol);
        if (b.usd) out.usdTo = true;
        break;
      case "bridge": {
        // "send 5 USDC" is a transfer without a recipient; only bridge/move/port mean a bridge without a network.
        if (!(g.n1 || g.n2) && !["bridge", "move", "port"].includes(verb)) continue;
        out.kind = slot("bridge");
        const source = network(g.n1);
        const destination = network(g.n2);
        if (source) out.network = slot(source);
        if (destination) out.toNetwork = slot(destination);
        if (b.symbol) out.to = slot(b.symbol);
        if (b.usd) out.usdTo = true;
        if (g.bridge) {
          const protocol = bridgeProtocol(g.bridge);
          if (protocol) out.protocol = slot(protocol);
        }
        break;
      }
      case "transfer":
        out.kind = slot("transfer");
        if (g.rcpt) out.recipient = slot(g.rcpt);
        break;
      case "transferLabel": {
        const label = (g.label as string).toLowerCase();
        if (resolveNetworkName(label)) continue;
        out.kind = slot("transfer");
        // The word itself is never kept: Kletia never looks up or completes a nickname.
        out.nickname = true;
        break;
      }
      case "stake": {
        out.kind = slot("stake");
        // "stake 2 SOL natively": native staking to a validator, read without a connector (grammar "native-stake").
        const provider = g.natively ? stakeProvider(NATIVE_STAKE_PROTOCOL) : g.lst ? providerFromWord(g.lst) : undefined;
        const said = g.a?.toUpperCase();
        const input = said === "ETH" || said === "SOL" ? said : provider?.input ?? "SOL";
        out.from = slot(input, said ? "user" : "derived");
        if (provider) out.provider = slot(provider.id);
        break;
      }
      case "deposit":
      case "withdraw": {
        out.kind = slot(shape);
        if (g.venue) {
          const protocol = lendingProtocol(g.venue);
          if (protocol) out.protocol = slot(protocol);
        }
        if (g.vault) {
          // "lend 100 USDC on aave base": a network word after the venue is the network, not a vault slug.
          const vaultNetwork = network(g.vault);
          if (vaultNetwork && !net) out.network = slot(vaultNetwork);
          else out.vault = slot(g.vault.toLowerCase());
        }
        break;
      }
    }
    if (g.dex && out.kind?.v === "swap") {
      const protocol = dexProtocol(g.dex);
      if (protocol) out.protocol = slot(protocol);
    }
    if (g.amt) {
      amountSlot(out, parseAmountText(g.amt, previousExists));
      const amount = out.amount?.v;
      if (shape === "withdraw" && amount && (amount.t === "balance" || (amount.t === "previous" && !previousExists))) {
        out.amount = slot({ t: "position", bps: amount.bps });
      }
    } else {
      possessiveWhole(out, g, previousExists);
    }
    return out;
  }
  return null;
}

/** "swap 1 SOL too USDC", "fo USDC": slips of "to" and "for" (only tried when the clause does not read as typed). */
const SHORT_CONNECTOR_SLIPS: Readonly<Record<string, string>> = Object.freeze({ too: "to", fo: "for" });

function correctClause(clause: string, index: number): { text: string; corrections: ThreadCorrection[]; verbCandidates?: string[] } {
  const corrections: ThreadCorrection[] = [];
  let verbCandidates: string[] | undefined;
  const out = clause.split(/\s+/u).map((token, position) => {
    const lower = token.toLowerCase();
    // Never touched: numbers, addresses, names, CAIP ids, symbols, known words (R8, R14).
    if (!/^[a-z]+$/u.test(lower) || FILLER.has(lower) || knownSymbol(lower) || Object.hasOwn(SENTENCE_VERBS, lower) || resolveNetworkName(lower)) return token;
    if (CONNECTOR_VOCAB.includes(lower) || VENUE_VOCAB.includes(lower) || NETWORK_VOCAB.includes(lower)) return token;
    if (position === 0) {
      const verbs = candidates(lower, VERB_VOCAB);
      if (verbs.length === 1) {
        corrections.push({ field: `actions[${index}].kind`, from: token.slice(0, 16), to: verbs[0] as string, material: true });
        return verbs[0] as string;
      }
      if (verbs.length > 1) verbCandidates = verbs;
      return token;
    }
    // Short connectors are too short for the edit-distance reader: a fixed list of their usual slips.
    const connector = SHORT_CONNECTOR_SLIPS[lower];
    if (connector) {
      corrections.push({ field: `actions[${index}].text`, from: token.slice(0, 16), to: connector, material: false });
      return connector;
    }
    const found = candidates(lower, [...CONNECTOR_VOCAB, ...NETWORK_VOCAB, ...VENUE_VOCAB]);
    if (found.length !== 1) return token;
    const to = found[0] as string;
    const name = NETWORK_VOCAB.includes(to) ? "network" : VENUE_VOCAB.includes(to) ? "protocol" : "text";
    corrections.push({ field: `actions[${index}].${name}`, from: token.slice(0, 16), to, material: name !== "text" });
    return to;
  });
  return { text: out.join(" "), corrections, ...(verbCandidates ? { verbCandidates } : {}) };
}

export interface ParsedSentence {
  readonly steps: WorkStep[];
  readonly corrections: ThreadCorrection[];
}

/** Nouns that name no asset ("swap some tokens", "stake something"). */
const VAGUE_NOUNS: ReadonlySet<string> = new Set([
  "stuff", "something", "anything", "token", "tokens", "coin", "coins", "crypto", "cryptos", "money", "funds", "cash", "assets",
]);
/** Words around them that add nothing ("some", "a bit of", "my", "please"). */
const VAGUE_WORDS: ReadonlySet<string> = new Set([...VAGUE_NOUNS, "some", "few", "bit", "little", "of", "my", "the", "a", "an", "me", "please"]);

/**
 * A clause that names an action but nothing it acts on ("swap", "swap some
 * tokens", "stake something"): the action alone, so the policy asks for what
 * is missing instead of refusing. Anything else in the clause (an unknown
 * word, a number) keeps it unread.
 */
function vagueClause(clause: string, bare: boolean): WorkStep | null {
  const [verb = "", ...rest] = clause.toLowerCase().replace(/[.!?]+$/u, "").split(/\s+/u);
  if (!Object.hasOwn(SENTENCE_VERBS, verb)) return null;
  if (!rest.every((word) => VAGUE_WORDS.has(word))) return null;
  // Read first only when a vague noun stands where the asset would; a bare verb only when nothing else reads.
  if (!bare && !rest.some((word) => VAGUE_NOUNS.has(word))) return null;
  const kind = SENTENCE_VERBS[verb] as Kind;
  const step: WorkStep = { kind: slot(kind), vague: true };
  if (verb === "buy" || verb === "get" || verb === "purchase") step.buy = true;
  if (verb === "sell") step.sell = true;
  return step;
}

/** Example sentences sent with a refusal (`hints`), so the reader sees what does work. */
const REFUSAL_EXAMPLES: readonly string[] = Object.freeze([
  "swap 1 SOL to USDC",
  "bridge 25 USDC from base to solana",
  "send 5 USDC to vitalik.eth on base",
  "stake 1.5 SOL with marinade",
  "deposit 100 USDC into aave on base",
]);

function notUnderstood(clause: string): PlatformError {
  const verb = clause.split(/\s+/u)[0]?.toLowerCase() ?? "";
  // "borrow" and "repay" are lending actions Kletia does not run yet: said so, in every path.
  if (BORROW_VERBS.includes(verb)) {
    const refusal = borrowRefusal(clause, verb);
    return new PlatformError("INTENT_UNSUPPORTED", refusal.message, 422, refusal.issues, REFUSAL_EXAMPLES);
  }
  // "show live Aave rates": a read-only question, answered by GET /v1/venues (details say so).
  const rates = readOnlyRates(clause);
  if (rates) return readOnlyRatesRefusal(rates, REFUSAL_EXAMPLES);
  return new PlatformError(
    "INTENT_UNSUPPORTED",
    Object.hasOwn(SENTENCE_VERBS, verb)
      ? `Kletia could not read "${clause.slice(0, 120)}" as a ${verb} it can plan. Name the token and the amount, as in the examples.`
      : `Kletia cannot do "${clause.slice(0, 60)}". It can swap, buy, bridge, send, stake, deposit and withdraw tokens.`,
    422,
    [{ path: "text", message: "Could not read this clause." }],
    REFUSAL_EXAMPLES,
  );
}

/** ASSET_TYPO (D9): an unknown symbol within one edit of listed symbols ("SLO" for SOL), flagged for the policy. */
function flagAssetTypo(step: WorkStep): void {
  if (step.assetTypo) return;
  for (const field of ["from", "to"] as const) {
    const said = step[field];
    if (!said || said.by !== "user") continue;
    const found = symbolTypoCandidates(said.v);
    if (found.length > 0) {
      step.assetTypo = { field, raw: said.v.slice(0, 16), candidates: found };
      return;
    }
  }
}

/** Step kinds that spend the previous step's output when their clause names neither an amount nor an asset. */
const CHAINABLE: ReadonlySet<Kind> = new Set(["swap", "bridge", "transfer", "deposit", "stake"]);

/**
 * "swap 1 SOL to USDC, bridge to base, deposit into aave": a later clause with
 * no amount and no asset continues with what the step before produced, as if
 * it said "it" (F9). Stake's derived input (SOL) counts as unsaid.
 */
function chainImplicit(step: WorkStep, previous: boolean): void {
  if (!previous || step.amount || step.usdFrom || step.contract || step.goal) return;
  if (!step.kind || !CHAINABLE.has(step.kind.v)) return;
  if (step.from && step.from.by === "user") return;
  if (step.kind.v === "stake" && step.from) delete step.from;
  step.amount = slot({ t: "previous", bps: 10_000 }, "derived");
}

/** A message as slots for every clause (1 to 8); unique keyword typos are corrected (R9, R10). */
export function parseSentence(raw: string, phrases: readonly ContractPhrase[], previousExists = false, offset = 0): ParsedSentence {
  // Compound number words ("twenty five") become digits first; single ones are the core normaliser's.
  const labelled = stripLabel(normalizeMessage(spellNumbers(raw, 2)));
  const text = labelled.text;
  if (!text) throw new PlatformError("INTENT_UNSUPPORTED", "The message is empty.", 422);
  const extraVerbs = phrases.flatMap((phrase) => phrase.verbs);
  const clauses = splitClauses(text, extraVerbs);
  if (clauses.length === 0 || clauses.length > 8) throw new PlatformError("INTENT_UNSUPPORTED", "Say what should happen in one to eight steps.", 422);
  const steps: WorkStep[] = [];
  // The label is kept only as a note (a non-material ".text" correction, never shown as a chip or read as a slot).
  const corrections: ThreadCorrection[] = labelled.label ? [{ field: `actions[${offset}].text`, from: labelled.label.slice(0, 16), to: "note", material: false }] : [];
  clauses.forEach((clause, i) => {
    const index = steps.length + offset;
    const previous = previousExists || steps.length > 0;
    let parsed = parseContractClause(clause, phrases, index, previous) ?? vagueClause(clause, false) ?? parseClause(clause, previous);
    let fixed: ReturnType<typeof correctClause> | undefined;
    if (!parsed) {
      fixed = correctClause(clause, index);
      parsed = parseClause(fixed.text, previous);
      if (parsed) corrections.push(...fixed.corrections);
      if (!parsed && fixed.verbCandidates) {
        // R9: only verbs that make the rest of the clause read are candidates; one left is a correction.
        const rest = fixed.text.split(/\s+/u).slice(1).join(" ");
        const fitting = fixed.verbCandidates.filter((verb) => parseClause(`${verb} ${rest}`, previous) !== null);
        const kinds = [...new Set(fitting.map((verb) => SENTENCE_VERBS[verb] as Kind))];
        if (kinds.length === 1) {
          parsed = parseClause(`${fitting[0]} ${rest}`, previous);
          corrections.push(...fixed.corrections, { field: `actions[${index}].kind`, from: (clause.split(/\s+/u)[0] ?? "").slice(0, 16), to: fitting[0] as string, material: true });
        } else if (kinds.length > 1) {
          const probe = parseClause(`${fitting[0]} ${rest}`, previous) as WorkStep;
          delete probe.kind;
          probe.kindCandidates = kinds;
          parsed = probe;
        }
      }
    }
    let read: WorkStep[] = parsed ? [parsed] : [];
    if (!parsed) {
      // Intent engine v2 §3.4: the Goal reader, only when the strict reader (with typo correction) found nothing.
      const options = { previousExists: previous, index, strict: (piece: string, before: boolean) => parseClause(piece, before) };
      let reading = readClause(clause, options);
      // Keyword typos may help the Goal reader too, but never a corrected verb: "unstake" is not "stake".
      if (!reading && fixed && fixed.text !== clause && !fixed.corrections.some((entry) => entry.field.endsWith(".kind")) && !fixed.verbCandidates) {
        reading = readClause(fixed.text, options);
        if (reading) corrections.push(...fixed.corrections);
      }
      if (!reading) {
        const vague = vagueClause(clause, true);
        if (!vague) throw notUnderstood(clause);
        read = [vague];
      } else {
        corrections.push(...reading.corrections);
        read = reading.steps;
      }
    }
    read.forEach((step, position) => {
      const at = index + position;
      chainImplicit(step, previous || position > 0);
      flagAssetTypo(step);
      const amount = step.amount?.v;
      if (amount?.t === "exact" && amount.raw && /^\$?\d+,\d{1,2}$/u.test(amount.raw)) {
        corrections.push({ field: `actions[${at}].amount`, from: amount.raw.slice(0, 16), to: amount.value, material: true });
      }
      steps.push(step);
    });
  });
  if (steps.length === 0) throw notUnderstood(text);
  if (steps.length > 8) throw new PlatformError("INTENT_UNSUPPORTED", "Say what should happen in one to eight steps.", 422);
  return { steps, corrections };
}
