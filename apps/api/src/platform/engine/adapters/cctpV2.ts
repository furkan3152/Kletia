/**
 * Circle CCTP V2 adapter: native USDC burn-and-mint Fast Transfers with
 * Circle's Forwarding Service, from an EVM network to another EVM network or
 * to Solana, on one capital lane: production (the five EVM mainnets and
 * Solana) or testnet (Arc Testnet, Arbitrum Sepolia, and Solana Devnet as a
 * destination). A network is served only where its CCTP contracts are pinned;
 * a route whose ends sit on different lanes is refused (supports, plan,
 * prepare and the burn proof), and testnet burns are quoted and attested by
 * Circle's sandbox Iris. Solana origins are a follow-up (the burn there is an
 * SVM instruction set).
 *
 * Kletia encodes `TokenMessengerV2.depositForBurnWithHook` itself: exact
 * amount, the destination domain from the chain registry, the recipient as
 * mint recipient (on Solana: the recipient's existing USDC associated token
 * account, else RECIPIENT_TOKEN_ACCOUNT_MISSING), no destination caller,
 * `maxFee` = the protocol fee (Iris `minimumFee` bps of the amount, rounded
 * up) plus the Forwarding Service's `forwardFee.high`, Fast finality (1000)
 * and the documented static version-0 forward hook. The TokenMessenger
 * enforces `maxFee`, so at least `amount - maxFee` is minted ("onchain"
 * floor); Circle spends the whole budget in practice, so expected and
 * minimum output are both `amount - maxFee`. Refused: `maxFee` at or above
 * the amount (AMOUNT_TOO_SMALL) and amounts above the TokenMinter's
 * `burnLimitsPerMessage` (read on-chain).
 *
 * Verification needs the pinned TokenMessenger's DepositForBurn event and the
 * pinned MessageTransmitter's MessageSent body matching the landed calldata
 * and the step. Settlement needs Iris to report the attested message
 * complete with `forwardState` COMPLETE and the forward transaction crediting
 * the recipient at least `amount - maxFee`. There is no refund once burned
 * (journey refund path "none"): a forward that fails or never comes keeps the
 * leg settling with the attested message hash as its tracking id, and the
 * settlement timeout moves it to manual review (indeterminate) unless the
 * person completes the mint with the destination claim step.
 *
 * Destination claim: `cctpClaimTransaction` builds the unsigned
 * `MessageTransmitterV2.receiveMessage(message, attestation)` call on the
 * destination's pinned transmitter for a burn whose message Circle attested
 * but whose forward has not minted. The message is decoded and held to the
 * step's proven burn first; a message already received on the destination (its
 * nonce used) is refused. Anyone may submit it (no destination caller), and
 * the USDC is minted to the step's recipient whoever signs; it needs gas on
 * the destination.
 *
 * Standard Transfer (finality 2000, no Fast Transfer fee): offered only with
 * Circle's forwarding (the mint needs no gas on the destination), only once
 * the claim step exists (it does), only when the server enables it
 * (KLETIA_CCTP_STANDARD=on) and only when the request sets an explicit time
 * budget long enough for the source chain's finality and does not ask for
 * the fastest route. It replaces Fast Transfer for that request only when the
 * fee saved beats the time cost in the route score by more than the score's
 * tie margin, max($0.05, 0.5 bps) (same signatures either way). The step records the choice (`provider: "standard"`), so prepare
 * encodes the same finality.
 */
import { address as solanaAddress } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { decodeFunctionData, encodeFunctionData, erc20Abi, getAddress, keccak256, parseAbi, type Hex, type Log } from "viem";
import {
  CHAINS,
  explorerTxUrl,
  formatAmount,
  fromBaseUnits,
  parseAccountId,
  sameCapitalLane,
  venueContracts,
  type IntentStep,
  type NetworkKey,
  type StepEvidence,
  type TransactionRequest,
} from "@kletia/core";
import { assertSolanaWalletRecipient, isSolanaNetworkKey, solanaRpc, type SolanaNetworkKey } from "../../../networks/solana/index.js";
import { rpcAbortSignal } from "../../../networks/solana/rpc.js";
import { PlatformError } from "../../errors.js";
import { assetAmount, assetFromRef } from "../assets.js";
import { evmChainId, evmClient, isEvmNetwork, observeEvmTransaction, readAllowance, type EvmNetworkKey } from "../chains/evm.js";
import { isRecord } from "../util.js";
import { isRegistryUsdc } from "./across.js";
import { LAMBDA_T_USD_PER_SECOND, TIE_MARGIN } from "../routing/score.js";
import {
  assertCctpLane,
  CCTP_FAST_FINALITY,
  CCTP_STANDARD_FINALITY,
  cctpProtocolFee,
  fetchCctpFeeTable,
  fetchCctpMessages,
  type CctpEndpoint,
  type CctpFastFees,
  type CctpMessage,
} from "./cctpClient.js";
import { assertEvmBalance } from "./evmTransfer.js";
import { accountBytes32 } from "./lifi.js";
import { cappedOutput, destinationCredit, type DestinationCheck } from "./relay.js";
import type { AdapterAction, AdapterRoute, PlannedStep, PlannedStepPreview, PreparedPayload, ProtocolAdapter, SettlementResult, VerificationResult } from "./types.js";
import { evmEvents, fillNotBefore, stepOwner, verifyEvmReceipts } from "./verification.js";

/**
 * The Forwarding Service's static version-0 hook ("cctp-forward" padded to 32
 * bytes), as documented and as seen in real forwarded burns on Base.
 */
