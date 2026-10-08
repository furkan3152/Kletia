/**
 * Intent planner: IntentRequest -> IntentGraph.
 *
 * 1. Validate the request; compile text with the deterministic grammar or
 *    accept structured actions.
 * 2. Normalise actions (kinds, networks, amounts, capital lane).
 * 3. Resolve assets, accounts and recipients per step; bind each step to an
 *    adapter (respecting prefer/avoid constraints) and quote it.
 * 4. Chain dependent amounts from the previous step's guaranteed minimum.
 * 5. Merge "bridge then swap everything on the destination" into a single
 *    Relay cross-network swap when possible.
 * 6. Assemble steps, edges, summary and warnings; enforce fee limits; validate.
 */
import {
  CHAINS,
  counterpartAsset,
  deriveIntentStatus,
  findAssetBySymbol,
  fromBaseUnits,
  getAsset,
  INTENT_SPEC_VERSION,
  parseAccountId,
  sameCapitalLane,
  toBaseUnits,
  validateIntentGraph,
  validateIntentRequest,
  type AssetAmount,
  type IntentActionKind,
  type IntentActionSpec,
  type IntentEdge,
  type IntentGraph,
  type IntentRequest,
  type IntentStep,
  type IntentSummary,
  type NetworkKey,
  type ParsedAccountId,
  type ProtocolId,
} from "@kletia/core";
import { PlatformError, unsupported } from "../errors.js";
import { accountForNetwork, parseAccounts, recipientForNetwork, sameAddress } from "./accounts.js";
import { candidateAdapters } from "./adapters/registry.js";
import { RELAY_NETWORKS } from "./adapters/relay.js";
import type { AdapterAction, AdapterRoute, PlannedStep, ProtocolAdapter } from "./adapters/types.js";
import { assetFromRef, resolveAsset, sameAsset, type ResolvedAsset } from "./assets.js";
import { compileIntentText, GRAMMAR_EXAMPLES, LIQUID_STAKING_TOKENS } from "./grammar.js";
import { decodeStepRef, encodeStepRef } from "./stepRef.js";
import { newIntentId, portionOf, roundUsd } from "./util.js";

export const DEFAULT_SLIPPAGE_BPS = 50;
export const INTENT_TTL_MS = 30 * 60 * 1000;

const SUPPORTED_KINDS: readonly IntentActionKind[] = ["swap", "transfer", "bridge", "stake", "deposit"];
const STAKE_PROTOCOLS: Readonly<Partial<Record<ProtocolId, string>>> = {
  jito: "jito",
  marinade: "marinade",
  sanctum: "jupiter",
  jupiter: "jito",
};

type AmountSpec = { readonly type: "exact"; readonly value: string } | { readonly type: "previous"; readonly portionBps: number };

/** An action after normalisation, before assets are resolved. */
export interface NormalizedAction {
  readonly index: number;
  readonly kind: IntentActionKind;
  readonly network: NetworkKey;
  readonly destinationNetwork: NetworkKey;
  readonly amount: AmountSpec;
  readonly from?: string;
  readonly to?: string;
  readonly recipient?: string;
  readonly protocol?: ProtocolId;
  readonly provider?: string;
}

export interface PlanOptions {
  readonly now?: number;
  readonly id?: string;
}

function issue(path: string, message: string) {
  return [{ path, message }];
}

function portionFrom(spec: IntentActionSpec, path: string): number {
  const raw = spec.params?.portionBps;
  if (raw === undefined) return 10_000;
  const value = typeof raw === "string" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 10_000) {
    throw new PlatformError("INVALID_REQUEST", "params.portionBps must be an integer between 1 and 10000.", 400, issue(`${path}.params.portionBps`, "Out of range."));
  }
  return value;
}

