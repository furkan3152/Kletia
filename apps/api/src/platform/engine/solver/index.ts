/**
 * The Goal solver: `solveGoals(goals, snapshot, ctx)`
 * turns Goals the reader could not lower into ordinary clarify steps,
 * chips and questions.
 *
 *   for each goal, in order:
 *     D9 typo, D1 recipient          asked before anything is searched
 *     sources                        holdings (or positions, or the previous goal's landing)
 *     D2 amount above the balance    asked
 *     D4 possessive scope            asked, or one network (chip), or every network
 *     search (search.ts)             beam search over the capability graph, ranked
 *     D0, D3, D5-D8 (decide.ts)      refuse / ask / pick and show
 *     amounts                        said, priced (D11) or back-solved for a target
 *     expansion (expand.ts)          WorkStep[] with provenance
 *     D12 / D13                      confirm a reading from word order or the LLM layer
 *
 * Abstract goals: rebalance targets, dust sweeps, exit-all,
 * atLeast top-ups, exact deliveries, exposure classes, USD targets and the
 * receiving network of a payment asked with each network's cost; every move
 * Kletia computes for them is confirmed with the moves listed, and more moves
 * than one plan holds are asked or refused, never cut.
 *
 * Goals after the first one that asks are left pending (the policy asks at
 * most two questions a turn). Pure and synchronous over the snapshot read
 * for this turn (snapshot.ts) and the capability graph; nothing is read,
 * signed or sent here. A goal no route can serve throws PlatformError (D0),
 * like the policy does for what no question can fix.
 */
import {
  ASSET_CLASSES,
  CHAINS,
  CLARIFY_LIMITS,
  EXPOSURE_ASSET_CLASSES,
  GOAL_LIMITS,
  isNetworkKey,
  NATIVE_FEE_RESERVE,
  protocolTier,
  THREAD_LIMITS,
  type AssetClass,
  type AssetSel,
  type ExposureAssetClass,
  type Goal,
  type GoalTargets,
  type NetworkKey,
  type ThreadAmount,
} from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { BRIDGE_NETWORKS, hasAccount, isUsdWord, lane, laneOf, LOOKALIKES, NETWORK_ORDER, recipientFamily, SWAP_NETWORKS, symbolsOn, transferOnly, USD_ORDER } from "../clarify/catalog.js";
import { planTooLarge } from "../routing/caps.js";
import { assumption, clip, question } from "../clarify/copy.js";
import { cmp, isDecimal, isPositive, parseDecimal, portion, sub, formatDecimal } from "../clarify/decimal.js";
import { field } from "../clarify/edits.js";
import type { Assumption, Option, Question, Slot, WorkStep } from "../clarify/types.js";
import type { GoalNotes } from "../goal/frames.js";
import { EXACT_DELIVERY_PLANNED } from "./moves.js";
import { homeNetworks, overCaps, planSize, planTooLargeQuestion, rebalancePlan, splitLabel, type RebalanceBucket } from "./abstract.js";
import type { EdgeKind } from "./costs.js";
import { bestRatedStake, comparableApy, stakeProvidersOf } from "./yieldRank.js";
import {
  ceilTo,
  chooseRoute,
  confirmQuestion,
  crossingSourceQuestion,
  describeRoute,
  exceedsQuestion,
  fundsElsewhereQuestion,
  noRouteError,
  priceAmount,
  recipientQuestion,
  scopeDecision,
  typoQuestion,
  type GoalPins,
  type GoalReadNotes,
} from "./decide.js";
import { expandRoute } from "./expand.js";
import { amountLabel, apyLabel, costLabel, networkLabel, protocolName, SOLVER_CODES, solverWhy, usdLabel } from "./explain.js";
import { capabilityGraph, nodeMatchesAsset, nodeMatchesCustody, walletNodeId, type CapabilityGraph, type GraphNode } from "./graph.js";
import { landingOf, RANKING, sameAsset, searchRoutes, stakeProviderFor, type Landing, type Route, type SearchSource, type SearchSpec } from "./search.js";
import { usablePrice, type Snapshot, type SnapshotHolding } from "./snapshot.js";

export { SOLVER_CODES, solverWhy } from "./explain.js";
export type { GoalPins, GoalReadNotes } from "./decide.js";
export { pickCandidates, searchRoutes, type Dimension, type Landing, type Route, type RouteHop, type SearchSource, type SearchSpec } from "./search.js";
export { expandRoute } from "./expand.js";

/* ------------------------------------------------------------------ types */

export interface SolveContext {
  /** The request's accounts (a step needs one of its network's family). */
  readonly accounts: readonly string[];
  /** The action index of the first step these goals expand into (default 0). */
  readonly index?: number;
  /** Per goal: what the reader noted (order-only roles, possessive scope, typos). */
  readonly reads?: readonly (GoalReadNotes | undefined)[];
  /** Per goal: answers and chip changes from earlier turns. */
  readonly pins?: readonly (GoalPins | undefined)[];
  /** The capability graph (default: the active adapters' memoised graph). */
  readonly graph?: CapabilityGraph;
  /** Live gas prices (wei) per EVM network, when the caller read them (ranking only). */
  readonly gasPriceWei?: Readonly<Partial<Record<NetworkKey, bigint>>>;
}

export type GoalStatus = "ready" | "ask" | "pending";

export interface GoalOutcome {
  /** The goal's index in the list. */
  readonly goal: number;
  readonly status: GoalStatus;
  /** The expanded steps (ready; also kept for a confirm question, D12/D13). */
  readonly steps: readonly WorkStep[];
  /** The chosen route (one, or one per source for consolidate / all-networks scope). */
  readonly routes: readonly Route[];
  /** Where the money lands after each step. */
  readonly landings: readonly Landing[];
  readonly questions: readonly Question[];
  readonly assumptions: readonly Assumption[];
}

export interface SolveResult {
  /** Steps of the goals that are ready, in order, up to the first goal that asks. */
  readonly steps: readonly WorkStep[];
  /** Chips of those goals, material first. */
  readonly assumptions: readonly Assumption[];
  /** At most two questions, of the first goal that asks. */
  readonly questions: readonly Question[];
  readonly outcomes: readonly GoalOutcome[];
}

/** The decision-table notes of a goal the frames read (orderOnly D12, possessive D4, typo D9). */
export function readNotesOf(read: { readonly notes: Pick<GoalNotes, "orderOnly" | "possessive" | "typo"> }): GoalReadNotes {
  return {
    ...(read.notes.orderOnly ? { orderOnly: true } : {}),
    ...(read.notes.possessive ? { possessive: true } : {}),
    ...(read.notes.typo ? { typo: read.notes.typo } : {}),
  };
}

/* ---------------------------------------------------------------- helpers */

const MAX_QUESTIONS = 2;
const upper = (value: string) => value.trim().toUpperCase();
const symbolOf = (asset: AssetSel | undefined): string | undefined => (asset && "symbol" in asset ? asset.symbol : undefined);
const isStableSymbol = (symbol: string) => USD_ORDER.includes(upper(symbol)) || isUsdWord(symbol);
const user = <T>(v: T): Slot<T> => ({ v, by: "user" });

interface GoalEnv {
  readonly goal: Goal;
  readonly position: number;
  /** Action index of this goal's first step. */
  readonly index: number;
  readonly notes?: GoalReadNotes;
  readonly pins?: GoalPins;
  readonly snapshot: Snapshot;
  readonly graph: CapabilityGraph;
  readonly ctx: SolveContext;
  /** The landing of the goal this one spends from (chain / "it"). */
  readonly previous?: { readonly route: Route; readonly outcome: GoalOutcome };
}

type Step =
  | { readonly kind: "ask"; readonly questions: readonly Question[]; readonly steps?: readonly WorkStep[]; readonly routes?: readonly Route[] }
  | { readonly kind: "ready"; readonly steps: readonly WorkStep[]; readonly routes: readonly Route[]; readonly assumptions: readonly Assumption[] };

const ask = (...questions: (Question | null)[]): Step => ({ kind: "ask", questions: questions.filter((entry): entry is Question => entry !== null) });

function priceOf(snapshot: Snapshot, node: GraphNode): number | null {
  const price = usablePrice(snapshot, node.asset);
  if (price) return price.usd;
  return isStableSymbol(node.symbol) && node.category === "stablecoin" ? 1 : null;
}

function accountLane(accounts: readonly string[]): "mainnet" | "testnet" {
  return laneOf(accounts);
}

/** The networks the person can receive on for a recipient (its address family, or Base for a .base.eth name). */
function recipientNetworks(goal: Goal, accounts: readonly string[]): NetworkKey[] | null {
  const holder = goal.holder;
  if (holder.t !== "address" && holder.t !== "name") return null;
  if (/\.base\.eth$/iu.test(holder.value)) return ["base"];
  const kind = recipientFamily(holder.value);
  const current = accountLane(accounts);
  if (kind === "caip") {
    const chain = Object.values(CHAINS).find((entry) => holder.value.startsWith(`${entry.id}:`));
    return chain ? [chain.key as NetworkKey] : [];
  }
  return NETWORK_ORDER.filter((network) => lane(network) === current && (!kind || CHAINS[network].namespace === kind));
}

/** "stablecoins", "ETH", "gas tokens" for an asset class. */
function classLabel(asset: AssetSel | undefined): string | undefined {
  if (!asset || !("class" in asset)) return undefined;
  const cls = asset.class as AssetClass | ExposureAssetClass;
  switch (cls) {
    case "eth-lst":
      return "liquid staked ETH";
    case "sol-lst":
      return "liquid staked SOL";
    case "btc":
      return "BTC";
    case "usd-stable":
    case "any-stable":
      return "stablecoins";
    case "eth":
      return "ETH";
    case "sol":
      return "SOL";
    case "gas":
      return "gas tokens";
  }
}

/* ------------------------------------------------------------- problems */

interface Problem {
  readonly kinds: ReadonlySet<EdgeKind>;
  readonly isTarget: (node: GraphNode, source: SearchSource) => boolean;
  readonly finalTransfer?: boolean;
  readonly allowBridge?: boolean;
  /** Source nodes that already satisfy the goal are not sources (acquire, relocate, fuel, consolidate). */
  readonly excludeSatisfied: boolean;
  /** Where the goal lands when the problem decided it (acquire, fuel, a convert with one home network). */
  readonly where?: NetworkKey;
}

/** The same exposure: the same asset, or the same group (native ETH into a WETH venue). */
function sameExposure(node: GraphNode, source: GraphNode): boolean {
  return sameAsset(node, source) || (node.group !== undefined && node.group === source.group);
}

function earnCategories(goal: Goal, pins: GoalPins | undefined): { lending: boolean; staking: boolean } {
  if (pins?.earnKind) return { lending: pins.earnKind === "lending", staking: pins.earnKind === "staking" };
  if (goal.op === "stake") return { lending: false, staking: true };
  if (goal.op === "deposit") return { lending: true, staking: false };
  const custody = goal.want.at?.custody;
  if (custody?.kind === "venue") {
    if (custody.category === "staking") return { lending: false, staking: true };
    if (custody.category === "lending" || custody.vault) return { lending: true, staking: false };
    if (custody.protocol) {
      const staking = stakeProviderIds().has(custody.protocol);
      return { lending: !staking, staking };
    }
  }
  return { lending: true, staking: true };
}

let providerIds: Set<string> | null = null;
function stakeProviderIds(): Set<string> {
  if (!providerIds) {
    providerIds = new Set<string>();
    for (const node of capabilityGraph().nodes.values()) {
      const provider = stakeProviderFor(node);
      if (provider) providerIds.add(provider.id);
    }
  }
  return providerIds;
}

