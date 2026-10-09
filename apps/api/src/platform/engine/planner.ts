/**
 * Intent planner: IntentRequest -> IntentGraph.
 *
 * 1. Validate the request; compile text with the deterministic grammar or
 *    accept structured actions.
 * 2. Normalise actions (kinds, networks, amounts, capital lane).
 * 3. Resolve assets, accounts, recipients (names through the resolver hook)
 *    and, for deposit / withdraw, the registry venue; bind each step to an
 *    adapter (respecting prefer/avoid constraints) and quote it. Cross-network
 *    steps run a venue auction (auction.ts); other steps take the first
 *    adapter that quotes.
 * 4. Chain dependent amounts from the previous step's guaranteed minimum.
 * 5. Merge "bridge then swap everything on the destination" into a single
 *    cross-network swap when a venue quotes it.
 * 6. Assemble steps, edges, summary and warnings; enforce fee limits; validate.
 */
import {
  CHAINS,
  contractActionInput,
  counterpartAsset,
  CUSTOM_CONTRACT_WARNING,
  deriveIntentStatus,
  findAssetBySymbol,
  findYieldVenue,
  fromBaseUnits,
  getAsset,
  getProtocol,
  getYieldVenue,
  CONTRACT_ID_PATTERN,
  INTENT_SPEC_VERSION,
  nativeAssetId,
  parseAccountId,
  PROTOCOLS,
  resolveContractParams,
  sameCapitalLane,
  toBaseUnits,
  validateIntentGraph,
  validateIntentRequest,
  YIELD_VENUES,
  yieldVenuesFor,
  buildPlanRecord,
  planRecordDigest,
  type AssetAmount,
  type EvmContractAction,
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
  type SolanaActionEndpoint,
  type StepEvidence,
  type YieldVenue,
  type YieldVenueAction,
} from "@kletia/core";
import { PlatformError, toPlatformError, unsupported } from "../errors.js";
import { accountForNetwork, ownAccountOn, parseAccounts, recipientForNetwork, sameAddress } from "./accounts.js";
import { recordedVenueId } from "./adapters/lending/common.js";
import { activeProtocolAdapters, adapterForProtocol, candidateAdapters } from "./adapters/registry.js";
import type { AdapterAction, AdapterRoute, ContractPlannedStep, PlannedStep, PlannedStepPreview, ProtocolAdapter } from "./adapters/types.js";
import { assertContractAmount } from "./contracts/caps.js";
import { contractDirectory, contractsEnabled, withActivationRetry, type ContractPhrase } from "./contracts/directory.js";
import { contractOutputAsset, evmSnapshot, solanaSnapshot } from "./contracts/snapshot.js";
import { assetFromRef, resolveAsset, sameAsset, type ResolvedAsset } from "./assets.js";
import { DEFAULT_MAX_SECONDS, describeQuote, exclusionReason, runVenueAuction, type AuctionResult } from "./auction.js";
import { compileIntentText, GRAMMAR_EXAMPLES, LIQUID_STAKING_TOKENS } from "./grammar.js";
import { looksLikeName, normalizeName, resolveRecipientName, type NameResolution } from "./names.js";
import { decodeStepRef, encodeStepRef } from "./stepRef.js";
import { newIntentId, portionOf, roundUsd } from "./util.js";

export const DEFAULT_SLIPPAGE_BPS = 50;
export const INTENT_TTL_MS = 30 * 60 * 1000;

const SUPPORTED_KINDS: readonly IntentActionKind[] = ["swap", "transfer", "bridge", "stake", "deposit", "withdraw", "call", "action"];
/** Kinds bound to an integrator contract registration (`contract` + `entry`). */
const CONTRACT_KINDS: readonly IntentActionKind[] = ["call", "action"];
/** Lending protocols in the order a deposit / withdraw without a named protocol tries them. */
export const LENDING_PROTOCOLS: readonly ProtocolId[] = ["aave-v3", "compound-v3", "morpho", "moonwell", "jupiter-lend", "kamino"];
const STAKE_PROTOCOLS: Readonly<Partial<Record<ProtocolId, string>>> = {
  jito: "jito",
  marinade: "marinade",
  sanctum: "jupiter",
  jupiter: "jito",
};

/**
 * - `exact`: a decimal amount of the input.
 * - `previous`: a share of the previous step's output.
 * - `position`: a withdraw of the whole position at the venue ("withdraw all").
 */
type AmountSpec =
  | { readonly type: "exact"; readonly value: string }
  | { readonly type: "previous"; readonly portionBps: number }
  | { readonly type: "position" }
  /** Call / action entries that spend nothing (e.g. claim). */
  | { readonly type: "none" };

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
  /** Deposit / withdraw venue reference from `params.venue` (id, slug or address). */
  readonly venue?: string;
  /** Call / action: registration id or alias, entry id and the entry's parameter values. */
  readonly contract?: string;
  readonly entry?: string;
  readonly params?: Readonly<Record<string, string | number | boolean>>;
}

export interface PlanOptions {
  readonly now?: number;
  readonly id?: string;
  /**
   * API key id the intent is created with: registrations this key may use
   * can be called (structured `call` / `action` actions and their aliases in
   * text). Intents without a key can never contain call / action steps.
   */
  readonly ownerKeyId?: string;
  /**
   * Intent lifetime (default INTENT_TTL_MS): intents held for Rule Book
   * approval live longer so a human has time (policy design §7.1). Still
   * capped by `constraints.deadline`.
   */
  readonly ttlMs?: number;
}

/** Longest lifetime an intent can be given (a held intent waiting for approval). */
export const MAX_INTENT_TTL_MS = 24 * 60 * 60 * 1000;

