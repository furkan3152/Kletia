/**
 * Intent planner: IntentRequest -> IntentGraph.
 *
 * 1. Validate the request; compile text with the deterministic grammar or
 *    accept structured actions; apply the departure (`sourceNetwork`,
 *    departure.ts) unless the clarify layer already applied one.
 * 2. Normalise actions (kinds, networks, amounts, capital lane).
 * 3. Resolve assets, accounts, recipients (names through the resolver hook)
 *    and, for deposit / withdraw, the registry venue; bind each step to an
 *    adapter (respecting prefer/avoid constraints) and quote it. Cross-network
 *    steps run a venue auction (auction.ts); other steps take the first
 *    adapter that quotes.
 *    Same-network swaps with several candidate venues run the auction too.
 * 4. Chain dependent amounts from the previous step's guaranteed minimum
 *    (amount flow F1), recorded as `step.funding`; a funded step that spends
 *    the network's gas asset keeps a gas reserve when the account holds too
 *    little gas there (F6). Legs arriving on a network named in
 *    `constraints.gasOnArrival` are served only by venues that deliver gas
 *    with the fill (Relay today).
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
  evmChecksumState,
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
  fundedFlow,
  gasReserveUnits,
  fundingParent,
  parentCreditFromGraph,
  planRecordDigest,
  reserveTooLarge,
  type AccountId,
  type AssetAmount,
  type EvmContractAction,
  type IntentActionKind,
  type IntentActionSpec,
  type IntentEdge,
  type IntentDeparture,
  type IntentGraph,
  type IntentInterpretation,
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
import { activeProtocolAdapters, adapterForProtocol, avoidedDependency, candidateAdapters, effectiveProtocol } from "./adapters/registry.js";
import type { AdapterAction, AdapterRoute, ContractPlannedStep, PlannedStep, PlannedStepPreview, ProtocolAdapter } from "./adapters/types.js";
import { assertContractAmount } from "./contracts/caps.js";
import { contractDirectory, contractsEnabled, withActivationRetry, type ContractPhrase } from "./contracts/directory.js";
import { contractOutputAsset, evmSnapshot, solanaSnapshot } from "./contracts/snapshot.js";
import { assetAmount, assetFromRef, resolveAsset, resolvedFromDescriptor, sameAsset, type ResolvedAsset } from "./assets.js";
import { DEFAULT_MAX_SECONDS, describeQuote, exclusionReason, runVenueAuction, type AuctionResult } from "./auction.js";
import { pickFundedSource, resolveDeparture, type DepartureBalanceReader } from "./departure.js";
import { knownAmount, readFacts } from "./holdings.js";
import { estimateStepFee, gasPriceFrom, rentFrom, SOLANA_WALLET_RENT_FALLBACK } from "./journey/fees.js";
import { compileIntentText, EVM_STAKING_NETWORK, EVM_STAKING_TOKENS, GRAMMAR_EXAMPLES, LIQUID_STAKING_TOKENS, MissingSourceError, type GrammarResult } from "./grammar.js";
import { looksLikeName, normalizeName, resolveRecipientName, type NameResolution } from "./names.js";
import { screenIntentRequest } from "./secretScreen.js";
import { decodeStepRef, encodeStepRef } from "./stepRef.js";
import { newIntentId, portionOf, roundUsd } from "./util.js";

export const DEFAULT_SLIPPAGE_BPS = 50;
export const INTENT_TTL_MS = 30 * 60 * 1000;

const SUPPORTED_KINDS: readonly IntentActionKind[] = ["swap", "transfer", "bridge", "stake", "deposit", "withdraw", "call", "action"];
/** Kinds bound to an integrator contract registration (`contract` + `entry`). */
const CONTRACT_KINDS: readonly IntentActionKind[] = ["call", "action"];
/** Lending protocols in the order a deposit / withdraw without a named protocol tries them. */
export const LENDING_PROTOCOLS: readonly ProtocolId[] = [
  "aave-v3", "compound-v3", "morpho", "moonwell", "jupiter-lend", "kamino",
  // round 6: appended, so unnamed deposits keep their defaults
  "spark-savings", "fluid", "sparklend", "yearn-v3",
];
/** Solana liquid staking: protocol id -> LIQUID_STAKING_TOKENS key (routes run through Jupiter). */
const STAKE_PROTOCOLS: Readonly<Partial<Record<ProtocolId, string>>> = {
  jito: "jito",
  marinade: "marinade",
  sanctum: "jupiter",
  jupiter: "jito",
};
/** EVM liquid staking on Ethereum: protocol id -> the token it mints and the provider label. */
const EVM_STAKE_PROTOCOLS: Readonly<Partial<Record<ProtocolId, { readonly symbol: string; readonly provider: string }>>> = Object.fromEntries(
  Object.values(EVM_STAKING_TOKENS).map((entry) => [entry.protocol, { symbol: entry.symbol, provider: entry.provider }]),
);
/** Networks liquid staking may plan on (the adapters decide what is live). */
const STAKE_NETWORKS: readonly NetworkKey[] = ["solana", EVM_STAKING_NETWORK];

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
   * The key whose registrations the plan may call instead of the owner's: a
   * session minted from a project flow is owned by the publishable key and
   * calls the registrations of the key that saved the flow (integrator
   * design 4.8). Default: `ownerKeyId`.
   */
  readonly contractAuthorityKeyId?: string;
  /**
   * Intent lifetime (default INTENT_TTL_MS): intents held for Rule Book
   * approval live longer so a human has time (policy design §7.1). Still
   * capped by `constraints.deadline`.
   */
  readonly ttlMs?: number;
  /**
   * Interpretation extras from the clarify layer (assumptions, thread,
   * departure), merged into `graph.interpretation`. When it carries a
   * `departure`, clarify already applied it: the request's `sourceNetwork`
   * is then ignored, so a departure is never applied twice.
   */
  readonly interpretation?: PlanInterpretation;
  /** Balance reader of the departure step (tests); default: holdings.ts. */
  readonly readBalance?: DepartureBalanceReader;
}