function destinationQuestion(env: GoalEnv, what: string): Question {
  const current = accountLane(env.ctx.accounts);
  const networks = BRIDGE_NETWORKS.filter((network) => lane(network) === current && hasAccount(env.ctx.accounts, network));
  return question(field(env.index, "toNetwork"), "choice", "DESTINATION_MISSING", `Which network should the ${what} arrive on?`, "The destination is where the money arrives.",
    networks.slice(0, 8).map((network) => ({ id: network, label: networkLabel(network), value: { network } })), true);
}

function outputQuestion(env: GoalEnv): Question {
  const network = env.goal.want.at?.network ?? env.goal.spend.from?.network ?? "base";
  const options = symbolsOn(network).filter((symbol) => !transferOnly(network, symbol)).slice(0, 5).map((symbol) => ({ id: symbol, label: symbol, value: { asset: symbol } }));
  return question(field(env.index, "to"), "choice", "OUTPUT_ASSET_MISSING", "Which token should you end up with?", "Name the token you want to receive.", options, true);
}

/** The route problem of a goal, or a question for a gap no route can fill. */
function problemFor(env: GoalEnv): Problem | Question {
  const { goal, pins } = env;
  const want = goal.want.asset;
  const network = goal.want.at?.network;
  const custody = goal.want.at?.custody;
  const k = (...kinds: EdgeKind[]) => new Set<EdgeKind>(kinds);
  const from = pins?.source ?? goal.spend.from?.network;
  switch (goal.kind) {
    case "convert": {
      if (!want) return outputQuestion(env);
      // "Convert on the home network": with no network said for what is wanted, it lands where the money is
      // when that network lists it, else on the networks that list it (SOL: Solana); several of those are asked.
      const homes = network ? [network] : homeNetworks({ from, listed: listedNetworks(env, want) });
      if (!network && from && homes.length > 1) return destinationQuestion(env, symbolOf(want) ?? classLabel(want) ?? "money");
      const crossing = network ? from !== undefined && from !== network : from !== undefined && !homes.includes(from);
      const swapOnly = goal.op === "swap" && !crossing;
      return {
        kinds: k("swap", "bridge", "stake"),
        isTarget: (node, source) => {
          if (node.custody.kind !== "wallet" || !nodeMatchesAsset(node, want) || sameAsset(node, source.node)) return false;
          if (network) return node.network === network;
          const here = homeNetworks({ from: source.node.network, listed: homes });
          return here.length > 0 ? here.includes(node.network) : homes.includes(node.network);
        },
        allowBridge: !swapOnly,
        excludeSatisfied: false,
        ...(homes.length === 1 ? { where: homes[0] } : {}),
      };
    }
    case "relocate":
    case "consolidate":
      if (!network) return destinationQuestion(env, symbolOf(goal.spend.asset) ?? symbolOf(want) ?? "money");
      return {
        kinds: goal.kind === "consolidate" ? k("bridge") : k("bridge", "swap"),
        isTarget: (node, source) => node.custody.kind === "wallet" && node.network === network &&
          (want && goal.kind === "relocate" ? nodeMatchesAsset(node, want) : sameAsset(node, source.node)),
        excludeSatisfied: true,
      };
    case "deliver": {
      const networks = network ? [network] : recipientNetworks(goal, env.ctx.accounts) ?? [];
      const asset = want ?? goal.spend.asset;
      return {
        kinds: k("swap", "bridge", "transfer"),
        isTarget: (node, source) => node.custody.kind === "wallet" && networks.includes(node.network) &&
          (asset ? nodeMatchesAsset(node, asset) : sameAsset(node, source.node)),
        finalTransfer: true,
        excludeSatisfied: false,
      };
    }
    case "earn": {
      const categories = earnCategories(goal, pins);
      return {
        kinds: k("bridge", "deposit", "stake"),
        isTarget: (node, source) => {
          if (network && node.network !== network) return false;
          if (node.custody.kind === "venue") {
            if (!categories.lending || !sameExposure(node, source.node)) return false;
            return custody?.kind === "venue" ? nodeMatchesCustody(node, { ...custody, category: "lending" }) : true;
          }
          if (!categories.staking) return false;
          const provider = stakeProviderFor(node);
          if (!provider || (source.node.group !== provider.input && upper(source.node.symbol) !== provider.input)) return false;
          if (custody?.kind === "venue" && custody.protocol && custody.protocol !== provider.id) return false;
          return want ? nodeMatchesAsset(node, want) : true;
        },
        excludeSatisfied: false,
      };
    }
    case "exit": {
      const moving = custody?.kind === "venue";
      return {
        kinds: moving ? k("withdraw", "deposit", "bridge") : want ? k("withdraw", "swap", "bridge") : k("withdraw", "bridge"),
        isTarget: (node, source) => {
          if (node.id === source.node.id) return false;
          const where = network ?? (moving || !want ? source.node.network : undefined);
          if (where && node.network !== where) return false;
          if (moving) return node.custody.kind === "venue" && nodeMatchesCustody(node, { ...custody, category: "lending" }) && sameExposure(node, source.node);
          if (node.custody.kind !== "wallet") return false;
          return want ? nodeMatchesAsset(node, want) : sameAsset(node, source.node);
        },
        excludeSatisfied: false,
      };
    }
    case "acquire":
    case "fuel": {
      const wanted: AssetSel = want ?? { class: "gas" };
      if (goal.kind === "acquire" && !want) return outputQuestion(env);
      let where = network;
      if (!where) {
        const listed = listedNetworks(env, wanted);
        // An exposure class ("hold btc", "eth staking exposure") is bought where the money is when that network lists it.
        const exposure = isExposure(wanted) && from && listed.includes(from) ? [from] : listed;
        if (exposure.length !== 1) return destinationQuestion(env, symbolOf(want) ?? classLabel(want) ?? "gas");
        where = exposure[0];
      }
      return {
        kinds: goal.kind === "fuel" ? k("swap", "bridge") : k("swap", "bridge", "stake"),
        isTarget: (node) => node.custody.kind === "wallet" && node.network === where && nodeMatchesAsset(node, wanted),
        excludeSatisfied: true,
        where,
      };
    }
    case "rebalance":
    case "contract":
      throw noRouteError(goal);
  }
}

/** The networks of the request's lane, with an account, whose wallet lists an asset matching `asset`. */
function listedNetworks(env: GoalEnv, asset: AssetSel): NetworkKey[] {
  const current = accountLane(env.ctx.accounts);
  return NETWORK_ORDER.filter((candidate) => lane(candidate) === current && hasAccount(env.ctx.accounts, candidate) &&
    [...env.graph.nodes.values()].some((node) => node.network === candidate && node.custody.kind === "wallet" && !node.transferOnly && nodeMatchesAsset(node, asset)));
}

/** An exposure class: a liquid staking token of ETH or SOL, or wrapped bitcoin. */
function isExposure(asset: AssetSel | undefined): boolean {
  return asset !== undefined && "class" in asset && (EXPOSURE_ASSET_CLASSES as readonly string[]).includes(asset.class);
}

/** The staked asset of a liquid staking exposure class, or null (btc). */
function exposureInput(asset: AssetSel | undefined): "ETH" | "SOL" | null {
  const cls = asset && "class" in asset ? (asset.class as string) : undefined;
  return cls === "eth-lst" ? "ETH" : cls === "sol-lst" ? "SOL" : null;
}

/** Exposure routes: those landing on the liquid staking token with the best compared 7-day rate for its risk first. */
function exposureOrder(env: GoalEnv, routes: readonly Route[]): Route[] {
  const input = exposureInput(env.goal.want.asset);
  const readings = input ? env.snapshot.stakes?.get(input) : undefined;
  const best = input && readings && readings.length > 0 ? bestRatedStake(stakeProvidersOf(input), readings, yieldPreference(env.goal)) : undefined;
  if (!best) return [...routes];
  const lead = routes.filter((route) => upper(route.landing.symbol) === upper(best.lst));
  return [...lead, ...routes.filter((route) => !lead.includes(route))];
}

/** The chip of an exposure goal's landing token (material: the token held is Kletia's choice), with the other tokens reached. */
function exposureChip(env: GoalEnv, route: Route, routes: readonly Route[]): Assumption | null {
  if (!isExposure(env.goal.want.asset) || route.category === "staking") return null;
  const input = exposureInput(env.goal.want.asset);
  const readings = input ? env.snapshot.stakes?.get(input) : undefined;
  const best = input && readings && readings.length > 0 ? bestRatedStake(stakeProvidersOf(input), readings, yieldPreference(env.goal)) : undefined;
  const others = [...new Set(routes.map((entry) => entry.landing.symbol).filter((symbol) => upper(symbol) !== upper(route.landing.symbol)))];
  const step = Math.max(0, route.hops.length - 1);
  const rated = best && upper(best.lst) === upper(route.landing.symbol);
  return assumption(field(env.index + step, "to"), clip(`Holds ${route.landing.symbol}${rated ? ` · ${apyLabel(best?.apy)} (7-day)` : ""}`, 48), { asset: route.landing.symbol }, "default",
    rated ? `The best compared 7-day rate for its risk among the tokens Kletia lists on ${networkLabel(route.landing.network)}; rates are variable.`
      : `The ${classLabel(env.goal.want.asset) ?? "token"} Kletia lists on ${networkLabel(route.landing.network)} with the cheapest route.`,
    others.slice(0, 4).map((symbol) => ({ id: symbol, label: `Hold ${symbol}`, value: { asset: symbol } })), true);
}

/* -------------------------------------------------------------- sources */

/** Holdings a goal may spend from (wallet nodes), with what is known about them. */
function holdingSources(env: GoalEnv): SearchSource[] {
  const { goal, snapshot, graph, pins } = env;
  const from = pins?.source ?? goal.spend.from?.network;
  const asset: AssetSel | undefined = pins?.asset ? { symbol: pins.asset } : goal.spend.asset;
  const current = accountLane(env.ctx.accounts);
  const out: SearchSource[] = [];
  for (const holding of snapshot.holdings) {
    if (!holding.asset) continue;
    const node = graph.nodes.get(walletNodeId(holding.network, holding.asset));
    if (!node || lane(node.network) !== current || !hasAccount(env.ctx.accounts, node.network)) continue;
    if (from && node.network !== from) continue;
    if (asset && !nodeMatchesAsset(node, asset)) continue;
    if (node.transferOnly && goal.kind !== "deliver") continue;
    if (holding.status === "known") {
      if (!holding.formatted || !isDecimal(holding.formatted) || parseDecimal(holding.formatted) <= 0n) continue;
      const price = priceOf(snapshot, node);
      const value = holding.usd ?? (price !== null ? Number(holding.formatted) * price : null);
      if (!asset && (value === null || value < GOAL_LIMITS.dustUsd)) continue;
      if (asset && value !== null && value < GOAL_LIMITS.dustUsd && !from) continue;
      out.push({ node, valueUsd: value, amount: holding.formatted, status: "known", position: false });
    } else if (asset && from) {
      // Unknown is never zero: a named holding that could not be read stays a source (the policy asks the amount).
      out.push({ node, valueUsd: null, amount: null, status: "unknown", position: false });
    }
  }
  return out;
}

/** The same goal with no source network (said or pinned): where else the funds are. */
function withoutSource(env: GoalEnv): GoalEnv {
  const { from: _from, ...spend } = env.goal.spend;
  const { source: _source, ...pins } = env.pins ?? {};
  return { ...env, goal: { ...env.goal, spend }, pins };
}

