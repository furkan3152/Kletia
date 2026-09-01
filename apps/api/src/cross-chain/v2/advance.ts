import { createHash } from "node:crypto";
import {
  decodeFunctionData,
  decodeEventLog,
  erc20Abi,
  formatUnits,
  getAddress,
  isAddressEqual,
  keccak256,
  pad,
  parseAbi,
  zeroHash,
  type Address,
  type Abi,
  type Hex,
  verifyMessage,
} from "viem";
import {
  Address as StellarAddress,
  Keypair,
  rpc,
  scValToNative,
  StrKey,
  xdr,
} from "@stellar/stellar-sdk";
import { arcPublicClient } from "../../shared/config/networks.js";
import { ARBITRUM_SEPOLIA, arbitrumSepoliaPublicClient } from "../../networks/arbitrum-sepolia/config.js";
import { readArbitrumSepoliaBorrowCapacity } from "../../networks/arbitrum-sepolia/service.js";
import { STELLAR_TESTNET } from "../../networks/stellar/config.js";
import { archiveVerifiedStellarTransaction } from "../../networks/stellar/eventArchive.js";
import {
  prepareStellarPolicyRegistryFinalize,
  readStellarPolicyRegistryRecord,
  type StellarPolicyRegistryRecordState,
} from "../../networks/stellar/policyRegistryState.js";
import { assertStellarPolicyRegistryReady } from "../../networks/stellar/policyRegistryReadiness.js";
import {
  buildPrivateIntentManifestV1,
  openWorkflowPlanV2,
  rebindWorkflowPlanAuthorization,
  renewWorkflowPlanAuthorization,
  sealWorkflowPlanV2,
} from "./compiler.js";
import { readCctpStandardFeeBps } from "./quotes.js";
import type { WorkflowPlanV2, WorkflowV2Step } from "./types.js";
import { recordWorkflowCheckpoint } from "./checkpointStore.js";
import {
  assertWorkflowStepAdvanceable,
  sealWorkflowLifecycleFailure,
} from "./lifecycle.js";
import { assertPrivacyBudgetCompatible } from "./privacyPolicy.js";
import {
  cctpV2AttestedMessageMatchesSourceEvent,
  cctpV2MessageMatchesDomains,
  cctpV2NonceMatches,
} from "./cctpV2MessageBinding.js";

const CCTP_TOKEN_MESSENGER = getAddress("0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA");
const CCTP_MESSAGE_TRANSMITTER = getAddress("0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275");
const ARC_USDC = getAddress("0x3600000000000000000000000000000000000000");
const ERC20_EVENT_ABI = parseAbi([
  "event Approval(address indexed owner,address indexed spender,uint256 value)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const CCTP_EVENT_ABI = parseAbi(["event MessageSent(bytes message)"]);
const AAVE_EVENT_ABI = parseAbi([
  "event Supply(address indexed reserve,address user,address indexed onBehalfOf,uint256 amount,uint16 indexed referralCode)",
]);
const TOKEN_MESSENGER_ABI = [
  {
    type: "function",
    name: "depositForBurn",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "depositForBurnWithHook",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
      { name: "hookData", type: "bytes" },
    ],
    outputs: [],
  },
] as const;
const MESSAGE_TRANSMITTER_ABI = [
  {
    type: "function",
    name: "receiveMessage",
    stateMutability: "nonpayable",
    inputs: [
      { name: "message", type: "bytes" },
      { name: "attestation", type: "bytes" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
] as const;

function controlled(code: string, message: string, statusCode = 400): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

function canonicalReceiptValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalReceiptValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalReceiptValue(entry)]),
    );
  }
  return value;
}

function decodeReceiptEvent(
  abi: Abi,
  log: { readonly data: Hex; readonly topics: readonly Hex[] },
) {
  try {
    return decodeEventLog({
      abi,
      data: log.data,
      topics: log.topics as [] | [Hex, ...Hex[]],
      strict: true,
    });
  } catch {
    return null;
  }
}

function decodeStellarSignature(value: unknown): Buffer {
  const signature = String(value ?? "").trim();
  const bytes = /^0x[a-f0-9]{128}$/iu.test(signature)
    ? Buffer.from(signature.slice(2), "hex")
    : Buffer.from(signature, "base64");
  if (bytes.length !== 64) {
    throw controlled("MANIFEST_SIGNATURE_INVALID", "Stellar manifest signature is invalid.", 409);
  }
  return bytes;
}

async function ensureManifestAuthorization(
  plan: WorkflowPlanV2,
  input: { family?: unknown; signer?: unknown; signature?: unknown } | undefined,
): Promise<WorkflowPlanV2> {
  if (plan.manifestAuthorization) return plan;
  if (!input || (input.family !== "evm" && input.family !== "stellar")) {
    throw controlled("MANIFEST_SIGNATURE_REQUIRED", "The sealed workflow manifest must be signed first.", 409);
  }
  const message = buildPrivateIntentManifestV1(plan);
  const stellarManifestSigner =
    plan.policyAnchor.mode === "stellar_public_registry" ||
    plan.selectedRoute !== "direct_cctp";
  const expectedSigner =
    stellarManifestSigner
      ? walletAddress(plan, "stellar_wallet")
      : walletAddress(plan, "arc_wallet");
  if (String(input.signer ?? "").toLowerCase() !== expectedSigner.toLowerCase()) {
    throw controlled("MANIFEST_SIGNER_MISMATCH", "Manifest signer did not match the sealed wallet.", 409);
  }
  let verified = false;
  if (!stellarManifestSigner && input.family === "evm") {
    verified = await verifyMessage({
      address: getAddress(expectedSigner),
      message,
      signature: String(input.signature ?? "") as Hex,
    }).catch(() => false);
  } else if (stellarManifestSigner && input.family === "stellar") {
    // Freighter implements SEP-53 signMessage semantics: the UTF-8 message is
    // prefixed with "Stellar Signed Message:\n", hashed with SHA-256, and only
    // then signed. `verifyMessage` applies that exact domain separation;
    // verifying the raw bytes would reject every legitimate Freighter signature.
    verified = Keypair.fromPublicKey(expectedSigner).verifyMessage(
      message,
      decodeStellarSignature(input.signature),
    );
  }
  if (!verified) {
    throw controlled("MANIFEST_SIGNATURE_INVALID", "Manifest signature could not be verified.", 409);
  }
  return {
    ...plan,
    manifestAuthorization: {
      family: input.family,
      signer: expectedSigner,
      signature: String(input.signature),
      manifestSha256: `0x${createHash("sha256").update(message).digest("hex")}`,
      verifiedAt: new Date().toISOString(),
    },
  };
}

function hexHash(value: unknown): Hex {
  const hash = String(value ?? "").trim();
  if (!/^0x[a-f0-9]{64}$/iu.test(hash)) {
    throw controlled("WORKFLOW_EVM_HASH_INVALID", "A valid EVM transaction hash is required.");
  }
  return hash as Hex;
}

function stellarHash(value: unknown): string {
  const hash = String(value ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(hash)) {
    throw controlled("WORKFLOW_STELLAR_HASH_INVALID", "A valid Stellar transaction hash is required.");
  }
  return hash;
}

function walletAddress(plan: WorkflowPlanV2, id: string): string {
  const wallet = plan.walletBindings.find((binding) => binding.id === id);
  if (!wallet) throw controlled("WORKFLOW_WALLET_BINDING_MISSING", "Workflow wallet binding is missing.");
  return wallet.address;
}

function latestAmount(plan: WorkflowPlanV2, beforeOrder: number): bigint | null {
  for (let index = beforeOrder - 2; index >= 0; index -= 1) {
    const value = plan.steps[index]?.result?.amountAtomic;
    if (typeof value === "string" && /^\d+$/u.test(value)) return BigInt(value);
  }
  return null;
}

function verifyPublicAmountCommitment(
  plan: WorkflowPlanV2,
  atomicAmount: bigint,
  saltInput: unknown,
): void {
  if (atomicAmount <= 0n) {
    throw controlled("PUBLIC_AMOUNT_INVALID", "The public transaction amount is invalid.");
  }
  const value = formatUnits(atomicAmount, 6);
  const salt = String(saltInput ?? "").toLowerCase();
  if (!/^0x[a-f0-9]{64}$/u.test(salt)) {
    throw controlled("PRIVATE_AMOUNT_OPENING_INVALID", "Private amount salt is invalid.");
  }
  const digest = createHash("sha256")
    .update(["KLETIA_PRIVATE_FIELD_V1", "stellar:testnet", "amount", value, salt].join("\u001f"))
    .digest("hex");
  if (`0x${digest}` !== plan.privacy.amountCommitment) {
    throw controlled("PRIVATE_AMOUNT_COMMITMENT_MISMATCH", "Amount opening did not match the sealed commitment.", 409);
  }
}

function verifyPublicRecipientCommitment(
  plan: WorkflowPlanV2,
  saltInput: unknown,
): void {
  // The recipient commitment always binds the final public EVM destination.
  // A Stellar-centered route has a separate, explicitly sealed intermediate
  // forwarder recipient and must not replace the final destination identity.
  const recipient = walletAddress(plan, "arbitrum_sepolia_wallet");
  const salt = String(saltInput ?? "").toLowerCase();
  if (!/^0x[a-f0-9]{64}$/u.test(salt)) {
    throw controlled("PRIVATE_RECIPIENT_OPENING_INVALID", "Private recipient salt is invalid.");
  }
  const digest = createHash("sha256")
    .update(
      [
        "KLETIA_PRIVATE_FIELD_V1",
        "stellar:testnet",
        "recipient",
        recipient,
        salt,
      ].join("\u001f"),
    )
    .digest("hex");
  if (`0x${digest}` !== plan.privacy.recipientCommitment) {
    throw controlled(
      "PRIVATE_RECIPIENT_COMMITMENT_MISMATCH",
      "Recipient opening did not match the sealed route recipient.",
      409,
    );
  }
}

function expectedBytes32Address(address: string): Hex {
  return pad(getAddress(address), { size: 32 });
}

export function isWorkflowExpirySafeRecoveryActionV2(action: string | undefined): boolean {
  return action === "cctp_attestation" ||
    action === "cctp_mint" ||
    action === "borrow_capacity" ||
    action === "stellar_receipt_finalize";
}

function exactBufferedFee(amountAtomic: bigint, feeBps: number): bigint {
  if (!Number.isFinite(feeBps) || feeBps < 0 || feeBps > 10_000) {
    throw controlled("CCTP_FEE_EVIDENCE_INVALID", "Circle fee evidence is invalid.", 409);
  }
  const feeHundredthBps = BigInt(Math.round(feeBps * 100));
  const protocolFee =
    (amountAtomic * feeHundredthBps + 999_999n) / 1_000_000n;
  return (protocolFee * 120n + 99n) / 100n;
}

function sealedCctpLegFee(
  plan: WorkflowPlanV2,
  sourceDomain: 26 | 27,
  destinationDomain: 3 | 27,
  requireFresh = false,
): number {
  const route = plan.routeCandidates.find((candidate) => candidate.kind === plan.selectedRoute);
  if (!route || (requireFresh && route.liveEvidence.quoteExpiresAt <= Date.now())) {
    throw controlled("CCTP_FEE_QUOTE_EXPIRED", "The sealed Circle fee quote expired.", 409);
  }
  const leg = route?.liveEvidence.cctpLegs.find(
    (candidate) =>
      candidate.sourceDomain === sourceDomain &&
      candidate.destinationDomain === destinationDomain,
  );
  if (!leg) {
    throw controlled("CCTP_FEE_EVIDENCE_MISSING", "The exact Circle fee leg is missing.", 409);
  }
  return leg.standardFeeBps;
}

