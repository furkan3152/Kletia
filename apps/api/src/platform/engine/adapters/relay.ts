/**
 * Relay adapter: cross-network bridges and bridge-and-swap between the EVM
 * networks Relay serves in the registry and Solana, plus same-network swaps on
 * Base and Arbitrum. A cross-network step settles only when Relay reports the
 * fill and the destination transaction is visible on the destination network.
 *
 * Every Relay call is checked against the pinned contracts in
 * `VENUE_CONTRACTS` at plan and at prepare: EVM calls may only approve the
 * input token for, and call, the depository (same-asset bridges) or the
 * depository / ERC-20 router / approval proxy (routes with a swap); depository
 * calls are decoded (depositor, token, exact amount). Solana deposits may only
 * invoke the pinned depository program plus capped ComputeBudget instructions.
 */
import { decodeFunctionData, erc20Abi, getAddress, parseAbi, type Hex } from "viem";
import {
  CHAINS,
  explorerTxUrl,
  formatAmount,
  formatAssetId,
  fromBaseUnits,
  nativeAssetId,
  getProtocol,
  isVenueContract,
  parseAccountId,
  venueContracts,
  type IntentStep,
  type NetworkKey,
  type StepEvidence,
  type TransactionRequest,
  WRAPPED_SOL_MINT,
} from "@kletia/core";
import { assembleSolanaTransaction, assertSolanaWalletRecipient, isSolanaNetworkKey } from "../../../networks/solana/index.js";
import { PlatformError } from "../../errors.js";
import { assetAmount, assetFromRef, providerCurrency, sameAsset, type ResolvedAsset } from "../assets.js";
import {
  erc20CreditFromLogs,
  evmChainId,
  isEvmNetwork,
  nativeBalanceDelta,
  observeEvmTransaction,
  type EvmNetworkKey,
} from "../chains/evm.js";
import { assertSolanaTransactionOwner, computeBudgetMismatch, confirmSimulation, readSolanaCredit, SOLANA_PROGRAM_IDS } from "../chains/solana.js";
import { decodeStepRef } from "../stepRef.js";
import { assertEvmBalance } from "./evmTransfer.js";
import {
  fetchRelayQuote,
  fetchRelayRequestsByHash,
  fetchRelayStatus,
  RELAY_NATIVE_SOLANA,
  type RelayCall,
  type RelayEvmCall,
  type RelayQuote,
  type RelayRequestState,
} from "./relayClient.js";
import type {
  AdapterAction,
  AdapterRoute,
  PlannedStep,
  PlannedStepPreview,
  PlannedVenueFee,
  PreparedPayload,
  ProtocolAdapter,
  SettlementResult,
  VerificationResult,
} from "./types.js";
import {
  effectiveSolDelta,
  fillNotBefore,
  lowestPreparedFloor,
  REFERENCE_STALE_MS,
  SOL_RENT_TOLERANCE_LAMPORTS,
  stepOwner,
  tokenDelta,
  verifyEvmReferences,
  verifySolanaReferences,
} from "./verification.js";

/** Networks Relay serves, from the protocol registry (its contracts are pinned per network in VENUE_CONTRACTS). */
export const RELAY_NETWORKS: readonly NetworkKey[] = Object.freeze([...(getProtocol("relay")?.networks ?? [])]);
const SAME_NETWORK_SWAP_NETWORKS: readonly NetworkKey[] = ["base", "arbitrum"];
const APPROVE_SELECTOR = "0x095ea7b3";
const MAX_TOTAL_IMPACT_PERCENT = 10;

/** Relay Depository v2 entry points (selectors 0xe8017952 / 0x49290c1c). */
const RELAY_DEPOSITORY_ABI = parseAbi([
  "function depositErc20(address depositor, address token, uint256 amount, bytes32 id)",
  "function depositNative(address depositor, bytes32 id)",
]);

/**
 * Programs a Relay Solana deposit may invoke besides the pinned depository:
 * ComputeBudget only (its instructions decoded and capped). Relay deposits
 * need no Token or ATA instruction, and an arbitrary one could hand the
 * user's token account to someone else (SetAuthority, Approve, Transfer).
 */