/** Positions an exit goal may leave (venue nodes) and the networks whose positions could not be read, or a question when none could. */
function positionSources(env: GoalEnv): { readonly sources: SearchSource[]; readonly unread: NetworkKey[] } | Question {
  const { goal, snapshot, graph, pins } = env;
  const custody = goal.spend.from?.custody;
  const protocol = custody && custody.kind !== "wallet" ? custody.protocol : undefined;
  const from = pins?.source ?? goal.spend.from?.network;
  const asset = goal.spend.asset;
  const venueNodes = new Map<string, GraphNode>();
  for (const node of graph.nodes.values()) if (node.custody.kind === "venue") venueNodes.set(node.custody.venueId, node);
  const known: SearchSource[] = [];
  const unknown = new Set<NetworkKey>();
  for (const position of snapshot.positions) {
    if (protocol && position.protocol !== protocol) continue;
    if (from && position.network !== from) continue;
    const node = venueNodes.get(position.venue);
    if (!node || !hasAccount(env.ctx.accounts, node.network)) continue;
    if (asset && !nodeMatchesAsset(node, asset) && !(symbolOf(asset) && upper(symbolOf(asset) as string) === upper(position.symbol))) continue;
    if (position.status !== "known") {
      unknown.add(position.network);
      continue;
    }
    if (!position.formatted || !isDecimal(position.formatted) || parseDecimal(position.formatted) <= 0n) continue;
    known.push({ node, valueUsd: position.usd, amount: position.formatted, status: "known", position: true });
  }
  if (known.length > 0) return { sources: known, unread: NETWORK_ORDER.filter((network) => unknown.has(network)) };
  if (unknown.size > 0) {
    const networks = NETWORK_ORDER.filter((network) => unknown.has(network));
    const name = protocol ? protocolName(protocol) : "lending";
    return question(field(env.index, "network"), "choice", "NETWORK_AMBIGUOUS", `Which network is your ${name} position on?`, "Kletia could not read your positions right now.",
      networks.slice(0, 8).map((network) => ({ id: network, label: networkLabel(network), value: { network } })), true);
  }
  const what = [symbolOf(asset), protocol ? protocolName(protocol) : undefined].filter(Boolean).join(" ");
  throw new PlatformError("POSITION_EMPTY", clip(`You have no ${what ? `${what} ` : ""}position Kletia can withdraw${from ? ` on ${networkLabel(from)}` : ""}.`, 200), 422);
}

/** True when a look-alike of the source's asset on its network (USDbC for USDC on Base) covers `need` and could be used. */
function lookalikeCovers(env: GoalEnv, source: SearchSource, need: string): boolean {
  const symbol = upper(source.node.symbol);
  const pair = LOOKALIKES.find((entry) => entry.network === source.node.network && (upper(entry.a) === symbol || upper(entry.b) === symbol));
  if (!pair) return false;
  const other = upper(pair.a) === symbol ? pair.b : pair.a;
  if (env.goal.kind !== "deliver" && transferOnly(source.node.network, other)) return false;
  const holding = env.snapshot.holdings.find((entry) => entry.network === source.node.network && upper(entry.symbol) === upper(other));
  return holding?.status === "known" && holding.formatted !== undefined && isDecimal(holding.formatted) && cmp(holding.formatted, need) >= 0;
}

/* -------------------------------------------------------------- amounts */

interface AmountPlan {
  readonly slot?: Slot<ThreadAmount>;
  readonly assumption?: Assumption;
  readonly question?: Question;
}

/** The exact amount the person asked to spend (token units), when it is one; dollar amounts of a stablecoin count at par. */
function exactNeed(goal: Goal, pins: GoalPins | undefined): string | null {
  const amount = pins?.amount ?? goal.spend.amount;
  if (!amount) return null;
  if (amount.t === "exact") return amount.value;
  if (amount.t === "usd") {
    const symbol = pins?.asset ?? symbolOf(goal.spend.asset);
    if (!symbol || isStableSymbol(symbol)) return amount.value;
  }
  return null;
}

/** The first step's amount for a spend amount said (or none: the policy asks). */
function spendAmount(env: GoalEnv, route: Route): AmountPlan {
  const { goal, pins, snapshot } = env;
  const source = route.source;
  const path = field(env.index, "amount");
  if (pins?.amount) return { slot: { v: pins.amount, by: "answer" } };
  const said = goal.spend.amount;
  if (!said) return {};
  const symbol = source.node.symbol;
  switch (said.t) {
    case "exact":
      return { slot: user({ t: "exact", value: said.value }) };
    case "usd": {
      if (isStableSymbol(symbol) && source.node.category === "stablecoin") return { slot: user({ t: "exact", value: said.value }) };
      const priced = priceAmount({ index: env.index, usd: said.value, symbol, decimals: source.node.decimals, price: usablePrice(snapshot, source.node.asset) });
      if (!priced) {
        return { question: question(path, "amount", "AMOUNT_MISSING", `How much ${symbol}?`, `Kletia could not price ${symbol} right now; say the amount in ${symbol}.`, [], true, `Amount in ${symbol}`) };
      }
      return { slot: { v: { t: "exact", value: priced.value }, by: "assumed", why: solverWhy(SOLVER_CODES.PRICE_USD) }, assumption: { ...priced.assumption, source: "price" } };
    }
    case "portion":
      return { slot: user(source.position ? { t: "position", bps: said.bps } : { t: "balance", bps: said.bps }) };
    case "max":
      return { slot: user(source.position ? { t: "position", bps: 10_000 } : { t: "balance", bps: 10_000 }) };
    case "previous":
      return { slot: user({ t: "previous", bps: 10_000 }) };
    case "allBut": {
      if (source.amount === null) {
        return { question: question(path, "amount", "AMOUNT_BALANCE_UNKNOWN", `How much ${symbol}?`, "Kletia cannot read your balance; say an exact amount.", [], true, `Amount in ${symbol}`) };
      }
      const left = sub(source.amount, said.keep);
      if (left <= 0n) throw new PlatformError("AMOUNT_TOO_SMALL", `You hold ${amountLabel(source.amount)} ${symbol}, not more than the ${amountLabel(said.keep)} to keep.`, 422, [{ path, message: "Balance too small." }]);
      const value = formatDecimal(left, Math.min(source.node.decimals, 18));
      return {
        slot: { v: { t: "exact", value }, by: "assumed", why: solverWhy(SOLVER_CODES.SOLVER_SCOPE) },
        assumption: assumption(path, `All but ${amountLabel(said.keep)} ${symbol}: ${amountLabel(value)}`, { amount: { t: "exact", value } }, "balance",
          `You hold ${amountLabel(source.amount)} ${symbol} on ${networkLabel(source.node.network)}.`, [], true),
      };
    }
  }
}

/**
 * Back-solving a target ("get me 0.01 ETH on Arbitrum"): moving the same
 * asset spends the target itself (fees come out of what arrives, shown);
 * another asset is priced, divided by the route's fee shares and given a 1%
 * buffer. Null when a price is missing.
 */
function targetAmount(snapshot: Snapshot, route: Route, target: string): { value: string; same: boolean; wantUsd?: number; sourceUsd?: number } | null {
  const last = route.hops[route.hops.length - 1]?.to ?? route.source.node;
  if (sameAsset(route.source.node, last)) return { value: target, same: true };
  const wantUsd = priceOf(snapshot, last);
  const sourceUsd = priceOf(snapshot, route.source.node);
  if (wantUsd === null || sourceUsd === null || sourceUsd <= 0) return null;
  const kept = route.hops.reduce((share, hop) => share * (1 - hop.edge.feeBps / 10_000), 1);
  const units = ((Number(target) * wantUsd) / sourceUsd / Math.max(kept, 0.5)) * 1.01;
  return { value: ceilTo(units, Math.min(route.source.node.decimals, 6)), same: false, wantUsd, sourceUsd };
}

/** The USD value a goal moves, when the amount said (or the target) and a price tell it; null otherwise. */
function movedValue(env: GoalEnv, target: string | null): number | null {
  const { goal, snapshot, graph } = env;
  const amount = env.pins?.amount ?? goal.spend.amount;
  if (amount?.t === "usd") return Number(amount.value);
  const priceOfSel = (selection: AssetSel | undefined, network: NetworkKey | undefined): number | null => {
    if (!selection) return null;
    for (const node of graph.nodes.values()) {
      if (node.custody.kind !== "wallet" || (network && node.network !== network) || !nodeMatchesAsset(node, selection)) continue;
      const price = priceOf(snapshot, node);
      if (price !== null) return price;
    }
    return null;
  };
  if (amount?.t === "exact") {
    const price = priceOfSel(env.pins?.asset ? { symbol: env.pins.asset } : goal.spend.asset, goal.spend.from?.network);
    return price === null ? null : Number(amount.value) * price;
  }
  if (target) {
    if (goal.want.amount?.t === "usd") return Number(goal.want.amount.value);
    const price = priceOfSel(goal.want.asset, goal.want.at?.network);
    return price === null ? null : Number(target) * price;
  }
  return null;
}

/* ------------------------------------------------------------ one goal */

/** The search spec of a goal's problem over a list of sources (the goal's verb, constraints, rates and gas prices). */
function specFor(env: GoalEnv, problem: Problem): (list: readonly SearchSource[]) => SearchSpec {
  const { goal } = env;
  const gasPrices = new Map<NetworkKey, number | null>();
  for (const node of env.graph.nodes.values()) {
    if (node.isNative && node.custody.kind === "wallet" && !gasPrices.has(node.network)) gasPrices.set(node.network, priceOf(env.snapshot, node));
  }
  return (list) => ({
    graph: env.graph,
    sources: list,
    isTarget: problem.isTarget,
    kinds: problem.kinds,
    ...(goal.op && goal.op !== "call" && goal.op !== "action" && problem.kinds.has(goal.op) ? { op: goal.op } : {}),
    ...(problem.allowBridge === false ? { allowBridge: false } : {}),
    ...(problem.finalTransfer ? { finalTransfer: true } : {}),
    accounts: env.ctx.accounts,
    ...(goal.constraints.via ? { via: goal.constraints.via } : {}),
    ...(goal.constraints.avoid ? { avoid: goal.constraints.avoid } : {}),
    ...(goal.constraints.prefer ? { prefer: goal.constraints.prefer } : {}),
    // Routes count a venue's smoothed rate only when it passes the comparison checks, never the current rate.
    apy: (venueId) => {
      const entry = env.snapshot.apy.get(venueId);
      return entry ? comparableApy(entry, protocolTier(entry.protocol, entry.network)) : null;
    },
    gasAssetUsd: (network) => gasPrices.get(network) ?? null,
    ...(env.ctx.gasPriceWei ? { gasPriceWei: env.ctx.gasPriceWei } : {}),
  });
}

/**
 * Exact delivery ("make sure alice.eth gets exactly 50 usdc on arbitrum"):
 * the stated amount is what the recipient receives, so it is what the final
 * transfer sends, paid in that asset.
 */
function exactlyGoal(env: GoalEnv): GoalEnv {
  const goal = env.goal;
  if (goal.kind !== "deliver" || goal.want.mode !== "exactly" || goal.want.amount?.t !== "exact" || goal.spend.amount) return env;
  const asset = goal.spend.asset ?? goal.want.asset;
  return { ...env, goal: { ...goal, spend: { ...goal.spend, amount: goal.want.amount, ...(asset ? { asset } : {}) } } };
}

/** "exit all my lending positions", "close everything on base": every position in scope, none named. */
function isExitAll(goal: Goal): boolean {
  const custody = goal.spend.from?.custody;
  if (goal.kind !== "exit" || (custody && custody.kind !== "wallet" && custody.protocol)) return false;
  if (goal.spend.amount && goal.spend.amount.t !== "max") return false;
  return goal.want.at?.custody.kind !== "venue" && goal.want.asset === undefined;
}