async function refreshNextBurnQuote(
  plan: WorkflowPlanV2,
  nextStep: WorkflowV2Step | undefined,
): Promise<WorkflowPlanV2["routeCandidates"]> {
  if (
    nextStep?.action !== "cctp_burn" ||
    (nextStep.binding?.sourceDomain !== 26 && nextStep.binding?.sourceDomain !== 27) ||
    (nextStep.binding.destinationDomain !== 3 && nextStep.binding.destinationDomain !== 27)
  ) {
    return plan.routeCandidates;
  }
  const sourceDomain = nextStep.binding.sourceDomain;
  const destinationDomain = nextStep.binding.destinationDomain;
  const standardFeeBps = await readCctpStandardFeeBps(sourceDomain, destinationDomain);
  const observedAt = new Date().toISOString();
  const quoteExpiresAt = Date.now() + 60_000;
  return plan.routeCandidates.map((route) => {
    if (route.kind !== plan.selectedRoute) return route;
    const cctpLegs = route.liveEvidence.cctpLegs.map((leg) =>
      leg.sourceDomain === sourceDomain && leg.destinationDomain === destinationDomain
        ? { ...leg, standardFeeBps }
        : leg,
    );
    const cctpStandardFeeBps = cctpLegs.reduce(
      (effective, leg) =>
        10_000 - ((10_000 - effective) * (10_000 - leg.standardFeeBps)) / 10_000,
      0,
    );
    const score = {
      ...route.score,
      bridgeFeeBps: cctpStandardFeeBps,
      total: Number((
        cctpStandardFeeBps +
        route.score.latencyPenalty +
        route.score.failurePenalty +
        route.score.disclosurePenalty -
        route.score.apyCredit
      ).toFixed(4)),
    };
    return {
      ...route,
      score,
      liveEvidence: {
        ...route.liveEvidence,
        observedAt,
        quoteExpiresAt,
        cctpLegs,
        cctpStandardFeeBps,
      },
    };
  });
}

function parseForwardRecipient(hookData: Hex): string {
  const bytes = Buffer.from(hookData.slice(2), "hex");
  if (
    bytes.length < 33 ||
    !bytes.subarray(0, 24).equals(Buffer.alloc(24)) ||
    bytes.readUInt32BE(24) !== 0
  ) {
    throw controlled("CCTP_HOOK_INVALID", "CCTP Forwarder hook header is invalid.", 409);
  }
  const length = bytes.readUInt32BE(28);
  if (length === 0 || 32 + length !== bytes.length) {
    throw controlled("CCTP_HOOK_INVALID", "CCTP Forwarder hook length is invalid.", 409);
  }
  return bytes.subarray(32).toString("utf8");
}

function rawStellarContract(contractId: string): Hex {
  return `0x${Buffer.from(StrKey.decodeContract(contractId)).toString("hex")}`;
}

function rawStellarAccount(account: string): Hex {
  return `0x${Buffer.from(StrKey.decodeEd25519PublicKey(account)).toString("hex")}`;
}

/**
 * The pinned Circle CctpForwarder deployment emits a `mint_and_forward` event
 * after its atomic SAC transfer succeeds. Bind that event's recipient, token
 * and seven-decimal amount instead of treating any event from the forwarder as
 * proof of payout. Bytecode pinning establishes deployment identity; it is not
 * a source-code review or audit claim.
 */
function verifyStellarMintAndForwardPayout(input: {
  events: readonly xdr.ContractEvent[];
  recipient: string;
  amountAtomicSixDecimals: bigint;
}): void {
  const forwarderEvents = input.events.flatMap((event) => {
    if (
      event.contractId === null ||
      StrKey.encodeContract(Buffer.from(event.contractId.value)) !==
        STELLAR_TESTNET.cctp.forwarder ||
      event.type.name !== "contract" ||
      event.body.type !== "v0"
    ) {
      return [];
    }
    const body = event.body.v0;
    if (
      body.topics.length !== 1 ||
      scValToNative(body.topics[0]) !== "mint_and_forward"
    ) {
      return [];
    }
    const value = scValToNative(body.data);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value as Record<string, unknown>).sort().join(",") !==
        "amount,forward_recipient,token"
    ) {
      throw controlled(
        "STELLAR_CCTP_PAYOUT_EVENT_INVALID",
        "The Stellar CCTP payout event had an unexpected shape.",
        409,
      );
    }
    const fields = value as Record<string, unknown>;
    let amount: bigint;
    try {
      amount = BigInt(String(fields.amount));
    } catch {
      throw controlled(
        "STELLAR_CCTP_PAYOUT_EVENT_INVALID",
        "The Stellar CCTP payout event amount was invalid.",
        409,
      );
    }
    return [{
      recipient: String(fields.forward_recipient),
      token: String(fields.token),
      amount,
    }];
  });
  if (forwarderEvents.length !== 1) {
    throw controlled(
      "STELLAR_CCTP_PAYOUT_EVIDENCE_MISSING",
      "The confirmed transaction did not contain exactly one CCTP forwarder payout event.",
      409,
    );
  }
  const [payout] = forwarderEvents;
  const expectedSevenDecimalAmount = input.amountAtomicSixDecimals * 10n;
  if (
    payout.recipient !== input.recipient ||
    payout.token !== STELLAR_TESTNET.usdc.sac ||
    payout.amount !== expectedSevenDecimalAmount
  ) {
    throw controlled(
      "STELLAR_CCTP_PAYOUT_MISMATCH",
      "The Stellar payout recipient, asset or amount did not match the sealed workflow.",
      409,
    );
  }
}

function readU256(bytes: Buffer, offset: number): bigint {
  return BigInt(`0x${bytes.subarray(offset, offset + 32).toString("hex")}`);
}

function parseCctpV2Message(message: string) {
  if (!/^0x[a-f0-9]+$/iu.test(message)) {
    throw controlled("CCTP_MESSAGE_INVALID", "Circle returned an invalid raw message.", 409);
  }
  const bytes = Buffer.from(message.slice(2), "hex");
  if (bytes.length < 376) {
    throw controlled("CCTP_MESSAGE_INVALID", "Circle raw message was truncated.", 409);
  }
  const bytes32 = (offset: number): Hex =>
    `0x${bytes.subarray(offset, offset + 32).toString("hex")}`;
  return {
    messageVersion: bytes.readUInt32BE(0),
    sourceDomain: bytes.readUInt32BE(4),
    destinationDomain: bytes.readUInt32BE(8),
    nonce: bytes32(12),
    sender: bytes32(44),
    recipient: bytes32(76),
    destinationCaller: bytes32(108),
    minFinalityThreshold: bytes.readUInt32BE(140),
    finalityThresholdExecuted: bytes.readUInt32BE(144),
    burnMessageVersion: bytes.readUInt32BE(148),
    burnToken: bytes32(152),
    mintRecipient: bytes32(184),
    amount: readU256(bytes, 216),
    messageSender: bytes32(248),
    maxFee: readU256(bytes, 280),
    feeExecuted: readU256(bytes, 312),
    expirationBlock: readU256(bytes, 344),
    hookData: `0x${bytes.subarray(376).toString("hex")}` as Hex,
  };
}