/** Normalises structured or grammar-produced actions and enforces one capital lane. */
export function normalizeActions(actions: readonly IntentActionSpec[], request: IntentRequest): NormalizedAction[] {
  const normalized = actions.map((spec, index): NormalizedAction => {
    const path = `actions[${index}]`;
    let kind = spec.kind;
    if (!SUPPORTED_KINDS.includes(kind)) {
      throw unsupported(
        `"${kind}" intents are not executable yet. Supported: swap, transfer, bridge, stake (SOL liquid staking), deposit (Aave V3).`,
        GRAMMAR_EXAMPLES,
        issue(`${path}.kind`, "Unsupported action kind."),
      );
    }
    if (spec.amount === undefined) {
      throw new PlatformError("AMOUNT_REQUIRED", "Every action needs an amount (decimal or \"max\").", 400, issue(`${path}.amount`, "Required."));
    }
    const amount: AmountSpec = spec.amount === "max"
      ? { type: "previous", portionBps: portionFrom(spec, path) }
      : { type: "exact", value: spec.amount };
    if (amount.type === "previous" && index === 0) {
      throw unsupported(
        "\"max\" means the output of the previous step, so the first action needs an explicit amount.",
        GRAMMAR_EXAMPLES,
        issue(`${path}.amount`, "No previous step."),
      );
    }
    let destinationNetwork = spec.toNetwork ?? spec.network;
    if (kind === "swap" && destinationNetwork !== spec.network) kind = "bridge";
    if (kind !== "bridge") destinationNetwork = spec.network;
    if (kind === "bridge" && destinationNetwork === spec.network) {
      throw unsupported("A bridge needs a different destination network (toNetwork).", GRAMMAR_EXAMPLES, issue(`${path}.toNetwork`, "Same as network."));
    }
    let protocol = spec.protocol;
    let provider = typeof spec.params?.provider === "string" ? spec.params.provider.slice(0, 32) : undefined;
    let to = spec.to;
    if (kind === "stake") {
      const key = protocol ? STAKE_PROTOCOLS[protocol] : undefined;
      if (protocol && !key) {
        throw unsupported(`Liquid staking runs through Jupiter routes, not ${protocol}.`, GRAMMAR_EXAMPLES, issue(`${path}.protocol`, "Unsupported."));
      }
      if (key && !to) to = LIQUID_STAKING_TOKENS[key]?.symbol;
      if (!provider) {
        const target = Object.values(LIQUID_STAKING_TOKENS).find((entry) => entry.symbol.toUpperCase() === (to ?? "JitoSOL").toUpperCase());
        provider = target?.provider ?? "Jito";
      }
      to = to ?? "JitoSOL";
      protocol = "jupiter";
    }
    if (kind === "deposit" && protocol && protocol !== "aave-v3") {
      throw unsupported(`Deposits are executed on Aave V3; ${protocol} is discovery-only.`, GRAMMAR_EXAMPLES, issue(`${path}.protocol`, "Unsupported."));
    }
    return {
      index,
      kind,
      network: spec.network,
      destinationNetwork,
      amount,
      ...(spec.from ? { from: spec.from } : {}),
      ...(to ? { to } : {}),
      ...(spec.recipient ? { recipient: spec.recipient } : {}),
      ...(protocol ? { protocol } : {}),
      ...(provider ? { provider } : {}),
    };
  });
  const lane = normalized[0]?.network;
  for (const action of normalized) {
    for (const network of [action.network, action.destinationNetwork]) {
      if (lane && !sameCapitalLane(lane, network)) {
        throw new PlatformError(
          "CAPITAL_LANE_MIXED",
          `${CHAINS[network].name} (${CHAINS[network].environment}) cannot share an intent with ${CHAINS[lane].name} (${CHAINS[lane].environment}).`,
          422,
          issue(`actions[${action.index}].network`, "Mainnet and testnet networks never mix in one intent."),
        );
      }
      if (request.constraints?.allowTestnets === false && CHAINS[network].environment === "testnet") {
        throw new PlatformError("TESTNET_NOT_ALLOWED", `${CHAINS[network].name} is a testnet and constraints.allowTestnets is false.`, 422);
      }
    }
  }
  return normalized;
}

interface PreviousStep {
  readonly step: IntentStep;
  readonly output: ResolvedAsset;
  readonly network: NetworkKey;
  /** Account the previous step pays its output to. */
  readonly recipient: ParsedAccountId;
}

