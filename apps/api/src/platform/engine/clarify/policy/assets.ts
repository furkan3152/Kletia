/**
 * Asset checks: network contradictions, lookalike and close-symbol
 * questions.
 */
import {
  lookalikeFamilyOf,
  type NetworkKey,
  type ThreadAmount,
} from "@kletia/core";
import { PlatformError } from "../../../errors.js";
import {
  ALIASES,
  AMBIGUOUS_SYMBOLS,
  canonicalOn,
  family,
  lane,
  lookalikeOf,
  LOOKALIKES,
  NETWORK_ORDER,
  networkName,
  symbolsOn,
  transferOnly,
  USD_ORDER,
} from "../catalog.js";
import { assumption, question } from "../copy.js";
import { typoQuestion } from "../../solver/decide.js";
import { cmp, tidy } from "../decimal.js";
import { field } from "../edits.js";
import { candidates } from "../fuzzy.js";
import type { Assumption, Kind, Option, Question, WorkStep } from "../types.js";
import { type Env, exactNeed, held, STEP_VERBS } from "./env.js";

/**
 * A step that spends the previous step's output on another network than the one that output lands on
 * ("bridge 100 usdc from base to arbitrum then deposit it into aave on base"): refused, naming both networks,
 * instead of spending other funds already on the step's network. No crossing is inserted between them.
 */
export function networkContradiction(index: number, kind: Kind, here: NetworkKey, there: NetworkKey, asset: string | undefined, previous: WorkStep | undefined): PlatformError {
  const what = asset ? `the ${asset}` : "its output";
  const [does, verb] = STEP_VERBS[kind] ?? ["runs", "run"];
  const head = kind === "bridge"
    ? `Step ${index + 1} bridges from ${networkName(here)}, but step ${index} delivers ${what} on ${networkName(there)}.`
    : `Step ${index + 1} ${does} on ${networkName(here)}, but step ${index} delivers ${what} on ${networkName(there)}.`;
  const saidBridge = previous?.kind?.v === "bridge" && previous.toNetwork !== undefined && previous.toNetwork.by !== "assumed";
  const tail = kind === "bridge"
    ? `Rewrite it to bridge from ${networkName(there)}, where the funds arrive.`
    : saidBridge
      ? `Rewrite with one network: ${verb} it on ${networkName(there)}, or ${verb} on ${networkName(here)} and skip the bridge.`
      : `Rewrite with one network for both steps, or add a step that bridges it to ${networkName(here)}.`;
  return new PlatformError("INTENT_UNSUPPORTED", `${head} Kletia will not use other funds on ${networkName(here)} in its place. ${tail}`, 422, [
    { path: field(index, "network"), message: `Not where step ${index} delivers.` },
  ]);
}

/* -------------------------------------------------------------- assets */

interface AssetCheck {
  symbol?: string;
  question?: Question;
  assumption?: Assumption;
}

/** ASSET_LOOKALIKE for a word that names a different token than the listed `symbol`: the listed one or cancel, no suggestion. */
function lookalikeQuestion(env: Env, path: string, network: NetworkKey, side: "spend" | "receive", symbol: string, prompt: string, why: string): Question {
  const amount = side === "spend" ? held(env, network, symbol) : undefined;
  const options: Option[] = [
    {
      id: symbol,
      label: `${side === "spend" ? "Use" : "Receive"} ${symbol}`,
      detail: amount !== undefined ? `You hold ${amount} ${symbol} on ${networkName(network)}` : `Listed by Kletia on ${networkName(network)}`,
      value: { asset: symbol },
    },
    { id: "cancel", label: "Neither, cancel", value: { target: "cancel" } },
  ];
  return question(path, "choice", "ASSET_LOOKALIKE", prompt, why, options, true);
}

/**
 * A typed symbol Kletia does not list, with exactly one listed symbol close to it, is asked and never read as
 * that symbol on a chip: a member of the same look-alike family (stETH for wstETH) asks ASSET_LOOKALIKE with
 * what the listed token is and no suggestion; on Solana an unlisted symbol may be a real unverified token, so
 * it asks ASSET_LOOKALIKE ("Did you mean USDC?"); elsewhere a plain typo asks ASSET_TYPO (D9).
 */
