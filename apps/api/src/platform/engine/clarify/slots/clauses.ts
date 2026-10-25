/**
 * Amounts, slots and clause parsing, with keyword typo correction.
 */
import {
  lookalikeFamilyOf,
  NEVER_DROP,
  SENTENCE_VERBS,
  type NetworkKey,
  type ThreadAmount,
} from "@kletia/core";
import { PlatformError } from "../../../errors.js";
import {
  EXIT_GUIDES,
  SOLANA_PAY_PROTOCOL,
  swapFilterProvider,
  vaultOfVenueWord,
  matchContractPhrase,
  resolveNetworkName,
  NATIVE_STAKE_PROTOCOL,
} from "../../grammar.js";
import type { ContractPhrase } from "../../contracts/directory.js";
import { candidates, keywordCandidates } from "../fuzzy.js";
import { isEnglishWord } from "../englishWords.js";
import {
  bridgeProtocol,
  dexProtocol,
  isUsdWord,
  knownSymbol,
  lendingProtocol,
  providerFromWord,
  stakeProvider,
  USD_ORDER,
} from "../catalog.js";
import type { Kind, Slot, WorkStep } from "../types.js";
import type { ThreadCorrection } from "@kletia/core";
import {
  AMT,
  CONNECTOR_VOCAB,
  FILLER,
  NET,
  NETWORK_VOCAB,
  REFUSAL_EXAMPLES,
  SHAPES,
  VENUE_VOCAB,
  VERB_VOCAB,
} from "./shapes.js";

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

export function slot<T>(v: T, by: Slot<T>["by"] = "user"): Slot<T> {
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
export function parseContractClause(clause: string, phrases: readonly ContractPhrase[], index: number, previousExists: boolean): WorkStep | null {
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
export function parseClause(clause: string, previousExists: boolean): WorkStep | null {
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
        if (g.pay) {
          if (net && net !== "solana" && net !== "solana-devnet") throw new PlatformError("INTENT_UNSUPPORTED", `Solana Pay runs on Solana, not on ${net}.`, 422);
          out.protocol = slot(SOLANA_PAY_PROTOCOL);
          if (!net) out.network = slot("solana", "derived");
        }
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
          const guide = shape === "withdraw" && protocol ? EXIT_GUIDES[protocol as keyof typeof EXIT_GUIDES] : undefined;
          if (guide) throw new PlatformError("INTENT_UNSUPPORTED", guide, 422, [{ path: "text", message: "No exit through Kletia." }], REFUSAL_EXAMPLES);
          // "into sdai": the venue word names the vault itself.
          const named = protocol ? vaultOfVenueWord(protocol, g.venue) : undefined;
          if (named) out.vault = slot(named);
        }
        if (g.vault && out.vault && g.vault.toLowerCase() !== out.vault.v) {
          throw new PlatformError("INTENT_UNSUPPORTED", `"${g.venue}" is the ${out.vault.v} venue; it cannot also be "${g.vault.slice(0, 32)}".`, 422);
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
    if (out.kind?.v === "swap" && (g.only || g.viaOnly || g.avoid)) {
      // A Jupiter venue filter: the swap runs on Jupiter with the filter as its provider.
      out.provider = slot(swapFilterProvider(g, net ?? undefined, clause) as string);
      out.protocol = slot("jupiter");
    }
    if (g.amt && g.a && PORTION_AMOUNT.test(g.amt.trim()) && bareOf(clause, g.amt, g.a)) {
      // Portion evidence: "swap half sol" says neither "half my SOL" nor "half a SOL";
      // the amount is asked (with "Half" among the options), never read as a share of the balance.
    } else if (g.amt) {
      // "all my SOL", "half of my USDC" is a share of the holding, never of the previous
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
 * into a keyword: it names no token, amount, network or venue.
 */
const SHORT_CONNECTOR_SLIPS: Readonly<Record<string, string>> = Object.freeze({ too: "to", fo: "for", form: "from" });

/** Single closed-class words (never corrected into a keyword, never corrected at all: I12). */
const CLOSED_WORDS: ReadonlySet<string> = new Set(NEVER_DROP.map((entry) => entry.phrase).filter((phrase) => /^[a-z']+$/u.test(phrase)));

/** At most this many keyword corrections per clause; more and the clause is not read as corrected. */
export const MAX_CORRECTIONS = 2;

export function correctClause(clause: string, index: number): { text: string; corrections: ThreadCorrection[]; verbCandidates?: string[]; verbEnglish?: true } {
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