const RELAY_SOLANA_HELPER_PROGRAMS: ReadonlySet<string> = new Set([SOLANA_PROGRAM_IDS.computeBudget]);

function relayChainId(network: NetworkKey): number {
  const id = CHAINS[network].settlement.relayChainId;
  if (id === undefined) throw new PlatformError("NETWORK_UNSUPPORTED", `Relay does not serve ${CHAINS[network].name}.`, 422);
  return id;
}

function crossNetwork(route: Pick<AdapterRoute, "network" | "destinationNetwork">): boolean {
  return route.network !== route.destinationNetwork;
}

function title(action: Pick<AdapterAction, "kind" | "network" | "destinationNetwork" | "input" | "output" | "amount">): string {
  const amount = `${formatAmount(fromBaseUnits(action.amount, action.input.decimals))} ${action.input.symbol}`;
  if (!crossNetwork(action)) return `Swap ${amount} for ${action.output.symbol} on ${CHAINS[action.network].name}`;
  const base = `Bridge ${amount} from ${CHAINS[action.network].name} to ${CHAINS[action.destinationNetwork].name}`;
  return action.output.symbol.toUpperCase() === action.input.symbol.toUpperCase() ? base : `${base} as ${action.output.symbol}`;
}

async function quote(action: AdapterAction, slippageBps: number): Promise<RelayQuote> {
  // Relay pays a Solana recipient's token account; a token account, mint or program vault there strands the output.
  if (isSolanaNetworkKey(action.destinationNetwork)) {
    await assertSolanaWalletRecipient(action.destinationNetwork, action.recipient.address);
  }
  return fetchRelayQuote({
    user: action.account.address,
    recipient: action.recipient.address,
    originChainId: relayChainId(action.network),
    destinationChainId: relayChainId(action.destinationNetwork),
    originCurrency: providerCurrency(action.input),
    destinationCurrency: providerCurrency(action.output),
    amount: action.amount,
    slippageBps,
  });
}

function quoteWarnings(result: RelayQuote): string[] {
  const warnings: string[] = [];
  const impact = result.totalImpactPercent;
  if (impact !== null && impact < -MAX_TOTAL_IMPACT_PERCENT) {
    throw new PlatformError(
      "PRICE_IMPACT_TOO_HIGH",
      `Fees and price impact would cost ${Math.abs(impact).toFixed(2)}% of the amount; routes above ${MAX_TOTAL_IMPACT_PERCENT}% are refused.`,
      422,
    );
  }
  if (impact !== null && impact < -1) warnings.push(`Fees and price impact total ${Math.abs(impact).toFixed(2)}% of the amount.`);
  return warnings;
}

function amounts(action: AdapterAction, result: RelayQuote) {
  const outUsd = result.currencyOut.amountUsd;
  const ratio = outUsd !== null && result.currencyOut.amount !== "0"
    ? Number(result.currencyOut.minimumAmount) / Number(result.currencyOut.amount)
    : null;
  return {
    input: assetAmount(action.input, action.amount, result.currencyIn.amountUsd ?? undefined),
    expectedOutput: assetAmount(action.output, result.currencyOut.amount, outUsd ?? undefined),
    minimumOutput: assetAmount(
      action.output,
      result.currencyOut.minimumAmount,
      outUsd !== null && ratio !== null && Number.isFinite(ratio) ? outUsd * ratio : undefined,
    ),
  };
}

/** Relay may name native SOL by the System program or the wrapped-SOL mint. */
function solanaNative(currency: string): string {
  return currency === WRAPPED_SOL_MINT ? RELAY_NATIVE_SOLANA : currency;
}

