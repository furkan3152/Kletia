/**
 * The sensitivity policy (rules R0-R14): for every step of a thread it
 * decides, slot by slot, whether to ask, assume (a chip) or refuse, using
 * only the wallet facts read for this turn. Purpose slots (who receives,
 * where it arrives, what to receive or spend, how much, the network a
 * transfer lands on) are asked; means slots (where a swap or deposit runs,
 * which vault, which staking provider) are assumed and shown.
 *
 * Pure and synchronous over (state, context, facts): it mutates only
 * `assumed` slots of the state it is given (so a kept assumption stays put
 * on later turns, R0) and throws PlatformError for what no question can fix.
 */
import {
  CHAINS,
  CLOSED_CLASS_REFUSAL_OF,
  evmChecksumState,
  findAssetBySymbol,
  isEvmAddress,
  lookalikeFamilyOf,
  protocolTier,
  NATIVE_FEE_RESERVE,
  parseAccountId,
  type AssumptionSource,
  type ClarifyReason,
  type NetworkKey,
  type ProtocolId,
  type ThreadAmount,
  YIELD_VENUES,
} from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { matchContractPhrase, NATIVE_STAKE_PROTOCOL } from "../grammar.js";
import {
  ALIASES,
  AMBIGUOUS_SYMBOLS,
  ambiguousVenue,
  BRIDGE_NETWORKS,
  bridgeNetworksOf,
  canonicalOn,
  decimalsOf,
  defaultProvider,
  dexNetworks,
  EVM_NETWORKS,
  family,
  hasAccount,
  isName,
  isUsdWord,
  l2StakeOptions,
  lane,
  laneOf,
  lendingProtocols,
  lookalikeOf,
  LOOKALIKES,
  NETWORK_ORDER,
  networkName,
  ownAddress,
  portable,
  protocolLabel,
  rankedVenueOptions,
  recipientFamily,
  stakeProvider,
  STAKE_PROVIDERS,
  SWAP_NETWORKS,
  symbolsOn,
  transferOnly,
  USD_ORDER,
  venueNetworks,
  venuesOn,
} from "./catalog.js";
import { assumption, clip, closedClassRefusal, placeholderFor, PROTOCOL_QUESTION_COPY, question, reasonText, short, isReasonCode, type ReasonCode, type ReasonParams } from "./copy.js";
import { MAX_POSITION_READS, type DecisionFacts } from "./facts.js";
import { confirmPrompt, endStateDigest, gasSymbol, recipientLabel, settledAcks } from "../solver/confirm.js";
import { GAS_TOPUP_USD, gasShortfalls, type GasShortfall } from "../solver/gasNeeds.js";
import { invariantRefusal, readyViolations, spendsPrevious, type ActionMeta } from "../solver/invariants.js";
import { movesReason } from "../solver/moves.js";
import { expandGoalSteps } from "./goals.js";
import { symbolTypoCandidates } from "../goal/lexer.js";
import { priceAmount, typoQuestion } from "../solver/decide.js";
import { apyLabel, riskLabel } from "../solver/explain.js";
import { cmp, formatDecimal, isDecimal, isPositive, parseDecimal, portion, sub, tidy } from "./decimal.js";
import { field, pendingEditQuestion } from "./edits.js";
import { candidates } from "./fuzzy.js";
import type { Analysis, Assumption, FactsView, Kind, Option, Question, ResolvedAction, TurnContext, WorkState, WorkStep } from "./types.js";

interface Env {
  readonly ctx: TurnContext;
  readonly facts: FactsView;
}

/* ------------------------------------------------------------ helpers */

function exactNeed(amount: ThreadAmount | undefined): string | null {
  return amount?.t === "exact" ? amount.value : null;
}

function usdStable(env: Env, network: NetworkKey, need: string | null, side: "spend" | "receive"): { symbol: string; alternatives: string[] } | null {
  const listed = USD_ORDER.filter((symbol) => canonicalOn(network, symbol) && !transferOnly(network, symbol));
  if (listed.length === 0) return null;
  if (side === "spend" && need) {
    const covering = listed.filter((symbol) => {
      const balance = env.facts.balance(network, symbol);
      return balance !== undefined && cmp(balance, need) >= 0;
    });
    if (covering.length > 0) return { symbol: covering[0] as string, alternatives: listed.filter((symbol) => symbol !== covering[0]) };
  }
  return { symbol: listed[0] as string, alternatives: listed.slice(1) };
}

/** The listed symbol a raw token stands for on a network (canonical, alias, USD words); funding checks only. */
function symbolOnNetwork(env: Env, network: NetworkKey, raw: string | undefined, usd: boolean | undefined): string | null {
  if (!raw) return usd ? usdStable(env, network, null, "spend")?.symbol ?? null : null;
  const canonical = canonicalOn(network, raw);
  if (canonical) return canonical;
  const upper = raw.toUpperCase();
  const alias = ALIASES.find((entry) => (entry.network === network || entry.network === "*") && entry.from === upper);
  if (alias) return canonicalOn(network, alias.to);
  // An ambiguous symbol ("ETH" on Polygon) never makes a network a candidate the user did not name.
  if (isUsdWord(raw)) return usdStable(env, network, null, "spend")?.symbol ?? null;
  return null;
}

/** Balance minus the native fee reserve, times bps (R6). */
function spendable(env: Env, network: NetworkKey, symbol: string, bps: number): bigint | undefined {
  const balance = env.facts.balance(network, symbol);
  if (balance === undefined) return undefined;
  const share = portion(balance, bps);
  if (CHAINS[network].nativeAsset.symbol.toUpperCase() !== symbol.toUpperCase()) return share;
  const cap = sub(balance, NATIVE_FEE_RESERVE[network]);
  return share < cap ? share : cap;
}

interface Funding {
  known: boolean;
  covering: NetworkKey[];
  balances: Map<NetworkKey, string>;
}

/** Which candidate networks hold enough (or any, when the amount is not exact). */
function funding(env: Env, networks: readonly NetworkKey[], symbolOn: (network: NetworkKey) => string | null, amount: ThreadAmount | undefined): Funding {
  const balances = new Map<NetworkKey, string>();
  let known = true;
  for (const network of networks) {
    const symbol = symbolOn(network);
    if (!symbol) continue;
    const balance = env.facts.balance(network, symbol);
    if (balance === undefined) known = false;
    else balances.set(network, balance);
  }
  const need = exactNeed(amount);
  const covering = [...balances.entries()]
    .filter(([network, balance]) => {
      if (need) return cmp(balance, need) >= 0;
      const usable = spendable(env, network, symbolOn(network) as string, 10_000);
      return usable !== undefined && usable > 0n;
    })
    .map(([network]) => network);
  return { known: known && balances.size > 0, covering, balances };
}

function byLargest(networks: readonly NetworkKey[], balances: Map<NetworkKey, string>): NetworkKey[] {
  return [...networks].sort((a, b) => {
    const order = cmp(balances.get(b) ?? "0", balances.get(a) ?? "0");
    return order !== 0 ? order : NETWORK_ORDER.indexOf(a) - NETWORK_ORDER.indexOf(b);
  });
}

function networkOption(network: NetworkKey, detail?: string, extra: Partial<Option> = {}): Option {
  return { id: network, label: networkName(network), ...(detail ? { detail } : {}), value: { network }, ...extra };
}

function held(env: Env, network: NetworkKey, symbol: string): string | undefined {
  const balance = env.facts.balance(network, symbol);
  return balance === undefined ? undefined : tidy(balance, Math.min(decimalsOf(network, symbol), 6));
}

function holdDetail(env: Env, balances: Map<NetworkKey, string>, network: NetworkKey, symbol: string | null, need: string | null): string | undefined {
  const balance = balances.get(network);
  if (balance === undefined || !symbol) return undefined;
  const enough = need === null || cmp(balance, need) >= 0;
  return `You hold ${held(env, network, symbol)} ${symbol}${enough ? "" : " (not enough)"}`;
}

/** Stores an assumed value (R0: never over a stated one), with its reason code so the chip stays put. */
function remember(step: WorkStep, name: "network" | "provider", value: string, why: { source: AssumptionSource; code: ReasonCode }): void {
  const current = step[name];
  if (!current || current.by === "assumed") (step as Record<string, unknown>)[name] = { v: value, by: "assumed", why };
}

function amountPhrase(step: WorkStep, symbol?: string): string {
  const asset = symbol ?? step.from?.v ?? (step.usdFrom ? "USD" : "it");
  if (step.amount?.v.t === "exact") return `${step.amount.v.value} ${asset}`;
  return asset === "it" ? "it" : `the ${asset}`;
}

/** Swap networks where both tokens are known (grammar inferSwapNetwork), limited to a named venue's networks. */
function swapCandidates(env: Env, step: WorkStep, from = step.from?.v, to = step.to?.v): NetworkKey[] {
  const tokens = [from ?? (step.usdFrom ? "usd" : undefined), to ?? (step.usdTo ? "usd" : undefined)].filter((token): token is string => token !== undefined);
  const venue = dexNetworks(step.protocol?.v);
  const current = laneOf(env.ctx.accounts);
  const lanePool = SWAP_NETWORKS.filter((network) => lane(network) === current);
  const pool = venue ? lanePool.filter((network) => venue.includes(network)) : lanePool;
  const networks = pool.filter((network) => tokens.every((token) => symbolOnNetwork(env, network, token, false) !== null));
  const usable = networks.filter((network) => hasAccount(env.ctx.accounts, network));
  if (usable.length > 0) return usable;
  if (networks.length > 0) return networks;
  const evmKnown = tokens.some((token) => SWAP_NETWORKS.some((network) => CHAINS[network].vm === "evm" && canonicalOn(network, token)) && !canonicalOn("solana", token));
  return !evmKnown && (!venue || venue.includes("solana")) ? ["solana"] : [];
}

function refuseUnsupported(message: string): PlatformError {
  return new PlatformError("INTENT_UNSUPPORTED", message, 422, [{ path: "text", message: "Not supported." }]);
}

const STEP_VERBS: Readonly<Partial<Record<Kind, readonly [string, string]>>> = {
  swap: ["swaps", "swap"],
  deposit: ["deposits", "deposit"],
  withdraw: ["withdraws", "withdraw"],
  stake: ["stakes", "stake"],
  transfer: ["sends", "send"],
};

/**
 * A step that spends the previous step's output on another network than the one that output lands on
 * ("bridge 100 usdc from base to arbitrum then deposit it into aave on base"): refused, naming both networks,
 * instead of spending other funds already on the step's network. No crossing is inserted between them.
 */