function solveGoal(input: GoalEnv): Step {
  const env = exactlyGoal(input);
  const { goal, notes, pins } = env;
  // D9, D1: before anything is searched.
  const typo = typoQuestion(notes, env.index);
  if (typo && !pins?.asset) return ask(typo);
  const recipient = recipientQuestion(goal, env.index);
  if (recipient) return ask(recipient);
  // "send everything on base to alice.eth" is a payment of every holding there to the recipient, never a
  // consolidation into the person's own account (one transfer per asset; the policy confirms every move).
  if (goal.kind === "consolidate" && (goal.holder.t === "address" || goal.holder.t === "name")) return deliverAll(env, goal.holder.value);
  // Abstract goals with their own arithmetic: rebalance targets and dust sweeps.
  if (goal.kind === "rebalance") return solveRebalance(env);
  if (goal.kind === "consolidate" && goal.spend.filter) return solveDust(env);

  const problem = problemFor(env);
  if (!("kinds" in problem)) return ask(problem);

  // Sources: the previous goal's landing, positions, or holdings.
  const chained = env.previous !== undefined;
  // The want-side target: a token amount, USD back-solved, "enough for fees", or only the difference (atLeast).
  const wantSaid = wantTarget(env, goal.want.at?.network ?? problem.where, chained);
  if (wantSaid && "reason" in wantSaid) return ask(wantSaid);
  // "exactly": the recipient receives the stated amount. Until exact delivery across networks is planned, only
  // funds already on the receiving network can pay it.
  const exactly = goal.kind === "deliver" && goal.want.mode === "exactly";
  const receiving = goal.want.at?.network ?? (recipientNetworks(goal, env.ctx.accounts)?.length === 1 ? recipientNetworks(goal, env.ctx.accounts)?.[0] : undefined);
  let sources: SearchSource[];
  let unread: NetworkKey[] = [];
  if (env.previous) {
    const landing = env.previous.route.landing;
    const node = env.graph.nodes.get(env.previous.route.hops[env.previous.route.hops.length - 1]?.to.id ?? env.previous.route.source.node.id);
    if (!node) throw noRouteError(goal);
    sources = [{ node, valueUsd: env.previous.route.valueOutUsd, amount: null, status: "unknown", position: landing.place.custody.kind === "venue" }];
  } else if (goal.kind === "exit" || goal.spend.from?.custody.kind === "position") {
    const positions = positionSources(env);
    if (!("sources" in positions)) return ask(positions);
    sources = positions.sources;
    unread = positions.unread;
  } else {
    sources = holdingSources(env);
  }
  if (exactly && receiving && !EXACT_DELIVERY_PLANNED && !chained) {
    const need = exactNeed(goal, pins);
    const there = sources.filter((source) => source.node.network === receiving);
    const covering = there.filter((source) => source.status === "known" && source.amount !== null && need !== null && cmp(source.amount, need) >= 0);
    if (covering.length === 0) {
      const held = there.find((source) => source.amount !== null)?.amount ?? "0";
      const what = symbolOf(goal.spend.asset) ?? "it";
      throw refuse(`${goal.holder.t === "name" || goal.holder.t === "address" ? goal.holder.value.slice(0, 42) : "The recipient"} receives exactly ${need ? amountLabel(need) : "that"} ${what} on ${networkLabel(receiving)} only from ${what} already there, and you hold ${amountLabel(held)}. Move ${what} to ${networkLabel(receiving)} first, then send.`);
    }
    sources = covering;
  }
  if (problem.excludeSatisfied) sources = sources.filter((source) => !problem.isTarget(source.node, source));
  // Converting into an asset already held: those holdings are not what is spent ("convert my stablecoins to USDC").
  const wanted = goal.want.asset;
  if (goal.kind === "convert" && wanted && !symbolOf(goal.spend.asset)) sources = sources.filter((source) => !nodeMatchesAsset(source.node, wanted));
  if (goal.kind === "consolidate" && !goal.spend.asset && !pins?.asset) sources = sources.filter((source) => !source.node.isNative);

  const symbol = pins?.asset ?? symbolOf(goal.spend.asset) ?? classLabel(goal.spend.asset) ?? sources[0]?.node.symbol ?? symbolOf(goal.want.asset) ?? "funds";
  // Exit-all: one withdraw per position in scope; networks whose positions could not be read are named and asked
  // about, never treated as empty.
  const exitAll = !chained && isExitAll(goal);
  if (exitAll && unread.length > 0 && pins?.scope !== "all") {
    return ask(question(field(env.index, "network"), "confirm", "SCOPE_AMBIGUOUS",
      clip(`Kletia could not read your positions on ${unread.map(networkLabel).join(", ")}. Withdraw from the ${sources.length} it read?`, 160),
      "Positions Kletia could not read are not withdrawn; you can ask again for them later.",
      [{ id: "all", label: clip(`Withdraw the ${sources.length} Kletia read`, 48), value: { target: "all" } }, { id: "cancel", label: "No, rewrite it", value: { target: "cancel" } }], false));
  }

  // D2: an exact amount above every known balance.
  const need = chained ? null : exactNeed(goal, pins);
  if (need && sources.length > 0 && !pins?.amount) {
    const named = pins?.source ?? goal.spend.from?.network;
    const elsewhere = named ? holdingSources(withoutSource(env)).filter((source) => source.node.network !== named) : [];
    // D10 before D2: a look-alike on the same network that covers the amount is the policy's ASSET_LOOKALIKE question.
    const lookalike = sources.some((source) => lookalikeCovers(env, source, need));
    const exceeds = lookalike ? null : exceedsQuestion({ index: env.index, symbol: sources[0]?.node.symbol ?? symbol, need, sources, elsewhere });
    if (exceeds) return ask(exceeds);
    sources = sources.filter((source) => source.status !== "known" || source.amount === null || cmp(source.amount, need) >= 0 || lookalikeCovers(env, source, need));
  }

  // D4: a possessive scope over several networks.
  const assumptions: Assumption[] = [...(wantSaid && !("reason" in wantSaid) ? wantSaid.assumptions : [])];
  // One position read and nothing unread is an ordinary withdraw; several (or some unread) are an exit-all's moves.
  let multi = goal.kind === "consolidate" || (exitAll && (sources.length > 1 || unread.length > 0));
  const possessive = notes?.possessive === true || goal.spend.amount?.t === "max";
  if (!multi && !chained && possessive && !goal.spend.from?.network && !pins?.source && goal.spend.asset && new Set(sources.map((source) => source.node.network)).size > 1) {
    const scope = scopeDecision({ index: env.index, symbol, sources, ...(pins?.scope ? { pinned: pins.scope } : {}) });
    if (scope.kind === "ask") return ask(scope.question);
    if (scope.kind === "all") multi = true;
    else {
      sources = sources.filter((source) => source.node.network === scope.network);
      if (scope.assumption) assumptions.push(scope.assumption);
    }
  }
  // A class spent whole or in part ("all my stables on base", "half my stablecoins") is every holding of the class
  // in scope, never the one a route search prefers; several holdings are several moves (the policy confirms them).
  const classSpend = goal.spend.asset !== undefined && "class" in goal.spend.asset && !pins?.asset;
  const shareSaid = goal.spend.amount?.t === "max" || goal.spend.amount?.t === "portion";
  if (!multi && !chained && classSpend && shareSaid && new Set(sources.map((source) => source.node.id)).size > 1) multi = true;

  const spec = specFor(env, problem);

  if (multi) return solveMulti(env, sources, spec, assumptions, exitAll ? { unread } : undefined);

  // Fees are charged on what moves, not on the whole holding.
  const target = wantSaid && !("reason" in wantSaid) ? wantSaid.value : null;
  const movedUsd = movedValue(env, target);
  if (movedUsd !== null) sources = sources.map((source) => ({ ...source, valueUsd: source.valueUsd === null ? movedUsd : Math.min(source.valueUsd, movedUsd) }));
  else if (goal.spend.amount?.t === "portion") {
    const bps = goal.spend.amount.bps;
    sources = sources.map((source) => ({ ...source, valueUsd: source.valueUsd === null ? null : (source.valueUsd * bps) / 10_000 }));
  }

  let routes = sources.length > 0 ? searchRoutes(spec(sources)) : [];

  // Back-solve a target amount; keep the routes whose source covers it.
  const required = new Map<Route, ReturnType<typeof targetAmount>>();
  if (target) {
    const all = routes;
    for (const route of routes) required.set(route, targetAmount(env.snapshot, route, target));
    routes = routes.filter((route) => {
      const amount = required.get(route);
      return !amount || route.source.amount === null || cmp(route.source.amount, amount.value) >= 0;
    });
    if (routes.length === 0 && all.length > 0) {
      // The person named where or what to spend, or only the wanted asset itself can pay: the amount is the question (D2).
      const sameOnly = all.every((route) => required.get(route)?.same === true);
      if (goal.spend.from?.network || pins?.source || goal.spend.asset || sameOnly) {
        const routeSources = [...new Map(all.map((route) => [route.source.node.id, route.source])).values()];
        // The shortfall is in what pays: the source amount the target needs, not the target itself (0.1 SOL paid in USDC).
        const needs = all.map((route) => required.get(route)?.value).filter((value): value is string => value !== undefined);
        const need = needs.length > 0 ? needs.reduce((low, value) => (cmp(value, low) < 0 ? value : low)) : target;
        const exceeds = exceedsQuestion({ index: env.index, symbol: routeSources[0]?.node.symbol ?? symbol, need, sources: routeSources, elsewhere: [] });
        if (exceeds) return ask(exceeds);
      }
      const options: Option[] = [];
      const seen = new Set<string>();
      for (const route of all) {
        const key = `${route.source.node.network}:${route.source.node.symbol}`;
        if (seen.has(key) || options.length >= 8) continue;
        seen.add(key);
        options.push({ id: key, label: clip(`Pay with ${route.source.node.symbol} on ${networkLabel(route.source.node.network)}`, 48), detail: route.source.amount ? `You hold ${amountLabel(route.source.amount)} (not enough)` : "Balance unknown", value: { asset: route.source.node.symbol, source: route.source.node.network } });
      }
      return ask(question(field(env.index, "from"), "choice", "INPUT_ASSET_MISSING", `None of your holdings covers ${amountLabel(target)} ${symbolOf(goal.want.asset) ?? ""}. Which should pay, with a smaller target?`.replace(" .", "."),
        "Kletia only plans what your balances cover.", options, true));
    }
  }

  // D0: nothing can run the goal.
  if (routes.length === 0) {
    const named = pins?.source ?? goal.spend.from?.network;
    if (named || goal.spend.asset) {
      const relaxed = holdingSources(withoutSource(env))
        .filter((source) => source.node.network !== named && (!need || source.amount === null || cmp(source.amount, need) >= 0))
        .filter((source) => !problem.excludeSatisfied || !problem.isTarget(source.node, source));
      const elsewhere = relaxed.length > 0 && named ? searchRoutes(spec(relaxed)) : [];
      const funds = fundsElsewhereQuestion({ index: env.index, symbol, from: named, routes: elsewhere });
      if (funds) return ask(funds);
    }
    throw noRouteError(goal);
  }

  // The receiving network of a payment to someone else is purpose (I13): asked with each network's cost when the
  // recipient does not imply it ("cheapest way to send 50 usdc to alice.eth").
  if (goal.kind === "deliver" && !chained && !goal.want.at?.network && (goal.holder.t === "address" || goal.holder.t === "name") && (recipientNetworks(goal, env.ctx.accounts) ?? []).length > 1) {
    const asked = receivingQuestion(env, routes, goal.holder.value);
    if (asked) return ask(asked);
  }
  // Exposure classes: the liquid staking token with the best compared 7-day rate for its risk leads.
  if (isExposure(goal.want.asset)) routes = exposureOrder(env, routes);

  const choice = chooseRoute({
    goal,
    index: env.index,
    routes,
    ...(pins ? { pins } : {}),
    assetNamed: goal.spend.asset !== undefined || pins?.asset !== undefined || chained,
    sourceNamed: goal.spend.from?.network !== undefined || pins?.source !== undefined || chained,
    bestStake: (input) => {
      const readings = env.snapshot.stakes?.get(input);
      return readings && readings.length > 0 ? bestRatedStake(stakeProvidersOf(input), readings, yieldPreference(goal)) : undefined;
    },
  });
  if (choice.kind === "ask") {
    if (choice.questions.length === 0) throw noRouteError(goal);
    return { kind: "ask", questions: choice.questions };
  }
  const route = choice.route;
  // A crossing to a network the person said (or the recipient implies), from a holding on a network
  // they did not name, is asked; moving money they asked to move (relocate, consolidate) or a means choice is a chip.
  const sourceNamed = goal.spend.from?.network !== undefined || pins?.source !== undefined || chained;
  const destinationSaid = goal.want.at?.network !== undefined || (goal.kind === "deliver" && (recipientNetworks(goal, env.ctx.accounts) ?? []).length === 1);
  // A top-up ("prepare 100 usdc on optimism") names no source either: asked like any other crossing.
  const movesSaid = (goal.kind === "relocate" || goal.kind === "consolidate") && goal.want.mode !== "atLeast";
  if (!sourceNamed && destinationSaid && !movesSaid && route.hops.some((hop) => hop.edge.kind === "bridge")) {
    const to = goal.want.at?.network ?? route.landing.network;
    const asked = crossingSourceQuestion({ index: env.index, symbol: route.source.node.symbol, to, routes: routes.filter((entry) => entry.hops.some((hop) => hop.edge.kind === "bridge")) });
    if (asked) return ask(asked);
  }
  assumptions.push(...choice.assumptions);
  const exposure = exposureChip(env, route, routes);
  if (exposure) assumptions.push(exposure);

  // The first step's amount: said, priced (D11), back-solved, or left for the policy to ask.
  let amount: AmountPlan;
  if (chained) amount = { slot: user({ t: "previous", bps: 10_000 }) };
  else if (target) {
    const solved = required.get(route) ?? targetAmount(env.snapshot, route, target);
    const wantSymbol = route.landing.symbol;
    if (!solved) {
      amount = { question: question(field(env.index, "amount"), "amount", "AMOUNT_MISSING", `How much ${route.source.node.symbol} should pay for ${amountLabel(target)} ${wantSymbol}?`, `Kletia could not price ${route.source.node.symbol} or ${wantSymbol} right now.`, [], true, `Amount in ${route.source.node.symbol}`) };
    } else {
      amount = {
        slot: { v: { t: "exact", value: solved.value }, by: "assumed", why: solverWhy(SOLVER_CODES.SOLVER_TARGET_AMOUNT) },
        assumption: assumption(field(env.index, "amount"),
          solved.same ? `Moves ${amountLabel(solved.value)} ${route.source.node.symbol}` : `${amountLabel(solved.value)} ${route.source.node.symbol} for ${amountLabel(target)} ${wantSymbol}`,
          { amount: { t: "exact", value: solved.value } }, solved.same ? "default" : "price",
          solved.same
            ? `${route.valueInUsd === null ? "Fees" : `Fees (${costLabel(route.feesUsd, route.seconds)})`} come out of what arrives.`
            : `At ${usdLabel(solved.wantUsd as number)} per ${wantSymbol} and ${usdLabel(solved.sourceUsd as number)} per ${route.source.node.symbol}, plus fees and a 1% buffer.`,
          [], !solved.same),
      };
    }
  } else amount = spendAmount(env, route);
  if (amount.question) return ask(amount.question);
  if (amount.assumption) {
    // One amount chip: what the goal's target says (a top-up, "enough for fees", a dollar target) leads, the
    // back-solved price detail follows.
    const own = assumptions.findIndex((entry) => entry.id === amount.assumption?.id);
    if (own >= 0) {
      const lead = assumptions[own] as Assumption;
      assumptions.splice(own, 1);
      const reason = lead.source === "price" ? amount.assumption.reason : `${lead.reason} ${amount.assumption.reason}`;
      assumptions.unshift({ ...amount.assumption, label: lead.label, reason: clip(reason, CLARIFY_LIMITS.why) });
    } else assumptions.unshift(amount.assumption);
  }

  const steps = expandRoute({
    goal,
    route,
    ...(amount.slot ? { amount: amount.slot } : {}),
    ...(goal.holder.t === "address" || goal.holder.t === "name" ? { recipient: goal.holder.value } : {}),
    chained,
  });
  // A target amount Kletia computed that moves more than half of what the source network holds (by USD)
  // is confirmed with the move listed; unknown values count as more (fail closed).
  if (target && amount.slot?.v.t === "exact" && steps[0]) {
    if (movesMajority(env.snapshot, route.source.node, amount.slot.v.value)) (steps[0] as WorkStep & MovesFlag).movesMajority = true;
  }
  assumptions.push(...gasWarnings(env, route));

  // D12 / D13: confirm a reading from word order or the LLM layer.
  const amountSaid = amount.slot?.v.t === "exact" ? amount.slot.v.value : undefined;
  const confirm = confirmQuestion({ goal, ...(notes ? { notes } : {}), ...(pins ? { pins } : {}), index: env.index, summary: describeRoute(route, amountSaid) });
  if (confirm) return { kind: "ask", questions: [confirm], steps, routes: [route] };
  return { kind: "ready", steps, routes: [route], assumptions };
}

