/**
 * The policy entry point: analyze().
 */
import { CHAINS, type NetworkKey } from "@kletia/core";
import { PlatformError } from "../../../errors.js";
import { NATIVE_STAKE_PROTOCOL } from "../../grammar.js";
import {
  ambiguousVenue,
  bridgeNetworksOf,
  canonicalOn,
  defaultProvider,
  dexNetworks,
  family,
  hasAccount,
  isName,
  isUsdWord,
  l2StakeOptions,
  lane,
  laneOf,
  lendingProtocols,
  NETWORK_ORDER,
  networkName,
  ownAddress,
  protocolLabel,
  stakeProvider,
  STAKE_PROVIDERS,
  SWAP_NETWORKS,
  symbolsOn,
  transferOnly,
  venueNetworks,
  venuesOn,
} from "../catalog.js";
import {
  assumption,
  clip,
  PROTOCOL_QUESTION_COPY,
  question,
  reasonText,
} from "../copy.js";
import type { ActionMeta } from "../../solver/invariants.js";
import { expandGoalSteps } from "../goals.js";
import { typoQuestion } from "../../solver/decide.js";
import { apyLabel, smoothedApyLabel } from "../../solver/explain.js";
import { rankedByRate } from "../../solver/yieldRank.js";
import { isPositive } from "../decimal.js";
import { field, pendingEditQuestion } from "../edits.js";
import type {
  Assumption,
  FactsView,
  Question,
  ResolvedAction,
  TurnContext,
  WorkState,
  WorkStep,
} from "../types.js";
import {
  amountPhrase,
  dedupe,
  type Env,
  exactNeed,
  held,
  networkOption,
  refuseUnsupported,
  remember,
  swapCandidates,
  symbolOnNetwork,
  usdStable,
} from "./env.js";
import { checkAsset, networkContradiction } from "./assets.js";
import {
  type AmountChoice,
  recipientQuestion,
  resolveAmount,
  withIndependent,
} from "./amounts.js";
import {
  chooseNetwork,
  crossingSymbols,
  onlyPosition,
  wholeHolding,
} from "./networks.js";
import {
  analyzeContract,
  chooseVenue,
  exceedsBalance,
  SPENDING_KINDS,
  stakeChoice,
  typoOf,
  vaultRanking,
  VENUE_RATE_CODE,
} from "./venues.js";
import {
  type AckNeed,
  closedClassBlock,
  contradictionQuestion,
  correctionAssumptions,
  crossingChip,
  crossingPaymentChip,
  decidePlan,
  fundSource,
  type PlacedAction,
  type PolicyAnalysis,
  readingChips,
  referenceQuestion,
  stakeInputAck,
} from "./acks.js";

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
    // A vault Kletia picked by rate goes with that pick: a chip that changes the protocol leaves no stale vault behind.
    const vaultByRate = step.vault?.by === "assumed" && step.vault.why?.code === VENUE_RATE_CODE;
    let vault = pickedByRate || vaultByRate ? undefined : step.vault?.v;
    let provider = step.provider?.v;
    if (kind === "deposit" || kind === "withdraw") {
      if (!protocol && kind === "deposit") {
        // A venue-less deposit: the capability index's venues, ranked by tier, with live
        // rates. The best risk-adjusted rate among core and curated venues is picked and shown; asked only without rates.
        const pick = chooseVenue(env, index, step, network, from, dependent ? resolved[resolved.length - 1] : undefined);
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
      const venues = venuesOn(network, kind, protocol, from, vault);
      if (venues.length === 0) throw refuseUnsupported(`${protocolLabel(protocol)} does not take ${from} on ${networkName(network)}.`);
      if (vault && !venues.some((venue) => venue.slug === vault)) {
        throw refuseUnsupported(`${protocolLabel(protocol)} has no ${from} vault "${vault.slice(0, 32)}" on ${networkName(network)}.`);
      }
      if (!vault && venues.length > 1) {
        // A named protocol with several vaults: the vault with the best compared 7-day rate for its
        // risk; without one, the protocol's default vault. Either is a means, shown.
        const ranked = kind === "deposit" ? vaultRanking(env, network, protocol, from) : [];
        const best = ranked.find(rankedByRate);
        const pick = best?.venue ?? venues[0]!;
        vault = pick.slug;
        const rateOf = (slug: string) => ranked.find((entry) => entry.venue.slug === slug);
        assumptions.push(assumption(field(index, "venue"), best ? `${pick.name} · ${smoothedApyLabel(best)}` : pick.name, { venue: vault }, "default",
          best ? `The ${protocolLabel(protocol)} vault with the best 7-day rate for ${from} on ${networkName(network)} among those Kletia compared; rates are variable.`
            : `The default ${protocolLabel(protocol)} venue for ${from} on ${networkName(network)}.`,
          venues.filter((venue) => venue.slug !== pick.slug).map((venue) => {
            const entry = rateOf(venue.slug);
            return { id: venue.slug, label: entry && entry.compared && entry.smoothedApy !== null ? `${venue.name} · ${smoothedApyLabel(entry)}` : venue.name, value: { venue: venue.slug } };
          }), false));
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
        // An unnamed provider is the best compared 7-day rate net of the risk allowance; without readings, Kletia's default.
        const rated = !provider && network !== "solana-devnet" ? stakeChoice(env, input, network) : undefined;
        const chosen = stakeProvider(provider) ?? rated?.provider ?? (network === "solana-devnet" ? stakeProvider(NATIVE_STAKE_PROTOCOL) as NonNullable<ReturnType<typeof stakeProvider>> : defaultProvider(input));
        provider = chosen.id;
        remember(step, "provider", provider, { source: "default", code: "default.provider" });
        const others = STAKE_PROVIDERS.filter((entry) => entry.input === input && entry.id !== provider).map((entry) => {
          const rank = rated?.ranks.find((row) => row.provider === entry.id);
          return { id: entry.id, label: rank?.apy !== null && rank?.apy !== undefined ? `${entry.label} · ${apyLabel(rank.apy)} (7-day)` : entry.label, value: { provider: entry.id } };
        });
        assumptions.push(assumption(field(index, "provider"), rated ? `${chosen.label} · ${apyLabel(rated.best.apy)} (7-day)` : chosen.label, { provider }, "default",
          reasonText(rated ? "stake.rate" : "default.provider", { protocol: chosen.grammarProvider, symbol: input }), others, true));
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