async function verifyEvmTransaction(
  plan: WorkflowPlanV2,
  step: WorkflowV2Step,
  txHashInput: unknown,
  amountCommitmentSalt?: unknown,
  recipientCommitmentSalt?: unknown,
) {
  const txHash = hexHash(txHashInput);
  const client = step.network === "arc_testnet" ? arcPublicClient : arbitrumSepoliaPublicClient;
  const expectedChainId = step.network === "arc_testnet" ? 5_042_002 : ARBITRUM_SEPOLIA.chainId;
  const [chainId, receipt, transaction] = await Promise.all([
    client.getChainId(),
    client.getTransactionReceipt({ hash: txHash }),
    client.getTransaction({ hash: txHash }),
  ]);
  if (chainId !== expectedChainId || receipt.status !== "success") {
    throw controlled("WORKFLOW_EVM_TRANSACTION_REJECTED", "EVM checkpoint was not successful on the expected chain.", 409);
  }
  const expectedWallet = getAddress(walletAddress(plan, step.walletBinding));
  if (!isAddressEqual(transaction.from, expectedWallet)) {
    throw controlled("WORKFLOW_WALLET_MISMATCH", "Checkpoint sender did not match the workflow wallet.", 409);
  }
  if (!step.target || !transaction.to || !isAddressEqual(transaction.to, getAddress(step.target))) {
    throw controlled("WORKFLOW_TARGET_MISMATCH", "Checkpoint target did not match the sealed workflow.", 409);
  }
  if (transaction.value !== 0n) {
    throw controlled("WORKFLOW_VALUE_MISMATCH", "This workflow step must not transfer native value.", 409);
  }
  let amountAtomic = latestAmount(plan, step.order);
  let emittedMessage: Hex | undefined;
  let emittedNonce: Hex | undefined;
  let maxFeeAtomic: bigint | undefined;
  let feeQuoteBps: number | undefined;
  let feeQuoteObservedAt: string | undefined;
  try {
    if (step.action === "cctp_approve") {
      const decoded = decodeFunctionData({ abi: erc20Abi, data: transaction.input });
      if (decoded.functionName !== "approve") throw new Error("wrong_method");
      const [spender, amount] = decoded.args;
      verifyPublicAmountCommitment(plan, amount, amountCommitmentSalt);
      verifyPublicRecipientCommitment(plan, recipientCommitmentSalt);
      if (!isAddressEqual(spender, CCTP_TOKEN_MESSENGER)) {
        throw new Error("wrong_approval");
      }
      const approvalFound = receipt.logs.some((log) => {
        if (!isAddressEqual(log.address, ARC_USDC)) return false;
        const decodedEvent = decodeReceiptEvent(ERC20_EVENT_ABI, log);
        if (decodedEvent?.eventName !== "Approval") return false;
        const event = decodedEvent.args as unknown as {
          owner: Address;
          spender: Address;
          value: bigint;
        };
        return (
          isAddressEqual(event.owner, expectedWallet) &&
          isAddressEqual(event.spender, CCTP_TOKEN_MESSENGER) &&
          event.value === amount
        );
      });
      if (!approvalFound) throw new Error("approval_event_missing");
      amountAtomic = amount;
    } else if (step.action === "cctp_burn") {
      const decoded = decodeFunctionData({ abi: TOKEN_MESSENGER_ABI, data: transaction.input });
      const args = decoded.args;
      if (!args || (decoded.functionName !== "depositForBurn" && decoded.functionName !== "depositForBurnWithHook")) {
        throw new Error("wrong_method");
      }
      const [amount, destinationDomain, mintRecipient, burnToken, destinationCaller, maxFee, finality] = args;
      const expectedAmount = latestAmount(plan, step.order);
      const expectedDestination = step.binding?.destinationDomain;
      const forwarder = `0x${Buffer.from(StrKey.decodeContract(STELLAR_TESTNET.cctp.forwarder)).toString("hex")}` as Hex;
      const expectedRecipient =
        expectedDestination === 27
          ? forwarder
          : expectedBytes32Address(walletAddress(plan, "arbitrum_sepolia_wallet"));
      const expectedCaller = expectedDestination === 27 ? forwarder : zeroHash;
      feeQuoteBps = sealedCctpLegFee(plan, 26, expectedDestination as 3 | 27);
      feeQuoteObservedAt = plan.routeCandidates.find(
        (candidate) => candidate.kind === plan.selectedRoute,
      )?.liveEvidence.observedAt;
      if (
        expectedAmount === null ||
        amount !== expectedAmount ||
        destinationDomain !== expectedDestination ||
        String(mintRecipient).toLowerCase() !== expectedRecipient.toLowerCase() ||
        !isAddressEqual(burnToken, ARC_USDC) ||
        String(destinationCaller).toLowerCase() !== expectedCaller.toLowerCase() ||
        maxFee !== exactBufferedFee(amount, feeQuoteBps) ||
        finality !== 2_000
      ) {
        throw new Error("wrong_burn_binding");
      }
      if (expectedDestination === 27) {
        if (decoded.functionName !== "depositForBurnWithHook") throw new Error("hook_required");
        const hookRecipient = parseForwardRecipient(decoded.args[7]);
        if (hookRecipient !== walletAddress(plan, "stellar_wallet")) throw new Error("wrong_hook_recipient");
      } else if (decoded.functionName !== "depositForBurn") {
        throw new Error("hook_not_allowed");
      }
      const messageEvent = receipt.logs.flatMap((log) => {
        if (!isAddressEqual(log.address, CCTP_MESSAGE_TRANSMITTER)) return [];
        const decodedEvent = decodeReceiptEvent(CCTP_EVENT_ABI, log);
        if (decodedEvent?.eventName !== "MessageSent") return [];
        const event = decodedEvent.args as unknown as { message: Hex };
        return typeof event.message === "string" ? [event.message] : [];
      })[0];
      if (!messageEvent) throw new Error("message_sent_event_missing");
      const raw = parseCctpV2Message(messageEvent);
      if (
        raw.messageVersion !== 1 ||
        raw.sourceDomain !== 26 ||
        raw.destinationDomain !== expectedDestination ||
        raw.burnMessageVersion !== 1 ||
        raw.minFinalityThreshold !== 2_000 ||
        raw.amount !== amount ||
        raw.maxFee !== maxFee ||
        raw.sender.toLowerCase() !== pad(CCTP_TOKEN_MESSENGER, { size: 32 }).toLowerCase() ||
        raw.recipient.toLowerCase() !==
          (expectedDestination === 27
            ? rawStellarContract(STELLAR_TESTNET.cctp.tokenMessengerMinter)
            : pad(ARBITRUM_SEPOLIA.cctp.tokenMessengerV2, { size: 32 }))
            .toLowerCase() ||
        raw.burnToken.toLowerCase() !== pad(ARC_USDC, { size: 32 }).toLowerCase() ||
        raw.mintRecipient.toLowerCase() !== expectedRecipient.toLowerCase() ||
        raw.destinationCaller.toLowerCase() !== expectedCaller.toLowerCase() ||
        raw.messageSender.toLowerCase() !== pad(expectedWallet, { size: 32 }).toLowerCase() ||
        (expectedDestination === 27
          ? parseForwardRecipient(raw.hookData) !== walletAddress(plan, "stellar_wallet")
          : raw.hookData !== "0x")
      ) {
        throw new Error("message_sent_event_mismatch");
      }
      emittedMessage = messageEvent;
      emittedNonce = raw.nonce;
      maxFeeAtomic = raw.maxFee;
      amountAtomic = amount;
    } else if (step.action === "cctp_mint") {
      const decoded = decodeFunctionData({ abi: MESSAGE_TRANSMITTER_ABI, data: transaction.input });
      const attestationStep = [...plan.steps]
        .slice(0, step.order - 1)
        .reverse()
        .find((candidate) => candidate.action === "cctp_attestation" && candidate.result?.message);
      if (
        decoded.functionName !== "receiveMessage" ||
        !attestationStep?.result?.message ||
        !attestationStep.result.attestation ||
        decoded.args[0].toLowerCase() !== attestationStep.result.message.toLowerCase() ||
        decoded.args[1].toLowerCase() !== attestationStep.result.attestation.toLowerCase()
      ) {
        throw new Error("wrong_mint_binding");
      }
      amountAtomic = attestationStep.result.amountAtomic
        ? BigInt(attestationStep.result.amountAtomic)
        : null;
      if (amountAtomic === null) throw new Error("mint_amount_missing");
      const mintTransferFound = receipt.logs.some((log) => {
        if (!isAddressEqual(log.address, ARBITRUM_SEPOLIA.usdc)) return false;
        const decodedEvent = decodeReceiptEvent(ERC20_EVENT_ABI, log);
        if (decodedEvent?.eventName !== "Transfer") return false;
        const event = decodedEvent.args as unknown as {
          from: Address;
          to: Address;
          value: bigint;
        };
        return (
          event.from === "0x0000000000000000000000000000000000000000" &&
          isAddressEqual(event.to, expectedWallet) &&
          event.value === amountAtomic
        );
      });
      if (!mintTransferFound) throw new Error("mint_transfer_event_missing");
    } else if (step.action === "aave_approve") {
      const decoded = decodeFunctionData({ abi: erc20Abi, data: transaction.input });
      const expectedAmount = latestAmount(plan, step.order);
      if (
        decoded.functionName !== "approve" ||
        expectedAmount === null ||
        !isAddressEqual(decoded.args[0], ARBITRUM_SEPOLIA.aave.pool) ||
        decoded.args[1] !== expectedAmount
      ) {
        throw new Error("wrong_aave_approval");
      }
      const approvalFound = receipt.logs.some((log) => {
        if (!isAddressEqual(log.address, ARBITRUM_SEPOLIA.usdc)) return false;
        const decodedEvent = decodeReceiptEvent(ERC20_EVENT_ABI, log);
        if (decodedEvent?.eventName !== "Approval") return false;
        const event = decodedEvent.args as unknown as {
          owner: Address;
          spender: Address;
          value: bigint;
        };
        return (
          isAddressEqual(event.owner, expectedWallet) &&
          isAddressEqual(event.spender, ARBITRUM_SEPOLIA.aave.pool) &&
          event.value === expectedAmount
        );
      });
      if (!approvalFound) throw new Error("aave_approval_event_missing");
      amountAtomic = expectedAmount;
    } else if (step.action === "aave_supply") {
      const decoded = decodeFunctionData({
        abi: [{
          type: "function",
          name: "supply",
          stateMutability: "nonpayable",
          inputs: [
            { name: "asset", type: "address" },
            { name: "amount", type: "uint256" },
            { name: "onBehalfOf", type: "address" },
            { name: "referralCode", type: "uint16" },
          ],
          outputs: [],
        }] as const,
        data: transaction.input,
      });
      const expectedAmount = latestAmount(plan, step.order);
      if (
        decoded.functionName !== "supply" ||
        expectedAmount === null ||
        !isAddressEqual(decoded.args[0], ARBITRUM_SEPOLIA.usdc) ||
        decoded.args[1] !== expectedAmount ||
        !isAddressEqual(decoded.args[2], getAddress(walletAddress(plan, step.walletBinding))) ||
        decoded.args[3] !== 0
      ) {
        throw new Error("wrong_aave_supply");
      }
      const supplyFound = receipt.logs.some((log) => {
        if (!isAddressEqual(log.address, ARBITRUM_SEPOLIA.aave.pool)) return false;
        const decodedEvent = decodeReceiptEvent(AAVE_EVENT_ABI, log);
        if (decodedEvent?.eventName !== "Supply") return false;
        const event = decodedEvent.args as unknown as {
          reserve: Address;
          user: Address;
          onBehalfOf: Address;
          amount: bigint;
          referralCode: number;
        };
        return (
          isAddressEqual(event.reserve, ARBITRUM_SEPOLIA.usdc) &&
          isAddressEqual(event.user, expectedWallet) &&
          isAddressEqual(event.onBehalfOf, expectedWallet) &&
          event.amount === expectedAmount &&
          event.referralCode === 0
        );
      });
      if (!supplyFound) throw new Error("aave_supply_event_missing");
      amountAtomic = expectedAmount;
    }
  } catch (error) {
    if ((error as { code?: unknown }).code) throw error;
    throw controlled(
      "WORKFLOW_CALLDATA_MISMATCH",
      "Transaction calldata did not match the sealed workflow step.",
      409,
    );
  }
  return {
    kind: "evm_transaction" as const,
    reference: txHash,
    observedAt: new Date().toISOString(),
    blockOrLedger: receipt.blockNumber.toString(),
    ...(amountAtomic !== null ? { amountAtomic: amountAtomic.toString() } : {}),
    ...(emittedMessage ? { message: emittedMessage } : {}),
    ...(emittedNonce ? { nonce: emittedNonce } : {}),
    ...(maxFeeAtomic !== undefined ? { maxFeeAtomic: maxFeeAtomic.toString() } : {}),
    ...(feeQuoteBps !== undefined ? { feeQuoteBps } : {}),
    ...(feeQuoteObservedAt ? { feeQuoteObservedAt } : {}),
  };
}

function bytes32FromNative(value: unknown, field: string): `0x${string}` {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw controlled(
      "STELLAR_POLICY_REGISTRY_EVIDENCE_INVALID",
      `The registry ${field} was not an exact 32-byte value.`,
      409,
    );
  }
  return `0x${Buffer.from(value).toString("hex")}`;
}

function bigintFromNative(value: unknown, field: string): bigint {
  try {
    const parsed = BigInt(String(value));
    if (parsed < 0n) throw new Error("negative");
    return parsed;
  } catch {
    throw controlled(
      "STELLAR_POLICY_REGISTRY_EVIDENCE_INVALID",
      `The registry ${field} was invalid.`,
      409,
    );
  }
}

function exactRegistryEvent(input: {
  events: readonly xdr.ContractEvent[];
  contractId: string;
  name: "policy_committed" | "policy_finalized";
  owner: string;
  nonce: bigint;
}): Record<string, unknown> {
  const matches = input.events.flatMap((event) => {
    if (
      event.contractId === null ||
      StrKey.encodeContract(Buffer.from(event.contractId.value)) !==
        input.contractId ||
      event.type.name !== "contract" ||
      event.body.type !== "v0"
    ) {
      return [];
    }
    const body = event.body.v0;
    if (body.topics.length !== 3) return [];
    let eventName: unknown;
    let owner: unknown;
    let nonce: bigint;
    let data: unknown;
    try {
      eventName = scValToNative(body.topics[0]);
      owner = scValToNative(body.topics[1]);
      nonce = bigintFromNative(scValToNative(body.topics[2]), "event nonce");
      data = scValToNative(body.data);
    } catch {
      return [];
    }
    if (
      eventName !== input.name ||
      String(owner) !== input.owner ||
      nonce !== input.nonce ||
      !data ||
      typeof data !== "object" ||
      Array.isArray(data)
    ) {
      return [];
    }
    return [data as Record<string, unknown>];
  });
  if (matches.length !== 1) {
    throw controlled(
      "STELLAR_POLICY_REGISTRY_EVENT_MISMATCH",
      `The confirmed transaction did not contain exactly one ${input.name} event with the sealed owner and nonce.`,
      409,
    );
  }
  return matches[0];
}

