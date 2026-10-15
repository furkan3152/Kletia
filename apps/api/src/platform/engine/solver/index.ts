/**
 * The Goal solver (intent engine v2 §4): `solveGoals(goals, snapshot, ctx)`
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
 * Goals after the first one that asks are left pending (the policy asks at
 * most two questions a turn). Pure and synchronous over the snapshot read
 * for this turn (snapshot.ts) and the capability graph; nothing is read,
 * signed or sent here. A goal no route can serve throws PlatformError (D0),
 * like the policy does for what no question can fix.
 */
import {
  CHAINS,
  GOAL_LIMITS,
  THREAD_LIMITS,
  type AssetSel,
  type Goal,
  type NetworkKey,
  type ThreadAmount,
} from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { BRIDGE_NETWORKS, hasAccount, isUsdWord, lane, laneOf, LOOKALIKES, NETWORK_ORDER, recipientFamily, symbolsOn, transferOnly, USD_ORDER } from "../clarify/catalog.js";
import { assumption, clip, question } from "../clarify/copy.js";
import { cmp, isDecimal, parseDecimal, sub, formatDecimal } from "../clarify/decimal.js";
import { field } from "../clarify/edits.js";
import type { Assumption, Option, Question, Slot, WorkStep } from "../clarify/types.js";
import type { GoalNotes } from "../goal/frames.js";
import type { EdgeKind } from "./costs.js";
import {
  ceilTo,
  chooseRoute,
  confirmQuestion,
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
import { amountLabel, costLabel, networkLabel, protocolName, SOLVER_CODES, solverWhy, usdLabel } from "./explain.js";
import { capabilityGraph, nodeMatchesAsset, nodeMatchesCustody, walletNodeId, type CapabilityGraph, type GraphNode } from "./graph.js";
import { landingOf, sameAsset, searchRoutes, stakeProviderFor, type Landing, type Route, type SearchSource, type SearchSpec } from "./search.js";
import { usablePrice, type Snapshot } from "./snapshot.js";

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
  /** Where the money lands after each step (§4.5). */
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
  switch (asset.class) {
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
  const swapOnly = goal.op === "swap" && !(goal.spend.from?.network && network && goal.spend.from.network !== network);
  switch (goal.kind) {
    case "convert":
      if (!want) return outputQuestion(env);
      return {
        kinds: k("swap", "bridge", "stake"),
        isTarget: (node, source) => node.custody.kind === "wallet" && nodeMatchesAsset(node, want) && !sameAsset(node, source.node) &&
          (network ? node.network === network : node.network === source.node.network || goal.spend.from?.network === undefined),
        allowBridge: !swapOnly,
        excludeSatisfied: false,
      };
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
        const current = accountLane(env.ctx.accounts);
        const listed = NETWORK_ORDER.filter((candidate) => lane(candidate) === current && hasAccount(env.ctx.accounts, candidate) &&
          [...env.graph.nodes.values()].some((node) => node.network === candidate && node.custody.kind === "wallet" && nodeMatchesAsset(node, wanted)));
        if (listed.length !== 1) return destinationQuestion(env, symbolOf(want) ?? "gas");
        where = listed[0];
      }
      return {
        kinds: goal.kind === "fuel" ? k("swap", "bridge") : k("swap", "bridge", "stake"),
        isTarget: (node) => node.custody.kind === "wallet" && node.network === where && nodeMatchesAsset(node, wanted),
        excludeSatisfied: true,
      };
    }
    case "rebalance":
    case "contract":
      throw noRouteError(goal);
  }
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

