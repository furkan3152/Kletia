import {
  Address,
  StrKey,
  TransactionBuilder,
  rpc,
  scValToNative,
  type xdr,
} from "@stellar/stellar-sdk";

import { STELLAR_TESTNET } from "../config.js";
import type { Sep24TransferInstruction } from "./types.js";

const TRANSACTION_HASH_PATTERN = /^[a-f\d]{64}$/u;

function controlled(
  code: string,
  message: string,
  statusCode = 409,
  cause?: unknown,
): Error {
  return Object.assign(new Error(message, { cause }), { code, statusCode });
}

function amountAtomic(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, "0") || "0");
}

function nativeMapValue(value: unknown, key: string): unknown {
  if (value instanceof Map) return value.get(key);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return (value as Record<string, unknown>)[key];
  }
  return undefined;
}

function exactTransferEvent(input: {
  events: readonly xdr.ContractEvent[];
  passkeyAccount: string;
  instruction: Sep24TransferInstruction;
}): void {
  const expectedAmount = amountAtomic(input.instruction.amount);
  const matches = input.events.filter((event) => {
    if (
      event.contractId === null ||
      StrKey.encodeContract(Buffer.from(event.contractId.value)) !==
        input.instruction.assetContract ||
      event.type.name !== "contract" ||
      event.body.type !== "v0"
    ) {
      return false;
    }
    const body = event.body.v0;
    if (body.topics.length !== 3) return false;
    try {
      if (
        String(scValToNative(body.topics[0])) !== "transfer" ||
        Address.fromScVal(body.topics[1]).toString() !== input.passkeyAccount ||
        Address.fromScVal(body.topics[2]).toString() !==
          input.instruction.anchorAccount
      ) {
        return false;
      }
      const nativeData = scValToNative(body.data) as unknown;
      const eventAmount =
        typeof nativeData === "bigint" ||
        typeof nativeData === "number" ||
        typeof nativeData === "string"
          ? nativeData
          : nativeMapValue(nativeData, "amount");
      if (BigInt(String(eventAmount)) !== expectedAmount) return false;
      const muxedId = nativeMapValue(nativeData, "to_muxed_id");
      return input.instruction.memo
        ? BigInt(String(muxedId)) === BigInt(input.instruction.memo.value)
        : muxedId === undefined;
    } catch {
      return false;
    }
  });
  if (matches.length !== 1) {
    throw controlled(
      "SEP24_TRANSFER_EVENT_MISMATCH",
      "The Stellar transaction did not emit exactly one matching USDC transfer event.",
    );
  }
}

function exactTransferInvocation(input: {
  envelope: xdr.TransactionEnvelope;
  passkeyAccount: string;
  instruction: Sep24TransferInstruction;
}): void {
  const parsed = TransactionBuilder.fromXdr(
    input.envelope,
    STELLAR_TESTNET.networkPassphrase,
  );
  if (parsed.operations.length !== 1) {
    throw controlled(
      "SEP24_TRANSFER_INVOCATION_MISMATCH",
      "The Stellar transaction contains more than the reviewed payout transfer.",
    );
  }
  const operation = parsed.operations[0];
  if (
    operation.type !== "invokeHostFunction" ||
    operation.func.type !== "hostFunctionTypeInvokeContract"
  ) {
    throw controlled(
      "SEP24_TRANSFER_INVOCATION_MISMATCH",
      "The Stellar transaction is not the reviewed USDC contract invocation.",
    );
  }
  const invocation = operation.func.value;
  const args = invocation.args;
  if (
    Address.fromScAddress(invocation.contractAddress).toString() !==
      input.instruction.assetContract ||
    invocation.functionName.toString() !== "transfer" ||
    args.length !== 3 ||
    Address.fromScVal(args[0]).toString() !== input.passkeyAccount ||
    Address.fromScVal(args[1]).toString() !== input.instruction.destination ||
    BigInt(String(scValToNative(args[2]))) !== amountAtomic(input.instruction.amount)
  ) {
    throw controlled(
      "SEP24_TRANSFER_INVOCATION_MISMATCH",
      "The Stellar USDC invocation differs from the reviewed payout instruction.",
    );
  }
}

export async function verifySep24PasskeyTransfer(input: {
  transactionHash: string;
  passkeyAccount: string;
  instruction: Sep24TransferInstruction;
}): Promise<{ ledgerSequence: number }> {
  const transactionHash = input.transactionHash.trim().toLowerCase();
  if (!TRANSACTION_HASH_PATTERN.test(transactionHash)) {
    throw controlled(
      "SEP24_TRANSFER_HASH_INVALID",
      "A canonical Stellar transaction hash is required.",
      400,
    );
  }
  const server = new rpc.Server(STELLAR_TESTNET.rpcUrl, { timeout: 12_000 });
  const transaction = await server.getTransaction(transactionHash);
  if (transaction.status === "NOT_FOUND") {
    throw controlled(
      "SEP24_TRANSFER_NOT_CONFIRMED",
      "The submitted Stellar transfer is not visible yet; Kletia will keep the session in recovery without resending it.",
    );
  }
  if (transaction.status !== "SUCCESS") {
    throw controlled(
      "SEP24_TRANSFER_FAILED_ONCHAIN",
      "The submitted Stellar transfer failed onchain.",
    );
  }
  exactTransferInvocation({
    envelope: transaction.envelopeXdr,
    passkeyAccount: input.passkeyAccount,
    instruction: input.instruction,
  });
  exactTransferEvent({
    events: transaction.events.contractEventsXdr.flat(),
    passkeyAccount: input.passkeyAccount,
    instruction: input.instruction,
  });
  return { ledgerSequence: transaction.ledger };
}
