/**
 * Gas consequences: gas to continue and gas to leave.
 */
import { CHAINS, type NetworkKey } from "../chains.js";
import { nativeAssetId, sameAddressAccount } from "../caip.js";
import { getProtocol } from "../protocols.js";
import { isOwnRequestAccount } from "../flow.js";
import type { IntentGraph, IntentRequest, IntentStep } from "../intent.js";
import type { JourneyCertainty } from "./constants.js";
import {
  JOURNEY_LIMITS,
  type JourneyFacts,
  type JourneyOption,
} from "./types.js";
import {
  actionsRequest,
  addressOf,
  cents,
  destinationOf,
  type Draft,
  GAS_LEG_COST_USD,
  holderOf,
  isCross,
  isNativeOf,
  nativeKey,
  nativeRef,
  networkName,
  nonNegative,
  OK_OPTION,
  option,
  priceFact,
  symbolText,
  timeOf,
  TOPUP_OVERHEAD_USD,
  UNSIGNED_STATUSES,
  venueName,
  view,
  wholeUnits,
} from "./helpers.js";
import type { Walk } from "./walk.js";
import { actionsFromGraph } from "./continuation.js";

function priceOfNative(facts: JourneyFacts, network: NetworkKey): number | null {
  return priceFact(facts, nativeAssetId(network))?.usd ?? null;
}

function unitsUsd(units: bigint, decimals: number, price: number | null): number | null {
  return price === null ? null : wholeUnits(units, decimals) * price;
}

function topupRequest(graph: IntentGraph, network: NetworkKey, usd: string): IntentRequest {
  const constraints = graph.request.constraints ?? {};
  return { ...graph.request, constraints: { ...constraints, gasOnArrival: { ...(constraints.gasOnArrival ?? {}), [network]: usd } } };
}

function topupUsd(needUsd: number | null, exitUsd: number | null): string {
  if (needUsd === null) return "0.50";
  const raw = Math.ceil(3 * (needUsd + (exitUsd ?? 0)) * 100) / 100;
  const clamped = Math.min(JOURNEY_LIMITS.topupMaxUsd, Math.max(JOURNEY_LIMITS.topupMinUsd, raw));
  return clamped.toFixed(2);
}

/** Wallet legs of own accounts not signed yet, by `${network}:${address}`, in order. */
function unsignedLegsByAccount(walk: Walk): Map<string, IntentStep[]> {
  const out = new Map<string, IntentStep[]>();
  for (const step of walk.order) {
    if (step.mode !== "wallet" || !UNSIGNED_STATUSES.has(step.status) || (step.references?.length ?? 0) > 0) continue;
    if (!isOwnRequestAccount(walk.graph, step.account)) continue;
    const key = nativeKey(step.network, step.account);
    out.set(key, [...(out.get(key) ?? []), step]);
  }
  return out;
}

/** Gas-asset units earlier unsettled legs deliver to `account` on `network` (top-ups, reserves, kept gas-asset outputs). */
function deliveredGas(walk: Walk, network: NetworkKey, account: string, beforeIndex: number): bigint {
  let total = 0n;
  walk.order.forEach((step, index) => {
    if (index >= beforeIndex || step.status === "settled" || step.status === "failed" || step.status === "skipped") return;
    if (destinationOf(step) !== network || !sameAddressAccount(holderOf(walk.graph, step), `${CHAINS[network].id}:${addressOf(account)}`)) return;
    const stop = walk.byId.get(`out:${step.id}`);
    for (const entry of stop?.holdings ?? []) {
      if (!isNativeOf(entry.asset.asset, network)) continue;
      if (entry.role === "gas" || entry.role === "kept") total += BigInt(entry.atLeast.amount);
    }
  });
  return total;
}

/** The first unsettled cross-network leg arriving on `network` for the account (where a top-up or gas leg attaches). */
function arrivingLeg(walk: Walk, network: NetworkKey, account: string): IntentStep | null {
  return walk.order.find((step) =>
    isCross(step) && destinationOf(step) === network && step.status !== "settled" && step.status !== "skipped" &&
    sameAddressAccount(holderOf(walk.graph, step), `${CHAINS[network].id}:${addressOf(account)}`)) ?? null;
}

interface GasFinding {
  readonly network: NetworkKey;
  readonly account: string;
  readonly stopId: string;
  readonly legIds: string[];
  readonly need: bigint;
  readonly have: bigint | null;
  readonly fees: bigint;
}