/** Positions an exit goal may leave (venue nodes), or a question when they could not be read. */
function positionSources(env: GoalEnv): SearchSource[] | Question {
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
  if (known.length > 0) return known;
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

function solveGoal(env: GoalEnv): Step {
  const { goal, notes, pins } = env;
  // D9, D1: before anything is searched.
  const typo = typoQuestion(notes, env.index);
  if (typo && !pins?.asset) return ask(typo);
  const recipient = recipientQuestion(goal, env.index);
  if (recipient) return ask(recipient);

  const problem = problemFor(env);
  if (!("kinds" in problem)) return ask(problem);

  // Sources: the previous goal's landing, positions, or holdings.
  const chained = env.previous !== undefined;
  let sources: SearchSource[];
  if (env.previous) {
    const landing = env.previous.route.landing;
    const node = env.graph.nodes.get(env.previous.route.hops[env.previous.route.hops.length - 1]?.to.id ?? env.previous.route.source.node.id);
    if (!node) throw noRouteError(goal);
    sources = [{ node, valueUsd: env.previous.route.valueOutUsd, amount: null, status: "unknown", position: landing.place.custody.kind === "venue" }];
  } else if (goal.kind === "exit" || goal.spend.from?.custody.kind === "position") {
    const positions = positionSources(env);
    if (!Array.isArray(positions)) return ask(positions);
    sources = positions;
  } else {
    sources = holdingSources(env);
  }
  if (problem.excludeSatisfied) sources = sources.filter((source) => !problem.isTarget(source.node, source));
  // Converting into an asset already held: those holdings are not what is spent ("convert my stablecoins to USDC").
  const wanted = goal.want.asset;
  if (goal.kind === "convert" && wanted && !symbolOf(goal.spend.asset)) sources = sources.filter((source) => !nodeMatchesAsset(source.node, wanted));
  if (goal.kind === "consolidate" && !goal.spend.asset && !pins?.asset) sources = sources.filter((source) => !source.node.isNative);

  const symbol = pins?.asset ?? symbolOf(goal.spend.asset) ?? classLabel(goal.spend.asset) ?? sources[0]?.node.symbol ?? symbolOf(goal.want.asset) ?? "funds";

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
  const assumptions: Assumption[] = [];
  let multi = goal.kind === "consolidate";
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

  const gasPrices = new Map<NetworkKey, number | null>();
  for (const node of env.graph.nodes.values()) {
    if (node.isNative && node.custody.kind === "wallet" && !gasPrices.has(node.network)) gasPrices.set(node.network, priceOf(env.snapshot, node));
  }
  const spec = (list: readonly SearchSource[]): SearchSpec => ({
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
    apy: (venueId) => env.snapshot.apy.get(venueId)?.apy ?? null,
    gasAssetUsd: (network) => gasPrices.get(network) ?? null,
    ...(env.ctx.gasPriceWei ? { gasPriceWei: env.ctx.gasPriceWei } : {}),
  });

  if (multi) return solveMulti(env, sources, spec, assumptions);

  // Fees are charged on what moves, not on the whole holding.
  const target = goal.want.amount?.t === "exact" && !goal.spend.amount && !chained ? goal.want.amount.value : null;
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

  const choice = chooseRoute({
    goal,
    index: env.index,
    routes,
    ...(pins ? { pins } : {}),
    assetNamed: goal.spend.asset !== undefined || pins?.asset !== undefined || chained,
    sourceNamed: goal.spend.from?.network !== undefined || pins?.source !== undefined || chained,
  });
  if (choice.kind === "ask") {
    if (choice.questions.length === 0) throw noRouteError(goal);
    return { kind: "ask", questions: choice.questions };
  }
  const route = choice.route;
  assumptions.push(...choice.assumptions);

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
  if (amount.assumption) assumptions.unshift(amount.assumption);

  const steps = expandRoute({
    goal,
    route,
    ...(amount.slot ? { amount: amount.slot } : {}),
    ...(goal.holder.t === "address" || goal.holder.t === "name" ? { recipient: goal.holder.value } : {}),
    chained,
  });
  assumptions.push(...gasWarnings(env, route));

  // D12 / D13: confirm a reading from word order or the LLM layer.
  const amountSaid = amount.slot?.v.t === "exact" ? amount.slot.v.value : undefined;
  const confirm = confirmQuestion({ goal, ...(notes ? { notes } : {}), ...(pins ? { pins } : {}), index: env.index, summary: describeRoute(route, amountSaid) });
  if (confirm) return { kind: "ask", questions: [confirm], steps, routes: [route] };
  return { kind: "ready", steps, routes: [route], assumptions };
}

/** Consolidate, or a possessive scope answered "all networks": one route per source, each moving all of it. */
function solveMulti(env: GoalEnv, sources: readonly SearchSource[], spec: (list: readonly SearchSource[]) => SearchSpec, assumptions: Assumption[]): Step {
  const { goal } = env;
  const ordered = [...sources].filter((source) => source.status === "known").sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0) || a.node.id.localeCompare(b.node.id));
  const routes: Route[] = [];
  const steps: WorkStep[] = [];
  const stays: string[] = [];
  const room = Math.max(0, THREAD_LIMITS.maxSteps - env.index);
  for (const source of ordered) {
    const found = searchRoutes(spec([source]));
    const label = `${amountLabel(source.amount ?? "0")} ${source.node.symbol} on ${networkLabel(source.node.network)}`;
    if (found.length === 0) {
      stays.push(label);
      continue;
    }
    const choice = chooseRoute({ goal, index: env.index + steps.length, routes: found, ...(env.pins ? { pins: env.pins } : {}), assetNamed: true, sourceNamed: true });
    if (choice.kind === "ask") {
      if (choice.questions.length === 0) {
        stays.push(label);
        continue;
      }
      return { kind: "ask", questions: choice.questions };
    }
    if (steps.length + choice.route.hops.length > room) {
      stays.push(label);
      continue;
    }
    const expanded = expandRoute({ goal, route: choice.route, amount: user(source.position ? { t: "position", bps: 10_000 } : { t: "balance", bps: 10_000 }) });
    // Each source's first step names its own asset and network: it is independent of the previous route.
    routes.push(choice.route);
    steps.push(...expanded);
    assumptions.push(...choice.assumptions.filter((entry) => !entry.id.endsWith(".network")));
  }
  if (routes.length === 0) throw noRouteError(goal);
  const where = goal.want.at?.network;
  assumptions.unshift(assumption(field(env.index, "amount"), clip(`Moves ${routes.map((route) => `${amountLabel(route.source.amount ?? "0")} ${route.source.node.symbol} from ${networkLabel(route.source.node.network)}`).join(", ")}`, 48),
    {}, "balance", clip(`${where ? `Everything that can reach ${networkLabel(where)}. ` : ""}${stays.length > 0 ? `Stays: ${stays.join(", ")} (no route or kept for network fees).` : "Gas tokens stay for network fees."}`, 160), [], true));
  return { kind: "ready", steps, routes, assumptions };
}

/** §4.5: a step that runs after a bridge on a network where the person holds no gas. */
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

/** Where the money lands after each step of the routes (the predicted journey, §4.5). */
function landingsOf(routes: readonly Route[]): Landing[] {
  return routes.flatMap((route) => route.hops.map((hop) => hop.landing));
}

/** Re-exported for the journey drift check (§4.5) and tests. */
export { landingOf };
export type { Snapshot };