function sameAddress(a: string, b: string): boolean {
  return a.startsWith("0x") ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function sameAssetGroup(action: Pick<AdapterAction, "input" | "output">): boolean {
  return action.input.group !== undefined && action.input.group === action.output.group;
}

/**
 * Pinned Relay contracts a non-approval call may target: the depository only
 * for a same-asset bridge, the depository, ERC-20 router and approval proxy
 * for routes that swap.
 */
function relayTargets(action: AdapterAction): string[] {
  const depository = venueContracts("relay", action.network, "depository");
  if (crossNetwork(action) && sameAssetGroup(action)) return depository;
  return [
    ...depository,
    ...venueContracts("relay", action.network, "erc20-router"),
    ...venueContracts("relay", action.network, "approval-proxy"),
  ];
}

function rejectRelayCall(message: string): never {
  throw new PlatformError("RELAY_QUOTE_INVALID", message, 502);
}

/** Decodes a depository deposit and checks depositor, token, amount and value against the step. */
function assertDepositoryCall(action: AdapterAction, call: { readonly data: string; readonly value: string }): void {
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: RELAY_DEPOSITORY_ABI, data: call.data as Hex });
  } catch {
    rejectRelayCall("Relay call to the depository is not a deposit.");
  }
  const amount = BigInt(action.amount);
  const account = action.account.address.toLowerCase();
  if (decoded.functionName === "depositErc20") {
    const [depositor, token, deposited] = decoded.args;
    if (depositor.toLowerCase() !== account) rejectRelayCall("Relay deposit is credited to another depositor.");
    if (action.input.isNative || !action.input.address || token.toLowerCase() !== action.input.address.toLowerCase()) {
      rejectRelayCall("Relay deposit names another token.");
    }
    if (deposited !== amount) rejectRelayCall("Relay deposit amount differs from the step amount.");
    if (call.value !== "0") rejectRelayCall("Relay token deposit must not carry value.");
    return;
  }
  const [depositor] = decoded.args;
  if (depositor.toLowerCase() !== account) rejectRelayCall("Relay deposit is credited to another depositor.");
  if (!action.input.isNative || BigInt(call.value) !== amount) rejectRelayCall("Relay native deposit value differs from the step amount.");
}

/**
 * Validates Relay's EVM calls against the step and the pinned contracts
 * (runs at plan and at prepare, so a quote that would be refused at prepare
 * never wins the auction).
 */
function assertRelayEvmCalls(action: AdapterAction, calls: readonly RelayCall[]): RelayEvmCall[] {
  if (!isEvmNetwork(action.network)) throw new PlatformError("NETWORK_UNSUPPORTED", "Not an EVM network.", 422);
  const chainId = evmChainId(action.network);
  const amount = BigInt(action.amount);
  const targets = relayTargets(action);
  if (targets.length === 0) throw new PlatformError("NETWORK_UNSUPPORTED", `Relay has no pinned contracts on ${CHAINS[action.network].name}.`, 422);
  const evmCalls = calls.map((call) => {
    if (call.kind !== "evm") rejectRelayCall("Relay returned a Solana call for an EVM origin.");
    return call;
  });
  const pinned = (to: string) => targets.some((target) => target.toLowerCase() === to.toLowerCase());
  let deposits = 0;
  evmCalls.forEach((call, index) => {
    if (call.chainId !== chainId) rejectRelayCall("Relay call targets another chain.");
    if (call.from.toLowerCase() !== action.account.address.toLowerCase()) rejectRelayCall("Relay call is not sent by the step account.");
    if (call.data.toLowerCase().startsWith(APPROVE_SELECTOR)) {
      if (action.input.isNative || !action.input.address || call.to.toLowerCase() !== action.input.address.toLowerCase()) {
        rejectRelayCall("Relay approval targets an unexpected token.");
      }
      const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data as Hex });
      if (decoded.functionName !== "approve") rejectRelayCall("Unexpected approval call.");
      const [spender, approved] = decoded.args;
      const next = evmCalls[index + 1];
      if (!next || next.to.toLowerCase() !== spender.toLowerCase()) rejectRelayCall("Relay approval spender is not the contract it then calls.");
      if (!pinned(spender)) rejectRelayCall("Relay approval spender is not a pinned Relay contract.");
      if (approved > amount) rejectRelayCall("Relay approval exceeds the step amount.");
      if (call.value !== "0") rejectRelayCall("Approval must not carry value.");
      return;
    }
    if (!pinned(call.to)) rejectRelayCall(`Relay call target ${call.to} is not a pinned Relay contract on ${CHAINS[action.network].name}.`);
    if (isVenueContract("relay", action.network, call.to, "depository")) {
      assertDepositoryCall(action, call);
      deposits += 1;
    } else if (action.input.isNative ? BigInt(call.value) > amount : call.value !== "0") {
      rejectRelayCall("Relay call value does not match the step amount.");
    }
  });
  if (crossNetwork(action) && sameAssetGroup(action) && deposits !== 1) rejectRelayCall("A Relay bridge must make exactly one depository deposit.");
  return evmCalls;
}

