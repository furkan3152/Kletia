/**
 * Stage 3: resolve inputs, outputs, recipients and registry venues, and
 * the live-venue wording of unsupported routes.
 */
import {
  CHAINS,
  counterpartAsset,
  evmChecksumState,
  findAssetBySymbol,
  findYieldVenue,
  getAsset,
  getProtocol,
  isSolanaAddress,
  nativeAssetId,
  PROTOCOLS,
  sameCapitalLane,
  YIELD_VENUES,
  venueExecutes,
  yieldVenuesFor,
  type IntentActionKind,
  type IntentActionSpec,
  type IntentRequest,
  type NetworkKey,
  type ParsedAccountId,
  type ProtocolId,
  type YieldVenue,
  type YieldVenueAction,
} from "@kletia/core";
import { PlatformError, unsupported } from "../../errors.js";
import {
  accountForNetwork,
  recipientForNetwork,
  sameAddress,
} from "../accounts.js";
import {
  activeProtocolAdapters,
  candidateAdapters,
  effectiveProtocol,
} from "../adapters/registry.js";
import type { AdapterRoute } from "../adapters/types.js";
import {
  resolveAsset,
  resolvedFromDescriptor,
  sameAsset,
  type ResolvedAsset,
} from "../assets.js";
import {
  EVM_STAKING_NETWORK,
  GRAMMAR_EXAMPLES,
  NATIVE_STAKE_PROTOCOL,
  NATIVE_STAKE_PROVIDER,
} from "../grammar.js";
import { looksLikeName, resolveRecipientName } from "../names.js";
import { remainingMs } from "../routing/deadline.js";
import { rankedByRate, rankYieldVenues } from "../solver/yieldRank.js";
import {
  EVM_STAKE_PROTOCOLS,
  issue,
  joinList,
  LENDING_PROTOCOLS,
  NATIVE_STAKE_NETWORKS,
  STAKE_PROTOCOLS,
} from "./shared.js";
import type {
  NormalizedAction,
  PreviousStep,
  ResolvedRecipient,
  VenueChoice,
} from "./types.js";

function executableProtocols(): Set<ProtocolId> {
  return new Set(activeProtocolAdapters().flatMap((adapter) => adapter.protocols));
}

/**
 * A Solana stake that is native staking: named by protocol, or (the clarify
 * layer's structured fallback, which carries no stake protocol) the native
 * asset as output with the native provider label or a vote account.
 */
export function isNativeStake(spec: IntentActionSpec): boolean {
  if (spec.protocol === NATIVE_STAKE_PROTOCOL) return true;
  if (spec.protocol || !spec.to || spec.to.toUpperCase() !== CHAINS[spec.network].nativeAsset.symbol.toUpperCase()) return false;
  const provider = typeof spec.params?.provider === "string" ? spec.params.provider.trim() : "";
  return provider === NATIVE_STAKE_PROVIDER || isSolanaAddress(provider);
}

/** "Jito, Marinade, Jupiter / Sanctum LSTs or native staking" (Solana staking protocols of the grammar). */
export function solanaStakeNames(): string {
  const ids = [...new Set(Object.keys(STAKE_PROTOCOLS).filter((id) => id !== "jupiter"))] as ProtocolId[];
  return joinList([...ids.map((id) => getProtocol(id)?.name ?? id), "native staking"], "or");
}

/** Names of the registry protocols with a live adapter for `kind` (the lending list keeps its default order). */
function liveVenueNames(kind: IntentActionKind): string {
  const executable = executableProtocols();
  const ids = kind === "deposit" || kind === "withdraw"
    ? LENDING_PROTOCOLS.filter((id) => executable.has(id))
    : PROTOCOLS.filter((protocol) => executable.has(protocol.id) && (protocol.kinds ?? []).includes(kind)).map((protocol) => protocol.id);
  return ids.map((id) => getProtocol(id)?.name ?? id).join(", ");
}

