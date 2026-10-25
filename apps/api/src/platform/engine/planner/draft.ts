/**
 * Step drafts: candidate selection, merging and the per-kind drafts for
 * protocol and registered-contract steps.
 */
import {
  CHAINS,
  contractActionInput,
  findAssetBySymbol,
  fromBaseUnits,
  getProtocol,
  CONTRACT_ID_PATTERN,
  resolveContractParams,
  reserveTooLarge,
  type AssetAmount,
  type EvmContractAction,
  type IntentRequest,
  type ParsedAccountId,
  type SolanaActionEndpoint,
} from "@kletia/core";
import { PlatformError, unsupported } from "../../errors.js";
import { accountForNetwork, ownAccountOn, sameAddress } from "../accounts.js";
import {
  adapterForProtocol,
  avoidedDependency,
  candidateAdapters,
  effectiveProtocol,
} from "../adapters/registry.js";
import type {
  AdapterAction,
  AdapterRoute,
  ProtocolAdapter,
} from "../adapters/types.js";
import { assertContractAmount } from "../contracts/caps.js";
import {
  contractDirectory,
  contractsEnabled,
  withActivationRetry,
} from "../contracts/directory.js";
import {
  contractOutputAsset,
  evmSnapshot,
  solanaSnapshot,
} from "../contracts/snapshot.js";
import {
  assetAmount,
  assetFromRef,
  resolveAsset,
  sameAsset,
} from "../assets.js";
import {
  DEFAULT_MAX_SECONDS,
  runVenueAuction,
  type QuoteContact,
} from "../auction.js";
import { GRAMMAR_EXAMPLES, NATIVE_STAKE_PROTOCOL } from "../grammar.js";
import { portionOf } from "../util.js";
import { assertWithinDeadline } from "../routing/deadline.js";
import { currentRoutePin, legPinKey } from "../routing/deliverExact.js";
import {
  baseUnits,
  CONTRACT_KINDS,
  DEFAULT_SLIPPAGE_BPS,
  issue,
  NATIVE_STAKE_NETWORKS,
  STAKE_NETWORKS,
} from "./shared.js";
import type {
  CandidateSelection,
  DraftContext,
  NormalizedAction,
  PlanTrace,
  PreviousStep,
  StepDraft,
} from "./types.js";
import {
  liveStakeText,
  noCandidates,
  recipientOn,
  resolveInput,
  resolveOutput,
  resolveRecipient,
  resolveVenue,
  unsupportedRoute,
} from "./resolve.js";
import {
  dlnEligible,
  gasTopupEligible,
  gasTopupUnavailable,
  nativePlaceholder,
  plannedGasReserve,
  reserveWarning,
  topupWarning,
  usesPrevious,
} from "./gasReserve.js";

/**
 * Cross-network steps and same-network swaps with several candidate venues
 * run the venue auction; every other step takes the first candidate (in
 * preference order) that quotes.
 */
async function planWithCandidates(
  candidates: readonly ProtocolAdapter[],
  action: AdapterAction,
  request: IntentRequest,
  trace?: PlanTrace,
): Promise<CandidateSelection> {
  const crossNetwork = action.kind === "bridge" && action.network !== action.destinationNetwork;
  const swapAuction = action.kind === "swap" && action.network === action.destinationNetwork && candidates.length > 1;
  // Liquid staking with several venues minting the same token (a stake pool deposit and a Jupiter route to the
  // same LST): the venue that guarantees more of it wins.
  const stakeAuction = action.kind === "stake" && action.network === action.destinationNetwork && candidates.length > 1;
  if (crossNetwork || swapAuction || stakeAuction) {
    trace?.budget.startAuction(`${action.kind} ${action.input.symbol} on ${CHAINS[action.network].name}${crossNetwork ? ` to ${CHAINS[action.destinationNetwork].name}` : ""}`);
    const maxSeconds = request.constraints?.maxSeconds;
    const contacts: QuoteContact[] = [];
    try {
      const auction = await runVenueAuction(candidates, action, {
        maxSeconds: maxSeconds ?? DEFAULT_MAX_SECONDS,
        explicitMaxSeconds: maxSeconds !== undefined,
        explicitSlippage: request.constraints?.maxSlippageBps !== undefined,
        prefer: request.constraints?.preferProtocols ?? [],
        ...(request.constraints?.routePreference ? { preference: request.constraints.routePreference } : {}),
        contacts,
      });
      return { adapter: auction.winner.adapter, planned: auction.winner.planned, auction };
    } finally {
      trace?.contacts.push(...contacts);
    }
  }
  let firstError: unknown = null;
  for (const adapter of candidates) {
    assertWithinDeadline();
    trace?.contacts.push({ protocol: effectiveProtocol(adapter, action), sawAccount: true });
    try {
      return { adapter, planned: await adapter.plan(action) };
    } catch (error) {
      firstError ??= error;
    }
  }
  throw firstError ?? unsupportedRoute(action);
}