function assertRecordCommitBinding(input: {
  record: StellarPolicyRegistryRecordState | null;
  owner: string;
  nonce: bigint;
  policyCommitment: `0x${string}`;
  privacyBudgetCommitment: `0x${string}`;
  executionExpiresAtLedger: number;
  receiptCloseByLedger: number;
  retentionFloorLedger: number;
}): asserts input is typeof input & {
  record: StellarPolicyRegistryRecordState;
} {
  const record = input.record;
  if (
    !record ||
    record.owner !== input.owner ||
    record.nonce !== input.nonce.toString() ||
    record.policyCommitment !== input.policyCommitment ||
    record.privacyBudgetCommitment !== input.privacyBudgetCommitment ||
    record.executionExpiresAtLedger !== input.executionExpiresAtLedger ||
    record.receiptCloseByLedger !== input.receiptCloseByLedger ||
    record.retentionFloorLedger !== input.retentionFloorLedger ||
    BigInt(record.nextNonce) < input.nonce + 1n
  ) {
    throw controlled(
      "STELLAR_POLICY_REGISTRY_STATE_MISMATCH",
      "The stored registry record did not match the exact sealed owner, nonce, commitments and ledger boundaries.",
      409,
    );
  }
}

async function verifyPolicyRegistryInvocation(input: {
  plan: WorkflowPlanV2;
  step: WorkflowV2Step;
  nativeArgs: readonly unknown[];
  events: readonly xdr.ContractEvent[];
  transactionLedger: number;
}) {
  const anchor = input.plan.policyAnchor;
  const call = input.step.binding?.policyRegistryCall;
  if (
    anchor.mode !== "stellar_public_registry" ||
    input.step.binding?.protocol !== "kletia_policy_registry" ||
    !call ||
    input.step.target !== anchor.contractId ||
    call.owner !== anchor.owner ||
    call.nonce !== anchor.nonce ||
    call.expectedWasmSha256 !== anchor.expectedWasmSha256
  ) {
    throw controlled(
      "STELLAR_POLICY_REGISTRY_BINDING_MISMATCH",
      "The registry call did not match the sealed public anchor.",
      409,
    );
  }
  const readiness = await assertStellarPolicyRegistryReady();
  if (
    readiness.contractId !== anchor.contractId ||
    readiness.expectedWasmSha256 !== anchor.expectedWasmSha256
  ) {
    throw controlled(
      "STELLAR_POLICY_REGISTRY_RUNTIME_DRIFT",
      "The live registry deployment no longer matches the sealed executable identity.",
      409,
    );
  }
  const nonce = bigintFromNative(call.nonce, "sealed nonce");
  if (call.operation === "commit") {
    if (input.step.action !== "stellar_policy_commit" || input.nativeArgs.length !== 7) {
      throw controlled("STELLAR_POLICY_COMMIT_MISMATCH", "Registry commit arguments were incomplete.", 409);
    }
    const [owner, nativeNonce, policyHash, budgetHash, executionExpiry, receiptClose, retentionFloor] =
      input.nativeArgs;
    const invocationSha256 = canonicalSha256({
      schemaVersion: "kletia_policy_registry_call_v1",
      networkPassphrase: STELLAR_TESTNET.networkPassphrase,
      contractId: anchor.contractId,
      method: "commit",
      owner: call.owner,
      nonce: call.nonce,
      policyCommitment: call.policyCommitment,
      privacyBudgetCommitment: call.privacyBudgetCommitment,
      executionExpiresAtLedger: call.executionExpiresAtLedger,
      receiptCloseByLedger: call.receiptCloseByLedger,
      retentionFloorLedger: call.retentionFloorLedger,
    });
    if (
      invocationSha256 !== call.invocationSha256 ||
      String(owner) !== call.owner ||
      bigintFromNative(nativeNonce, "commit nonce") !== nonce ||
      bytes32FromNative(policyHash, "policy commitment") !== call.policyCommitment ||
      bytes32FromNative(budgetHash, "privacy budget commitment") !==
        call.privacyBudgetCommitment ||
      Number(bigintFromNative(executionExpiry, "execution expiry")) !==
        call.executionExpiresAtLedger ||
      Number(bigintFromNative(receiptClose, "receipt deadline")) !==
        call.receiptCloseByLedger ||
      Number(bigintFromNative(retentionFloor, "retention floor")) !==
        call.retentionFloorLedger
    ) {
      throw controlled("STELLAR_POLICY_COMMIT_MISMATCH", "Registry commit arguments did not match the sealed plan.", 409);
    }
    const event = exactRegistryEvent({
      events: input.events,
      contractId: anchor.contractId,
      name: "policy_committed",
      owner: call.owner,
      nonce,
    });
    const eventKeys = Object.keys(event).sort().join(",");
    if (
      eventKeys !==
        "execution_expires_at_ledger,manifest_hash,privacy_budget_hash,receipt_close_by_ledger,retention_floor_ledger" ||
      bytes32FromNative(event.manifest_hash, "event manifest hash") !==
        call.policyCommitment ||
      bytes32FromNative(event.privacy_budget_hash, "event budget hash") !==
        call.privacyBudgetCommitment ||
      Number(bigintFromNative(event.execution_expires_at_ledger, "event execution expiry")) !==
        call.executionExpiresAtLedger ||
      Number(bigintFromNative(event.receipt_close_by_ledger, "event receipt deadline")) !==
        call.receiptCloseByLedger ||
      Number(bigintFromNative(event.retention_floor_ledger, "event retention floor")) !==
        call.retentionFloorLedger
    ) {
      throw controlled("STELLAR_POLICY_REGISTRY_EVENT_MISMATCH", "The policy_committed event did not match the sealed call.", 409);
    }
    const record = await readStellarPolicyRegistryRecord({
      owner: call.owner,
      nonce,
    });
    const binding = {
      record,
      owner: call.owner,
      nonce,
      policyCommitment: call.policyCommitment,
      privacyBudgetCommitment: call.privacyBudgetCommitment,
      executionExpiresAtLedger: call.executionExpiresAtLedger,
      receiptCloseByLedger: call.receiptCloseByLedger,
      retentionFloorLedger: call.retentionFloorLedger,
    };
    assertRecordCommitBinding(binding);
    if (
      binding.record.receiptHash !== null ||
      binding.record.recordStatus !== "Active" ||
      binding.record.effectiveStatus !== "Active" ||
      binding.record.active !== true ||
      binding.record.canFinalize !== true ||
      binding.record.committedAtLedger !== input.transactionLedger ||
      binding.record.updatedAtLedger !== input.transactionLedger
    ) {
      throw controlled("STELLAR_POLICY_REGISTRY_STATE_MISMATCH", "The committed record lifecycle did not match the confirmed transaction.", 409);
    }
    return {
      schemaVersion: "kletia_policy_registry_evidence_v1" as const,
      contractId: anchor.contractId,
      method: "commit" as const,
      owner: call.owner,
      nonce: call.nonce,
      eventName: "policy_committed" as const,
      effectiveStatus: binding.record.effectiveStatus,
      recordStatus: binding.record.recordStatus,
      policyCommitment: call.policyCommitment,
      privacyBudgetCommitment: call.privacyBudgetCommitment,
      externalTruthProven: false as const,
    };
  }

  if (input.step.action !== "stellar_receipt_finalize" || input.nativeArgs.length !== 3) {
    throw controlled("STELLAR_POLICY_FINALIZE_MISMATCH", "Registry finalize arguments were incomplete.", 409);
  }
  const [owner, nativeNonce, receiptHash] = input.nativeArgs;
  const invocationSha256 = canonicalSha256({
    schemaVersion: "kletia_policy_registry_call_v1",
    networkPassphrase: STELLAR_TESTNET.networkPassphrase,
    contractId: anchor.contractId,
    method: "finalize",
    owner: call.owner,
    nonce: call.nonce,
    receiptHash: call.receiptHash,
  });
  if (
    invocationSha256 !== call.invocationSha256 ||
    String(owner) !== call.owner ||
    bigintFromNative(nativeNonce, "finalize nonce") !== nonce ||
    bytes32FromNative(receiptHash, "receipt hash") !== call.receiptHash
  ) {
    throw controlled("STELLAR_POLICY_FINALIZE_MISMATCH", "Registry finalize arguments did not match the sealed receipt hash.", 409);
  }
  const event = exactRegistryEvent({
    events: input.events,
    contractId: anchor.contractId,
    name: "policy_finalized",
    owner: call.owner,
    nonce,
  });
  if (
    Object.keys(event).sort().join(",") !== "finalized_at_ledger,receipt_hash" ||
    bytes32FromNative(event.receipt_hash, "event receipt hash") !== call.receiptHash ||
    Number(bigintFromNative(event.finalized_at_ledger, "finalized ledger")) !==
      input.transactionLedger
  ) {
    throw controlled("STELLAR_POLICY_REGISTRY_EVENT_MISMATCH", "The policy_finalized event did not match the sealed receipt call.", 409);
  }
  const record = await readStellarPolicyRegistryRecord({
    owner: call.owner,
    nonce,
  });
  const binding = {
    record,
    owner: call.owner,
    nonce,
    policyCommitment: anchor.policyCommitment,
    privacyBudgetCommitment: anchor.privacyBudgetCommitment,
    executionExpiresAtLedger: anchor.executionExpiresAtLedger,
    receiptCloseByLedger: anchor.receiptCloseByLedger,
    retentionFloorLedger: anchor.retentionFloorLedger,
  };
  assertRecordCommitBinding(binding);
  if (
    binding.record.receiptHash !== call.receiptHash ||
    binding.record.recordStatus !== "Finalized" ||
    binding.record.effectiveStatus !== "Finalized" ||
    binding.record.active !== false ||
    binding.record.canFinalize !== false ||
    binding.record.updatedAtLedger !== input.transactionLedger
  ) {
    throw controlled("STELLAR_POLICY_REGISTRY_STATE_MISMATCH", "The finalized stored record did not match the exact owner-acknowledged receipt.", 409);
  }
  return {
    schemaVersion: "kletia_policy_registry_evidence_v1" as const,
    contractId: anchor.contractId,
    method: "finalize" as const,
    owner: call.owner,
    nonce: call.nonce,
    eventName: "policy_finalized" as const,
    effectiveStatus: binding.record.effectiveStatus,
    recordStatus: binding.record.recordStatus,
    receiptHash: call.receiptHash,
    externalTruthProven: false as const,
  };
}

