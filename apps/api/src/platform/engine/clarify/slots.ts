/**
 * The relaxed slot reader (clarify design §4.2): each clause of a message is
 * matched by the grammar's own sentence shapes with every slot optional, so
 * "swap SOL to USDC" reads as a swap with no amount instead of a refusal.
 * Fragments come from grammar.ts (SENTENCE_FRAGMENTS and the venue words);
 * keyword typos are corrected only when exactly one word is close (§4.3);
 * contract aliases go through the grammar's matchContractPhrase (§4.11).
 */
import { lookalikeFamilyOf, NEVER_DROP, normalizeMessage, scanClosedClass, screenText, SENTENCE_VERBS, type NetworkKey, type ThreadAmount } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import {
  ASSET_NETWORK_WORDS,
  assetOrNetworkRefusal,
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
  NEUTRAL_MOVE_VERBS,
} from "../grammar.js";
import type { ContractPhrase } from "../contracts/directory.js";
import { candidates, keywordCandidates } from "./fuzzy.js";
import { isEnglishWord } from "./englishWords.js";
import { hasQuestionMark, questionRefusal, readOnlyRates, readOnlyRatesRefusal } from "../readOnly.js";
import { abstractClause, EXACT_OF_PREVIOUS, lex, normalizeClause, readClause, spellNumbers, stripLabel, symbolTypoCandidates, type Token } from "../goal/index.js";
import { amountInWords, groupedThousands } from "../goal/amounts.js";
import {
  clauseRecord,
  closedClassError,
  consumable,
  dropFillers,
  nonLatinRefusal,
  openerOf,
  unconsumed,
  unsupportedNetwork,
} from "../goal/closedClass.js";
import { CLOSED_CLASS_COPY } from "./copy.js";
import {
  bridgeProtocol,
  canonicalOn,
  dexProtocol,
  lane,
  NETWORK_ORDER,
  isUsdWord,
  knownSymbol,
  lendingProtocol,
  providerFromWord,
  stakeProvider,
  USD_ORDER,
} from "./catalog.js";
import type { Kind, Slot, UnreadClause, WorkStep } from "./types.js";
import type { Goal, ThreadCorrection, ThreadKeep } from "@kletia/core";

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
/**
 * Every word the keyword corrector may correct into (verbs at the start of a
 * clause; connectors, networks and venues elsewhere). The drift test pins it
 * to the list clarify/englishWords.ts was reviewed against.
 */
export const KEYWORD_VOCABULARY: readonly string[] = Object.freeze([...VERB_VOCAB, ...CONNECTOR_VOCAB, ...NETWORK_VOCAB, ...VENUE_VOCAB]);
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

/** A portion word as the whole amount ("half", "a quarter"): read as a share only with evidence ("of it", "my"). */
const PORTION_AMOUNT = /^(?:half|a\s+quarter|quarter)$/iu;