function gasOptions(walk: Walk, network: NetworkKey, account: string, need: bigint, have: bigint | null): JourneyOption[] {
  const { facts, graph } = walk;
  const native = nativeRef(network);
  const price = priceOfNative(facts, network);
  const options: JourneyOption[] = [];
  const leg = arrivingLeg(walk, network, account);
  const capability = leg ? facts.gasOptions[leg.id] : undefined;
  const chain = CHAINS[network];
  const needUsd = unitsUsd(need, native.decimals, price);
  const exit = facts.exitFees[network];
  const exitUsd = exit && /^\d+$/u.test(exit) ? unitsUsd(BigInt(exit), native.decimals, price) : null;
  if (leg && capability?.topup && chain.vm === "evm") {
    const usd = topupUsd(needUsd, exitUsd);
    const delivered = price ? view(BigInt(Math.floor((Number(usd) / price) * 10 ** native.decimals)), native.decimals) : null;
    options.push(option(
      "gas-topup",
      `Add ${usd === "0.50" && needUsd === null ? "about $0.50" : `$${usd}`} of ${native.symbol} with the ${venueName(leg)} leg`,
      `${venueName(leg)} delivers ${delivered ? `about ${symbolText(delivered, native.symbol)}` : `$${usd} of ${native.symbol}`} on ${chain.name} with the fill; it costs about $${(Number(usd) + TOPUP_OVERHEAD_USD).toFixed(2)} from the bridged amount and re-plans the intent.`,
      { type: "replan", request: topupRequest(graph, network, usd) },
      cents(Number(usd) + TOPUP_OVERHEAD_USD),
      true,
    ));
  }
  const gasLeg = capability?.gasLeg ?? null;
  const actions = actionsFromGraph(graph);
  if (gasLeg && actions && !(leg && capability?.topup && chain.vm === "evm")) {
    options.push(option(
      "gas-leg",
      `Bridge $${JOURNEY_LIMITS.gasLegUsd} into ${native.symbol} first`,
      `A small ${getProtocol(gasLeg.protocol ?? "relay")?.name ?? "Relay"} bridge of $${JOURNEY_LIMITS.gasLegUsd} of the first leg's input into ${native.symbol} on ${chain.name} runs before the main leg: one more signature, about $${GAS_LEG_COST_USD.toFixed(2)} in fees, and $${JOURNEY_LIMITS.gasLegUsd} less of the input for the rest.`,
      { type: "replan", request: actionsRequest(graph, [gasLeg, ...actions]) },
      cents(JOURNEY_LIMITS.gasLegUsd + GAS_LEG_COST_USD),
      options.length === 0,
    ));
  }
  const needText = symbolText(view(need, native.decimals), native.symbol);
  options.push(option(
    "bring-gas",
    `I will bring ${native.symbol} myself`,
    `Send at least ${needText} to your ${chain.name} wallet before that step${have !== null ? `; it holds ${symbolText(view(have, native.decimals), native.symbol)} now` : ""}.`,
    { type: "acknowledge" },
    needUsd === null ? null : cents(needUsd),
  ));
  return options;
}