/** Solana deposits may only invoke the pinned depository (primary) and capped ComputeBudget instructions. */
function assertRelaySolanaCalls(action: AdapterAction, calls: readonly RelayCall[]): string[] {
  if (action.network !== "solana") throw new PlatformError("NETWORK_UNSUPPORTED", "Relay Solana deposits run on Solana mainnet.", 422);
  const depository = venueContracts("relay", "solana", "depository");
  return calls.map((call) => {
    if (call.kind !== "svm") rejectRelayCall("Relay returned an EVM call for a Solana origin.");
    for (const instruction of call.instructions) {
      if (!depository.includes(instruction.programId) && !RELAY_SOLANA_HELPER_PROGRAMS.has(instruction.programId)) {
        rejectRelayCall(`Relay deposit invokes ${instruction.programId}, which is not a pinned Relay program.`);
      }
      const budget = instruction.programId === SOLANA_PROGRAM_IDS.computeBudget ? computeBudgetMismatch(Buffer.from(instruction.data, "hex")) : null;
      if (budget) rejectRelayCall(`Relay deposit carries a compute-budget instruction that ${budget}.`);
    }
    const primary = [...call.instructions].reverse().find((instruction) => instruction.programId !== SOLANA_PROGRAM_IDS.computeBudget);
    if (!primary || !depository.includes(primary.programId)) rejectRelayCall("Relay deposit does not invoke the pinned Relay depository program.");
    return primary.programId;
  });
}

/**
 * Relay's minimum is its own claim (nothing on-chain binds it before the
 * fill), yet the auction ranks it against calldata-bound minimums. A
 * same-asset minimum at or above the amount sent is not an honest quote: a
 * bridge always charges something.
 */
function assertRelayMinimum(action: AdapterAction, result: RelayQuote): void {
  if (!sameAssetGroup(action)) return;
  const minimum = BigInt(result.currencyOut.minimumAmount) * 10n ** BigInt(action.input.decimals);
  if (minimum >= BigInt(action.amount) * 10n ** BigInt(action.output.decimals)) {
    rejectRelayCall("Relay quoted a same-asset minimum at or above the amount sent.");
  }
}

/** Validates Relay's calls for the action's VM (plan and prepare). */
function assertRelayCalls(action: AdapterAction, calls: readonly RelayCall[]): void {
  if (isEvmNetwork(action.network)) assertRelayEvmCalls(action, calls);
  else assertRelaySolanaCalls(action, calls);
}

/** Validates Relay's EVM calls against the step before anything reaches a wallet. */
function evmTransactions(action: AdapterAction, calls: readonly RelayCall[], description: string): TransactionRequest[] {
  const evmCalls = assertRelayEvmCalls(action, calls);
  const network = action.network as EvmNetworkKey;
  const chainId = evmChainId(network);
  return evmCalls.map((call) => {
    const isApprove = call.data.toLowerCase().startsWith(APPROVE_SELECTOR);
    return {
      vm: "evm" as const,
      network,
      chainId,
      from: getAddress(call.from),
      to: getAddress(call.to),
      data: call.data,
      value: call.value,
      ...(call.gas ? { gas: call.gas } : {}),
      description: isApprove ? `Approve ${action.input.symbol} for Relay` : description,
    };
  });
}