export const CCTP_FORWARD_HOOK: Hex = "0x636374702d666f72776172640000000000000000000000000000000000000000";
const ZERO_BYTES32: Hex = `0x${"00".repeat(32)}`;
const APPROVE_GAS = "70000";
const BURN_LIMIT_CACHE_MS = 5 * 60_000;

export const TOKEN_MESSENGER_V2_ABI = parseAbi([
  "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)",
  "event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)",
]);
export const MESSAGE_TRANSMITTER_V2_ABI = parseAbi([
  "event MessageSent(bytes message)",
  "function receiveMessage(bytes message, bytes attestation) returns (bool success)",
  "function usedNonces(bytes32 nonce) view returns (uint256)",
]);
const TOKEN_MINTER_V2_ABI = parseAbi(["function burnLimitsPerMessage(address token) view returns (uint256)"]);

function pinned(network: NetworkKey, role: "token-messenger" | "message-transmitter" | "token-minter" | "token-messenger-minter"): string | null {
  const contracts = venueContracts("cctp-v2", network, role);
  return contracts.length === 1 ? (contracts[0] as string) : null;
}

function cctpDomain(network: NetworkKey): number {
  const domain = CHAINS[network].settlement.cctpDomain;
  if (domain === undefined) throw new PlatformError("NETWORK_UNSUPPORTED", `CCTP does not serve ${CHAINS[network].name}.`, 422);
  return domain;
}

function endpoint(network: NetworkKey): CctpEndpoint {
  return { network, domain: cctpDomain(network) };
}

/**
 * Destinations served: an EVM network with the pinned TokenMessenger, or a
 * Solana network with the pinned TokenMessengerMinter program (Solana, and
 * Solana Devnet where the Forwarding Service mints too).
 */
function servedDestination(network: NetworkKey): boolean {
  if (isSolanaNetworkKey(network)) return pinned(network, "token-messenger-minter") !== null;
  return isEvmNetwork(network) && pinned(network, "token-messenger") !== null;
}

function title(action: Pick<AdapterAction, "network" | "destinationNetwork" | "input" | "amount">): string {
  const amount = `${formatAmount(fromBaseUnits(action.amount, action.input.decimals))} ${action.input.symbol}`;
  return `Bridge ${amount} from ${CHAINS[action.network].name} to ${CHAINS[action.destinationNetwork].name} via Circle CCTP`;
}

/* ------------------------------------------------------------ recipient */