function intentTtl(ttlMs: number | undefined): number {
  if (ttlMs === undefined || !Number.isFinite(ttlMs)) return INTENT_TTL_MS;
  return Math.min(MAX_INTENT_TTL_MS, Math.max(INTENT_TTL_MS, Math.floor(ttlMs)));
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

/** Call / action specs: the VM must match the network; the amount is optional (non-spending entries). */
function normalizeContractAction(spec: IntentActionSpec, index: number): NormalizedAction {
  const path = `actions[${index}]`;
  const vm = spec.kind === "call" ? "evm" : "svm";
  if (CHAINS[spec.network].vm !== vm) {
    throw new PlatformError(
      "NETWORK_UNSUPPORTED",
      spec.kind === "call"
        ? `call steps run registered EVM contracts; ${CHAINS[spec.network].name} is not an EVM network (use kind "action" for Solana Actions).`
        : `action steps run registered Solana Actions; ${CHAINS[spec.network].name} is not a Solana network (use kind "call" for EVM contracts).`,
      422,
      issue(`${path}.network`, "Wrong VM for this kind."),
    );
  }
  const expected: ProtocolId = spec.kind === "call" ? "custom-call" : "solana-actions";
  if (spec.protocol && spec.protocol !== expected) {
    throw unsupported(`${spec.kind} steps execute under ${expected}, not ${spec.protocol}.`, GRAMMAR_EXAMPLES, issue(`${path}.protocol`, "Unsupported."));
  }
  if (spec.params?.venue !== undefined) {
    throw unsupported("params.venue applies to deposit and withdraw actions only.", GRAMMAR_EXAMPLES, issue(`${path}.params.venue`, "Unsupported."));
  }
  if (spec.toNetwork !== undefined && spec.toNetwork !== spec.network) {
    throw unsupported(`${spec.kind} steps run on one network; move funds with a bridge step first.`, GRAMMAR_EXAMPLES, issue(`${path}.toNetwork`, "Unsupported."));
  }
  const amount: AmountSpec = spec.amount === undefined
    ? { type: "none" }
    : spec.amount === "max"
      ? { type: "previous", portionBps: portionFrom(spec, path) }
      : { type: "exact", value: spec.amount };
  if (amount.type === "previous" && index === 0) {
    throw unsupported(
      "\"max\" means the output of the previous step, so the first action needs an explicit amount.",
      GRAMMAR_EXAMPLES,
      issue(`${path}.amount`, "No previous step."),
    );
  }
  return {
    index,
    kind: spec.kind,
    network: spec.network,
    destinationNetwork: spec.network,
    amount,
    ...(spec.from ? { from: spec.from } : {}),
    ...(spec.recipient ? { recipient: spec.recipient } : {}),
    protocol: expected,
    contract: spec.contract ?? "",
    entry: spec.entry ?? "",
    ...(spec.params ? { params: spec.params } : {}),
  };
}

/** Normalises structured or grammar-produced actions and enforces one capital lane. */
export function normalizeActions(actions: readonly IntentActionSpec[], request: IntentRequest): NormalizedAction[] {
  const normalized = actions.map((spec, index): NormalizedAction => {
    const path = `actions[${index}]`;
    let kind = spec.kind;
    if (!SUPPORTED_KINDS.includes(kind)) {
      throw unsupported(
        `"${kind}" intents are not executable yet. Supported: swap, transfer, bridge, stake (SOL liquid staking), deposit and withdraw (lending venues), and call / action steps of registered contracts.`,
        GRAMMAR_EXAMPLES,
        issue(`${path}.kind`, "Unsupported action kind."),
      );
    }
    if (CONTRACT_KINDS.includes(kind)) return normalizeContractAction(spec, index);
    if (spec.amount === undefined) {
      throw new PlatformError("AMOUNT_REQUIRED", "Every action needs an amount (decimal or \"max\").", 400, issue(`${path}.amount`, "Required."));
    }
    if (kind === "withdraw" && spec.amount === "max" && spec.params?.portionBps !== undefined) {
      throw unsupported(
        "\"max\" on a withdraw closes the whole position; give an exact amount to withdraw part of it.",
        GRAMMAR_EXAMPLES,
        issue(`${path}.params.portionBps`, "Not allowed with a full withdrawal."),
      );
    }
    const amount: AmountSpec = spec.amount === "max"
      ? kind === "withdraw" ? { type: "position" } : { type: "previous", portionBps: portionFrom(spec, path) }
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
    const lending = kind === "deposit" || kind === "withdraw";
    if (lending && protocol && !(getProtocol(protocol)?.kinds ?? []).includes(kind)) {
      throw unsupported(
        `${getProtocol(protocol)?.name ?? protocol} does not take ${kind}s. Deposits and withdrawals run on ${lendingNames()}.`,
        GRAMMAR_EXAMPLES,
        issue(`${path}.protocol`, "Unsupported."),
      );
    }
    const venue = typeof spec.params?.venue === "string" ? spec.params.venue.trim().slice(0, 128) : undefined;
    if (venue && !lending) {
      throw unsupported("params.venue applies to deposit and withdraw actions only.", GRAMMAR_EXAMPLES, issue(`${path}.params.venue`, "Unsupported."));
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
      ...(venue ? { venue } : {}),
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
  /** Null after a call / action step that declares no output. */
  readonly output: ResolvedAsset | null;
  readonly network: NetworkKey;
  /** Account the previous step pays its output to. */
  readonly recipient: ParsedAccountId;
}

function executableProtocols(): Set<ProtocolId> {
  return new Set(activeProtocolAdapters().flatMap((adapter) => adapter.protocols));
}

/** Names of the registry protocols with a live adapter for `kind` (the lending list keeps its default order). */
function liveVenueNames(kind: IntentActionKind): string {
  const executable = executableProtocols();
  const ids = kind === "deposit" || kind === "withdraw"
    ? LENDING_PROTOCOLS.filter((id) => executable.has(id))
    : PROTOCOLS.filter((protocol) => executable.has(protocol.id) && (protocol.kinds ?? []).includes(kind)).map((protocol) => protocol.id);
  return ids.map((id) => getProtocol(id)?.name ?? id).join(", ");
}

function lendingNames(): string {
  return LENDING_PROTOCOLS.map((id) => getProtocol(id)?.name ?? id).join(", ");
}

function unsupportedRoute(route: AdapterRoute): PlatformError {
  const network = CHAINS[route.network].name;
  const live = liveVenueNames(route.kind);
  const routes = "GET /v1/networks lists the live routes.";
  const messages: Record<string, string> = {
    swap: `Swaps run on Solana (Jupiter) and on Base or Arbitrum (Relay); ${route.input.symbol} → ${route.output.symbol} on ${network} is not available.`,
    stake: "Liquid staking runs on Solana mainnet (SOL → JitoSOL, mSOL or JupSOL).",
    bridge: live
      ? `Bridges run through ${live}; ${route.input.symbol} from ${network} to ${CHAINS[route.destinationNetwork].name} is not available. ${routes}`
      : "No bridge venue is enabled on this deployment.",
    transfer: `Transfers of ${route.input.symbol} on ${network} are not available.`,
    deposit: live
      ? `Deposits run on ${live}; ${route.input.symbol} on ${network} is not available. ${routes}`
      : "No lending venue is enabled on this deployment.",
    withdraw: live
      ? `Withdrawals run on ${live}; ${route.input.symbol} on ${network} is not available. ${routes}`
      : "No lending venue is enabled on this deployment.",
  };
  return unsupported(messages[route.kind] ?? "This action is not supported.", GRAMMAR_EXAMPLES);
}

/** No candidate adapter: say so precisely when the requested protocol has no live adapter at all. */
function noCandidates(route: AdapterRoute, requested: ProtocolId | undefined): PlatformError {
  if (requested && !executableProtocols().has(requested)) {
    return unsupported(`Kletia does not execute ${getProtocol(requested)?.name ?? requested} routes on this deployment.`, GRAMMAR_EXAMPLES);
  }
  return unsupportedRoute(route);
}

async function resolveInput(action: NormalizedAction, previous: PreviousStep | null): Promise<ResolvedAsset> {
  if (action.amount.type === "previous") {
    if (!previous) throw unsupported("\"max\" needs a previous step.", GRAMMAR_EXAMPLES);
    if (!previous.output) {
      throw new PlatformError(
        "AMOUNT_REQUIRED",
        `Step ${action.index + 1} spends the previous step's output, but the previous step produces nothing to spend. Give an explicit amount.`,
        400,
        issue(`actions[${action.index}].amount`, "The previous step has no output."),
      );
    }
    if (previous.network !== action.network) {
      throw unsupported(
        `Step ${action.index + 1} spends funds on ${CHAINS[action.network].name}, but step ${action.index} delivers them on ${CHAINS[previous.network].name}.`,
        GRAMMAR_EXAMPLES,
      );
    }
    const produced = previous.output;
    if (action.from) {
      const named = await resolveAsset(action.network, action.from);
      if (!sameAsset(named, produced)) {
        throw new PlatformError(
          "ASSET_MISMATCH",
          `Step ${action.index + 1} spends ${named.symbol}, but the previous step produces ${produced.symbol}.`,
          422,
        );
      }
    }
    return produced;
  }
  if (!action.from) {
    throw new PlatformError("ASSET_REQUIRED", `Step ${action.index + 1} needs an input token (e.g. "5 USDC").`, 422, issue(`actions[${action.index}].from`, "Required."));
  }
  return resolveAsset(action.network, action.from);
}

async function resolveOutput(action: NormalizedAction, input: ResolvedAsset): Promise<ResolvedAsset> {
  if (action.kind === "transfer" || action.kind === "deposit" || action.kind === "withdraw") return input;
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

interface ResolvedRecipient {
  readonly recipient: ParsedAccountId;
  /** Present when the recipient was given as a name. */
  readonly name?: NameResolution;
}

/** Parses an address / CAIP-10 recipient, or resolves a name through the resolver hook. */
async function recipientOn(raw: string, network: NetworkKey): Promise<ResolvedRecipient> {
  if (!looksLikeName(raw)) return { recipient: recipientForNetwork(raw, network) };
  const name = await resolveRecipientName(raw, network);
  return { recipient: recipientForNetwork(name.address, network), name };
}

async function resolveRecipient(action: NormalizedAction, account: ParsedAccountId, accounts: readonly ParsedAccountId[]): Promise<ResolvedRecipient> {
  if (action.kind === "transfer") {
    if (!action.recipient) throw new PlatformError("RECIPIENT_REQUIRED", "A transfer needs a recipient.", 422);
    const resolved = await recipientOn(action.recipient, action.network);
    if (sameAddress(resolved.recipient, account)) {
      throw new PlatformError("SELF_TRANSFER", "The recipient is the sending account; nothing would move.", 422);
    }
    return resolved;
  }
  if (action.kind === "bridge") {
    return action.recipient
      ? recipientOn(action.recipient, action.destinationNetwork)
      : { recipient: accountForNetwork(accounts, action.destinationNetwork) };
  }
  if (action.recipient) {
    const { recipient } = await recipientOn(action.recipient, action.network);
    if (!sameAddress(recipient, account)) {
      throw unsupported(`A ${action.kind} pays the acting account; send the result with a separate "send" step.`, GRAMMAR_EXAMPLES);
    }
  }
  return { recipient: account };
}

/** The venue's underlying is the input (a native input may target the wrapped-native venue; the adapter wraps or refuses). */
function venueAssetMatches(venue: YieldVenue, input: ResolvedAsset): boolean {
  const underlying = findAssetBySymbol(venue.network, venue.asset);
  if (!underlying) return false;
  if (sameAsset(underlying, input)) return true;
  return input.isNative && underlying.category === "wrapped" && underlying.group === input.group;
}

interface VenueChoice {
  readonly venue: YieldVenue;
  readonly warnings: readonly string[];
}

/**
 * The venue `params.venue` names (registry id, slug, market or receipt
 * address). Several venues can share one market address: every Aave V3
 * reserve on a network is reached through the network's Pool. That address
 * then names the venue among them that holds the input asset.
 */
function namedVenue(action: NormalizedAction, reference: string, input: ResolvedAsset, kind: YieldVenueAction): YieldVenue | null {
  const venue = findYieldVenue(action.network, reference, action.protocol);
  if (!venue || venueAssetMatches(venue, input)) return venue;
  const target = venue.target.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/u.test(target) || reference.trim().toLowerCase() !== target) return venue;
  const sharing = yieldVenuesFor(action.network, venue.protocol).filter(
    (entry) => entry.target.toLowerCase() === target && venueAssetMatches(entry, input),
  );
  return sharing.find((entry) => entry.actions.includes(kind)) ?? sharing[0] ?? venue;
}

/**
 * Resolves and validates the registry venue of a deposit / withdraw: the
 * named venue (`params.venue`), else the default venue of the named protocol,
 * else the first lending protocol (preferred first) with a live adapter.
 */
function resolveVenue(action: NormalizedAction, input: ResolvedAsset, route: AdapterRoute, request: IntentRequest): VenueChoice {
  const kind = action.kind as YieldVenueAction;
  const chain = CHAINS[action.network];
  const path = `actions[${action.index}]`;
  const avoid = new Set(request.constraints?.avoidProtocols ?? []);
  const protocolName = action.protocol ? getProtocol(action.protocol)?.name ?? action.protocol : "lending";
  if (action.venue) {
    const venue = namedVenue(action, action.venue, input, kind);
    if (!venue) {
      const known = yieldVenuesFor(action.network, action.protocol).filter((entry) => entry.actions.includes(kind)).map((entry) => entry.slug);
      throw new PlatformError(
        "VENUE_UNKNOWN",
        `No ${protocolName} venue "${action.venue.slice(0, 64)}" on ${chain.name}.${known.length > 0 ? ` Known: ${[...new Set(known)].join(", ")}.` : ""}`,
        422,
        issue(`${path}.params.venue`, "Unknown venue."),
      );
    }
    if (!venue.actions.includes(kind)) {
      throw new PlatformError("VENUE_UNSUPPORTED", `${venue.name} is listed for discovery only; Kletia does not execute ${kind}s there.`, 422, issue(`${path}.params.venue`, "Not executable."));
    }
    if (!venueAssetMatches(venue, input)) {
      throw new PlatformError("VENUE_ASSET_MISMATCH", `${venue.name} holds ${venue.asset}, not ${input.symbol}.`, 422, issue(`${path}.params.venue`, "Asset mismatch."));
    }
    if (avoid.has(venue.protocol)) {
      throw unsupported(`${venue.name} is a ${getProtocol(venue.protocol)?.name ?? venue.protocol} venue, which constraints.avoidProtocols excludes.`, GRAMMAR_EXAMPLES);
    }
    return { venue, warnings: [] };
  }
  const venues = YIELD_VENUES.filter((venue) =>
    venue.network === action.network && venue.actions.includes(kind) && venueAssetMatches(venue, input) &&
    (!action.protocol || venue.protocol === action.protocol) && !avoid.has(venue.protocol));
  let venue: YieldVenue | undefined;
  if (action.protocol) {
    venue = venues[0];
    if (!venue) {
      const assets = [...new Set(yieldVenuesFor(action.network, action.protocol).filter((entry) => entry.actions.includes(kind)).map((entry) => entry.asset))];
      throw unsupported(
        assets.length > 0
          ? `${protocolName} on ${chain.name} takes ${assets.join(", ")}; ${input.symbol} is not available.`
          : `${protocolName} ${kind}s are not available on ${chain.name}.`,
        GRAMMAR_EXAMPLES,
        issue(`${path}.protocol`, "No venue for this asset and network."),
      );
    }
  } else {
    const prefer = (request.constraints?.preferProtocols ?? []).filter((id) => LENDING_PROTOCOLS.includes(id));
    const order = [...prefer, ...LENDING_PROTOCOLS.filter((id) => !prefer.includes(id))];
    venue = order
      .map((protocol) => venues.find((entry) => entry.protocol === protocol))
      .find((entry): entry is YieldVenue => entry !== undefined && candidateAdapters(route, request.constraints, entry.protocol).length > 0);
    if (!venue) throw unsupportedRoute(route);
  }
  const alternatives = venues.filter((entry) => entry.protocol === venue.protocol && entry !== venue);
  const warnings = alternatives.length > 0
    ? [`Using ${venue.name}; name another ${getProtocol(venue.protocol)?.name ?? venue.protocol} venue with params.venue (${alternatives.map((entry) => entry.slug).join(", ")}).`]
    : [];
  return { venue, warnings };
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

type AnyPlannedStep = PlannedStep | ContractPlannedStep;

interface CandidateSelection {
  readonly adapter: ProtocolAdapter;
  readonly planned: PlannedStep;
  /** Present when several venues competed (cross-network steps). */
  readonly auction?: AuctionResult;
}

/**
 * Cross-network steps run the venue auction; every other step takes the
 * first candidate (in preference order) that quotes.
 */
async function planWithCandidates(
  candidates: readonly ProtocolAdapter[],
  action: AdapterAction,
  request: IntentRequest,
): Promise<CandidateSelection> {
  if (action.kind === "bridge" && action.network !== action.destinationNetwork) {
    const maxSeconds = request.constraints?.maxSeconds;
    const auction = await runVenueAuction(candidates, action, {
      maxSeconds: maxSeconds ?? DEFAULT_MAX_SECONDS,
      explicitMaxSeconds: maxSeconds !== undefined,
      prefer: request.constraints?.preferProtocols ?? [],
    });
    return { adapter: auction.winner.adapter, planned: auction.winner.planned, auction };
  }
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
  readonly planned: AnyPlannedStep;
  readonly account: ParsedAccountId;
  readonly recipient: ParsedAccountId;
  /** Name the recipient was resolved from. */
  readonly name?: NameResolution;
  readonly venue?: YieldVenue;
  readonly auction?: AuctionResult;
  /** Planner warnings for the step (venue defaults, auction notes). */
  readonly notes: readonly string[];
  /** Null for a call / action step without a declared output. */
  readonly output: ResolvedAsset | null;
  readonly funded: boolean;
  readonly portionBps?: number;
  readonly merged?: string;
}

function canMerge(bridge: NormalizedAction, next: NormalizedAction | undefined, request: IntentRequest): next is NormalizedAction {
  if (!next || bridge.kind !== "bridge") return false;
  if (next.kind !== "swap" && next.kind !== "stake") return false;
  if (next.network !== bridge.destinationNetwork || next.amount.type !== "previous" || next.amount.portionBps !== 10_000) return false;
  if (next.recipient || !next.to) return false;
  const prefer = request.constraints?.preferProtocols ?? [];
  // Preferring Jupiter (and no cross-network venue) means "swap on the destination", not one merged route.
  if (prefer.includes("jupiter") && !prefer.some((id) => getProtocol(id)?.crossChain)) return false;
  if (next.from && bridge.to && next.from.toUpperCase() !== bridge.to.toUpperCase()) return false;
  if (next.from && !bridge.to && bridge.from && next.from.toUpperCase() !== bridge.from.toUpperCase()) return false;
  return true;
}

async function draftStep(
  action: NormalizedAction,
  previous: PreviousStep | null,
  accounts: readonly ParsedAccountId[],
  request: IntentRequest,
  ownerKeyId?: string,
): Promise<StepDraft> {
  if (CONTRACT_KINDS.includes(action.kind)) return draftContractStep(action, previous, accounts, request, ownerKeyId);
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
  const { recipient, name } = await resolveRecipient(action, account, accounts);
  const closePosition = action.amount.type === "position";
  const amount = action.amount.type === "exact"
    ? baseUnits(action.amount.value, input, action.index)
    : action.amount.type === "position"
      ? "0"
      : action.amount.type === "previous"
        ? portionOf((previous as PreviousStep).step.minimumOutput?.amount ?? "0", action.amount.portionBps)
        : "0";
  if (amount === "0" && !closePosition) {
    throw new PlatformError("AMOUNT_TOO_SMALL", `Step ${action.index + 1} would spend zero ${input.symbol}.`, 422);
  }
  const route: AdapterRoute = {
    kind: action.kind,
    network: action.network,
    destinationNetwork: action.destinationNetwork,
    input,
    output,
  };
  const lending = action.kind === "deposit" || action.kind === "withdraw";
  const choice = lending ? resolveVenue(action, input, route, request) : null;
  const requested = choice ? choice.venue.protocol : action.protocol === "jupiter" && action.kind === "stake" ? undefined : action.protocol;
  const candidates = candidateAdapters(route, request.constraints, requested);
  if (candidates.length === 0) throw noCandidates(route, requested);
  const destinationAccount = route.destinationNetwork !== route.network ? ownAccountOn(accounts, route.destinationNetwork) : undefined;
  const adapterAction: AdapterAction = {
    ...route,
    amount,
    account,
    recipient,
    slippageBps: request.constraints?.maxSlippageBps ?? DEFAULT_SLIPPAGE_BPS,
    ...(action.provider ? { provider: action.provider } : {}),
    ...(choice ? { venue: choice.venue.id } : {}),
    ...(closePosition ? { closePosition: true } : {}),
    ...(destinationAccount ? { destinationAccount } : {}),
  };
  const { adapter, planned, auction } = await planWithCandidates(candidates, adapterAction, request);
  if (closePosition && !(BigInt(planned.input.amount) > 0n)) {
    throw new PlatformError("POSITION_EMPTY", `There is no ${input.symbol} position to withdraw at ${choice?.venue.name ?? "this venue"}.`, 422);
  }
  if (choice && planned.protocol !== choice.venue.protocol) {
    throw new PlatformError("PLAN_INVALID", `${adapter.label} planned ${planned.protocol} for a ${choice.venue.protocol} venue.`, 502);
  }
  const plannedOutput = planned.minimumOutput as AssetAmount;
  return {
    action,
    adapter,
    planned,
    account,
    recipient,
    ...(name ? { name } : {}),
    ...(choice ? { venue: choice.venue } : {}),
    ...(auction ? { auction } : {}),
    notes: [...(choice?.warnings ?? []), ...(auction?.warnings ?? [])],
    output: sameAsset(plannedOutput, output) ? output : assetFromRef(plannedOutput),
    funded: action.amount.type === "previous",
    ...(action.amount.type === "previous" ? { portionBps: action.amount.portionBps } : {}),
  };
}

/** The network's native asset as a placeholder input of non-spending call / action steps. */
function nativePlaceholder(network: NetworkKey): ResolvedAsset {
  const native = CHAINS[network].nativeAsset;
  return assetFromRef({ asset: nativeAssetId(network), symbol: native.symbol, decimals: native.decimals });
}

/** True when an argument binding (or a tuple member) reads `$previous.*`. */
function usesPrevious(binding: unknown): boolean {
  if (typeof binding === "string") return binding.startsWith("$previous.");
  if (typeof binding === "object" && binding !== null && "tuple" in binding) return (binding as { tuple: unknown[] }).tuple.some(usesPrevious);
  return false;
}

/**
 * Plans a call (EVM) or action (Solana Actions) step against a registration
 * the intent's API key may use (design §6.3): scoping, status and revision,
 * deny list, parameters, input and amount (exact, or the previous step's
 * guaranteed minimum), limits and USD caps, recipient, `$previous` bindings;
 * then the contract adapter pins, simulates and reviews it.
 */
async function draftContractStep(
  action: NormalizedAction,
  previous: PreviousStep | null,
  accounts: readonly ParsedAccountId[],
  request: IntentRequest,
  ownerKeyId: string | undefined,
): Promise<StepDraft> {
  const path = `actions[${action.index}]`;
  const network = action.network;
  const chain = CHAINS[network];
  const directory = contractDirectory();
  if (!contractsEnabled() || !directory) {
    throw new PlatformError("CONTRACTS_DISABLED", "Custom contract and Solana Action steps are not enabled on this deployment.", 503);
  }
  const reference = (action.contract ?? "").trim();
  const registration = ownerKeyId
    ? await directory.resolve(ownerKeyId, CONTRACT_ID_PATTERN.test(reference) ? reference : reference.toLowerCase(), network)
    : null;
  if (!registration) {
    throw new PlatformError(
      "CONTRACT_UNKNOWN",
      ownerKeyId
        ? `No contract registration "${reference.slice(0, 64)}" usable by this API key on ${chain.name}.`
        : "Intents created without an API key cannot call registered contracts.",
      422,
      issue(`${path}.contract`, "Unknown contract."),
    );
  }
  const definition = registration.definition;
  if (registration.status === "suspended") {
    throw new PlatformError("CONTRACT_SUSPENDED", `${registration.id} is suspended; the integrator must inspect and reverify it.`, 409, issue(`${path}.contract`, "Suspended."));
  }
  if (registration.status === "pending" || registration.activeRevision === null) {
    throw withActivationRetry(new PlatformError(
      "CONTRACT_PENDING",
      `${registration.id} activates${registration.activatesAt ? ` at ${registration.activatesAt}` : " after its activation delay"}; retry then.`,
      409,
      issue(`${path}.contract`, "Pending activation."),
    ), registration.activatesAt);
  }
  if (definition.network !== network) {
    throw new PlatformError(
      "NETWORK_UNSUPPORTED",
      `${registration.id} is registered on ${CHAINS[definition.network].name}, not ${chain.name}.`,
      422,
      issue(`${path}.network`, "The registration is on another network."),
    );
  }
  if ((definition.vm === "evm") !== (action.kind === "call")) {
    throw unsupported(`${registration.id} is ${definition.vm === "evm" ? "an EVM contract (kind call)" : "a Solana Actions registration (kind action)"}.`, GRAMMAR_EXAMPLES, issue(`${path}.kind`, "Wrong kind."));
  }
  const entry = (definition.actions as readonly (EvmContractAction | SolanaActionEndpoint)[]).find((candidate) => candidate.id === action.entry);
  if (!entry) {
    throw new PlatformError(
      "CONTRACT_ACTION_UNKNOWN",
      `${registration.id} has no action "${(action.entry ?? "").slice(0, 40)}". Known: ${definition.actions.map((candidate) => candidate.id).join(", ")}.`,
      422,
      issue(`${path}.entry`, "Unknown entry."),
    );
  }
  const targets = definition.vm === "evm" ? [definition.address, ...(definition.addresses ?? []).map((item) => item.address)] : definition.programs;
  for (const target of targets) {
    const denied = directory.denied(network, target);
    if (denied) throw new PlatformError("CONTRACT_DENIED", `${target} on ${chain.name} is ${denied}; Kletia does not call it.`, 422, issue(`${path}.contract`, "Denied."));
  }
  const params = resolveContractParams(entry.params, action.params);
  if (!params.ok) {
    throw new PlatformError(
      "CONTRACT_PARAM_INVALID",
      `Invalid parameters for ${entry.label}: ${params.issues.map((item) => `${item.path} ${item.message}`).join(" ").slice(0, 300)}`,
      422,
      params.issues.map((item) => ({ path: `${path}.${item.path}`, message: item.message })),
    );
  }
  // Input and amount.
  const descriptor = contractActionInput(network, entry);
  const input = descriptor ? await resolveAsset(network, descriptor.id) : null;
  const account = accountForNetwork(accounts, network);
  let amount: string | null = null;
  if (!input) {
    if (action.amount.type !== "none") {
      throw unsupported(`${entry.label} spends nothing; remove the amount.`, GRAMMAR_EXAMPLES, issue(`${path}.amount`, "This action takes no amount."));
    }
  } else if (action.amount.type === "none") {
    throw new PlatformError("AMOUNT_REQUIRED", `${entry.label} spends ${input.symbol}: give an amount (a decimal, or max after a step that produces ${input.symbol}).`, 400, issue(`${path}.amount`, "Required."));
  } else {
    const resolved = action.amount.type === "previous" || action.from ? await resolveInput(action, previous) : input;
    if (!sameAsset(resolved, input)) {
      throw new PlatformError("ASSET_MISMATCH", `${entry.label} spends ${input.symbol}, not ${resolved.symbol}.`, 422, issue(`${path}.from`, "Asset mismatch."));
    }
    if (action.amount.type === "previous") {
      if (previous && !sameAddress(previous.recipient, account)) {
        throw unsupported(
          `Step ${action.index + 1} spends the output of step ${action.index}, but that output is paid to ${previous.recipient.address}, not to your account. Give step ${action.index + 1} an explicit amount.`,
          GRAMMAR_EXAMPLES,
          issue(`${path}.amount`, "The previous step pays another account."),
        );
      }
      const minimum = previous?.step.minimumOutput?.amount;
      if (!minimum) {
        throw new PlatformError("AMOUNT_REQUIRED", `Step ${action.index + 1} spends the previous step's output, whose amount could not be estimated. Give an explicit amount.`, 400, issue(`${path}.amount`, "Unknown previous output."));
      }
      amount = portionOf(minimum, action.amount.portionBps);
    } else if (action.amount.type === "exact") {
      amount = baseUnits(action.amount.value, input, action.index);
    }
    if (amount === "0") throw new PlatformError("AMOUNT_TOO_SMALL", `Step ${action.index + 1} would spend zero ${input.symbol}.`, 422);
  }
  if (input && amount !== null) {
    await assertContractAmount(entry.limits, input, BigInt(amount), registration.verification.domain.verified, entry.label, `${path}.amount`);
  }
  // Recipient: the account unless the entry allows third parties.
  const recipientMode = definition.vm === "evm" ? (entry as EvmContractAction).recipient ?? "account" : "account";
  let recipient = account;
  if (action.recipient) {
    const named = await recipientOn(action.recipient, network);
    if (recipientMode !== "any" && !sameAddress(named.recipient, account)) {
      throw unsupported(`${entry.label} pays the acting account; send the result with a separate "send" step.`, GRAMMAR_EXAMPLES, issue(`${path}.recipient`, "Third-party recipients are not allowed by this action."));
    }
    recipient = named.recipient;
  }
  // $previous.* bindings need a previous step on the same network with an output.
  const samePrevious = previous && previous.network === network && previous.step.minimumOutput ? previous : null;
  if (definition.vm === "evm" && (entry as EvmContractAction).args.some(usesPrevious) && !samePrevious) {
    throw new PlatformError(
      "CONTRACT_BINDING_INVALID",
      `${entry.label} binds $previous.output, but step ${action.index + 1} has no previous step on ${chain.name} that produces an output.`,
      422,
      issue(`${path}.entry`, "No previous output on this network."),
    );
  }
  const output = await contractOutputAsset(registration, entry);
  const snapshot = definition.vm === "evm"
    ? evmSnapshot(registration, entry as EvmContractAction, params.values, output)
    : solanaSnapshot(registration, entry as SolanaActionEndpoint, params.values, output);
  const adapter = adapterForProtocol(definition.vm === "evm" ? "custom-call" : "solana-actions");
  const funded = action.amount.type === "previous";
  const placeholder = input ?? nativePlaceholder(network);
  const adapterAction: AdapterAction = {
    kind: action.kind,
    network,
    destinationNetwork: network,
    input: placeholder,
    output: output ?? placeholder,
    amount: amount ?? "0",
    account,
    recipient,
    slippageBps: request.constraints?.maxSlippageBps ?? DEFAULT_SLIPPAGE_BPS,
    call: {
      snapshot,
      input,
      output,
      ...(samePrevious?.step.minimumOutput ? { previousOutput: samePrevious.step.minimumOutput } : {}),
      registration,
      funded,
      stage: "plan",
    },
  };
  const planned = await adapter.planCall(adapterAction);
  return {
    action,
    adapter,
    planned,
    account,
    recipient,
    notes: [],
    output,
    funded,
    ...(funded && action.amount.type === "previous" ? { portionBps: action.amount.portionBps } : {}),
  };
}

/** Quote evidence for the selected venue, the venues it beat and the ones that could not quote. */
function quoteEvidence(draft: StepDraft, now: string): StepEvidence[] {
  const { planned, action } = draft;
  const competitors = (draft.auction?.losers.length ?? 0) + (draft.auction?.failures.length ?? 0);
  const selected: StepEvidence = {
    kind: "quote",
    network: action.network,
    observedAt: now,
    ...(planned.quoteId ? { reference: planned.quoteId } : {}),
    detail: `Quoted by ${draft.adapter.label}.${competitors > 0 ? ` Selected over ${competitors} other venue(s) by net guaranteed output, then time.` : ""}`,
  };
  // Provider quote ids of other venues stay out of `reference`: references of quote evidence bind deposits.
  const losers: StepEvidence[] = (draft.auction?.losers ?? []).map((quote) => ({
    kind: "quote",
    network: action.network,
    observedAt: now,
    detail: `Also quoted: ${describeQuote(quote)}; not selected${exclusionReason(quote) ? ` (${exclusionReason(quote)})` : ""}.`.slice(0, 300),
  }));
  const failures: StepEvidence[] = (draft.auction?.failures ?? []).map((failure) => ({
    kind: "quote",
    network: action.network,
    observedAt: now,
    detail: `${getProtocol(failure.protocol)?.name ?? failure.adapter.label} could not quote (${failure.error.code}).`,
  }));
  const resolution: StepEvidence[] = draft.name
    ? [{
        kind: "note",
        network: draft.recipient.chain.key,
        ...(draft.name.reference ? { reference: draft.name.reference.slice(0, 100) } : {}),
        observedAt: now,
        detail: `Resolved ${draft.name.name} to ${draft.recipient.address} via ${getProtocol(draft.name.protocol)?.name ?? draft.name.protocol}: ${draft.name.detail}`.slice(0, 300),
      }]
    : [];
  return [selected, ...losers, ...failures, ...resolution];
}

function buildStep(draft: StepDraft, index: number, previous: PreviousStep | null, now: string): IntentStep {
  const { action } = draft;
  const contract = "kind" in draft.planned && draft.planned.kind === "call";
  // Call steps record a third-party recipient (entries with recipient "any") so prepare rebuilds it.
  const paysRecipient = action.kind === "transfer" || action.kind === "bridge" || (contract && !sameAddress(draft.recipient, draft.account));
  const recipient = paysRecipient ? draft.recipient.id : undefined;
  const warnings = [...new Set([...draft.notes, ...draft.planned.warnings, ...(draft.name?.warnings ?? [])])];
  if (contract) return buildContractStep(draft, draft.planned as ContractPlannedStep, index, previous, now, recipient, warnings);
  const planned = draft.planned as PlannedStep;
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
    ...(recipient && draft.name ? { recipientName: draft.name.name } : {}),
    ...(draft.venue ? { venue: draft.venue.id } : {}),
    dependsOn: previous ? [previous.step.id] : [],
    settlement: planned.settlement,
    ...(planned.feesUsd !== undefined ? { feesUsd: roundUsd(planned.feesUsd) } : {}),
    ...(planned.extraCosts && planned.extraCosts.length > 0 ? { extraCosts: planned.extraCosts } : {}),
    estimatedSeconds: planned.estimatedSeconds,
    status: previous ? "pending" : "ready",
    evidence: quoteEvidence(draft, now),
    quoteRef: encodeStepRef({
      v: 1,
      slippageBps: planned.slippageBps,
      ...(planned.quoteId ? { quote: planned.quoteId } : {}),
      ...(draft.portionBps !== undefined ? { portionBps: draft.portionBps } : {}),
      ...((planned.provider ?? action.provider) ? { provider: planned.provider ?? action.provider } : {}),
      // Every prepare is held to this floor (QUOTE_MOVED), not to the previous prepare's.
      plannedInput: planned.input.amount,
      plannedMinimum: planned.minimumOutput.amount,
      ...(action.amount.type === "position" ? { closePosition: true as const } : {}),
    }),
    ...(warnings.length > 0 ? { warnings: warnings.slice(0, 12) } : {}),
  };
}

/** IntentStep of a call / action step: input and outputs only when the entry has them; the snapshot in `call`. */
function buildContractStep(
  draft: StepDraft,
  planned: ContractPlannedStep,
  index: number,
  previous: PreviousStep | null,
  now: string,
  recipient: IntentStep["recipient"],
  warnings: readonly string[],
): IntentStep {
  const { action } = draft;
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
    ...(planned.input ? { input: planned.input } : {}),
    ...(planned.expectedOutput ? { expectedOutput: planned.expectedOutput } : {}),
    ...(planned.minimumOutput ? { minimumOutput: planned.minimumOutput } : {}),
    ...(recipient ? { recipient } : {}),
    dependsOn: previous ? [previous.step.id] : [],
    settlement: planned.settlement,
    ...(planned.feesUsd !== undefined ? { feesUsd: roundUsd(planned.feesUsd) } : {}),
    estimatedSeconds: planned.estimatedSeconds,
    status: previous ? "pending" : "ready",
    evidence: quoteEvidence(draft, now),
    quoteRef: encodeStepRef({
      v: 1,
      slippageBps: planned.slippageBps,
      ...(draft.portionBps !== undefined ? { portionBps: draft.portionBps } : {}),
      ...(planned.input && planned.minimumOutput ? { plannedInput: planned.input.amount, plannedMinimum: planned.minimumOutput.amount } : {}),
    }),
    ...(warnings.length > 0 ? { warnings: warnings.slice(0, 12) } : {}),
    call: planned.call,
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
  // A withdraw's input comes out of a venue position, not out of the wallet.
  const inputs = steps.filter((step) => !funded.has(step.id) && step.input && step.kind !== "withdraw").map((step) => step.input as AssetAmount);
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

/** Phrases of the registrations the key may use (none without a key, a directory or with the kill switch on). */
async function contractPhrases(ownerKeyId: string | undefined): Promise<readonly ContractPhrase[]> {
  const directory = contractDirectory();
  if (!ownerKeyId || !directory || !contractsEnabled()) return [];
  return directory.phrases(ownerKeyId);
}

/** Plans an intent into a quote-backed IntentGraph (not persisted). */
export async function planIntent(input: unknown, options: PlanOptions = {}): Promise<IntentGraph> {
  return (await planIntentWithPreviews(input, options)).graph;
}

export interface PlannedIntent {
  readonly graph: IntentGraph;
  /**
   * Plan-time quote transactions by step id (asset-change preview, design
   * §5.1): what the winning quotes already returned, never stored in the graph.
   */
  readonly previews: ReadonlyMap<string, PlannedStepPreview>;
}

/**
 * Plans an intent and also returns the winning quotes' transactions for the
 * plan-time preview. The graph carries its immutable plan record
 * (`graph.plan`, receipts design §4.5), dry runs included.
 */
export async function planIntentWithPreviews(input: unknown, options: PlanOptions = {}): Promise<PlannedIntent> {
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
    const contracts = await contractPhrases(options.ownerKeyId);
    const compiled = compileIntentText(request.text ?? "", {
      ...(request.defaultNetwork ? { defaultNetwork: request.defaultNetwork } : {}),
      accounts: request.accounts,
      ...(contracts.length > 0 ? { contracts } : {}),
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
        const candidate = await draftStep(merged, previous, accounts, request, options.ownerKeyId);
        const venue = getProtocol(candidate.planned.protocol)?.name ?? candidate.adapter.label;
        draft = { ...candidate, merged: `Merged ${action.kind} (action ${index + 1}) and ${next.kind} on ${CHAINS[next.network].name} (action ${index + 2}) into one ${venue} cross-network swap into ${candidate.output?.symbol ?? next.to}; saves a signature and a settlement wait.` };
        index += 1;
      } catch (error) {
        // Name resolution failures are the user's input, not a missing merged route: report them.
        const code = toPlatformError(error).code;
        if (code.startsWith("RECIPIENT_") || code === "NAME_RESOLUTION_UNAVAILABLE") throw error;
        draft = null;
      }
    }
    draft ??= await draftStep(action, previous, accounts, request, options.ownerKeyId);
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
  if (drafts.some((draft) => draft.funded && draft.action.network.startsWith("solana") && draft.planned.input?.asset.endsWith("/slip44:501"))) {
    warnings.push("Keep a little SOL outside this intent for Solana network fees.");
  }
  if (steps.some((step) => CONTRACT_KINDS.includes(step.kind))) warnings.push(CUSTOM_CONTRACT_WARNING);
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
    nowMs + intentTtl(options.ttlMs),
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
  // The plan as created: prepare replaces amounts in the steps, never this record (receipts commit to it).
  const record = buildPlanRecord(graph);
  const previews = new Map<string, PlannedStepPreview>();
  drafts.forEach((draft, index) => {
    const preview = draft.planned.preview;
    const step = steps[index];
    if (preview && step && preview.transactions.length > 0) previews.set(step.id, preview);
  });
  return { graph: { ...graph, plan: { digest: planRecordDigest(record), record } }, previews };
}

/**
 * Re-times a just-planned graph (a Rule Book hold extends its lifetime,
 * policy design §7.1): expiry = createdAt + ttl (INTENT_TTL_MS..24 h), never
 * past the deadline; status and the plan record (which commits to the
 * expiry) follow. Only for graphs that were never stored.
 */
export function withIntentTtl(graph: IntentGraph, ttlMs: number, nowMs: number = Date.now()): IntentGraph {
  const created = Date.parse(graph.createdAt);
  const deadline = graph.request.constraints?.deadline;
  const expiry = Math.min(
    (Number.isFinite(created) ? created : nowMs) + intentTtl(ttlMs),
    deadline !== undefined ? deadline * 1000 : Number.POSITIVE_INFINITY,
  );
  const expiresAt = new Date(expiry).toISOString();
  if (expiresAt === graph.expiresAt) return graph;
  const { plan: _plan, ...rest } = graph;
  const next: IntentGraph = { ...rest, expiresAt, status: deriveIntentStatus(graph.steps, expiresAt, nowMs) };
  const record = buildPlanRecord(next);
  return { ...next, plan: { digest: planRecordDigest(record), record } };
}

/**
 * Rebuilds the adapter action for a step at prepare time. A step funded by a
 * previous step spends its share of that step's observed output when known,
 * otherwise of its guaranteed minimum.
 */
export function actionForStep(graph: IntentGraph, step: IntentStep): AdapterAction {
  if (CONTRACT_KINDS.includes(step.kind)) return contractActionForStep(graph, step);
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
  const output = step.kind === "transfer" || step.kind === "deposit" || step.kind === "withdraw" ? input : assetFromRef(step.minimumOutput);
  const venueId = recordedVenueId(step);
  const venue = venueId ? getYieldVenue(venueId) : null;
  if (venueId && (!venue || venue.network !== step.network || venue.protocol !== step.protocol)) {
    throw new PlatformError("STEP_INVALID", "The step's venue is not in the registry for its network and protocol.", 500);
  }
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
  const slippageBps = ref?.slippageBps ?? graph.request.constraints?.maxSlippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const accounts = parseAccounts(graph.request.accounts);
  if (fundingEdge && !accounts.some((own) => sameAddress(own, recipient))) {
    // A funded step paying someone else never pays more than the plan showed plus slippage: a larger
    // funding output (a "withdraw all" position that grew, positive slippage) stays with the user.
    const cap = (BigInt(ref?.plannedInput ?? step.input.amount) * BigInt(10_000 + slippageBps)) / 10_000n;
    if (BigInt(amount) > cap) amount = cap.toString();
  }
  // Same derivation as at plan time, from the intent's own accounts.
  const destinationAccount = destinationNetwork !== step.network ? ownAccountOn(accounts, destinationNetwork) : undefined;
  return {
    kind: step.kind,
    network: step.network,
    destinationNetwork,
    input,
    output,
    amount,
    account,
    recipient,
    slippageBps,
    ...(ref?.provider ? { provider: ref.provider } : {}),
    ...(venue ? { venue: venue.id } : {}),
    ...(ref?.closePosition && step.kind === "withdraw" ? { closePosition: true } : {}),
    ...(destinationAccount ? { destinationAccount } : {}),
  };
}

/** The amount a step executes now: its share of the funding step's observed output (else guaranteed minimum). */
function fundedAmount(graph: IntentGraph, step: IntentStep, input: AssetAmount, portionBps: number | undefined): { amount: string; funded: boolean } {
  const fundingEdge = graph.edges.find((edge) => edge.to === step.id && edge.kind === "funds");
  if (!fundingEdge) return { amount: input.amount, funded: false };
  const parent = graph.steps.find((candidate) => candidate.id === fundingEdge.from);
  const source = parent?.actualOutput && sameAsset(parent.actualOutput, input)
    ? parent.actualOutput
    : parent?.minimumOutput && sameAsset(parent.minimumOutput, input)
      ? parent.minimumOutput
      : null;
  const amount = source ? portionOf(source.amount, portionBps ?? 10_000) : input.amount;
  if (amount === "0") throw new PlatformError("AMOUNT_TOO_SMALL", "The funding step produced too little to continue.", 422);
  return { amount, funded: true };
}

/**
 * Prepare-time action of a call / action step: the step's own snapshot, its
 * (funded) amount, and the previous step's observed output for `$previous`
 * bindings. The service adds the re-read registration before the adapter runs.
 */
function contractActionForStep(graph: IntentGraph, step: IntentStep): AdapterAction {
  if (!step.call) throw new PlatformError("STEP_INVALID", "The call step has no contract snapshot.", 500);
  const account = parseAccountId(step.account);
  if (!account) throw new PlatformError("STEP_INVALID", "The step account is invalid.", 500);
  const recipient = step.recipient ? parseAccountId(step.recipient) : account;
  if (!recipient) throw new PlatformError("STEP_INVALID", "The step recipient is invalid.", 500);
  const ref = decodeStepRef(step.quoteRef);
  const input = step.input ? assetFromRef(step.input) : null;
  const output = step.call.output ? assetFromRef(step.call.output) : null;
  let amount = "0";
  let funded = false;
  if (step.input) {
    ({ amount, funded } = fundedAmount(graph, step, step.input, ref?.portionBps));
    const accounts = parseAccounts(graph.request.accounts);
    const slippageBps = ref?.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
    if (funded && !accounts.some((own) => sameAddress(own, recipient))) {
      const cap = (BigInt(ref?.plannedInput ?? step.input.amount) * BigInt(10_000 + slippageBps)) / 10_000n;
      if (BigInt(amount) > cap) amount = cap.toString();
    }
  }
  const parent = graph.steps.find((candidate) => candidate.id === step.dependsOn[0]);
  // `$previous.*` reads the previous step's output when it lands on this step's network.
  const previousOutput = parent && (parent.settlement?.destinationNetwork ?? parent.network) === step.network
    ? parent.actualOutput ?? parent.minimumOutput
    : undefined;
  const placeholder = input ?? assetFromRef({
    asset: nativeAssetId(step.network),
    symbol: CHAINS[step.network].nativeAsset.symbol,
    decimals: CHAINS[step.network].nativeAsset.decimals,
  });
  return {
    kind: step.kind,
    network: step.network,
    destinationNetwork: step.network,
    input: placeholder,
    output: output ?? placeholder,
    amount,
    account,
    recipient,
    slippageBps: ref?.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
    call: {
      snapshot: step.call,
      input,
      output,
      ...(previousOutput ? { previousOutput } : {}),
      funded,
      stage: "prepare",
    },
  };
}

/** Normalised recipient name of a step, when it was planned from one (service re-resolves it before prepare). */
export function stepRecipientName(step: IntentStep): string | null {
  return step.recipientName && step.recipient ? normalizeName(step.recipientName) : null;
}