async function solanaTransactions(
  action: AdapterAction,
  calls: readonly RelayCall[],
  description: string,
): Promise<{ transactions: TransactionRequest[]; programs: string[] }> {
  const primaries = assertRelaySolanaCalls(action, calls);
  const transactions: TransactionRequest[] = [];
  const programs: string[] = [];
  for (const [index, call] of calls.entries()) {
    if (call.kind !== "svm") throw new PlatformError("RELAY_QUOTE_INVALID", "Relay returned an EVM call for a Solana origin.", 502);
    const prepared = await assembleSolanaTransaction({
      network: "solana",
      feePayer: action.account.address,
      instructions: call.instructions,
      addressLookupTables: call.addressLookupTables,
    });
    const simulation = await confirmSimulation("solana", prepared.transaction, prepared.simulation);
    if (simulation && !simulation.ok) {
      throw new PlatformError(
        "SIMULATION_FAILED",
        `The Relay deposit would fail on-chain (${simulation.error.slice(0, 160)}). Check the balance of the sending account.`,
        422,
      );
    }
    const info = assertSolanaTransactionOwner(prepared.transaction, action.account.address);
    // The assembled transaction may only add ComputeBudget instructions to the validated ones.
    if (info.programs.some((program) => program !== primaries[index] && !RELAY_SOLANA_HELPER_PROGRAMS.has(program))) {
      throw new PlatformError("RELAY_QUOTE_INVALID", "The assembled Relay deposit invokes an unpinned program.", 502);
    }
    programs.push(primaries[index] as string);
    transactions.push({
      vm: "svm",
      network: "solana",
      feePayer: action.account.address,
      transaction: prepared.transaction,
      encoding: "base64",
      lastValidBlockHeight: prepared.lastValidBlockHeight,
      description,
    });
  }
  return { transactions, programs };
}

/** Seconds a Relay quote's transactions are previewed for (Relay quotes are short-lived). */
const PREVIEW_TTL_SECONDS = 60;

/** Relayer and app fees as preview fee lines (deducted from the output, as Relay quotes them). */
function relayVenueFees(action: AdapterAction, result: RelayQuote): PlannedVenueFee[] {
  return result.venueFees.map((fee): PlannedVenueFee => {
    const network = [action.network, action.destinationNetwork].find((candidate) => relayChainId(candidate) === fee.chainId);
    const native = /^0x0{40}$/u.test(fee.address) || fee.address === RELAY_NATIVE_SOLANA;
    const asset = network
      ? native
        ? nativeAssetId(network)
        : formatAssetId(network, CHAINS[network].vm === "svm" ? "token" : "erc20", CHAINS[network].vm === "svm" ? fee.address : getAddress(fee.address))
      : null;
    return {
      kind: "venue",
      label: fee.kind === "relayer" ? "Relay relayer fee" : "Relay app fee",
      ...(asset ? { asset: { asset, symbol: fee.symbol, decimals: fee.decimals }, amount: fee.amount } : {}),
      formatted: fromBaseUnits(fee.amount, fee.decimals),
      ...(fee.amountUsd !== null ? { usd: Math.round(fee.amountUsd * 1e6) / 1e6 } : {}),
      paid: "deducted",
      certainty: "quoted",
    };
  });
}

/**
 * The quote's own transactions for the plan-time preview: the EVM calls it
 * returned, validated and mapped exactly as prepare maps them. Solana origins
 * need a blockhash and a simulation to assemble, so they stay quoted at plan.
 */
function relayPreview(action: AdapterAction, result: RelayQuote): PlannedStepPreview | undefined {
  if (!isEvmNetwork(action.network)) return undefined;
  const transactions = evmTransactions(action, result.calls, title(action));
  const approve = result.calls.find((call): call is RelayEvmCall => call.kind === "evm" && call.data.toLowerCase().startsWith(APPROVE_SELECTOR));
  return {
    transactions,
    ...(approve ? { approvalSpender: `0x${approve.data.slice(34, 74)}`.toLowerCase() } : {}),
    venueFees: relayVenueFees(action, result),
    expiresAt: Math.floor(Date.now() / 1000) + PREVIEW_TTL_SECONDS,
  };
}

function settlementFailure(state: RelayRequestState): SettlementResult | null {
  const why = state.failReason ? ` (${state.failReason})` : "";
  if (state.status === "refund") {
    return {
      status: "failed",
      evidence: [],
      failure: { code: "SETTLEMENT_REFUNDED", message: `Relay refunded the deposit on the origin network${why}.` },
    };
  }
  if (state.status === "failure") {
    return {
      status: "failed",
      evidence: [],
      failure: { code: "SETTLEMENT_FAILED", message: `Relay could not fill the request${why}.` },
    };
  }
  return null;
}

const RELAY_REQUEST_ID = /^0x[0-9a-fA-F]{64}$/u;

/**
 * Relay request ids quoted for this step (plan time and every prepare), most
 * recent first. A deposit only counts for the step when Relay attributes it
 * to one of these requests.
 */