/** The recipient's USDC associated token account on Solana (where CCTP mints). */
export async function solanaUsdcAccount(owner: string, mint: string): Promise<string> {
  const [ata] = await findAssociatedTokenPda({ owner: solanaAddress(owner), mint: solanaAddress(mint), tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return String(ata);
}

/**
 * CCTP on Solana mints into an existing token account: the recipient must be
 * a wallet and its USDC associated token account must exist, be owned by the
 * Token program, hold USDC for that wallet and be initialized (not frozen).
 */
async function assertSolanaMintAccount(network: SolanaNetworkKey, owner: string, mint: string): Promise<string> {
  await assertSolanaWalletRecipient(network, owner);
  const ata = await solanaUsdcAccount(owner, mint);
  let value: unknown;
  try {
    const info = await solanaRpc(network)
      .getAccountInfo(solanaAddress(ata), { encoding: "jsonParsed", commitment: "confirmed" })
      .send({ abortSignal: rpcAbortSignal() });
    value = info.value;
  } catch {
    throw new PlatformError("SOLANA_RPC_UNAVAILABLE", "The recipient's USDC account could not be checked. Try again shortly.", 502);
  }
  if (!value) {
    throw new PlatformError(
      "RECIPIENT_TOKEN_ACCOUNT_MISSING",
      `CCTP mints into the recipient's USDC token account (${ata}), which does not exist yet. Create it first (any wallet receiving USDC once creates it), or bridge with another venue.`,
      422,
    );
  }
  const record = value as { owner?: unknown; data?: unknown };
  const parsed = isRecord(record.data) && isRecord(record.data.parsed) && isRecord(record.data.parsed.info) ? record.data.parsed.info : null;
  if (String(record.owner) !== String(TOKEN_PROGRAM_ADDRESS) || !parsed || parsed.mint !== mint || parsed.owner !== owner) {
    throw new PlatformError("ROUTE_UNAVAILABLE", "The recipient's USDC token account is not a standard USDC account of that wallet.", 422);
  }
  if (parsed.state !== "initialized") {
    throw new PlatformError("ROUTE_UNAVAILABLE", "The recipient's USDC token account is frozen, so CCTP cannot mint into it.", 422);
  }
  return ata;
}

/** The bytes32 mint recipient for the step's recipient (Solana: its USDC token account, derived without I/O). */
async function expectedMintRecipient(destination: NetworkKey, recipient: string, outputAddress: string): Promise<Hex> {
  if (isSolanaNetworkKey(destination)) return accountBytes32(destination, await solanaUsdcAccount(recipient, outputAddress));
  return accountBytes32(destination, recipient);
}

/* -------------------------------------------------------------- burn limit */

const burnLimitCache = new Map<NetworkKey, { value: bigint; expiresAt: number }>();

/** Clears cached burn limits (tests). */
export function resetCctpBurnLimitCache(): void {
  burnLimitCache.clear();
}

/** TokenMinterV2.burnLimitsPerMessage(USDC) on the origin network, read on-chain. */
async function burnLimit(network: EvmNetworkKey, usdc: string): Promise<bigint> {
  const cached = burnLimitCache.get(network);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const minter = pinned(network, "token-minter");
  if (!minter) throw new PlatformError("NETWORK_UNSUPPORTED", "CCTP has no pinned TokenMinter on this network.", 422);
  let value: bigint;
  try {
    value = await evmClient(network).readContract({ address: getAddress(minter), abi: TOKEN_MINTER_V2_ABI, functionName: "burnLimitsPerMessage", args: [getAddress(usdc)] });
  } catch {
    throw new PlatformError("RPC_UNAVAILABLE", `CCTP's burn limit on ${CHAINS[network].name} could not be read on-chain. Try again shortly.`, 502);
  }
  burnLimitCache.set(network, { value, expiresAt: Date.now() + BURN_LIMIT_CACHE_MS });
  return value;
}

/* ------------------------------------------------------------- quoting */

/** The provider tag a step records when it burns with Standard finality. */
export const CCTP_STANDARD_PROVIDER = "standard";
/** Seconds a Standard Transfer waits for the source chain's finality (Ethereum finality, also for L2 batches). */
export const CCTP_STANDARD_SECONDS = 1_200;

/** True when the server enables Standard Transfer (default off until the live route audit passes). */
export function cctpStandardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KLETIA_CCTP_STANDARD?.trim().toLowerCase() === "on";
}

/**
 * Whether a burn of `amount` (USDC base units, 6 decimals) uses Standard
 * Transfer instead of Fast (see the header): the fee it saves must beat the
 * extra time at the route score's time value by more than its tie margin.
 */
export function preferStandard(
  action: Pick<AdapterAction, "amount" | "timeBudget" | "input">,
  fast: CctpFastFees,
  standard: CctpFastFees | null,
  fastSeconds: number,
  enabled = cctpStandardEnabled(),
): boolean {
  if (!enabled || !standard || !action.timeBudget || action.timeBudget.fastest) return false;
  if (action.timeBudget.maxSeconds < CCTP_STANDARD_SECONDS) return false;
  const amount = BigInt(action.amount);
  const fastFee = cctpProtocolFee(amount, fast.protocolFeeCentiBps) + fast.forwardFeeHigh;
  const standardFee = cctpProtocolFee(amount, standard.protocolFeeCentiBps) + standard.forwardFeeHigh;
  const savedUsd = Number(fromBaseUnits(fastFee - standardFee, action.input.decimals));
  const amountUsd = Number(fromBaseUnits(amount, action.input.decimals));
  const timeCost = LAMBDA_T_USD_PER_SECOND * (CCTP_STANDARD_SECONDS - fastSeconds);
  const margin = Math.max(TIE_MARGIN.minUsd, (amountUsd * TIE_MARGIN.bps) / 10_000);
  return savedUsd - timeCost > margin;
}

interface CheckedBurn {
  /** CCTP_FAST_FINALITY or CCTP_STANDARD_FINALITY. */
  readonly finality: number;
  readonly messenger: string;
  readonly maxFee: bigint;
  readonly protocolFee: bigint;
  readonly forwardFee: bigint;
  readonly mintRecipient: Hex;
  /** The Solana token account minted into (Solana destinations). */
  readonly solanaAccount: string | null;
  readonly allowance: bigint;
}

async function checkedBurn(action: AdapterAction, stage: "plan" | "prepare"): Promise<CheckedBurn> {
  // Mixed lanes get their own explicit refusal before the general one.
  assertCctpLane(action.network, action.destinationNetwork);
  if (!cctpV2Adapter.supports(action) || !isEvmNetwork(action.network)) {
    throw new PlatformError("ROUTE_UNSUPPORTED", "Circle CCTP serves USDC from an EVM network to another EVM network or to Solana, mainnet to mainnet or testnet to testnet.", 422);
  }
  const network: EvmNetworkKey = action.network;
  const messenger = pinned(network, "token-messenger") as string;
  const amount = BigInt(action.amount);
  const destination = action.destinationNetwork;
  if (action.recipient.chain.namespace !== CHAINS[destination].namespace) {
    throw new PlatformError("RECIPIENT_INVALID", `CCTP pays a recipient address on ${CHAINS[destination].name}.`, 422);
  }
  const table = await fetchCctpFeeTable(endpoint(network), endpoint(destination));
  if (!table.fast) throw new PlatformError("PROVIDER_TRANSACTION_INVALID", "Circle returned a fee table Kletia refuses (no Fast Transfer row).", 502);
  // Prepare keeps the finality the plan chose (step ref provider); plan chooses by the rule in the header.
  const standard = stage === "prepare"
    ? action.provider === CCTP_STANDARD_PROVIDER
    : preferStandard(action, table.fast, table.standard, estimatedSeconds(network));
  if (standard && !table.standard) {
    throw new PlatformError("ROUTE_UNAVAILABLE", "Circle no longer forwards Standard Transfers on this route; plan the bridge again.", 422);
  }
  const fees = standard ? (table.standard as CctpFastFees) : table.fast;
  const finality = standard ? CCTP_STANDARD_FINALITY : CCTP_FAST_FINALITY;
  const protocolFee = cctpProtocolFee(amount, fees.protocolFeeCentiBps);
  const maxFee = protocolFee + fees.forwardFeeHigh;
  if (maxFee >= amount) {
    throw new PlatformError(
      "AMOUNT_TOO_SMALL",
      `Circle's Fast Transfer and forwarding fees (up to ${fromBaseUnits(maxFee, action.input.decimals)} ${action.input.symbol}) would take the whole amount. Move more than that.`,
      422,
    );
  }
  const limit = await burnLimit(network, action.input.address as string);
  if (amount > limit) {
    throw new PlatformError(
      "ROUTE_UNAVAILABLE",
      `CCTP burns at most ${fromBaseUnits(limit, action.input.decimals)} ${action.input.symbol} per transfer on ${CHAINS[network].name}. Split the amount or use another venue.`,
      422,
    );
  }
  let solanaAccount: string | null = null;
  let mintRecipient: Hex;
  if (isSolanaNetworkKey(destination)) {
    solanaAccount = await assertSolanaMintAccount(destination, action.recipient.address, action.output.address as string);
    mintRecipient = accountBytes32(destination, solanaAccount);
  } else {
    mintRecipient = accountBytes32(destination, action.recipient.address);
  }
  const read = readAllowance(network, action.input.address as string, action.account.address, messenger);
  const allowance = stage === "plan" ? await read.catch(() => 0n) : await read;
  return { finality, messenger, maxFee, protocolFee, forwardFee: fees.forwardFeeHigh, mintRecipient, solanaAccount, allowance };
}

/** The depositForBurnWithHook call Kletia encodes for a checked burn. */
export function cctpBurnData(action: AdapterAction, burn: Pick<CheckedBurn, "mintRecipient" | "maxFee"> & { readonly finality?: number }): Hex {
  return encodeFunctionData({
    abi: TOKEN_MESSENGER_V2_ABI,
    functionName: "depositForBurnWithHook",
    args: [
      BigInt(action.amount),
      cctpDomain(action.destinationNetwork),
      burn.mintRecipient,
      getAddress(action.input.address as string),
      ZERO_BYTES32,
      burn.maxFee,
      burn.finality ?? CCTP_FAST_FINALITY,
      CCTP_FORWARD_HOOK,
    ],
  });
}

function burnTransactions(action: AdapterAction, network: EvmNetworkKey, burn: CheckedBurn): TransactionRequest[] {
  const amount = BigInt(action.amount);
  const chainId = evmChainId(network);
  const from = getAddress(action.account.address);
  const transactions: TransactionRequest[] = [];
  if (burn.allowance < amount) {
    transactions.push({
      vm: "evm",
      network,
      chainId,
      from,
      to: getAddress(action.input.address as string),
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [getAddress(burn.messenger), amount] }),
      value: "0",
      gas: APPROVE_GAS,
      description: `Approve ${formatAmount(fromBaseUnits(action.amount, action.input.decimals))} ${action.input.symbol} for Circle CCTP`,
    });
  }
  transactions.push({
    vm: "evm",
    network,
    chainId,
    from,
    to: getAddress(burn.messenger),
    data: cctpBurnData(action, burn),
    value: "0",
    description: title(action),
  });
  return transactions;
}

