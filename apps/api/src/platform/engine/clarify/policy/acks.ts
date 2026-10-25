/**
 * Placed actions, acknowledgements, chips and the plan decision.
 */
import {
  CHAINS,
  CLOSED_CLASS_REFUSAL_OF,
  isEvmAddress,
  type AssumptionSource,
  type ClarifyReason,
  type NetworkKey,
} from "@kletia/core";
import { PlatformError } from "../../../errors.js";
import {
  canonicalOn,
  decimalsOf,
  EVM_NETWORKS,
  lane,
  networkName,
  ownAddress,
  protocolLabel,
  stakeProvider,
} from "../catalog.js";
import {
  assumption,
  clip,
  closedClassRefusal,
  placeholderFor,
  question,
  short,
} from "../copy.js";
import type { DecisionFacts } from "../facts.js";
import {
  confirmPrompt,
  endStateDigest,
  gasSymbol,
  recipientLabel,
  settledAcks,
} from "../../solver/confirm.js";
import {
  GAS_TOPUP_USD,
  gasShortfalls,
  type GasShortfall,
} from "../../solver/gasNeeds.js";
import {
  invariantRefusal,
  readyViolations,
  spendsPrevious,
  type ActionMeta,
} from "../../solver/invariants.js";
import { EXACT_DELIVERY_PLANNED, movesReason } from "../../solver/moves.js";
import {
  formatDecimal,
  isDecimal,
  isPositive,
  parseDecimal,
} from "../decimal.js";
import { field } from "../edits.js";
import type {
  Analysis,
  Assumption,
  Kind,
  Option,
  Question,
  ResolvedAction,
  WorkState,
  WorkStep,
} from "../types.js";
import { dedupe, type Env, held, networkOption, STEP_VERBS } from "./env.js";

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
export interface AckNeed {
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
export function fundSource(step: WorkStep, kind: Kind, network: NetworkKey): NetworkKey | undefined {
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
export function contradictionQuestion(env: Env, index: number, step: WorkStep, previous: WorkStep | undefined, kind: Kind, network: NetworkKey, prevDest: NetworkKey, prevOut: string | undefined,
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
export function referenceQuestion(env: Env, index: number, step: WorkStep, prevDest: NetworkKey | undefined, prevOut: string | undefined): Question | null {
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

export function crossingChip(index: number, kind: Kind, from: NetworkKey, to: NetworkKey, asset: string, step: WorkStep, why: "dependent" | "said"): Assumption {
  const venue = step.protocol?.v ? protocolLabel(step.protocol.v) : step.provider?.v ? stakeProvider(step.provider.v)?.grammarProvider : undefined;
  const runs = venue ? `${venue} runs on ${networkName(to)}` : `this ${kind} runs on ${networkName(to)}`;
  return assumption(field(index, why === "dependent" ? "network" : "fundFrom"), `Bridges ${asset} ${networkName(from)} to ${networkName(to)} first`, { network: to }, "context",
    why === "dependent"
      ? `Step ${index}'s ${asset} is on ${networkName(from)}, and ${runs}. The route is picked by live quotes at planning.`
      : `You said the ${asset} is on ${networkName(from)}, and ${runs}. The route is picked by live quotes at planning.`,
    [], true);
}

export function crossingPaymentChip(index: number, recipient: string, from: NetworkKey, to: NetworkKey, asset: string, why: "dependent" | "said" | "answer" | "departure" | "auto"): Assumption {
  const source: AssumptionSource = why === "auto" ? "balance" : "context";
  const lead = why === "departure" ? `Your departure is ${networkName(from)}. ` : why === "auto" ? `${networkName(to)} does not hold enough; ${networkName(from)} does. ` : "";
  return assumption(field(index, "network"), `Pays ${recipientLabel(recipient)} on ${networkName(to)} from ${networkName(from)}`, { network: to }, source,
    `${lead}The ${asset} leaves ${networkName(from)} in one bridge that pays ${short(recipient)} on ${networkName(to)}; bridge fees come out of what arrives.`, [], true);
}

/** "Read as" chips (units, fractions, corrections the reader derived) and the "Ignored" chip of reviewed fillers. */
export function readingChips(steps: readonly WorkStep[]): Assumption[] {
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
export function closedClassBlock(steps: readonly WorkStep[]): PlatformError | null {
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

export function stakeInputAck(index: number, from: string, wanted: string, lst: string): AckNeed {
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
      : moves.kind === "computed"
        ? "Kletia computed these amounts from your goal. It lists every move before planning."
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
export function decidePlan(input: {
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

export function correctionAssumptions(state: WorkState): Assumption[] {
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