export function lendingNames(): string {
  return LENDING_PROTOCOLS.map((id) => getProtocol(id)?.name ?? id).join(", ");
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
export function liveStakeText(): string {
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
  const native = executableProtocols().has(NATIVE_STAKE_PROTOCOL)
    ? `; native SOL staking (say "natively") runs on ${joinList(NATIVE_STAKE_NETWORKS.map((network) => CHAINS[network].name), "and")}`
    : "";
  if (parts.length === 0) return native ? `No liquid staking venue is enabled on this deployment${native}` : "No liquid staking venue is enabled on this deployment";
  return `Liquid staking runs on ${joinList(parts)}${native}`;
}

export function unsupportedRoute(route: AdapterRoute): PlatformError {
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
export function noCandidates(route: AdapterRoute, requested: ProtocolId | undefined): PlatformError {
  if (requested && !executableProtocols().has(requested)) {
    return unsupported(`Kletia does not execute ${getProtocol(requested)?.name ?? requested} routes on this deployment.`, GRAMMAR_EXAMPLES);
  }
  return unsupportedRoute(route);
}

export async function resolveInput(action: NormalizedAction, previous: PreviousStep | null): Promise<ResolvedAsset> {
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
        `Step ${action.index + 1} spends funds on ${CHAINS[action.network].name}, but step ${action.index} delivers them on ${CHAINS[previous.network].name}. Add a bridge step between them (structured actions may set constraints.allowCrossings).`,
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

export async function resolveOutput(action: NormalizedAction, input: ResolvedAsset): Promise<ResolvedAsset> {
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

/** Parses an address / CAIP-10 recipient, or resolves a name through the resolver hook. */
export async function recipientOn(raw: string, network: NetworkKey): Promise<ResolvedRecipient> {
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

export async function resolveRecipient(action: NormalizedAction, account: ParsedAccountId, accounts: readonly ParsedAccountId[]): Promise<ResolvedRecipient> {
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

/** Bound of the earn ranking's reads inside a plan (the reads are cached a minute). */
const VENUE_RANK_DEADLINE_MS = 1_500;

/**
 * The deposit venue chosen by rate: the first venue `rankYieldVenues` compared
 * on its 7-day rate (or kept as the only or the named protocol's default venue)
 * among `eligible`, with its reason; null when the ranking compared none (the
 * registry default then applies, said in a warning) or the reads failed. Never
 * makes an ineligible venue eligible.
 */
async function rankedDepositVenue(
  action: NormalizedAction,
  input: ResolvedAsset,
  eligible: readonly YieldVenue[],
): Promise<{ readonly venue: YieldVenue; readonly why: string } | null> {
  if (eligible.length < 2 && !action.protocol) return null;
  const deadlineMs = Math.min(VENUE_RANK_DEADLINE_MS, Math.max(1, remainingMs() - 1_000));
  let ranked: Awaited<ReturnType<typeof rankYieldVenues>>;
  try {
    ranked = await rankYieldVenues({
      network: action.network,
      symbol: input.symbol,
      ...(action.protocol ? { protocol: action.protocol } : {}),
      deadlineMs,
    });
  } catch {
    return null;
  }
  const allowed = new Set(eligible.map((venue) => venue.id));
  const pick = ranked.find((entry) => entry.compared && allowed.has(entry.venue.id));
  if (!pick) return null;
  const venue = eligible.find((entry) => entry.id === pick.venue.id) as YieldVenue;
  return { venue, why: rankedByRate(pick) ? `Chose ${venue.name} by rate: ${pick.why}` : `Chose ${venue.name}: ${pick.why}` };
}

/**
 * Resolves and validates the registry venue of a deposit / withdraw: the
 * named venue (`params.venue`), else, for a deposit, a preferred protocol's
 * venue, else the venue ranked best by rate among the eligible ones
 * (`rankYieldVenues`; a named protocol's vaults are ranked the same way),
 * else the registry default (the first lending protocol with a live
 * adapter, or the named protocol's first venue). Withdraws keep the
 * registry default: the venue is the position's.
 */
export async function resolveVenue(action: NormalizedAction, input: ResolvedAsset, route: AdapterRoute, request: IntentRequest): Promise<VenueChoice> {
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
    venue.network === action.network && venueExecutes(venue, kind) && venueAssetMatches(venue, input) &&
    (!action.protocol || venue.protocol === action.protocol) && !avoid.has(venue.protocol));
  let venue: YieldVenue | undefined;
  const rankWarnings: string[] = [];
  const prefer = (request.constraints?.preferProtocols ?? []).filter((id) => LENDING_PROTOCOLS.includes(id));
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
    const order = [...prefer, ...LENDING_PROTOCOLS.filter((id) => !prefer.includes(id))];
    venue = order
      .map((protocol) => venues.find((entry) => entry.protocol === protocol))
      .find((entry): entry is YieldVenue => entry !== undefined && candidateAdapters(route, request.constraints, entry.protocol).length > 0);
    if (!venue) throw unsupportedRoute(route);
  }
  // A deposit with no preferred protocol goes to the venue ranked best by its 7-day rate among
  // the executable ones (a named protocol's vaults are ranked the same way). The registry default above stays when
  // the ranking compared none; a preferred protocol keeps the preference (preferred protocols first).
  const preferred = !action.protocol && prefer.some((protocol) => venues.some((entry) => entry.protocol === protocol));
  if (kind === "deposit" && !preferred) {
    const executable = venues.filter((entry) => candidateAdapters(route, request.constraints, entry.protocol).length > 0);
    const ranked = await rankedDepositVenue(action, input, executable);
    if (ranked && ranked.venue.id !== venue.id) {
      venue = ranked.venue;
      rankWarnings.push(ranked.why);
    }
  }
  const chosen = venue;
  const alternatives = venues.filter((entry) => entry.protocol === chosen.protocol && entry !== chosen);
  const warnings = [
    ...rankWarnings,
    ...(alternatives.length > 0
      ? [`Using ${chosen.name}; name another ${getProtocol(chosen.protocol)?.name ?? chosen.protocol} venue with params.venue (${alternatives.map((entry) => entry.slug).join(", ")}).`]
      : []),
  ];
  return { venue: chosen, warnings };
}