async function verifyStellarTransaction(
  plan: WorkflowPlanV2,
  step: WorkflowV2Step,
  hashInput: unknown,
): Promise<NonNullable<WorkflowV2Step["result"]>> {
  const hash = stellarHash(hashInput);
  const response = await fetch(
    new URL(`/transactions/${hash}`, STELLAR_TESTNET.horizonUrl),
    { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8_000) },
  );
  if (!response.ok) {
    throw controlled("WORKFLOW_STELLAR_TRANSACTION_UNAVAILABLE", "Stellar checkpoint was not found.", 409);
  }
  const transaction = (await response.json()) as {
    successful?: unknown;
    source_account?: unknown;
    ledger?: unknown;
  };
  if (
    transaction.successful !== true ||
    transaction.source_account !== walletAddress(plan, step.walletBinding)
  ) {
    throw controlled("WORKFLOW_STELLAR_TRANSACTION_REJECTED", "Stellar checkpoint failed its wallet or success boundary.", 409);
  }
  if (!step.target || !StrKey.isValidContract(step.target) || !step.binding?.method) {
    throw controlled("STELLAR_INVOCATION_BINDING_MISSING", "Stellar invocation binding is missing.", 409);
  }
  const operationsResponse = await fetch(
    new URL(`/transactions/${hash}/operations`, STELLAR_TESTNET.horizonUrl),
    { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8_000) },
  );
  if (!operationsResponse.ok) {
    throw controlled("STELLAR_OPERATION_UNAVAILABLE", "Stellar operation evidence is unavailable.", 409);
  }
  const operationsBody = (await operationsResponse.json()) as {
    _embedded?: {
      records?: Array<{
        type?: unknown;
        source_account?: unknown;
        parameters?: Array<{ type?: unknown; value?: unknown }>;
      }>;
    };
  };
  const operations = operationsBody._embedded?.records;
  if (!Array.isArray(operations) || operations.length !== 1) {
    throw controlled("STELLAR_OPERATION_SHAPE_INVALID", "Stellar checkpoint must contain one exact contract invocation.", 409);
  }
  const operation = operations[0];
  const parameters = operation.parameters;
  if (
    operation.type !== "invoke_host_function" ||
    operation.source_account !== walletAddress(plan, step.walletBinding) ||
    !Array.isArray(parameters) ||
    parameters.length < 2 ||
    parameters[0]?.type !== "Address" ||
    parameters[1]?.type !== "Sym" ||
    typeof parameters[0].value !== "string" ||
    typeof parameters[1].value !== "string"
  ) {
    throw controlled("STELLAR_INVOCATION_INVALID", "Stellar invocation shape did not match the workflow.", 409);
  }
  let contractId: string;
  let method: string;
  let nativeArgs: unknown[];
  try {
    contractId = StellarAddress.fromScVal(
      xdr.ScVal.fromXdr(parameters[0].value, "base64"),
    ).toString();
    method = String(scValToNative(xdr.ScVal.fromXdr(parameters[1].value, "base64")));
    nativeArgs = parameters.slice(2).map((parameter) => {
      if (typeof parameter.value !== "string") throw new Error("invalid_parameter");
      return scValToNative(xdr.ScVal.fromXdr(parameter.value, "base64"));
    });
  } catch {
    throw controlled("STELLAR_INVOCATION_INVALID", "Stellar invocation parameters could not be decoded.", 409);
  }
  if (contractId !== step.target || method !== step.binding.method) {
    throw controlled("STELLAR_INVOCATION_MISMATCH", "Stellar contract or method did not match the sealed workflow.", 409);
  }
  const rpcServer = new rpc.Server(STELLAR_TESTNET.rpcUrl);
  const rpcResult = await rpcServer.getTransaction(hash);
  if (rpcResult.status !== "SUCCESS") {
    throw controlled("STELLAR_RPC_RESULT_MISMATCH", "Stellar RPC did not confirm a successful result.", 409);
  }
  const expectedContractBytes = Buffer.from(StrKey.decodeContract(step.target));
  const hasExpectedEvent = rpcResult.events.contractEventsXdr
    .flat()
    .some(
      (event) =>
        event.contractId !== null &&
        Buffer.from(event.contractId.value).equals(expectedContractBytes),
    );
  if (!hasExpectedEvent) {
    throw controlled("STELLAR_EVENT_MISMATCH", "No event from the sealed Stellar contract was found.", 409);
  }
  const archivedEvents = rpcResult.events.contractEventsXdr.flat().flatMap((event) => {
    if (event.contractId === null) return [];
    return [{
      contractId: StrKey.encodeContract(Buffer.from(event.contractId.value)),
      eventXdr: event.toXdr("base64"),
    }];
  });
  const previousAmount = latestAmount(plan, step.order);
  let amountAtomic = previousAmount;
  let maxFeeAtomic: bigint | undefined;
  let feeQuoteBps: number | undefined;
  let feeQuoteObservedAt: string | undefined;
  let policyRegistry: NonNullable<
    NonNullable<WorkflowV2Step["result"]>["policyRegistry"]
  > | undefined;
  const lastAttestation = [...plan.steps]
    .slice(0, step.order - 1)
    .reverse()
    .find((candidate) => candidate.action === "cctp_attestation" && candidate.result?.message);
  if (step.action === "cctp_mint") {
    const [messageBytes, attestationBytes] = nativeArgs;
    const asHex = (value: unknown) =>
      value instanceof Uint8Array ? `0x${Buffer.from(value).toString("hex")}`.toLowerCase() : "";
    if (
      !lastAttestation?.result?.message ||
      !lastAttestation.result.attestation ||
      asHex(messageBytes) !== lastAttestation.result.message.toLowerCase() ||
      asHex(attestationBytes) !== lastAttestation.result.attestation.toLowerCase()
    ) {
      throw controlled("STELLAR_CCTP_PAYLOAD_MISMATCH", "Stellar mint payload did not match Circle attestation.", 409);
    }
    amountAtomic = lastAttestation.result.amountAtomic
      ? BigInt(lastAttestation.result.amountAtomic)
      : null;
    if (amountAtomic === null) {
      throw controlled(
        "STELLAR_CCTP_PAYOUT_EVIDENCE_MISSING",
        "The verified Circle attestation did not include a payout amount.",
        409,
      );
    }
    verifyStellarMintAndForwardPayout({
      events: rpcResult.events.contractEventsXdr.flat(),
      recipient: walletAddress(plan, "stellar_wallet"),
      amountAtomicSixDecimals: amountAtomic,
    });
  } else if (step.action === "cctp_approve") {
    const [owner, spender, approvedAmount] = nativeArgs;
    if (
      previousAmount === null ||
      String(owner) !== walletAddress(plan, step.walletBinding) ||
      String(spender) !== STELLAR_TESTNET.cctp.tokenMessengerMinter ||
      BigInt(String(approvedAmount)) !== previousAmount * 10n
    ) {
      throw controlled("STELLAR_CCTP_APPROVAL_MISMATCH", "Stellar CCTP approval did not match the workflow amount.", 409);
    }
  } else if (step.action === "cctp_burn") {
    const [owner, stellarAmount, destinationDomain, mintRecipient, burnToken, destinationCaller, maxFee, finality] = nativeArgs;
    const expectedRecipient = expectedBytes32Address(walletAddress(plan, "arbitrum_sepolia_wallet"));
    const bytesHex = (value: unknown) =>
      value instanceof Uint8Array ? `0x${Buffer.from(value).toString("hex")}`.toLowerCase() : "";
    feeQuoteBps = sealedCctpLegFee(plan, 27, 3);
    feeQuoteObservedAt = plan.routeCandidates.find(
      (candidate) => candidate.kind === plan.selectedRoute,
    )?.liveEvidence.observedAt;
    const canonicalMaxFeeAtomic = exactBufferedFee(
      previousAmount === null ? 0n : previousAmount,
      feeQuoteBps,
    );
    const stellarMaxFeeAtomic = canonicalMaxFeeAtomic * 10n;
    if (
      previousAmount === null ||
      String(owner) !== walletAddress(plan, step.walletBinding) ||
      BigInt(String(stellarAmount)) !== previousAmount * 10n ||
      Number(destinationDomain) !== 3 ||
      bytesHex(mintRecipient) !== expectedRecipient.toLowerCase() ||
      String(burnToken) !== STELLAR_TESTNET.usdc.sac ||
      bytesHex(destinationCaller) !== zeroHash ||
      BigInt(String(maxFee)) !== stellarMaxFeeAtomic ||
      Number(finality) !== 2_000
    ) {
      throw controlled("STELLAR_CCTP_BURN_MISMATCH", "Stellar CCTP burn did not match the sealed workflow.", 409);
    }
    // Stellar contract arguments use seven-decimal SAC units. CCTP message
    // bodies always normalize USDC amount and maxFee to six-decimal units.
    maxFeeAtomic = canonicalMaxFeeAtomic;
    amountAtomic = previousAmount;
  } else if (
    step.action === "stellar_policy_commit" ||
    step.action === "stellar_receipt_finalize"
  ) {
    amountAtomic = null;
    policyRegistry = await verifyPolicyRegistryInvocation({
      plan,
      step,
      nativeArgs,
      events: rpcResult.events.contractEventsXdr.flat(),
      transactionLedger: Number(transaction.ledger ?? rpcResult.ledger),
    });
  }
  // Archive only after the action-specific economic evidence has passed. A
  // successful envelope with unrelated or malformed events is not a verified
  // Kletia checkpoint and must never enter the recovery archive.
  await archiveVerifiedStellarTransaction({
    transactionHash: hash,
    ledgerSequence: Number(transaction.ledger ?? rpcResult.ledger),
    events: archivedEvents,
  });
  return {
    kind: "stellar_transaction",
    reference: hash,
    observedAt: new Date().toISOString(),
    blockOrLedger: String(transaction.ledger ?? rpcResult.ledger),
    ...(amountAtomic !== null ? { amountAtomic: amountAtomic.toString() } : {}),
    ...(maxFeeAtomic !== undefined ? { maxFeeAtomic: maxFeeAtomic.toString() } : {}),
    ...(feeQuoteBps !== undefined ? { feeQuoteBps } : {}),
    ...(feeQuoteObservedAt ? { feeQuoteObservedAt } : {}),
    ...(policyRegistry ? { policyRegistry } : {}),
  };
}