function closeSymbolQuestion(env: Env, index: number, name: "from" | "to", network: NetworkKey, raw: string, side: "spend" | "receive", symbol: string): Question {
  const path = field(index, name);
  const typed = raw.slice(0, 16);
  const look = lookalikeOf(raw, symbol);
  if (look) {
    const prompt = `Kletia lists ${symbol}${look.note ? ` (${look.note})` : ""}, not ${look.typed}. ${side === "spend" ? "Use" : "Receive"} ${symbol}?`;
    return lookalikeQuestion(env, path, network, side, symbol, prompt, `${look.typed} and ${symbol} are different tokens. Kletia never uses one in place of the other without asking.`);
  }
  if (family(network) === "solana") {
    return question(path, "choice", "ASSET_LOOKALIKE", `Did you mean ${symbol}?`, `${typed} is not a token Kletia lists. To use an unlisted token deliberately, paste its mint address.`,
      [{ id: symbol, label: symbol, detail: "Listed by Kletia", value: { asset: symbol }, recommended: true }], true);
  }
  return typoQuestion({ typo: { side: side === "spend" ? "spend" : "want", raw: typed, candidates: [symbol] } }, index) as Question;
}

/**
 * ASSET_LOOKALIKE for a typed member of a look-alike family (core
 * LOOKALIKE_FAMILIES) that is not listed on `network`: the listed member it is
 * usually mistaken for when there is one (stETH: wstETH), else every listed
 * member of the family there; never a suggestion. Null when `raw` is no family
 * member, or no member is listed here (the caller refuses).
 */
function lookalikeQuestionFor(env: Env, index: number, name: "from" | "to", network: NetworkKey, raw: string, side: "spend" | "receive", exclude?: string): AssetCheck | null {
  const familyOf = lookalikeFamilyOf(raw);
  if (!familyOf) return null;
  const plain = (symbol: string) => symbol.toUpperCase().replace(/[\s.-]/gu, "");
  const typed = familyOf.members.find((member) => plain(member) === plain(raw)) ?? raw.slice(0, 16);
  // The other side of a swap is never offered ("swap 1 SOL to stSOL" does not offer SOL).
  const here = [...new Set(familyOf.members.map((member) => canonicalOn(network, member)).filter((symbol): symbol is string => symbol !== null && !transferOnly(network, symbol) && symbol.toUpperCase() !== exclude?.toUpperCase()))];
  const counterpart = here.find((symbol) => lookalikeOf(typed, symbol)?.note !== undefined);
  if (counterpart) return { question: closeSymbolQuestion(env, index, name, network, typed, side, counterpart) };
  if (here.length === 0) return null;
  const path = field(index, name);
  const options: Option[] = here.slice(0, 7).map((symbol) => {
    const amount = side === "spend" ? held(env, network, symbol) : undefined;
    return { id: symbol, label: `${side === "spend" ? "Use" : "Receive"} ${symbol}`, detail: amount !== undefined ? `You hold ${amount} ${symbol} on ${networkName(network)}` : `Listed by Kletia on ${networkName(network)}`, value: { asset: symbol } };
  });
  options.push({ id: "cancel", label: "Neither, cancel", value: { target: "cancel" } });
  return {
    question: question(path, "choice", "ASSET_LOOKALIKE", `Kletia does not list ${typed} on ${networkName(network)}. Which token did you mean?`,
      `${typed} is a different token from each of these. Kletia never uses one in place of another without asking.`, options, true),
  };
}