function unsupportedRoute(route: AdapterRoute): PlatformError {
  const network = CHAINS[route.network].name;
  const messages: Record<string, string> = {
    swap: `Swaps run on Solana (Jupiter) and on Base or Arbitrum (Relay); ${route.input.symbol} → ${route.output.symbol} on ${network} is not available.`,
    stake: "Liquid staking runs on Solana mainnet (SOL → JitoSOL, mSOL or JupSOL).",
    bridge: `Bridges run between ${RELAY_NETWORKS.map((key) => CHAINS[key].name).join(", ")} through Relay; ${network} → ${CHAINS[route.destinationNetwork].name} is not available.`,
    transfer: `Transfers of ${route.input.symbol} on ${network} are not available.`,
    deposit: `Aave V3 deposits run on Base and Arbitrum; ${route.input.symbol} on ${network} is not available.`,
  };
  return unsupported(messages[route.kind] ?? "This action is not supported.", GRAMMAR_EXAMPLES);
}

async function resolveInput(action: NormalizedAction, previous: PreviousStep | null): Promise<ResolvedAsset> {
  if (action.amount.type === "previous") {
    if (!previous) throw unsupported("\"max\" needs a previous step.", GRAMMAR_EXAMPLES);
    if (previous.network !== action.network) {
      throw unsupported(
        `Step ${action.index + 1} spends funds on ${CHAINS[action.network].name}, but step ${action.index} delivers them on ${CHAINS[previous.network].name}.`,
        GRAMMAR_EXAMPLES,
      );
    }
    if (action.from) {
      const named = await resolveAsset(action.network, action.from);
      if (!sameAsset(named, previous.output)) {
        throw new PlatformError(
          "ASSET_MISMATCH",
          `Step ${action.index + 1} spends ${named.symbol}, but the previous step produces ${previous.output.symbol}.`,
          422,
        );
      }
    }
    return previous.output;
  }
  if (!action.from) {
    throw new PlatformError("ASSET_REQUIRED", `Step ${action.index + 1} needs an input token (e.g. "5 USDC").`, 422, issue(`actions[${action.index}].from`, "Required."));
  }
  return resolveAsset(action.network, action.from);
}

async function resolveOutput(action: NormalizedAction, input: ResolvedAsset): Promise<ResolvedAsset> {
  if (action.kind === "transfer" || action.kind === "deposit") return input;
  if (action.to) return resolveAsset(action.destinationNetwork, action.to);
  if (action.kind === "bridge") {
    const descriptor = getAsset(input.id);
    const counterpart = descriptor ? counterpartAsset(descriptor, action.destinationNetwork) : null;
    if (counterpart) return resolveAsset(action.destinationNetwork, counterpart.id);
    const suggestion = ["USDC", CHAINS[action.destinationNetwork].nativeAsset.symbol]
      .filter((symbol) => findAssetBySymbol(action.destinationNetwork, symbol))
      .join("\" or \"as ");
    throw new PlatformError(
      "ASSET_REQUIRED",
      `${input.symbol} has no direct counterpart on ${CHAINS[action.destinationNetwork].name}. Say what to receive, e.g. "as ${suggestion}".`,
      422,
    );
  }
  throw new PlatformError("ASSET_REQUIRED", `Step ${action.index + 1} needs an output token.`, 422, issue(`actions[${action.index}].to`, "Required."));
}

function resolveRecipient(action: NormalizedAction, account: ParsedAccountId, accounts: readonly ParsedAccountId[]): ParsedAccountId {
  if (action.kind === "transfer") {
    if (!action.recipient) throw new PlatformError("RECIPIENT_REQUIRED", "A transfer needs a recipient.", 422);
    const recipient = recipientForNetwork(action.recipient, action.network);
    if (sameAddress(recipient, account)) {
      throw new PlatformError("SELF_TRANSFER", "The recipient is the sending account; nothing would move.", 422);
    }
    return recipient;
  }
  if (action.kind === "bridge") {
    return action.recipient
      ? recipientForNetwork(action.recipient, action.destinationNetwork)
      : accountForNetwork(accounts, action.destinationNetwork);
  }
  if (action.recipient) {
    const recipient = recipientForNetwork(action.recipient, action.network);
    if (!sameAddress(recipient, account)) {
      throw unsupported(`A ${action.kind} pays the acting account; send the result with a separate "send" step.`, GRAMMAR_EXAMPLES);
    }
  }
  return account;
}