/** Transient markers on an expanded step (never stored): its computed amount moves most of a network's holdings, or it is a move of an abstract goal. */
export interface MovesFlag {
  movesMajority?: true;
  movesConfirm?: true;
}

/** True when `amount` of `node` is worth more than half of the known USD value held on its network, or a value is unknown. */
function movesMajority(snapshot: Snapshot, node: GraphNode, amount: string): boolean {
  const price = priceOf(snapshot, node);
  if (price === null || !isDecimal(amount)) return true;
  const moved = Number(amount) * price;
  let total = 0;
  for (const holding of snapshot.holdings) {
    if (holding.network !== node.network || holding.status !== "known" || !holding.formatted || !isDecimal(holding.formatted) || parseDecimal(holding.formatted) <= 0n) continue;
    const listed = holding.asset ? capabilityGraph().nodes.get(walletNodeId(holding.network, holding.asset)) : undefined;
    const usd = holding.usd ?? (listed ? (priceOf(snapshot, listed) ?? null) : null);
    if (usd === null) return true;
    total += holding.usd ?? Number(holding.formatted) * usd;
  }
  return total <= 0 || moved > total / 2;
}

/**
 * Deliver-all: every known, positive holding on the network the
 * person named, paid to the recipient as one transfer each: tokens first, the
 * gas asset last (the policy keeps its fee reserve). The policy asks for the
 * receiving network rules and confirms every move with its amount.
 */
function deliverAll(env: GoalEnv, recipient: string): Step {
  const { goal, snapshot } = env;
  const network = goal.spend.from?.network ?? goal.want.at?.network;
  if (!network) {
    const networks = [...new Set(snapshot.holdings.filter((holding) => holding.status === "known" && holding.formatted && isDecimal(holding.formatted) && parseDecimal(holding.formatted) > 0n).map((holding) => holding.network))];
    return ask(question(field(env.index, "network"), "choice", "SCOPE_AMBIGUOUS", `Which network's holdings should ${recipient} receive?`, "Each network is paid separately; Kletia does not pick for you.",
      networks.slice(0, 8).map((entry) => ({ id: entry, label: networkLabel(entry), value: { source: entry } })), true));
  }
  const native = CHAINS[network].nativeAsset.symbol.toUpperCase();
  const held = snapshot.holdings
    .filter((holding) => holding.network === network && holding.status === "known" && holding.formatted !== undefined && isDecimal(holding.formatted) && parseDecimal(holding.formatted) > 0n)
    .sort((a, b) => Number(upper(a.symbol) === native) - Number(upper(b.symbol) === native) || a.symbol.localeCompare(b.symbol));
  if (held.length === 0) throw noRouteError(goal);
  // Every holding is one transfer; more than one plan holds is refused with the list, never cut silently.
  const room = Math.max(0, THREAD_LIMITS.maxSteps - env.index);
  if (overCaps({ signatures: held.length, auctions: 0 }, room)) {
    throw planTooLarge({ signatures: held.length, auctions: 0, moves: held.map((holding) => `${amountLabel(holding.formatted as string)} ${holding.symbol} on ${networkLabel(network)} to ${recipient}`) });
  }
  const steps: WorkStep[] = held.map((holding) => ({
    kind: user("transfer" as const),
    from: user(holding.symbol),
    amount: user({ t: "balance", bps: 10_000 } as ThreadAmount),
    network: user(network),
    recipient: user(recipient),
  }));
  const assumptions = [assumption(field(env.index, "amount"), clip(`Sends ${steps.length} holdings on ${networkLabel(network)} to ${recipient}`, 48), {}, "balance",
    `Every token you hold on ${networkLabel(network)}, the gas token last with a little kept for network fees.`, [], true)];
  return { kind: "ready", steps, routes: [], assumptions };
}

/** Consolidate, or a possessive scope answered "all networks": one route per source, each moving all of it. */
function solveMulti(env: GoalEnv, sources: readonly SearchSource[], spec: (list: readonly SearchSource[]) => SearchSpec, assumptions: Assumption[], exit?: { readonly unread: readonly NetworkKey[] }): Step {
  const { goal } = env;
  const ordered = [...sources].filter((source) => source.status === "known").sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0) || a.node.id.localeCompare(b.node.id));
  const routes: Route[] = [];
  const moves: { network: NetworkKey; label: string; steps: WorkStep[] }[] = [];
  const chips: Assumption[] = [];
  const stays: string[] = [];
  // "half my stablecoins": the same share of each holding.
  const bps = goal.spend.amount?.t === "portion" ? goal.spend.amount.bps : 10_000;
  const moved = (source: SearchSource): string => (source.amount === null ? "0" : bps === 10_000 ? source.amount : formatDecimal(portion(source.amount, bps), Math.min(source.node.decimals, 18)));
  for (const source of ordered) {
    const found = searchRoutes(spec([source]));
    const label = `${amountLabel(moved(source))} ${source.node.symbol} on ${networkLabel(source.node.network)}`;
    if (found.length === 0) {
      stays.push(label);
      continue;
    }
    const at = env.index + moves.reduce((sum, move) => sum + move.steps.length, 0);
    const choice = chooseRoute({ goal, index: at, routes: found, ...(env.pins ? { pins: env.pins } : {}), assetNamed: true, sourceNamed: true });
    if (choice.kind === "ask") {
      if (choice.questions.length === 0) {
        stays.push(label);
        continue;
      }
      return { kind: "ask", questions: choice.questions };
    }
    const expanded = expandRoute({
      goal,
      route: choice.route,
      amount: user(source.position ? { t: "position", bps } : { t: "balance", bps }),
      ...(goal.holder.t === "address" || goal.holder.t === "name" ? { recipient: goal.holder.value } : {}),
    });
    // Each source's first step names its own asset and network: it is independent of the previous route.
    routes.push(choice.route);
    moves.push({ network: source.node.network, label, steps: expanded });
    chips.push(...choice.assumptions.filter((entry) => !entry.id.endsWith(".network")));
  }
  if (routes.length === 0) throw noRouteError(goal);
  // More moves than one plan holds are asked (or refused), never cut silently.
  const tooLarge = sizeCheck(env, moves);
  if (tooLarge) return ask(tooLarge);
  const steps = moves.flatMap((move) => move.steps);
  assumptions.push(...chips);
  const where = goal.want.at?.network;
  if (exit) {
    confirmMoves(steps);
    const unread = exit.unread.length > 0 ? ` Kletia could not read ${exit.unread.map(networkLabel).join(", ")}; nothing there is withdrawn.` : "";
    assumptions.unshift(assumption(field(env.index, "amount"), clip(`Withdraws ${routes.length} position${routes.length === 1 ? "" : "s"}`, 48), {}, "position",
      clip(`Every position Kletia read: ${moves.map((move) => move.label).join(", ")}. Wallet tokens stay where they are.${unread}`, 160), [], true));
    return { kind: "ready", steps, routes, assumptions };
  }
  assumptions.unshift(assumption(field(env.index, "amount"), clip(`Moves ${routes.map((route) => `${amountLabel(moved(route.source))} ${route.source.node.symbol} from ${networkLabel(route.source.node.network)}`).join(", ")}`, 48),
    {}, "balance", clip(`${where ? `Everything that can reach ${networkLabel(where)}. ` : ""}${stays.length > 0 ? `Stays: ${stays.join(", ")} (no route or kept for network fees).` : "Gas tokens stay for network fees."}`, 160), [], true));
  return { kind: "ready", steps, routes, assumptions };
}