/** Resolves an asset the user named on one network (R5). */
export function checkAsset(env: Env, index: number, name: "from" | "to", network: NetworkKey, raw: string, by: string, side: "spend" | "receive", amount: ThreadAmount | undefined, kind: Kind, exclude?: string): AssetCheck {
  const path = field(index, name);
  const purpose = kind === "transfer" || kind === "bridge";
  const canonical = canonicalOn(network, raw);
  if (canonical) {
    const need = exactNeed(amount);
    const pair = LOOKALIKES.find((entry) => entry.network === network && (entry.a === canonical || entry.b === canonical));
    if (side === "spend" && pair && need && by === "user") {
      const other = pair.a === canonical ? pair.b : pair.a;
      // A transfer-only look-alike is offered only for a transfer: no venue can spend it.
      const usable = kind === "transfer" || !transferOnly(network, other);
      const mine = env.facts.balance(network, canonical);
      const theirs = env.facts.balance(network, other);
      if (usable && mine !== undefined && theirs !== undefined && cmp(mine, need) < 0 && cmp(theirs, need) >= 0) {
        const options: Option[] = [
          { id: canonical, label: canonical, detail: `You hold ${tidy(mine)}`, value: { asset: canonical } },
          { id: other, label: other, detail: `${pair.note} You hold ${tidy(theirs)}.`, value: { asset: other }, ...(purpose ? {} : { recommended: true as const }) },
        ];
        return { question: question(path, "choice", "ASSET_LOOKALIKE", `You hold ${tidy(mine)} ${canonical} on ${networkName(network)}. Which token should this use?`, pair.note, options, false) };
      }
    }
    if (kind !== "transfer" && transferOnly(network, canonical)) {
      throw new PlatformError("ROUTE_UNSUPPORTED", `${canonical} on ${networkName(network)} is listed for balances and transfers only; no venue Kletia uses swaps, bridges or deposits it.`, 422, [{ path, message: "Transfer only." }]);
    }
    return { symbol: canonical };
  }
  const upper = raw.toUpperCase();
  const alias = ALIASES.find((entry) => (entry.network === network || entry.network === "*") && entry.from === upper && canonicalOn(network, entry.to));
  if (alias) {
    const symbol = canonicalOn(network, alias.to) as string;
    if (alias.lookalike) return { question: lookalikeQuestion(env, path, network, side, symbol, side === "spend" ? alias.lookalike.spend : alias.lookalike.receive, alias.note) };
    if (alias.silent) return { symbol };
    return { symbol, assumption: assumption(path, `${raw} means ${symbol}`, { asset: symbol }, "alias", alias.note, [], alias.material === true) };
  }
  const ambiguous = AMBIGUOUS_SYMBOLS.find((entry) => entry.network === network && entry.symbol === upper);
  if (ambiguous) {
    const options = ambiguous.options.map((entry) => {
      const amount = held(env, network, entry.symbol);
      return { id: entry.symbol, label: entry.symbol, detail: `${entry.detail}${amount !== undefined ? `; you hold ${amount}` : ""}`, value: { asset: entry.symbol }, ...(entry.recommended ? { recommended: true as const } : {}) };
    });
    return { question: question(path, "choice", "ASSET_AMBIGUOUS", `On ${networkName(network)}, "${raw.slice(0, 16)}" could mean two tokens. Which one?`, "They are worth very different amounts.", options, false) };
  }
  // R5: a real token listed on another network is never "corrected" into a different one.
  const elsewhere = NETWORK_ORDER.filter((other) => other !== network && lane(other) === lane(network) && canonicalOn(other, raw));
  if (elsewhere.length > 0) {
    if (side === "spend") {
      const stable = USD_ORDER.find((symbol) => canonicalOn(network, symbol) && !transferOnly(network, symbol));
      const amount = stable ? held(env, network, stable) : undefined;
      const options: Option[] = stable && USD_ORDER.includes(upper)
        ? [{ id: stable, label: stable, detail: `Listed on ${networkName(network)}${amount !== undefined ? `; you hold ${amount}` : ""}`, value: { asset: stable } }]
        : [];
      return { question: question(path, "choice", "ASSET_NOT_ON_NETWORK", `Kletia does not list ${raw.slice(0, 16)} on ${networkName(network)}. What should this use?`, `${raw.slice(0, 16)} is listed on ${elsewhere.map(networkName).join(", ")}.`, options, true) };
    }
    // On Solana an unlisted symbol may be a real token the planner verifies, but never one Kletia lists elsewhere under
    // a look-alike family name (ETH on Solana is not Ethereum's ETH): refused like on every other network.
    if (family(network) !== "solana" || lookalikeFamilyOf(raw)) throw new PlatformError("TOKEN_UNKNOWN", `${raw.slice(0, 16)} is not listed on ${networkName(network)}.`, 422, [{ path, message: "Not listed on this network." }]);
  }
  // R5 across lanes: a real token listed only on the other lane (USDT on a testnet) is never read as a near
  // symbol of this network (USDT is one letter from USDC); say it is not available here instead.
  const otherLane = elsewhere.length === 0 ? NETWORK_ORDER.filter((other) => lane(other) !== lane(network) && canonicalOn(other, raw)) : [];
  if (otherLane.length > 0) {
    const symbol = raw.slice(0, 16);
    const here = symbolsOn(network).filter((listed) => !transferOnly(network, listed)).slice(0, 6);
    const where = lane(network) === "testnet" ? `${networkName(network)} (a testnet)` : networkName(network);
    const listedOn = `${symbol} is listed on ${lane(otherLane[0] as NetworkKey) === "testnet" ? "testnets" : "mainnet networks"} only (${otherLane.slice(0, 3).map(networkName).join(", ")}).`;
    if (side === "spend") {
      const stable = USD_ORDER.find((candidate) => canonicalOn(network, candidate) && !transferOnly(network, candidate));
      const amount = stable ? held(env, network, stable) : undefined;
      const options: Option[] = stable && USD_ORDER.includes(upper)
        ? [{ id: stable, label: stable, detail: `Listed on ${networkName(network)}${amount !== undefined ? `; you hold ${amount}` : ""}`, value: { asset: stable } }]
        : [];
      return { question: question(path, "choice", "ASSET_NOT_ON_NETWORK", `${symbol} is not available on ${where}. What should this use?`, listedOn, options, true) };
    }
    throw new PlatformError(
      "TOKEN_UNKNOWN",
      `${symbol} is not available on ${where}. ${listedOn}${here.length > 0 ? ` On ${networkName(network)} Kletia lists ${here.join(", ")}.` : ""}`,
      422,
      [{ path, message: `${symbol} is not available on this network.` }],
    );
  }
  const listed = symbolsOn(network).filter((symbol) => !transferOnly(network, symbol));
  // On every path: a typed member of a look-alike family that Kletia does not list (stETH, eETH, stSOL, USDC.e) is
  // asked with the listed members, never read as one of them and never passed on as an unverified token.
  const lookalike = lookalikeQuestionFor(env, index, name, network, raw, side, exclude);
  if (lookalike) return lookalike;
  const near = candidates(raw, listed);
  // A symbol is never corrected: one close listed symbol is asked, on both sides and every network family.
  if (near.length === 1) return { question: closeSymbolQuestion(env, index, name, network, raw, side, near[0] as string) };
  if (family(network) === "solana") {
    // An unlisted Solana symbol may be a verified token or an unverified look-alike, which only the planner's
    // token list can tell: close listed symbols are asked ("did you mean USDC?"), never corrected or offered
    // as the unverified token; anything else goes to the planner, which refuses unverified tokens.
    if (near.length > 1) {
      const options = near.map((symbol) => ({ id: symbol, label: symbol, detail: "Listed by Kletia", value: { asset: symbol } }));
      return { question: question(path, "choice", "ASSET_LOOKALIKE", `Did you mean ${near.join(" or ")}?`, `${raw.slice(0, 16)} is not a token Kletia lists. To use an unlisted token deliberately, paste its mint address.`, options, true) };
    }
    return { symbol: raw };
  }
  if (near.length > 1) {
    const options = near.map((symbol) => ({ id: symbol, label: symbol, value: { asset: symbol } }));
    return { question: question(path, "choice", "ASSET_AMBIGUOUS", `Which token did you mean by "${raw.slice(0, 16)}"?`, "Several listed tokens are spelled almost the same.", options, true) };
  }
  throw new PlatformError("TOKEN_UNKNOWN", `Unknown token "${raw.slice(0, 16)}" on ${networkName(network)}.`, 422, [{ path, message: "Unknown token." }]);
}
