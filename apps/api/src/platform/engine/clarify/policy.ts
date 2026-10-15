/**
 * The sensitivity policy (clarify design §4.4, rules R0-R14): for every step
 * of a thread it decides, slot by slot, whether to ask, assume (a chip) or
 * refuse, using only the wallet facts read for this turn. Purpose slots
 * (who receives, where it arrives, what to receive or spend, how much, the
 * network a transfer lands on) are asked; means slots (where a swap or
 * deposit runs, which vault, which staking provider) are assumed and shown.
 *
 * Pure and synchronous over (state, context, facts): it mutates only
 * `assumed` slots of the state it is given (so a kept assumption stays put
 * on later turns, R0) and throws PlatformError for what no question can fix.
 */
import {
  CHAINS,
  evmChecksumState,
  findAssetBySymbol,
  protocolTier,
  NATIVE_FEE_RESERVE,
  parseAccountId,
  type AssumptionSource,
  type NetworkKey,
  type ProtocolId,
  type ThreadAmount,
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
import { assumption, placeholderFor, PROTOCOL_QUESTION_COPY, question, reasonText, short, isReasonCode, type ReasonCode, type ReasonParams } from "./copy.js";
import { expandGoalSteps } from "./goals.js";
import { symbolTypoCandidates } from "../goal/lexer.js";
import { priceAmount, typoQuestion } from "../solver/decide.js";
import { apyLabel, riskLabel } from "../solver/explain.js";
import { cmp, formatDecimal, isPositive, parseDecimal, portion, sub, tidy } from "./decimal.js";
import { field, pendingEditQuestion } from "./edits.js";
import { candidates, distance } from "./fuzzy.js";
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

/* -------------------------------------------------------------- assets */

interface AssetCheck {
  symbol?: string;
  question?: Question;
  assumption?: Assumption;
}

/** Resolves an asset the user named on one network (R5). */
function checkAsset(env: Env, index: number, name: "from" | "to", network: NetworkKey, raw: string, by: string, side: "spend" | "receive", amount: ThreadAmount | undefined, kind: Kind): AssetCheck {
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
    if (family(network) !== "solana") throw new PlatformError("TOKEN_UNKNOWN", `${raw.slice(0, 16)} is not listed on ${networkName(network)}.`, 422, [{ path, message: "Not listed on this network." }]);
  }
  const listed = symbolsOn(network).filter((symbol) => !transferOnly(network, symbol));
  const near = candidates(raw, listed);
  if (family(network) === "solana") {
    // An unlisted Solana symbol may be a verified token or an unverified look-alike, which only the planner's
    // token list can tell: a close listed symbol is asked ("did you mean USDC?"), never corrected or offered
    // as the unverified token; anything else goes to the planner, which refuses unverified tokens.
    // Spending: the user can only spend what they hold, so one close listed symbol is a visible correction.
    if (side === "spend" && near.length === 1) {
      const symbol = near[0] as string;
      return { symbol, assumption: assumption(path, `"${raw.slice(0, 16)}" read as ${symbol}`, { asset: symbol }, "correction", `${raw.slice(0, 16)} is not a token Kletia lists on ${networkName(network)}; ${symbol} is the only close match.`, [], true) };
    }
    if (near.length >= 1) {
      const options = near.map((symbol, i) => ({ id: symbol, label: symbol, detail: "Listed by Kletia", value: { asset: symbol }, ...(i === 0 && near.length === 1 ? { recommended: true as const } : {}) }));
      return { question: question(path, "choice", "ASSET_LOOKALIKE", `Did you mean ${near.join(" or ")}?`, `${raw.slice(0, 16)} is not a token Kletia lists. To use an unlisted token deliberately, paste its mint address.`, options, true) };
    }
    return { symbol: raw };
  }
  if (near.length === 1) {
    const symbol = near[0] as string;
    return { symbol, assumption: assumption(path, `"${raw.slice(0, 16)}" read as ${symbol}`, { asset: symbol }, "correction", `${raw.slice(0, 16)} is not a token Kletia lists on ${networkName(network)}; ${symbol} is ${distance(raw, symbol) === 1 ? "one letter" : "two letters"} away.`, [], true) };
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
  if (!isName(recipient)) return null;
  const kind = recipientFamily(recipient);
  // Where the recipient receives: a bridge pays on its destination, a transfer on its (stated) network.
  const network = step.kind?.v === "bridge" ? step.toNetwork?.v : step.network && step.network.by !== "assumed" ? step.network.v : undefined;
  if (/\.sol$/iu.test(recipient)) {
    const moved = recipient.replace(/\.sol$/iu, ".sns");
    const address = env.facts.resolveName(moved, "solana");
    if (address) {
      return question(path, "confirm", "RECIPIENT_NAME_MOVED", `.sol names moved to .sns. Send to ${moved} (${short(address)})?`, "SNS paused .sol names while it moves them to its new registry.", [
        { id: moved, label: `Send to ${moved}`.slice(0, 48), detail: `Resolves to ${short(address)}`, value: { recipient: moved } },
      ], true, placeholderFor("address", undefined, true));
    }
    return question(path, "address", "RECIPIENT_UNRESOLVED", `${recipient} cannot be used right now. Who should receive ${what}?`, "SNS paused .sol names.", [], true, placeholderFor("address", undefined, true));
  }
  if (network && kind && kind !== "caip" && kind !== family(network)) {
    const evm = EVM_NETWORKS.filter((candidate) => lane(candidate) === "mainnet").filter((candidate) => {
      const symbol = symbolOnNetwork(env, candidate, step.from?.v, step.usdFrom);
      return symbol !== null && isPositive(env.facts.balance(candidate, symbol));
    });
    const options = kind === "eip155"
      ? evm.slice(0, 3).map((candidate) => networkOption(candidate, `You hold ${held(env, candidate, symbolOnNetwork(env, candidate, step.from?.v, step.usdFrom) as string)}`, { label: `Send on ${networkName(candidate)} instead` }))
      : [];
    return question(path, "address", "RECIPIENT_NETWORK_MISMATCH", `${recipient} is ${kind === "eip155" ? "an Ethereum" : "a Solana"} name with no ${networkName(network)} address. Enter a ${networkName(network)} address, or send on another network.`, "Names resolve only on their own network family.", options, true, placeholderFor("address", undefined, family(network) === "solana"));
  }
  const probe = network ?? (kind === "solana" ? "solana" : "base");
  if (env.facts.resolveName(recipient, probe) === null) {
    return question(path, "address", "RECIPIENT_UNRESOLVED", `${recipient} has no ${networkName(probe)} address Kletia could find. Who should receive ${what}?`, "Check the spelling or paste the address. Kletia does not suggest other names.", [], true, placeholder);
  }
  return null;
}

/* ------------------------------------------------------------- networks */

interface NetworkChoice {
  network?: NetworkKey;
  question?: Question;
  assumption?: Assumption;
  /** R4b: the departure the step is bridged from (departure.ts adds the bridge; never stored). */
  departureBridge?: NetworkKey;
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
  const said = step.network && step.network.by !== "assumed" ? step.network.v : undefined;
  const assumed = step.network?.by === "assumed" ? step.network.v : undefined;
  const dependent = step.amount?.v.t === "previous";
  const departure = ctx.sourceNetwork && ctx.sourceNetwork !== "auto" ? ctx.sourceNetwork : undefined;
  const symbolOn = (network: NetworkKey) => symbolOnNetwork(env, network, step.from?.v, step.usdFrom);
  const need = exactNeed(step.amount?.v);
  const params = (network: NetworkKey, extra: ReasonParams = {}): ReasonParams => ({ symbol: symbolOn(network) ?? step.from?.v ?? "", ...extra });
  // R4b (departure.ts's rule, decided here for the chip and the amount): the user fixed where the money starts
  // (or chose "auto" and no network where this runs holds enough) and this swap or deposit cannot run there.
  // The planner input gets the bridge from departure.ts; the chip's alternatives are the other bridge targets.
  // A network the user typed wins.
  const rewritable = index === 0 && !dependent && (kind === "swap" || kind === "deposit") && step.network?.by !== "user";
  let start = departure;
  let auto: { holder: NetworkKey; held: string } | undefined;
  if (!start && ctx.sourceNetwork === "auto" && rewritable && need && step.from) {
    const networks = runNetworks(env, step, kind, symbolOn);
    const f = funding(env, networks, symbolOn, step.amount?.v);
    const holder = f.known && f.covering.length === 0 ? holderFor(env, step.from.v, networks, need, current) : undefined;
    if (holder) {
      start = holder;
      auto = { holder, held: held(env, holder, canonicalOn(holder, step.from.v) as string) ?? "" };
    }
  }
  if (start && rewritable && lane(start) === current) {
    const from = start;
    const networks = runNetworks(env, step, kind, symbolOn);
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
  if (kind === "transfer") {
    const recipient = step.recipient?.v as string;
    const kindOf = recipientFamily(recipient);
    if (kindOf === "caip") return { network: parseAccountId(recipient)?.chain.key as NetworkKey };
    if (/\.base\.eth$/iu.test(recipient)) return { network: "base" };
    if (kindOf === "solana") return { network: current === "testnet" ? "solana-devnet" : "solana" };
    if (dependent && prevDest) {
      if (family(prevDest) === "eip155") return { network: prevDest };
      // R7: the funds will be on Solana but the recipient is an Ethereum-family identity.
      const networks = EVM_NETWORKS.filter((network) => lane(network) === lane(prevDest) && BRIDGE_NETWORKS.includes(network) && hasAccount(ctx.accounts, network) && canonicalOn(network, prevOut ?? "USDC") && portable(prevOut ?? "USDC", false, prevDest, network));
      return {
        question: question(path, "choice", "NETWORK_HANDOFF", `${short(recipient)} is on Ethereum-family networks, and the ${prevOut ?? "funds"} will be on ${networkName(prevDest)}. Which network should ${short(recipient)} receive it on? Kletia bridges it there.`, "A payment lands on one network; the recipient must use that network.", networks.map((network) => networkOption(network)), true),
      };
    }
    const evm = EVM_NETWORKS.filter((network) => lane(network) === current && hasAccount(ctx.accounts, network) && symbolOn(network));
    const who = { recipient: short(recipient) };
    if (assumed && evm.includes(assumed)) {
      const f = funding(env, [assumed], symbolOn, step.amount?.v);
      if (!f.known || f.covering.includes(assumed)) return pick(assumed, "context", "context.kept", evm, f.balances, { ...who, network: networkName(assumed) });
    }
    if (departure && evm.includes(departure)) return { network: departure };
    if (ctx.defaultNetwork && evm.includes(ctx.defaultNetwork)) {
      return pick(ctx.defaultNetwork, "default", "default.network", evm, new Map(), { ...who, network: networkName(ctx.defaultNetwork) });
    }
    if (evm.length === 1) return { network: evm[0] as NetworkKey };
    const f = funding(env, evm, symbolOn, step.amount?.v);
    if (f.known && f.covering.length === 1) {
      const network = f.covering[0] as NetworkKey;
      return pick(network, "balance", "balance.only", evm, f.balances, { ...who, network: networkName(network) });
    }
    const positive = byLargest(evm.filter((network) => isPositive(f.balances.get(network))), f.balances);
    const pool = f.known && f.covering.length > 1 ? byLargest(f.covering, f.balances) : f.known && positive.length > 0 ? positive : evm;
    const options = pool.map((network) => networkOption(network, holdDetail(env, f.balances, network, symbolOn(network), need)));
    return { question: question(path, "choice", "TRANSFER_NETWORK", `Which network should ${short(recipient)} receive ${amountPhrase(step)} on?`, "An address may be used on only one network. Sending on the wrong one can lose the funds.", options, true) };
  }
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

/** A contract step: the grammar's matcher decides the registration; its gaps become questions (§4.11). */
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
 * Kinds whose exact amount is checked against the balance where the step runs
 * (D2). A payment is not: its network is where the recipient receives, and the
 * departure rules may still bridge to it.
 */
const SPENDING_KINDS: ReadonlySet<Kind> = new Set(["swap", "bridge", "deposit", "stake"]);

/** D9: a typed symbol within one edit of listed ones and not itself listed ("SLO"), which the round-6 fuzzy reader leaves alone. */
function typoOf(step: WorkStep): { side: "spend" | "want"; raw: string; candidates: string[] } | null {
  if (step.contract) return null;
  for (const name of ["from", "to"] as const) {
    const said = step[name];
    if (!said || said.by !== "user") continue;
    const found = symbolTypoCandidates(said.v);
    // The round-6 rules come first: a symbol the fuzzy reader matches (four letters and more) is corrected or asked as before.
    if (found.length > 0 && candidates(said.v, found).length === 0) return { side: name === "from" ? "spend" : "want", raw: said.v.slice(0, 16), candidates: found };
  }
  return null;
}

/**
 * D2 for every step: an exact amount above the known balance asks
 * AMOUNT_EXCEEDS_BALANCE (all of it, funds on another network that cover it,
 * or keep the amount as said). Unknown balances never ask.
 */
function exceedsBalance(env: Env, index: number, step: WorkStep, kind: Kind, network: NetworkKey, from: string, need: string): Question | null {
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
  // Funds elsewhere: a bridge starts there instead (bridge), or bridges them here first (swap, deposit).
  if (kind === "bridge" || kind === "swap" || kind === "deposit") {
    for (const other of bridgeNetworksOf(current)) {
      if (options.length >= 4 || other === network || (kind === "bridge" && other === step.toNetwork?.v) || !hasAccount(env.ctx.accounts, other)) continue;
      const symbol = canonicalOn(other, from);
      if (!symbol || (kind !== "bridge" && !portable(from, false, other, network))) continue;
      const there = env.facts.balance(other, symbol);
      if (there === undefined || cmp(there, need) < 0) continue;
      options.push({ id: other, label: `Use funds on ${networkName(other)}`, detail: `You hold ${held(env, other, symbol)} ${symbol} there`, value: { source: other, network } });
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
export function analyze(state: WorkState, ctx: TurnContext, facts: FactsView): Analysis {
  const env: Env = { ctx, facts };
  const pending = pendingEditQuestion(state);
  if (pending) return { questions: [pending], assumptions: [], resolved: null };
  // Goal steps (intent engine v2): solved from their Goals and this turn's snapshot, expanded into ordinary steps.
  const expansion = state.steps.some((step) => step.goal !== undefined && step.kind === undefined) ? expandGoalSteps(state, ctx, facts) : null;
  if (expansion?.pending) return { questions: [], assumptions: [], resolved: null, pending: true, layout: expansion.layout };
  const steps = expansion ? expansion.steps : state.steps;
  const questions: Question[] = [];
  const assumptions: Assumption[] = [...correctionAssumptions(state), ...(expansion?.assumptions ?? [])];
  const resolved: ResolvedAction[] = [];
  let prevDest: NetworkKey | undefined;
  let prevOut: string | undefined;
  const ask = (list: Question[]) => questions.push(...list);
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
      resolved.push(action);
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
      const networks = bridgeNetworksOf(current).filter((network) => network !== source && hasAccount(ctx.accounts, network) && (dependent || symbolOnNetwork(env, network, step.from?.v, step.usdFrom)));
      first = question(field(index, "toNetwork"), "choice", "DESTINATION_MISSING", `Where should ${amountPhrase(step)} go?`, "The destination is where the money arrives.", networks.map((network) => networkOption(network)), true);
    }
    if (!first && kind === "swap" && !step.to && !step.usdTo) {
      const network = step.network?.v ?? swapCandidates(env, step, step.from?.v, undefined)[0] ?? "base";
      const from = (step.from?.v ?? "").toUpperCase();
      const options = symbolsOn(network)
        .filter((symbol) => symbol.toUpperCase() !== from && !transferOnly(network, symbol))
        .slice(0, 5)
        .map((symbol) => ({ id: symbol, label: symbol, value: { asset: symbol } }));
      first = question(field(index, "to"), "choice", "OUTPUT_ASSET_MISSING", `Swap ${amountPhrase(step)} for what?`, "Name the token you want to receive.", options, true);
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
      first = question(field(index, "from"), "choice", "INPUT_ASSET_MISSING", step.buy ? `Buy ${step.to?.v ?? "it"} with what?` : "Which token should this use?", "Kletia plans with the amount you spend.", options, true);
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
    const choice = chooseNetwork(env, index, step, prevDest, prevOut);
    if (choice.question) {
      ask([choice.question]);
      break;
    }
    if (choice.assumption) assumptions.push(choice.assumption);
    const network = choice.network as NetworkKey;
    const firstLane = resolved[0] ? lane(resolved[0].network) : lane(network);
    if (lane(network) !== firstLane || (kind === "bridge" && step.toNetwork && lane(step.toNetwork.v) !== lane(network))) {
      const other = lane(network) !== firstLane ? network : (step.toNetwork?.v as NetworkKey);
      const base = lane(network) !== firstLane ? (resolved[0] as ResolvedAction).network : network;
      throw new PlatformError("CAPITAL_LANE_MIXED", `${networkName(other)} (${lane(other)}) cannot share an intent with ${networkName(base)} (${lane(base)}): mainnet and testnet capital never mix.`, 422);
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
    const missing = !hasAccount(ctx.accounts, network) ? network : kind === "bridge" && step.toNetwork && !step.recipient && !hasAccount(ctx.accounts, step.toNetwork.v) ? step.toNetwork.v : null;
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
    }
    // The input asset on the chosen network.
    let from: string;
    if (departureFrom) {
      from = canonicalOn(network, departureFrom) ?? departureFrom;
    } else if (dependent) {
      from = prevOut ?? (step.from?.v as string);
      if (kind === "stake") {
        const provider = stakeProvider(step.provider?.v);
        const wanted = provider?.input ?? (from.toUpperCase() === "ETH" || from.toUpperCase() === "WETH" ? "ETH" : "SOL");
        if (from.toUpperCase() !== wanted) {
          assumptions.push(assumption(field(index, "from"), `Staking buys liquid staked ${wanted} with the ${from}`, { asset: from }, "context", `Staking needs ${wanted}; the previous step delivers ${from}, so Kletia buys the staked token with it.`, [], true));
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
        const check = checkAsset(env, index, "to", destination, rawTo, step.to?.by ?? "user", "receive", undefined, kind);
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
    const amount: AmountChoice = departureAmount ?? resolveAmount(env, index, step, network, from);
    if (amount.question) {
      ask([amount.question]);
      break;
    }
    if (amount.assumption && !departureAmount) assumptions.push(amount.assumption);
    // D2: an exact amount the person typed above the known balance where the step spends it (unknown is never a shortfall).
    // With a departure (sourceNetwork) the departure rules fund the step, so the balance where it runs says nothing.
    if (!departureAmount && !dependent && !ctx.sourceNetwork && step.amount?.by === "user" && step.amount.v.t === "exact" && SPENDING_KINDS.has(kind)) {
      const exceeds = exceedsBalance(env, index, step, kind, network, from, step.amount.v.value);
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
        // A venue-less deposit (protocols design 3.6, engine D6): the capability index's venues, ranked by tier, with live
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
      // Staking ETH where it does not run (protocols design 3.3): buy a liquid staking token there, or bridge and stake.
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
    resolved.push({
      kind,
      network,
      ...(kind === "bridge" ? { toNetwork: step.toNetwork?.v as NetworkKey } : {}),
      from,
      ...(to ? { to } : {}),
      amount: amount.amount as string,
      ...(amount.portionBps !== undefined ? { portionBps: amount.portionBps } : {}),
      ...(step.recipient ? { recipient: step.recipient.v } : {}),
      ...(protocol ? { protocol } : {}),
      ...(vault ? { vault } : {}),
      ...(provider ? { provider } : {}),
      explicit: step.network?.by === "user" || (kind === "transfer" && (step.recipient?.v ?? "").includes(":")),
    });
    prevDest = kind === "bridge" ? (step.toNetwork?.v as NetworkKey) : network;
    prevOut = kind === "swap" || kind === "bridge" || kind === "stake" ? (to ?? from) : from;
  }
  // A goal that asks comes after every step before it was decided.
  if (questions.length === 0 && expansion && expansion.questions.length > 0) questions.push(...expansion.questions);
  if (questions.length === 0 && expansion?.blocked) throw expansion.blocked;
  return {
    questions: questions.slice(0, 2),
    assumptions: dedupe(assumptions),
    resolved: questions.length === 0 ? resolved : null,
    ...(expansion ? { layout: expansion.layout } : {}),
  };
}

function dedupe(list: Assumption[]): Assumption[] {
  const seen = new Set<string>();
  return list.filter((entry) => (seen.has(entry.id) ? false : (seen.add(entry.id), true)));
}