function baseUnits(value: string, asset: ResolvedAsset, index: number): string {
  let units: string;
  try {
    units = toBaseUnits(value, asset.decimals);
  } catch {
    throw new PlatformError(
      "AMOUNT_INVALID",
      `${value} ${asset.symbol} has more than ${asset.decimals} decimal places.`,
      422,
      issue(`actions[${index}].amount`, "Too precise."),
    );
  }
  if (units === "0") throw new PlatformError("AMOUNT_INVALID", "Amount must be positive.", 422, issue(`actions[${index}].amount`, "Zero."));
  return units;
}

async function planWithCandidates(candidates: readonly ProtocolAdapter[], action: AdapterAction): Promise<{ adapter: ProtocolAdapter; planned: PlannedStep }> {
  let firstError: unknown = null;
  for (const adapter of candidates) {
    try {
      return { adapter, planned: await adapter.plan(action) };
    } catch (error) {
      firstError ??= error;
    }
  }
  throw firstError ?? unsupportedRoute(action);
}

interface StepDraft {
  readonly action: NormalizedAction;
  readonly adapter: ProtocolAdapter;
  readonly planned: PlannedStep;
  readonly account: ParsedAccountId;
  readonly recipient: ParsedAccountId;
  readonly output: ResolvedAsset;
  readonly funded: boolean;
  readonly portionBps?: number;
  readonly merged?: string;
}

function canMerge(bridge: NormalizedAction, next: NormalizedAction | undefined, request: IntentRequest): next is NormalizedAction {
  if (!next || bridge.kind !== "bridge") return false;
  if (next.kind !== "swap" && next.kind !== "stake") return false;
  if (next.network !== bridge.destinationNetwork || next.amount.type !== "previous" || next.amount.portionBps !== 10_000) return false;
  if (next.recipient || !next.to) return false;
  if (!RELAY_NETWORKS.includes(bridge.network) || !RELAY_NETWORKS.includes(bridge.destinationNetwork)) return false;
  const constraints = request.constraints;
  if (constraints?.avoidProtocols?.includes("relay")) return false;
  const prefer = constraints?.preferProtocols ?? [];
  if (prefer.includes("jupiter") && !prefer.includes("relay")) return false;
  if (next.from && bridge.to && next.from.toUpperCase() !== bridge.to.toUpperCase()) return false;
  if (next.from && !bridge.to && bridge.from && next.from.toUpperCase() !== bridge.from.toUpperCase()) return false;
  return true;
}

async function draftStep(
  action: NormalizedAction,
  previous: PreviousStep | null,
  accounts: readonly ParsedAccountId[],
  request: IntentRequest,
): Promise<StepDraft> {
  if (action.kind === "stake" && action.network !== "solana") {
    throw unsupported(
      `Liquid staking runs on Solana mainnet (SOL → JitoSOL, mSOL or JupSOL), not ${CHAINS[action.network].name}.`,
      GRAMMAR_EXAMPLES,
    );
  }
  const account = accountForNetwork(accounts, action.network);
  const input = await resolveInput(action, previous);
  if (action.amount.type === "previous" && previous && !sameAddress(previous.recipient, account)) {
    // The previous output belongs to someone else; spending "it" would silently spend other funds of the user.
    throw unsupported(
      `Step ${action.index + 1} spends the output of step ${action.index}, but that output is paid to ${previous.recipient.address}, not to your account. Give step ${action.index + 1} an explicit amount.`,
      GRAMMAR_EXAMPLES,
      issue(`actions[${action.index}].amount`, "The previous step pays another account."),
    );
  }
  const output = await resolveOutput(action, input);
  if ((action.kind === "swap" || action.kind === "stake" || action.kind === "bridge") && sameAsset(input, output)) {
    throw new PlatformError("SWAP_SAME_ASSET", `Step ${action.index + 1} would swap ${input.symbol} into itself.`, 422);
  }
  const recipient = resolveRecipient(action, account, accounts);
  const amount = action.amount.type === "exact"
    ? baseUnits(action.amount.value, input, action.index)
    : portionOf((previous as PreviousStep).step.minimumOutput?.amount ?? "0", action.amount.portionBps);
  if (amount === "0") {
    throw new PlatformError("AMOUNT_TOO_SMALL", `Step ${action.index + 1} would spend zero ${input.symbol}.`, 422);
  }
  const route: AdapterRoute = {
    kind: action.kind,
    network: action.network,
    destinationNetwork: action.destinationNetwork,
    input,
    output,
  };
  const candidates = candidateAdapters(route, request.constraints, action.protocol === "jupiter" && action.kind === "stake" ? undefined : action.protocol);
  if (candidates.length === 0) throw unsupportedRoute(route);
  const adapterAction: AdapterAction = {
    ...route,
    amount,
    account,
    recipient,
    slippageBps: request.constraints?.maxSlippageBps ?? DEFAULT_SLIPPAGE_BPS,
    ...(action.provider ? { provider: action.provider } : {}),
  };
  const { adapter, planned } = await planWithCandidates(candidates, adapterAction);
  const plannedOutput = planned.minimumOutput;
  return {
    action,
    adapter,
    planned,
    account,
    recipient,
    output: sameAsset(plannedOutput, output) ? output : assetFromRef(plannedOutput),
    funded: action.amount.type === "previous",
    ...(action.amount.type === "previous" ? { portionBps: action.amount.portionBps } : {}),
  };
}

