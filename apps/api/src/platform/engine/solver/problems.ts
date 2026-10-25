/**
 * Problems a goal poses (D1, D4, exposure classes) and their questions
 * and chips.
 */
import {
  CHAINS,
  EXPOSURE_ASSET_CLASSES,
  type AssetClass,
  type AssetSel,
  type ExposureAssetClass,
  type Goal,
  type NetworkKey,
} from "@kletia/core";
import {
  BRIDGE_NETWORKS,
  hasAccount,
  lane,
  NETWORK_ORDER,
  recipientFamily,
  symbolsOn,
  transferOnly,
} from "../clarify/catalog.js";
import { assumption, clip, question } from "../clarify/copy.js";
import { field } from "../clarify/edits.js";
import type { Assumption, Question } from "../clarify/types.js";
import { homeNetworks } from "./abstract.js";
import type { EdgeKind } from "./costs.js";
import { bestRatedStake, stakeProvidersOf } from "./yieldRank.js";
import { noRouteError, type GoalPins } from "./decide.js";
import { apyLabel, networkLabel } from "./explain.js";
import {
  capabilityGraph,
  nodeMatchesAsset,
  nodeMatchesCustody,
  type GraphNode,
} from "./graph.js";
import {
  sameAsset,
  stakeProviderFor,
  type Route,
  type SearchSource,
} from "./search.js";
import { accountLane, type GoalEnv, symbolOf, upper } from "./goalEnv.js";

/** The networks the person can receive on for a recipient (its address family, or Base for a .base.eth name). */
export function recipientNetworks(goal: Goal, accounts: readonly string[]): NetworkKey[] | null {
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
export function classLabel(asset: AssetSel | undefined): string | undefined {
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

export interface Problem {
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

export function destinationQuestion(env: GoalEnv, what: string): Question {
  const current = accountLane(env.ctx.accounts);
  const networks = BRIDGE_NETWORKS.filter((network) => lane(network) === current && hasAccount(env.ctx.accounts, network));
  return question(field(env.index, "toNetwork"), "choice", "DESTINATION_MISSING", `Which network should the ${what} arrive on?`, "The destination is where the money arrives.",
    networks.slice(0, 8).map((network) => ({ id: network, label: networkLabel(network), value: { network } })), true);
}

export function outputQuestion(env: GoalEnv): Question {
  const network = env.goal.want.at?.network ?? env.goal.spend.from?.network ?? "base";
  const options = symbolsOn(network).filter((symbol) => !transferOnly(network, symbol)).slice(0, 5).map((symbol) => ({ id: symbol, label: symbol, value: { asset: symbol } }));
  return question(field(env.index, "to"), "choice", "OUTPUT_ASSET_MISSING", "Which token should you end up with?", "Name the token you want to receive.", options, true);
}

/** The route problem of a goal, or a question for a gap no route can fill. */
export function problemFor(env: GoalEnv): Problem | Question {
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
export function isExposure(asset: AssetSel | undefined): boolean {
  return asset !== undefined && "class" in asset && (EXPOSURE_ASSET_CLASSES as readonly string[]).includes(asset.class);
}

/** The staked asset of a liquid staking exposure class, or null (btc). */
function exposureInput(asset: AssetSel | undefined): "ETH" | "SOL" | null {
  const cls = asset && "class" in asset ? (asset.class as string) : undefined;
  return cls === "eth-lst" ? "ETH" : cls === "sol-lst" ? "SOL" : null;
}

/** Exposure routes: those landing on the liquid staking token with the best compared 7-day rate for its risk first. */
export function exposureOrder(env: GoalEnv, routes: readonly Route[]): Route[] {
  const input = exposureInput(env.goal.want.asset);
  const readings = input ? env.snapshot.stakes?.get(input) : undefined;
  const best = input && readings && readings.length > 0 ? bestRatedStake(stakeProvidersOf(input), readings, yieldPreference(env.goal)) : undefined;
  if (!best) return [...routes];
  const lead = routes.filter((route) => upper(route.landing.symbol) === upper(best.lst));
  return [...lead, ...routes.filter((route) => !lead.includes(route))];
}

/** The chip of an exposure goal's landing token (material: the token held is Kletia's choice), with the other tokens reached. */
export function exposureChip(env: GoalEnv, route: Route, routes: readonly Route[]): Assumption | null {
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

/** The goal's preference as the earn ranking reads it ("safest": tier first; "yield": raw 7-day rate). */
export function yieldPreference(goal: Goal): "safest" | "yield" | undefined {
  const prefer: string | undefined = goal.constraints.prefer;
  return prefer === "safest" || prefer === "yield" ? prefer : undefined;
}