const PREVIEW_TTL_SECONDS = 60;

function preview(action: AdapterAction, network: EvmNetworkKey, burn: CheckedBurn): PlannedStepPreview {
  const fee = (label: string, value: bigint) => ({
    kind: "venue" as const,
    label,
    asset: { asset: action.input.id, symbol: action.input.symbol, decimals: action.input.decimals },
    amount: value.toString(),
    formatted: fromBaseUnits(value, action.input.decimals),
    usd: Number(fromBaseUnits(value, action.input.decimals)),
    paid: "deducted" as const,
    certainty: "quoted" as const,
  });
  return {
    transactions: burnTransactions(action, network, burn),
    approvalSpender: burn.messenger.toLowerCase(),
    venueFees: [
      ...(burn.protocolFee > 0n ? [fee("Circle Fast Transfer fee", burn.protocolFee)] : []),
      ...(burn.forwardFee > 0n ? [fee("Circle forwarding gas (budget)", burn.forwardFee)] : []),
    ],
    expiresAt: Math.floor(Date.now() / 1000) + PREVIEW_TTL_SECONDS,
  };
}

function burnAmounts(action: AdapterAction, burn: CheckedBurn) {
  const minted = (BigInt(action.amount) - burn.maxFee).toString();
  return {
    input: assetAmount(action.input, action.amount),
    expectedOutput: assetAmount(action.output, minted),
    minimumOutput: assetAmount(action.output, minted),
  };
}

function warnings(action: AdapterAction, burn: CheckedBurn): string[] {
  const fee = `${fromBaseUnits(burn.maxFee, action.input.decimals)} ${action.input.symbol}`;
  const minted = `${fromBaseUnits(BigInt(action.amount) - burn.maxFee, action.output.decimals)} ${action.output.symbol}`;
  const destination = CHAINS[action.destinationNetwork].name;
  const kind = burn.finality === CCTP_STANDARD_FINALITY ? "Standard Transfer (waits for the source network's finality, about 20 minutes; no Fast Transfer fee)" : "Fast Transfer";
  const notes = [
    `Route: Circle CCTP ${kind} with Circle's Forwarding Service; Circle keeps up to ${fee} (fee plus forwarding gas) and mints at least ${minted} on ${destination}. Burned USDC is not refunded; if forwarding stalls, the mint can be completed on ${destination} with Circle's attestation (a claim you sign there, which needs gas on ${destination}).`,
  ];
  if (burn.solanaAccount) notes.push(`USDC is minted into the recipient's USDC token account ${burn.solanaAccount}.`);
  // A third party, not the user's own account on the destination (the departure rule's bridge-to-recipient leg).
  const own = action.destinationAccount?.address ?? action.account.address;
  if (action.recipient.address.toLowerCase() !== own.toLowerCase()) {
    notes.push(`Circle mints to ${action.recipient.address} on ${destination}, not to your own account.`);
  }
  if (CHAINS[action.network].environment === "testnet") {
    notes.push("Testnet route: Circle's sandbox attestation service (Iris sandbox) quotes and attests this burn; testnet USDC has no value.");
  }
  if (action.network === "arc") {
    notes.push("Arc Testnet pays gas in USDC from the same balance: keep some USDC beyond the bridged amount for the approval and burn.");
  }
  return notes;
}