function buildStep(draft: StepDraft, index: number, previous: PreviousStep | null, now: string): IntentStep {
  const { planned, action } = draft;
  const recipient = action.kind === "transfer" || action.kind === "bridge" ? draft.recipient.id : undefined;
  return {
    id: `s${index + 1}`,
    index,
    kind: action.kind,
    title: planned.title,
    network: action.network,
    chain: CHAINS[action.network].id,
    account: draft.account.id,
    protocol: planned.protocol,
    mode: planned.mode,
    input: planned.input,
    expectedOutput: planned.expectedOutput,
    minimumOutput: planned.minimumOutput,
    ...(recipient ? { recipient } : {}),
    dependsOn: previous ? [previous.step.id] : [],
    settlement: planned.settlement,
    ...(planned.feesUsd !== undefined ? { feesUsd: roundUsd(planned.feesUsd) } : {}),
    estimatedSeconds: planned.estimatedSeconds,
    status: previous ? "pending" : "ready",
    evidence: [
      {
        kind: "quote",
        network: action.network,
        observedAt: now,
        ...(planned.quoteId ? { reference: planned.quoteId } : {}),
        detail: `Quoted by ${draft.adapter.label}.`,
      },
    ],
    quoteRef: encodeStepRef({
      v: 1,
      slippageBps: planned.slippageBps,
      ...(planned.quoteId ? { quote: planned.quoteId } : {}),
      ...(draft.portionBps !== undefined ? { portionBps: draft.portionBps } : {}),
      ...(action.provider ? { provider: action.provider } : {}),
      // Every prepare is held to this floor (QUOTE_MOVED), not to the previous prepare's.
      plannedInput: planned.input.amount,
      plannedMinimum: planned.minimumOutput.amount,
    }),
    ...(planned.warnings.length > 0 ? { warnings: planned.warnings } : {}),
  };
}

function scaleUsd(amount: AssetAmount, units: bigint): number | undefined {
  if (amount.usd === undefined || amount.amount === "0") return undefined;
  return Math.round((amount.usd * Number(units)) / Number(amount.amount) * 100) / 100;
}

export function summarize(steps: readonly IntentStep[], edges: readonly IntentEdge[], signatures: number, title: string): IntentSummary {
  const funded = new Set(edges.filter((edge) => edge.kind === "funds").map((edge) => edge.to));
  const networks: NetworkKey[] = [];
  for (const step of steps) {
    for (const network of [step.network, step.settlement?.destinationNetwork]) {
      if (network && !networks.includes(network)) networks.push(network);
    }
  }
  const inputs = steps.filter((step) => !funded.has(step.id) && step.input).map((step) => step.input as AssetAmount);
  const outputs: AssetAmount[] = [];
  for (const step of steps) {
    const produced = step.actualOutput ?? step.expectedOutput;
    if (!produced) continue;
    const consumed = edges
      .filter((edge) => edge.kind === "funds" && edge.from === step.id)
      .map((edge) => steps.find((candidate) => candidate.id === edge.to)?.input)
      .filter((input): input is AssetAmount => input !== undefined && sameAsset(input, produced))
      .reduce((total, input) => total + BigInt(input.amount), 0n);
    const remaining = BigInt(produced.amount) - consumed;
    if (remaining <= 0n) continue;
    const usd = scaleUsd(produced, remaining);
    outputs.push({
      ...produced,
      amount: remaining.toString(),
      formatted: fromBaseUnits(remaining, produced.decimals),
      ...(usd !== undefined ? { usd } : {}),
    });
  }
  const fees = steps.map((step) => step.feesUsd).filter((fee): fee is number => fee !== undefined);
  return {
    title,
    networks,
    inputs,
    outputs,
    ...(fees.length > 0 ? { totalFeesUsd: roundUsd(fees.reduce((total, fee) => total + fee, 0)) } : {}),
    estimatedSeconds: steps.reduce((total, step) => total + (step.estimatedSeconds ?? 0), 0),
    signaturesRequired: signatures,
    crossNetwork: steps.some((step) => step.settlement?.kind === "cross-network"),
  };
}