function networkContradiction(index: number, kind: Kind, here: NetworkKey, there: NetworkKey, asset: string | undefined, previous: WorkStep | undefined): PlatformError {
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
function checkAsset(env: Env, index: number, name: "from" | "to", network: NetworkKey, raw: string, by: string, side: "spend" | "receive", amount: ThreadAmount | undefined, kind: Kind, exclude?: string): AssetCheck {
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
  // A10 on every path: a typed member of a look-alike family that Kletia does not list (stETH, eETH, bSOL, USDC.e) is
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

/* ------------------------------------------------------------- amounts */

/** R6: how much, with balance shortcuts when known. */
function amountQuestion(env: Env, index: number, step: WorkStep, network: NetworkKey, from: string): Question {
  const path = field(index, "amount");
  const decimals = decimalsOf(network, from);
  const options: Option[] = [];
  if (step.kind?.v === "withdraw") {
    const position = env.facts.position(network, step.protocol?.v ?? "", from);
    options.push({ id: "all", label: position && isPositive(position) ? `All · ${tidy(position, decimals)} ${from}` : "All", detail: "Closes the position", value: { amount: { t: "position", bps: 10_000 } } });
    if (position !== undefined && isPositive(position)) {
      options.push({ id: "half", label: `Half · ${formatDecimal(portion(position, 5_000), decimals)} ${from}`, value: { amount: { t: "position", bps: 5_000 } } });
    } else {
      options.push({ id: "half", label: "Half", detail: "Half of the position", value: { amount: { t: "position", bps: 5_000 } } });
    }
    return question(path, "amount", "AMOUNT_MISSING", `How much ${from} should come out?`, position !== undefined ? `Your position is ${tidy(position, decimals)} ${from}.` : "Say an amount, or all.", options, true, placeholderFor("amount", from));
  }
  const all = spendable(env, network, from, 10_000);
  if (all !== undefined && all > 0n) {
    const native = CHAINS[network].nativeAsset.symbol === from;
    options.push({ id: "all", label: `All · ${formatDecimal(all, decimals)} ${from}`, ...(native ? { detail: `Keeps ${NATIVE_FEE_RESERVE[network]} ${from} for network fees` } : {}), value: { amount: { t: "balance", bps: 10_000 } } });
    options.push({ id: "half", label: `Half · ${formatDecimal(spendable(env, network, from, 5_000) as bigint, decimals)} ${from}`, value: { amount: { t: "balance", bps: 5_000 } } });
  }
  const shown = held(env, network, from);
  return question(path, "amount", "AMOUNT_MISSING", `How much ${from}?`, shown !== undefined ? `You hold ${shown} ${from} on ${networkName(network)}.` : "Say an amount, or all / half of your balance.", options, true, placeholderFor("amount", from));
}

/** R12: a second question only when it cannot change the first one's options. */
function withIndependent(env: Env, index: number, step: WorkStep, first: Question): Question[] {
  if (step.amount || (!step.from && !step.usdFrom) || step.contract) return [first];
  let network: NetworkKey | undefined;
  if (first.reason === "RECIPIENT_MISSING" && step.network && step.network.by !== "assumed") network = step.network.v;
  if (first.reason === "DESTINATION_MISSING" && step.network) network = step.network.v;
  if (first.reason === "OUTPUT_ASSET_MISSING") {
    const networks = step.network ? [step.network.v] : swapCandidates(env, step, step.from?.v, undefined);
    if (networks.length === 1) network = networks[0];
  }
  if (!network) return [first];
  const from = symbolOnNetwork(env, network, step.from?.v, step.usdFrom);
  if (!from) return [first];
  return [first, amountQuestion(env, index, step, network, from)];
}

interface AmountChoice {
  amount?: string;
  portionBps?: number;
  question?: Question;
  assumption?: Assumption;
}

/** R6: amounts. */
function resolveAmount(env: Env, index: number, step: WorkStep, network: NetworkKey, from: string): AmountChoice {
  const path = field(index, "amount");
  const amount = step.amount?.v;
  const decimals = decimalsOf(network, from);
  if (!amount) return { question: amountQuestion(env, index, step, network, from) };
  if (amount.t === "exact") {
    if (step.usdFrom && !USD_ORDER.includes(from.toUpperCase())) {
      return { question: question(path, "amount", "AMOUNT_MISSING", `How much ${from}?`, "A $ amount is paid in a USD stablecoin; say the amount in the token instead.", [], true, placeholderFor("amount", from)) };
    }
    if (amount.raw && /^\d{1,3},\d{3}$/u.test(amount.raw) && step.amount?.by === "user") {
      const decimal = formatDecimal(parseDecimal(amount.raw.replace(",", ".")), decimals);
      const balance = env.facts.balance(network, from);
      if (balance !== undefined && cmp(balance, amount.value) < 0 && cmp(balance, decimal) >= 0) {
        return {
          question: question(path, "choice", "AMOUNT_FORMAT_AMBIGUOUS", `Did you mean ${decimal} ${from} or ${amount.raw} ${from}?`, `You hold ${tidy(balance)} ${from}, which covers only ${decimal}.`, [
            { id: "decimal", label: `${decimal} ${from}`, detail: "The comma as a decimal point", value: { amount: { t: "exact", value: decimal } }, recommended: true },
            { id: "thousands", label: `${amount.raw} ${from}`, detail: "The comma as a thousands separator", value: { amount: { t: "exact", value: amount.value } } },
          ], false),
        };
      }
    }
    return { amount: amount.value };
  }
  if (amount.t === "previous") {
    if (index === 0) return { question: question(path, "amount", "AMOUNT_MISSING", `How much ${from}?`, "\"it\" refers to a previous step.", [], true, placeholderFor("amount", from)) };
    return { amount: "max", ...(amount.bps !== 10_000 ? { portionBps: amount.bps } : {}) };
  }
  if (amount.t === "position") {
    if (amount.bps === 10_000) return { amount: "max" };
    const position = env.facts.position(network, step.protocol?.v ?? "", from);
    if (position === undefined) return { question: question(path, "amount", "AMOUNT_BALANCE_UNKNOWN", `How much ${from} should come out?`, "Kletia could not read your position; say an exact amount.", [], true, placeholderFor("amount", from)) };
    const value = formatDecimal(portion(position, amount.bps), decimals);
    return { amount: value, assumption: assumption(path, `${amount.bps / 100}% of your position: ${value} ${from}`, { amount }, "position", `Your position is ${tidy(position)} ${from}.`, [], true) };
  }
  if (amount.t === "usd") {
    // D11: a stablecoin counts at par; another token is priced (chip with the price), or asked without a usable price.
    if (USD_ORDER.includes(from.toUpperCase()) || findAssetBySymbol(network, from)?.category === "stablecoin") return { amount: amount.value };
    const price = env.facts.usdPrice?.(network, from);
    const asset = findAssetBySymbol(network, from);
    const priced = price && asset
      ? priceAmount({ index, usd: amount.value, symbol: from, decimals, price: { asset: asset.id, usd: price.usd, source: price.source as never, at: price.at, readAt: price.at, stale: false } })
      : null;
    if (!priced) {
      return { question: question(path, "amount", "AMOUNT_MISSING", `How much ${from}?`, `Kletia could not price ${from} right now; say the amount in ${from}.`, [], true, placeholderFor("amount", from)) };
    }
    return { amount: priced.value, assumption: { ...priced.assumption, source: "price" } };
  }
  const value = spendable(env, network, from, amount.bps);
  if (value === undefined) return { question: question(path, "amount", "AMOUNT_BALANCE_UNKNOWN", `How much ${from}?`, "Kletia cannot read your balance; say an exact amount.", [], true, placeholderFor("amount", from)) };
  if (value <= 0n) throw new PlatformError("AMOUNT_TOO_SMALL", `Your ${from} balance on ${networkName(network)} is too small to spend.`, 422, [{ path, message: "Balance too small." }]);
  const formatted = formatDecimal(value, decimals);
  const native = CHAINS[network].nativeAsset.symbol === from;
  const label = amount.bps === 10_000 ? `All your ${from}: ${formatted}` : `${amount.bps / 100}% of your ${from}: ${formatted}`;
  return {
    amount: formatted,
    assumption: assumption(path, label, { amount }, "balance", `You hold ${held(env, network, from)} ${from} on ${networkName(network)}${native ? `; ${NATIVE_FEE_RESERVE[network]} ${from} stays for network fees` : ""}.`, [], true),
  };
}

/* ---------------------------------------------------------- recipients */

/** R8: recipients are asked, never assumed, completed or corrected. */
function recipientQuestion(env: Env, index: number, step: WorkStep): Question | null {
  const path = field(index, "recipient");
  const what = amountPhrase(step);
  const solana = step.network ? family(step.network.v) === "solana" : false;
  const placeholder = placeholderFor("address", undefined, solana);
  if (!step.recipient && step.nickname) {
    return question(path, "address", "RECIPIENT_MISSING", `Who should receive ${what}? Enter their address or full name (for example name.eth).`, "Kletia never guesses a recipient from a nickname.", [], true, placeholder);
  }
  if (!step.recipient) return question(path, "address", "RECIPIENT_MISSING", `Who should receive ${what}?`, "Enter an address or a name such as name.eth, name.base.eth or name.sns.", [], true, placeholder);
  const recipient = step.recipient.v;
  if (/^0x[0-9a-fA-F]{40}$/u.test(recipient) && evmChecksumState(recipient) === "invalid") {
    return question(path, "address", "RECIPIENT_CHECKSUM", `The capital letters in ${short(recipient)} do not match its checksum. Check the address and enter it again.`, "A checksum mismatch usually means a mistyped character. Kletia never corrects an address.", [], true, placeholder);
  }
  const kind = recipientFamily(recipient);
  // Where the recipient receives: a bridge pays on its destination, a transfer on its stated network. A Solana
  // recipient receives only on Solana: a stated Ethereum-family network is where the money is sent from
  // (transferPlacement). An Ethereum-family recipient with a stated Solana network is asked which one was meant.
  const stated = step.network && step.network.by !== "assumed" ? step.network.v : undefined;
  const network = step.kind?.v === "bridge" ? step.toNetwork?.v : stated && !(kind === "solana" && family(stated) !== "solana") ? stated : undefined;
  // A raw address is held to its family too (an EVM address is never paid on Solana).
  if (!isName(recipient)) return network && kind && kind !== "caip" && kind !== family(network) ? familyQuestion(env, index, step, recipient, kind, network) : null;
  if (/\.sol$/iu.test(recipient)) {
    const moved = recipient.replace(/\.sol$/iu, ".sns");
    const address = env.facts.resolveName(moved, "solana");
    if (address) {
      return question(path, "confirm", "RECIPIENT_NAME_MOVED", `Send to ${moved} (${short(address)})? SNS has paused .sol names during its registry move, and ${recipient} now resolves as ${moved}.`, "Each existing .sol name has a matching .sns name. Kletia shows the address it resolves to; check it before you sign.", [
        { id: moved, label: `Send to ${moved}`.slice(0, 48), detail: `Resolves to ${short(address)}`, value: { recipient: moved } },
      ], true, placeholderFor("address", undefined, true));
    }
    return question(path, "address", "RECIPIENT_UNRESOLVED", `Who should receive ${what}? ${recipient} cannot be used: SNS has paused .sol names during its registry move, and ${moved} did not resolve.`, "Paste the recipient's Solana address, or use their .sns name.", [], true, placeholderFor("address", undefined, true));
  }
  if (network && kind && kind !== "caip" && kind !== family(network)) return familyQuestion(env, index, step, recipient, kind, network);
  const probe = network ?? (kind === "solana" ? "solana" : "base");
  if (env.facts.resolveName(recipient, probe) === null) {
    return question(path, "address", "RECIPIENT_UNRESOLVED", `${recipient} has no ${networkName(probe)} address Kletia could find. Who should receive ${what}?`, "Check the spelling or paste the address. Kletia does not suggest other names.", [], true, placeholder);
  }
  return null;
}

/**
 * A recipient of one network family with a stated network of the other
 * (RECIPIENT_NETWORK_MISMATCH): enter a recipient of that network, or send on
 * a network of the recipient's family (where the person holds the asset).
 */
function familyQuestion(env: Env, index: number, step: WorkStep, recipient: string, kind: "eip155" | "solana", network: NetworkKey): Question {
  const path = field(index, "recipient");
  const evm = EVM_NETWORKS.filter((candidate) => lane(candidate) === lane(network)).filter((candidate) => {
    const symbol = symbolOnNetwork(env, candidate, step.from?.v, step.usdFrom);
    return symbol !== null && isPositive(env.facts.balance(candidate, symbol));
  });
  const options = kind === "eip155"
    ? evm.slice(0, 3).map((candidate) => networkOption(candidate, `You hold ${held(env, candidate, symbolOnNetwork(env, candidate, step.from?.v, step.usdFrom) as string)}`, { label: `Send on ${networkName(candidate)} instead` }))
    : [];
  const what = isName(recipient) ? `${kind === "eip155" ? "an Ethereum" : "a Solana"} name with no ${networkName(network)} address` : `${kind === "eip155" ? "an Ethereum-family" : "a Solana"} address that cannot receive on ${networkName(network)}`;
  return question(path, "address", "RECIPIENT_NETWORK_MISMATCH", `${short(recipient)} is ${what}. Enter a ${networkName(network)} address, or send on another network.`,
    isName(recipient) ? "Names resolve only on their own network family." : "An address belongs to one network family; funds sent across families are lost.", options, true, placeholderFor("address", undefined, family(network) === "solana"));
}

/* ------------------------------------------------------------- networks */

interface NetworkChoice {
  network?: NetworkKey;
  question?: Question;
  assumption?: Assumption;
  /** R4b: the departure the step is bridged from (departure.ts adds the bridge; never stored). */
  departureBridge?: NetworkKey;
  /**
   * A payment whose money is on another network than the one the recipient
   * receives on: where it comes from, and why that network (the
   * person said it, the caller's departure, or the `auto` departure's coverage).
   */
  source?: { readonly network: NetworkKey; readonly why: "said" | "answer" | "departure" | "auto" };
}

/**
 * The symbols a crossing leg moves from `from` to `to` for `symbol` (as it is
 * named on `from`), or null when no bridge carries it there (for now:
 * canonical USDC between the mainnets that list it, native ETH between the
 * ETH networks; on the testnet lane, USDC between the CCTP testnets).
 */
export function crossingSymbols(symbol: string, from: NetworkKey, to: NetworkKey): { readonly from: string; readonly to: string } | null {
  if (from === to || lane(from) !== lane(to)) return null;
  if (lane(from) === "testnet") {
    const pool = bridgeNetworksOf("testnet");
    if (!pool.includes(from) || !pool.includes(to) || symbol.toUpperCase() !== "USDC") return null;
    const a = canonicalOn(from, "USDC");
    const b = canonicalOn(to, "USDC");
    return a && b ? { from: a, to: b } : null;
  }
  return portableSymbolOf(symbol, from, to);
}

/** Portability through departure.ts's rule (canonical USDC, native ETH between the ETH networks). */
function portableSymbolOf(symbol: string, from: NetworkKey, to: NetworkKey): { from: string; to: string } | null {
  if (!portable(symbol, false, from, to)) return null;
  const a = canonicalOn(from, symbol);
  const b = canonicalOn(to, symbol);
  return a && b ? { from: a, to: b } : null;
}

/**
 * The options of TRANSFER_NETWORK: where the person can pay from (the
 * networks that cover the amount, else those holding some, else every
 * network listing the asset), or, when the money comes from another network,
 * every network a crossing leg reaches. Never a suggestion (purpose).
 */
function receivingOptions(env: Env, kindOf: "eip155" | "solana", current: "mainnet" | "testnet", symbolOn: (network: NetworkKey) => string | null, source: NetworkKey | undefined, need: string | null, amount: ThreadAmount | undefined): Option[] {
  const listed = NETWORK_ORDER.filter((network) => lane(network) === current && family(network) === kindOf && hasAccount(env.ctx.accounts, network));
  if (source) {
    return listed.filter((network) => network === source || crossingSymbols(symbolOn(source) ?? "", source, network) !== null)
      .map((network) => networkOption(network, network === source ? undefined : `Kletia bridges it from ${networkName(source)}`));
  }
  const pool = listed.filter((network) => symbolOn(network) !== null);
  const f = funding(env, pool, symbolOn, amount);
  const positive = byLargest(pool.filter((network) => isPositive(f.balances.get(network))), f.balances);
  const chosen = f.known && f.covering.length > 0 ? byLargest(f.covering, f.balances) : f.known && positive.length > 0 ? positive : pool;
  return chosen.map((network) => networkOption(network, holdDetail(env, f.balances, network, symbolOn(network), need)));
}

/**
 * Where a payment to someone else lands and where its money comes from. The
 * receiving network is purpose, never a chip: the network the person said (of
 * the recipient's family), the one the recipient implies (CAIP-10, `.base.eth`,
 * a Solana name or address), or where the previous output lands; otherwise
 * TRANSFER_NETWORK asks. A said network of the other family is where the money
 * is (`send 50 usdc on polygon to carol.sns`), like `fundFrom`, a fixed
 * departure, or `auto` when the receiving network does not cover the amount:
 * the payment then becomes one crossing leg that pays the recipient (the policy
 * asks DELIVERY_AMOUNT).
 */
function transferPlacement(env: Env, index: number, step: WorkStep, prevDest: NetworkKey | undefined, prevOut: string | undefined): NetworkChoice {
  const { ctx } = env;
  const path = field(index, "network");
  const current = laneOf(ctx.accounts);
  const recipient = step.recipient?.v as string;
  const kindOf = recipientFamily(recipient);
  const said = step.network && step.network.by !== "assumed" ? step.network : undefined;
  const dependent = step.amount?.v.t === "previous";
  const symbolOn = (network: NetworkKey) => symbolOnNetwork(env, network, step.from?.v, step.usdFrom);
  const need = exactNeed(step.amount?.v);
  let receiving: NetworkKey | undefined;
  let source: NetworkChoice["source"];
  if (kindOf === "caip") receiving = parseAccountId(recipient)?.chain.key as NetworkKey;
  else if (/\.base\.eth$/iu.test(recipient)) receiving = "base";
  else if (kindOf === "solana") receiving = current === "testnet" ? "solana-devnet" : "solana";
  if (said) {
    const sameFamily = kindOf === null || (kindOf !== "caip" && family(said.v) === kindOf);
    // A said network of the recipient's family is where it receives; beside a Solana recipient or a CAIP-10 id
    // (which name their network), a network of another family is where the money is.
    if (sameFamily) receiving = said.v;
    else if (said.v !== receiving && receiving !== undefined) source = { network: said.v, why: said.by === "answer" ? "answer" : "said" };
  }
  if (step.fundFrom) source = { network: step.fundFrom.v, why: step.fundFrom.by === "answer" ? "answer" : "said" };
  const recipientFamilyOf: "eip155" | "solana" = kindOf === "solana" || (kindOf === "caip" && receiving !== undefined && family(receiving) === "solana") ? "solana" : "eip155";
  if (!receiving) {
    if (dependent && prevDest) {
      if (family(prevDest) === "eip155") return { network: prevDest };
      // R7: the funds will be on Solana but the recipient is an Ethereum-family identity.
      const networks = EVM_NETWORKS.filter((network) => lane(network) === lane(prevDest) && BRIDGE_NETWORKS.includes(network) && hasAccount(ctx.accounts, network) && canonicalOn(network, prevOut ?? "USDC") && portable(prevOut ?? "USDC", false, prevDest, network));
      return {
        question: question(path, "choice", "NETWORK_HANDOFF", `${short(recipient)} is on Ethereum-family networks, and the ${prevOut ?? "funds"} will be on ${networkName(prevDest)}. Which network should ${short(recipient)} receive it on? Kletia bridges it there.`, "A payment lands on one network; the recipient must use that network.", networks.map((network) => networkOption(network)), true),
      };
    }
    // An asset no network of the recipient's family lists is a recipient question, never a network one.
    const familyNetworks = NETWORK_ORDER.filter((network) => lane(network) === current && family(network) === recipientFamilyOf);
    const from = source?.network;
    const listedThere = familyNetworks.some((network) => symbolOn(network) !== null) || (from !== undefined && familyNetworks.some((network) => crossingSymbols(symbolOn(from) ?? "", from, network) !== null));
    if (!listedThere && (step.from || step.usdFrom)) return { question: familyMismatch(index, step, recipient, recipientFamilyOf, current) };
    const options = receivingOptions(env, recipientFamilyOf, current, symbolOn, from, need, step.amount?.v);
    const bridged = from ? ` Kletia bridges it from ${networkName(from)}.` : "";
    return { question: question(path, "choice", "TRANSFER_NETWORK", `Which network should ${short(recipient)} receive ${amountPhrase(step)} on?${bridged}`, "An address may be used on only one network. Sending on the wrong one can lose the funds.", options, true) };
  }
  // On a known receiving network: a token that no network of the recipient's family lists (on this lane), but
  // the other family does, cannot reach this recipient: a recipient question, not a token one.
  if ((step.from || step.usdFrom) && !dependent && symbolOn(receiving) === null && !(source && crossingSymbols(symbolOn(source.network) ?? "", source.network, receiving))) {
    const target = family(receiving) === "solana" ? "solana" : "eip155";
    const onLane = NETWORK_ORDER.filter((network) => lane(network) === lane(receiving));
    const familyLists = onLane.some((network) => family(network) === target && symbolOn(network) !== null);
    const otherLists = onLane.some((network) => family(network) !== target && symbolOn(network) !== null);
    if (!familyLists && otherLists) return { question: familyMismatch(index, step, recipient, target, lane(receiving)) };
  }
  if (!dependent && !source) {
    const departure = ctx.sourceNetwork && ctx.sourceNetwork !== "auto" ? ctx.sourceNetwork : undefined;
    if (departure && departure !== receiving && lane(departure) === lane(receiving)) source = { network: departure, why: "departure" };
    else if (ctx.sourceNetwork === "auto" && need && step.from) {
      // The caller chose "any network": the receiving network's own balance first, else a covering network.
      const f = funding(env, [receiving], symbolOn, step.amount?.v);
      const holder = f.known && f.covering.length === 0 ? holderFor(env, step.from.v, [receiving], need, current) : undefined;
      if (holder) source = { network: holder, why: "auto" };
    }
  }
  return { network: receiving, ...(source && source.network !== receiving ? { source } : {}) };
}

/** The asset is not on any network the recipient's family can receive on: change the recipient (or the token). */
function familyMismatch(index: number, step: WorkStep, recipient: string, kindOf: "eip155" | "solana", current: "mainnet" | "testnet"): Question {
  const asset = step.from?.v.toUpperCase() ?? "This token";
  const other = kindOf === "eip155" ? "Solana" : "Ethereum-family";
  const solanaTarget = kindOf === "eip155";
  return question(field(index, "recipient"), "address", "RECIPIENT_NETWORK_MISMATCH",
    `${recipient} receives on ${kindOf === "eip155" ? "Ethereum-family networks" : networkName(current === "testnet" ? "solana-devnet" : "solana")}, where ${asset} is not listed. Who should receive the ${asset}?`,
    `Enter a ${other} address or name, or send a token listed where ${short(recipient)} receives.`, [], true, placeholderFor("address", undefined, solanaTarget));
}

/** R7: the network (outside `networks`, same lane, input portable to one of them) holding the most of `raw`, if it covers `need`. */
function holderFor(env: Env, raw: string, networks: readonly NetworkKey[], need: string, current: "mainnet" | "testnet"): NetworkKey | undefined {
  const balances = new Map<NetworkKey, string>();
  for (const network of bridgeNetworksOf(current)) {
    if (networks.includes(network) || lane(network) !== current || !hasAccount(env.ctx.accounts, network)) continue;
    const symbol = canonicalOn(network, raw);
    if (!symbol || !networks.some((target) => portable(raw, false, network, target))) continue;
    const balance = env.facts.balance(network, symbol);
    if (balance !== undefined && cmp(balance, need) >= 0) balances.set(network, balance);
  }
  return byLargest([...balances.keys()], balances)[0];
}

/** R7's question: bridge from the holder first; one option per network where the step runs. */
function fundsElsewhere(env: Env, path: string, kind: Kind, raw: string, need: string, holder: NetworkKey, networks: readonly NetworkKey[]): Question {
  const targets = networks.filter((network) => portable(raw, false, holder, network));
  const options = targets.map((network, i) => networkOption(network, `Bridge ${need} ${raw} from ${networkName(holder)} first`, { value: { network, source: holder }, ...(i === 0 ? { recommended: true as const } : {}) }));
  const amount = held(env, holder, canonicalOn(holder, raw) as string);
  const prompt = targets.length === 1
    ? `Your ${raw} is on ${networkName(holder)}, and this ${kind} runs on ${networkName(targets[0] as NetworkKey)}. Bridge ${need} ${raw} there first?`
    : `Your ${raw} is on ${networkName(holder)}, where this cannot run. Bridge it first? Pick where to ${kind}.`;
  return question(path, targets.length === 1 ? "confirm" : "choice", "FUNDS_ELSEWHERE", prompt, `${networkName(holder)} holds ${amount} ${raw}.`, options, false);
}

function networkAssumption(path: string, network: NetworkKey, source: AssumptionSource, reason: string, pool: readonly NetworkKey[], balances: Map<NetworkKey, string>, env: Env, symbolOn: (network: NetworkKey) => string | null): Assumption {
  // Known balances: only networks that hold some of the asset are one-tap alternatives (the rest via text, "on <network>").
  const others = pool.filter((candidate) => candidate !== network);
  const funded = balances.size > 0 ? others.filter((candidate) => isPositive(balances.get(candidate))) : others;
  const alternatives = funded.slice(0, 4).map((candidate) => {
    const symbol = symbolOn(candidate);
    return networkOption(candidate, balances.has(candidate) && symbol ? `You hold ${held(env, candidate, symbol)} ${symbol}` : undefined);
  });
  return assumption(path, `On ${networkName(network)}`, { network }, source, reason, alternatives, true);
}

/** The networks a step can run on, for its kind (swap, deposit, withdraw). */
function runNetworks(env: Env, step: WorkStep, kind: Kind, symbolOn: (network: NetworkKey) => string | null): NetworkKey[] {
  const current = laneOf(env.ctx.accounts);
  if (kind === "swap") return swapCandidates(env, step);
  return venueNetworks(kind as "deposit" | "withdraw", step.protocol?.v, symbolOn).filter((network) => hasAccount(env.ctx.accounts, network) && lane(network) === current);
}

/** R2, R3, R4, R7: where a step runs (for a bridge: where it starts). */
function chooseNetwork(env: Env, index: number, step: WorkStep, prevDest: NetworkKey | undefined, prevOut: string | undefined): NetworkChoice {
  const { ctx } = env;
  const kind = step.kind?.v as Kind;
  const path = field(index, "network");
  const current = laneOf(ctx.accounts);
  // A bridge's source may be said only as where the money is ("bridge my base usdc to arbitrum": fundFrom).
  const said = step.network && step.network.by !== "assumed" ? step.network.v : kind === "bridge" ? step.fundFrom?.v : undefined;
  const assumed = step.network?.by === "assumed" ? step.network.v : undefined;
  const dependent = step.amount?.v.t === "previous";
  const departure = ctx.sourceNetwork && ctx.sourceNetwork !== "auto" ? ctx.sourceNetwork : undefined;
  const symbolOn = (network: NetworkKey) => symbolOnNetwork(env, network, step.from?.v, step.usdFrom);
  const need = exactNeed(step.amount?.v);
  const params = (network: NetworkKey, extra: ReasonParams = {}): ReasonParams => ({ symbol: symbolOn(network) ?? step.from?.v ?? "", ...extra });
  // R4b (departure.ts's rule, decided here for the chip and the amount): the caller fixed where the money starts
  // (or chose "auto" and no network where this runs holds enough) and this swap or deposit cannot run there.
  // The planner input gets the bridge from departure.ts; the chip's alternatives are the other bridge targets.
  // Only a spend-side network the person said (`fundFrom`) overrides the departure; a network said for
  // where the step runs ("deposit into aave on base") is where it runs, and the money still comes from the departure.
  // Under "auto" the coverage is checked on the said network too.
  const rewritable = index === 0 && !dependent && (kind === "swap" || kind === "deposit") && step.fundFrom === undefined;
  const pool = (): NetworkKey[] => {
    const networks = runNetworks(env, step, kind, symbolOn);
    return said ? networks.filter((network) => network === said) : networks;
  };
  let start = departure;
  let auto: { holder: NetworkKey; held: string } | undefined;
  if (!start && ctx.sourceNetwork === "auto" && rewritable && need && step.from) {
    const networks = pool();
    const f = funding(env, networks, symbolOn, step.amount?.v);
    const holder = f.known && f.covering.length === 0 ? holderFor(env, step.from.v, networks, need, current) : undefined;
    if (holder) {
      start = holder;
      auto = { holder, held: held(env, holder, canonicalOn(holder, step.from.v) as string) ?? "" };
    }
  }
  if (start && rewritable && lane(start) === current) {
    const from = start;
    const networks = pool();
    const targets = networks.filter((network) => BRIDGE_NETWORKS.includes(network) && portable(step.from?.v, step.usdFrom, from, network));
    if (networks.length > 0 && !networks.includes(from) && BRIDGE_NETWORKS.includes(from) && targets.length > 0) {
      const target = step.network && targets.includes(step.network.v) ? step.network.v
        : ctx.defaultNetwork && targets.includes(ctx.defaultNetwork) ? ctx.defaultNetwork
          : (targets[0] as NetworkKey);
      const why = auto ? { source: "balance" as const, code: "departure.auto" as const } : { source: "context" as const, code: "departure.fixed" as const };
      remember(step, "network", target, why);
      const alternatives = targets.filter((network) => network !== target).slice(0, 4).map((network) => networkOption(network, `Bridge to ${networkName(network)} instead`));
      const reason = reasonText(why.code, { departure: networkName(from), kind, targets: targets.map(networkName).join(", "), holder: auto ? networkName(auto.holder) : undefined, held: auto?.held, symbol: step.from?.v });
      return {
        network: target,
        departureBridge: from,
        assumption: assumption(path, `Starts on ${networkName(from)}: bridges to ${networkName(target)} first`, { network: target }, why.source, reason, alternatives, true),
      };
    }
  }
  if (kind === "transfer") return transferPlacement(env, index, step, prevDest, prevOut);
  if (said) return { network: said };
  if (kind === "stake") {
    const provider = stakeProvider(step.provider?.v);
    if (dependent && prevDest) return { network: prevDest };
    const input = provider?.input ?? (step.from?.v.toUpperCase() === "ETH" ? "ETH" : "SOL");
    // Testnet capital stakes on Solana Devnet, where only native staking runs.
    if (current === "testnet") return { network: input === "SOL" ? "solana-devnet" : provider?.network ?? defaultProvider(input).network };
    return { network: provider?.network ?? defaultProvider(input).network };
  }
  const pick = (network: NetworkKey, source: AssumptionSource, code: ReasonCode, pool: readonly NetworkKey[], balances: Map<NetworkKey, string>, extra: ReasonParams = {}): NetworkChoice => {
    const kept = code === "context.kept" && step.network?.why && isReasonCode(step.network.why.code)
      ? { source: step.network.why.source, code: step.network.why.code as ReasonCode }
      : { source, code };
    remember(step, "network", network, kept);
    return { network, assumption: networkAssumption(path, network, kept.source, reasonText(kept.code, params(network, extra)), pool, balances, env, symbolOn) };
  };
  if (kind === "call" || kind === "action") return {};
  if (dependent && prevDest) return { network: prevDest };
  if (kind === "bridge") {
    if (departure) return { network: departure };
    const networks = bridgeNetworksOf(current).filter((network) => network !== step.toNetwork?.v && hasAccount(ctx.accounts, network) && symbolOn(network));
    if (networks.length === 1) return { network: networks[0] as NetworkKey };
    const f = funding(env, networks, symbolOn, step.amount?.v);
    if (assumed && networks.includes(assumed) && (!f.known || f.covering.includes(assumed))) return pick(assumed, "context", "context.kept", networks, f.balances);
    if (f.known) {
      if (f.covering.length >= 1) {
        const network = byLargest(f.covering, f.balances)[0] as NetworkKey;
        return pick(network, "balance", f.covering.length === 1 ? "balance.only" : "balance.largest", networks, f.balances);
      }
      const positive = byLargest(networks.filter((network) => isPositive(f.balances.get(network))), f.balances);
      const options = (positive.length > 0 ? positive : networks).map((network) => networkOption(network, holdDetail(env, f.balances, network, symbolOn(network), need)));
      return { question: question(path, "choice", "SOURCE_MISSING", `No network holds enough ${step.from?.v ?? "USD"}. Where should ${amountPhrase(step)} come from?`, "The source network is the wallet that pays.", options, true) };
    }
    if (ctx.defaultNetwork && networks.includes(ctx.defaultNetwork)) return pick(ctx.defaultNetwork, "default", "default.network", networks, new Map());
    return { question: question(path, "choice", "SOURCE_MISSING", `Where should ${amountPhrase(step)} come from?`, "The source network is the wallet that pays.", networks.map((network) => networkOption(network)), true) };
  }
  // swap / deposit / withdraw are means: assume and show it (R3).
  const networks = runNetworks(env, step, kind, symbolOn);
  if (networks.length === 0) {
    if (kind === "swap") {
      const venue = step.protocol ? protocolLabel(step.protocol.v) : null;
      throw refuseUnsupported(venue
        ? `${venue} swaps run on ${(dexNetworks(step.protocol?.v) ?? []).map(networkName).join(", ")}; ${[step.from?.v, step.to?.v].filter(Boolean).join(" and ")} are not listed there together.`
        : `Cannot find one network that lists ${[step.from?.v, step.to?.v].filter(Boolean).join(" and ")}. Add "on <network>".`);
    }
    throw refuseUnsupported(`No ${step.protocol ? protocolLabel(step.protocol.v) : "lending"} venue takes ${step.from?.v ?? "this"} where you have an account.`);
  }
  if (departure && networks.includes(departure)) return { network: departure };
  if (networks.length === 1) {
    // R7 with one network: it cannot cover the amount but another network holds enough. Without a departure
    // the bridge is a consequence the user confirms (with "auto" it was added above as a chip).
    if (kind !== "withdraw" && !ctx.sourceNetwork && need && step.from) {
      const f = funding(env, networks, symbolOn, step.amount?.v);
      const holder = f.known && f.covering.length === 0 ? holderFor(env, step.from.v, networks, need, current) : undefined;
      if (holder) return { question: fundsElsewhere(env, path, kind, step.from.v, need, holder, networks) };
    }
    return { network: networks[0] as NetworkKey };
  }
  if (kind === "withdraw") {
    const protocol = step.protocol?.v as string;
    const positions = new Map<NetworkKey, string>();
    let known = true;
    for (const network of networks) {
      const value = env.facts.position(network, protocol, symbolOn(network) as string);
      if (value === undefined) known = false;
      else positions.set(network, value);
    }
    const holding = [...positions.entries()].filter(([, value]) => isPositive(value)).map(([network]) => network);
    if (holding.length === 1) {
      // One position found: used and shown (when another network could not be read, the chip says so and offers it).
      const network = holding[0] as NetworkKey;
      return pick(network, "position", known ? "position.only" : "position.found", networks, positions, { protocol: protocolLabel(protocol) });
    }
    if (known && holding.length === 0) {
      throw new PlatformError("POSITION_EMPTY", `You have no ${step.from?.v} supplied to ${protocolLabel(protocol)} on ${networks.map(networkName).join(", ")}.`, 422);
    }
    const pool = known ? holding : networks;
    return {
      question: question(path, "choice", "NETWORK_AMBIGUOUS", `Which network is your ${protocolLabel(protocol)} ${step.from?.v ?? ""} position on?`.replace("  ", " "), "A withdrawal happens where the position is.", pool.map((network) => networkOption(network, positions.has(network) ? `Supplied: ${positions.get(network)}` : undefined)), true),
    };
  }
  const f = funding(env, networks, symbolOn, step.amount?.v);
  if (assumed && networks.includes(assumed) && (!f.known || f.covering.includes(assumed))) return pick(assumed, "context", "context.kept", networks, f.balances);
  if (ctx.defaultNetwork && networks.includes(ctx.defaultNetwork) && (!f.known || f.covering.includes(ctx.defaultNetwork))) {
    return pick(ctx.defaultNetwork, "default", "default.network", networks, f.balances);
  }
  if (f.known && f.covering.length >= 1) {
    const network = byLargest(f.covering, f.balances)[0] as NetworkKey;
    return pick(network, "balance", f.covering.length === 1 ? "balance.only" : "balance.largest", networks, f.balances);
  }
  if (f.known && need && step.from) {
    // R7: the funds sit on a network where this step cannot run.
    const holder = holderFor(env, step.from.v, networks, need, current);
    if (holder) return { question: fundsElsewhere(env, path, kind, step.from.v, need, holder, networks) };
  }
  const network = (f.known ? byLargest(networks, f.balances) : networks)[0] as NetworkKey;
  return pick(network, f.known ? "balance" : "default", f.known ? "balance.short" : "default.kletia", networks, f.balances);
}

/**
 * F8 / D4 for a strict step: "stake my SOL" is all of it when the sentence
 * names the network or exactly one network holds the asset (balances read,
 * none unknown). Holdings on several networks leave the amount open, so
 * AMOUNT_MISSING asks (a possessive never picks a scope by itself).
 */
function wholeHolding(env: Env, step: WorkStep): void {
  const symbol = step.from?.v;
  if (!symbol) return;
  const whole = () => {
    step.amount = { v: { t: "balance", bps: 10_000 }, by: "user" };
  };
  if (step.network && step.network.by === "user") {
    whole();
    return;
  }
  const current = laneOf(env.ctx.accounts);
  const networks = NETWORK_ORDER.filter((network) => lane(network) === current && hasAccount(env.ctx.accounts, network) && canonicalOn(network, symbol));
  const balances = networks.map((network) => env.facts.balance(network, canonicalOn(network, symbol) as string));
  if (balances.some((balance) => balance === undefined)) return;
  if (balances.filter((balance) => isPositive(balance)).length === 1) whole();
}

/**
 * "withdraw half from aave on base": a withdrawal that names its venue and
 * network but no token uses the one position held there, shown as a material
 * chip. Only when every venue of the protocol on that network was read: two
 * positions, none, or an unread venue leave the token to INPUT_ASSET_MISSING.
 */
function onlyPosition(env: Env, index: number, step: WorkStep): { symbol: string; assumption: Assumption } | null {
  const protocol = step.protocol?.v;
  const said = step.network && step.network.by !== "assumed" ? step.network.v : undefined;
  if (!protocol || ambiguousVenue(protocol) || !env.facts.positionsAt) return null;
  // No network said ("withdraw everything from morpho"): every network the protocol runs on is read (within the
  // turn's position budget); one position across all of them is used, anything else (or an unread network) is asked.
  const current = laneOf(env.ctx.accounts);
  const networks = said ? [said] : [...new Set(YIELD_VENUES.filter((venue) => venue.protocol === protocol && (venue.actions as readonly string[]).includes("withdraw") &&
    lane(venue.network) === current && hasAccount(env.ctx.accounts, venue.network)).map((venue) => venue.network))];
  if (networks.length === 0 || networks.length > MAX_POSITION_READS) return null;
  const found: { network: NetworkKey; symbol: string; amount: string }[] = [];
  for (const network of networks) {
    const held = env.facts.positionsAt(network, protocol);
    if (!held) return null;
    for (const entry of held) found.push({ network, ...entry });
  }
  if (found.length !== 1) return null;
  const only = found[0] as { network: NetworkKey; symbol: string; amount: string };
  const network = only.network;
  const symbol = canonicalOn(network, only.symbol);
  if (!symbol) return null;
  const params = { protocol: protocolLabel(protocol), symbol };
  return {
    symbol,
    assumption: assumption(field(index, "from"), `Your ${protocolLabel(protocol)} ${symbol} position · ${tidy(only.amount)}`, { asset: symbol }, "position", reasonText("position.only", params), [], true),
  };
}

/* ------------------------------------------------------- contract steps */

/** The contract clause of a step, in the registration's own words. */
export function contractClause(step: WorkStep, amount: string | null, network: NetworkKey | undefined): string {
  const [alias, verb] = (step.contract?.v ?? "#").split("#") as [string, string];
  const connector = /^(?:withdraw|redeem|claim|unstake|exit|remove|unwrap)$/u.test(verb) ? "from" : "into";
  const spend = amount ? ` ${amount}${amount === "it" || amount === "half" || /%$/u.test(amount) ? "" : step.from ? ` ${step.from.v}` : ""}` : step.from ? ` ${step.from.v}` : "";
  return `${verb}${spend} ${connector} ${alias}${network ? ` on ${network}` : ""}`;
}

function contractAmountWord(amount: ThreadAmount | undefined): string | null {
  if (!amount) return null;
  if (amount.t === "exact") return amount.value;
  if (amount.t === "previous") return amount.bps === 10_000 ? "it" : amount.bps === 5_000 ? "half" : `${amount.bps / 100}%`;
  return null;
}

/** A contract step: the grammar's matcher decides the registration; its gaps become questions. */
function analyzeContract(env: Env, index: number, step: WorkStep, prevDest: NetworkKey | undefined): { question?: Question; action?: ResolvedAction } {
  const said = step.network && step.network.by !== "derived" ? step.network.v : undefined;
  const amountWord = contractAmountWord(step.amount?.v);
  const clause = contractClause(step, amountWord, said);
  const match = matchContractPhrase(clause, env.ctx.contracts, { ...(prevDest ? { previousDestination: prevDest } : {}), index });
  if (!match) throw refuseUnsupported("That contract alias is not registered for this key.");
  if ("gap" in match) {
    if (match.gap === "network") {
      return { question: question(field(index, "network"), "choice", "NETWORK_AMBIGUOUS", "Which registered contract should this use?", "The alias is registered on more than one network.", match.networks.map((network) => networkOption(network)), false) };
    }
    const network = step.network?.v;
    const from = step.from?.v;
    if (network && from) return { question: amountQuestion(env, index, step, network, canonicalOn(network, from) ?? from) };
    return { question: question(field(index, "amount"), "amount", "AMOUNT_MISSING", `How much should go into ${(step.contract?.v ?? "").split("#")[0]}?`, "This contract spends a token; say an amount.", [], true, placeholderFor("amount", from)) };
  }
  const [alias, verb] = (step.contract?.v ?? "#").split("#") as [string, string];
  const action = match.action;
  const amount = action.amount ?? "";
  const bps = typeof action.params?.portionBps === "number" ? action.params.portionBps : undefined;
  return {
    action: {
      kind: action.kind as Kind,
      network: action.network,
      from: action.from ?? "",
      amount,
      ...(bps !== undefined ? { portionBps: bps } : {}),
      ...(action.contract ? { contract: action.contract } : {}),
      ...(action.entry ? { entry: action.entry } : {}),
      alias,
      verb,
      explicit: match.explicit,
    },
  };
}

/* ------------------------------------------------- engine v2 policy rules */

/** The why code of a deposit venue Kletia picked by rate (D6); decided again each turn. */
const VENUE_RATE_CODE = "venue.rate";
/**
 * Kinds whose exact amount is checked against the balance where the step
 * spends it (D2). A payment too: its money is where it is sent from,
 * which the policy decides (transferPlacement), so "Use funds on N"
 * becomes one crossing leg that pays the recipient.
 */
const SPENDING_KINDS: ReadonlySet<Kind> = new Set(["swap", "bridge", "deposit", "stake", "transfer"]);

/** D9: a typed symbol within one edit of listed ones and not itself listed ("SLO"), which the fuzzy reader leaves alone. */
function typoOf(step: WorkStep): { side: "spend" | "want"; raw: string; candidates: string[] } | null {
  if (step.contract) return null;
  for (const name of ["from", "to"] as const) {
    const said = step[name];
    if (!said || said.by !== "user") continue;
    const found = symbolTypoCandidates(said.v);
    // The fuzzy reader's rules come first: a symbol it matches (four letters and more) is corrected or asked as before.
    if (found.length > 0 && candidates(said.v, found).length === 0) return { side: name === "from" ? "spend" : "want", raw: said.v.slice(0, 16), candidates: found };
  }
  return null;
}

/**
 * D2 for every step: an exact amount above the known balance asks
 * AMOUNT_EXCEEDS_BALANCE (all of it, funds on another network that cover it,
 * or keep the amount as said). Unknown balances never ask.
 */
function exceedsBalance(env: Env, index: number, step: WorkStep, kind: Kind, network: NetworkKey, from: string, need: string, receiving: NetworkKey = network): Question | null {
  const balance = env.facts.balance(network, from);
  if (balance === undefined || cmp(balance, need) >= 0) return null;
  const current = laneOf(env.ctx.accounts);
  const options: Option[] = [];
  const all = spendable(env, network, from, 10_000);
  const decimals = decimalsOf(network, from);
  const shown = held(env, network, from) ?? tidy(balance);
  if (all !== undefined && all > 0n) {
    const native = CHAINS[network].nativeAsset.symbol === from;
    options.push({ id: "all", label: `All · ${formatDecimal(all, decimals)} ${from}`, ...(native ? { detail: `Keeps ${NATIVE_FEE_RESERVE[network]} ${from} for network fees` } : { detail: `On ${networkName(network)}` }), value: { amount: { t: "balance", bps: 10_000 } } });
  }
  // A payment: funds on another network pay the recipient where they receive, in one crossing leg.
  if (kind === "transfer") {
    for (const other of [receiving, ...bridgeNetworksOf(current)]) {
      if (options.length >= 4 || other === network || !hasAccount(env.ctx.accounts, other) || options.some((option) => option.id === other)) continue;
      const symbol = canonicalOn(other, from);
      if (!symbol || (other !== receiving && !crossingSymbols(symbol, other, receiving))) continue;
      const there = env.facts.balance(other, symbol);
      if (there === undefined || cmp(there, need) < 0) continue;
      options.push({ id: other, label: `Use funds on ${networkName(other)}`, detail: `You hold ${held(env, other, symbol)} ${symbol} there`, value: { source: other, network: receiving } });
    }
  }
  // Funds elsewhere: a bridge starts there instead (bridge), or they are bridged to where the step runs first (swap,
  // deposit); when the step runs where they are (a departure that holds too little), the step simply spends them there.
  if (kind === "bridge" || kind === "swap" || kind === "deposit") {
    const runs = kind === "bridge" ? network : receiving;
    for (const other of bridgeNetworksOf(current)) {
      if (options.length >= 4 || other === network || (kind === "bridge" && other === step.toNetwork?.v) || !hasAccount(env.ctx.accounts, other)) continue;
      const symbol = canonicalOn(other, from);
      if (!symbol || (kind !== "bridge" && other !== runs && !portable(from, false, other, runs))) continue;
      const there = env.facts.balance(other, symbol);
      if (there === undefined || cmp(there, need) < 0) continue;
      options.push({ id: other, label: `Use funds on ${networkName(other)}`, detail: `You hold ${held(env, other, symbol)} ${symbol} there`, value: { source: other, network: runs } });
    }
  }
  options.push({ id: "keep", label: `Keep ${need} ${from}`, detail: "The plan will fail unless more arrives first", value: { amount: { t: "exact", value: need } } });
  // Balances go in the why line only: the prompt becomes the thread's turn label, which never holds facts.
  return question(field(index, "amount"), "choice", "AMOUNT_EXCEEDS_BALANCE", `${need} ${from} is more than you hold on ${networkName(network)}. How much should this use?`,
    `You hold ${shown} ${from} there; Kletia checks the amount against your balance before planning.`, options, true, placeholderFor("amount", from));
}

/** The risk penalty of a tier in rate terms: a curated venue must pay 0.5 points more than a core one to be picked. */
const TIER_PENALTY: Readonly<Record<string, number>> = { core: 0, curated: 0.005 };

/** D6 for a venue-less deposit: the venue (picked by rate, a chip) or a VENUE_MISSING question. */
function chooseVenue(env: Env, index: number, step: WorkStep, network: NetworkKey, from: string): { protocol?: string; vault?: string; assumption?: Assumption; question?: Question } {
  const ranked = rankedVenueOptions(network, "deposit", from, 4);
  if (ranked.length === 0) throw refuseUnsupported(`No lending venue takes ${from} on ${networkName(network)}.`);
  const rated = ranked.map((venue) => ({ venue, apy: env.facts.venueApy?.(venue.id) ?? null, tier: protocolTier(venue.protocol as ProtocolId, network) }));
  const scored = rated.filter((entry) => entry.apy !== null && entry.tier in TIER_PENALTY)
    .sort((a, b) => ((b.apy as number) - TIER_PENALTY[b.tier]!) - ((a.apy as number) - TIER_PENALTY[a.tier]!));
  const vaultOf = (venue: (typeof ranked)[number]) => (venuesOn(network, "deposit", venue.protocol, from).length > 1 ? venue.slug : undefined);
  const best = scored[0];
  if (!best) {
    const options = rated.map((entry, i) => ({
      id: entry.venue.protocol, label: protocolLabel(entry.venue.protocol), detail: `${entry.venue.name} · ${riskLabel(entry.tier as never)} · ${apyLabel(entry.apy)}`,
      value: { protocol: entry.venue.protocol, ...(vaultOf(entry.venue) ? { venue: vaultOf(entry.venue) } : {}) }, ...(i === 0 ? { recommended: true as const } : {}),
    }));
    const copy = PROTOCOL_QUESTION_COPY.venueMissing(amountPhrase(step, from), networkName(network));
    return { question: question(field(index, "protocol"), "choice", "VENUE_MISSING", copy.prompt, `${copy.why} Rates could not be read right now.`, options, false) };
  }
  const vault = vaultOf(best.venue);
  step.protocol = { v: best.venue.protocol, by: "assumed", why: { source: "default", code: VENUE_RATE_CODE } };
  if (vault) step.vault = { v: vault, by: "assumed", why: { source: "default", code: VENUE_RATE_CODE } };
  else delete step.vault;
  const alternatives = rated.filter((entry) => entry !== best).map((entry) => ({
    id: entry.venue.protocol, label: `${protocolLabel(entry.venue.protocol)} · ${apyLabel(entry.apy)}`, detail: riskLabel(entry.tier as never),
    value: { protocol: entry.venue.protocol, ...(vaultOf(entry.venue) ? { venue: vaultOf(entry.venue) } : {}) },
  }));
  return {
    protocol: best.venue.protocol,
    ...(vault ? { vault } : {}),
    assumption: assumption(field(index, "protocol"), `${best.venue.name} · ${apyLabel(best.apy)}`, { protocol: best.venue.protocol, ...(vault ? { venue: vault } : {}) }, "default",
      reasonText(VENUE_RATE_CODE, { protocol: protocolLabel(best.venue.protocol), kind: riskLabel(best.tier as never) }), alternatives, true),
  };
}

/* ------------------------------------------------------------- analyze */

/* ------------------------------------------------- decision layer (P2-M1) */

/**
 * Exact delivery to a recipient (seam S10: `receiveExact`, the input sized by
 * an inverse quote) is offered once the planner sizes such legs (P3-M2).
 * Until then a payment that crosses networks asks DELIVERY_AMOUNT with "the
 * recipient receives what arrives" as the only plannable reading.
 */
export const EXACT_DELIVERY_PLANNED = false;

/** A resolved action with the decision layer's internal fields (never serialised). */
export interface PlacedAction extends ResolvedAction {
  /** A payment: the recipient receives exactly `amount`. */
  receiveExact?: true;
}

/** The analysis of a turn with the decision layer's extras (never serialised). */
export interface PolicyAnalysis extends Analysis {
  /** Per resolved action: where it comes from (invariants, departure flags). */
  meta?: ActionMeta[];
  /** Gas top-ups the person chose on GAS_ON_ARRIVAL (constraints.gasOnArrival of the plan request). */
  gasOnArrival?: Record<string, string>;
  /** The digest of the plan's end state with the acknowledgements made (what thread.confirmDigest holds once settled). */
  digest?: string;
  /** The plan carries a model-assisted reading: its confirm is accepted only from the person (desk or wallet-bound token). */
  modelReading?: true;
}

/** One acknowledgement the solved plan needs, in Kletia's words; settled through the confirm digest (solver/confirm.ts). */
interface AckNeed {
  readonly id: string;
  readonly reason: ClarifyReason;
  /** The (expanded) step index the question sits on. */
  readonly index: number;
  readonly fieldName: string;
  readonly kind: "choice" | "confirm";
  readonly prompt: string;
  readonly why: string;
  readonly choices: readonly { readonly id: string; readonly label: string; readonly detail?: string }[];
  /** A model-assisted reading: only the person may settle it (CONFIRM_AUTHORITY_REQUIRED otherwise). */
  readonly llm?: true;
}

/** A said spend-side network (`fundFrom`) other than where the step runs: the crossing source. */
function fundSource(step: WorkStep, kind: Kind, network: NetworkKey): NetworkKey | undefined {
  const from = step.fundFrom?.v;
  if (!from || from === network) return undefined;
  if (kind === "bridge" || kind === "withdraw" || kind === "transfer" || kind === "call" || kind === "action") return undefined;
  return from;
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * A dependent step whose network contradicts a destination the person said for
 * the previous step, a dependent bridge from another network than where the
 * funds are, or a crossing back to a network the same funds left, is asked,
 * never an inserted leg: where the previous step delivers, or (after a said
 * bridge) here without the bridge, or cancel.
 */
function contradictionQuestion(env: Env, index: number, step: WorkStep, previous: WorkStep | undefined, kind: Kind, network: NetworkKey, prevDest: NetworkKey, prevOut: string | undefined,
  path: readonly NetworkKey[], layout: Analysis["layout"]): Question | null {
  const saidDestination = previous?.kind?.v === "bridge" && previous.toNetwork !== undefined && (previous.toNetwork.by === "user" || previous.toNetwork.by === "answer");
  const roundTrip = path.slice(0, -1).includes(network);
  if (!saidDestination && kind !== "bridge" && !roundTrip) return null;
  if (step.network?.by === "answer" && !roundTrip) return null;
  const what = prevOut ? `the ${prevOut}` : "its output";
  const [does, verb] = STEP_VERBS[kind] ?? ["runs", "run"];
  const head = kind === "bridge"
    ? `Step ${index + 1} bridges from ${networkName(network)}, but step ${index} delivers ${what} on ${networkName(prevDest)}.`
    : `Step ${index + 1} ${does} on ${networkName(network)}, but step ${index} delivers ${what} on ${networkName(prevDest)}.`;
  const options: Option[] = [
    networkOption(prevDest, `Where step ${index} delivers ${what}`, { label: kind === "bridge" ? `Bridge from ${networkName(prevDest)}` : `${capital(verb)} on ${networkName(prevDest)}` }),
  ];
  const strict = !layout || (!layout[index]?.goal && !layout[index - 1]?.goal);
  if (saidDestination && kind !== "bridge" && strict && previous?.amount && previous.amount.v.t !== "previous" && !previous.recipient) {
    options.push({ id: "skip", label: clip(`${capital(verb)} on ${networkName(network)}, skip the bridge`, 48), detail: `Uses funds already on ${networkName(network)} instead`, value: { network, target: "contradiction:skip" } });
  }
  options.push({ id: "cancel", label: "Neither, cancel", value: { target: "cancel" } });
  void env;
  return question(field(index, "network"), "choice", "NETWORK_CONTRADICTION", `${head} Which did you mean?`,
    roundTrip ? "That would move the funds back to a network they just left, paying two bridges. Kletia asks instead." : "Kletia never spends other funds in place of what a step delivers, and never guesses which network you meant.",
    options, false);
}

/**
 * A payment to someone else of a named asset right after a step that delivers
 * that asset ("send all eth to ..."), while the person also holds it there, has
 * two referents (what the step delivers, or the holding). Asked, with the
 * step's output as an option, never guessed.
 */
function referenceQuestion(env: Env, index: number, step: WorkStep, prevDest: NetworkKey | undefined, prevOut: string | undefined): Question | null {
  if (step.kind?.v !== "transfer" || step.amount?.v.t !== "previous" || step.amount.by !== "user" || step.from?.by !== "user") return null;
  if (!step.recipient || !prevDest || !prevOut || ownAddress(env.ctx.accounts, step.recipient.v)) return null;
  const named = canonicalOn(prevDest, step.from.v);
  if (!named || named.toUpperCase() !== prevOut.toUpperCase()) return null;
  const holding = env.facts.balance(prevDest, named);
  if (holding === undefined || !isPositive(holding)) return null;
  return question(field(index, "amount"), "choice", "REFERENCE_AMBIGUOUS", `How much ${named} should ${short(step.recipient.v)} receive?`,
    `This could be the ${named} step ${index} delivers, or the ${held(env, prevDest, named)} ${named} you hold on ${networkName(prevDest)}. Kletia never guesses an amount paid to someone else.`,
    [
      { id: "output", label: clip(`Only the ${named} from step ${index}`, 48), detail: "What step " + String(index) + " delivers, after fees", value: { amount: { t: "previous", bps: 10_000 } } },
      { id: "cancel", label: "Neither, cancel", value: { target: "cancel" } },
    ], true, placeholderFor("amount", named));
}

function crossingChip(index: number, kind: Kind, from: NetworkKey, to: NetworkKey, asset: string, step: WorkStep, why: "dependent" | "said"): Assumption {
  const venue = step.protocol?.v ? protocolLabel(step.protocol.v) : step.provider?.v ? stakeProvider(step.provider.v)?.grammarProvider : undefined;
  const runs = venue ? `${venue} runs on ${networkName(to)}` : `this ${kind} runs on ${networkName(to)}`;
  return assumption(field(index, why === "dependent" ? "network" : "fundFrom"), `Bridges ${asset} ${networkName(from)} to ${networkName(to)} first`, { network: to }, "context",
    why === "dependent"
      ? `Step ${index}'s ${asset} is on ${networkName(from)}, and ${runs}. The bridge with the best quote is picked at planning.`
      : `You said the ${asset} is on ${networkName(from)}, and ${runs}. The bridge with the best quote is picked at planning.`,
    [], true);
}

function crossingPaymentChip(index: number, recipient: string, from: NetworkKey, to: NetworkKey, asset: string, why: "dependent" | "said" | "answer" | "departure" | "auto"): Assumption {
  const source: AssumptionSource = why === "auto" ? "balance" : "context";
  const lead = why === "departure" ? `Your departure is ${networkName(from)}. ` : why === "auto" ? `${networkName(to)} does not hold enough; ${networkName(from)} does. ` : "";
  return assumption(field(index, "network"), `Pays ${recipientLabel(recipient)} on ${networkName(to)} from ${networkName(from)}`, { network: to }, source,
    `${lead}The ${asset} leaves ${networkName(from)} in one bridge that pays ${short(recipient)} on ${networkName(to)}; bridge fees come out of what arrives.`, [], true);
}

/** "Read as" chips (units, fractions, corrections the reader derived) and the "Ignored" chip of reviewed fillers. */
function readingChips(steps: readonly WorkStep[]): Assumption[] {
  const out: Assumption[] = [];
  steps.forEach((step, index) => {
    for (const item of step.readAs ?? []) {
      out.push(assumption(field(index, item.slot), `Read as ${item.to}${item.from ? ` (${item.from})` : ""}`, {}, "correction",
        "Kletia read this from what you wrote; check it before you sign.", [], true));
    }
    if (step.ignored && step.ignored.length > 0) {
      out.push(assumption(field(index, "text"), `Ignored: ${step.ignored.slice(0, 6).join(", ")}`, {}, "correction", "Filler words; nothing else in the sentence changes.", [], false));
    }
  });
  return out;
}

/**
 * At the start (I12): a closed-class word no reviewed rule consumed
 * refuses the clause with its family's message; an unsupported network or
 * qualifier refuses NETWORK_UNSUPPORTED. The reader consumes these first;
 * this is where one that slipped through stops.
 */
function closedClassBlock(steps: readonly WorkStep[]): PlatformError | null {
  for (const [index, step] of steps.entries()) {
    const record = step.closedClass;
    if (!record) continue;
    const rules = new Set<string>();
    for (const key of ["kind", "amount", "from", "to", "network", "toNetwork", "recipient", "protocol", "vault", "provider", "fundFrom"] as const) {
      const rule = (step[key] as { prov?: { rule?: string } } | undefined)?.prov?.rule;
      if (rule) rules.add(rule);
    }
    for (const entry of step.readAs ?? []) rules.add(entry.rule);
    for (const hit of record.hits) {
      if (hit.category === "network") {
        return new PlatformError("NETWORK_UNSUPPORTED", `Kletia does not run on ${hit.phrase.slice(0, 32)}. It runs on Base, Arbitrum One, Ethereum, OP Mainnet, Polygon PoS and Solana; test networks: Arc Testnet, Arbitrum Sepolia and Solana Devnet.`, 422, [{ path: field(index, "network"), message: "Not a network Kletia runs on." }]);
      }
      if (hit.category === "question" && step.questionForm) continue;
      if (hit.rules.some((rule) => rules.has(rule))) continue;
      return closedClassRefusal(hit.category === "unit" ? "unit" : CLOSED_CLASS_REFUSAL_OF[hit.category], field(index, "kind"));
    }
  }
  return null;
}

function stakeInputAck(index: number, from: string, wanted: string, lst: string): AckNeed {
  return {
    id: `stake-input:${index}`,
    reason: "STAKE_INPUT_MISMATCH",
    index,
    fieldName: "from",
    kind: "choice",
    prompt: `Staking needs ${wanted}, and the previous step delivers ${from}. Buy ${lst} with the ${from} at market?`,
    why: `Kletia never buys a staked token with another asset without asking. You can also rewrite the steps to get ${wanted} first.`,
    choices: [{ id: "buy", label: clip(`Buy ${lst} with the ${from}`, 48), detail: "At market through a swap venue; the price guard checks the rate." }],
  };
}

/** Recipients the person said (strict steps' recipients and goal holders), for recipient fidelity. */
function saidRecipients(state: WorkState, steps: readonly WorkStep[]): string[] {
  const out = new Set<string>();
  for (const step of [...steps, ...state.steps]) {
    if (step.recipient && step.recipient.by !== "assumed") out.add(step.recipient.v);
    const holder = step.goal?.holder;
    if (holder && (holder.t === "address" || holder.t === "name")) out.add(holder.value);
  }
  return [...out];
}

/**
 * Two claims on one holding (asset and network) that together exceed
 * the known balance, or two "all of it", ask SPEND_CONFLICT on the later
 * step. A claim the person kept on purpose (answered) is not asked again.
 */
function spendConflict(env: Env, resolved: readonly ResolvedAction[], meta: readonly ActionMeta[], steps: readonly WorkStep[]): Question | null {
  const claims = new Map<string, { network: NetworkKey; symbol: string; total: bigint; actions: number[] }>();
  for (const [index, action] of resolved.entries()) {
    if (spendsPrevious(action, index) || action.kind === "withdraw" || action.contract || !isDecimal(action.amount)) continue;
    const info = meta[index];
    const step = info?.step !== null && info?.step !== undefined ? steps[info.step] : undefined;
    if (step?.amount?.by === "answer") return null;
    const key = `${action.network}|${action.from.toUpperCase()}`;
    const entry = claims.get(key) ?? { network: action.network, symbol: action.from, total: 0n, actions: [] };
    entry.total += parseDecimal(action.amount);
    entry.actions.push(index);
    claims.set(key, entry);
  }
  for (const entry of claims.values()) {
    if (entry.actions.length < 2) continue;
    const balance = env.facts.balance(entry.network, entry.symbol);
    if (balance === undefined || entry.total <= parseDecimal(balance)) continue;
    const last = entry.actions[entry.actions.length - 1] as number;
    const before = entry.actions.slice(0, -1).reduce((sum, index) => sum + parseDecimal((resolved[index] as ResolvedAction).amount), 0n);
    const rest = parseDecimal(balance) - before;
    const decimals = Math.min(decimalsOf(entry.network, entry.symbol), 6);
    const stepIndex = meta[last]?.step ?? last;
    const options: Option[] = rest > 0n ? [{ id: "rest", label: clip(`The rest · ${formatDecimal(rest, decimals)} ${entry.symbol}`, 48), value: { amount: { t: "exact", value: formatDecimal(rest, decimals) } } }] : [];
    return question(field(stepIndex, "amount"), "amount", "SPEND_CONFLICT",
      `Two steps spend your ${entry.symbol} on ${networkName(entry.network)}, more than the ${held(env, entry.network, entry.symbol)} you hold together. How much should step ${stepIndex + 1} use?`,
      "Kletia checks every step against what you hold before planning.", options, true, placeholderFor("amount", entry.symbol));
  }
  return null;
}

/**
 * A raw EVM address is checked where it receives. Contract code there, or none
 * anywhere, is fine (an EIP-7702 delegation counts as an account); no code
 * there but contract code on another network asks where it should receive; a
 * read that failed is acknowledged, never a silent pass. `pending` while a read
 * is still to come (the policy runs again).
 */
function codeCheck(env: Env, index: number, address: string, receiving: NetworkKey): { question?: Question; ack?: AckNeed; pending?: true } | null {
  const facts = env.facts as DecisionFacts;
  if (!facts.accountCode) return null;
  const here = facts.accountCode(receiving, address);
  if (here === undefined) return { pending: true };
  if (here === "contract") return null;
  const ack = (network: NetworkKey): AckNeed => ({
    id: `code:${network}`,
    reason: "RECIPIENT_NETWORK_MISMATCH",
    index,
    fieldName: "recipient",
    kind: "choice",
    prompt: `Kletia could not check ${address} on ${networkName(network)} right now. Pay it there anyway?`,
    why: "A contract wallet can exist on one network only. Kletia checks an address before paying it and does not skip the check silently.",
    choices: [{ id: "anyway", label: clip(`Pay on ${networkName(receiving)} anyway`, 48) }],
  });
  if (here === "unknown") return { ack: ack(receiving) };
  const others = EVM_NETWORKS.filter((network) => network !== receiving && lane(network) === lane(receiving));
  const kinds = others.map((network) => [network, facts.accountCode?.(network, address)] as const);
  if (kinds.some(([, kind]) => kind === undefined)) return { pending: true };
  const contracts = kinds.filter(([, kind]) => kind === "contract").map(([network]) => network);
  if (contracts.length > 0) {
    return {
      question: question(field(index, "recipient"), "address", "RECIPIENT_NETWORK_MISMATCH",
        `${address} is a contract on ${contracts.map(networkName).join(", ")} but has no code on ${networkName(receiving)}. Where should it receive?`,
        "A contract wallet such as a Safe exists only where it was deployed; funds sent elsewhere can be lost.",
        contracts.slice(0, 4).map((network) => networkOption(network, "The address is a contract there", { label: `Receive on ${networkName(network)}` })), true, placeholderFor("address")),
    };
  }
  const unknown = kinds.find(([, kind]) => kind === "unknown");
  return unknown ? { ack: ack(unknown[0]) } : null;
}

function deliveryAck(index: number, action: ResolvedAction): AckNeed {
  const recipient = action.recipient ?? "";
  const to = action.toNetwork ?? action.network;
  const choices: { id: string; label: string; detail?: string }[] = [
    { id: "send", label: clip(`Send ${action.amount} ${action.from}`, 48), detail: clip(`${recipientLabel(recipient)} receives a little less after bridge fees`, 96) },
  ];
  if (EXACT_DELIVERY_PLANNED) choices.unshift({ id: "receive", label: clip(`${recipientLabel(recipient)} receives ${action.amount}`, 48), detail: "You pay a little more to cover the fees" });
  return {
    id: `delivery:${index}`,
    reason: "DELIVERY_AMOUNT",
    index,
    fieldName: "amount",
    kind: "choice",
    prompt: `${short(recipient)} receives on ${networkName(to)}, and the ${action.from} is on ${networkName(action.network)}. Send ${action.amount} ${action.from} and let the bridge fees come out of it?`,
    why: "A payment that crosses networks pays bridge fees on the way. Kletia does not decide on its own who bears them.",
    choices,
  };
}

function gasAck(index: number, shortfall: GasShortfall, departure?: NetworkKey): AckNeed {
  const network = shortfall.network;
  // The arriving leg: a step of the plan, or the departure's bridge before step 1 (arriving -1).
  const via = shortfall.arriving !== null && shortfall.arriving >= 0 ? `with step ${shortfall.arriving + 1}` : departure ? `with the bridge from ${networkName(departure)}` : "";
  const gas = gasSymbol(network);
  const topup = shortfall.arriving !== null && CHAINS[network].vm === "evm";
  const none = !isPositive(shortfall.held);
  return {
    id: `gas:${network}`,
    reason: "GAS_ON_ARRIVAL",
    index,
    fieldName: "network",
    kind: "choice",
    prompt: `You hold ${none ? "no" : "too little"} ${gas} on ${networkName(network)} to sign step ${shortfall.action + 1}. How should it pay its network fee?`,
    why: `Each step pays its network fee in ${networkName(network)}'s gas token. Without it the step cannot be signed and the funds wait there.`,
    choices: [
      ...(topup ? [{ id: "topup", label: clip(`Add $${GAS_TOPUP_USD} of ${gas} with the bridge`, 48), detail: `Delivered on ${networkName(network)} ${via}`.trim() }] : []),
      { id: "anyway", label: "Plan anyway", detail: clip(`Add ${gas} on ${networkName(network)} before you sign`, 96) },
    ],
  };
}

/** True for a step read by model-assisted reading (lowered, or a goal the reading proposed). */
const modelReadStep = (step: WorkStep | undefined) => step?.modelRead === true || step?.goal?.confidence === "llm" || step?.source === "M";

/** "2,500", "1.000": a typed amount with thousands groups (always "Read as" when paid to someone else). */
const groupedAmount = (raw: string | undefined) => raw !== undefined && /^\d{1,3}(?:[.,]\d{3})+$/u.test(raw);

/**
 * Confirm-class outcomes of a solved plan: corrected or derived readings
 * (source C), order-only roles of a strict step (F), model-assisted readings
 * (M), a sentence asked as a question, a moves confirm, or a payment to
 * someone else whose amount was derived (a unit, a correction, "1.000").
 * One confirm of the whole solved plan, or null.
 */
function confirmNeed(state: WorkState, env: Env, steps: readonly WorkStep[], resolved: readonly ResolvedAction[], meta: readonly ActionMeta[], thirdParty: (action: ResolvedAction) => boolean): AckNeed | null {
  const stepAt = (action: number) => {
    const at = meta[action]?.step;
    return at === null || at === undefined ? undefined : steps[at];
  };
  let lead = "";
  let why = "";
  let at: number | null = null;
  let llm = false;
  const note = (index: number, nextLead: string, nextWhy: string) => {
    if (at !== null) return;
    at = index;
    lead = nextLead;
    why = nextWhy;
  };
  steps.forEach((step, index) => {
    if (modelReadStep(step) && step.kind) {
      llm = true;
      note(index, "Model-assisted reading: ", "Model-assisted reading. Kletia plans it only when you confirm.");
    }
    if (step.questionForm) note(index, "You asked this as a question. ", "Kletia plans a question only when you say so.");
    if (step.source === "C" || step.source === "F") note(index, "Kletia read this as: ", "Part of this was read from a correction or from word order alone; check the plan before Kletia builds it.");
  });
  const moves = movesReason({
    actions: resolved,
    steps: resolved.map((_action, index) => stepAt(index)),
    origins: meta.map((info) => (info.step === null ? undefined : { step: info.goalStep ?? info.step, goal: info.goal === true })),
    thirdParty,
    balance: (network, symbol) => env.facts.balance(network, symbol),
  });
  if (moves) {
    const index = moves.kind === "several" ? meta.find((info) => info.goalStep === moves.step)?.step ?? 0 : meta[moves.action]?.step ?? 0;
    note(index, "Every move: ", moves.kind === "holding-to-third-party"
      ? "It pays a whole holding (or a share of it) to someone else. Kletia lists the amount before planning."
      : "It moves more than one holding, or most of one. Kletia lists every move before planning.");
  }
  for (const [action, entry] of resolved.entries()) {
    if (!thirdParty(entry)) continue;
    const step = stepAt(action);
    const raw = step?.amount?.v.t === "exact" ? step.amount.v.raw : undefined;
    const corrected = state.corrections.some((correction) => correction.field === field(meta[action]?.step ?? action, "amount"));
    const derived = (step?.readAs?.length ?? 0) > 0 || (step?.amount?.v.t === "exact" && step.amount.v.unit !== undefined) || corrected || groupedAmount(raw);
    if (derived && step?.amount?.by !== "answer") {
      note(meta[action]?.step ?? action, "Kletia read this as: ", `Read as ${entry.amount} ${entry.from}${raw ? ` (${raw.slice(0, 16)})` : ""}. Check the amount before Kletia pays someone else.`);
    }
  }
  if (at === null) return null;
  return {
    id: "confirm",
    reason: "INTERPRETATION_CONFIRM",
    index: at,
    fieldName: "kind",
    kind: "confirm",
    prompt: confirmPrompt(resolved, lead),
    why,
    choices: [{ id: "confirm", label: "Yes, plan it" }],
    ...(llm ? { llm: true as const } : {}),
  };
}

/**
 * After every step resolved: holding claims, the address check,
 * the acknowledgements a plan needs (delivery across networks, staking fed
 * another asset, gas where a step signs, the confirm of the solved plan),
 * each settled through the confirm digest, then the ready-time invariants.
 */
function decidePlan(input: {
  readonly state: WorkState;
  readonly env: Env;
  readonly steps: readonly WorkStep[];
  readonly resolved: PlacedAction[];
  readonly meta: ActionMeta[];
  readonly assumptions: readonly Assumption[];
  readonly acksNeeded: readonly AckNeed[];
  readonly layout?: Analysis["layout"];
}): PolicyAnalysis {
  const { state, env, steps, resolved, meta, layout } = input;
  const assumptions = [...input.assumptions];
  const thirdParty = (action: ResolvedAction) => action.recipient !== undefined && !ownAddress(env.ctx.accounts, action.recipient);
  const stepOf = (action: number): number => {
    for (let index = action; index < meta.length; index += 1) {
      const at = meta[index]?.step;
      if (at !== null && at !== undefined) return at;
    }
    return 0;
  };
  const done = (questions: Question[], extra: Partial<PolicyAnalysis> = {}): PolicyAnalysis => ({
    questions: questions.slice(0, 2),
    assumptions: dedupe(assumptions),
    resolved: questions.length === 0 && !extra.pending ? resolved : null,
    ...(layout ? { layout } : {}),
    meta,
    ...extra,
  });
  const conflict = spendConflict(env, resolved, meta, steps);
  if (conflict) return done([conflict]);
  const acks: AckNeed[] = [];
  for (const [index, action] of resolved.entries()) {
    if (!action.recipient || !isEvmAddress(action.recipient) || !thirdParty(action)) continue;
    const receiving = action.kind === "bridge" ? (action.toNetwork as NetworkKey) : action.network;
    const code = codeCheck(env, stepOf(index), action.recipient, receiving);
    if (code?.pending) return done([], { pending: true });
    if (code?.question) return done([code.question]);
    if (code?.ack) acks.push(code.ack);
  }
  for (const [index, action] of resolved.entries()) {
    if (meta[index]?.crossingPayment && action.amount !== "max") acks.push(deliveryAck(stepOf(index), action));
  }
  acks.push(...input.acksNeeded);
  // A fixed departure adds a bridge before the first step (departure.ts): that step then signs after an arrival too.
  const start = env.ctx.sourceNetwork;
  const lead = resolved[0];
  const departing = start !== undefined && start !== "auto" && lead !== undefined && lead.kind !== "transfer" && !lead.recipient && !lead.explicit && lead.network !== start;
  const gasPlan: ResolvedAction[] = departing ? [{ kind: "bridge", network: start, toNetwork: lead.network, from: lead.from, amount: lead.amount }, ...resolved] : [...resolved];
  for (const shortfall of gasShortfalls(gasPlan, (network, symbol) => env.facts.balance(network, symbol))) {
    const shift = departing ? 1 : 0;
    const arriving = shortfall.arriving === null ? null : shortfall.arriving - shift;
    acks.push(gasAck(stepOf(shortfall.action - shift), { ...shortfall, action: shortfall.action - shift, arriving }, departing ? start : undefined));
  }
  const confirm = confirmNeed(state, env, steps, resolved, meta, thirdParty);
  if (confirm) acks.push(confirm);
  const digestOf = (tokens: readonly string[]) => endStateDigest(resolved, tokens, { ...(env.ctx.sourceNetwork ? { sourceNetwork: env.ctx.sourceNetwork } : {}) });
  const settled = settledAcks(state.confirmDigest, acks.map((ack) => ({ id: ack.id, choices: ack.choices.map((choice) => `${ack.id}=${choice.id}`) })), digestOf);
  if (settled.length < acks.length) {
    const next = acks[settled.length] as AckNeed;
    const options: Option[] = next.choices.map((choice) => ({
      id: choice.id,
      label: choice.label,
      ...(choice.detail ? { detail: choice.detail } : {}),
      value: { target: `${next.llm ? "ackllm" : "ack"}:${digestOf([...settled, `${next.id}=${choice.id}`])}` },
    }));
    options.push({ id: "cancel", label: next.kind === "confirm" ? "No, rewrite it" : "Cancel", value: { target: "cancel" } });
    return done([question(field(next.index, next.fieldName), next.kind, next.reason, next.prompt, next.why, options, next.kind === "confirm")], next.llm ? { modelReading: true } : {});
  }
  const gasOnArrival: Record<string, string> = {};
  for (const token of settled) {
    const topup = /^gas:([a-z-]+)=topup$/u.exec(token);
    if (topup?.[1]) gasOnArrival[topup[1]] = GAS_TOPUP_USD;
  }
  for (const [network] of Object.entries(gasOnArrival)) {
    assumptions.push(assumption(field(0, "gasOnArrival"), clip(`Includes $${GAS_TOPUP_USD} of ${gasSymbol(network as NetworkKey)} on ${networkName(network as NetworkKey)}`, 48), {}, "context",
      "Delivered with the bridge that arrives there, so the next step can pay its network fee.", [], true));
  }
  const violations = readyViolations({
    actions: resolved,
    meta,
    steps,
    saidRecipients: saidRecipients(state, steps),
    thirdParty,
    confirmed: settled.includes("confirm=confirm"),
  });
  if (violations.length > 0) throw invariantRefusal(violations);
  const llm = steps.some((step) => modelReadStep(step));
  return done([], {
    ...(Object.keys(gasOnArrival).length > 0 ? { gasOnArrival } : {}),
    digest: digestOf(settled),
    ...(llm ? { modelReading: true as const } : {}),
  });
}

function correctionAssumptions(state: WorkState): Assumption[] {
  return state.corrections
    .filter((correction) => !correction.field.endsWith(".text"))
    .map((correction) => assumption(
      correction.field,
      `"${correction.from}" read as ${correction.to}`,
      {},
      "correction",
      correction.field.endsWith(".amount") ? "A comma before one or two digits is read as a decimal point." : `"${correction.from}" is not a word Kletia knows; "${correction.to}" is the only close match.`,
      [],
      correction.material,
    ));
}

/** The whole policy over a thread's slots; mutates only `assumed` slots (stickiness, R0). */
export function analyze(state: WorkState, ctx: TurnContext, facts: FactsView): PolicyAnalysis {
  const env: Env = { ctx, facts };
  const pending = pendingEditQuestion(state);
  if (pending) return { questions: [pending], assumptions: [], resolved: null };
  // Goal steps: solved from their Goals and this turn's snapshot, expanded into ordinary steps.
  const expansion = state.steps.some((step) => step.goal !== undefined && step.kind === undefined) ? expandGoalSteps(state, ctx, facts) : null;
  if (expansion?.pending) return { questions: [], assumptions: [], resolved: null, pending: true, layout: expansion.layout };
  const steps = expansion ? expansion.steps : state.steps;
  const layout = expansion?.layout;
  const questions: Question[] = [];
  const assumptions: Assumption[] = [...correctionAssumptions(state), ...readingChips(steps), ...(expansion?.assumptions ?? [])];
  const resolved: PlacedAction[] = [];
  const meta: ActionMeta[] = [];
  const push = (action: PlacedAction, info: ActionMeta) => {
    resolved.push(action);
    meta.push(info);
  };
  let prevDest: NetworkKey | undefined;
  let prevOut: string | undefined;
  // The networks the funds of the current chain of steps visited (no round trip).
  let path: NetworkKey[] = [];
  const ask = (list: Question[]) => questions.push(...list);
  // Acknowledgements the plan needs once it is solved (asked in order after the loop; settled by the confirm digest).
  const acksNeeded: AckNeed[] = [];
  const closedClass = closedClassBlock(steps);
  if (closedClass) throw closedClass;
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index] as WorkStep;
    if (!step.kind) {
      ask([question(field(index, "kind"), "choice", "VERB_AMBIGUOUS", "Which action did you mean?", "The first word is close to more than one action.",
        (step.kindCandidates ?? []).map((kind) => ({ id: kind, label: kind[0]!.toUpperCase() + kind.slice(1), value: { kind } })), false)]);
      break;
    }
    const kind = step.kind.v;
    const dependent = step.amount?.v.t === "previous";
    if (step.contract) {
      const contract = analyzeContract(env, index, step, prevDest);
      if (contract.question) {
        ask([contract.question]);
        break;
      }
      const action = contract.action as ResolvedAction;
      if (resolved[0] && lane(resolved[0].network) !== lane(action.network)) {
        throw new PlatformError("CAPITAL_LANE_MIXED", `${networkName(action.network)} cannot share an intent with ${networkName(resolved[0].network)}.`, 422);
      }
      if (dependent && prevOut && !action.from) action.from = prevOut;
      push(action, { step: index, ...(layout?.[index]?.goal ? { goal: true, goalStep: layout[index]?.step } : {}) });
      if (!dependent) path = [action.network];
      prevDest = action.network;
      prevOut = action.from || prevOut;
      continue;
    }
    // D9: a symbol within one edit of listed ones ("SLO") is asked, never corrected silently.
    const typo = typoOf(step);
    if (typo) {
      ask([typoQuestion({ typo }, index) as Question]);
      break;
    }
    // "sell 1 SOL": received in the network's most used dollar stablecoin unless named (a chip).
    if (kind === "swap" && step.sell && !step.to && !step.usdTo) step.usdTo = true;
    let first: Question | null = null;
    if (kind === "transfer" || (kind === "bridge" && step.recipient)) first = recipientQuestion(env, index, step);
    if (!first && kind === "bridge" && !step.toNetwork) {
      const source = step.network?.v ?? (dependent ? prevDest : undefined);
      const current = laneOf(ctx.accounts);
      const networks = bridgeNetworksOf(current).filter((network) => network !== source && hasAccount(ctx.accounts, network) && (dependent || (step.vague === true && !step.from) || symbolOnNetwork(env, network, step.from?.v, step.usdFrom)));
      first = question(field(index, "toNetwork"), "choice", "DESTINATION_MISSING", `Where should ${amountPhrase(step)} go?`, "The destination is where the money arrives.", networks.map((network) => networkOption(network)), true);
    }
    // "swap some tokens": what to spend comes first; "buy something": what to buy comes first.
    const vagueSwap = kind === "swap" && step.vague === true && !step.from && !step.usdFrom && !dependent;
    if (!first && kind === "swap" && !step.to && !step.usdTo && (!vagueSwap || step.buy)) {
      const network = step.network?.v ?? swapCandidates(env, step, step.from?.v, undefined)[0] ?? "base";
      const from = (step.from?.v ?? "").toUpperCase();
      const options = symbolsOn(network)
        .filter((symbol) => symbol.toUpperCase() !== from && !transferOnly(network, symbol))
        .slice(0, 5)
        .map((symbol) => ({ id: symbol, label: symbol, value: { asset: symbol } }));
      first = vagueSwap
        ? question(field(index, "to"), "choice", "OUTPUT_ASSET_MISSING", "What should Kletia buy?", "Name the token you want to receive.", options, true)
        : question(field(index, "to"), "choice", "OUTPUT_ASSET_MISSING", `Swap ${amountPhrase(step)} for what?`, "Name the token you want to receive.", options, true);
    }
    if (!first && kind === "withdraw" && !step.usdFrom && !dependent && (!step.from || (step.from.by === "assumed" && step.from.why?.code === "position.only"))) {
      const only = onlyPosition(env, index, step);
      if (only) {
        step.from = { v: only.symbol, by: "assumed", why: { source: "position", code: "position.only" } };
        assumptions.push(only.assumption);
      } else if (step.from?.by === "assumed") {
        delete step.from;
      }
    }
    if (!first && kind === "stake" && step.vague === true && !step.from && !dependent && !step.provider) {
      const stakeable = (["SOL", "ETH"] as const).filter((symbol) => NETWORK_ORDER.some((network) => lane(network) === laneOf(ctx.accounts) && hasAccount(ctx.accounts, network) && isPositive(facts.balance(network, symbol))));
      const options = (stakeable.length > 0 ? stakeable : (["SOL", "ETH"] as const)).map((symbol) => ({ id: symbol, label: symbol, value: { asset: symbol } }));
      first = question(field(index, "from"), "choice", "INPUT_ASSET_MISSING", "What should Kletia stake?", "Kletia stakes SOL, or ETH on Ethereum, into a liquid staking token.", options, true);
    }
    if (!first && !step.from && !step.usdFrom && !dependent && kind !== "stake") {
      const network = step.network?.v ?? (kind === "swap" ? swapCandidates(env, step, undefined, step.to?.v)[0] : undefined) ?? "base";
      const symbols = symbolsOn(network).filter((symbol) => symbol !== step.to?.v && !(kind !== "transfer" && transferOnly(network, symbol)));
      const funded = symbols.filter((symbol) => isPositive(facts.balance(network, symbol)));
      const pool = funded.length > 0 ? funded : [CHAINS[network].nativeAsset.symbol, "USDC"].filter((symbol) => canonicalOn(network, symbol) && symbol !== step.to?.v);
      const options = pool.slice(0, 4).map((symbol) => {
        const amount = held(env, network, symbol);
        return { id: symbol, label: symbol, ...(amount !== undefined ? { detail: `You hold ${amount}` } : {}), value: { asset: symbol } };
      });
      const prompt = step.buy
        ? `Buy ${step.to?.v ?? "it"} with what?`
        : step.vague && kind === "swap" ? `What should Kletia ${step.sell ? "sell" : "swap"}?` : "Which token should this use?";
      first = question(field(index, "from"), "choice", "INPUT_ASSET_MISSING", prompt, "Kletia plans with the amount you spend.", options, true);
    }
    if (first) {
      ask(withIndependent(env, index, step, first));
      break;
    }
    if (kind === "stake" && step.provider && step.from?.by === "user") {
      const provider = stakeProvider(step.provider.v);
      if (provider && step.from.v.toUpperCase() !== provider.input) throw refuseUnsupported(`${provider.grammarProvider} stakes ${provider.input}, not ${step.from.v.toUpperCase()}.`);
    }
    if ((kind === "deposit" || kind === "withdraw") && ambiguousVenue(step.protocol?.v)) {
      // A venue word that names two protocols (bare "spark"): asked before anything is decided on it, the
      // default suggested; a network the user typed that only one of them serves settles it.
      const ambiguous = ambiguousVenue(step.protocol?.v) as readonly string[];
      const said = step.network?.by === "user" ? step.network.v : undefined;
      const symbolOn = (network: NetworkKey) => symbolOnNetwork(env, network, step.from?.v, step.usdFrom);
      const fitting = said ? ambiguous.filter((id) => venueNetworks(kind, id, symbolOn).includes(said)) : [...ambiguous];
      if (fitting.length === 1) step.protocol = { v: fitting[0] as string, by: "derived" };
      else {
        const word = step.protocol?.v ?? "";
        const options = (fitting.length > 0 ? fitting : ambiguous).map((id, i) => ({ id, label: protocolLabel(id), value: { protocol: id }, ...(i === 0 ? { recommended: true as const } : {}) }));
        ask([question(field(index, "protocol"), "choice", "VENUE_AMBIGUOUS", `"${word}" names ${ambiguous.map(protocolLabel).join(" and ")}. Which one?`, `${protocolLabel(ambiguous[0] as string)} is Kletia's default for "${word}".`, options, false)]);
        break;
      }
    }
    if (step.possessive && !step.amount) wholeHolding(env, step);
    const reference = referenceQuestion(env, index, step, prevDest, prevOut);
    if (reference) {
      ask([reference]);
      break;
    }
    const choice = chooseNetwork(env, index, step, prevDest, prevOut);
    if (choice.question) {
      ask([choice.question]);
      break;
    }
    if (choice.assumption) assumptions.push(choice.assumption);
    const network = choice.network as NetworkKey;
    // Where the money of this step is when it is not where the step runs: a payment's source or a said
    // spend-side network (`fundFrom`), never for a step that spends the previous output.
    const source = !dependent ? choice.source?.network ?? fundSource(step, kind, network) : undefined;
    const firstLane = resolved[0] ? lane(resolved[0].network) : lane(network);
    const mixed = [network, ...(source ? [source] : []), ...(kind === "bridge" && step.toNetwork ? [step.toNetwork.v] : [])].find((entry) => lane(entry) !== firstLane);
    if (mixed) {
      const base = resolved[0] ? (resolved[0] as ResolvedAction).network : network;
      const other = mixed === base ? network : mixed;
      throw new PlatformError("CAPITAL_LANE_MIXED", `${networkName(other)} (${lane(other)}) cannot share an intent with ${networkName(base)} (${lane(base)}): mainnet and testnet capital never mix.`, 422);
    }
    // Network continuity (I6): a step that spends the previous step's output runs where that output lands. A
    // network the person said that contradicts where the previous step delivers, or a crossing back to a network the
    // funds left, is asked (rule 6); otherwise a crossing leg carries the output there (rule 2), never other funds.
    let crossing: { readonly from: string; readonly to: string } | null = null;
    if (dependent && prevDest && network !== prevDest) {
      const contradiction = contradictionQuestion(env, index, step, steps[index - 1], kind, network, prevDest, prevOut, path, layout);
      if (contradiction) {
        ask([contradiction]);
        break;
      }
      crossing = crossingSymbols(prevOut ?? step.from?.v ?? "", prevDest, network);
      if (!crossing) throw networkContradiction(index, kind, network, prevDest, prevOut, steps[index - 1]);
    }
    // A said bridge back: the funds would return to a network they left (two bridges for nothing).
    // Asked once; the answer keeps the destination as the person's own (invariant 10 then holds).
    if (dependent && kind === "bridge" && step.toNetwork?.by === "user" && path.slice(0, -1).includes(step.toNetwork.v)) {
      const back = step.toNetwork.v;
      const what = prevOut ? `the ${prevOut}` : "the funds";
      ask([question(field(index, "toNetwork"), "choice", "NETWORK_CONTRADICTION", `Step ${index + 1} bridges ${what} back to ${networkName(back)}, where ${index > 1 ? "earlier steps" : "step 1"} moved it from. Bridge it back?`,
        "That pays two bridges and returns the funds where they started. Kletia asks before planning a round trip.", [
          networkOption(back, "Two bridges; the funds end where they started", { label: clip(`Bridge it back to ${networkName(back)}`, 48) }),
          { id: "cancel", label: "Neither, cancel", value: { target: "cancel" } },
        ], false)]);
      break;
    }
    if (kind === "swap" && !SWAP_NETWORKS.includes(network)) {
      throw refuseUnsupported(`Swaps run on ${SWAP_NETWORKS.filter((entry) => lane(entry) === lane(network)).map(networkName).join(", ")}, not ${networkName(network)}.`);
    }
    if (kind === "swap" && step.protocol && !(dexNetworks(step.protocol.v) ?? []).includes(network)) {
      throw refuseUnsupported(`${protocolLabel(step.protocol.v)} swaps run on ${(dexNetworks(step.protocol.v) ?? []).map(networkName).join(", ")}, not ${networkName(network)}.`);
    }
    const bridgeable = bridgeNetworksOf(lane(network));
    if (kind === "bridge" && (!bridgeable.includes(network) || (step.toNetwork && !bridgeable.includes(step.toNetwork.v)))) {
      throw refuseUnsupported(`Bridges run between ${bridgeable.map(networkName).join(", ")}.`);
    }
    if ((kind === "transfer" || (kind === "bridge" && step.recipient)) && step.recipient && !isName(step.recipient.v) && ownAddress(ctx.accounts, step.recipient.v)) {
      throw new PlatformError("SELF_TRANSFER", "The recipient is the sending account; nothing would move.", 422);
    }
    const receivesHere = kind === "transfer" && source !== undefined;
    const missing = !receivesHere && !hasAccount(ctx.accounts, network) ? network
      : source && !hasAccount(ctx.accounts, source) ? source
        : kind === "bridge" && step.toNetwork && !step.recipient && !hasAccount(ctx.accounts, step.toNetwork.v) ? step.toNetwork.v : null;
    if (missing) {
      throw new PlatformError("ACCOUNT_REQUIRED", `This intent needs a ${family(missing) === "solana" ? "Solana" : "EVM"} account for ${networkName(missing)}.`, 422, [{ path: "accounts", message: `Missing ${family(missing)} account.` }]);
    }
    // R4b: the money starts on the departure: check the asset and the amount there (departure.ts adds the bridge).
    let departureAmount: AmountChoice | null = null;
    let departureFrom: string | null = null;
    if (choice.departureBridge) {
      const from = choice.departureBridge;
      if (!hasAccount(ctx.accounts, from)) {
        throw new PlatformError("ACCOUNT_REQUIRED", `This intent needs a ${family(from) === "solana" ? "Solana" : "EVM"} account for ${networkName(from)}.`, 422, [{ path: "accounts", message: `Missing ${family(from)} account.` }]);
      }
      departureFrom = "USDC";
      if (step.from && !isUsdWord(step.from.v)) {
        const check = checkAsset(env, index, "from", from, step.from.v, step.from.by, "spend", step.amount?.v, "bridge");
        if (check.question) {
          ask([check.question]);
          break;
        }
        if (check.assumption) assumptions.push(check.assumption);
        departureFrom = check.symbol as string;
      }
      departureAmount = resolveAmount(env, index, step, from, departureFrom);
      if (departureAmount.question) {
        ask([departureAmount.question]);
        break;
      }
      if (departureAmount.assumption) assumptions.push(departureAmount.assumption);
      // D2 where the money starts (I9 funding): the departure must hold the amount it sends.
      if (step.amount?.by === "user" && step.amount.v.t === "exact") {
        const exceeds = exceedsBalance(env, index, step, kind, from, departureFrom, step.amount.v.value, network);
        if (exceeds) {
          ask([exceeds]);
          break;
        }
      }
    }
    // The money is on `source`, the step runs (or the recipient receives) on `network`. The asset
    // and the amount are checked where the money is; one crossing leg carries it (a bridge, or a bridge that pays).
    let sourceFrom: string | null = null;
    let sourceAmount: AmountChoice | null = null;
    let sourceCrossing: { readonly from: string; readonly to: string } | null = null;
    if (source) {
      if (step.from && !isUsdWord(step.from.v)) {
        const check = checkAsset(env, index, "from", source, step.from.v, step.from.by, "spend", step.amount?.v, "bridge");
        if (check.question) {
          ask([check.question]);
          break;
        }
        if (check.assumption) assumptions.push(check.assumption);
        sourceFrom = check.symbol as string;
      } else {
        const stable = usdStable(env, source, exactNeed(step.amount?.v), "spend");
        if (!stable) throw new PlatformError("TOKEN_UNKNOWN", `No USD stablecoin is listed on ${networkName(source)}.`, 422);
        sourceFrom = stable.symbol;
      }
      sourceCrossing = crossingSymbols(sourceFrom, source, network);
      if (!sourceCrossing) {
        throw refuseUnsupported(`Kletia cannot move ${sourceFrom} from ${networkName(source)} to ${networkName(network)} in one bridge. ${kind === "transfer" ? `Pay on ${networkName(source)}` : `Use one network for this step`}, or use a token a bridge carries (USDC, or ETH between Ethereum-family networks).`);
      }
      sourceAmount = resolveAmount(env, index, step, source, sourceFrom);
      if (sourceAmount.question) {
        ask([sourceAmount.question]);
        break;
      }
      if (sourceAmount.assumption) assumptions.push(sourceAmount.assumption);
      // D2 where the money is (a payment included).
      if (step.amount?.by === "user" && step.amount.v.t === "exact") {
        const exceeds = exceedsBalance(env, index, step, kind, source, sourceFrom, step.amount.v.value, network);
        if (exceeds) {
          ask([exceeds]);
          break;
        }
      }
    }
    // The input asset on the chosen network.
    let from: string;
    if (departureFrom) {
      from = canonicalOn(network, departureFrom) ?? departureFrom;
    } else if (sourceCrossing) {
      from = sourceCrossing.to;
    } else if (dependent) {
      from = crossing ? crossing.to : prevOut ?? (step.from?.v as string);
      if (kind === "stake") {
        const provider = stakeProvider(step.provider?.v);
        const wanted = provider?.input ?? (from.toUpperCase() === "ETH" || from.toUpperCase() === "WETH" ? "ETH" : "SOL");
        // Staking fed another asset is never a silent purchase of the staked token: asked (or confirmed) first.
        if (from.toUpperCase() !== wanted) {
          const lst = (stakeProvider(step.provider?.v) ?? defaultProvider(wanted)).symbol;
          acksNeeded.push(stakeInputAck(index, from, wanted, lst));
        }
      }
    } else if (!step.from || isUsdWord(step.from.v)) {
      const stable = usdStable(env, network, exactNeed(step.amount?.v), "spend");
      if (!stable) throw new PlatformError("TOKEN_UNKNOWN", `No USD stablecoin is listed on ${networkName(network)}.`, 422);
      from = stable.symbol;
      if (stable.alternatives.length > 0) {
        assumptions.push(assumption(field(index, "from"), `Pay in ${from}`, { asset: from }, step.from ? "alias" : "default", `A dollar amount is paid in a USD stablecoin; ${from} is the most widely used on ${networkName(network)}.`,
          stable.alternatives.map((symbol) => ({ id: symbol, label: symbol, value: { asset: symbol } })), false));
      }
    } else {
      const check = checkAsset(env, index, "from", network, step.from.v, step.from.by, "spend", step.amount?.v, kind);
      if (check.question) {
        ask([check.question]);
        break;
      }
      if (check.assumption) assumptions.push(check.assumption);
      from = check.symbol as string;
    }
    // The output asset.
    let to: string | undefined;
    const destination = kind === "bridge" ? (step.toNetwork?.v as NetworkKey) : network;
    if (kind === "swap" || kind === "bridge") {
      const rawTo = step.to?.v;
      if (step.usdTo || isUsdWord(rawTo)) {
        const stable = usdStable(env, destination, null, "receive");
        if (!stable) throw new PlatformError("TOKEN_UNKNOWN", `No USD stablecoin is listed on ${networkName(destination)}.`, 422);
        to = stable.symbol;
        assumptions.push(assumption(field(index, "to"), `Receive ${to}`, { asset: to }, "alias", `${to} is the most widely used dollar stablecoin on ${networkName(destination)}.`,
          stable.alternatives.map((symbol) => ({ id: symbol, label: symbol, value: { asset: symbol } })), false));
      } else if (rawTo) {
        const check = checkAsset(env, index, "to", destination, rawTo, step.to?.by ?? "user", "receive", undefined, kind, kind === "swap" ? from : undefined);
        if (check.question) {
          ask([check.question]);
          break;
        }
        if (check.assumption) assumptions.push(check.assumption);
        to = check.symbol;
      } else if (kind === "bridge") {
        const counterpart = canonicalOn(destination, from);
        if (!counterpart || (from.toUpperCase() === "ETH" && family(destination) === "solana")) {
          const options = ["SOL", "USDC", "ETH"].filter((symbol) => canonicalOn(destination, symbol) && symbol !== from).map((symbol) => ({ id: symbol, label: `Receive ${symbol}`, value: { asset: symbol } }));
          ask([question(field(index, "to"), "choice", "COUNTERPART_MISSING", `${from} does not exist on ${networkName(destination)}. What should arrive there?`, "The bridge swaps into the token you pick.", options, true)]);
          break;
        }
      }
      if (kind === "swap" && to && to.toUpperCase() === from.toUpperCase()) throw new PlatformError("SWAP_SAME_ASSET", `This would swap ${from} into itself.`, 422);
    }
    // A crossing leg carries the money: the step spends all of what arrives ("it").
    const amount: AmountChoice = departureAmount ?? (sourceAmount && kind !== "transfer" ? { amount: "max" } : sourceAmount) ?? resolveAmount(env, index, step, network, from);
    if (amount.question) {
      ask([amount.question]);
      break;
    }
    if (amount.assumption && !departureAmount && !sourceAmount) assumptions.push(amount.assumption);
    // D2: an exact amount the person typed above the known balance where the step spends it (unknown is never a shortfall).
    // With a departure (sourceNetwork) the departure rules fund the step, so the balance where it runs says nothing.
    if (!departureAmount && !source && !dependent && !ctx.sourceNetwork && step.amount?.by === "user" && step.amount.v.t === "exact" && SPENDING_KINDS.has(kind)) {
      const exceeds = exceedsBalance(env, index, step, kind, network, from, step.amount.v.value, network);
      if (exceeds) {
        ask([exceeds]);
        break;
      }
    }
    // Venue, vault and provider.
    // A venue Kletia picked by rate is decided again each turn (rates move); one the person chose stays.
    const pickedByRate = step.protocol?.by === "assumed" && step.protocol.why?.code === VENUE_RATE_CODE;
    let protocol = pickedByRate ? undefined : step.protocol?.v;
    let vault = pickedByRate ? undefined : step.vault?.v;
    let provider = step.provider?.v;
    if (kind === "deposit" || kind === "withdraw") {
      if (!protocol && kind === "deposit") {
        // A venue-less deposit: the capability index's venues, ranked by tier, with live
        // rates. The best risk-adjusted rate among core and curated venues is picked and shown; asked only without rates.
        const pick = chooseVenue(env, index, step, network, from);
        if (pick.question) {
          ask([pick.question]);
          break;
        }
        protocol = pick.protocol as string;
        vault = pick.vault;
        if (pick.assumption) assumptions.push(pick.assumption);
      }
      if (!protocol) {
        const venues = lendingProtocols().map((id) => venuesOn(network, kind, id, from)[0]).filter((venue) => venue !== undefined);
        if (venues.length === 0) throw refuseUnsupported(`No lending venue takes ${from} on ${networkName(network)}.`);
        const options = venues.map((venue, i) => ({ id: venue.protocol, label: protocolLabel(venue.protocol), detail: venue.name, value: { protocol: venue.protocol }, ...(i === 0 ? { recommended: true as const } : {}) }));
        ask([question(field(index, "protocol"), "choice", "VENUE_MISSING", `Where should ${amountPhrase(step, from)} earn yield on ${networkName(network)}?`, "Each venue has its own rate and risks; rates are variable.", options, false)]);
        break;
      }
      const venues = venuesOn(network, kind, protocol, from);
      if (venues.length === 0) throw refuseUnsupported(`${protocolLabel(protocol)} does not take ${from} on ${networkName(network)}.`);
      if (vault && !venues.some((venue) => venue.slug === vault)) {
        throw refuseUnsupported(`${protocolLabel(protocol)} has no ${from} vault "${vault.slice(0, 32)}" on ${networkName(network)}.`);
      }
      if (!vault && venues.length > 1) {
        vault = venues[0]!.slug;
        assumptions.push(assumption(field(index, "venue"), venues[0]!.name, { venue: vault }, "default", `The default ${protocolLabel(protocol)} venue for ${from} on ${networkName(network)}.`,
          venues.slice(1).map((venue) => ({ id: venue.slug, label: venue.name, value: { venue: venue.slug } })), false));
      }
    }
    if (kind === "stake" && !dependent && step.provider?.by !== "user" && step.provider?.by !== "answer") {
      // Staking ETH where it does not run: buy a liquid staking token there, or bridge and stake.
      const etherIn = from.toUpperCase() === "ETH" || from.toUpperCase() === "WETH";
      const options = etherIn && family(network) === "eip155" ? l2StakeOptions(network) : [];
      if (options.length > 0) {
        const copy = PROTOCOL_QUESTION_COPY.l2Stake(amountPhrase(step, from), networkName(network));
        ask([question(field(index, "provider"), "choice", "VENUE_MISSING", copy.prompt, copy.why,
          options.map((option) => ({ id: option.id, label: option.label, detail: option.detail, value: { target: option.id } })), false)]);
        break;
      }
    }
    if (kind === "stake") {
      const input = stakeProvider(provider)?.input ?? (network === "ethereum" || from.toUpperCase() === "ETH" ? "ETH" : "SOL");
      if (!provider || step.provider?.by === "assumed") {
        // Solana Devnet runs native staking only.
        const chosen = stakeProvider(provider) ?? (network === "solana-devnet" ? stakeProvider(NATIVE_STAKE_PROTOCOL) as NonNullable<ReturnType<typeof stakeProvider>> : defaultProvider(input));
        provider = chosen.id;
        remember(step, "provider", provider, { source: "default", code: "default.provider" });
        assumptions.push(assumption(field(index, "provider"), chosen.label, { provider }, "default", reasonText("default.provider", { protocol: chosen.grammarProvider, symbol: input }),
          STAKE_PROVIDERS.filter((entry) => entry.input === input && entry.id !== provider).map((entry) => ({ id: entry.id, label: entry.label, value: { provider: entry.id } })), true));
      }
      const chosen = stakeProvider(provider) as ReturnType<typeof stakeProvider>;
      if (!chosen) throw refuseUnsupported("Unknown staking provider.");
      if (chosen.network !== network && !(chosen.id === NATIVE_STAKE_PROTOCOL && network === "solana-devnet")) {
        throw refuseUnsupported(`${chosen.grammarProvider} stakes ${chosen.input} on ${networkName(chosen.network)}, not on ${networkName(network)}.`);
      }
      if (!dependent && from.toUpperCase() !== chosen.input) throw refuseUnsupported(`${chosen.grammarProvider} stakes ${chosen.input}, not ${from}.`);
      to = chosen.symbol;
    }
    if (kind === "bridge" && step.toNetwork?.v === network) throw refuseUnsupported("The source and destination networks are the same; use swap or send instead.");
    const info: ActionMeta = { step: index, ...(layout?.[index]?.goal ? { goal: true, goalStep: layout[index]?.step } : {}) };
    const explicit = choice.departureBridge !== undefined ? false
      : kind === "transfer" || step.network?.by === "user" || step.network?.by === "answer" || step.fundFrom !== undefined;
    const portionOf = (choiceOf: AmountChoice | null) => (choiceOf?.portionBps !== undefined ? { portionBps: choiceOf.portionBps } : {});
    if (!dependent) path = [source ?? network];
    const recipient = step.recipient?.v;
    if (kind === "transfer" && (crossing || sourceCrossing) && recipient) {
      // One crossing leg that pays the recipient where they receive.
      const legSource = crossing ? (prevDest as NetworkKey) : (source as NetworkKey);
      const legFrom = crossing ? (prevOut as string) : (sourceFrom as string);
      const legTo = (crossing ?? sourceCrossing)?.to as string;
      push({
        kind: "bridge",
        network: legSource,
        toNetwork: network,
        from: legFrom,
        to: legTo,
        amount: crossing ? "max" : (amount.amount as string),
        ...portionOf(amount),
        recipient,
        explicit: true,
      }, { ...info, crossingPayment: true });
      assumptions.push(crossingPaymentChip(index, recipient, legSource, network, legFrom, crossing ? "dependent" : choice.source?.why ?? "said"));
      path.push(network);
      prevDest = network;
      prevOut = legTo;
      continue;
    }
    if (crossing || sourceCrossing) {
      // A crossing leg carries the step's input to where it runs; the step spends all of what arrives.
      const legSource = crossing ? (prevDest as NetworkKey) : (source as NetworkKey);
      const legFrom = crossing ? (prevOut as string) : (sourceFrom as string);
      const legTo = (crossing ?? sourceCrossing)?.to as string;
      push({
        kind: "bridge",
        network: legSource,
        toNetwork: network,
        from: legFrom,
        to: legTo,
        amount: crossing ? "max" : (sourceAmount?.amount as string),
        ...portionOf(crossing ? amount : sourceAmount),
        explicit: true,
      }, { step: index, crossing: true });
      assumptions.push(crossingChip(index, kind, legSource, network, legFrom, step, crossing ? "dependent" : "said"));
      path.push(network);
    }
    const spendsAll = crossing !== null || sourceCrossing !== null;
    push({
      kind,
      network,
      ...(kind === "bridge" ? { toNetwork: step.toNetwork?.v as NetworkKey } : {}),
      from,
      ...(to ? { to } : {}),
      amount: spendsAll ? "max" : (amount.amount as string),
      ...(spendsAll ? {} : portionOf(amount)),
      ...(recipient ? { recipient } : {}),
      ...(protocol ? { protocol } : {}),
      ...(vault ? { vault } : {}),
      ...(provider ? { provider } : {}),
      explicit: explicit || spendsAll || (kind === "transfer" && (recipient ?? "").includes(":")),
    }, info);
    prevDest = kind === "bridge" ? (step.toNetwork?.v as NetworkKey) : network;
    prevOut = kind === "swap" || kind === "bridge" || kind === "stake" ? (to ?? from) : from;
    if (path[path.length - 1] !== prevDest) path.push(prevDest);
  }
  // A goal that asks comes after every step before it was decided.
  if (questions.length === 0 && expansion && expansion.questions.length > 0) questions.push(...expansion.questions);
  if (questions.length === 0 && expansion?.blocked) throw expansion.blocked;
  if (questions.length > 0) {
    return { questions: questions.slice(0, 2), assumptions: dedupe(assumptions), resolved: null, ...(layout ? { layout } : {}) };
  }
  return decidePlan({ state, env, steps, resolved, meta, assumptions, acksNeeded, ...(layout ? { layout } : {}) });
}

function dedupe(list: Assumption[]): Assumption[] {
  const seen = new Set<string>();
  return list.filter((entry) => (seen.has(entry.id) ? false : (seen.add(entry.id), true)));
}