function estimatedSeconds(network: NetworkKey): number {
  return network === "ethereum" ? 30 : 20;
}

/* ---------------------------------------------------------- burn proof */

interface DecodedBurn {
  readonly amount: bigint;
  readonly destinationDomain: number;
  readonly mintRecipient: Hex;
  readonly burnToken: string;
  readonly destinationCaller: Hex;
  readonly maxFee: bigint;
  readonly minFinalityThreshold: number;
  readonly hookData: Hex;
}

function decodeBurn(data: string): DecodedBurn | null {
  try {
    const decoded = decodeFunctionData({ abi: TOKEN_MESSENGER_V2_ABI, data: data as Hex });
    if (decoded.functionName !== "depositForBurnWithHook") return null;
    const [amount, destinationDomain, mintRecipient, burnToken, destinationCaller, maxFee, minFinalityThreshold, hookData] = decoded.args;
    return { amount, destinationDomain, mintRecipient, burnToken, destinationCaller, maxFee, minFinalityThreshold, hookData };
  } catch {
    return null;
  }
}

/** Fields of a CCTP V2 message (header + BurnMessageV2 body), decoded from its bytes. */
export interface CctpMessageFields {
  readonly sourceDomain: number;
  readonly destinationDomain: number;
  readonly sender: string;
  readonly destinationCaller: string;
  readonly minFinalityThreshold: number;
  readonly burnToken: string;
  readonly mintRecipient: string;
  readonly amount: bigint;
  readonly messageSender: string;
  readonly maxFee: bigint;
  readonly feeExecuted: bigint;
  readonly hookData: string;
}

/**
 * Decodes a CCTP V2 message: header (version 4, source 4, destination 4,
 * nonce 32, sender 32, recipient 32, destinationCaller 32, minFinality 4,
 * finalityExecuted 4 bytes) then the burn body (version 4, burnToken 32,
 * mintRecipient 32, amount 32, messageSender 32, maxFee 32, feeExecuted 32,
 * expirationBlock 32 bytes, hookData). Null when too short.
 */
export function decodeCctpMessage(message: string): CctpMessageFields | null {
  const hex = message.replace(/^0x/u, "").toLowerCase();
  const BODY = 148;
  if (!/^(?:[0-9a-f]{2})+$/u.test(hex) || hex.length < (BODY + 228) * 2) return null;
  const at = (offset: number, bytes: number) => hex.slice(offset * 2, (offset + bytes) * 2);
  const uint = (offset: number, bytes: number) => BigInt(`0x${at(offset, bytes)}`);
  const word = (offset: number) => `0x${at(offset, 32)}`;
  return {
    sourceDomain: Number(uint(4, 4)),
    destinationDomain: Number(uint(8, 4)),
    sender: word(44),
    destinationCaller: word(108),
    minFinalityThreshold: Number(uint(140, 4)),
    burnToken: word(BODY + 4),
    mintRecipient: word(BODY + 36),
    amount: uint(BODY + 68, 32),
    messageSender: word(BODY + 100),
    maxFee: uint(BODY + 132, 32),
    feeExecuted: uint(BODY + 164, 32),
    hookData: `0x${hex.slice((BODY + 228) * 2)}`,
  };
}

/** True when a message carries exactly the burn the calldata made, for the step account. */
function messageMatches(fields: CctpMessageFields, burn: DecodedBurn, step: IntentStep, messenger: string): boolean {
  return (
    fields.sourceDomain === cctpDomain(step.network) &&
    fields.destinationDomain === burn.destinationDomain &&
    fields.sender === accountBytes32(step.network, messenger) &&
    fields.destinationCaller === ZERO_BYTES32 &&
    fields.minFinalityThreshold === burn.minFinalityThreshold &&
    fields.burnToken === accountBytes32(step.network, burn.burnToken) &&
    fields.mintRecipient === burn.mintRecipient.toLowerCase() &&
    fields.amount === burn.amount &&
    fields.messageSender === accountBytes32(step.network, stepOwner(step)) &&
    fields.maxFee === burn.maxFee &&
    fields.hookData === burn.hookData.toLowerCase()
  );
}

interface ProvenBurn {
  readonly burn: DecodedBurn;
  /** keccak256 of the MessageSent bytes (before attestation fills the nonce). */
  readonly sentHash: string;
}

/**
 * The burn a landed TokenMessenger call made: the calldata is a forwarded
 * Fast Transfer of the step's USDC to the step recipient's mint account, the
 * pinned TokenMessenger emitted the matching DepositForBurn (depositor = the
 * step account) and the pinned MessageTransmitter the matching MessageSent.
 */