/* ------------------------------------------------------- abstract goals */

/** Every move of an abstract goal (rebalance, exit-all, dust sweep, top-up) is confirmed with the moves listed. */
function confirmMoves(steps: readonly WorkStep[]): void {
  for (const step of steps) if (step.amount?.v.t !== "previous") (step as WorkStep & MovesFlag).movesConfirm = true;
}

/** Fail closed: an abstract goal Kletia cannot compute exactly is refused with what to say instead, never guessed. */
function refuse(message: string, note = "Not planned."): PlatformError {
  return new PlatformError("INTENT_UNSUPPORTED", clip(message, 200), 422, [{ path: "text", message: note }]);
}

/** The snapshot holding of a wallet node. */
function holdingOf(snapshot: Snapshot, node: GraphNode): SnapshotHolding | undefined {
  return snapshot.holdings.find((holding) => holding.network === node.network && holding.asset === node.asset);
}

/** The wallet node of `selection` on `network` (listed, not transfer-only), the first in build order. */
function walletNodeFor(graph: CapabilityGraph, network: NetworkKey, selection: AssetSel): GraphNode | undefined {
  for (const node of graph.nodes.values()) {
    if (node.network === network && node.custody.kind === "wallet" && !node.transferOnly && nodeMatchesAsset(node, selection)) return node;
  }
  return undefined;
}

/** USD as an 18-digit fixed-point bigint (the rebalance arithmetic's unit for the asset axis). */
const usdUnits = (usd: number): bigint => (Number.isFinite(usd) && usd > 0 ? parseDecimal(usd.toFixed(6)) : 0n);
/** Token units worth `usd` at `price`, as an 18-digit fixed-point bigint. */
const unitsForUsd = (usd: number, price: number): bigint => (price > 0 ? parseDecimal((usd / price).toFixed(12)) : 0n);
const unitsToNumber = (value: bigint): number => Number(formatDecimal(value, 12));

/** What the rebalance chips say about the targets ("Base 50%, Arbitrum One 50%"). */
function targetsLabel(targets: GoalTargets, name: (key: string) => string): string {
  return targets.weights.map((weight) => `${name(weight.key)} ${Math.round(weight.bps / 100)}%`).join(", ");
}

/** A target key read as an asset: a class name (ASSET_CLASSES and the exposure classes) or a listed symbol. */
function keySelection(key: string): AssetSel {
  const classes: readonly string[] = [...ASSET_CLASSES, ...EXPOSURE_ASSET_CLASSES];
  return classes.includes(key) ? ({ class: key } as AssetSel) : { symbol: key };
}

/** The moves one plan may hold: within the step limit left in the thread and the plan-size caps. */
function sizeCheck(env: GoalEnv, moves: readonly { readonly network: NetworkKey; readonly label: string; readonly steps: readonly WorkStep[] }[]): Question | null {
  const steps = moves.flatMap((move) => move.steps);
  const room = Math.max(0, THREAD_LIMITS.maxSteps - env.index);
  if (!overCaps(planSize(steps.map((step) => step.kind?.v)), room)) return null;
  const listed = moves.map((move) => ({ network: move.network, label: move.label, steps: move.steps.length, auctions: planSize(move.steps.map((step) => step.kind?.v)).auctions }));
  const asked = planTooLargeQuestion({ index: env.index, moves: listed, room, networkLabel });
  if (asked && !env.goal.spend.from?.network && !env.pins?.source) return asked;
  throw planTooLarge({ signatures: steps.length, auctions: planSize(steps.map((step) => step.kind?.v)).auctions, moves: listed.map((move) => move.label) });
}

/**
 * Rebalance (GOA045, ABS006, ABS019, ABS056): the scope's holdings are
 * read, each target key's share computed, and the fewest moves that bring
 * every key within max($1, 1 %) of its target are planned (bridges for the
 * network axis, swaps for the asset axis), gas reserves kept. Every amount
 * is computed, so every move is confirmed with the list. Unreadable or
 * unpriced holdings refuse (fail closed); "already balanced" refuses.
 */
function solveRebalance(env: GoalEnv): Step {
  const targets = env.goal.targets;
  const example = "for example \"rebalance my USDC 50/50 between base and arbitrum\"";
  if (!targets || targets.weights.length === 0) throw refuse(`Say the split you want, ${example}.`);
  const sum = targets.weights.reduce((total, weight) => total + weight.bps, 0);
  if (sum !== 10_000 || targets.weights.some((weight) => !Number.isInteger(weight.bps) || weight.bps < 0)) throw refuse(`The shares must add up to 100%, ${example}.`);
  if (new Set(targets.weights.map((weight) => weight.key.toUpperCase())).size !== targets.weights.length) throw refuse(`Name each part of the split once, ${example}.`);
  return targets.axis === "network" ? rebalanceNetworks(env, targets) : rebalanceAssets(env, targets);
}

function rebalanceNetworks(env: GoalEnv, targets: GoalTargets): Step {
  const { goal, snapshot, graph } = env;
  const symbol = symbolOf(goal.spend.asset) ?? symbolOf(goal.want.asset);
  if (!symbol) throw refuse("Say one token to spread across networks, for example \"even out my USDC between base and arbitrum\".");
  const current = accountLane(env.ctx.accounts);
  const nodes = new Map<string, { node: GraphNode; held: string }>();
  const buckets: RebalanceBucket[] = [];
  for (const weight of targets.weights) {
    const network = weight.key;
    if (!isNetworkKey(network) || lane(network) !== current || !hasAccount(env.ctx.accounts, network) || !BRIDGE_NETWORKS.includes(network)) {
      throw refuse(`Kletia cannot move ${symbol} to "${network.slice(0, 24)}" for you. Name networks your accounts can use, such as base and arbitrum.`);
    }
    const node = walletNodeFor(graph, network, { symbol });
    if (!node) throw refuse(`Kletia does not list ${symbol} on ${networkLabel(network)}, so it cannot rebalance it there.`);
    const holding = holdingOf(snapshot, node);
    if (holding?.status !== "known" || !isDecimal(holding.formatted)) {
      throw refuse(`Kletia could not read your ${symbol} on ${networkLabel(network)} right now, so it cannot compute the split. Nothing is planned; try again in a moment.`);
    }
    nodes.set(network, { node, held: holding.formatted });
    buckets.push({ key: network, value: parseDecimal(holding.formatted) });
  }
  const first = [...nodes.values()][0]?.node as GraphNode;
  const price = priceOf(snapshot, first);
  const total = buckets.reduce((sum, bucket) => sum + bucket.value, 0n);
  const names = targets.weights.map((weight) => networkLabel(weight.key as NetworkKey)).join(" and ");
  if (total === 0n) throw refuse(`You hold no ${symbol} on ${names} to rebalance.`);
  const tolerance = [total / 100n, price ? unitsForUsd(1, price) : 0n].reduce((a, b) => (a > b ? a : b));
  const plan = rebalancePlan(buckets, targets.weights, tolerance, price ? unitsForUsd(GOAL_LIMITS.materialUsd, price) : 0n);
  if (plan.transfers.length === 0) throw refuse(`Your ${symbol} is already within 1% (or $1) of ${targetsLabel(targets, (key) => networkLabel(key as NetworkKey))}; nothing to move.`);
  const moves: { network: NetworkKey; label: string; steps: WorkStep[]; route: Route }[] = [];
  for (const transfer of plan.transfers) {
    const from = nodes.get(transfer.from) as { node: GraphNode; held: string };
    const to = transfer.to as NetworkKey;
    let value = transfer.value;
    if (from.node.isNative) {
      // The gas reserve stays; a split it keeps from being reached (beyond the tolerance) is refused, never planned short.
      const movable = parseDecimal(from.held) - parseDecimal(NATIVE_FEE_RESERVE[from.node.network]);
      if (movable < value) value = value - movable > tolerance ? 0n : movable;
    }
    const units = formatDecimal(value, Math.min(from.node.decimals, 18));
    if (value <= 0n || !isPositive(units)) {
      throw refuse(`Kletia keeps ${NATIVE_FEE_RESERVE[from.node.network]} ${symbol} on ${networkLabel(from.node.network)} for network fees, so it cannot move enough to reach that split.`);
    }
    const problem: Problem = {
      kinds: new Set<EdgeKind>(["bridge"]),
      isTarget: (node, source) => node.custody.kind === "wallet" && node.network === to && sameAsset(node, source.node),
      excludeSatisfied: false,
    };
    const valueUsd = price ? Number(units) * price : null;
    const route = searchRoutes(specFor(env, problem)([{ node: from.node, valueUsd, amount: from.held, status: "known", position: false }]))[0];
    if (!route) throw refuse(`Kletia found no route for ${symbol} from ${networkLabel(from.node.network)} to ${networkLabel(to)}, so it cannot rebalance it.`);
    const steps = expandRoute({ goal, route, amount: { v: { t: "exact", value: units }, by: "assumed", why: solverWhy(SOLVER_CODES.SOLVER_TARGET_AMOUNT) } });
    moves.push({ network: from.node.network, label: `${amountLabel(units)} ${symbol} ${networkLabel(from.node.network)} to ${networkLabel(to)}`, steps, route });
  }
  const tooLarge = sizeCheck(env, moves);
  if (tooLarge) return ask(tooLarge);
  const steps = moves.flatMap((move) => move.steps);
  confirmMoves(steps);
  const chip = assumption(field(env.index, "amount"), clip(`Rebalances ${symbol} ${splitLabel(targets.weights)}`, 48), {}, "balance",
    clip(`Moves ${moves.map((move) => move.label).join("; ")}. Targets: ${targetsLabel(targets, (key) => networkLabel(key as NetworkKey))}; within 1% or $1 counts as reached.`, 160), [], true);
  return { kind: "ready", steps, routes: moves.map((move) => move.route), assumptions: [chip] };
}

/** The symbol a class key is bought as on `network`: the largest holding of the class there, else Kletia's default member. */
function outputSymbol(graph: CapabilityGraph, network: NetworkKey, selection: AssetSel, held: readonly { readonly node: GraphNode; readonly usd: number }[]): string | null {
  if ("symbol" in selection) return walletNodeFor(graph, network, selection)?.symbol ?? null;
  const owned = held.filter((entry) => nodeMatchesAsset(entry.node, selection)).sort((a, b) => b.usd - a.usd)[0];
  if (owned) return owned.node.symbol;
  const cls = selection.class as AssetClass | ExposureAssetClass;
  const defaults: Record<AssetClass | ExposureAssetClass, readonly string[]> = {
    "usd-stable": ["USDC", ...USD_ORDER],
    "any-stable": ["USDC", ...USD_ORDER],
    eth: [CHAINS[network].nativeAsset.symbol === "ETH" ? "ETH" : "WETH", "WETH"],
    sol: ["SOL"],
    gas: [CHAINS[network].nativeAsset.symbol],
    "eth-lst": ["wstETH"],
    "sol-lst": ["JitoSOL"],
    btc: ["cbBTC"],
  };
  for (const symbol of defaults[cls]) {
    const node = walletNodeFor(graph, network, { symbol });
    if (node && nodeMatchesAsset(node, selection)) return node.symbol;
  }
  return null;
}

