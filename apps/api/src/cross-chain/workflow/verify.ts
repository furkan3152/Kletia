/**
 * Settlement checks: Across status, transaction receipts, token outputs
 * and data-purchase evidence.
 */
import { getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import {
  NETWORK_CLIENTS,
  type NetworkId,
} from "../../shared/config/networks.js";
import type { WorkflowSemanticStep } from "./plan.js";
import { ACROSS_STATUS_URL, controlled, MAX_STATUS_BYTES } from "./token.js";

export async function readAcrossStatus(transactionHash: Hex) {
  const apiKey = process.env.ACROSS_API_KEY?.trim();
  if (!apiKey) {
    throw controlled("ACROSS_CONFIGURATION_REQUIRED", "Across status verification is unavailable.", 503);
  }
  const url = new URL(ACROSS_STATUS_URL);
  url.searchParams.set("depositTxnRef", transactionHash);
  const response = await fetch(url, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  const raw = await response.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_STATUS_BYTES) {
    throw controlled("ACROSS_STATUS_INVALID", "Across status response exceeded the safe limit.", 502);
  }
  let data: any;
  try { data = JSON.parse(raw); } catch {
    throw controlled("ACROSS_STATUS_INVALID", "Across status response was not valid JSON.", 502);
  }
  if (!response.ok) {
    if (response.status === 404) return { status: "pending" as const };
    throw controlled("ACROSS_STATUS_UNAVAILABLE", "Across status verification is temporarily unavailable.", 502);
  }
  if (
    !["pending", "received", "filled", "expired", "refunded"].includes(data.status) ||
    Number(data.originChainId) !== 8453 ||
    Number(data.destinationChainId) !== 42161 ||
    String(data.depositTxHash || data.depositTxnRef).toLowerCase() !== transactionHash.toLowerCase()
  ) {
    throw controlled("ACROSS_STATUS_INVALID", "Across status did not match the sealed workflow deposit.", 502);
  }
  const fillTxHash = typeof data.fillTx === "string" && /^0x[0-9a-f]{64}$/iu.test(data.fillTx)
    ? data.fillTx as Hex
    : undefined;
  return { status: data.status as "pending" | "received" | "filled" | "expired" | "refunded", fillTxHash };
}

export async function verifyTransaction(
  network: NetworkId,
  txHash: Hex,
  step: WorkflowSemanticStep,
  userAddress: Address,
) {
  const client = NETWORK_CLIENTS[network];
  const [transaction, receipt] = await Promise.all([
    client.getTransaction({ hash: txHash }),
    client.getTransactionReceipt({ hash: txHash }),
  ]);
  if (
    receipt.status !== "success" ||
    getAddress(transaction.from) !== userAddress ||
    !transaction.to ||
    !step.execution ||
    getAddress(transaction.to) !== getAddress(step.execution.target) ||
    keccak256(transaction.input) !== step.execution.calldataHash ||
    transaction.value.toString() !== step.execution.value
  ) {
    throw controlled(
      "WORKFLOW_RECEIPT_MISMATCH",
      "Transaction receipt does not match the sealed workflow step.",
      409,
    );
  }
  if (!step.outputTokenAddress) return undefined;
  return assertWorkflowTokenOutputReceipt({
    logs: receipt.logs,
    token: step.outputTokenAddress,
    recipient: userAddress,
    minimumAmountAtomic: step.expectedOutputAtomic || "1",
  });
}

const ERC20_TRANSFER_TOPIC = keccak256(
  toHex("Transfer(address,address,uint256)"),
);
const AUTHORIZATION_USED_TOPIC = keccak256(
  toHex("AuthorizationUsed(address,bytes32)"),
);

function topicAddress(topic: string | undefined): Address | null {
  if (!topic || !/^0x[0-9a-f]{64}$/iu.test(topic)) return null;
  try {
    return getAddress(`0x${topic.slice(-40)}`);
  } catch {
    return null;
  }
}

export function assertWorkflowTokenOutputReceipt(input: {
  readonly logs: ReadonlyArray<{
    readonly address: Address;
    readonly topics: readonly Hex[];
    readonly data: Hex;
  }>;
  readonly token: Address;
  readonly recipient: Address;
  readonly minimumAmountAtomic: string;
}): bigint {
  if (!/^\d+$/u.test(input.minimumAmountAtomic) || BigInt(input.minimumAmountAtomic) <= 0n) {
    throw controlled("WORKFLOW_OUTPUT_RECEIPT_MISMATCH", "The sealed minimum output is invalid.", 409);
  }
  const output = input.logs.reduce((total, log) => {
    if (
      getAddress(log.address) !== getAddress(input.token) ||
      log.topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC.toLowerCase() ||
      topicAddress(log.topics[2]) !== getAddress(input.recipient) ||
      !/^0x[0-9a-f]{64}$/iu.test(log.data)
    ) return total;
    return total + BigInt(log.data);
  }, 0n);
  if (output < BigInt(input.minimumAmountAtomic)) {
    throw controlled(
      "WORKFLOW_OUTPUT_RECEIPT_MISMATCH",
      "The confirmed transaction did not deliver the sealed minimum output to the workflow wallet.",
      409,
    );
  }
  return output;
}

export async function verifyDataPurchaseSettlement(
  txHash: Hex,
  step: WorkflowSemanticStep,
  userAddress: Address,
  authorizationNonceInput: unknown,
) {
  if (
    typeof authorizationNonceInput !== "string" ||
    !/^0x[0-9a-f]{64}$/iu.test(authorizationNonceInput) ||
    !step.payment
  ) {
    throw controlled(
      "WORKFLOW_X402_NONCE_REQUIRED",
      "The exact x402 authorization nonce is required to advance this payment.",
      409,
    );
  }
  const authorizationNonce = authorizationNonceInput.toLowerCase() as Hex;
  const [transaction, receipt] = await Promise.all([
    NETWORK_CLIENTS.base.getTransaction({ hash: txHash }),
    NETWORK_CLIENTS.base.getTransactionReceipt({ hash: txHash }),
  ]);
  assertDataPurchaseReceiptEvidence({
    transactionTo: transaction.to,
    receipt,
    step,
    userAddress,
    authorizationNonce,
  });
  return authorizationNonce;
}

export async function verifyAcrossDestinationOutput(
  step: WorkflowSemanticStep,
  fillTxHash: Hex,
  userAddress: Address,
): Promise<bigint> {
  if (!step.outputTokenAddress || !step.expectedOutputAtomic) {
    throw controlled("ACROSS_OUTPUT_BINDING_MISSING", "The Across destination output binding is missing.", 409);
  }
  const receipt = await NETWORK_CLIENTS.arbitrum.getTransactionReceipt({
    hash: fillTxHash,
  });
  if (receipt.status !== "success") {
    throw controlled("ACROSS_FILL_RECEIPT_MISMATCH", "The Across destination fill transaction reverted.", 409);
  }
  try {
    return assertWorkflowTokenOutputReceipt({
      logs: receipt.logs,
      token: step.outputTokenAddress,
      recipient: userAddress,
      minimumAmountAtomic: step.expectedOutputAtomic,
    });
  } catch {
    throw controlled(
      "ACROSS_FILL_RECEIPT_MISMATCH",
      "The Across fill did not deliver the sealed minimum token output to the workflow wallet.",
      409,
    );
  }
}

export function assertDataPurchaseReceiptEvidence(input: {
  readonly transactionTo: Address | null;
  readonly receipt: {
    readonly status: "success" | "reverted";
    readonly logs: ReadonlyArray<{
      readonly address: Address;
      readonly topics: readonly Hex[];
      readonly data: Hex;
    }>;
  };
  readonly step: WorkflowSemanticStep;
  readonly userAddress: Address;
  readonly authorizationNonce: Hex;
}) {
  const { transactionTo, receipt, step, userAddress, authorizationNonce } = input;
  if (
    !step.payment ||
    receipt.status !== "success" ||
    !transactionTo ||
    getAddress(transactionTo) !== getAddress(step.payment.asset)
  ) {
    throw controlled(
      "WORKFLOW_X402_RECEIPT_MISMATCH",
      "x402 settlement transaction did not target the sealed Base USDC contract.",
      409,
    );
  }
  const payment = step.payment;
  const transferMatched = receipt.logs.some((log) =>
    getAddress(log.address) === getAddress(payment.asset) &&
    log.topics[0]?.toLowerCase() === ERC20_TRANSFER_TOPIC.toLowerCase() &&
    topicAddress(log.topics[1]) === userAddress &&
    topicAddress(log.topics[2]) === getAddress(payment.payTo) &&
    /^0x[0-9a-f]{64}$/iu.test(log.data) &&
    BigInt(log.data) === BigInt(payment.amountAtomic),
  );
  const authorizationMatched = receipt.logs.some((log) =>
    getAddress(log.address) === getAddress(payment.asset) &&
    log.topics[0]?.toLowerCase() === AUTHORIZATION_USED_TOPIC.toLowerCase() &&
    topicAddress(log.topics[1]) === userAddress &&
    log.topics[2]?.toLowerCase() === authorizationNonce,
  );
  if (!transferMatched || !authorizationMatched) {
    throw controlled(
      "WORKFLOW_X402_RECEIPT_MISMATCH",
      "x402 settlement did not contain the exact Transfer and AuthorizationUsed nonce evidence.",
      409,
    );
  }
}
