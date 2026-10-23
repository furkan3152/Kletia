/**
 * The decision table: when the solver asks, and when it picks a route and
 * shows its choice as a chip. Purpose differences (what is spent, scope
 * across networks, staking or lending, who receives, how much) are asked;
 * means differences (venue, bridge, the network an asset is taken from when
 * costs differ) are chosen and shown with alternatives.
 *
 *   D0  no candidate                 refuse, or FUNDS_ELSEWHERE when funds sit elsewhere
 *   D1  recipient missing / nickname ask (never assumed)
 *   D2  amount above the balance     ask AMOUNT_EXCEEDS_BALANCE
 *   D3  candidates spend other assets pick the exposure-neutral one (chip), else ask INPUT_ASSET_MISSING
 *   D4  possessive scope on 2+ networks ask SCOPE_AMBIGUOUS
 *   D5  staking or lending           ask EARN_KIND
 *   D6  venue of one category        best risk-adjusted APY (chip); VENUE_MISSING only when no APY is known and tiers differ
 *   D7  same asset on several networks the cheaper source (chip)
 *   D8  bridge / venue (means)       chip, never asked (the auction picks the venue)
 *   D9  misspelt symbol              ask ASSET_TYPO
 *   D10 look-alike asset             the policy's ASSET_LOOKALIKE
 *   D11 dollar amount of a token     priced (chip), asked only without a usable price
 *   D12 role filled by word order    ask INTERPRETATION_CONFIRM
 *   D13 read by the LLM layer        ask INTERPRETATION_CONFIRM
 *   D14 otherwise                    ready, material chips first
 *
 * Pure: every function reads only its arguments.
 */
import { CHAINS, GOAL_LIMITS, type Goal, type NetworkKey, type ThreadAmount } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { defaultProvider } from "../clarify/catalog.js";
import { assumption, clip, question } from "../clarify/copy.js";
import { cmp, isDecimal, tidy } from "../clarify/decimal.js";
import { field } from "../clarify/edits.js";
import type { Assumption, Option, Question } from "../clarify/types.js";
import {
  amountLabel,
  apyLabel,
  clockLabel,
  costLabel,
  networkLabel,
  priceSourceLabel,
  protocolName,
  riskLabel,
  SOLVER_CODE_SOURCES,
  SOLVER_CODES,
  usdLabel,
} from "./explain.js";
import { sameAsset, type Route, type SearchSource } from "./search.js";
import type { SnapshotPrice } from "./snapshot.js";
import type { RankedStakeProvider } from "./yieldRank.js";

/** What a goal's typed words told the reader (transient notes; never stored). */
export interface GoalReadNotes {
  /** A role was filled by word order alone (D12). */
  readonly orderOnly?: boolean;
  /** "my USDC" with no amount (F8, D4). */
  readonly possessive?: boolean;
  /** An unknown symbol within one edit of listed ones (D9). */
  readonly typo?: { readonly side: "spend" | "want"; readonly raw: string; readonly candidates: readonly string[] };
}

/** Answers and chip changes pinned on a goal (thread memory; the clarify policy fills them). */
export interface GoalPins {
  /** Spend from this network only (an answer to D2 / D4 / FUNDS_ELSEWHERE, or a source chip change). */
  readonly source?: NetworkKey;
  /** D4 answered "all networks". */
  readonly scope?: "all";
  /** D5 answered. */
  readonly earnKind?: "staking" | "lending";
  /** D3 / D9 answered: spend this symbol. */
  readonly asset?: string;
  /** D6 answered or a venue chip changed: a YIELD_VENUES id. */
  readonly venue?: string;
  /** D12 / D13 answered "yes, plan it". */
  readonly confirmed?: boolean;
  /** D2 answered with an amount. */
  readonly amount?: ThreadAmount;
}

export type Choice =
  | { readonly kind: "route"; readonly route: Route; readonly assumptions: readonly Assumption[] }
  | { readonly kind: "ask"; readonly questions: readonly Question[] };

const option = (id: string, label: string, value: Option["value"], detail?: string): Option => ({
  id,
  label: clip(label, 48),
  ...(detail ? { detail: clip(detail, 96) } : {}),
  value,
});

const solverAssumption = (path: string, label: string, value: Option["value"], code: keyof typeof SOLVER_CODES, reason: string, alternatives: Option[], material: boolean): Assumption =>
  assumption(path, label, value, SOLVER_CODE_SOURCES[SOLVER_CODES[code]], reason, alternatives, material);

const symbolOf = (goal: Goal, side: "spend" | "want"): string | undefined => {
  const asset = goal[side].asset;
  return asset && "symbol" in asset ? asset.symbol : undefined;
};

/* ------------------------------------------------------------------ D1 */