/** Plans an intent into a quote-backed IntentGraph (not persisted). */
export async function planIntent(input: unknown, options: PlanOptions = {}): Promise<IntentGraph> {
  const validated = validateIntentRequest(input);
  if (!validated.ok) {
    throw new PlatformError("INVALID_REQUEST", "The intent request is invalid.", 400, validated.issues);
  }
  const request = validated.value;
  const nowMs = options.now ?? Date.now();
  const now = new Date(nowMs).toISOString();
  if (request.constraints?.deadline !== undefined && request.constraints.deadline * 1000 <= nowMs) {
    throw new PlatformError("DEADLINE_PASSED", "constraints.deadline is in the past.", 422, issue("constraints.deadline", "In the past."));
  }
  const accounts = parseAccounts(request.accounts);

  let source: "structured" | "grammar";
  let specs: readonly IntentActionSpec[];
  let normalizedText: string | undefined;
  let confidence = 1;
  if (request.actions && request.actions.length > 0) {
    source = "structured";
    specs = request.actions;
  } else {
    const compiled = compileIntentText(request.text ?? "", {
      ...(request.defaultNetwork ? { defaultNetwork: request.defaultNetwork } : {}),
      accounts: request.accounts,
    });
    source = "grammar";
    specs = compiled.actions;
    normalizedText = compiled.normalizedText;
    confidence = compiled.confidence;
  }
  const actions = normalizeActions(specs, request);

  const drafts: StepDraft[] = [];
  const optimizations: string[] = [];
  let previous: PreviousStep | null = null;
  const steps: IntentStep[] = [];
  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index] as NormalizedAction;
    const next = actions[index + 1];
    let draft: StepDraft | null = null;
    if (canMerge(action, next, request)) {
      const merged: NormalizedAction = {
        ...action,
        to: next.to as string,
        ...(next.provider ? { provider: next.provider } : {}),
      };
      try {
        const candidate = await draftStep(merged, previous, accounts, request);
        if (candidate.adapter.id === "relay") {
          draft = { ...candidate, merged: `Merged ${action.kind} (action ${index + 1}) and ${next.kind} on ${CHAINS[next.network].name} (action ${index + 2}) into one Relay cross-network swap into ${candidate.output.symbol}; saves a signature and a settlement wait.` };
          index += 1;
        }
      } catch {
        draft = null;
      }
    }
    draft ??= await draftStep(action, previous, accounts, request);
    if (draft.merged) optimizations.push(draft.merged);
    const step = buildStep(draft, steps.length, previous, now);
    steps.push(step);
    drafts.push(draft);
    previous = { step, output: draft.output, network: action.destinationNetwork, recipient: draft.recipient };
  }

  const edges: IntentEdge[] = steps.flatMap((step, index) =>
    step.dependsOn.map((dependency) => ({
      from: dependency,
      to: step.id,
      kind: drafts[index]?.funded ? ("funds" as const) : ("orders" as const),
    })),
  );

  const warnings: string[] = [];
  const signatures = drafts.reduce((total, draft) => total + draft.planned.transactionCount, 0);
  if (steps.some((step) => step.settlement?.kind === "cross-network")) {
    warnings.push("Cross-network steps settle asynchronously; dependent steps unlock after the destination fill is observed.");
  }
  if (drafts.some((draft) => draft.funded)) {
    warnings.push("Dependent steps spend the previous step's guaranteed minimum output (or the observed output once known).");
  }
  if (drafts.some((draft) => draft.funded && draft.action.network.startsWith("solana") && draft.planned.input.asset.endsWith("/slip44:501"))) {
    warnings.push("Keep a little SOL outside this intent for Solana network fees.");
  }
  const totalFees = steps.reduce((total, step) => total + (step.feesUsd ?? 0), 0);
  const maxFee = request.constraints?.maxFeeUsd;
  if (maxFee !== undefined) {
    if (totalFees > maxFee) {
      throw new PlatformError(
        "FEE_LIMIT_EXCEEDED",
        `Estimated fees are $${totalFees.toFixed(2)}, above constraints.maxFeeUsd ($${maxFee}).`,
        422,
        issue("constraints.maxFeeUsd", "Exceeded."),
      );
    }
    if (steps.some((step) => step.feesUsd === undefined)) warnings.push("Some step fees could not be estimated; maxFeeUsd was checked against known fees only.");
  }

  const expiry = Math.min(
    nowMs + INTENT_TTL_MS,
    request.constraints?.deadline !== undefined ? request.constraints.deadline * 1000 : Number.POSITIVE_INFINITY,
  );
  const expiresAt = new Date(expiry).toISOString();
  const title = steps.length <= 3 ? steps.map((step) => step.title).join(" → ") : normalizedText ?? `${steps.length}-step intent`;
  const graph: IntentGraph = {
    spec: INTENT_SPEC_VERSION,
    id: options.id ?? newIntentId(),
    createdAt: now,
    updatedAt: now,
    expiresAt,
    status: deriveIntentStatus(steps, expiresAt, nowMs),
    request,
    interpretation: {
      source,
      ...(normalizedText ? { normalizedText } : {}),
      confidence,
      ...(optimizations.length > 0 ? { optimizations } : {}),
    },
    steps,
    edges,
    summary: summarize(steps, edges, signatures, title.slice(0, 200)),
    warnings,
    ...(request.metadata ? { metadata: request.metadata } : {}),
  };
  const issues = validateIntentGraph(graph);
  if (issues.length > 0) {
    throw new PlatformError("PLAN_INVALID", "The planned graph failed validation.", 422, issues);
  }
  return graph;
}

