/**
 * Network choice: where a step runs, transfer placement and network
 * assumptions.
 */
import {
  parseAccountId,
  type AssumptionSource,
  type NetworkKey,
  type ThreadAmount,
  YIELD_VENUES,
} from "@kletia/core";
import { PlatformError } from "../../../errors.js";
import {
  ambiguousVenue,
  BRIDGE_NETWORKS,
  bridgeNetworksOf,
  canonicalOn,
  defaultProvider,
  dexNetworks,
  EVM_NETWORKS,
  family,
  hasAccount,
  lane,
  laneOf,
  NETWORK_ORDER,
  networkName,
  portable,
  protocolLabel,
  recipientFamily,
  stakeProvider,
  venueNetworks,
} from "../catalog.js";
import {
  assumption,
  placeholderFor,
  question,
  reasonText,
  short,
  isReasonCode,
  type ReasonCode,
  type ReasonParams,
} from "../copy.js";
import { MAX_POSITION_READS } from "../facts.js";
import { cmp, isPositive, tidy } from "../decimal.js";
import { field } from "../edits.js";
import type { Assumption, Kind, Option, Question, WorkStep } from "../types.js";
import {
  amountPhrase,
  byLargest,
  type Env,
  exactNeed,
  funding,
  held,
  holdDetail,
  networkOption,
  refuseUnsupported,
  remember,
  swapCandidates,
  symbolOnNetwork,
} from "./env.js";

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
export function chooseNetwork(env: Env, index: number, step: WorkStep, prevDest: NetworkKey | undefined, prevOut: string | undefined): NetworkChoice {
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
export function wholeHolding(env: Env, step: WorkStep): void {
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
export function onlyPosition(env: Env, index: number, step: WorkStep): { symbol: string; assumption: Assumption } | null {
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