/** True when the portion word stands right before the token ("half sol"), with no "my" / "of" between them. */
function bareOf(clause: string, amount: string, asset: string): boolean {
  const escape = (text: string) => text.trim().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/\s+/gu, "\\s+");
  return new RegExp(`(?:^|\\s)${escape(amount)}\\s+${escape(asset)}(?:\\s|$)`, "iu").test(clause);
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
    if (g.amt && g.a && PORTION_AMOUNT.test(g.amt.trim()) && bareOf(clause, g.amt, g.a)) {
      // Portion evidence (design A.2, WP6, red-team A4): "swap half sol" says neither "half my SOL" nor "half a SOL";
      // the amount is asked (with "Half" among the options), never read as a share of the balance.
    } else if (g.amt) {
      // WP2 (design A.2 binding): "all my SOL", "half of my USDC" is a share of the holding, never of the previous
      // step's output, even after another step.
      amountSlot(out, parseAmountText(g.amt, previousExists && !(g.my && g.a)));
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

/**
 * "swap 1 SOL too USDC", "fo USDC", "bridge 25 USDC form base": reviewed
 * spellings of "to", "for" and "from" (only tried when the clause does not
 * read as typed). A connector spelling is a lexicon entry, not a correction
 * into a keyword: it names no token, amount, network or venue (design A.2 L2).
 */
const SHORT_CONNECTOR_SLIPS: Readonly<Record<string, string>> = Object.freeze({ too: "to", fo: "for", form: "from" });

/** Single closed-class words (never corrected into a keyword, never corrected at all: design A.2 L2, I12). */
const CLOSED_WORDS: ReadonlySet<string> = new Set(NEVER_DROP.map((entry) => entry.phrase).filter((phrase) => /^[a-z']+$/u.test(phrase)));

/** At most this many keyword corrections per clause (design A.2 L2); more and the clause is not read as corrected. */
const MAX_CORRECTIONS = 2;

function correctClause(clause: string, index: number): { text: string; corrections: ThreadCorrection[]; verbCandidates?: string[]; verbEnglish?: true } {
  const corrections: ThreadCorrection[] = [];
  let verbCandidates: string[] | undefined;
  let verbEnglish = false;
  const out = clause.split(/\s+/u).map((token, position) => {
    const lower = token.toLowerCase();
    // Never touched: numbers, addresses, names, CAIP ids, symbols, known words (R8, R14), closed-class words and look-alike symbols.
    if (!/^[a-z]+$/u.test(lower) || FILLER.has(lower) || knownSymbol(lower) || Object.hasOwn(SENTENCE_VERBS, lower) || resolveNetworkName(lower)) return token;
    if (CLOSED_WORDS.has(lower) || lookalikeFamilyOf(lower)) return token;
    if (CONNECTOR_VOCAB.includes(lower) || VENUE_VOCAB.includes(lower) || NETWORK_VOCAB.includes(lower)) return token;
    if (position === 0) {
      const verbs = candidates(lower, VERB_VOCAB);
      // An English word ("bend", "sway") is never corrected into a verb; two close verbs are still asked (VERB_AMBIGUOUS), never chosen.
      const english = isEnglishWord(lower);
      if (verbs.length === 1 && !english) {
        corrections.push({ field: `actions[${index}].kind`, from: token.slice(0, 16), to: verbs[0] as string, material: true });
        return verbs[0] as string;
      }
      if (verbs.length > 1) verbCandidates = verbs;
      if (english && verbs.length > 0) verbEnglish = true;
      return token;
    }
    // Short connectors are too short for the edit-distance reader: a fixed list of their usual slips.
    const connector = SHORT_CONNECTOR_SLIPS[lower];
    if (connector) {
      corrections.push({ field: `actions[${index}].text`, from: token.slice(0, 16), to: connector, material: false });
      return connector;
    }
    // Never into a keyword from an English word ("on case" is not "on base"): keywordCandidates leaves those alone.
    const found = keywordCandidates(lower, [...CONNECTOR_VOCAB, ...NETWORK_VOCAB, ...VENUE_VOCAB]);
    if (found.length !== 1) return token;
    const to = found[0] as string;
    const name = NETWORK_VOCAB.includes(to) ? "network" : VENUE_VOCAB.includes(to) ? "protocol" : "text";
    corrections.push({ field: `actions[${index}].${name}`, from: token.slice(0, 16), to, material: name !== "text" });
    return to;
  });
  return { text: out.join(" "), corrections, ...(verbCandidates ? { verbCandidates } : {}), ...(verbEnglish ? { verbEnglish: true as const } : {}) };
}

/* ------------------------------------------------ questions (A.2, A14) */

/** "what's the best yield for my usdc", "best yield for 200 usdc on arbitrum": a yield question about one holding. */
const YIELD_QUESTION = /^(?:(?:what(?:'s|s| is)|which is|where(?:'s| is))\s+)?(?:the\s+)?(?:best|highest|top)\s+(?:yield|apy|rate|interest(?:\s+rate)?)\s+(?:for|on)\s+(?<object>(?:my\s+)?(?:\$?\d[\d,]*(?:\.\d+)?\s+)?[a-z][a-z0-9.]{1,15}(?:\s+(?:on|in)\s+[a-z][a-z -]{1,24})?)$/iu;
/** The imperatives that act on the answer of a yield question ("put it there", "go"). */
const ANSWER_IMPERATIVE = /^(?:(?:ok|okay|then|so|and|please|pls|plz)\s+)*(?:go|go for it|do it|put it there|put it in there|deposit it there|put them there|lets go|let's go)(?:\s+(?:please|pls|plz|thanks|thx))?$/iu;
/** "what is the cheapest way to <command>": a command asked as a question (confirmed, never planned as typed). */
const WAY_QUESTION = /^(?:(?:what(?:'s|s| is)|which is)\s+)?(?:the\s+)?(?:cheapest|fastest|best|easiest|quickest)\s+way\s+to\s+(?<command>\S.*)$/iu;

interface QuestionForm {
  /** The instruction Kletia reads instead of the question, from the person's own words. */
  readonly text: string;
  /** The rule that turned the question into that instruction. */
  readonly rule: "question:trailing" | "question:yieldAnswer" | "question:way";
}

/**
 * Questions vs commands (design A.2, red-team A1/A14). Returns the
 * instruction a question stands for (always confirmed as the solved plan:
 * every step is `questionForm`), or null when the message is not one of
 * these shapes (the caller refuses a question as before):
 * - "swap 0.01 eth to usdc on base?", "can you swap 1 sol to usdc?": the
 *   command before a trailing "?" (an advice or hypothetical opener is refused);
 * - "what's the best yield for my usdc? put it there", "best yield for 200
 *   usdc on arbitrum, go": a deposit into the best-ranked venue, only when the
 *   imperative passes the never-drop check ("... don't put it there yet" is
 *   refused);
 * - "what is the cheapest way to send 50 usdc to alice.eth": the command.
 */
function questionForm(raw: string): QuestionForm | null {
  const text = raw.replace(/\s+/gu, " ").trim();
  const mark = text.search(/[?¿？﹖⸮]/u);
  const head = (mark >= 0 ? text.slice(0, mark) : text).trim();
  const tail = mark >= 0 ? text.slice(mark).replace(/^[?¿？﹖⸮!.\s]+/u, "").trim() : "";
  const label = /^[a-z][a-z' -]{0,23}:\s+/iu.exec(head);
  const body = label && scanClosedClass(label[0].toLowerCase()).length === 0 ? head.slice(label[0].length) : head;
  const yieldQuestion = (question: string, imperative: string): QuestionForm | null => {
    const match = YIELD_QUESTION.exec(question.replace(/[,.!]+$/u, "").trim());
    if (!match?.groups) return null;
    const command = imperative.replace(/[.!]+$/u, "").trim();
    // A14: the imperative must carry no closed-class word ("don't put it there yet" is not an instruction).
    if (!ANSWER_IMPERATIVE.test(command) || scanClosedClass(command.toLowerCase()).length > 0) return null;
    return { text: `deposit ${match.groups.object} into the best yield`, rule: "question:yieldAnswer" };
  };
  if (tail) {
    if (/[?¿？﹖⸮]/u.test(tail)) return null;
    return yieldQuestion(body, tail);
  }
  // "best yield for 200 usdc on arbitrum, go": the imperative after a comma.
  const comma = /^(?<question>.+?),\s*(?<imperative>[^,]+)$/u.exec(body);
  if (comma?.groups && mark < 0) {
    const read = yieldQuestion(comma.groups.question as string, comma.groups.imperative as string);
    if (read) return read;
  }
  const way = WAY_QUESTION.exec(body.replace(/[.!]+$/u, "").trim());
  if (way?.groups) return { text: way.groups.command as string, rule: "question:way" };
  if (mark < 0) return null;
  // A trailing "?" on a command: never ready, only a confirm of the solved plan; an advice opener stays a question.
  if (openerOf(body)?.kind === "question" || readOnlyRates(body)) return null;
  return { text: body, rule: "question:trailing" };
}

/* ------------------------------------------------- keep (A.2, RF11) */

const KEEP_SYMBOL = "(?!(?:on|in|for|and|then|the)\\b)(?<asset>[a-z][a-z0-9.]{1,15})";
/** "keep 0.05 eth on base for gas", "keep 50", "keep the rest": a constraint of a step, never a step. */
const KEEP = new RegExp(
  `(?:^|\\s*,\\s*(?:and\\s+)?|\\s+and\\s+|\\s+then\\s+)keep\\s+(?:(?<rest>the\\s+rest)|(?<amount>\\$?\\d[\\d,]*(?:\\.\\d+)?|\\.\\d+)(?:\\s+${KEEP_SYMBOL})?(?:\\s+(?:on|in)\\s+(?<network>[a-z][a-z-]*(?:\\s+(?:one|mainnet|pos|sepolia|devnet|testnet))?))?(?:\\s+for\\s+gas)?)(?=\\s*(?:[,;.]|$)|\\s+(?:and|then)\\s+)`,
  "iu",
);

interface KeepPhrase {
  readonly before: string;
  readonly after: string;
  readonly rest: boolean;
  readonly amount?: string;
  readonly asset?: string;
  readonly network?: NetworkKey;
}

function keepRefusal(message: string): PlatformError {
  return new PlatformError("INTENT_UNSUPPORTED", message, 422, [{ path: "text", message: "What to keep could not be applied." }], REFUSAL_EXAMPLES);
}

/** The one "keep ..." phrase of a message, split out of it (two or more are refused: which step each limits is a guess). */
function keepPhrase(text: string): KeepPhrase | null {
  const match = KEEP.exec(text);
  if (!match?.groups) return null;
  const after = text.slice(match.index + match[0].length).replace(/^\s*(?:[,;.]\s*)?(?:and\s+|then\s+)*/iu, "").trim();
  const before = text.slice(0, match.index).trim().replace(/[,;.]+$/u, "").trim();
  if (KEEP.test(after) || /(?:^|\s)keep\s/iu.test(before)) throw keepRefusal("Say what to keep once, for one step, for example \"keep 0.05 ETH on base for gas and swap the rest to USDC\".");
  const g = match.groups;
  if (g.rest) return { before, after, rest: true };
  const amount = parseAmountText(g.amount as string, false);
  if (amount.t !== "exact" || amount.usd) throw keepRefusal("Say how much to keep as a number of tokens, for example \"keep 0.05 ETH\".");
  if (g.asset && !knownSymbol(g.asset)) return null;
  const network = g.network ? resolveNetworkName(g.network) : null;
  if (g.network && !network) return null;
  return { before, after, rest: false, amount: amount.value, ...(g.asset ? { asset: g.asset.toUpperCase() } : {}), ...(network ? { network } : {}) };
}

/**
 * RF11 (design A.2 binding, A.6 keep): "keep N [token] [on network] [for
 * gas]" limits the step it belongs to, and "the rest" after it is all of the
 * holding but what is kept:
 * - "keep 0.05 eth on base for gas and swap the rest to usdc": the swap spends
 *   all of the ETH on Base but 0.05 (confirmed, the keep is on the step);
 * - "swap 100 usdc to eth on base and keep 20 usdc": the swap keeps 20 USDC
 *   back (the policy checks both fit);
 * - "..., keep 50 and deposit the rest": the rest of a previous output less a
 *   kept amount is asked, never guessed;
 * - "... swap 10 of them to eth and keep the rest": nothing to do.
 */
function readWithKeep(keep: KeepPhrase, phrases: readonly ContractPhrase[], previousExists: boolean, offset: number, previousStep: WorkStep | undefined): ParsedSentence {
  const entry = keep.amount ? { amount: { t: "exact" as const, value: keep.amount }, ...(keep.asset ? { asset: keep.asset } : {}), ...(keep.network ? { network: keep.network } : {}) } : undefined;
  const head = keep.before ? parseSentence(keep.before, phrases, previousExists, offset, previousStep) : null;
  const last = head?.steps[head.steps.length - 1] ?? previousStep;
  if (keep.rest) {
    // "keep the rest": a no-op only after a step with an exact amount.
    if (keep.after || !head || last?.amount?.v.t !== "exact") throw keepRefusal("Kletia could not tell what \"keep the rest\" keeps. Give each step its amount.");
    return head;
  }
  if (!keep.after) {
    if (!head || !last || !entry) throw keepRefusal("Say which step keeps the amount back, for example \"swap 100 USDC to ETH on base and keep 20 USDC\".");
    last.keep = [...(last.keep ?? []), entry].slice(0, 4);
    return head;
  }
  if (!head && !previousExists) {
    // "keep 0.05 eth on base for gas and swap the rest to usdc": the rest of that holding, the keep on the step.
    if (!keep.asset || !/(?:^|\s)the\s+rest(?:\s|$)/iu.test(keep.after)) throw keepRefusal("Say which token the rest is, for example \"keep 0.05 ETH on base for gas and swap the rest to USDC\".");
    const said = keep.after.replace(/(?:^|\s)the\s+rest(?=\s|$)/iu, ` all my ${keep.asset.toLowerCase()}`).trim() + (keep.network && !/\s(?:on|in|from)\s/iu.test(keep.after) ? ` on ${keep.network}` : "");
    const tail = parseSentence(said, phrases, false, offset, undefined);
    const step = tail.steps[0];
    if (!step || tail.steps.length !== 1 || step.from?.v.toUpperCase() !== keep.asset) throw keepRefusal("Kletia could not apply what you keep to that step. Give the amount to use.");
    step.keep = [entry as ThreadKeep];
    if (keep.asset === "ETH" || keep.asset === "SOL" || keep.asset === "POL") {
      // A native token kept "for gas" is the fee reserve itself: until the decision layer counts it as the reserve,
      // the amount is asked (two reserves would not be the rest the person meant).
      delete step.amount;
      return tail;
    }
    step.source = "C";
    step.readAs = [...(step.readAs ?? []), { slot: "amount", rule: "keep:rest", to: `All but ${keep.amount} ${keep.asset}`.slice(0, 40) }].slice(0, 4);
    return tail;
  }
  // "..., keep 50 and deposit the rest into aave": what is left of the previous output is asked.
  const tail = parseSentence(keep.after, phrases, true, offset + (head?.steps.length ?? 0), last);
  const first = tail.steps[0];
  if (first && first.amount?.v.t === "previous" && first.amount.v.bps === 10_000) {
    delete first.amount;
    // The token and network are still the previous output's: only how much is asked.
    const asset = last ? outputOf(last) : undefined;
    const landing = last ? destinationOf(last) : undefined;
    if (asset && !first.from && !first.usdFrom && !isUsdWord(asset)) first.from = { v: asset, by: "derived", prov: { rule: "previous-output" } };
    if (landing && !first.network) first.network = { v: landing, by: "derived", prov: { rule: "previous-output" } };
  }
  else if (!head || !last || !entry) throw keepRefusal("Say which step keeps the amount back.");
  else last.keep = [...(last.keep ?? []), entry].slice(0, 4);
  return { steps: [...(head?.steps ?? []), ...tail.steps], corrections: [...(head?.corrections ?? []), ...tail.corrections] };
}

/* ------------------------------------- in-message corrections (RF9) */

/** "no wait, 3 sol", "actually make it 0.5", "sorry, I meant arbitrum": a correction at the end of the message. */
const IN_MESSAGE_CORRECTION = /^(?<message>.+?)(?:\s*[,.;!]\s*|\s+)(?:no\s+wait|wait\s+no|wait|no|actually|sorry|oops)(?:\s*,)?\s+(?:i\s+meant\s+|i\s+mean\s+|make\s+it\s+|change\s+it\s+to\s+|it'?s\s+)?(?<value>[^,;!?]+?)[.!]?$/iu;
const NUMBER_TOKEN = /^(?:\$?\d[\d,]*(?:\.\d+)?|\.\d+)$/u;
const SPELLED = /^(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|thousand|half|quarter|third|all|max|everything)$/iu;

function editAmbiguous(what: string): PlatformError {
  return new PlatformError("INTENT_UNSUPPORTED", `Kletia could not tell which ${what} your correction changes. Send the corrected instruction on its own, for example "swap 3 SOL to USDC".`, 422,
    [{ path: "text", message: "The correction has more than one possible target." }], REFUSAL_EXAMPLES);
}

/**
 * RF9 (design A.2 binding, red-team A12): a correction applies only when the
 * message has exactly one slot of its type (one amount, one network, one
 * recipient); otherwise it is refused (EDIT_TARGET_AMBIGUOUS in words). The
 * corrected message is source C: confirmed as the solved plan, with a "Read
 * as" item naming the change.
 */
function inMessageCorrection(text: string): { text: string; from: string; to: string; slot: string } | null {
  const match = IN_MESSAGE_CORRECTION.exec(text.trim());
  if (!match?.groups) return null;
  const message = (match.groups.message as string).trim();
  const value = (match.groups.value as string).trim();
  const words = message.split(/\s+/u);
  const clean = (word: string) => word.replace(/[,;.!]+$/u, "");
  const parts = value.split(/\s+/u);
  // An amount, optionally with its token: "3 sol", "0.5".
  if (NUMBER_TOKEN.test(parts[0] ?? "") && parts.length <= 2) {
    const at = words.flatMap((word, index) => (NUMBER_TOKEN.test(clean(word)) ? [index] : []));
    if (at.length !== 1 || words.some((word) => SPELLED.test(clean(word)))) throw editAmbiguous("amount");
    const index = at[0] as number;
    const symbol = parts[1];
    if (symbol && clean(words[index + 1] ?? "").toLowerCase() !== symbol.toLowerCase()) throw editAmbiguous("amount");
    const from = clean(words[index] as string);
    const next = [...words];
    next[index] = parts[0] as string;
    return { text: next.join(" "), from, to: parts[0] as string, slot: "amount" };
  }
  // A network: "arbitrum", "on arbitrum".
  const named = value.replace(/^(?:on|in)\s+/iu, "");
  const network = /^[a-z][a-z -]*$/iu.test(named) ? resolveNetworkName(named) : null;
  if (network && !Object.hasOwn(ASSET_NETWORK_WORDS, value.toLowerCase())) {
    const at = words.flatMap((word, index) => (/^[a-z][a-z-]*$/iu.test(clean(word)) && resolveNetworkName(clean(word)) && !Object.hasOwn(ASSET_NETWORK_WORDS, clean(word).toLowerCase()) ? [index] : []));
    if (at.length !== 1) throw editAmbiguous("network");
    const index = at[0] as number;
    const next = [...words];
    next[index] = value.replace(/^(?:on|in)\s+/iu, "");
    return { text: next.join(" "), from: clean(words[index] as string), to: next[index] as string, slot: "network" };
  }
  // A recipient: "bob.eth", "to bob.eth".
  const recipient = value.replace(/^to\s+/iu, "");
  if (new RegExp(`^${ADDR}$`, "iu").test(recipient)) {
    const at = words.flatMap((word, index) => (new RegExp(`^${ADDR}$`, "iu").test(clean(word)) ? [index] : []));
    if (at.length !== 1) throw editAmbiguous("recipient");
    const index = at[0] as number;
    const next = [...words];
    next[index] = recipient;
    return { text: next.join(" "), from: clean(words[index] as string), to: recipient, slot: "recipient" };
  }
  return null;
}

/* ----------------------------------------- several recipients (RF8) */

const RECIPIENT = "(?:[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:eth|sns|sol)|0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})";
/** "send 10 usdc each to alice.eth and bob.eth [on base]", "send 10 usdc to alice.eth and bob.eth each [on base]". */
const EACH = new RegExp(
  `^(?<verb>send|pay|transfer|give|tip)\\s+(?<amount>\\S+\\s+[a-z][a-z0-9.]{0,15})\\s+(?:each\\s+to\\s+(?<a>${RECIPIENT})\\s+and\\s+(?<b>${RECIPIENT})|to\\s+(?<c>${RECIPIENT})\\s+and\\s+(?<d>${RECIPIENT})\\s+(?:each|apiece|a\\s+piece))(?<rest>\\s+(?:on|from)\\s+[a-z][a-z -]{1,24})?$`,
  "iu",
);
/** "send 10 usdc to alice.eth and bob.eth": one amount, two recipients, no "each". */
const TWO_RECIPIENTS = new RegExp(`(?:^|\\s)to\\s+${RECIPIENT}\\s+and\\s+${RECIPIENT}(?=\\s|$)`, "iu");

/**
 * RF8 (design A.2 binding): "N <token> each to A and B" is one payment of N
 * per recipient (stated); without "each" it is refused, because N each and
 * N shared are different payments to other people (RECIPIENT_EACH in words).
 */
function eachRecipients(text: string): string | null {
  const match = EACH.exec(text.trim());
  if (!match?.groups) {
    if (TWO_RECIPIENTS.test(text)) {
      throw new PlatformError("INTENT_UNSUPPORTED", "Kletia does not guess whether each recipient gets that amount or they share it. Say \"send 10 USDC each to alice.eth and bob.eth\", or give each recipient its own amount.", 422,
        [{ path: "text", message: "One amount for two recipients." }], REFUSAL_EXAMPLES);
    }
    return null;
  }
  const g = match.groups;
  const rest = g.rest ?? "";
  return `${g.verb} ${g.amount} to ${g.a ?? g.c}${rest} and ${g.amount} to ${g.b ?? g.d}${rest}`;
}

/* ----------------------------------------------- "the rest" (A.2, A7) */

/**
 * "sell 1 sol, then stake the rest": the rest of the holding the step before
 * spent from, when this step can only take that token (a stake takes its
 * native token, never the stablecoin the sale produced). Every other "the
 * rest" after a step keeps its reading of the previous output, except a
 * payment to someone else, whose amount is asked (I13).
 */
function bindRest(step: WorkStep, before: WorkStep | undefined, at: number): void {
  if (!before) return;
  if (paysSomeoneElse(step)) {
    delete step.amount;
    return;
  }
  const spent = before.from?.v.toUpperCase();
  const native = spent === "SOL" || spent === "ETH";
  if (step.kind?.v === "stake" && native && before.amount?.v.t === "exact" && before.amount.by === "user" && !paysSomeoneElse(before)) {
    const input = step.from?.v.toUpperCase() ?? (step.provider ? stakeProvider(step.provider.v)?.input : undefined) ?? spent;
    if (input !== spent) return;
    step.from = { v: spent, by: "derived", prov: { rule: "rest" } };
    step.amount = { v: { t: "balance", bps: 10_000 }, by: "derived", prov: { rule: "rest" } };
    step.keep = [{ amount: { t: "exact", value: before.amount.v.value }, asset: spent, ...(before.network && before.network.by === "user" ? { network: before.network.v } : {}) }];
    step.source = "C";
    step.readAs = [...(step.readAs ?? []), { slot: "amount", rule: "rest", to: `The rest of your ${spent} after step ${at}`.slice(0, 40) }].slice(0, 4);
  }
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
/** "send alice.eth and bob.eth 10 and 20 usdc": recipients and amounts in separate lists (A13). */
const PARALLEL_LISTS = /^(?:send|pay|transfer|give|tip)\s+\S+\s+and\s+\S+\s+\$?[\d.,]+\s+and\s+\$?[\d.,]+(?:\s|$)/iu;

function pairingRefusal(): PlatformError {
  return new PlatformError("INTENT_UNSUPPORTED", "Kletia does not pair recipients and amounts by their order. Give each recipient its amount, for example \"send 10 USDC to alice.eth and 20 USDC to bob.eth\".", 422,
    [{ path: "text", message: "Recipients and amounts are in separate lists." }], REFUSAL_EXAMPLES);
}

/** A name or an address read where a token goes ("send alice.eth ..."): the clause is not read as a payment of that "token". */
function recipientAsToken(step: WorkStep): boolean {
  return [step.from?.v, step.to?.v].some((value) => value !== undefined && /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:eth|sns|sol)|0x[0-9a-f]{40})$/iu.test(value) && !knownSymbol(value));
}

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

/** A step whose output goes to someone else: a recipient, a nickname, any transfer, or a payment goal. */
function paysSomeoneElse(step: WorkStep | undefined): boolean {
  if (!step) return false;
  if (step.recipient !== undefined || step.nickname === true || step.kind?.v === "transfer") return true;
  return step.kind === undefined && step.goal !== undefined && step.goal.holder.t !== "self";
}

/**
 * A step that spends what the step before it produced: "it", "that", "the
 * rest", "half of it", "all" after a step, or a goal chained to the one
 * before (a portion or "all" with no token named counts as chained).
 */
function spendsPrevious(step: WorkStep): boolean {
  if (step.amount?.v.t === "previous") return true;
  const goal = step.kind === undefined ? step.goal : undefined;
  if (!goal) return false;
  if (goal.chain !== undefined || goal.spend.amount?.t === "previous") return true;
  return !goal.spend.asset && (goal.spend.amount?.t === "portion" || goal.spend.amount?.t === "max") && goal.spend.from?.custody.kind !== "position";
}

/**
 * "send 10 USDC to vitalik.eth on base and swap it to ETH": "it" would be the
 * money paid to someone else, which is no longer in the person's account.
 * Refused (design A.2 binding, red-team A7) instead of spending other funds.
 */
function previousPaidRefusal(at: number): PlatformError {
  const step = at > 0 ? `Step ${at + 1}` : "This step";
  const before = at > 0 ? `step ${at}` : "the step before";
  return new PlatformError(
    "INTENT_UNSUPPORTED",
    `${step} spends what ${before} produces, but ${before} pays someone else, so that money is no longer in your account. ` +
      `Give ${step.toLowerCase()} its own amount and token, for example "send 10 USDC to vitalik.eth on base, then swap 5 USDC to ETH on base".`,
    422,
    [{ path: `actions[${at}].amount`, message: "The previous step pays someone else." }],
    REFUSAL_EXAMPLES,
  );
}

/**
 * "move 10 USDC to op", "send 10 USDC to sol": a neutral verb whose
 * destination names both a token and a network, with no source network said
 * ("from base") and no "as <token>": refused with both phrasings (design A.2
 * frames, F-1, AQ1) instead of choosing a bridge or a swap.
 */
function neutralDestination(clause: string): PlatformError | null {
  const tokens = lex(normalizeClause(clause));
  // One verb's span at a time: a source said anywhere in it ("to op from base") keeps the network reading.
  const starts = tokens.flatMap((token, position) => (token.t === "VERB" ? [position] : []));
  for (const [order, start] of starts.entries()) {
    const span = tokens.slice(start, starts[order + 1] ?? tokens.length);
    const verb = (span[0] as Extract<Token, { t: "VERB" }>).raw.toLowerCase();
    if (!NEUTRAL_MOVE_VERBS.includes(verb)) continue;
    const source = span.some((token, position) => {
      const next = span[position + 1];
      return token.t === "CONN" && token.word === "from" && (next?.t === "NETWORK" || (next?.t === "ASSET" && next.network !== undefined));
    });
    if (source) continue;
    for (const [position, token] of span.entries()) {
      if (token.t !== "CONN" || (token.word !== "to" && token.word !== "into" && token.word !== "onto")) continue;
      const next = span[position + 1];
      if (next?.t !== "ASSET" || !next.network || !Object.hasOwn(ASSET_NETWORK_WORDS, next.raw.toLowerCase())) continue;
      const after = span[position + 2];
      // "to sol as SOL" names the token after the network; "to sol network" names the network.
      if (after?.t === "CONN" && after.word === "as") continue;
      if (after?.t === "NOISE" && /^(?:network|chain)$/iu.test(after.raw)) continue;
      const amount = span.find((entry): entry is Extract<Token, { t: "AMOUNT" }> => entry.t === "AMOUNT" && entry.sel.t === "exact");
      const asset = span.find((entry, at): entry is Extract<Token, { t: "ASSET" }> => entry.t === "ASSET" && at < position);
      return assetOrNetworkRefusal(clause, verb, next.raw, amount && asset ? `${amount.raw} ${asset.symbol.toUpperCase()}` : undefined);
    }
  }
  return null;
}

/**
 * "swap 1 SOL to USDC, bridge to base, deposit into aave": a later clause with
 * no amount and no asset continues with what the step before produced, as if
 * it said "it" (F9). Stake's derived input (SOL) counts as unsaid. Never after
 * a step that pays someone else: that output is not the person's to spend
 * (the step then asks for its amount).
 */
function chainImplicit(step: WorkStep, previous: boolean, before?: WorkStep): void {
  if (!previous || step.amount || step.usdFrom || step.contract || step.goal) return;
  if (paysSomeoneElse(before)) return;
  if (!step.kind || !CHAINABLE.has(step.kind.v)) return;
  if (step.from && step.from.by === "user") return;
  if (step.kind.v === "stake" && step.from) delete step.from;
  step.amount = slot({ t: "previous", bps: 10_000 }, "derived");
}

/** The token a step leaves in the person's account, when the step says it (never for payments, stakes or deposits). */
function outputOf(step: WorkStep): string | undefined {
  if (step.goal && !step.kind) return undefined;
  switch (step.kind?.v) {
    case "swap":
      return step.to?.v;
    case "bridge":
      return step.to?.v ?? step.from?.v;
    case "withdraw":
      return step.from?.v;
    default:
      return undefined;
  }
}

/** Where a step's output lands, when the message says it (or the spent token has one home network). */
function destinationOf(step: WorkStep): NetworkKey | undefined {
  if (step.kind?.v === "bridge") return step.toNetwork?.v;
  if (step.network && step.network.by !== "assumed") return step.network.v;
  const spent = step.from?.v;
  if (!spent || step.kind?.v !== "swap") return undefined;
  const homes = NETWORK_ORDER.filter((network) => lane(network) === "mainnet" && canonicalOn(network, spent) !== null);
  return homes.length === 1 ? homes[0] : undefined;
}

/**
 * AQ2 (design A.2 binding): "send 20 of it to carol.sns" spends exactly 20 of
 * the previous step's output token, where that output lands. Bound only when
 * the message names both the token and the network the output lands on;
 * otherwise the step stays without a token and the policy asks for it.
 */
function bindOfPrevious(step: WorkStep, before: WorkStep | undefined, at: number): void {
  if (!before || step.usdFrom || step.amount?.v.t !== "exact") return;
  const asset = outputOf(before);
  const landing = destinationOf(before);
  if (step.from) {
    // "send 10 usdc of it" after a step that delivers another token: "it" is not what the step names.
    if (asset && step.from.v.toUpperCase() !== asset.toUpperCase()) {
      throw new PlatformError("INTENT_UNSUPPORTED", `Step ${at + 1} spends ${step.from.v.toUpperCase()} "of it", but step ${at} delivers ${asset.toUpperCase()}. Name the token step ${at + 1} spends.`, 422,
        [{ path: `actions[${at}].from`, message: "Not the previous step's output." }], REFUSAL_EXAMPLES);
    }
    if (asset && landing && !step.network) step.network = { v: landing, by: "derived", prov: { rule: "previous-output" } };
    return;
  }
  if (!asset || !landing || isUsdWord(asset)) return;
  step.from = { v: asset, by: "derived", prov: { rule: "previous-output" } };
  if (!step.network) step.network = { v: landing, by: "derived", prov: { rule: "previous-output" } };
}

/** Plural references to earlier outputs ("them", "both", "all of them"). */
const PLURAL_REFERENCE = /(?:^|\s)(?:them|those|these|both|all\s+of\s+them|each\s+of\s+them|both\s+of\s+them)(?:\s|$)/iu;

/**
 * Red-team A7 (design A.2 binding): "them" / "both" with more than one
 * output still in the person's account (two swaps, then "send them") cannot
 * be read as one step's output. Kletia refuses with the outputs listed
 * instead of spending only the last one.
 */
function pluralReference(clause: string, steps: readonly WorkStep[], at: number): PlatformError | null {
  const word = PLURAL_REFERENCE.exec(clause)?.[0].trim().toLowerCase();
  if (!word) return null;
  const open = steps.filter((step, index) => !paysSomeoneElse(step) && !(steps[index + 1] && spendsPrevious(steps[index + 1] as WorkStep)));
  if (open.length < 2 && !/(?:^|\s)both(?:\s|$)/iu.test(clause)) return null;
  const named = open.map((step) => outputOf(step)?.toUpperCase() ?? "its output").slice(0, 3);
  return new PlatformError(
    "INTENT_UNSUPPORTED",
    `Step ${at + 1} says "${word}", but ${open.length > 1 ? `${open.length} earlier steps each leave tokens (${named.join(", ")})` : "only one earlier step leaves tokens"}. ` +
      `Kletia does not guess which. Give each step its own amount and token, for example "swap 1 SOL to USDC, then bridge it to arbitrum".`,
    422,
    [{ path: `actions[${at}].amount`, message: "Several earlier outputs could be meant." }],
    REFUSAL_EXAMPLES,
  );
}

/**
 * "$SOL", "$usdc": a cashtag is the token when "$" is followed by a letter
 * and the rest is a listed symbol (design A.2 L0, U2 AQ6); "$50" stays fifty
 * dollars.
 */
export function readCashtags(text: string): string {
  return text.replace(/(^|[\s(,])\$([A-Za-z][A-Za-z0-9.]{0,15})(?=$|[\s,;:!)])/gu, (match, before: string, symbol: string) => (knownSymbol(symbol) ? `${before}${symbol}` : match));
}

/** The closed-class rules a read step records in its slots and "Read as" items (design A.4 provenance). */
function stepRules(step: WorkStep): Set<string> {
  const rules = new Set<string>();
  for (const key of ["kind", "amount", "from", "to", "network", "toNetwork", "recipient", "protocol", "vault", "provider", "fundFrom"] as const) {
    const rule = (step[key] as { prov?: { rule?: string } } | undefined)?.prov?.rule;
    if (rule) rules.add(rule);
  }
  for (const item of step.readAs ?? []) rules.add(item.rule);
  return rules;
}

/** A keyword correction (verb, network, venue) or a digit read as a word: the clause is source C (one-click confirm). */
const keywordCorrection = (correction: ThreadCorrection) => correction.material && !correction.field.endsWith(".amount") && correction.to !== "note";

/**
 * A message as slots for every clause (1 to 8); unique keyword typos are
 * corrected (R9, R10). `previousStep` is the thread's last step when the
 * message continues a task (an appended clause): "it" after a step that pays
 * someone else is refused there too.
 *
 * Before any word is dropped or corrected (design A.2 L0, I12): the text is
 * screened (Unicode forms, emoji, homoglyph letters), the opener is read
 * (a question is refused; a polite command is planned only as a confirm),
 * cashtags are read, and each clause gets its closed-class record. An
 * unsupported network or lane qualifier refuses NETWORK_UNSUPPORTED; a
 * never-drop word no rule of this reader consumes refuses the clause with its
 * family's message; reviewed fillers are dropped and listed ("Ignored").
 */
/** Seam S1 options of `parseSentence`: readings proposed for clauses the reader could not read, by clause index. */
export interface SentenceOptions {
  readonly readings?: ReadonlyMap<number, readonly Goal[]>;
}

/**
 * Seam S1: the refusal for unread clauses carries them (index, text, closed-class record) on a non-enumerable
 * property, so the decision layer can offer them to the reading layer; it is never serialised.
 */
function unreadRefusal(unread: readonly UnreadClause[]): PlatformError {
  const error = notUnderstood((unread[0] as UnreadClause).text);
  Object.defineProperty(error, "unreadClauses", { value: unread, enumerable: false, writable: false, configurable: false });
  return error;
}

export function parseSentence(raw: string, phrases: readonly ContractPhrase[], previousExists = false, offset = 0, previousStep?: WorkStep, sentence: SentenceOptions = {}): ParsedSentence {
  // A question is never planned as typed ("swap 0.01 ETH to USDC on base?"): it is read only as the instruction it
  // stands for, and every step is confirmed as the solved plan (questionForm); anything else is refused.
  const asked = questionForm(raw);
  if (asked) {
    const read = parseSentence(asked.text, phrases, previousExists, offset, previousStep, sentence);
    // A goal only the solver can place ("exit my aave position?") does not carry the confirm through its expansion
    // yet: refused as a question, never ready (fail closed).
    if (read.steps.some((step) => step.kind === undefined)) throw questionRefusal(normalizeMessage(raw), REFUSAL_EXAMPLES);
    for (const step of read.steps) step.questionForm = true;
    return read;
  }
  if (hasQuestionMark(raw)) throw questionRefusal(normalizeMessage(raw), REFUSAL_EXAMPLES);
  if (PARALLEL_LISTS.test(raw.trim())) throw pairingRefusal();
  const each = eachRecipients(raw);
  if (each) {
    const read = parseSentence(each, phrases, previousExists, offset, previousStep, sentence);
    for (const step of read.steps) if (step.amount) step.amount = { ...step.amount, prov: { ...step.amount.prov, rule: "deliverEach" } };
    return read;
  }
  const keep = keepPhrase(raw);
  if (keep) return readWithKeep(keep, phrases, previousExists, offset, previousStep);
  const edit = inMessageCorrection(raw);
  if (edit) {
    const read = parseSentence(edit.text, phrases, previousExists, offset, previousStep, sentence);
    const target = read.steps.find((step) => (edit.slot === "amount" ? step.amount : edit.slot === "network" ? step.network ?? step.toNetwork : step.recipient)) ?? read.steps[0];
    for (const step of read.steps) step.source = "C";
    if (target) target.readAs = [...(target.readAs ?? []), { slot: edit.slot, rule: "correction:inMessage", from: edit.from.slice(0, 16), to: `${edit.to} (you corrected ${edit.from})`.slice(0, 40) }].slice(0, 4);
    return { steps: read.steps, corrections: [...read.corrections, { field: `actions[${offset + Math.max(0, read.steps.indexOf(target as WorkStep))}].${edit.slot}`, from: edit.from.slice(0, 16), to: edit.to.slice(0, 64), material: true }] };
  }
  const screened = screenText(raw);
  if (screened.nonLatin) throw nonLatinRefusal();
  // "should i swap ...", "what if i ...": a question, never a plan; "can you swap ...": a command asked politely (confirmed).
  const opener = openerOf(screened.text);
  if (opener?.kind === "question") {
    const rates = readOnlyRates(screened.text);
    if (rates) throw readOnlyRatesRefusal(rates, REFUSAL_EXAMPLES);
    throw new PlatformError("INTENT_UNSUPPORTED", CLOSED_CLASS_COPY.question, 422, [{ path: "text", message: "A question, not an instruction." }], REFUSAL_EXAMPLES);
  }
  // Compound number words ("twenty five") become digits first; single ones are the core normaliser's.
  const labelled = stripLabel(normalizeMessage(spellNumbers(readCashtags(screened.text), 2)));
  const text = labelled.text;
  if (!text) throw new PlatformError("INTENT_UNSUPPORTED", "The message is empty.", 422);
  const extraVerbs = phrases.flatMap((phrase) => phrase.verbs);
  const clauses = splitClauses(text, extraVerbs);
  if (clauses.length === 0 || clauses.length > 8) throw new PlatformError("INTENT_UNSUPPORTED", "Say what should happen in one to eight steps.", 422);
  const steps: WorkStep[] = [];
  // The label is kept only as a note (a non-material ".text" correction, never shown as a chip or read as a slot).
  const corrections: ThreadCorrection[] = labelled.label ? [{ field: `actions[${offset}].text`, from: labelled.label.slice(0, 16), to: "note", material: false }] : [];
  let emoji = screened.emoji > 0;
  const unreadClauses: UnreadClause[] = [];
  clauses.forEach((original, clauseIndex) => {
    const index = steps.length + offset;
    const previous = previousExists || steps.length > 0;
    // L0: the closed-class record, before any word is dropped or corrected.
    const record = clauseRecord(original, steps.length === 0 ? opener : null);
    const network = unsupportedNetwork(record, `actions[${index}].network`);
    if (network) throw network;
    const lower = original.toLowerCase();
    const blocked = record.hits.find((hit) => !consumable(lower, hit));
    if (blocked) throw closedClassError(blocked);
    const fillers = dropFillers(original);
    const clause = fillers.text;
    // A clause of fillers only ("please,") says nothing.
    if (!clause || /^[,.!\s]*$/u.test(clause)) return;
    const correctionsBefore = corrections.length;
    const ambiguous = neutralDestination(clause);
    if (ambiguous) throw ambiguous;
    const plural = steps.length > 0 ? pluralReference(clause, steps, index) : null;
    if (plural) throw plural;
    // L1 (the relaxed sentence shapes) consumes no closed-class word: a clause that holds one is read by the Goal reader only.
    // An abstract goal or idiom (P4-M4: "prepare 100 usdc on optimism", "fund alice.eth with ...") is read whole by the Goal reader.
    const shapes = record.hits.length === 0 && !abstractClause(normalizeClause(clause));
    // "stake something": the vague noun is read before the filler pass drops it.
    let parsed = shapes ? parseContractClause(clause, phrases, index, previous) ?? vagueClause(clause, false) ?? vagueClause(original, false) ?? parseClause(clause, previous) : null;
    let fixed: ReturnType<typeof correctClause> | undefined;
    if (!parsed && shapes) {
      fixed = correctClause(clause, index);
      // More than two keyword corrections in one clause is a guess, not a reading.
      if (fixed.corrections.filter((entry) => entry.material).length > MAX_CORRECTIONS) fixed = { text: clause, corrections: [] };
      parsed = parseClause(fixed.text, previous);
      if (parsed) corrections.push(...fixed.corrections);
      if (!parsed && fixed.verbCandidates) {
        // R9: only verbs that make the rest of the clause read are candidates; one left is a correction,
        // except from an English word ("bend 5 USDC to vitalik.eth" is not corrected to send: it is refused).
        const rest = fixed.text.split(/\s+/u).slice(1).join(" ");
        const fitting = fixed.verbCandidates.filter((verb) => parseClause(`${verb} ${rest}`, previous) !== null);
        const kinds = [...new Set(fitting.map((verb) => SENTENCE_VERBS[verb] as Kind))];
        if (kinds.length === 1 && !fixed.verbEnglish) {
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
    const applied = new Set<string>();
    let unsized: readonly WorkStep[] = [];
    let rest: readonly WorkStep[] = [];
    let ofPrevious: readonly WorkStep[] = parsed && previous && EXACT_OF_PREVIOUS.test(clause) ? [parsed] : [];
    if (!parsed) {
      // Intent engine v2 §3.4: the Goal reader, only when the strict reader (with typo correction) found nothing.
      const prior = steps.length > 0 ? steps[steps.length - 1] : previousStep;
      const options = {
        previousExists: previous,
        index,
        strict: (piece: string, before: boolean) => (scanClosedClass(piece).length === 0 ? parseClause(piece, before) : null),
        ...(prior ? { previousStep: prior } : {}),
        paysOther: paysSomeoneElse,
      };
      let reading = readClause(clause, options);
      // Keyword typos may help the Goal reader too, but never a corrected verb: "unstake" is not "stake".
      if (!reading && fixed && fixed.text !== clause && !fixed.corrections.some((entry) => entry.field.endsWith(".kind")) && !fixed.verbCandidates) {
        reading = readClause(fixed.text, options);
        if (reading) corrections.push(...fixed.corrections);
      }
      if (!reading) {
        // A unit or an approximation the reading could not apply says so ("50 cents of eth", "almost all my sol").
        const unread = record.hits.find((hit) => hit.category === "unit" || hit.category === "approximation");
        if (unread) throw closedClassError(unread);
        const vague = shapes ? vagueClause(clause, true) : null;
        if (vague) read = [vague];
        else {
          // Seam S1: a reading proposed for this clause (model-assisted, source M) stands in for it; it is solved
          // and confirmed like any goal step. Otherwise the clause is recorded as unread and the message refused.
          const given = sentence.readings?.get(clauseIndex);
          if (!given || given.length === 0) {
            unreadClauses.push({ index: clauseIndex, text: clause, closedClass: record });
            return;
          }
          read = given.map((goal: Goal): WorkStep => ({ goal, goalRead: { lowered: false }, modelRead: true, source: "M" }));
        }
      } else {
        corrections.push(...reading.corrections);
        read = reading.steps;
        for (const rule of reading.rules) applied.add(rule);
        unsized = reading.unsized;
        ofPrevious = reading.ofPrevious;
        rest = reading.rest;
      }
    }
    // I12: every closed-class word of the clause was consumed by a rule this reading applied.
    for (const step of read) for (const rule of stepRules(step)) applied.add(rule);
    const left = unconsumed(record, original, applied);
    if (left) throw closedClassError(left);
    const corrected = corrections.slice(correctionsBefore).some(keywordCorrection);
    const ignored = [...fillers.ignored, ...(emoji ? ["emoji"] : [])];
    emoji = false;
    read.forEach((step, position) => {
      const at = index + position;
      const before = steps.length > 0 ? steps[steps.length - 1] : previousStep;
      if (!unsized.includes(step)) chainImplicit(step, previous || position > 0, before);
      // "send 10 usdc to vitalik.eth and swap 5 of it": that output is someone else's (design A.2, red-team A7).
      if (paysSomeoneElse(before) && (spendsPrevious(step) || ofPrevious.includes(step))) throw previousPaidRefusal(at);
      if (ofPrevious.includes(step)) bindOfPrevious(step, before, at);
      if (rest.includes(step)) bindRest(step, before, at);
      if (recipientAsToken(step)) throw notUnderstood(clause);
      flagAssetTypo(step);
      const amount = step.amount?.v;
      if (amount?.t === "exact" && amount.raw && /^\$?\d+,\d{1,2}$/u.test(amount.raw)) {
        corrections.push({ field: `actions[${at}].amount`, from: amount.raw.slice(0, 16), to: amount.value, material: true });
      }
      // "send 2,500 usdc to ...": a grouped amount paid to someone else is always read back in words (design A.2, red-team A5).
      if (amount?.t === "exact" && groupedThousands(amount.raw) && paysSomeoneElse(step) && !(step.readAs ?? []).some((item) => item.slot === "amount")) {
        const words = amountInWords(amount.value);
        const shown = `${amount.raw}${step.from ? ` ${step.from.v.toUpperCase()}` : ""}`;
        const to = words && shown.length + words.length + 3 <= 64 ? `${shown} (${words})` : shown;
        step.readAs = [...(step.readAs ?? []), { slot: "amount", rule: "format:grouped", to }].slice(0, 4);
      }
      // What the reader recorded for the decision layer (A.3): corrections, the question form, the ignored words.
      if (corrected) step.source = "C";
      if (opener?.kind === "polite") step.questionForm = true;
      if (position === 0 && ignored.length > 0) step.ignored = [...ignored];
      const rules = stepRules(step);
      const hits = record.hits.filter((hit) => hit.rules.some((rule) => rules.has(rule)));
      if (hits.length > 0 || record.lookalikes.length > 0 || (record.opener && position === 0)) step.closedClass = { ...record, hits };
      steps.push(step);
    });
  });
  if (unreadClauses.length > 0) throw unreadRefusal(unreadClauses);
  if (steps.length === 0) throw notUnderstood(text);
  if (steps.length > 8) throw new PlatformError("INTENT_UNSUPPORTED", "Say what should happen in one to eight steps.", 422);
  return { steps, corrections };
}