async function verifyCircleAttestation(plan: WorkflowPlanV2, step: WorkflowV2Step) {
  const previous = plan.steps[step.order - 2];
  const transactionHash = previous?.result?.reference;
  if (!transactionHash) {
    throw controlled("CCTP_SOURCE_EVIDENCE_MISSING", "A verified source burn is required before attestation.", 409);
  }
  const sourceDomain = step.binding?.sourceDomain;
  const destinationDomain = step.binding?.destinationDomain;
  if (
    (sourceDomain !== 26 && sourceDomain !== 27) ||
    (destinationDomain !== 3 && destinationDomain !== 27)
  ) {
    throw controlled("CCTP_DOMAIN_BINDING_INVALID", "CCTP domain binding is invalid.", 409);
  }
  const url = new URL(`https://iris-api-sandbox.circle.com/v2/messages/${sourceDomain}`);
  url.searchParams.set("transactionHash", transactionHash);
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw controlled("CCTP_ATTESTATION_UNAVAILABLE", "Circle attestation is not available yet.", 409);
  }
  const payload = (await response.json()) as {
    messages?: Array<{
      status?: unknown;
      cctpVersion?: unknown;
      eventNonce?: unknown;
      attestation?: unknown;
      messageHash?: unknown;
      message?: unknown;
      sourceDomain?: unknown;
      destinationDomain?: unknown;
      decodedMessage?: {
        sourceDomain?: unknown;
        destinationDomain?: unknown;
        destinationCaller?: unknown;
        nonce?: unknown;
        decodedMessageBody?: {
          burnToken?: unknown;
          mintRecipient?: unknown;
          amount?: unknown;
          maxFee?: unknown;
          feeExecuted?: unknown;
        };
      };
    }>;
  };
  const message = payload.messages?.find(
    (candidate) => cctpV2MessageMatchesDomains(
      candidate,
      sourceDomain,
      destinationDomain,
    ),
  );
  if (
    !message ||
    message.status !== "complete" ||
    typeof message.attestation !== "string" ||
    !/^0x[a-f0-9]+$/iu.test(message.attestation) ||
    typeof message.messageHash !== "string" ||
    !/^0x[a-f0-9]{64}$/iu.test(message.messageHash) ||
    typeof message.message !== "string" ||
    !/^0x[a-f0-9]+$/iu.test(message.message)
  ) {
    throw controlled("CCTP_ATTESTATION_PENDING", "Circle attestation has not reached a verified complete state.", 409);
  }
  const decoded = message.decodedMessage;
  const raw = parseCctpV2Message(message.message);
  const amount = raw.amount;
  if (
    raw.sourceDomain !== sourceDomain ||
    raw.destinationDomain !== destinationDomain ||
    raw.messageVersion !== 1 ||
    Number(message.cctpVersion) !== 2 ||
    raw.burnMessageVersion !== 1 ||
    keccak256(message.message as Hex).toLowerCase() !==
      message.messageHash.toLowerCase() ||
    Number(decoded?.sourceDomain) !== sourceDomain ||
    Number(decoded?.destinationDomain) !== destinationDomain ||
    !cctpV2NonceMatches(message.eventNonce, raw.nonce) ||
    !cctpV2NonceMatches(decoded?.nonce, raw.nonce) ||
    raw.minFinalityThreshold !== 2_000 ||
    raw.finalityThresholdExecuted < 2_000 ||
    amount <= 0n ||
    raw.feeExecuted > raw.maxFee ||
    raw.feeExecuted >= amount
  ) {
    throw controlled("CCTP_DECODED_MESSAGE_INVALID", "Circle decoded message did not match the sealed domains.", 409);
  }
  const sourceMessage = previous.result?.message;
  const sourceRaw = typeof sourceMessage === "string"
    ? parseCctpV2Message(sourceMessage)
    : null;
  if (
    !sourceRaw ||
    !cctpV2AttestedMessageMatchesSourceEvent(sourceMessage, message.message) ||
    (previous.result?.nonce &&
      previous.result.nonce.toLowerCase() !== sourceRaw.nonce.toLowerCase())
  ) {
    throw controlled(
      "CCTP_SOURCE_MESSAGE_MISMATCH",
      "Circle attestation did not match the exact source-chain MessageSent event.",
      409,
    );
  }
  const expectedRecipient =
    destinationDomain === 27
      ? rawStellarContract(STELLAR_TESTNET.cctp.forwarder)
      : pad(getAddress(walletAddress(plan, "arbitrum_sepolia_wallet")), { size: 32 });
  const expectedCaller = destinationDomain === 27 ? expectedRecipient : zeroHash;
  const expectedBurnToken =
    sourceDomain === 26
      ? pad(ARC_USDC, { size: 32 })
      : rawStellarContract(STELLAR_TESTNET.usdc.sac);
  const expectedHeaderSender =
    sourceDomain === 26
      ? pad(CCTP_TOKEN_MESSENGER, { size: 32 })
      : rawStellarContract(STELLAR_TESTNET.cctp.tokenMessengerMinter);
  const expectedHeaderRecipient =
    destinationDomain === 27
      ? rawStellarContract(STELLAR_TESTNET.cctp.tokenMessengerMinter)
      : pad(ARBITRUM_SEPOLIA.cctp.tokenMessengerV2, { size: 32 });
  const expectedMessageSender =
    sourceDomain === 26
      ? pad(getAddress(walletAddress(plan, "arc_wallet")), { size: 32 })
      : rawStellarAccount(walletAddress(plan, "stellar_wallet"));
  if (
    raw.burnToken.toLowerCase() !== expectedBurnToken.toLowerCase() ||
    raw.mintRecipient.toLowerCase() !== expectedRecipient.toLowerCase() ||
    raw.destinationCaller.toLowerCase() !== expectedCaller.toLowerCase() ||
    raw.sender.toLowerCase() !== expectedHeaderSender.toLowerCase() ||
    raw.recipient.toLowerCase() !== expectedHeaderRecipient.toLowerCase() ||
    raw.messageSender.toLowerCase() !== expectedMessageSender.toLowerCase()
  ) {
    throw controlled("CCTP_ADDRESS_BINDING_MISMATCH", "CCTP message addresses did not match the sealed corridor.", 409);
  }
  if (
    (destinationDomain === 27 &&
      parseForwardRecipient(raw.hookData) !== walletAddress(plan, "stellar_wallet")) ||
    (destinationDomain === 3 && raw.hookData !== "0x")
  ) {
    throw controlled("CCTP_HOOK_BINDING_MISMATCH", "CCTP hook data did not match the sealed route.", 409);
  }
  const previousAmount = latestAmount(plan, step.order);
  // CCTP message amounts are six-decimal on every domain. A Stellar burn
  // takes seven-decimal SAC units locally, truncates the seventh decimal and
  // records the normalized six-decimal amount in the message.
  const expectedSourceAmount = previousAmount;
  if (expectedSourceAmount === null || amount !== expectedSourceAmount) {
    throw controlled("CCTP_AMOUNT_MISMATCH", "CCTP message amount did not match the verified burn.", 409);
  }
  const expectedMaxFee = previous.result?.maxFeeAtomic;
  if (typeof expectedMaxFee !== "string" || !/^\d+$/u.test(expectedMaxFee)) {
    throw controlled("CCTP_BURN_FEE_EVIDENCE_MISSING", "Verified burn fee evidence is missing.", 409);
  }
  if (raw.maxFee !== BigInt(expectedMaxFee)) {
    throw controlled("CCTP_MAX_FEE_MISMATCH", "CCTP max fee did not match the sealed live quote.", 409);
  }
  const netSourceAmount = amount - raw.feeExecuted;
  const destinationAmountAtomic = netSourceAmount;
  const destinationFeeAtomic = raw.feeExecuted;
  return {
    kind: "circle_attestation" as const,
    reference: message.messageHash,
    observedAt: new Date().toISOString(),
    message: message.message,
    attestation: message.attestation,
    amountAtomic: destinationAmountAtomic.toString(),
    feeAtomic: destinationFeeAtomic.toString(),
    nonce: raw.nonce,
  };
}

async function assertPublicRegistryExecutionWindow(
  plan: WorkflowPlanV2,
  step: WorkflowV2Step,
): Promise<void> {
  const anchor = plan.policyAnchor;
  if (
    anchor.mode !== "stellar_public_registry" ||
    step.action === "stellar_policy_commit" ||
    step.action === "stellar_receipt_finalize" ||
    step.action === "cctp_attestation" ||
    step.action === "borrow_capacity"
  ) {
    return;
  }
  const record = await readStellarPolicyRegistryRecord({
    owner: anchor.owner,
    nonce: anchor.nonce,
  });
  if (
    !record ||
    record.contractId !== anchor.contractId ||
    record.policyCommitment !== anchor.policyCommitment ||
    record.privacyBudgetCommitment !== anchor.privacyBudgetCommitment ||
    record.executionExpiresAtLedger !== anchor.executionExpiresAtLedger ||
    record.receiptCloseByLedger !== anchor.receiptCloseByLedger ||
    record.retentionFloorLedger !== anchor.retentionFloorLedger ||
    record.recordStatus !== "Active" ||
    record.effectiveStatus !== "Active" ||
    record.active !== true
  ) {
    throw controlled(
      "STELLAR_POLICY_EXECUTION_WINDOW_CLOSED",
      "The optional public registry record is absent, mismatched, terminal, or past its execution-validity ledger. It cannot be used to open new execution.",
      409,
    );
  }
}

function canonicalSha256(value: unknown): `0x${string}` {
  return `0x${createHash("sha256")
    .update(JSON.stringify(canonicalReceiptValue(value)))
    .digest("hex")}`;
}

function receiptCheckpointProjection(steps: readonly WorkflowV2Step[]) {
  return steps.map((step) => ({
    stepId: step.id,
    action: step.action,
    network: step.network,
    status: step.status,
    target: step.target,
    binding: step.binding,
    evidenceRequired: step.evidenceRequired,
    result: step.result,
  }));
}

function buildRegistryReceiptDraft(plan: WorkflowPlanV2) {
  if (
    plan.policyAnchor.mode !== "stellar_public_registry" ||
    !plan.manifestAuthorization
  ) {
    throw controlled(
      "STELLAR_POLICY_RECEIPT_NOT_READY",
      "A verified economic plan and current manifest authorization are required before receipt finalization can be prepared.",
      409,
    );
  }
  const checkpoints = receiptCheckpointProjection(
    plan.steps.filter((step) => step.action !== "stellar_receipt_finalize"),
  );
  const receiptGeneratedAt = new Date().toISOString();
  const anchorPreimage = {
    domain: "KLETIA_EXECUTION_RECEIPT_ANCHOR_V1" as const,
    schemaVersion: "kletia_execution_receipt_anchor_preimage_v1" as const,
    workflowId: plan.workflowId,
    requestId: plan.requestId,
    registryContractId: plan.policyAnchor.contractId,
    registryOwner: plan.policyAnchor.owner,
    registryNonce: plan.policyAnchor.nonce,
    executionPlanCoreSha256: plan.authorizationBoundary.planCoreSha256,
    executionManifestSha256: plan.manifestAuthorization.manifestSha256,
    executionPrivacyBudgetSha256: canonicalSha256(
      plan.privacy.privacyBudget,
    ),
    executionDisclosureDiffSha256: canonicalSha256(
      plan.privacy.disclosureDiff,
    ),
    checkpointEvidenceSha256: canonicalSha256(checkpoints),
    status: "confirmed" as const,
    receiptGeneratedAt,
    crossChainAtomicity: plan.policies.crossChainAtomicity,
    privateValuesExcludedFromAiPlanning: true as const,
    externalTruthProvenByRegistry: false as const,
  };
  return {
    anchorPreimage,
    receiptSha256: canonicalSha256(anchorPreimage),
    checkpoints,
  };
}

