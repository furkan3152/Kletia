/**
 * Registered-contract clauses, typos, balance limits and venue choice.
 */
import {
  CHAINS,
  protocolTier,
  NATIVE_FEE_RESERVE,
  type NetworkKey,
  type ProtocolId,
  type ThreadAmount,
  type YieldVenue,
} from "@kletia/core";
import { matchContractPhrase } from "../../grammar.js";
import {
  bridgeNetworksOf,
  canonicalOn,
  decimalsOf,
  hasAccount,
  laneOf,
  networkName,
  portable,
  protocolLabel,
  rankedVenueOptions,
  stakeProvider,
  type StakeProvider,
  venueCandidates,
  venuesOn,
} from "../catalog.js";
import {
  assumption,
  placeholderFor,
  PROTOCOL_QUESTION_COPY,
  question,
  reasonText,
} from "../copy.js";
import type { DecisionFacts } from "../facts.js";
import { symbolTypoCandidates } from "../../goal/lexer.js";
import { riskLabel, smoothedApyLabel } from "../../solver/explain.js";
import { typicalTxUsd } from "../../solver/search.js";
import {
  bestRatedStake,
  migrationVerdict,
  rankedByRate,
  rankStakeReadings,
  rankYieldReadings,
  stakeProvidersOf,
  type RankedStakeProvider,
  type RankedYieldVenue,
  type YieldReading,
} from "../../solver/yieldRank.js";
import { cmp, formatDecimal, isDecimal, tidy } from "../decimal.js";
import { field } from "../edits.js";
import { candidates } from "../fuzzy.js";
import type {
  Assumption,
  Kind,
  Option,
  Question,
  ResolvedAction,
  WorkStep,
} from "../types.js";
import {
  amountPhrase,
  type Env,
  held,
  networkOption,
  refuseUnsupported,
  spendable,
} from "./env.js";
import { amountQuestion } from "./amounts.js";
import { crossingSymbols } from "./networks.js";

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
export function analyzeContract(env: Env, index: number, step: WorkStep, prevDest: NetworkKey | undefined): { question?: Question; action?: ResolvedAction } {
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
export const VENUE_RATE_CODE = "venue.rate";
/**
 * Kinds whose exact amount is checked against the balance where the step
 * spends it (D2). A payment too: its money is where it is sent from,
 * which the policy decides (transferPlacement), so "Use funds on N"
 * becomes one crossing leg that pays the recipient.
 */
export const SPENDING_KINDS: ReadonlySet<Kind> = new Set(["swap", "bridge", "deposit", "stake", "transfer"]);

/** D9: a typed symbol within one edit of listed ones and not itself listed ("SLO"), which the fuzzy reader leaves alone. */
export function typoOf(step: WorkStep): { side: "spend" | "want"; raw: string; candidates: string[] } | null {
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
export function exceedsBalance(env: Env, index: number, step: WorkStep, kind: Kind, network: NetworkKey, from: string, need: string, receiving: NetworkKey = network): Question | null {
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

/** The previous step's venue when this deposit moves a position on the same network (a migration). */
function migrationSource(previous: ResolvedAction | undefined, network: NetworkKey, from: string): YieldVenue | undefined {
  if (!previous || previous.kind !== "withdraw" || previous.network !== network || !previous.protocol) return undefined;
  if (canonicalOn(network, previous.from)?.toUpperCase() !== canonicalOn(network, from)?.toUpperCase()) return undefined;
  const venues = venuesOn(network, "withdraw", previous.protocol, from);
  return venues.find((venue) => !previous.vault || venue.slug === previous.vault) ?? venues[0];
}

/** USD of what a deposit puts in (ranking only): an exact amount, or the previous withdrawal's position; undefined when unknown. */
function depositUsd(env: Env, step: WorkStep, network: NetworkKey, from: string, previous: ResolvedAction | undefined): number | undefined {
  let amount: string | undefined;
  if (step.amount?.v.t === "exact") amount = step.amount.v.value;
  else if (step.amount?.v.t === "previous" && previous?.kind === "withdraw" && previous.protocol) {
    amount = previous.amount === "max" ? env.facts.position(network, previous.protocol, from) : previous.amount;
  }
  if (amount === undefined || !isDecimal(amount)) return undefined;
  const price = (env.facts as DecisionFacts).usdPrice?.(network, from)?.usd;
  const value = price === undefined ? undefined : Number(amount) * price;
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * D6 for a venue-less deposit: every venue of the asset on the network is
 * ranked on its smoothed rate net of the tier's risk allowance
 * (`solver/yieldRank.ts`) before any list is cut. The best compared venue is
 * picked and shown (a chip with the other venues); without a compared venue it
 * is asked (VENUE_MISSING), never picked on an instantaneous rate. A deposit
 * that moves a position here (a withdrawal from a venue on the same network
 * just before) never returns to that venue and must beat it by more than the
 * gas of switching, else it is refused.
 */
export function chooseVenue(env: Env, index: number, step: WorkStep, network: NetworkKey, from: string, previous?: ResolvedAction): { protocol?: string; vault?: string; assumption?: Assumption; question?: Question } {
  const candidates = venueCandidates(network, "deposit", from);
  if (candidates.length === 0) throw refuseUnsupported(`No lending venue takes ${from} on ${networkName(network)}.`);
  const facts = env.facts as DecisionFacts;
  // A facts view without full readings (fixtures) knows the current rate only: nothing is compared on it.
  const readingOf = (venue: YieldVenue): YieldReading | null | undefined => {
    if (facts.venueReading) return facts.venueReading(venue.id);
    const apy = env.facts.venueApy?.(venue.id);
    return apy === undefined ? undefined : { status: "known", apy, smoothedApy: null, tvlUsd: null, capRemaining: null, paused: false, frozen: false };
  };
  const source = migrationSource(previous, network, from);
  const amountUsd = depositUsd(env, step, network, from, previous);
  // "somewhere safe" / "the highest apy": the reader's preference when the step still carries its Goal ("safest": tier
  // first; "yield": raw 7-day rate). A lowered step without its Goal ranks by the risk-adjusted rate.
  const preferred: string | undefined = step.goal?.constraints.prefer;
  const prefer = preferred === "safest" || preferred === "yield" ? preferred : undefined;
  const ranked = rankYieldReadings({
    network, ...(amountUsd !== undefined ? { amountUsd } : {}), ...(prefer ? { prefer } : {}), ...(source ? { excludeVenueIds: [source.id] } : {}),
  }, candidates, readingOf);
  const vaultOf = (venue: YieldVenue) => (venuesOn(network, "deposit", venue.protocol, from).length > 1 ? venue.slug : undefined);
  const valueOf = (venue: YieldVenue) => ({ protocol: venue.protocol, ...(vaultOf(venue) ? { venue: vaultOf(venue) } : {}) });
  // The best entry of each protocol, in ranked order (option ids are protocol ids).
  const perProtocol = (entries: readonly RankedYieldVenue[]) => entries.filter((entry, i) => entries.findIndex((other) => other.venue.protocol === entry.venue.protocol) === i);
  const ask = (why: string) => {
    const shown = rankedVenueOptions(network, "deposit", from, 8)
      .filter((venue) => venue.protocol !== source?.protocol || venuesOn(network, "deposit", venue.protocol, from).length > 1)
      .slice(0, 4);
    const options = shown.map((venue, i) => {
      const entry = ranked.find((row) => row.venue.protocol === venue.protocol);
      const pick = entry?.venue ?? venue;
      return {
        id: venue.protocol, label: protocolLabel(venue.protocol), detail: `${pick.name} · ${riskLabel(protocolTier(venue.protocol as ProtocolId, network) as never)} · ${entry ? smoothedApyLabel(entry) : "rate not compared"}`,
        value: valueOf(pick), ...(i === 0 ? { recommended: true as const } : {}),
      };
    });
    const copy = PROTOCOL_QUESTION_COPY.venueMissing(amountPhrase(step, from), networkName(network));
    return { question: question(field(index, "protocol"), "choice", "VENUE_MISSING", copy.prompt, `${copy.why} ${why}`, options, false) };
  };
  let best = ranked.find((entry) => entry.compared);
  if (!best) return ask("Rates could not be compared right now.");
  if (source) {
    const verdict = migrationVerdict({ ranked, source, sourceReading: readingOf(source), amountUsd: amountUsd ?? null, switchingGasUsd: 3 * typicalTxUsd(network) });
    if (!verdict.move) {
      if (verdict.reason === "not-compared") return ask(verdict.why);
      throw refuseUnsupported(`${verdict.why} Kletia does not move a position for no gain; name the venue to move it anyway.`);
    }
    best = verdict.target;
  }
  const chosen = best;
  const vault = vaultOf(chosen.venue);
  step.protocol = { v: chosen.venue.protocol, by: "assumed", why: { source: "default", code: VENUE_RATE_CODE } };
  if (vault) step.vault = { v: vault, by: "assumed", why: { source: "default", code: VENUE_RATE_CODE } };
  else delete step.vault;
  const alternatives = perProtocol(ranked.filter((entry) => entry.venue.protocol !== chosen.venue.protocol && entry.capacityOk !== false)).slice(0, 4).map((entry) => ({
    id: entry.venue.protocol, label: `${protocolLabel(entry.venue.protocol)} · ${smoothedApyLabel(entry)}`, detail: `${entry.venue.name} · ${riskLabel(entry.tier as never)}`,
    value: valueOf(entry.venue),
  }));
  const byRate = rankedByRate(chosen);
  return {
    protocol: chosen.venue.protocol,
    ...(vault ? { vault } : {}),
    assumption: assumption(field(index, "protocol"), `${chosen.venue.name} · ${smoothedApyLabel(chosen)}`, valueOf(chosen.venue), "default",
      reasonText(byRate ? VENUE_RATE_CODE : "venue.only", { protocol: protocolLabel(chosen.venue.protocol), kind: riskLabel(chosen.tier as never) }), alternatives, true),
  };
}

/** The vaults of a named protocol ranked on their 7-day rates; [] while unread. */
export function vaultRanking(env: Env, network: NetworkKey, protocol: string, from: string): RankedYieldVenue[] {
  const facts = env.facts as DecisionFacts;
  if (!facts.venueReading) return [];
  const candidates = venueCandidates(network, "deposit", from).filter((venue) => venue.protocol === protocol);
  return rankYieldReadings({ network, protocol: protocol as ProtocolId }, candidates, (venue) => facts.venueReading?.(venue.id));
}

/** The best compared staking provider of `input` on `network`, or undefined (no readings: the default stays). */
export function stakeChoice(env: Env, input: "SOL" | "ETH", network: NetworkKey): { provider: StakeProvider; best: RankedStakeProvider; ranks: readonly RankedStakeProvider[] } | undefined {
  const readings = (env.facts as DecisionFacts).stakeReadings?.(input);
  if (!readings || readings.length === 0) return undefined;
  const providers = stakeProvidersOf(input, network);
  const best = bestRatedStake(providers, readings);
  const provider = best ? stakeProvider(best.provider) : undefined;
  return best && provider ? { provider, best, ranks: rankStakeReadings(providers, readings) } : undefined;
}