/** D1: a delivery to a nickname or "my other wallet" is asked, never completed. Addresses and names go to the policy's recipient checks. */
export function recipientQuestion(goal: Goal, index: number): Question | null {
  if (goal.kind !== "deliver" && goal.holder.t === "self") return null;
  const what = symbolOf(goal, "spend") ?? symbolOf(goal, "want") ?? "it";
  switch (goal.holder.t) {
    case "nickname":
      return question(field(index, "recipient"), "address", "RECIPIENT_MISSING", `Who should receive the ${what}? Enter their address or full name (for example name.eth).`, "Kletia never guesses a recipient from a nickname.", [], true, "0x… or name.eth");
    case "selfOther":
      return question(field(index, "recipient"), "address", "RECIPIENT_MISSING", `Which of your wallets should receive the ${what}? Enter its address.`, "Kletia only knows the accounts of this request.", [], true, "0x… or name.eth");
    case "self":
      return goal.kind === "deliver"
        ? question(field(index, "recipient"), "address", "RECIPIENT_MISSING", `Who should receive the ${what}?`, "Enter an address or a name such as name.eth, name.base.eth or name.sns.", [], true, "0x… or name.eth")
        : null;
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ D9 */

/** D9: a misspelt symbol ("SLO") is asked: the corrected symbol (suggested when unique), or cancel. */
export function typoQuestion(notes: GoalReadNotes | undefined, index: number): Question | null {
  const typo = notes?.typo;
  if (!typo || typo.candidates.length === 0) return null;
  const raw = typo.raw.slice(0, 16);
  const options: Option[] = typo.candidates.slice(0, 6).map((symbol, i) => ({
    ...option(symbol, symbol, { asset: symbol }, "Listed by Kletia"),
    ...(i === 0 && typo.candidates.length === 1 ? { recommended: true as const } : {}),
  }));
  options.push(option("cancel", "Neither, cancel", { target: "cancel" }));
  return question(field(index, typo.side === "spend" ? "from" : "to"), "choice", "ASSET_TYPO", `Did you mean ${typo.candidates.slice(0, 3).join(" or ")}?`,
    `${raw} is not a token Kletia lists. To use an unlisted token deliberately, paste its address or mint.`, options, true);
}

/* ------------------------------------------------------------------ D2 */

/**
 * D2: an exact amount above every known balance of the sources. Options:
 * all of the largest holding, the funds on another network that cover it
 * (when the person named a network), or keep the amount as said.
 */
export function exceedsQuestion(input: {
  readonly index: number;
  readonly symbol: string;
  readonly need: string;
  readonly sources: readonly SearchSource[];
  readonly elsewhere: readonly SearchSource[];
}): Question | null {
  const known = input.sources.filter((source) => source.status === "known" && source.amount !== null && isDecimal(source.amount));
  if (known.length === 0 || known.length !== input.sources.length) return null;
  if (known.some((source) => cmp(source.amount as string, input.need) >= 0)) return null;
  const largest = [...known].sort((a, b) => cmp(b.amount as string, a.amount as string) || a.node.id.localeCompare(b.node.id))[0] as SearchSource;
  const held = tidy(largest.amount as string, 6);
  const network = largest.node.network;
  const options: Option[] = [];
  if (cmp(held, "0") > 0) {
    options.push(option("all", `All · ${held} ${input.symbol}`, { amount: { t: "balance", bps: 10_000 }, source: network }, CHAINS[network].nativeAsset.symbol === largest.node.symbol ? "Keeps a little for network fees" : `On ${networkLabel(network)}`));
  }
  for (const other of input.elsewhere.filter((source) => source.amount !== null && cmp(source.amount, input.need) >= 0).slice(0, 3)) {
    options.push(option(other.node.network, `Use funds on ${networkLabel(other.node.network)}`, { source: other.node.network }, `You hold ${tidy(other.amount as string, 6)} ${other.node.symbol} there`));
  }
  options.push(option("keep", `Keep ${amountLabel(input.need)} ${input.symbol}`, { amount: { t: "exact", value: input.need } }, "The plan will fail unless more arrives first"));
  return question(field(input.index, "amount"), "choice", "AMOUNT_EXCEEDS_BALANCE",
    `${amountLabel(input.need)} ${input.symbol} is more than you hold on ${networkLabel(network)}. How much should this use?`,
    `You hold ${held} ${input.symbol} there; Kletia checks the amount against your balance before planning.`, options, true, `Amount in ${input.symbol}`);
}

/* ------------------------------------------------------------------ D4 */

export type ScopeDecision =
  | { readonly kind: "ask"; readonly question: Question }
  | { readonly kind: "one"; readonly network: NetworkKey; readonly assumption?: Assumption }
  | { readonly kind: "all" };

/**
 * D4: a possessive scope ("my USDC") over holdings on several networks. Two
 * or more networks with at least `scopeShareBps` of the value: ask. One
 * network above the share: use it and say what stays.
 */
export function scopeDecision(input: { readonly index: number; readonly symbol: string; readonly sources: readonly SearchSource[]; readonly pinned?: "all" }): ScopeDecision {
  if (input.pinned === "all") return { kind: "all" };
  const byNetwork = new Map<NetworkKey, { usd: number; amount: number; sources: SearchSource[] }>();
  for (const source of input.sources) {
    if (source.status !== "known") continue;
    const entry = byNetwork.get(source.node.network) ?? { usd: 0, amount: 0, sources: [] };
    entry.usd += source.valueUsd ?? 0;
    entry.amount += Number(source.amount ?? "0");
    entry.sources.push(source);
    byNetwork.set(source.node.network, entry);
  }
  const networks = [...byNetwork.keys()];
  if (networks.length <= 1) return networks[0] ? { kind: "one", network: networks[0] } : { kind: "all" };
  const total = [...byNetwork.values()].reduce((sum, entry) => sum + entry.usd, 0);
  const share = (network: NetworkKey) => (total > 0 ? ((byNetwork.get(network)?.usd ?? 0) * 10_000) / total : 0);
  const ranked = networks.sort((a, b) => share(b) - share(a) || a.localeCompare(b));
  const major = ranked.filter((network) => share(network) >= GOAL_LIMITS.scopeShareBps);
  const amountOn = (network: NetworkKey) => amountLabel(String(byNetwork.get(network)?.amount ?? 0));
  if (major.length >= 2 || (major.length === 0 && total === 0)) {
    const sum = amountLabel(String([...byNetwork.values()].reduce((value, entry) => value + entry.amount, 0)));
    const options: Option[] = [
      option("all", `All ${sum} ${input.symbol} across ${ranked.length} networks`, { target: "all" }, ranked.map(networkLabel).join(", ")),
      ...ranked.slice(0, 7).map((network) => option(network, `Only ${networkLabel(network)}'s ${amountOn(network)} ${input.symbol}`, { source: network })),
    ];
    return {
      kind: "ask",
      question: question(field(input.index, "network"), "choice", "SCOPE_AMBIGUOUS", `Your ${input.symbol} ${/[a-z]s$/u.test(input.symbol) ? "are" : "is"} on ${ranked.map(networkLabel).join(", ")}. Which should this use?`,
        "Each network is moved separately; Kletia does not pick for you.", options, false),
    };
  }
  const chosen = major[0] ?? ranked[0] as NetworkKey;
  const rest = ranked.filter((network) => network !== chosen);
  return {
    kind: "one",
    network: chosen,
    assumption: solverAssumption(field(input.index, "network"), `Your ${amountOn(chosen)} ${input.symbol} on ${networkLabel(chosen)}`, { source: chosen }, "SOLVER_SCOPE",
      `Most of your ${input.symbol} is there; ${rest.map((network) => `${amountOn(network)} on ${networkLabel(network)}`).join(", ")} stays.`,
      rest.slice(0, 4).map((network) => option(network, `Use ${networkLabel(network)} instead`, { source: network })), true),
  };
}

/* ------------------------------------------------------------------ D11 */

/** D11: a dollar amount of a non-stable token, priced: the amount (decimal) and its chip, or null without a usable price. */
export function priceAmount(input: { readonly index: number; readonly usd: string; readonly symbol: string; readonly decimals: number; readonly price: SnapshotPrice | null }): { value: string; assumption: Assumption } | null {
  const price = input.price;
  if (!price || price.stale || !(price.usd > 0)) return null;
  const units = Number(input.usd) / price.usd;
  if (!Number.isFinite(units) || units <= 0) return null;
  const places = Math.min(input.decimals, 8);
  const value = amountLabel(floorTo(units, places));
  if (!/[1-9]/u.test(value)) return null;
  return {
    value,
    assumption: solverAssumption(field(input.index, "amount"), `$${amountLabel(input.usd)} ≈ ${value} ${input.symbol}`, { amount: { t: "exact", value } }, "SOLVER_TARGET_AMOUNT",
      `At ${usdLabel(price.usd)} per ${input.symbol} (${priceSourceLabel(price.source)}, ${clockLabel(price.at)}); the signed amount is in ${input.symbol}.`, [], true),
  };
}

/** A positive number as a decimal string with at most `places` decimals, rounded down. */
export function floorTo(value: number, places: number): string {
  const factor = 10 ** places;
  const scaled = Math.floor(value * factor + 1e-9);
  const whole = Math.floor(scaled / factor);
  const fraction = String(scaled - whole * factor).padStart(places, "0").replace(/0+$/u, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

/** A positive number as a decimal string with at most `places` decimals, rounded up. */
export function ceilTo(value: number, places: number): string {
  const factor = 10 ** places;
  const scaled = Math.ceil(value * factor - 1e-9);
  const whole = Math.floor(scaled / factor);
  const fraction = String(scaled - whole * factor).padStart(places, "0").replace(/0+$/u, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

/* ------------------------------------------------------- D0, D3, D5-D8 */

export interface ChooseInput {
  readonly goal: Goal;
  readonly index: number;
  /** Every route found, best first. */
  readonly routes: readonly Route[];
  readonly pins?: GoalPins;
  /** The person named the asset to spend (or answered D3 / D9). */
  readonly assetNamed: boolean;
  /** The person named the network to spend from (or answered D2 / D4). */
  readonly sourceNamed: boolean;
  /** The best staking provider whose 7-day rate was compared, per input asset; undefined: Kletia's default leads. */
  readonly bestStake?: (input: "SOL" | "ETH") => RankedStakeProvider | undefined;
}

function routeAssetLabel(route: Route): string {
  return `${route.source.node.symbol} on ${networkLabel(route.source.node.network)}`;
}

function venueName(route: Route): string {
  const last = route.hops[route.hops.length - 1];
  if (last?.provider) return `${last.provider.grammarProvider} (${last.provider.symbol})`;
  if (last?.venue) return `${protocolName(last.venue.protocol)} ${last.venue.name.includes(protocolName(last.venue.protocol)) ? "" : last.venue.name}`.trim();
  return route.landing.symbol;
}

/** The venue name of an earn route ("Aave V3", "Jito (JitoSOL)"). */
export function earnVenueLabel(route: Route): string {
  const last = route.hops[route.hops.length - 1];
  if (last?.provider) return `${last.provider.grammarProvider} (${last.provider.symbol})`;
  if (last?.venue) return last.venue.name;
  return venueName(route);
}

/** The risk tier of an earn route's venue (its last hop), not of the bridge that reaches it. */
const venueRisk = (route: Route) => route.hops[route.hops.length - 1]?.edge.risk ?? route.risk;

/** The best route per distinct value of `key`, in route order. */
function bestBy(routes: readonly Route[], key: (route: Route) => string): Route[] {
  const seen = new Set<string>();
  const out: Route[] = [];
  for (const route of routes) {
    const value = key(route);
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(route);
  }
  return out;
}

const isEarn = (goal: Goal) => goal.kind === "earn" || goal.want.at?.custody.kind === "venue";

function earnCategoryNamed(goal: Goal, pins: GoalPins | undefined): "staking" | "lending" | undefined {
  if (pins?.earnKind) return pins.earnKind;
  if (goal.op === "stake") return "staking";
  if (goal.op === "deposit") return "lending";
  const custody = goal.want.at?.custody;
  if (custody?.kind === "venue") {
    if (custody.category === "staking") return "staking";
    if (custody.category === "lending" || custody.protocol || custody.vault) return "lending";
  }
  return undefined;
}

/**
 * Picks a route among the candidates, or asks (D3, D5, D6). The routes are
 * those the search found (best first); an empty list is the caller's D0.
 */
export function chooseRoute(input: ChooseInput): Choice {
  const { goal, index, pins } = input;
  let routes = [...input.routes];
  const assumptions: Assumption[] = [];
  const at = (name: string) => field(index, name);

  // D5: staking or lending, when the person said neither.
  if (isEarn(goal)) {
    const named = earnCategoryNamed(goal, pins);
    if (named) routes = routes.filter((route) => route.category === named);
    const categories = new Set(routes.map((route) => route.category));
    if (!named && categories.has("staking") && categories.has("lending")) {
      const staking = routes.filter((route) => route.category === "staking");
      const input = staking[0]?.hops.find((hop) => hop.provider)?.provider?.input;
      const stake = (input ? staking.find((route) => route.hops.some((hop) => hop.provider?.id === defaultProvider(input).id)) : undefined) ?? (staking[0] as Route);
      const lend = routes.find((route) => route.category === "lending") as Route;
      const stakeProvider = stake.hops.find((hop) => hop.provider)?.provider;
      const lendVenue = lend.hops[lend.hops.length - 1]?.venue;
      const options: Option[] = [
        option("stake", `Stake for ${stakeProvider?.symbol ?? stake.landing.symbol}`, { kind: "stake", ...(stakeProvider ? { provider: stakeProvider.id } : {}) }, `${earnVenueLabel(stake)} · ${riskLabel(stake.risk)}`),
        option("lend", `Lend on ${lendVenue ? protocolName(lendVenue.protocol) : earnVenueLabel(lend)}`, { kind: "deposit", ...(lendVenue ? { protocol: lendVenue.protocol, venue: lendVenue.slug } : {}) }, `${apyLabel(lend.apy)} · ${riskLabel(lend.risk)}`),
      ];
      const symbol = stake.source.node.symbol;
      return { kind: "ask", questions: [question(at("kind"), "choice", "EARN_KIND", `How should your ${symbol} earn: staked, or lent out?`, "Staking and lending carry different risks and lock-ups; Kletia does not pick for you.", options, false)] };
    }
  }
  if (routes.length === 0) return { kind: "ask", questions: [] };

  // D3: the candidates spend different assets and the person named none.
  if (!input.assetNamed && !goal.spend.asset) {
    const perAsset = bestBy(routes, (route) => route.source.node.symbol.toUpperCase());
    if (perAsset.length > 1) {
      // Exposure-neutral: the route moves the asset that is wanted (no swap).
      const neutral = routes.filter((route) => {
        const last = route.hops[route.hops.length - 1];
        return last !== undefined && sameAsset(route.source.node, last.to);
      });
      if (neutral.length > 0) {
        const chosen = neutral[0] as Route;
        const others = perAsset.filter((route) => !sameAsset(route.source.node, chosen.source.node));
        assumptions.push(solverAssumption(at("from"), `Pays with ${routeAssetLabel(chosen)}`, { asset: chosen.source.node.symbol, source: chosen.source.node.network }, "SOLVER_SOURCE",
          `Moving the same asset keeps your exposure; no swap is needed.`,
          others.slice(0, 4).map((route) => option(`${route.source.node.network}:${route.source.node.symbol}`, `Pay with ${routeAssetLabel(route)}`, { asset: route.source.node.symbol, source: route.source.node.network }, costLabel(route.valueInUsd === null ? null : route.feesUsd, route.seconds))), true));
        routes = [chosen, ...routes.filter((route) => route !== chosen)];
        return finishChoice(input, routes, assumptions);
      }
      const options = perAsset.slice(0, 8).map((route) => option(`${route.source.node.network}:${route.source.node.symbol}`, `Pay with ${routeAssetLabel(route)}`, { asset: route.source.node.symbol, source: route.source.node.network },
        route.source.amount !== null ? `You hold ${amountLabel(route.source.amount)}; ${costLabel(route.valueInUsd === null ? null : route.feesUsd, route.seconds)}` : costLabel(null, route.seconds)));
      const target = routes[0]?.hops[routes[0].hops.length - 1]?.to;
      const wanted = symbolOf(goal, "want") ?? (target ? `${target.symbol} on ${networkLabel(target.network)}` : "it");
      return { kind: "ask", questions: [question(at("from"), "choice", "INPUT_ASSET_MISSING", `Which holding should pay for the ${wanted}?`, "Paying with another asset swaps it; Kletia does not choose what you sell.", options, false)] };
    }
  }
  return finishChoice(input, routes, assumptions);
}

/** D6, D7, D8 on the remaining routes (one category, one spent asset). */
function finishChoice(input: ChooseInput, routes: readonly Route[], assumptions: Assumption[]): Choice {
  const { goal, index, pins } = input;
  const at = (name: string) => field(index, name);
  let pool = [...routes];
  // D6: earn venues. Extended-tier venues only when named; a pinned venue wins.
  const lending = pool.filter((route) => route.category === "lending");
  if (lending.length > 0 && lending.length === pool.length) {
    const named = goal.want.at?.custody.kind === "venue" && (goal.want.at.custody.protocol !== undefined || goal.want.at.custody.vault !== undefined);
    if (pins?.venue) pool = pool.filter((route) => route.venueId === pins.venue);
    else if (!named) {
      const vetted = pool.filter((route) => ["core", "curated", "testnet"].includes(venueRisk(route)));
      if (vetted.length > 0) pool = vetted;
    }
    if (pool.length === 0) return { kind: "ask", questions: [] };
    const venues = bestBy(pool, (route) => route.venueId ?? route.id);
    const top = venues.slice(0, GOAL_LIMITS.candidates);
    if (!pins?.venue && top.length > 1 && top.every((route) => route.apy === null) && new Set(top.map(venueRisk)).size > 1) {
      const options = venues.slice(0, 8).map((route, i) => {
        const venue = route.hops[route.hops.length - 1]?.venue;
        return { ...option(venue?.id ?? route.id, venue ? protocolName(venue.protocol) : earnVenueLabel(route), { ...(venue ? { protocol: venue.protocol, venue: venue.slug } : {}) }, `${venue?.name ?? ""} · ${riskLabel(venueRisk(route))} · APY unavailable`.replace(/^ · /u, "")), ...(i === 0 ? { recommended: true as const } : {}) };
      });
      const symbol = pool[0]!.source.node.symbol;
      return { kind: "ask", questions: [question(field(index + Math.max(0, pool[0]!.hops.length - 1), "protocol"), "choice", "VENUE_MISSING", `Where should your ${symbol} earn yield on ${networkLabel(pool[0]!.landing.network)}?`, "Rates could not be read right now, and these venues carry different risks.", options, false)] };
    }
    const chosen = pool[0] as Route;
    const step = Math.max(0, chosen.hops.length - 1);
    const alternatives = venues.filter((route) => route !== chosen).slice(0, 4).map((route) => {
      const venue = route.hops[route.hops.length - 1]?.venue;
      return option(venue?.id ?? route.id, `${earnVenueLabel(route)} · ${apyLabel(route.apy)}`, { ...(venue ? { protocol: venue.protocol, venue: venue.slug } : {}) }, riskLabel(venueRisk(route)));
    });
    const pinnedOrNamed = pins?.venue !== undefined || (goal.want.at?.custody.kind === "venue" && goal.want.at.custody.vault !== undefined);
    if (!pinnedOrNamed) {
      const venue = chosen.hops[step]?.venue;
      assumptions.push(solverAssumption(field(index + step, "protocol"), `${earnVenueLabel(chosen)} · ${apyLabel(chosen.apy)}`, venue ? { venue: venue.slug, protocol: venue.protocol } : {}, "SOLVER_VENUE_APY",
        chosen.apy === null ? `Kletia's default venue (${riskLabel(venueRisk(chosen))}); rates could not be read right now.` : `The best rate for its risk (${riskLabel(venueRisk(chosen))}); rates are variable.`, alternatives, true));
    }
    pool = [chosen, ...pool.filter((route) => route !== chosen)];
  }
  // Staking: the provider is a means. The best compared 7-day rate net of the risk allowance leads;
  // without readings Kletia's default provider for the asset leads; shown.
  let rated: RankedStakeProvider | undefined;
  if (pool[0]?.category === "staking") {
    // A class wanted ("eth staking exposure") names no token: the provider stays Kletia's choice, shown.
    const named = (goal.want.asset !== undefined && "symbol" in goal.want.asset) || (goal.want.at?.custody.kind === "venue" && goal.want.at.custody.protocol !== undefined);
    const stakeInput = pool[0].hops.find((hop) => hop.provider)?.provider?.input;
    const best = stakeInput && !named ? input.bestStake?.(stakeInput) : undefined;
    rated = best && pool.some((route) => route.category === "staking" && route.hops.some((hop) => hop.provider?.id === best.provider)) ? best : undefined;
    const fallback = rated?.provider ?? (stakeInput ? defaultProvider(stakeInput).id : undefined);
    const preferred = !named ? pool.find((route) => route.category === "staking" && route.hops.some((hop) => hop.provider?.id === fallback)) : undefined;
    if (preferred && preferred !== pool[0]) pool = [preferred, ...pool.filter((route) => route !== preferred)];
  }
  const staking = pool[0]?.category === "staking" ? pool[0] : undefined;
  if (staking) {
    const step = staking.hops.findIndex((hop) => hop.provider);
    const provider = staking.hops[step]?.provider;
    const named = (goal.want.asset !== undefined && "symbol" in goal.want.asset) || (goal.want.at?.custody.kind === "venue" && goal.want.at.custody.protocol !== undefined);
    if (provider && !named) {
      const others = bestBy(pool.filter((route) => route.category === "staking"), (route) => route.hops.find((hop) => hop.provider)?.provider?.id ?? "").filter((route) => route !== staking);
      const byRate = rated?.provider === provider.id;
      assumptions.push(solverAssumption(field(index + step, "provider"), `${provider.grammarProvider} (${provider.symbol})${byRate ? ` · ${apyLabel(rated?.apy)} (7-day)` : ""}`, { provider: provider.id }, "SOLVER_VENUE_APY",
        byRate ? `The best 7-day staking rate for its risk (${riskLabel(staking.risk)}) among the providers Kletia compared; rates are variable.` : `Kletia's default liquid staking provider for ${provider.input} (${riskLabel(staking.risk)}).`,
        others.slice(0, 4).map((route) => {
          const other = route.hops.find((hop) => hop.provider)?.provider;
          return option(other?.id ?? route.id, other ? `${other.grammarProvider} (${other.symbol})` : earnVenueLabel(route), { ...(other ? { provider: other.id } : {}) }, riskLabel(route.risk));
        }), true));
    }
  }
  const chosen = pool[0] as Route;
  // D3 with one asset able to pay: another asset than the one wanted is spent (a swap); shown, material.
  const lastHop = chosen.hops[chosen.hops.length - 1];
  if (!input.assetNamed && !goal.spend.asset && lastHop && !sameAsset(chosen.source.node, lastHop.to) && !assumptions.some((entry) => entry.field === at("from"))) {
    assumptions.push(solverAssumption(at("from"), `Pays with ${routeAssetLabel(chosen)}`, { asset: chosen.source.node.symbol, source: chosen.source.node.network }, "SOLVER_SOURCE",
      `The only holding that covers this; it is swapped into ${lastHop.to.symbol}.`, [], true));
  }
  // D7: the same asset is held on several networks: the cheaper source, shown.
  if (!input.sourceNamed && chosen.hops.length > 0) {
    const others = bestBy(pool.filter((route) => sameAsset(route.source.node, chosen.source.node) && route.source.node.network !== chosen.source.node.network), (route) => route.source.node.network);
    if (others.length > 0) {
      assumptions.push(solverAssumption(at("network"), `From ${networkLabel(chosen.source.node.network)}`, { source: chosen.source.node.network }, "SOLVER_SOURCE",
        `${chosen.source.amount !== null ? `You hold ${amountLabel(chosen.source.amount)} ${chosen.source.node.symbol} there; ` : ""}${costLabel(chosen.valueInUsd === null ? null : chosen.feesUsd, chosen.seconds)}.`,
        others.slice(0, 4).map((route) => option(route.source.node.network, `From ${networkLabel(route.source.node.network)}`, { source: route.source.node.network }, costLabel(route.valueInUsd === null ? null : route.feesUsd, route.seconds))), true));
    }
  }
  // D8: a bridge the person did not ask for: shown, never asked; the auction picks the venue.
  const bridges = chosen.hops.map((hop, step) => ({ hop, step })).filter(({ hop }) => hop.edge.kind === "bridge");
  const saidBoth = goal.spend.from?.network !== undefined && goal.want.at?.network !== undefined;
  for (const { hop, step } of bridges) {
    if (goal.op === "bridge" && saidBoth) continue;
    // One abstract crossing leg: the planner compares its shapes (one-shot, via a carrier) with live quotes.
    const converts = hop.to.symbol.toUpperCase() !== hop.from.symbol.toUpperCase();
    assumptions.push(solverAssumption(field(index + step, "toNetwork"), `Bridges ${networkLabel(hop.edge.network)} to ${networkLabel(hop.edge.destinationNetwork)}${converts ? ` as ${hop.to.symbol}` : ""}`, { network: hop.edge.destinationNetwork }, "SOLVER_BRIDGE",
      `Route picked by live quotes at planning; ${costLabel(chosen.valueInUsd === null ? null : hop.feesUsd + hop.gasUsd, hop.seconds)}.`, [], !saidBoth));
  }
  return { kind: "route", route: chosen, assumptions };
}

/* ------------------------------------------------------------------ D0 */

/** D0 with funds elsewhere: the networks whose holdings could run the goal. */
export function fundsElsewhereQuestion(input: { readonly index: number; readonly symbol: string; readonly from: NetworkKey | undefined; readonly routes: readonly Route[] }): Question | null {
  const networks = bestBy(input.routes, (route) => route.source.node.network);
  if (networks.length === 0) return null;
  const options = networks.slice(0, 8).map((route, i) => ({
    ...option(route.source.node.network, `Use ${route.source.node.symbol} on ${networkLabel(route.source.node.network)}`, { source: route.source.node.network },
      route.source.amount !== null ? `You hold ${amountLabel(route.source.amount)}` : undefined),
    ...(i === 0 ? { recommended: true as const } : {}),
  }));
  const where = input.from ? ` on ${networkLabel(input.from)}` : "";
  return question(field(input.index, "network"), networks.length === 1 ? "confirm" : "choice", "FUNDS_ELSEWHERE", `Your ${input.symbol}${where} cannot do this. Use funds from another network?`,
    "Kletia moves them first; that adds a bridge.", options, false);
}

/**
 * The money must cross to a network the person said (or the
 * recipient implies) from one they did not name: asked which holding pays,
 * one option per source network that can, never a chip. A choice, not a
 * one-click confirm, even with one source: where money comes from is purpose.
 */
export function crossingSourceQuestion(input: { readonly index: number; readonly symbol: string; readonly to: NetworkKey; readonly routes: readonly Route[] }): Question | null {
  // One option per holding (asset and network), the holdings of the asset that lands first (exposure-neutral, D3),
  // then in route order; each option pins the holding its label names, so the answer plans exactly that source.
  const same = (route: Route) => route.source.node.symbol.toUpperCase() === route.landing.symbol.toUpperCase();
  const ranked = [...input.routes.filter(same), ...input.routes.filter((route) => !same(route))];
  const holdings = bestBy(ranked, (route) => `${route.source.node.network}:${route.source.node.symbol.toUpperCase()}`);
  if (holdings.length === 0) return null;
  const options = holdings.slice(0, 8).map((route) =>
    option(`${route.source.node.network}:${route.source.node.symbol}`, `Use ${route.source.node.symbol} on ${networkLabel(route.source.node.network)}`, { source: route.source.node.network, asset: route.source.node.symbol },
      route.source.amount !== null ? `You hold ${amountLabel(route.source.amount)}; a bridge moves it to ${networkLabel(input.to)}` : `A bridge moves it to ${networkLabel(input.to)}`));
  return question(field(input.index, "network"), "choice", "FUNDS_ELSEWHERE", `Where should the ${input.symbol} for ${networkLabel(input.to)} come from?`,
    "Kletia never moves money from a network you did not name without asking.", options, false);
}

/** D0 without funds anywhere: the refusal, with the closest sentence Kletia can plan. */
export function noRouteError(goal: Goal): PlatformError {
  const asset = symbolOf(goal, "spend") ?? symbolOf(goal, "want") ?? "USDC";
  const network = goal.want.at?.network ?? goal.spend.from?.network ?? "base";
  const closest: Record<Goal["kind"], string> = {
    convert: `swap 10 ${asset === "USDC" ? "USDT" : asset} to ${symbolOf(goal, "want") ?? "USDC"} on ${network}`,
    relocate: `bridge 10 ${asset} from ${network === "base" ? "arbitrum" : "base"} to ${network}`,
    deliver: `send 10 ${asset} to name.eth on ${network}`,
    earn: `deposit 10 ${asset} into aave on ${network}`,
    exit: `withdraw all ${asset} from aave on ${network}`,
    acquire: `swap 10 USDC to ${asset} on ${network}`,
    consolidate: `bridge all ${asset} from ${network === "arbitrum" ? "base" : "arbitrum"} to ${network}`,
    rebalance: `bridge half my ${asset} from base to arbitrum`,
    fuel: `bridge 0.001 ETH from base to ${network}`,
    contract: `deposit 10 ${asset} into <contract alias> on ${network}`,
  };
  return new PlatformError("INTENT_UNSUPPORTED", clip(`Kletia found no route for this with your holdings. Try a sentence such as "${closest[goal.kind]}".`, 200), 422, [{ path: "text", message: "No route." }]);
}

/* -------------------------------------------------------------- D12, D13 */

/** A route in a few words ("Bridge 20 USDC from Arbitrum to Base, then deposit it into Morpho"). */
export function describeRoute(route: Route, amount: string | undefined): string {
  const parts = route.hops.map((hop, step) => {
    const what = step === 0 ? `${amount ? `${amountLabel(amount)} ` : ""}${hop.from.symbol}` : "it";
    switch (hop.edge.kind) {
      case "swap":
        return `swap ${what} to ${hop.to.symbol} on ${networkLabel(hop.edge.network)}`;
      case "bridge":
        return `bridge ${what} from ${networkLabel(hop.edge.network)} to ${networkLabel(hop.edge.destinationNetwork)}${hop.to.symbol !== hop.from.symbol ? ` as ${hop.to.symbol}` : ""}`;
      case "stake":
        return `stake ${what} with ${hop.provider?.grammarProvider ?? "a staking provider"}`;
      case "deposit":
        return `deposit ${what} into ${hop.venue ? protocolName(hop.venue.protocol) : "a venue"} on ${networkLabel(hop.edge.network)}`;
      case "withdraw":
        return `withdraw ${step === 0 && amount ? what : `all ${hop.to.symbol}`} from ${hop.venue ? protocolName(hop.venue.protocol) : "the venue"} on ${networkLabel(hop.edge.network)}`;
      case "transfer":
        return `send ${what} on ${networkLabel(hop.edge.network)}`;
    }
  });
  const text = parts.join(", then ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** D12 / D13: a reading to confirm before planning (word order only, or the LLM layer). */
export function confirmQuestion(input: { readonly goal: Goal; readonly notes?: GoalReadNotes; readonly pins?: GoalPins; readonly index: number; readonly summary: string }): Question | null {
  if (input.pins?.confirmed) return null;
  const llm = input.goal.confidence === "llm";
  if (!llm && !input.notes?.orderOnly) return null;
  return question(field(input.index, "kind"), "confirm", "INTERPRETATION_CONFIRM", `${input.summary}. Is that what you meant?`,
    llm ? "Model-assisted reading. Kletia plans it only when you confirm." : "Kletia read part of this from word order alone.",
    [option("confirm", "Yes, plan it", { target: "confirm" })], true);
}