function rebuildRegistryReceipt(
  plan: WorkflowPlanV2,
  call: Extract<
    NonNullable<NonNullable<WorkflowV2Step["binding"]>["policyRegistryCall"]>,
    { operation: "finalize" }
  >,
) {
  const checkpoints = receiptCheckpointProjection(
    plan.steps.filter((step) => step.action !== "stellar_receipt_finalize"),
  );
  if (canonicalSha256(checkpoints) !== call.checkpointEvidenceSha256) {
    throw controlled(
      "STELLAR_POLICY_RECEIPT_EVIDENCE_MISMATCH",
      "The checkpoint evidence no longer matches the owner-acknowledged receipt preimage.",
      409,
    );
  }
  const anchor = plan.policyAnchor;
  if (anchor.mode !== "stellar_public_registry") {
    throw controlled("STELLAR_POLICY_RECEIPT_EVIDENCE_MISMATCH", "The receipt lost its registry anchor binding.", 409);
  }
  const anchorPreimage = {
    domain: "KLETIA_EXECUTION_RECEIPT_ANCHOR_V1" as const,
    schemaVersion: "kletia_execution_receipt_anchor_preimage_v1" as const,
    workflowId: plan.workflowId,
    requestId: plan.requestId,
    registryContractId: anchor.contractId,
    registryOwner: anchor.owner,
    registryNonce: anchor.nonce,
    executionPlanCoreSha256: call.executionPlanCoreSha256,
    executionManifestSha256: call.executionManifestSha256,
    executionPrivacyBudgetSha256: call.executionPrivacyBudgetSha256,
    executionDisclosureDiffSha256: call.executionDisclosureDiffSha256,
    checkpointEvidenceSha256: call.checkpointEvidenceSha256,
    status: "confirmed" as const,
    receiptGeneratedAt: call.receiptGeneratedAt,
    crossChainAtomicity: plan.policies.crossChainAtomicity,
    privateValuesExcludedFromAiPlanning: true as const,
    externalTruthProvenByRegistry: false as const,
  };
  const receiptSha256 = canonicalSha256(anchorPreimage);
  if (receiptSha256 !== call.receiptHash) {
    throw controlled(
      "STELLAR_POLICY_RECEIPT_HASH_MISMATCH",
      "The reconstructed execution receipt did not match the exact finalized hash.",
      409,
    );
  }
  return { anchorPreimage, receiptSha256, checkpoints };
}

function registryExecutionReceipt(input: {
  plan: WorkflowPlanV2;
  draft: ReturnType<typeof buildRegistryReceiptDraft> | ReturnType<typeof rebuildRegistryReceipt>;
  anchorStatus: "awaiting_owner_finalization" | "finalized";
  finalizationResult?: NonNullable<WorkflowV2Step["result"]>;
}) {
  const anchor = input.plan.policyAnchor;
  if (anchor.mode !== "stellar_public_registry") {
    throw controlled("STELLAR_POLICY_RECEIPT_NOT_READY", "Registry receipt mode is unavailable.", 409);
  }
  return {
    schemaVersion: "kletia_execution_receipt_v1" as const,
    workflowId: input.plan.workflowId,
    status: "confirmed" as const,
    generatedAt: input.draft.anchorPreimage.receiptGeneratedAt,
    crossChainAtomicity: input.plan.policies.crossChainAtomicity,
    privateValuesExcludedFromAiPlanning: true as const,
    anchorPreimage: input.draft.anchorPreimage,
    receiptSha256: input.draft.receiptSha256,
    checkpoints: input.draft.checkpoints,
    publicRegistryAnchor: {
      schemaVersion: "kletia_public_registry_anchor_evidence_v1" as const,
      status: input.anchorStatus,
      network: "stellar_testnet" as const,
      contractId: anchor.contractId,
      owner: anchor.owner,
      nonce: anchor.nonce,
      ownerAcknowledgementRequired: true as const,
      onchainAnchorPresent: input.anchorStatus === "finalized",
      provesReceiptPreimage: false as const,
      provesExternalExecution: false as const,
      providesConfidentiality: false as const,
      ...(input.finalizationResult
        ? {
            transactionHash: input.finalizationResult.reference,
            event: input.finalizationResult.policyRegistry,
          }
        : {}),
      limitation:
        "The registry proves only that this public Stellar owner authorized the opaque receipt hash. The receipt's underlying Stellar, EVM, CCTP and Aave evidence must still be verified independently.",
    },
    verificationModel: {
      kind: "evidence_bound_application_receipt_sha256" as const,
      recomputeReceiptHashFromAnchorPreimage: true as const,
      verifyCheckpointAttachmentHash: true as const,
      verifyUnderlyingChainEvidence: true as const,
      kletiaSignaturePresent: false as const,
      ownerAuthorizedOpaqueAnchorPresent:
        input.anchorStatus === "finalized",
      externalTruthProvenByRegistry: false as const,
      limitation:
        "Owner-authorized finalization is durable public linkage, not an oracle, bridge proof, privacy proof or independent statement of external-chain truth.",
    },
  };
}