/** What the clarify layer adds to `graph.interpretation`. */
export type PlanInterpretation = Partial<Pick<IntentInterpretation, "departure" | "assumptions" | "thread">>;

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
    if (kind === "stake" && CHAINS[spec.network].vm === "evm") {
      // EVM liquid staking: the protocol comes from the request or from the token it mints (default Lido).
      const byTarget = to
        ? (Object.entries(EVM_STAKE_PROTOCOLS).find(([, entry]) => entry?.symbol.toUpperCase() === to?.toUpperCase())?.[0] as ProtocolId | undefined)
        : undefined;
      if (protocol && !EVM_STAKE_PROTOCOLS[protocol]) {
        throw unsupported(
          `Liquid staking on ${CHAINS[spec.network].name} runs through Lido, Rocket Pool or ether.fi, not ${getProtocol(protocol)?.name ?? protocol}.`,
          GRAMMAR_EXAMPLES,
          issue(`${path}.protocol`, "Unsupported."),
        );
      }
      if (to && !byTarget) {
        throw unsupported(`Liquid staking on ${CHAINS[spec.network].name} mints wstETH (Lido), rETH (Rocket Pool) or weETH (ether.fi), not ${to}.`, GRAMMAR_EXAMPLES, issue(`${path}.to`, "Unsupported."));
      }
      protocol = protocol ?? byTarget ?? "lido";
      const target = EVM_STAKE_PROTOCOLS[protocol] as { symbol: string; provider: string };
      if (to && byTarget !== protocol) {
        throw unsupported(`${getProtocol(protocol)?.name ?? protocol} mints ${target.symbol}, not ${to}.`, GRAMMAR_EXAMPLES, issue(`${path}.to`, "Mismatch."));
      }
      to = target.symbol;
      provider = provider ?? target.provider;
    } else if (kind === "stake") {
      if (protocol && EVM_STAKE_PROTOCOLS[protocol]) {
        throw unsupported(
          `${getProtocol(protocol)?.name ?? protocol} stakes ETH on Ethereum; SOL stakes with Jito, Marinade or Jupiter.`,
          GRAMMAR_EXAMPLES,
          issue(`${path}.protocol`, "Unsupported on this network."),
        );
      }
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

/** "a", "a and b", "a, b and c". */
function joinList(items: readonly string[], last = "and"): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ${last} ${items[items.length - 1]}`;
}

/** A registry asset of `network` as a resolved asset, without lookups (null when not listed). */
function listedAsset(network: NetworkKey, symbol: string): ResolvedAsset | null {
  const descriptor = (symbol === CHAINS[network].nativeAsset.symbol ? getAsset(nativeAssetId(network)) : null) ?? findAssetBySymbol(network, symbol);
  return descriptor ? resolvedFromDescriptor(descriptor) : null;
}

/** Names of the active adapters' protocols that serve a probe route (both directions). */
function liveVenuesFor(kind: "swap" | "stake", network: NetworkKey, input: ResolvedAsset, output: ResolvedAsset): string[] {
  const routes: AdapterRoute[] = [
    { kind, network, destinationNetwork: network, input, output },
    ...(kind === "swap" ? [{ kind, network, destinationNetwork: network, input: output, output: input }] : []),
  ];
  const names = activeProtocolAdapters().flatMap((adapter) =>
    routes.filter((route) => adapter.supports(route)).map((route) => getProtocol(effectiveProtocol(adapter, route))?.name ?? adapter.label));
  return [...new Set(names)];
}

/** "Swaps run on Base or Arbitrum One (Relay) and Solana (Jupiter)", from the live adapters on the route's capital lane. */
function liveSwapText(lane: NetworkKey): string {
  const groups = new Map<string, string[]>();
  for (const network of Object.keys(CHAINS) as NetworkKey[]) {
    if (!sameCapitalLane(network, lane)) continue;
    const native = listedAsset(network, CHAINS[network].nativeAsset.symbol);
    const usdc = listedAsset(network, "USDC");
    if (!native || !usdc || sameAsset(native, usdc)) continue;
    const venues = liveVenuesFor("swap", network, native, usdc);
    if (venues.length === 0) continue;
    const key = joinList(venues);
    groups.set(key, [...(groups.get(key) ?? []), CHAINS[network].name]);
  }
  if (groups.size === 0) return "No swap venue is enabled on this deployment";
  return `Swaps run on ${joinList([...groups.entries()].map(([venues, networks]) => `${joinList(networks, "or")} (${venues})`))}`;
}

/** "Liquid staking runs on Solana (SOL → JitoSOL, mSOL or JupSOL)", from the live adapters. */
function liveStakeText(): string {
  const parts: string[] = [];
  const solana = listedAsset("solana", "SOL");
  const solTargets = ["JitoSOL", "mSOL", "JupSOL"].filter((symbol) => {
    const output = listedAsset("solana", symbol);
    return solana && output && liveVenuesFor("stake", "solana", solana, output).length > 0;
  });
  if (solTargets.length > 0) parts.push(`Solana mainnet (SOL → ${joinList(solTargets, "or")})`);
  const eth = listedAsset(EVM_STAKING_NETWORK, "ETH");
  const ethTargets = Object.values(EVM_STAKE_PROTOCOLS).map((entry) => entry?.symbol as string).filter((symbol) => {
    const output = listedAsset(EVM_STAKING_NETWORK, symbol);
    return eth && output && liveVenuesFor("stake", EVM_STAKING_NETWORK, eth, output).length > 0;
  });
  if (ethTargets.length > 0) parts.push(`${CHAINS[EVM_STAKING_NETWORK].name} (ETH → ${joinList([...new Set(ethTargets)], "or")})`);
  return parts.length > 0 ? `Liquid staking runs on ${joinList(parts)}` : "No liquid staking venue is enabled on this deployment";
}

function unsupportedRoute(route: AdapterRoute): PlatformError {
  const network = CHAINS[route.network].name;
  const live = liveVenueNames(route.kind);
  const routes = "GET /v1/networks lists the live routes.";
  const messages: Record<string, string> = {
    swap: `${liveSwapText(route.network)}; ${route.input.symbol} → ${route.output.symbol} on ${network} is not available for the requested protocol and constraints.`,
    stake: `${liveStakeText()}.`,
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
  if (!looksLikeName(raw)) {
    const recipient = recipientForNetwork(raw, network);
    // A mixed-case EVM address whose capitals do not match EIP-55 is usually a mistyped character: never pay it.
    if (recipient.chain.namespace === "eip155" && evmChecksumState(recipient.address) === "invalid") {
      throw new PlatformError(
        "RECIPIENT_CHECKSUM_INVALID",
        `Check the address ${recipient.address.slice(0, 10)}…${recipient.address.slice(-6)}: its capital letters do not match its EIP-55 checksum, which usually means a mistyped character.`,
        422,
        issue("recipient", "EIP-55 checksum mismatch."),
      );
    }
    return { recipient };
  }
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
 * Cross-network steps and same-network swaps with several candidate venues
 * run the venue auction; every other step takes the first candidate (in
 * preference order) that quotes.
 */
async function planWithCandidates(
  candidates: readonly ProtocolAdapter[],
  action: AdapterAction,
  request: IntentRequest,
): Promise<CandidateSelection> {
  const crossNetwork = action.kind === "bridge" && action.network !== action.destinationNetwork;
  const swapAuction = action.kind === "swap" && action.network === action.destinationNetwork && candidates.length > 1;
  if (crossNetwork || swapAuction) {
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
  /** F6: gas-asset units kept back from what arrives (recorded as `funding.gasReserve`). */
  readonly gasReserve?: AssetAmount;
  /** Gas on arrival this leg delivers (USD asked; the venue's amount is `planned.gasTopup`). */
  readonly gasTopupUsd?: string;
}

function canMerge(bridge: NormalizedAction, next: NormalizedAction | undefined, request: IntentRequest): next is NormalizedAction {
  if (!next || bridge.kind !== "bridge") return false;
  if (next.kind !== "swap" && next.kind !== "stake") return false;
  if (next.network !== bridge.destinationNetwork || next.amount.type !== "previous" || next.amount.portionBps !== 10_000) return false;
  if (next.recipient || !next.to) return false;
  // A named destination venue stays a separate, wallet-reviewed step: a bridge auction cannot promise that its
  // destination swap uses that venue.
  if (next.kind === "swap" && next.protocol && !getProtocol(next.protocol)?.crossChain) return false;
  const prefer = request.constraints?.preferProtocols ?? [];
  // A preferred local swap venue (and no cross-network venue) means "swap on the destination", not one merged route.
  if (prefer.some((id) => getProtocol(id)?.kinds?.includes("swap") && !getProtocol(id)?.crossChain) && !prefer.some((id) => getProtocol(id)?.crossChain)) return false;
  if (next.from && bridge.to && next.from.toUpperCase() !== bridge.to.toUpperCase()) return false;
  if (next.from && !bridge.to && bridge.from && next.from.toUpperCase() !== bridge.from.toUpperCase()) return false;
  return true;
}

/* --------------------------------------------------- gas reserve (F6) */

/** What the F6 gas reserve reads for one network: the account's gas balance and fee facts (null: unknown). */
export interface GasReserveFacts {
  readonly balance: bigint | null;
  readonly gasPriceWei: bigint | null;
  readonly walletRentLamports: bigint | null;
  readonly tokenAccountRentLamports: bigint | null;
}

export type GasReserveReader = (network: NetworkKey, account: ParsedAccountId, accounts: readonly AccountId[]) => Promise<GasReserveFacts>;

/** Deadline of the reserve's reads; a late or failed read counts as zero gas (fail closed: the reserve is kept). */
const GAS_RESERVE_DEADLINE_MS = 2_500;

/**
 * Wei per gas used when `eth_gasPrice` cannot be read: upper bounds of
 * recent prices (an estimate that is too high keeps a few cents more; one
 * that is too low leaves the user without gas).
 */
const FALLBACK_GAS_PRICE_WEI: Readonly<Partial<Record<NetworkKey, bigint>>> = Object.freeze({
  ethereum: 20_000_000_000n,
  base: 100_000_000n,
  optimism: 100_000_000n,
  arbitrum: 500_000_000n,
  polygon: 800_000_000_000n,
  arc: 300_000_000_000n,
  "arbitrum-sepolia": 500_000_000n,
});
const FALLBACK_GAS_PRICE_DEFAULT_WEI = 20_000_000_000n;

/** The default reader: holdings.readFacts (cached there), within GAS_RESERVE_DEADLINE_MS. */
const defaultGasReserveReader: GasReserveReader = async (network, account, accounts) => {
  const evm = CHAINS[network].vm === "evm";
  const facts = await readFacts(accounts, [
    { kind: "balance", network, asset: CHAINS[network].nativeAsset.symbol, owner: account.address },
    evm ? { kind: "gasPrice", network } : { kind: "solanaRent", network },
  ], { deadlineMs: GAS_RESERVE_DEADLINE_MS, balances: 1 });
  const rent = rentFrom(facts, network);
  return {
    balance: knownAmount(facts.balances[0]),
    gasPriceWei: evm ? gasPriceFrom(facts, network) : null,
    walletRentLamports: rent.wallet,
    tokenAccountRentLamports: rent.tokenAccount,
  };
};

let gasReserveReader: GasReserveReader = defaultGasReserveReader;

/** Replaces the F6 reserve's reads (tests); `null` restores the holdings reader. */
export function configureGasReserveReader(reader: GasReserveReader | null): void {
  gasReserveReader = reader ?? defaultGasReserveReader;
}

/**
 * F6 gas reserve of a funded step whose input is the network's gas asset:
 * zero when the account already holds enough gas there for this step and
 * the later steps on the same network (fees from journey/fees.ts, the
 * costliest candidate venue counted), else gasReserveUnits(fees, Solana
 * wallet rent when the wallet is empty). An unreadable balance counts as zero.
 */
async function plannedGasReserve(
  action: NormalizedAction,
  input: ResolvedAsset,
  protocols: readonly ProtocolId[],
  later: readonly NormalizedAction[],
  account: ParsedAccountId,
  request: IntentRequest,
): Promise<bigint> {
  const network = action.network;
  const svm = CHAINS[network].vm === "svm";
  const facts = await gasReserveReader(network, account, request.accounts).catch((): GasReserveFacts => ({
    balance: null, gasPriceWei: null, walletRentLamports: null, tokenAccountRentLamports: null,
  }));
  const gasPriceWei = facts.gasPriceWei ?? FALLBACK_GAS_PRICE_WEI[network] ?? FALLBACK_GAS_PRICE_DEFAULT_WEI;
  const fee = (kind: IntentActionKind, protocol: ProtocolId, spends: { readonly asset: string } | undefined): bigint => {
    const estimate = estimateStepFee({ kind, network, protocol, ...(spends ? { input: spends } : {}) }, {
      gasPriceWei,
      tokenAccountRentLamports: facts.tokenAccountRentLamports,
      // A swap, stake or deposit may create the output's token account (unknown counts as missing).
      ...(svm && kind !== "transfer" ? { tokenAccounts: [null] } : {}),
    });
    return estimate.amount === null ? 0n : BigInt(estimate.amount);
  };
  const own = (protocols.length > 0 ? protocols : [action.protocol ?? "relay"]).map((protocol) => fee(action.kind, protocol, { asset: input.id }));
  let fees = own.reduce((max, value) => (value > max ? value : max), 0n);
  for (const next of later) {
    if (next.network !== network) continue;
    const protocol: ProtocolId = next.protocol ?? (CONTRACT_KINDS.includes(next.kind) ? "custom-call" : UNKNOWN_PROTOCOL);
    fees += fee(next.kind, protocol, undefined);
  }
  if (facts.balance !== null && facts.balance >= fees) return 0n;
  const emptyWallet = facts.balance === null || facts.balance === 0n;
  const rent = svm && emptyWallet ? facts.walletRentLamports ?? SOLANA_WALLET_RENT_FALLBACK : 0n;
  return gasReserveUnits(fees, rent);
}

/** A later step whose venue is not chosen yet: fees.ts then counts the kind's costliest typical transactions. */
const UNKNOWN_PROTOCOL = "" as ProtocolId;

/** How a draft is planned beyond the action itself (later actions, reserves already kept, gas on arrival). */
interface DraftContext {
  /** Actions after this one (the F6 reserve covers the later steps on the same network). */
  readonly later: readonly NormalizedAction[];
  /** `${network}|${account}` pairs whose gas reserve an earlier step already keeps. */
  readonly reserved: ReadonlySet<string>;
  /** USD of destination gas this leg should deliver (constraints.gasOnArrival), when it is eligible. */
  readonly gasTopupUsd?: string;
}

const NO_DRAFT_CONTEXT: DraftContext = { later: [], reserved: new Set() };

async function draftStep(
  action: NormalizedAction,
  previous: PreviousStep | null,
  accounts: readonly ParsedAccountId[],
  request: IntentRequest,
  ownerKeyId?: string,
  context: DraftContext = NO_DRAFT_CONTEXT,
): Promise<StepDraft> {
  if (CONTRACT_KINDS.includes(action.kind)) return draftContractStep(action, previous, accounts, request, ownerKeyId);
  if (action.kind === "stake" && !STAKE_NETWORKS.includes(action.network)) {
    throw unsupported(`${liveStakeText()}, not ${CHAINS[action.network].name}.`, GRAMMAR_EXAMPLES);
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
  const transferOnly = [input, output].find((asset) => asset.transferOnly);
  if (transferOnly && action.kind !== "transfer") {
    // Listed for balances and transfers only (USDbC is Base's legacy bridged USDC, a different token from USDC).
    const usdc = findAssetBySymbol(transferOnly.network, "USDC") ? " Use USDC instead." : "";
    throw new PlatformError(
      "ROUTE_UNSUPPORTED",
      `${transferOnly.symbol} can only be sent, not ${action.kind === "swap" ? "swapped" : action.kind === "bridge" ? "bridged" : `used in a ${action.kind}`}: no venue route takes it.${usdc}`,
      422,
      issue(`actions[${action.index}].${transferOnly === input ? "from" : "to"}`, "Transfer-only asset."),
    );
  }
  const { recipient, name } = await resolveRecipient(action, account, accounts);
  const closePosition = action.amount.type === "position";
  let amount = action.amount.type === "exact"
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
  if (requested && !choice) {
    // A named venue is never replaced: an avoided venue, or one routed through an avoided protocol, refuses the step.
    const name = getProtocol(requested)?.name ?? requested;
    if ((request.constraints?.avoidProtocols ?? []).includes(requested)) {
      throw unsupported(`${name} is named here but constraints.avoidProtocols excludes it.`, GRAMMAR_EXAMPLES, issue(`actions[${action.index}].protocol`, "Avoided."));
    }
    const dependency = avoidedDependency(requested, request.constraints);
    if (dependency) {
      throw unsupported(
        `${name} ${action.kind === "swap" ? "swaps run" : "routes run"} through the ${getProtocol(dependency)?.name ?? dependency} program, which constraints.avoidProtocols excludes.`,
        GRAMMAR_EXAMPLES,
        issue(`actions[${action.index}].protocol`, "Routed through an avoided protocol."),
      );
    }
  }
  let candidates = candidateAdapters(route, request.constraints, requested);
  if (candidates.length === 0) throw noCandidates(route, requested);
  // Gas on arrival: an eligible leg (own recipient, output not the destination's gas asset) is served only by
  // venues that deliver gas with the fill.
  const gasTopupUsd = context.gasTopupUsd !== undefined && gasTopupEligible(route, recipient, accounts) ? context.gasTopupUsd : undefined;
  if (gasTopupUsd !== undefined) {
    candidates = candidates.filter((adapter) => adapter.supportsGasTopup?.(route) === true);
    if (candidates.length === 0) throw gasTopupUnavailable(route.destinationNetwork, request);
  }
  // F6: a funded step spending the network's gas asset keeps what its fees need when the account has no gas there.
  let gasReserve: AssetAmount | undefined;
  const reserveKey = `${action.network}|${account.id.toLowerCase()}`;
  if (action.amount.type === "previous" && input.isNative && !context.reserved.has(reserveKey)) {
    const protocols = [...new Set(candidates.map((adapter) => effectiveProtocol(adapter, route)))];
    const reserve = await plannedGasReserve(action, input, protocols, context.later, account, request);
    if (reserve > 0n) {
      const share = BigInt(amount);
      if (reserveTooLarge(reserve, share)) {
        throw new PlatformError(
          "AMOUNT_TOO_SMALL",
          `What arrives for step ${action.index + 1} (${fromBaseUnits(share, input.decimals)} ${input.symbol}) would mostly pay network fees on ${CHAINS[action.network].name}: ${fromBaseUnits(reserve, input.decimals)} ${input.symbol} must stay for gas. Send more, or bring gas to ${CHAINS[action.network].name} first.`,
          422,
          issue(`actions[${action.index}].amount`, "Below the gas reserve."),
        );
      }
      amount = (share - reserve).toString();
      gasReserve = assetAmount(input, reserve.toString());
    }
  }
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
    ...(gasTopupUsd !== undefined ? { gasTopupUsd } : {}),
  };
  const { adapter, planned, auction } = await planWithCandidates(candidates, adapterAction, request);
  if (gasTopupUsd !== undefined && !planned.gasTopup) {
    throw new PlatformError("PROVIDER_TRANSACTION_INVALID", `${adapter.label} planned the leg without the gas top-up it was asked for.`, 502);
  }
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
    notes: [
      ...(choice?.warnings ?? []),
      ...(auction?.warnings ?? []),
      ...(gasReserve ? [reserveWarning(gasReserve, action.network)] : []),
      ...(gasTopupUsd !== undefined && planned.gasTopup ? [topupWarning(planned.gasTopup, route.destinationNetwork, adapter)] : []),
    ],
    output: sameAsset(plannedOutput, output) ? output : assetFromRef(plannedOutput),
    funded: action.amount.type === "previous",
    ...(action.amount.type === "previous" ? { portionBps: action.amount.portionBps } : {}),
    ...(gasReserve ? { gasReserve } : {}),
    ...(gasTopupUsd !== undefined ? { gasTopupUsd } : {}),
  };
}

/** Committed warning line of a gas reserve (in the step and the plan record). */
function reserveWarning(reserve: AssetAmount, network: NetworkKey): string {
  return `Keeps ${reserve.formatted} ${reserve.symbol} of what arrives for network fees on ${CHAINS[network].name}.`;
}

/** Committed warning line of a gas top-up. */
function topupWarning(topup: AssetAmount, network: NetworkKey, adapter: ProtocolAdapter): string {
  const usd = topup.usd !== undefined ? ` (about $${topup.usd.toFixed(2)})` : "";
  return `Includes a gas top-up of ${topup.formatted} ${topup.symbol}${usd} on ${CHAINS[network].name}, delivered with the ${getProtocol(adapter.id)?.name ?? adapter.label} fill.`;
}

/** A cross-network leg can carry gas on arrival when it pays the user's own account and does not deliver the gas asset itself. */
function gasTopupEligible(route: AdapterRoute, recipient: ParsedAccountId, accounts: readonly ParsedAccountId[]): boolean {
  return route.kind === "bridge" && route.network !== route.destinationNetwork && !route.output.isNative &&
    accounts.some((own) => sameAddress(own, recipient));
}

function gasTopupUnavailable(network: NetworkKey, request: IntentRequest): PlatformError {
  const avoided = (request.constraints?.avoidProtocols ?? []).includes("relay") ? " (constraints.avoidProtocols excludes Relay)" : "";
  return new PlatformError(
    "GAS_TOPUP_UNAVAILABLE",
    `No venue can deliver gas on ${CHAINS[network].name} with this leg${avoided}. Relay serves EVM destinations when the output is not the gas asset; remove constraints.gasOnArrival.${network}, or bring gas yourself.`,
    422,
    issue(`constraints.gasOnArrival.${network}`, "No venue delivers gas with this leg."),
  );
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

/** `funding` of a step that spends the previous step's output (share and F6 reserve); none otherwise. */
function stepFunding(draft: StepDraft, previous: PreviousStep | null): Pick<IntentStep, "funding"> {
  if (!draft.funded || !previous) return {};
  return {
    funding: {
      from: previous.step.id,
      portionBps: draft.portionBps ?? 10_000,
      ...(draft.gasReserve ? { gasReserve: draft.gasReserve } : {}),
    },
  };
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
    ...stepFunding(draft, previous),
    ...(draft.gasTopupUsd !== undefined && planned.gasTopup ? { gasTopup: planned.gasTopup } : {}),
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
      // Prepare asks the same top-up again.
      ...(draft.gasTopupUsd !== undefined && planned.gasTopup ? { gasTopupUsd: draft.gasTopupUsd } : {}),
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
    ...stepFunding(draft, previous),
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

/**
 * What a funded child takes from its parent's output in the summary: its
 * share of what the parent produces (observed, else expected) minus its gas
 * reserve (which stays with the user), capped for a third-party recipient:
 * the same rule prepare applies (core flow.ts). The planned input (a share
 * of the guaranteed minimum) is not used: it would list the gap between
 * expected and minimum as money "received" at the stop.
 */
function consumedByChild(child: IntentStep, produced: AssetAmount, flowGraph: IntentGraph): bigint {
  const ref = decodeStepRef(child.quoteRef);
  const units = BigInt(produced.amount);
  const flow = fundedFlow(flowGraph, child, { expected: units, worst: units, certainty: "quoted" }, {
    ...(ref?.slippageBps !== undefined ? { slippageBps: ref.slippageBps } : {}),
    ...(ref?.plannedInput !== undefined ? { plannedInput: BigInt(ref.plannedInput) } : {}),
    ...(ref?.portionBps !== undefined ? { portionBps: ref.portionBps } : {}),
  });
  return flow.spends.expected;
}

export function summarize(
  steps: readonly IntentStep[],
  edges: readonly IntentEdge[],
  signatures: number,
  title: string,
  request: Pick<IntentRequest, "accounts" | "constraints">,
): IntentSummary {
  const funded = new Set(edges.filter((edge) => edge.kind === "funds").map((edge) => edge.to));
  // fundedFlow reads only the graph's request (own accounts, slippage); the summary has no full graph yet.
  const flowGraph = { request, steps, edges } as unknown as IntentGraph;
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
      .map((edge) => steps.find((candidate) => candidate.id === edge.to))
      .filter((child): child is IntentStep => child?.input !== undefined && sameAsset(child.input, produced))
      .reduce((total, child) => total + consumedByChild(child, produced, flowGraph), 0n);
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
  // Also here for callers that plan without creating (POST /v1/policy/evaluate): secrets are never planned.
  screenIntentRequest(input);
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

  // A departure the clarify layer applied is kept as is; sourceNetwork is then ignored (never applied twice).
  const suppliedDeparture = options.interpretation?.departure;
  const sourceNetwork = suppliedDeparture ? undefined : request.sourceNetwork;
  const fixedSource = sourceNetwork !== undefined && sourceNetwork !== "auto" ? sourceNetwork : undefined;
  const readBalance = options.readBalance;
  let departure: IntentDeparture | undefined = suppliedDeparture;
  const plannerWarnings: string[] = [];

  let source: "structured" | "grammar";
  let specs: readonly IntentActionSpec[];
  let explicitNetwork: readonly boolean[];
  let normalizedText: string | undefined;
  let confidence = 1;
  if (request.actions && request.actions.length > 0) {
    source = "structured";
    specs = request.actions;
    // Structured actions name their networks: they win over a departure like a sentence that names one.
    explicitNetwork = specs.map(() => true);
  } else {
    const contracts = await contractPhrases(options.contractAuthorityKeyId ?? options.ownerKeyId);
    const compile = (defaultNetwork: NetworkKey | undefined): GrammarResult => compileIntentText(request.text ?? "", {
      ...(defaultNetwork ? { defaultNetwork } : {}),
      accounts: request.accounts,
      ...(contracts.length > 0 ? { contracts } : {}),
    });
    // A fixed departure also serves as defaultNetwork when the request has none.
    const defaultNetwork = request.defaultNetwork ?? fixedSource;
    let compiled: GrammarResult;
    try {
      compiled = compile(defaultNetwork);
    } catch (error) {
      // auto: a bridge whose sentence names no source starts on the best-funded network.
      if (sourceNetwork !== "auto" || !(error instanceof MissingSourceError)) throw error;
      const picked = await pickFundedSource(error.missing, request.accounts, request, readBalance);
      compiled = compile(picked.network);
      departure = picked.departure;
    }
    source = "grammar";
    specs = compiled.actions;
    explicitNetwork = compiled.explicitNetwork;
    normalizedText = compiled.normalizedText;
    confidence = compiled.confidence;
    plannerWarnings.push(...compiled.warnings);
  }
  if (sourceNetwork !== undefined && departure === undefined) {
    const resolved = await resolveDeparture(specs, explicitNetwork, request, request.accounts, readBalance);
    specs = resolved.actions;
    departure = resolved.departure;
    plannerWarnings.push(...resolved.warnings);
  }
  const actions = normalizeActions(specs, request);
  // Registrations resolve against the contract authority (a flow's saver) when one is given.
  const contractKeyId = options.contractAuthorityKeyId ?? options.ownerKeyId;

  const drafts: StepDraft[] = [];
  const optimizations: string[] = [];
  let previous: PreviousStep | null = null;
  const steps: IntentStep[] = [];
  // Gas on arrival: networks still waiting for the first eligible leg that arrives there.
  const topups = new Map(Object.entries(request.constraints?.gasOnArrival ?? {}) as [NetworkKey, string][]);
  const arrivals = new Map<NetworkKey, "native" | "third-party">();
  const reserved = new Set<string>();
  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index] as NormalizedAction;
    const next = actions[index + 1];
    let draft: StepDraft | null = null;
    const gasTopupUsd = action.kind === "bridge" ? topups.get(action.destinationNetwork) : undefined;
    const context = (later: readonly NormalizedAction[]): DraftContext => ({ later, reserved, ...(gasTopupUsd !== undefined ? { gasTopupUsd } : {}) });
    if (canMerge(action, next, request)) {
      const merged: NormalizedAction = {
        ...action,
        to: next.to as string,
        ...(next.provider ? { provider: next.provider } : {}),
      };
      try {
        const candidate = await draftStep(merged, previous, accounts, request, contractKeyId, context(actions.slice(index + 2)));
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
    draft ??= await draftStep(action, previous, accounts, request, contractKeyId, context(actions.slice(index + 1)));
    if (draft.merged) optimizations.push(draft.merged);
    if (draft.gasReserve) reserved.add(`${draft.action.network}|${draft.account.id.toLowerCase()}`);
    if (gasTopupUsd !== undefined) {
      if (draft.gasTopupUsd !== undefined) topups.delete(action.destinationNetwork);
      else if (!arrivals.has(action.destinationNetwork)) arrivals.set(action.destinationNetwork, draft.output?.isNative ? "native" : "third-party");
    }
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

  // A named network no eligible leg arrives on: refused, except a leg that delivers the gas asset itself.
  for (const network of topups.keys()) {
    const arrival = arrivals.get(network);
    if (arrival === "native") {
      plannerWarnings.push(`No gas top-up on ${CHAINS[network].name}: the leg arriving there delivers ${CHAINS[network].nativeAsset.symbol} itself.`);
      continue;
    }
    throw new PlatformError(
      "INVALID_REQUEST",
      arrival === "third-party"
        ? `The leg arriving on ${CHAINS[network].name} pays another account; gas on arrival is delivered to your own account only.`
        : `No leg of this intent arrives on ${CHAINS[network].name}.`,
      400,
      issue(`constraints.gasOnArrival.${network}`, arrival === "third-party" ? "The leg pays another account." : "No leg arrives on this network."),
    );
  }
  // Reserves and top-ups are committed in the plan record (its warnings).
  for (const draft of drafts) {
    for (const note of draft.notes) {
      if (note.startsWith("Keeps ") || note.startsWith("Includes a gas top-up")) plannerWarnings.push(note);
    }
  }
  const warnings: string[] = [...new Set(plannerWarnings)];
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
      ...(departure ? { departure } : {}),
      ...(options.interpretation?.assumptions ? { assumptions: options.interpretation.assumptions } : {}),
      ...(options.interpretation?.thread ? { thread: options.interpretation.thread } : {}),
    },
    steps,
    edges,
    summary: summarize(steps, edges, signatures, title.slice(0, 200), request),
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
 * otherwise of its guaranteed minimum, minus its planned gas reserve (F3, F6;
 * core flow.ts). A leg planned with gas on arrival asks the same top-up again.
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
  const slippageBps = ref?.slippageBps ?? graph.request.constraints?.maxSlippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const amount = fundedAmount(graph, step, step.input, ref, slippageBps).amount;
  const accounts = parseAccounts(graph.request.accounts);
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
    ...(ref?.gasTopupUsd !== undefined && step.gasTopup ? { gasTopupUsd: ref.gasTopupUsd } : {}),
  };
}

/**
 * The amount a step executes now (core flow.ts): its share of the funding
 * step's observed output (else guaranteed minimum), minus its gas reserve,
 * and for a third-party recipient never more than the planned input plus
 * slippage (a larger funding output, e.g. a "withdraw all" position that
 * grew or positive slippage, stays with the user).
 */
function fundedAmount(
  graph: IntentGraph,
  step: IntentStep,
  input: AssetAmount,
  ref: ReturnType<typeof decodeStepRef>,
  slippageBps: number,
): { amount: string; funded: boolean } {
  if (!fundingParent(graph, step)) return { amount: input.amount, funded: false };
  const credit = parentCreditFromGraph(graph, { ...step, input });
  let amount = input.amount;
  if (credit) {
    const flow = fundedFlow(graph, { ...step, input }, credit, {
      slippageBps,
      plannedInput: BigInt(ref?.plannedInput ?? input.amount),
      ...(ref?.portionBps !== undefined ? { portionBps: ref.portionBps } : {}),
    });
    amount = flow.spends.worst.toString();
  }
  if (amount === "0") {
    throw new PlatformError(
      "AMOUNT_TOO_SMALL",
      step.funding?.gasReserve
        ? `The funding step delivered too little to continue after keeping ${step.funding.gasReserve.formatted} ${step.funding.gasReserve.symbol} for network fees.`
        : "The funding step produced too little to continue.",
      422,
    );
  }
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
    ({ amount, funded } = fundedAmount(graph, step, step.input, ref, ref?.slippageBps ?? DEFAULT_SLIPPAGE_BPS));
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
