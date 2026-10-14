/**
 * Circle CCTP V2 adapter: native USDC burn-and-mint Fast Transfers with
 * Circle's Forwarding Service (protocols design 3.5), from an EVM production
 * network to another EVM production network or to Solana. Solana origins are
 * a follow-up (the burn there is an SVM instruction set).
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
 * settlement timeout moves it to manual review (indeterminate); a
 * destination `receiveMessage` claim step is the documented follow-up.
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
  venueContracts,
  type IntentStep,
  type NetworkKey,
  type StepEvidence,
  type TransactionRequest,
} from "@kletia/core";
import { assertSolanaWalletRecipient, solanaRpc } from "../../../networks/solana/index.js";
import { rpcAbortSignal } from "../../../networks/solana/rpc.js";
import { PlatformError } from "../../errors.js";
import { assetAmount, assetFromRef } from "../assets.js";
import { evmChainId, evmClient, isEvmNetwork, observeEvmTransaction, readAllowance, type EvmNetworkKey } from "../chains/evm.js";
import { isRecord } from "../util.js";
import { isRegistryUsdc } from "./across.js";
import { CCTP_FAST_FINALITY, cctpProtocolFee, fetchCctpFastFees, fetchCctpMessages, type CctpMessage } from "./cctpClient.js";
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
export const MESSAGE_TRANSMITTER_V2_ABI = parseAbi(["event MessageSent(bytes message)"]);
const TOKEN_MINTER_V2_ABI = parseAbi(["function burnLimitsPerMessage(address token) view returns (uint256)"]);

function pinned(network: NetworkKey, role: "token-messenger" | "message-transmitter" | "token-minter"): string | null {
  const contracts = venueContracts("cctp-v2", network, role);
  return contracts.length === 1 ? (contracts[0] as string) : null;
}

function cctpDomain(network: NetworkKey): number {
  const domain = CHAINS[network].settlement.cctpDomain;
  if (domain === undefined) throw new PlatformError("NETWORK_UNSUPPORTED", `CCTP does not serve ${CHAINS[network].name}.`, 422);
  return domain;
}

/** Destinations served: an EVM production network with the pinned TokenMessenger, or Solana mainnet. */
function servedDestination(network: NetworkKey): boolean {
  if (network === "solana") return true;
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
async function assertSolanaMintAccount(owner: string, mint: string): Promise<string> {
  await assertSolanaWalletRecipient("solana", owner);
  const ata = await solanaUsdcAccount(owner, mint);
  let value: unknown;
  try {
    const info = await solanaRpc("solana")
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
  if (destination === "solana") return accountBytes32("solana", await solanaUsdcAccount(recipient, outputAddress));
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

interface CheckedBurn {
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
  if (!cctpV2Adapter.supports(action) || !isEvmNetwork(action.network)) {
    throw new PlatformError("ROUTE_UNSUPPORTED", "Circle CCTP serves USDC from an EVM production network to another one or to Solana.", 422);
  }
  const network: EvmNetworkKey = action.network;
  const messenger = pinned(network, "token-messenger") as string;
  const amount = BigInt(action.amount);
  const destination = action.destinationNetwork;
  if (action.recipient.chain.namespace !== CHAINS[destination].namespace) {
    throw new PlatformError("RECIPIENT_INVALID", `CCTP pays a recipient address on ${CHAINS[destination].name}.`, 422);
  }
  const fees = await fetchCctpFastFees(cctpDomain(network), cctpDomain(destination));
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
  if (destination === "solana") {
    solanaAccount = await assertSolanaMintAccount(action.recipient.address, action.output.address as string);
    mintRecipient = accountBytes32("solana", solanaAccount);
  } else {
    mintRecipient = accountBytes32(destination, action.recipient.address);
  }
  const read = readAllowance(network, action.input.address as string, action.account.address, messenger);
  const allowance = stage === "plan" ? await read.catch(() => 0n) : await read;
  return { messenger, maxFee, protocolFee, forwardFee: fees.forwardFeeHigh, mintRecipient, solanaAccount, allowance };
}

/** The depositForBurnWithHook call Kletia encodes for a checked burn. */
export function cctpBurnData(action: AdapterAction, burn: Pick<CheckedBurn, "mintRecipient" | "maxFee">): Hex {
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
      CCTP_FAST_FINALITY,
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
  const notes = [
    `Route: Circle CCTP Fast Transfer with Circle's Forwarding Service; Circle keeps up to ${fee} (fee plus forwarding gas) and mints at least ${minted} on ${destination}. Burned USDC is not refunded; if forwarding stalls, the mint can be completed on ${destination} with Circle's attestation.`,
  ];
  if (burn.solanaAccount) notes.push(`USDC is minted into the recipient's USDC token account ${burn.solanaAccount}.`);
  // A third party, not the user's own account on the destination (the departure rule's bridge-to-recipient leg).
  const own = action.destinationAccount?.address ?? action.account.address;
  if (action.recipient.address.toLowerCase() !== own.toLowerCase()) {
    notes.push(`Circle mints to ${action.recipient.address} on ${destination}, not to your own account.`);
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
  if (!landed.to || landed.to.toLowerCase() !== messenger.toLowerCase()) return null;
  const burn = decodeBurn(landed.input);
  if (!burn) return null;
  const mintRecipient = await expectedMintRecipient(destination, recipient.address, output.address);
  if (
    burn.burnToken.toLowerCase() !== input.address.toLowerCase() ||
    burn.destinationDomain !== cctpDomain(destination) ||
    burn.mintRecipient.toLowerCase() !== mintRecipient ||
    burn.destinationCaller !== ZERO_BYTES32 ||
    burn.minFinalityThreshold !== CCTP_FAST_FINALITY ||
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

/* -------------------------------------------------------------- adapter */

export const cctpV2Adapter: ProtocolAdapter = {
  id: "cctp-v2",
  protocols: ["cctp-v2"],
  label: "Circle CCTP",

  supports(route: AdapterRoute) {
    if (route.kind !== "bridge" || route.network === route.destinationNetwork) return false;
    if (!isEvmNetwork(route.network) || !pinned(route.network, "token-messenger") || !pinned(route.network, "message-transmitter") || !pinned(route.network, "token-minter")) return false;
    if (!servedDestination(route.destinationNetwork)) return false;
    if (CHAINS[route.network].settlement.cctpDomain === undefined || CHAINS[route.destinationNetwork].settlement.cctpDomain === undefined) return false;
    return isRegistryUsdc(route.input) && isRegistryUsdc(route.output) && route.input.decimals === route.output.decimals;
  },

  async plan(action): Promise<PlannedStep> {
    const burn = await checkedBurn(action, "plan");
    const network = action.network as EvmNetworkKey;
    const seconds = estimatedSeconds(action.network);
    return {
      protocol: "cctp-v2",
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
    if (!destination || !reference || !recipient || !output || !isEvmNetwork(step.network)) {
      return { status: "failed", evidence: [], failure: { code: "STEP_INVALID", message: "The bridge step lacks a burn, recipient or output." } };
    }
    const landed = await observeEvmTransaction(step.network, reference);
    if (landed.state !== "landed" || landed.status !== "success") return { status: "settling", evidence: [] };
    const proven = await provenBurn(step, [landed]);
    if (!proven) return { status: "settling", evidence: [] };
    const messenger = pinned(step.network, "token-messenger") as string;
    const messages: CctpMessage[] = await fetchCctpMessages(cctpDomain(step.network), reference);
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
    if (message.forwardState?.toUpperCase() !== "COMPLETE" || !message.forwardTxHash) return { status: "settling", evidence: [], ...tracking };
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