export async function advanceWorkflowV2(input: {
  workflowToken?: unknown;
  requestId?: unknown;
  txHash?: unknown;
  amountCommitmentSalt?: unknown;
  recipientCommitmentSalt?: unknown;
  manifestAuthorization?: {
    family?: unknown;
    signer?: unknown;
    signature?: unknown;
  };
}) {
  const openedPlan = openWorkflowPlanV2(input.workflowToken);
  const parentGuardStep = openedPlan.steps[openedPlan.currentStepIndex];
  if (
    (openedPlan.parentWorkflowV3?.expiresAt ?? openedPlan.parentWorkflowV4?.expiresAt ?? Number.POSITIVE_INFINITY) <= Date.now() &&
    !isWorkflowExpirySafeRecoveryActionV2(parentGuardStep?.action)
  ) {
    throw controlled(
      "WORKFLOW_V3_PARENT_EXPIRED",
      "The parent canonical policy window expired. New approvals, burns and DeFi spending cannot advance; only bound CCTP recovery or read-only checkpoints remain available.",
      409,
    );
  }
  const evaluatedDisclosureDiff = assertPrivacyBudgetCompatible(
    openedPlan,
    openedPlan.privacy.privacyBudget,
  );
  const declaredDisclosureHash = createHash("sha256")
    .update(JSON.stringify(canonicalReceiptValue(openedPlan.privacy.disclosureDiff)))
    .digest("hex");
  const evaluatedDisclosureHash = createHash("sha256")
    .update(JSON.stringify(canonicalReceiptValue(evaluatedDisclosureDiff)))
    .digest("hex");
  if (declaredDisclosureHash !== evaluatedDisclosureHash) {
    throw controlled(
      "DISCLOSURE_DIFF_INTEGRITY_MISMATCH",
      "The sealed Disclosure Diff no longer matches the exact workflow route.",
      409,
    );
  }
  const openedCurrent = openedPlan.steps[openedPlan.currentStepIndex];
  if (
    openedPlan.expiresAt <= Date.now() &&
    !isWorkflowExpirySafeRecoveryActionV2(openedCurrent?.action)
  ) {
    throw controlled(
      "WORKFLOW_AUTHORIZATION_EXPIRED",
      "The workflow authorization expired. Refresh and re-sign the sealed plan before continuing.",
      409,
    );
  }
  const plan = await ensureManifestAuthorization(
    openedPlan,
    input.manifestAuthorization,
  );
  if (String(input.requestId ?? "") !== plan.requestId) {
    throw controlled("WORKFLOW_REQUEST_MISMATCH", "Workflow request identity did not match.", 409);
  }
  // Fail closed before observing anything: a step that already reached `failed`
  // or `recovery_required` must not be advanced again under the same seal.
  assertWorkflowStepAdvanceable(plan);
  const current = plan.steps[plan.currentStepIndex];
  await assertPublicRegistryExecutionWindow(plan, current);
  let result: WorkflowV2Step["result"];
  try {
    if (current.action === "cctp_attestation") {
      result = await verifyCircleAttestation(plan, current);
    } else if (current.action === "borrow_capacity") {
      const value = await readArbitrumSepoliaBorrowCapacity(
        walletAddress(plan, current.walletBinding),
      );
      result = {
        kind: "read_result",
        reference: value.safeAmountAtomic,
        observedAt: value.observedAtBlock,
        blockOrLedger: value.observedAtBlock,
        safeBorrowCapacityAtomic: value.safeAmountAtomic,
        capacityStatus: value.capacityStatus,
        targetHealthFactor: value.targetHealthFactor,
        limitations: value.limitations,
      };
    } else if (current.network === "stellar_testnet") {
      result = await verifyStellarTransaction(plan, current, input.txHash);
    } else {
      result = await verifyEvmTransaction(
        plan,
        current,
        input.txHash,
        input.amountCommitmentSalt,
        input.recipientCommitmentSalt,
      );
    }
    result = await recordWorkflowCheckpoint({
      workflowId: plan.workflowId,
      step: current,
      result,
    });
  } catch (error) {
    // Classify into failed / indeterminate / recovery_required, record it in the
    // sealed plan and rethrow. Nothing is ever silently resubmitted here.
    throw sealWorkflowLifecycleFailure(plan, error, sealWorkflowPlanV2);
  }
  const steps = plan.steps.map((step, index) =>
    index === plan.currentStepIndex
      ? { ...step, status: step.action === "cctp_attestation" ? "filled" as const : "confirmed" as const, result }
      : index === plan.currentStepIndex + 1
        ? {
            ...step,
            status:
              step.action === "cctp_attestation"
                ? "attesting" as const
                : step.action === "borrow_capacity"
                  ? "ready" as const
                  : "awaiting_signature" as const,
          }
        : step,
  );
  const reachedPlanEnd = plan.currentStepIndex === plan.steps.length - 1;
  // Persist the observed checkpoint in the plan before any quote refresh or
  // receipt work. If a later service call fails, lifecycle classification is
  // applied to the *next* step while the just-verified step remains confirmed.
  // This prevents a post-checkpoint failure from making already-consumed
  // onchain evidence look safe to submit again.
  const checkpointedPlan = rebindWorkflowPlanAuthorization({
    ...plan,
    currentStepIndex: reachedPlanEnd ? plan.currentStepIndex : plan.currentStepIndex + 1,
    steps,
  });
  try {
    const routeCandidates = await refreshNextBurnQuote(
      checkpointedPlan,
      reachedPlanEnd
        ? undefined
        : checkpointedPlan.steps[checkpointedPlan.currentStepIndex],
    );
    const selectedRouteScore = routeCandidates.find(
      (candidate) => candidate.kind === checkpointedPlan.selectedRoute,
    )?.score.total;
    if (selectedRouteScore === undefined) {
      throw controlled("WORKFLOW_ROUTE_EVIDENCE_MISSING", "Selected route evidence is missing.", 409);
    }
    const draftPlan = rebindWorkflowPlanAuthorization({
      ...checkpointedPlan,
      routeCandidates,
      routeSelection: {
        ...checkpointedPlan.routeSelection,
        selectedScore: selectedRouteScore,
      },
    });
    const nextPlan = plan.expiresAt <= Date.now()
      ? renewWorkflowPlanAuthorization(draftPlan, routeCandidates)
      : draftPlan;

    if (
      reachedPlanEnd &&
      nextPlan.policyAnchor.mode === "stellar_public_registry" &&
      current.action !== "stellar_receipt_finalize"
    ) {
      const receiptDraft = buildRegistryReceiptDraft(nextPlan);
      const preparedFinalize = await prepareStellarPolicyRegistryFinalize({
        owner: nextPlan.policyAnchor.owner,
        nonce: nextPlan.policyAnchor.nonce,
        receiptHash: receiptDraft.receiptSha256,
        expectedPolicyCommitment: nextPlan.policyAnchor.policyCommitment,
        expectedPrivacyBudgetCommitment:
          nextPlan.policyAnchor.privacyBudgetCommitment,
      });
      const previousStep = nextPlan.steps[nextPlan.steps.length - 1];
      const finalStepId = `step-${nextPlan.steps.length + 1}`;
      const finalStep: WorkflowV2Step = {
        id: finalStepId,
        order: nextPlan.steps.length + 1,
        action: "stellar_receipt_finalize",
        network: "stellar_testnet",
        walletBinding: "stellar_wallet",
        dependsOn: [previousStep.id],
        status: "awaiting_signature",
        amount: { source: "none" },
        target: preparedFinalize.contractId,
        binding: {
          protocol: "kletia_policy_registry",
          method: "finalize",
          policyRegistryCall: {
            schemaVersion: "kletia_policy_registry_call_v1",
            operation: "finalize",
            owner: preparedFinalize.owner,
            nonce: preparedFinalize.nonce,
            receiptHash: preparedFinalize.receiptHash,
            executionPlanCoreSha256:
              receiptDraft.anchorPreimage.executionPlanCoreSha256,
            executionManifestSha256:
              receiptDraft.anchorPreimage.executionManifestSha256,
            executionPrivacyBudgetSha256:
              receiptDraft.anchorPreimage.executionPrivacyBudgetSha256,
            executionDisclosureDiffSha256:
              receiptDraft.anchorPreimage.executionDisclosureDiffSha256,
            checkpointEvidenceSha256:
              receiptDraft.anchorPreimage.checkpointEvidenceSha256,
            receiptGeneratedAt:
              receiptDraft.anchorPreimage.receiptGeneratedAt,
            expectedWasmSha256: preparedFinalize.expectedWasmSha256,
            stateObservedAtLedger: preparedFinalize.stateObservedAtLedger,
            recordingSimulationLatestLedger:
              preparedFinalize.recordingSimulationLatestLedger,
            invocationSha256: preparedFinalize.invocationSha256,
            enforcingSimulationRequiredBeforeSigning: true,
          },
        },
        evidenceRequired: [
          "exact_owner_authorized_invocation",
          "policy_finalized_event",
          "stored_finalized_record_match",
          "opaque_receipt_hash_match",
        ],
        disclosure: [
          {
            field: "wallet_identity",
            visibleTo: [
              "device",
              "wallet_extension",
              "kletia_api",
              "rpc",
              "public_ledger",
            ],
            reason:
              "The public Stellar owner explicitly acknowledges the opaque receipt hash.",
          },
          {
            field: "workflow_linkage",
            visibleTo: [
              "device",
              "wallet_extension",
              "kletia_api",
              "rpc",
              "public_ledger",
            ],
            reason:
              "The finalization event durably links the owner, nonce and receipt hash to this workflow.",
          },
          {
            field: "receipt_hash",
            visibleTo: [
              "device",
              "wallet_extension",
              "kletia_api",
              "rpc",
              "public_ledger",
            ],
            reason:
              "The receipt hash is public; the registry does not validate its preimage or external-chain truth.",
          },
          {
            field: "timing",
            visibleTo: [
              "device",
              "wallet_extension",
              "kletia_api",
              "rpc",
              "public_ledger",
            ],
            reason:
              "Receipt finalization timing is visible on Stellar and may be correlated with the workflow.",
          },
        ],
      };
      const boundaryMap = {
        ...nextPlan.privacy.boundaryMap,
        checkpoints: [
          ...nextPlan.privacy.boundaryMap.checkpoints,
          {
            stepId: finalStep.id,
            network: finalStep.network,
            action: finalStep.action,
            disclosure: finalStep.disclosure,
          },
        ],
      };
      const provisional = {
        ...nextPlan,
        currentStepIndex: nextPlan.steps.length,
        steps: [...nextPlan.steps, finalStep],
        policyAnchor: {
          ...nextPlan.policyAnchor,
          finalization: {
            status: "awaiting_owner_signature" as const,
            ownerAcknowledgementRequired: true as const,
            receiptHash: receiptDraft.receiptSha256,
          },
        },
        privacy: {
          ...nextPlan.privacy,
          boundaryMap,
        },
      };
      const disclosureDiff = assertPrivacyBudgetCompatible(
        provisional,
        provisional.privacy.privacyBudget,
      );
      const finalizationPlan = rebindWorkflowPlanAuthorization({
        ...provisional,
        privacy: { ...provisional.privacy, disclosureDiff },
      });
      return {
        workflowPlan: finalizationPlan,
        workflowToken: sealWorkflowPlanV2(finalizationPlan),
        terminal: false,
        message:
          "All economic checkpoints are verified. Review and separately sign the owner-only Stellar receipt finalization; it cannot authorize new execution.",
        executionReceipt: registryExecutionReceipt({
          plan: nextPlan,
          draft: receiptDraft,
          anchorStatus: "awaiting_owner_finalization",
        }),
      };
    }

    if (
      reachedPlanEnd &&
      current.action === "stellar_receipt_finalize"
    ) {
      const call = current.binding?.policyRegistryCall;
      if (!call || call.operation !== "finalize" || !result) {
        throw controlled(
          "STELLAR_POLICY_RECEIPT_EVIDENCE_MISSING",
          "The terminal registry receipt binding or evidence is missing.",
          409,
        );
      }
      const receiptDraft = rebuildRegistryReceipt(nextPlan, call);
      if (nextPlan.policyAnchor.mode !== "stellar_public_registry") {
        throw controlled("STELLAR_POLICY_RECEIPT_EVIDENCE_MISSING", "The terminal registry anchor is missing.", 409);
      }
      const finalizedPlan = rebindWorkflowPlanAuthorization({
        ...nextPlan,
        policyAnchor: {
          ...nextPlan.policyAnchor,
          finalization: {
            status: "finalized" as const,
            ownerAcknowledgementRequired: true as const,
            receiptHash: call.receiptHash,
            transactionHash: result.reference,
          },
        },
      });
      return {
        workflowPlan: finalizedPlan,
        workflowToken: sealWorkflowPlanV2(finalizedPlan),
        terminal: true,
        message:
          "The economic workflow and separate owner-authorized public receipt anchor are confirmed.",
        executionReceipt: registryExecutionReceipt({
          plan: finalizedPlan,
          draft: receiptDraft,
          anchorStatus: "finalized",
          finalizationResult: result,
        }),
      };
    }

    const receiptPayload = {
      schemaVersion: "kletia_execution_receipt_v1" as const,
      workflowId: nextPlan.workflowId,
      workflowBindingHash:
        nextPlan.manifestAuthorization?.manifestSha256,
      planCoreSha256: nextPlan.authorizationBoundary.planCoreSha256,
      status: "confirmed" as const,
      generatedAt: new Date().toISOString(),
      crossChainAtomicity: nextPlan.policies.crossChainAtomicity,
      privateValuesExcludedFromAiPlanning: true as const,
      manifestAuthorization: nextPlan.manifestAuthorization,
      privacyBudget: nextPlan.privacy.privacyBudget,
      disclosureDiff: nextPlan.privacy.disclosureDiff,
      verificationModel: {
        kind: "evidence_bound_application_receipt_sha256" as const,
        recomputeReceiptHash: true as const,
        verifyUnderlyingChainEvidence: true as const,
        kletiaSignaturePresent: false as const,
        onchainAnchorPresent: false as const,
        limitation:
          "The receipt is tamper-evident and bound to verified checkpoint evidence; its SHA-256 value is not a Kletia signature or an independent proof of external-chain consensus.",
      },
      checkpoints: nextPlan.steps.map((step) => ({
        stepId: step.id,
        action: step.action,
        network: step.network,
        status: step.status,
        target: step.target,
        binding: step.binding,
        evidenceRequired: step.evidenceRequired,
        result: step.result,
      })),
    };
    const receiptSha256 = `0x${createHash("sha256")
      .update(JSON.stringify(canonicalReceiptValue(receiptPayload)))
      .digest("hex")}` as const;
    const executionReceipt = reachedPlanEnd && nextPlan.manifestAuthorization
      ? { ...receiptPayload, receiptSha256 }
      : undefined;
    const returnedPlan = executionReceipt
      ? rebindWorkflowPlanAuthorization({
          ...nextPlan,
          terminalReceipt: {
            schemaVersion: "kletia_workflow_terminal_receipt_v1",
            receiptSha256,
            generatedAt: executionReceipt.generatedAt,
            checkpointCount: executionReceipt.checkpoints.length,
            executorPlanCoreSha256:
              nextPlan.authorizationBoundary.planCoreSha256,
            externalExecutionTruthProvenByStellar: false,
          },
        })
      : nextPlan;
    return {
      workflowPlan: returnedPlan,
      workflowToken: sealWorkflowPlanV2(returnedPlan),
      terminal: reachedPlanEnd,
      message: reachedPlanEnd
        ? "The testnet workflow completed with verified checkpoints."
        : "Checkpoint verified. The next step is ready for explicit approval.",
      ...(executionReceipt ? { executionReceipt } : {}),
    };
  } catch (error) {
    // Verification and durable checkpoint recording already succeeded. Preserve
    // that fact in the re-sealed plan and classify only the post-checkpoint
    // transition; the client must recover/refresh, never resubmit the confirmed
    // transaction.
    throw sealWorkflowLifecycleFailure(
      checkpointedPlan,
      error,
      sealWorkflowPlanV2,
    );
  }
}

export async function refreshWorkflowAuthorizationV2(input: {
  workflowToken?: unknown;
  requestId?: unknown;
}) {
  const plan = openWorkflowPlanV2(input.workflowToken);
  if ((plan.parentWorkflowV3?.expiresAt ?? plan.parentWorkflowV4?.expiresAt ?? Number.POSITIVE_INFINITY) <= Date.now()) {
    throw controlled(
      "WORKFLOW_V3_PARENT_EXPIRED",
      "The parent canonical policy window expired and cannot be refreshed.",
      409,
    );
  }
  assertPrivacyBudgetCompatible(plan, plan.privacy.privacyBudget);
  if (String(input.requestId ?? "") !== plan.requestId) {
    throw controlled("WORKFLOW_REQUEST_MISMATCH", "Workflow request identity did not match.", 409);
  }
  const current = plan.steps[plan.currentStepIndex];
  if (!current || current.status === "confirmed" || current.status === "filled") {
    throw controlled("WORKFLOW_REFRESH_INVALID", "The current workflow step cannot be refreshed.", 409);
  }
  // A refreshed off-chain authorization must never extend the registry's
  // on-chain execution window. Receipt finalization and read-only recovery are
  // intentionally exempt inside this guard; economic execution is not.
  await assertPublicRegistryExecutionWindow(plan, current);
  const routeCandidates = await refreshNextBurnQuote(plan, current);
  const refreshed = renewWorkflowPlanAuthorization(plan, routeCandidates);
  const selectedRouteScore = refreshed.routeCandidates.find(
    (candidate) => candidate.kind === refreshed.selectedRoute,
  )?.score.total;
  if (selectedRouteScore === undefined) {
    throw controlled("WORKFLOW_ROUTE_EVIDENCE_MISSING", "Selected route evidence is missing.", 409);
  }
  const nextPlan = rebindWorkflowPlanAuthorization({
    ...refreshed,
    routeSelection: {
      ...refreshed.routeSelection,
      selectedScore: selectedRouteScore,
    },
  });
  return {
    workflowPlan: nextPlan,
    workflowToken: sealWorkflowPlanV2(nextPlan),
    terminal: false,
    message: "The authorization window and any pending burn fee evidence were refreshed. Review and sign the new plan core.",
  };
}