/** R1 gas to continue, and the per-network findings R2 skips. */
export function ruleGasToContinue(walk: Walk, drafts: Draft[]): Set<NetworkKey> {
  const fired = new Set<NetworkKey>();
  const { facts } = walk;
  const byAccount = unsignedLegsByAccount(walk);
  if (facts.reads === "none") {
    const networks = [...new Set([...byAccount.keys()].map((key) => key.slice(0, key.indexOf(":")) as NetworkKey))];
    if (networks.length > 0) {
      drafts.push({
        id: "gas-to-continue:reads-none",
        kind: "gas-to-continue",
        severity: "info",
        stopId: null,
        legIds: [...byAccount.values()].flat().map((step) => step.id),
        title: `Connect your wallets to check gas on ${networks.map(networkName).join(" and ")}`,
        detail: "Balances were not read for these accounts, so Kletia cannot tell whether every step can pay its network fee.",
        certainty: "estimated",
        facts: {},
        source: "No account reads (demo or indicative)",
        options: [],
      });
    }
    return new Set(networks);
  }
  for (const [key, legs] of byAccount) {
    const first = legs[0] as IntentStep;
    const network = first.network;
    const native = nativeRef(network);
    const have = facts.native[key];
    let fees = 0n;
    let need = 0n;
    const short: string[] = [];
    let unknownFee = false;
    for (const leg of legs) {
      const fee = facts.fees[leg.id];
      if (!fee || !/^\d+$/u.test(fee.amount)) {
        unknownFee = true;
        continue;
      }
      fees += BigInt(fee.amount);
      if (have === null || have === undefined) continue;
      const index = walk.order.indexOf(leg);
      const available = BigInt(have.amount) + deliveredGas(walk, network, leg.account, index);
      if (available < fees) {
        if (fees - available > need) need = fees - available;
        short.push(leg.id);
      }
    }
    const stopId = walk.inputStop.get(first.id) ?? `start:${first.id}`;
    const certainty: JourneyCertainty = legs.some((leg) => facts.fees[leg.id]?.certainty === "estimated") ? "estimated" : (facts.fees[first.id]?.certainty ?? "estimated");
    if (have === null || have === undefined) {
      fired.add(network);
      drafts.push({
        id: `gas-to-continue:${stopId}`,
        kind: "gas-to-continue",
        severity: "warn",
        stopId,
        legIds: legs.map((leg) => leg.id),
        title: `Could not read your ${native.symbol} balance on ${networkName(network)}`,
        detail: `The steps on ${networkName(network)} need about ${symbolText(view(fees, native.decimals), native.symbol)} for network fees; your balance there could not be read, so check it before you sign.`,
        certainty,
        facts: { fees: fees.toString() },
        source: `${networkName(network)} RPC read failed at ${timeOf(facts.at)}`,
        options: gasOptions(walk, network, first.account, fees, null),
      });
      continue;
    }
    if (need === 0n) continue;
    fired.add(network);
    const needText = symbolText(view(need, native.decimals), native.symbol);
    const legNumbers = short.map((id) => walk.order.findIndex((step) => step.id === id) + 1);
    const which = legNumbers.length === 1 ? `step ${legNumbers[0]}` : `steps ${legNumbers.join(", ")}`;
    const options = gasOptions(walk, network, first.account, need, BigInt(have.amount));
    drafts.push({
      id: `gas-to-continue:${stopId}`,
      kind: "gas-to-continue",
      severity: "block",
      stopId,
      legIds: short,
      title: `${networkName(network)} needs ${needText} more for network fees`,
      detail: `Your ${networkName(network)} wallet holds ${symbolText(view(BigInt(have.amount), native.decimals), native.symbol)}; ${which} cannot be signed without about ${needText} more${unknownFee ? " (some fees could not be estimated)" : ""}. Nothing tops up on its own.`,
      certainty,
      facts: { need: need.toString(), have: have.amount, fees: fees.toString() },
      source: `${networkName(network)} balance read at ${timeOf(have.at)}; fees ${certainty === "estimated" ? "estimated" : "from the simulation"}`,
      options,
      question: `How should the network fee on ${networkName(network)} be paid?`,
    });
  }
  return fired;
}

/** R2 gas to leave: an end stop holding no gas asset where no gas is left after the journey. */
export function ruleGasToLeave(walk: Walk, drafts: Draft[], skip: ReadonlySet<NetworkKey>): void {
  const { facts } = walk;
  if (facts.reads === "none") return;
  const seen = new Set<string>();
  for (const stop of walk.stops) {
    if (stop.kind !== "end" || stop.state === "skipped" || !stop.holder.own || (stop.custody !== "wallet" && stop.custody !== "venue")) continue;
    if (skip.has(stop.network) || !stop.holder.account) continue;
    const main = stop.holdings.find((entry) => entry.role !== "gas");
    if (!main || isNativeOf(main.asset.asset, stop.network)) continue;
    const key = nativeKey(stop.network, stop.holder.account);
    if (seen.has(key)) continue;
    seen.add(key);
    const have = facts.native[key];
    const exit = facts.exitFees[stop.network];
    if (!have || !exit || !/^\d+$/u.test(exit)) continue;
    const delivered = deliveredGas(walk, stop.network, stop.holder.account, walk.order.length);
    const spent = walk.order
      .filter((step) => step.mode === "wallet" && UNSIGNED_STATUSES.has(step.status) && nativeKey(step.network, step.account) === key)
      .reduce((total, step) => total + (facts.fees[step.id] && /^\d+$/u.test(facts.fees[step.id]!.amount) ? BigInt(facts.fees[step.id]!.amount) : 0n), 0n);
    const left = BigInt(have.amount) + delivered - spent;
    if (left >= BigInt(exit)) continue;
    const native = nativeRef(stop.network);
    const options = gasOptions(walk, stop.network, stop.holder.account, nonNegative(BigInt(exit) - left), BigInt(have.amount))
      .filter((entry) => entry.id !== "bring-gas");
    drafts.push({
      id: `gas-to-leave:${stop.id}`,
      kind: "gas-to-leave",
      severity: "warn",
      stopId: stop.id,
      legIds: [],
      title: `No ${native.symbol} left on ${networkName(stop.network)} to move ${main.asset.symbol} later`,
      detail: `After this journey your ${networkName(stop.network)} wallet holds about ${symbolText(view(nonNegative(left), native.decimals), native.symbol)}; moving the ${main.asset.symbol} again needs about ${symbolText(view(BigInt(exit), native.decimals), native.symbol)}.`,
      certainty: "estimated",
      facts: { left: nonNegative(left).toString(), exitFee: exit, have: have.amount },
      source: `${networkName(stop.network)} balance read at ${timeOf(have.at)}; exit fee estimated`,
      options: [...options, OK_OPTION],
    });
  }
}