async function provenBurn(
  step: IntentStep,
  receipts: readonly { readonly to: string | null; readonly input: string; readonly logs: readonly Log[] }[],
): Promise<ProvenBurn | null> {
  if (!isEvmNetwork(step.network)) return null;
  const messenger = pinned(step.network, "token-messenger");
  const transmitter = pinned(step.network, "message-transmitter");
  const destination = step.settlement?.destinationNetwork;
  const recipient = step.recipient ? parseAccountId(step.recipient) : null;
  const input = step.input ? assetFromRef(step.input) : null;
  const output = step.minimumOutput ? assetFromRef(step.minimumOutput) : null;
  const landed = receipts[receipts.length - 1];
  if (!messenger || !transmitter || !destination || !recipient || !input?.address || !output?.address || !landed) return null;
  if (!sameCapitalLane(step.network, destination) || !servedDestination(destination)) return null;
  if (!landed.to || landed.to.toLowerCase() !== messenger.toLowerCase()) return null;
  const burn = decodeBurn(landed.input);
  if (!burn) return null;
  const mintRecipient = await expectedMintRecipient(destination, recipient.address, output.address);
  if (
    burn.burnToken.toLowerCase() !== input.address.toLowerCase() ||
    burn.destinationDomain !== cctpDomain(destination) ||
    burn.mintRecipient.toLowerCase() !== mintRecipient ||
    burn.destinationCaller !== ZERO_BYTES32 ||
    (burn.minFinalityThreshold !== CCTP_FAST_FINALITY && burn.minFinalityThreshold !== CCTP_STANDARD_FINALITY) ||
    burn.hookData.toLowerCase() !== CCTP_FORWARD_HOOK ||
    burn.maxFee >= burn.amount
  ) {
    return null;
  }
  const account = stepOwner(step).toLowerCase();
  const deposited = evmEvents(receipts, { address: messenger, abi: TOKEN_MESSENGER_V2_ABI, eventName: "DepositForBurn" }).some((event) => {
    const args = event.args;
    return (
      args.burnToken.toLowerCase() === burn.burnToken.toLowerCase() &&
      args.amount === burn.amount &&
      args.depositor.toLowerCase() === account &&
      args.mintRecipient.toLowerCase() === burn.mintRecipient.toLowerCase() &&
      args.destinationDomain === burn.destinationDomain &&
      args.destinationCaller === ZERO_BYTES32 &&
      args.maxFee === burn.maxFee &&
      args.minFinalityThreshold === burn.minFinalityThreshold &&
      args.hookData.toLowerCase() === burn.hookData.toLowerCase()
    );
  });
  if (!deposited) return null;
  for (const event of evmEvents(receipts, { address: transmitter, abi: MESSAGE_TRANSMITTER_V2_ABI, eventName: "MessageSent" })) {
    const fields = decodeCctpMessage(event.args.message);
    if (fields && messageMatches(fields, burn, step, messenger)) return { burn, sentHash: keccak256(event.args.message) };
  }
  return null;
}

/* ------------------------------------------------------ destination claim */

/** The nonce of an attested CCTP V2 message (header bytes 12..44). */
function messageNonce(message: Hex): Hex {
  return `0x${message.slice(2 + 24, 2 + 24 + 64)}` as Hex;
}

/** True when the destination's pinned transmitter already received `message` (its nonce is used). Throws on a failed read. */
async function messageReceived(destination: EvmNetworkKey, message: Hex): Promise<boolean> {
  const transmitter = pinned(destination, "message-transmitter");
  if (!transmitter) return false;
  const used = await evmClient(destination).readContract({ address: getAddress(transmitter), abi: MESSAGE_TRANSMITTER_V2_ABI, functionName: "usedNonces", args: [messageNonce(message)] });
  return used !== 0n;
}

export interface CctpClaim {
  /** The unsigned receiveMessage call on the destination's pinned MessageTransmitter. */
  readonly transaction: TransactionRequest;
  /** keccak256 of the attested message (the settlement tracking id). */
  readonly messageHash: string;
  readonly destination: NetworkKey;
  /** At least this much USDC (base units) is minted to the step's recipient. */
  readonly minimum: bigint;
}

/**
 * The destination claim of a CCTP leg whose forward has not minted (see the
 * header): `receiveMessage(message, attestation)` on the destination's
 * pinned MessageTransmitterV2, sent by `claimant` (the person's own account
 * there, which pays the gas). Refuses a step that is not a CCTP burn to an EVM
 * network, a burn not proven on-chain, a message not attested yet, one the
 * Forwarding Service already minted and one already received on the
 * destination. Read-only: nothing is signed or sent.
 */