function rebalanceAssets(env: GoalEnv, targets: GoalTargets): Step {
  const { goal, snapshot, graph, pins } = env;
  const current = accountLane(env.ctx.accounts);
  const keys = targets.weights.map((weight) => ({ key: weight.key, selection: keySelection(weight.key) }));
  // One key at 100% ("go 100% stablecoins on base"): every other holding in scope is sold into it.
  const everything = targets.weights.length === 1;
  const matches = (node: GraphNode) => keys.findIndex((entry) => nodeMatchesAsset(node, entry.selection));
  let network = targets.scope?.network ?? goal.want.at?.network ?? pins?.source ?? goal.spend.from?.network;
  if (!network) {
    const held = NETWORK_ORDER.filter((candidate) => lane(candidate) === current && hasAccount(env.ctx.accounts, candidate) && SWAP_NETWORKS.includes(candidate) &&
      snapshot.holdings.some((holding) => {
        if (holding.network !== candidate || holding.status !== "known" || !isPositive(holding.formatted) || !holding.asset) return false;
        const node = graph.nodes.get(walletNodeId(candidate, holding.asset));
        return node !== undefined && (everything || matches(node) >= 0);
      }));
    if (held.length === 0) throw refuse("You hold nothing Kletia can rebalance into that split. Name the network and the tokens, for example \"rebalance to 50/50 eth usdc on arbitrum\".");
    if (held.length > 1) {
      return ask(question(field(env.index, "network"), "choice", "SCOPE_AMBIGUOUS", "Which network should Kletia rebalance?", "Each network is rebalanced on its own; Kletia does not pick for you.",
        held.slice(0, 8).map((entry) => ({ id: entry, label: networkLabel(entry), value: { network: entry } })), true));
    }
    network = held[0] as NetworkKey;
  }
  const scope = network;
  if (lane(scope) !== current || !hasAccount(env.ctx.accounts, scope) || !SWAP_NETWORKS.includes(scope)) throw refuse(`Kletia cannot swap on ${networkLabel(scope)} for your accounts.`);
  for (const entry of keys) {
    if ("symbol" in entry.selection && !walletNodeFor(graph, scope, entry.selection)) throw refuse(`Kletia does not list ${entry.key.slice(0, 16)} on ${networkLabel(scope)}.`);
  }
  const entries: { node: GraphNode; amount: string; price: number; usd: number; key: string }[] = [];
  for (const holding of snapshot.holdings) {
    if (holding.network !== scope || !holding.asset) continue;
    const node = graph.nodes.get(walletNodeId(scope, holding.asset));
    if (!node || node.transferOnly) continue;
    const keyIndex = matches(node);
    if (keyIndex < 0 && !everything) continue;
    if (holding.status !== "known" || !isDecimal(holding.formatted)) {
      throw refuse(`Kletia could not read your ${node.symbol} on ${networkLabel(scope)} right now, so it cannot compute the split. Nothing is planned; try again in a moment.`);
    }
    if (!isPositive(holding.formatted)) continue;
    const price = priceOf(snapshot, node);
    if (price === null) throw refuse(`Kletia could not price ${node.symbol} right now, so it cannot compute the split. Nothing is planned; try again in a moment.`);
    const usd = Number(holding.formatted) * price;
    if (keyIndex < 0 && usd < GOAL_LIMITS.dustUsd) continue;
    entries.push({ node, amount: holding.formatted, price, usd, key: keyIndex >= 0 ? (keys[keyIndex] as { key: string }).key : `other:${node.symbol}` });
  }
  const buckets: RebalanceBucket[] = entries.map((entry) => ({ key: entry.key, value: usdUnits(entry.usd) }));
  const total = buckets.reduce((sum, bucket) => sum + bucket.value, 0n);
  const label = (key: string) => (key.startsWith("other:") ? key.slice(6) : classLabel(keySelection(key)) ?? key);
  if (total === 0n) throw refuse(`You hold nothing on ${networkLabel(scope)} to rebalance into ${targetsLabel(targets, label)}.`);
  const tolerance = [total / 100n, usdUnits(1)].reduce((a, b) => (a > b ? a : b));
  const plan = rebalancePlan(buckets, targets.weights, tolerance, usdUnits(GOAL_LIMITS.materialUsd));
  if (plan.transfers.length === 0) throw refuse(`Your holdings on ${networkLabel(scope)} are already within 1% (or $1) of ${targetsLabel(targets, label)}; nothing to move.`);
  const used = new Map<GraphNode, number>();
  const moves: { network: NetworkKey; label: string; steps: WorkStep[]; route: Route }[] = [];
  for (const transfer of plan.transfers) {
    const target = keys.find((entry) => entry.key === transfer.to);
    const out = target ? outputSymbol(graph, scope, target.selection, entries) : null;
    if (!out) throw refuse(`Kletia cannot buy ${label(transfer.to)} on ${networkLabel(scope)}.`);
    let remaining = unitsToNumber(transfer.value);
    const sources = entries.filter((entry) => entry.key === transfer.from).sort((a, b) => b.usd - a.usd || a.node.id.localeCompare(b.node.id));
    for (const source of sources) {
      if (remaining < GOAL_LIMITS.materialUsd) break;
      const reserve = source.node.isNative ? Number(NATIVE_FEE_RESERVE[scope]) : 0;
      const movableUnits = Math.max(0, Number(source.amount) - reserve) - (used.get(source.node) ?? 0);
      const takeUsd = Math.min(remaining, movableUnits * source.price);
      if (takeUsd < GOAL_LIMITS.materialUsd) continue;
      const whole = takeUsd >= movableUnits * source.price - 1e-9 && reserve === 0 && !used.has(source.node);
      const units = whole ? source.amount : formatDecimal(unitsForUsd(takeUsd, source.price), Math.min(source.node.decimals, 6));
      if (!isPositive(units)) continue;
      const problem: Problem = {
        kinds: new Set<EdgeKind>(["swap"]),
        isTarget: (node, from) => node.custody.kind === "wallet" && node.network === scope && upper(node.symbol) === upper(out) && !sameAsset(node, from.node),
        allowBridge: false,
        excludeSatisfied: false,
      };
      const route = searchRoutes(specFor(env, problem)([{ node: source.node, valueUsd: takeUsd, amount: source.amount, status: "known", position: false }]))[0];
      if (!route) throw refuse(`Kletia found no swap from ${source.node.symbol} to ${out} on ${networkLabel(scope)}, so it cannot rebalance.`);
      const steps = expandRoute({ goal, route, amount: { v: { t: "exact", value: units }, by: "assumed", why: solverWhy(SOLVER_CODES.SOLVER_TARGET_AMOUNT) } });
      moves.push({ network: scope, label: `${amountLabel(units)} ${source.node.symbol} to ${out}`, steps, route });
      used.set(source.node, (used.get(source.node) ?? 0) + Number(units));
      remaining -= takeUsd;
    }
    // What the gas reserves keep from moving must stay within the tolerance, or the split is refused, never planned short.
    if (remaining > unitsToNumber(tolerance)) throw refuse(`Kletia keeps gas for network fees on ${networkLabel(scope)}, so it cannot reach ${targetsLabel(targets, label)} there.`);
  }
  if (moves.length === 0) throw refuse(`Kletia keeps gas for network fees on ${networkLabel(scope)}, so nothing is left to move for that split.`);
  const tooLarge = sizeCheck(env, moves);
  if (tooLarge) return ask(tooLarge);
  const steps = moves.flatMap((move) => move.steps);
  confirmMoves(steps);
  const chip = assumption(field(env.index, "amount"), clip(`Rebalances ${networkLabel(scope)} to ${splitLabel(targets.weights)}`, 48), {}, "balance",
    clip(`Swaps ${moves.map((move) => move.label).join("; ")}. Targets: ${targetsLabel(targets, label)} by USD value; within 1% or $1 counts as reached; gas for fees stays.`, 160), [], true);
  return { kind: "ready", steps, routes: moves.map((move) => move.route), assumptions: [chip] };
}

/**
 * Dust sweep (ABS010, ABS011): every holding worth at most
 * `spend.filter.maxUsdEach` (default $5) is converted into what is wanted on
 * the network named, when its route costs less than 20 % of its value. Gas
 * tokens stay; skipped holdings and unread networks are listed; every
 * conversion is confirmed with the list.
 */
function solveDust(env: GoalEnv): Step {
  const { goal, snapshot, graph, pins } = env;
  const want = goal.want.asset;
  if (!want) return ask(outputQuestion(env));
  const network = goal.want.at?.network;
  if (!network) return ask(destinationQuestion(env, symbolOf(want) ?? classLabel(want) ?? "dust"));
  const cap = Number(goal.spend.filter?.maxUsdEach ?? GOAL_LIMITS.dustMaxUsdEach);
  if (!Number.isFinite(cap) || cap <= 0) throw refuse("Say the largest balance to sweep in dollars, for example \"sweep balances under $5 into usdc on base\".");
  const from = pins?.source ?? goal.spend.from?.network;
  const current = accountLane(env.ctx.accounts);
  const problem: Problem = {
    kinds: new Set<EdgeKind>(["swap", "bridge"]),
    isTarget: (node, source) => node.custody.kind === "wallet" && node.network === network && nodeMatchesAsset(node, want) && !sameAsset(node, source.node),
    excludeSatisfied: true,
  };
  const spec = specFor(env, problem);
  const skipped: string[] = [];
  const unread = new Set<NetworkKey>();
  const moves: { network: NetworkKey; label: string; steps: WorkStep[]; route: Route }[] = [];
  const ordered = [...snapshot.holdings].sort((a, b) => NETWORK_ORDER.indexOf(a.network) - NETWORK_ORDER.indexOf(b.network) || a.symbol.localeCompare(b.symbol));
  for (const holding of ordered) {
    if (!holding.asset || lane(holding.network) !== current || !hasAccount(env.ctx.accounts, holding.network)) continue;
    if (from && holding.network !== from) continue;
    const node = graph.nodes.get(walletNodeId(holding.network, holding.asset));
    if (!node || node.isNative || node.transferOnly) continue;
    if (node.network === network && nodeMatchesAsset(node, want)) continue;
    if (holding.status !== "known") {
      unread.add(holding.network);
      continue;
    }
    if (!isPositive(holding.formatted)) continue;
    const price = priceOf(snapshot, node);
    if (price === null) {
      skipped.push(`${node.symbol} on ${networkLabel(node.network)} (no price)`);
      continue;
    }
    const usd = holding.usd ?? Number(holding.formatted) * price;
    if (usd > cap) continue;
    const route = searchRoutes(spec([{ node, valueUsd: usd, amount: holding.formatted as string, status: "known", position: false }]))[0];
    if (!route) {
      skipped.push(`${node.symbol} on ${networkLabel(node.network)} (no route)`);
      continue;
    }
    if (route.feesUsd >= usd * DUST_MAX_FEE_SHARE) {
      skipped.push(`${node.symbol} on ${networkLabel(node.network)} (fees above 20%)`);
      continue;
    }
    const steps = expandRoute({ goal, route, amount: user({ t: "balance", bps: 10_000 } as ThreadAmount) });
    moves.push({ network: node.network, label: `${amountLabel(holding.formatted as string)} ${node.symbol} on ${networkLabel(node.network)}`, steps, route });
  }
  const wanted = symbolOf(want) ?? classLabel(want) ?? "it";
  const notes = [
    ...(skipped.length > 0 ? [`Skipped: ${skipped.slice(0, 4).join(", ")}${skipped.length > 4 ? ", ..." : ""}`] : []),
    ...(unread.size > 0 ? [`Kletia could not read ${[...unread].map(networkLabel).join(", ")}`] : []),
  ];
  if (moves.length === 0) throw refuse(`Nothing to sweep into ${wanted}: no holding worth $${cap} or less has a route that costs under 20% of it.${notes.length > 0 ? ` ${notes.join(". ")}.` : ""}`);
  const tooLarge = sizeCheck(env, moves);
  if (tooLarge) return ask(tooLarge);
  const steps = moves.flatMap((move) => move.steps);
  confirmMoves(steps);
  const chip = assumption(field(env.index, "amount"), clip(`Sweeps ${moves.length} small holding${moves.length === 1 ? "" : "s"} into ${wanted}`, 48), {}, "balance",
    clip(`Each worth $${cap} or less: ${moves.map((move) => move.label).join(", ")}. Gas tokens stay for network fees.${notes.length > 0 ? ` ${notes.join(". ")}.` : ""}`, 160), [], true);
  return { kind: "ready", steps, routes: moves.map((move) => move.route), assumptions: [chip] };
}