export function relayRequestIds(step: IntentStep): string[] {
  const ids: string[] = [];
  const add = (value: string | undefined) => {
    if (value && RELAY_REQUEST_ID.test(value) && !ids.includes(value.toLowerCase())) ids.push(value.toLowerCase());
  };
  add(step.settlement?.trackingId);
  for (const entry of [...step.evidence].reverse()) {
    if (entry.kind === "quote") add(entry.reference);
  }
  return ids;
}

type DepositMatch =
  | { readonly kind: "matched"; readonly state: RelayRequestState }
  | { readonly kind: "foreign"; readonly requestId: string }
  | { readonly kind: "unknown" };

function sameReference(a: string, b: string): boolean {
  return a.startsWith("0x") || b.startsWith("0x") ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Finds the Relay request a deposit created and checks it was quoted for this step. */
async function requestForDeposit(step: IntentStep, deposit: string): Promise<DepositMatch> {
  const allowed = relayRequestIds(step);
  const byHash = await fetchRelayRequestsByHash(deposit);
  const own = byHash.find((state) => allowed.includes(state.requestId.toLowerCase()));
  if (own) return { kind: "matched", state: own };
  const foreign = byHash[0];
  if (foreign) return { kind: "foreign", requestId: foreign.requestId };
  // Not indexed by hash yet: a quoted request that lists this deposit as its origin transaction binds it too.
  for (const requestId of allowed.slice(0, 3)) {
    const state = await fetchRelayStatus(requestId);
    if (state.originTxHashes.some((hash) => sameReference(hash, deposit))) return { kind: "matched", state };
  }
  return { kind: "unknown" };
}

export interface DestinationCheck {
  readonly confirmed: boolean;
  /** Amount observed arriving at the recipient (always measured when confirmed). */
  readonly credited: bigint | null;
}

const UNCONFIRMED: DestinationCheck = { confirmed: false, credited: null };

/**
 * Destination-network evidence for a fill: the transaction succeeded, was
 * mined at or after `notBefore` (unix seconds: a transaction older than the
 * step's first prepare cannot be its fill; an unknown block time proves
 * nothing) and credited the recipient with the output asset: ERC-20 Transfer
 * logs, a direct native transfer, or the recipient's native balance change
 * over the fill block. Shared by every cross-network venue (Relay, LI.FI,
 * deBridge DLN).
 */
export async function destinationCredit(
  network: NetworkKey,
  hash: string,
  output: ResolvedAsset,
  recipient: string,
  notBefore: number | null,
): Promise<DestinationCheck> {
  const fresh = (minedAt: number | null) => notBefore !== null && minedAt !== null && minedAt >= notBefore;
  if (isEvmNetwork(network)) {
    if (!/^0x[0-9a-fA-F]{64}$/u.test(hash)) return UNCONFIRMED;
    const observation = await observeEvmTransaction(network, hash);
    if (observation.state !== "landed" || observation.status !== "success" || !fresh(observation.blockTimestamp)) return UNCONFIRMED;
    if (!output.isNative && output.address) {
      const credited = erc20CreditFromLogs(observation.logs, output.address, recipient);
      // A fill that moved no output token to the recipient is not this request's fill.
      return credited > 0n ? { confirmed: true, credited } : UNCONFIRMED;
    }
    if (observation.to !== null && observation.to.toLowerCase() === recipient.toLowerCase() && observation.value > 0n) {
      return { confirmed: true, credited: observation.value };
    }
    // A contract-forwarded native fill: the recipient's balance must have grown over the fill block.
    const delta = await nativeBalanceDelta(network, recipient, observation.blockNumber).catch(() => null);
    return delta !== null && delta > 0n ? { confirmed: true, credited: delta } : UNCONFIRMED;
  }
  if (isSolanaNetworkKey(network)) {
    const read = await readSolanaCredit(network, hash, recipient, output.isNative ? null : (output.address as string));
    if (read.status !== "success" || read.credited === null || read.credited <= 0n || !fresh(read.blockTime)) return UNCONFIRMED;
    return { confirmed: true, credited: read.credited };
  }
  return UNCONFIRMED;
}

/**
 * The output a settled fill reports, at most `cap` (the order's exact take or
 * the prepared expected output): credit above it is not attributable to this
 * step, and dependents must not spend it.
 */
export function cappedOutput(credited: bigint, cap: string | bigint | undefined): bigint {
  if (cap === undefined) return credited;
  const limit = BigInt(cap);
  return credited > limit ? limit : credited;
}

export const relayAdapter: ProtocolAdapter = {
  id: "relay",
  protocols: ["relay"],
  label: "Relay",

  supports(route) {
    if (!RELAY_NETWORKS.includes(route.network) || !RELAY_NETWORKS.includes(route.destinationNetwork)) return false;
    if (route.kind === "bridge") return crossNetwork(route);
    if (route.kind === "swap") {
      return !crossNetwork(route) && SAME_NETWORK_SWAP_NETWORKS.includes(route.network) && !sameAsset(route.input, route.output);
    }
    return false;
  },

  async plan(action): Promise<PlannedStep> {
    const result = await quote(action, action.slippageBps);
    // Same target / program checks as prepare: a quote that prepare would refuse never wins the auction.
    assertRelayCalls(action, result.calls);
    assertRelayMinimum(action, result);
    const warnings = quoteWarnings(result);
    if (!action.output.verified) warnings.push(`${action.output.symbol} is not a verified token.`);
    const cross = crossNetwork(action);
    const preview = relayPreview(action, result);
    return {
      protocol: "relay",
      title: title(action),
      mode: "wallet",
      ...amounts(action, result),
      ...(result.feesUsd !== null ? { feesUsd: result.feesUsd } : {}),
      estimatedSeconds: cross ? Math.max(result.timeEstimateSeconds, 5) + 15 : 15,
      settlement: cross
        ? { kind: "cross-network", destinationNetwork: action.destinationNetwork, expectedSeconds: Math.max(result.timeEstimateSeconds, 5) }
        : { kind: "same-network" },
      warnings,
      quoteId: result.requestId,
      transactionCount: result.calls.length,
      slippageBps: action.slippageBps,
      ...(preview ? { preview } : {}),
    };
  },

  async prepare({ step, action }): Promise<PreparedPayload> {
    const slippageBps = decodeStepRef(step.quoteRef)?.slippageBps ?? action.slippageBps;
    if (isEvmNetwork(action.network)) {
      await assertEvmBalance(action.network, action.account.address, action.input.address, BigInt(action.amount), action.input.symbol, action.input.decimals);
    }
    const result = await quote(action, slippageBps);
    assertRelayMinimum(action, result);
    const warnings = quoteWarnings(result);
    const description = title(action);
    let transactions: TransactionRequest[];
    let records: PreparedPayload["records"];
    if (isEvmNetwork(action.network)) {
      transactions = evmTransactions(action, result.calls, description);
      records = transactions.map((transaction) => ({
        vm: "evm" as const,
        network: action.network,
        to: transaction.vm === "evm" ? transaction.to : "",
        description: transaction.description,
      }));
    } else {
      const built = await solanaTransactions(action, result.calls, description);
      transactions = built.transactions;
      records = built.transactions.map((transaction, index) => ({
        vm: "svm" as const,
        network: action.network,
        feePayer: action.account.address,
        to: built.programs[index] as string,
        description: transaction.description,
      }));
    }
    return {
      transactions,
      records,
      ...amounts(action, result),
      ...(result.feesUsd !== null ? { feesUsd: result.feesUsd } : {}),
      ...(crossNetwork(action) ? { trackingId: result.requestId } : {}),
      quoteId: result.requestId,
      warnings,
    };
  },

  async verify(context): Promise<VerificationResult> {
    const { step } = context;
    // EVM: the exact quote binding proves the deposit calldata (and its Relay request) is ours.
    if (step.chain.startsWith("eip155:")) return verifyEvmReferences(context);
    const input = step.input ? assetFromRef(step.input) : null;
    const owner = stepOwner(step);
    const { result } = await verifySolanaReferences(context, (observations) => {
      if (!input || !step.input) return { failure: { code: "STEP_INVALID", message: "The step has no recorded input." } };
      const spent = input.isNative
        ? -effectiveSolDelta(observations, owner) + SOL_RENT_TOLERANCE_LAMPORTS
        : -tokenDelta(observations, owner, input.address as string);
      if (spent < BigInt(step.input.amount)) {
        return {
          failure: { code: "REFERENCE_MISMATCH", message: `The deposit did not debit ${step.input.formatted} ${input.symbol} from the step account.` },
        };
      }
    });
    if (result.status !== "confirmed" || step.settlement?.kind !== "cross-network") return result;
    // Solana wallets re-sign payloads, so bind the deposit through Relay's own request record.
    const deposit = context.references[context.references.length - 1] as string;
    const match = await requestForDeposit(step, deposit);
    if (match.kind === "foreign") {
      return {
        status: "failed",
        evidence: [],
        failure: { code: "REFERENCE_MISMATCH", message: "The deposit belongs to a Relay request that was not quoted for this step." },
      };
    }
    if (match.kind === "unknown") {
      return {
        status: "pending",
        evidence: [],
        reason: "Relay has not indexed the deposit yet.",
        stale: context.now - context.submittedAt > REFERENCE_STALE_MS,
      };
    }
    return result;
  },

  async poll(step: IntentStep): Promise<SettlementResult> {
    const destination = step.settlement?.destinationNetwork;
    if (!destination || destination === step.network) return { status: "settled", evidence: [] };
    const deposit = step.references?.[step.references.length - 1];
    const recipient = step.recipient ? parseAccountId(step.recipient) : null;
    const output = step.minimumOutput ? assetFromRef(step.minimumOutput) : null;
    if (!deposit || !recipient || !output) {
      return { status: "failed", evidence: [], failure: { code: "STEP_INVALID", message: "The bridge step lacks a deposit, recipient or output." } };
    }
    const match = await requestForDeposit(step, deposit);
    // Unknown or foreign attribution stays settling (and times out to manual review); it never settles.
    if (match.kind !== "matched") return { status: "settling", evidence: [] };
    const state = match.state;
    const mismatch = (message: string): SettlementResult => ({ status: "failed", evidence: [], failure: { code: "SETTLEMENT_MISMATCH", message } });
    if (state.recipient && !sameAddress(state.recipient, recipient.address)) {
      return mismatch("The Relay request for this deposit pays a different recipient.");
    }
    if (state.outputChainId !== null && state.outputChainId !== relayChainId(destination)) {
      return mismatch("The Relay request for this deposit settles on a different network.");
    }
    if (state.outputCurrency !== null && !sameAddress(solanaNative(state.outputCurrency), solanaNative(providerCurrency(output)))) {
      return mismatch("The Relay request for this deposit delivers a different asset.");
    }
    const failure = settlementFailure(state);
    if (failure) return failure;
    if (state.status !== "success") {
      return { status: "settling", evidence: [], ...(state.requestId !== step.settlement?.trackingId ? { trackingId: state.requestId } : {}) };
    }
    const observedAt = new Date().toISOString();
    const notBefore = fillNotBefore(step);
    // Relay's minimum is copied from its own quote, not bound on-chain: the fill is held to it here.
    const floor = lowestPreparedFloor(step);
    for (const hash of state.destinationTxHashes) {
      const check = await destinationCredit(destination, hash, output, recipient.address, notBefore).catch(
        (): DestinationCheck => UNCONFIRMED,
      );
      if (!check.confirmed || check.credited === null) continue;
      if (floor === null || check.credited < floor) {
        return mismatch(`The Relay fill credited ${fromBaseUnits(check.credited, output.decimals)} ${output.symbol}, below the guaranteed ${fromBaseUnits(floor ?? 0n, output.decimals)} ${output.symbol}.`);
      }
      const evidence: StepEvidence = {
        kind: "settlement",
        network: destination,
        reference: hash,
        url: explorerTxUrl(destination, hash),
        observedAt,
        detail: `Relay fill confirmed on ${CHAINS[destination].name} (request ${state.requestId.slice(0, 10)}…); ` +
          `${fromBaseUnits(check.credited, output.decimals)} ${output.symbol} credited to the recipient.`,
      };
      return {
        status: "settled",
        evidence: [evidence],
        actualOutput: assetAmount(output, cappedOutput(check.credited, step.expectedOutput?.amount).toString()),
      };
    }
    return { status: "settling", evidence: [] };
  },
};