export async function cctpClaimTransaction(step: IntentStep, claimant: string): Promise<CctpClaim> {
  const destination = step.settlement?.destinationNetwork;
  const reference = step.references?.[step.references.length - 1];
  if (step.protocol !== "cctp-v2" || !destination || !isEvmNetwork(step.network)) {
    throw new PlatformError("STEP_NOT_PREPARABLE", "Only a Circle CCTP bridge leg has a destination claim.", 409);
  }
  if (!isEvmNetwork(destination)) {
    throw new PlatformError("STEP_NOT_PREPARABLE", `A claim on ${CHAINS[destination].name} is not built by Kletia yet; Circle's forwarding mints there.`, 409);
  }
  const transmitter = pinned(destination, "message-transmitter");
  if (!transmitter) throw new PlatformError("STEP_NOT_PREPARABLE", `CCTP has no pinned MessageTransmitter on ${CHAINS[destination].name}.`, 409);
  if (!reference) throw new PlatformError("STEP_NOT_READY", "The burn has not been submitted yet.", 409);
  if (!/^0x[0-9a-fA-F]{40}$/u.test(claimant)) throw new PlatformError("STEP_NOT_PREPARABLE", "The claim is sent from an EVM account.", 409);
  const landed = await observeEvmTransaction(step.network, reference);
  if (landed.state !== "landed" || landed.status !== "success") throw new PlatformError("STEP_NOT_READY", "The burn transaction has not landed successfully yet.", 409);
  const proven = await provenBurn(step, [landed]);
  if (!proven) throw new PlatformError("STEP_NOT_PREPARABLE", "The landed transaction is not this step's CCTP burn.", 409);
  const messenger = pinned(step.network, "token-messenger") as string;
  const messages = await fetchCctpMessages(endpoint(step.network), reference);
  const attested = messages.find((message) => {
    const fields = message.message ? decodeCctpMessage(message.message) : null;
    return fields !== null && messageMatches(fields, proven.burn, step, messenger);
  });
  if (!attested?.message) throw new PlatformError("STEP_NOT_READY", "Circle has not published this burn's message yet. Try again in a minute.", 409);
  if (attested.status !== "complete" || !attested.attestation) {
    throw new PlatformError("STEP_NOT_READY", "Circle has not attested this burn yet (Fast Transfers take seconds, Standard Transfers wait for finality).", 409);
  }
  if (attested.forwardState?.toUpperCase() === "COMPLETE") {
    throw new PlatformError("STEP_NOT_PREPARABLE", "Circle's Forwarding Service already minted this transfer; there is nothing to claim.", 409);
  }
  const message = attested.message as Hex;
  let used: boolean;
  try {
    used = await messageReceived(destination, message);
  } catch {
    throw new PlatformError("RPC_UNAVAILABLE", `Whether ${CHAINS[destination].name} already received this transfer could not be read. Try again shortly.`, 502);
  }
  if (used) throw new PlatformError("STEP_NOT_PREPARABLE", `This transfer was already received on ${CHAINS[destination].name}; there is nothing to claim.`, 409);
  const fields = decodeCctpMessage(message) as CctpMessageFields;
  const decimals = step.minimumOutput?.decimals ?? 6;
  return {
    transaction: {
      vm: "evm",
      network: destination,
      chainId: evmChainId(destination),
      from: getAddress(claimant),
      to: getAddress(transmitter),
      data: encodeFunctionData({ abi: MESSAGE_TRANSMITTER_V2_ABI, functionName: "receiveMessage", args: [message, attested.attestation as Hex] }),
      value: "0",
      description: `Claim at least ${fromBaseUnits(fields.amount - fields.maxFee, decimals)} USDC on ${CHAINS[destination].name} with Circle's attestation`,
    },
    messageHash: keccak256(message),
    destination,
    minimum: fields.amount - fields.maxFee,
  };
}

/* -------------------------------------------------------------- adapter */