/**
 * Rebuilds the adapter action for a step at prepare time. A step funded by a
 * previous step spends its share of that step's observed output when known,
 * otherwise of its guaranteed minimum.
 */
export function actionForStep(graph: IntentGraph, step: IntentStep): AdapterAction {
  if (!step.input || !step.minimumOutput) {
    throw new PlatformError("STEP_INVALID", "The step has no input or output amounts.", 500);
  }
  const account = parseAccountId(step.account);
  if (!account) throw new PlatformError("STEP_INVALID", "The step account is invalid.", 500);
  const recipient = step.recipient ? parseAccountId(step.recipient) : account;
  if (!recipient) throw new PlatformError("STEP_INVALID", "The step recipient is invalid.", 500);
  const ref = decodeStepRef(step.quoteRef);
  const input = assetFromRef(step.input);
  const destinationNetwork = step.settlement?.destinationNetwork ?? step.network;
  const output = step.kind === "transfer" || step.kind === "deposit" ? input : assetFromRef(step.minimumOutput);
  let amount = step.input.amount;
  const fundingEdge = graph.edges.find((edge) => edge.to === step.id && edge.kind === "funds");
  if (fundingEdge) {
    const parent = graph.steps.find((candidate) => candidate.id === fundingEdge.from);
    const source = parent?.actualOutput && sameAsset(parent.actualOutput, step.input)
      ? parent.actualOutput
      : parent?.minimumOutput && sameAsset(parent.minimumOutput, step.input)
        ? parent.minimumOutput
        : null;
    if (source) amount = portionOf(source.amount, ref?.portionBps ?? 10_000);
    if (amount === "0") throw new PlatformError("AMOUNT_TOO_SMALL", "The funding step produced too little to continue.", 422);
  }
  return {
    kind: step.kind,
    network: step.network,
    destinationNetwork,
    input,
    output,
    amount,
    account,
    recipient,
    slippageBps: ref?.slippageBps ?? graph.request.constraints?.maxSlippageBps ?? DEFAULT_SLIPPAGE_BPS,
    ...(ref?.provider ? { provider: ref.provider } : {}),
  };
}