export function canMerge(bridge: NormalizedAction, next: NormalizedAction | undefined, request: IntentRequest): next is NormalizedAction {
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

const NO_DRAFT_CONTEXT: DraftContext = { later: [], reserved: new Set() };

export async function draftStep(
  action: NormalizedAction,
  previous: PreviousStep | null,
  accounts: readonly ParsedAccountId[],
  request: IntentRequest,
  ownerKeyId?: string,
  context: DraftContext = NO_DRAFT_CONTEXT,
): Promise<StepDraft> {
  if (CONTRACT_KINDS.includes(action.kind)) return draftContractStep(action, previous, accounts, request, ownerKeyId);
  const nativeStake = action.kind === "stake" && action.protocol === NATIVE_STAKE_PROTOCOL;
  if (action.kind === "stake" && !(nativeStake ? NATIVE_STAKE_NETWORKS : STAKE_NETWORKS).includes(action.network)) {
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
  // Native staking keeps the native asset (delegated in a stake account): the one stake whose output is its input.
  if ((action.kind === "swap" || (action.kind === "stake" && !nativeStake) || action.kind === "bridge") && sameAsset(input, output)) {
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
  const choice = lending ? await resolveVenue(action, input, route, request) : null;
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
  // A composed shape's leg runs on the venue its pre-screen chose; an exact-delivery or link sizing run 2-3 on run 1's.
  const pinKey = legPinKey(route);
  const pinned = action.pin ?? currentRoutePin()?.venue(pinKey);
  if (pinned && !requested) {
    const kept = candidates.filter((adapter) => effectiveProtocol(adapter, route) === pinned);
    if (kept.length > 0) candidates = kept;
  }
  candidates = await dlnEligible(candidates, route, accounts, request, context);
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
    ...(request.constraints?.maxSeconds !== undefined
      ? { timeBudget: { maxSeconds: request.constraints.maxSeconds, fastest: request.constraints.routePreference === "fastest" } }
      : {}),
  };
  const { adapter, planned, auction } = await planWithCandidates(candidates, adapterAction, request, context.trace);
  currentRoutePin()?.recordVenue(pinKey, planned.protocol);
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
      // A declared fallback asset is shown with the plan.
      ...(planned.fallbackOutput && !sameAsset(planned.fallbackOutput, output)
        ? [`If the swap on ${CHAINS[route.destinationNetwork].name} fails, you receive ${planned.fallbackOutput.formatted} ${planned.fallbackOutput.symbol} on ${CHAINS[route.destinationNetwork].name} instead.`]
        : []),
    ],
    output: sameAsset(plannedOutput, output) ? output : assetFromRef(plannedOutput),
    funded: action.amount.type === "previous",
    ...(action.amount.type === "previous" ? { portionBps: action.amount.portionBps } : {}),
    ...(gasReserve ? { gasReserve } : {}),
    ...(gasTopupUsd !== undefined ? { gasTopupUsd } : {}),
  };
}

/**
 * Plans a call (EVM) or action (Solana Actions) step against a registration
 * the intent's API key may use: scoping, status and revision,
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