export const cctpV2Adapter: ProtocolAdapter = {
  id: "cctp-v2",
  protocols: ["cctp-v2"],
  label: "Circle CCTP",

  supports(route: AdapterRoute) {
    if (route.kind !== "bridge" || route.network === route.destinationNetwork) return false;
    // Production and testnet capital never mix (chains.ts); each lane has its own Iris.
    if (!sameCapitalLane(route.network, route.destinationNetwork)) return false;
    if (!isEvmNetwork(route.network) || !pinned(route.network, "token-messenger") || !pinned(route.network, "message-transmitter") || !pinned(route.network, "token-minter")) return false;
    if (!servedDestination(route.destinationNetwork)) return false;
    if (CHAINS[route.network].settlement.cctpDomain === undefined || CHAINS[route.destinationNetwork].settlement.cctpDomain === undefined) return false;
    return isRegistryUsdc(route.input) && isRegistryUsdc(route.output) && route.input.decimals === route.output.decimals;
  },

  async plan(action): Promise<PlannedStep> {
    const burn = await checkedBurn(action, "plan");
    const network = action.network as EvmNetworkKey;
    const standard = burn.finality === CCTP_STANDARD_FINALITY;
    const seconds = standard ? CCTP_STANDARD_SECONDS : estimatedSeconds(action.network);
    return {
      protocol: "cctp-v2",
      ...(standard ? { provider: CCTP_STANDARD_PROVIDER } : {}),
      title: title(action),
      mode: "wallet",
      ...burnAmounts(action, burn),
      feesUsd: Number(fromBaseUnits(burn.maxFee, action.input.decimals)),
      estimatedSeconds: seconds,
      settlement: { kind: "cross-network", destinationNetwork: action.destinationNetwork, expectedSeconds: seconds },
      warnings: warnings(action, burn),
      transactionCount: burn.allowance < BigInt(action.amount) ? 2 : 1,
      slippageBps: action.slippageBps,
      preview: preview(action, network, burn),
      // The TokenMessenger caps the fee at maxFee: at least amount - maxFee is minted.
      floor: "onchain",
    };
  },

  async prepare({ action }): Promise<PreparedPayload> {
    if (!isEvmNetwork(action.network)) throw new PlatformError("NETWORK_UNSUPPORTED", "CCTP burns here start on an EVM network.", 422);
    const network: EvmNetworkKey = action.network;
    await assertEvmBalance(network, action.account.address, action.input.address, BigInt(action.amount), action.input.symbol, action.input.decimals);
    const burn = await checkedBurn(action, "prepare");
    const transactions = burnTransactions(action, network, burn);
    return {
      transactions,
      records: transactions.map((transaction) => ({
        vm: "evm" as const,
        network,
        to: transaction.vm === "evm" ? transaction.to : "",
        description: transaction.description,
      })),
      ...burnAmounts(action, burn),
      feesUsd: Number(fromBaseUnits(burn.maxFee, action.input.decimals)),
      warnings: warnings(action, burn),
    };
  },

  async verify(context): Promise<VerificationResult> {
    const { step } = context;
    const { result } = await verifyEvmReceipts(context, async (receipts) => {
      const proven = await provenBurn(step, receipts);
      if (!proven) {
        return {
          failure: {
            code: "OUTCOME_NOT_PROVEN",
            message: "The pinned TokenMessenger and MessageTransmitter did not emit DepositForBurn and MessageSent matching this burn (amount, recipient, fee, finality and forward hook).",
          },
        };
      }
      const { burn } = proven;
      const decimals = step.input?.decimals ?? 6;
      return {
        evidence: [{
          kind: "note",
          network: step.network,
          reference: proven.sentHash,
          observedAt: new Date(context.now).toISOString(),
          detail: `CCTP burn of ${fromBaseUnits(burn.amount, decimals)} USDC for domain ${burn.destinationDomain} (fee cap ${fromBaseUnits(burn.maxFee, decimals)} USDC); MessageSent ${proven.sentHash.slice(0, 12)}….`,
        }],
      };
    });
    return result;
  },

  async poll(step: IntentStep): Promise<SettlementResult> {
    const destination = step.settlement?.destinationNetwork;
    const reference = step.references?.[step.references.length - 1];
    const recipient = step.recipient ? parseAccountId(step.recipient) : null;
    const output = step.minimumOutput ? assetFromRef(step.minimumOutput) : null;
    if (!destination || !reference || !recipient || !output || !isEvmNetwork(step.network) || !sameCapitalLane(step.network, destination)) {
      return { status: "failed", evidence: [], failure: { code: "STEP_INVALID", message: "The bridge step lacks a burn, recipient or output." } };
    }
    const landed = await observeEvmTransaction(step.network, reference);
    if (landed.state !== "landed" || landed.status !== "success") return { status: "settling", evidence: [] };
    const proven = await provenBurn(step, [landed]);
    if (!proven) return { status: "settling", evidence: [] };
    const messenger = pinned(step.network, "token-messenger") as string;
    const messages: CctpMessage[] = await fetchCctpMessages(endpoint(step.network), reference);
    let attested: { message: CctpMessage; fields: CctpMessageFields; hash: string } | null = null;
    for (const message of messages) {
      const fields = message.message ? decodeCctpMessage(message.message) : null;
      if (message.message && fields && messageMatches(fields, proven.burn, step, messenger)) {
        attested = { message, fields, hash: keccak256(message.message as Hex) };
        break;
      }
    }
    if (!attested || attested.message.status !== "complete") return { status: "settling", evidence: [] };
    // From here the message hash is the reference a manual claim on the destination needs.
    const tracking = attested.hash !== step.settlement?.trackingId ? { trackingId: attested.hash } : {};
    const { message, fields } = attested;
    if (message.forwardState?.toUpperCase() !== "COMPLETE" || !message.forwardTxHash) {
      // A destination claim (cctpClaimTransaction) may have received the message instead of the forward: the used
      // nonce on the pinned transmitter proves the mint to the message's recipient of at least amount - maxFee.
      const received = isEvmNetwork(destination) && message.message ? await messageReceived(destination, message.message as Hex).catch(() => false) : false;
      if (!received) return { status: "settling", evidence: [], ...tracking };
      const floor = fields.amount - fields.maxFee;
      return {
        status: "settled",
        evidence: [{
          kind: "settlement",
          network: destination,
          reference: attested.hash,
          observedAt: new Date().toISOString(),
          detail: `Circle's message ${attested.hash.slice(0, 12)}… was received on ${CHAINS[destination].name} by a claim (its nonce is used); at least ${fromBaseUnits(floor, output.decimals)} ${output.symbol} minted to the recipient.`,
        }],
        actualOutput: assetAmount(output, floor.toString()),
      };
    }
    const floor = fields.amount - fields.maxFee;
    const check = await destinationCredit(destination, message.forwardTxHash, output, recipient.address, fillNotBefore(step)).catch(
      (): DestinationCheck => ({ confirmed: false, credited: null }),
    );
    if (!check.confirmed || check.credited === null) return { status: "settling", evidence: [], ...tracking };
    if (check.credited < floor) {
      return {
        status: "failed",
        evidence: [],
        failure: {
          code: "SETTLEMENT_MISMATCH",
          message: `Circle's forwarded mint credited ${fromBaseUnits(check.credited, output.decimals)} ${output.symbol}, below the guaranteed ${fromBaseUnits(floor, output.decimals)} ${output.symbol}.`,
        },
        credited: assetAmount(output, check.credited.toString()),
      };
    }
    const minted = fields.feeExecuted <= fields.maxFee ? fields.amount - fields.feeExecuted : floor;
    const evidence: StepEvidence = {
      kind: "settlement",
      network: destination,
      reference: message.forwardTxHash,
      url: explorerTxUrl(destination, message.forwardTxHash),
      observedAt: new Date().toISOString(),
      detail: `Circle minted on ${CHAINS[destination].name} (message ${attested.hash.slice(0, 12)}…); ${fromBaseUnits(check.credited, output.decimals)} ${output.symbol} credited to the recipient.`,
    };
    return { status: "settled", evidence: [evidence], actualOutput: assetAmount(output, cappedOutput(check.credited, minted).toString()) };
  },
};