/** A dust conversion is skipped when its route costs this share of its value or more. */
const DUST_MAX_FEE_SHARE = 0.2;

/** A target the goal states (want side): the amount to land, read from a token amount, a USD amount or "enough for fees". */
interface WantTarget {
  readonly value: string;
  readonly assumptions: readonly Assumption[];
}

/**
 * The want-side target of a goal: a token amount; a USD amount
 * back-solved at the price of what is wanted; "enough for fees"
 * (`atLeast` with no amount) as Kletia's fee reserve for that network. With
 * `atLeast`, only the difference to what is already held there is moved;
 * a goal that is already met, or whose holding there cannot be read,
 * refuses. Null when the goal states no target (or spends a stated amount).
 */
function wantTarget(env: GoalEnv, where: NetworkKey | undefined, chained: boolean): WantTarget | Question | null {
  const { goal, snapshot, graph } = env;
  if (chained || goal.spend.amount || env.pins?.amount) return null;
  const amount = goal.want.amount;
  const atLeast = goal.want.mode === "atLeast";
  const asset: AssetSel | undefined = goal.want.asset ?? (goal.kind === "fuel" ? { class: "gas" } : undefined);
  const chips: Assumption[] = [];
  const path = field(env.index, "amount");
  const node = asset && where ? walletNodeFor(graph, where, asset) : undefined;
  const symbol = node?.symbol ?? symbolOf(asset) ?? classLabel(asset) ?? "it";
  let value: string | null = null;
  if (amount?.t === "exact") value = amount.value;
  else if (amount?.t === "usd") {
    if (!node) return null;
    const stable = isStableSymbol(node.symbol) && node.category === "stablecoin";
    const price = stable ? 1 : priceOf(snapshot, node);
    if (price === null) throw refuse(`Kletia could not price ${node.symbol} right now; say the amount in ${node.symbol}, for example "get me 0.01 ${node.symbol} on ${where}".`);
    value = stable ? amount.value : ceilTo(Number(amount.value) / price, Math.min(node.decimals, 6));
    if (!stable) {
      chips.push(assumption(path, clip(`$${amountLabel(amount.value)} read as ${amountLabel(value)} ${node.symbol}`, 48), { amount: { t: "exact", value } }, "price",
        `At ${usdLabel(price)} per ${node.symbol}; the price can move before you sign.`, [], true));
    }
  } else if (atLeast && node?.isNative && where) {
    value = NATIVE_FEE_RESERVE[where];
    chips.push(assumption(path, clip(`Enough for fees: ${amountLabel(value)} ${node.symbol}`, 48), { amount: { t: "exact", value } }, "default",
      `Kletia's fee reserve on ${networkLabel(where)}: enough for several transactions at usual prices.`, [], true));
  }
  if (value === null) return null;
  if (!atLeast) return { value, assumptions: chips };
  if (!where || !node) return destinationQuestion(env, symbol);
  const holding = holdingOf(snapshot, node);
  if (holding?.status !== "known" || !isDecimal(holding.formatted)) {
    throw refuse(`Kletia could not read your ${node.symbol} on ${networkLabel(where)} right now, so it cannot tell how much to add. Say the amount to move instead.`);
  }
  const short = sub(value, holding.formatted);
  if (short <= 0n) throw refuse(`You already hold ${amountLabel(holding.formatted)} ${node.symbol} on ${networkLabel(where)}, at least the ${amountLabel(value)} you asked for. Nothing to move.`);
  const need = ceilTo(unitsToNumber(short), Math.min(node.decimals, 6));
  // One chip: the top-up, with what the target was read from (the fee reserve, a dollar amount) in its reason.
  const read = chips.map((chip) => chip.reason).join(" ");
  return {
    value: need,
    assumptions: [assumption(path, clip(`Tops up ${amountLabel(need)} ${node.symbol} on ${networkLabel(where)}`, 48), { amount: { t: "exact", value: need } }, "balance",
      clip(`You hold ${amountLabel(holding.formatted)} of the ${amountLabel(value)} ${node.symbol} you want there; Kletia adds the difference.${read ? ` ${read}` : ""}`, CLARIFY_LIMITS.why), [], true)],
  };
}

/**
 * Cheapest-path payment (ABS007, GOA040): the network a payment to
 * someone else lands on is purpose (I13). When the recipient does not imply
 * it (an Ethereum name or address), it is asked with what each network
 * would cost from the person's holdings, cheapest first; never a chip.
 */
function receivingQuestion(env: GoalEnv, routes: readonly Route[], recipient: string): Question | null {
  const best = new Map<NetworkKey, Route>();
  for (const route of routes) if (!best.has(route.landing.network)) best.set(route.landing.network, route);
  if (best.size === 0) return null;
  const cost = (route: Route) => route.feesUsd + RANKING.timeUsdPerSecond * route.seconds;
  const ordered = [...best.values()].sort((a, b) => cost(a) - cost(b) || NETWORK_ORDER.indexOf(a.landing.network) - NETWORK_ORDER.indexOf(b.landing.network));
  const options: Option[] = ordered.slice(0, 8).map((route) => {
    const crosses = route.hops.some((hop) => hop.edge.kind === "bridge");
    const fee = costLabel(route.valueInUsd === null ? null : route.feesUsd, route.seconds);
    return {
      id: route.landing.network,
      label: networkLabel(route.landing.network),
      detail: clip(`${crosses ? `Bridges from ${networkLabel(route.source.node.network)}` : `From your ${route.source.node.symbol} there`} · ${fee}`, 96),
      value: { network: route.landing.network },
    };
  });
  const what = symbolOf(env.goal.want.asset) ?? symbolOf(env.goal.spend.asset) ?? "it";
  return question(field(env.index, "network"), "choice", "TRANSFER_NETWORK", clip(`Which network should ${recipient} receive the ${what} on? Cheapest first.`, 160),
    "An address may be used on only one network; sending on the wrong one can lose the funds. Kletia lists what each costs from your holdings.", options, true);
}

/** A step that runs after a bridge on a network where the person holds no gas. */
function gasWarnings(env: GoalEnv, route: Route): Assumption[] {
  const out: Assumption[] = [];
  route.hops.forEach((hop, step) => {
    if (step === 0) return;
    const previous = route.hops[step - 1];
    if (previous?.edge.kind !== "bridge" || previous.edge.gasTopup) return;
    const network = hop.edge.network;
    const native = CHAINS[network].nativeAsset.symbol;
    const holding = env.snapshot.holdings.find((entry) => entry.network === network && upper(entry.symbol) === upper(native));
    if (holding?.status !== "known" || (holding.formatted !== undefined && isDecimal(holding.formatted) && parseDecimal(holding.formatted) > 0n)) return;
    out.push(assumption(field(env.index + step, "network"), clip(`No ${native} on ${networkLabel(network)} for fees`, 48), { network }, "balance",
      `The ${hop.edge.kind} on ${networkLabel(network)} needs ${native} for network fees; you hold none there.`, [], true));
  });
  return out;
}

/* ---------------------------------------------------------------- entry */

/**
 * Solves `goals` over this turn's `snapshot`: their steps (with provenance),
 * chips and at most two questions. Throws PlatformError for a goal no route
 * can serve and no question can fix (D0).
 */
export function solveGoals(goals: readonly Goal[], snapshot: Snapshot, ctx: SolveContext): SolveResult {
  const graph = ctx.graph ?? capabilityGraph();
  const outcomes: GoalOutcome[] = [];
  const steps: WorkStep[] = [];
  const assumptions: Assumption[] = [];
  let questions: Question[] = [];
  let index = ctx.index ?? 0;
  goals.forEach((goal, position) => {
    if (questions.length > 0) {
      outcomes.push({ goal: position, status: "pending", steps: [], routes: [], landings: [], questions: [], assumptions: [] });
      return;
    }
    const after = goal.chain?.after ?? (goal.spend.amount?.t === "previous" && position > 0 ? position - 1 : undefined);
    let previous: GoalEnv["previous"];
    if (after !== undefined) {
      const outcome = outcomes[after];
      if (!outcome || outcome.status !== "ready") {
        outcomes.push({ goal: position, status: "pending", steps: [], routes: [], landings: [], questions: [], assumptions: [] });
        return;
      }
      if (outcome.routes.length !== 1) {
        throw new PlatformError("INTENT_UNSUPPORTED", "\"It\" refers to money moved in several transfers; say which asset and network to use.", 422, [{ path: "text", message: "Ambiguous reference." }]);
      }
      previous = { route: outcome.routes[0] as Route, outcome };
    }
    const env: GoalEnv = {
      goal: normalizeGoal(goal),
      position,
      index,
      ...(ctx.reads?.[position] ? { notes: ctx.reads[position] } : {}),
      ...(ctx.pins?.[position] ? { pins: ctx.pins[position] } : {}),
      snapshot,
      graph,
      ctx,
      ...(previous ? { previous } : {}),
    };
    const result = solveGoal(env);
    if (result.kind === "ask") {
      questions = result.questions.slice(0, MAX_QUESTIONS);
      const routes = result.routes ?? [];
      outcomes.push({ goal: position, status: "ask", steps: result.steps ?? [], routes, landings: landingsOf(routes), questions, assumptions: [] });
      return;
    }
    if (index + result.steps.length > THREAD_LIMITS.maxSteps) {
      throw new PlatformError("INTENT_UNSUPPORTED", `A task has at most ${THREAD_LIMITS.maxSteps} steps; split it into smaller tasks.`, 422, [{ path: "text", message: "Too many steps." }]);
    }
    outcomes.push({ goal: position, status: "ready", steps: result.steps, routes: result.routes, landings: landingsOf(result.routes), questions: [], assumptions: result.assumptions });
    steps.push(...result.steps);
    assumptions.push(...result.assumptions);
    index += result.steps.length;
  });
  const seen = new Set<string>();
  const unique = assumptions.filter((entry) => (seen.has(entry.id) ? false : (seen.add(entry.id), true)));
  const ordered = [...unique.filter((entry) => entry.material), ...unique.filter((entry) => !entry.material)];
  return { steps, assumptions: ordered, questions, outcomes };
}

/**
 * "consolidate my USDC on Base": a lone "on <network>" fills both sides (F3),
 * but a consolidation or a move never spends from where it lands.
 */
function normalizeGoal(goal: Goal): Goal {
  const from = goal.spend.from;
  if ((goal.kind === "consolidate" || goal.kind === "relocate") && from?.network && from.network === goal.want.at?.network && from.custody.kind === "wallet") {
    const { from: _from, ...spend } = goal.spend;
    return { ...goal, spend };
  }
  return goal;
}

/** Where the money lands after each step of the routes (the predicted journey). */
function landingsOf(routes: readonly Route[]): Landing[] {
  return routes.flatMap((route) => route.hops.map((hop) => hop.landing));
}

/** Re-exported for the journey drift check and tests. */
export { landingOf };
export type { Snapshot };

/** The goal's preference as the earn ranking reads it ("safest": tier first; "yield": raw 7-day rate). */
function yieldPreference(goal: Goal): "safest" | "yield" | undefined {
  const prefer: string | undefined = goal.constraints.prefer;
  return prefer === "safest" || prefer === "yield" ? prefer : undefined;
}
