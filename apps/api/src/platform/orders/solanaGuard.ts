/**
 * Checks of Solana order transactions: what a provider built before the
 * wallet sees it, and what the wallet signed before Kletia relays it. The
 * signed transaction must carry byte for byte the message Kletia prepared
 * (sha256 match) and a valid ed25519 signature of the owner; anything else
 * is refused (fail closed).
 */
import { createHash } from "node:crypto";
import {
  getBase58Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  verifySignature,
  address,
  type SignatureBytes,
} from "@solana/kit";
import { PlatformError } from "../errors.js";
import { assertSolanaTransactionOwner, computeBudgetMismatch, SOLANA_PROGRAM_IDS } from "../engine/chains/solana.js";

/** Largest base64 signed transaction accepted (a legacy or v0 transaction is at most 1232 bytes). */
const MAX_SIGNED_BASE64 = 1_644;

/** Programs a Jupiter order transaction may call besides the order program itself. */
const SUPPORT_PROGRAMS: readonly string[] = [
  SOLANA_PROGRAM_IDS.computeBudget,
  SOLANA_PROGRAM_IDS.associatedToken,
  SOLANA_PROGRAM_IDS.system,
  SOLANA_PROGRAM_IDS.token,
];

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function rejected(message: string): PlatformError {
  return new PlatformError("PROVIDER_TRANSACTION_REJECTED", message, 502);
}

function decodeWire(base64: string): { messageBytes: Uint8Array; signatures: Readonly<Record<string, SignatureBytes | null>> } {
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(base64));
  return { messageBytes: Uint8Array.from(transaction.messageBytes), signatures: transaction.signatures as Readonly<Record<string, SignatureBytes | null>> };
}

/**
 * A provider-built order transaction, checked: fee-paid and signed solely by
 * the owner, legacy or v0, calling `program` and nothing but the support
 * programs, with capped compute-budget instructions. Returns the sha256 of
 * its message bytes, which the signed transaction must match.
 */
export function checkOrderTransaction(base64: string, owner: string, program: string): string {
  const info = assertSolanaTransactionOwner(base64, owner);
  if (info.version !== 0 && info.version !== "legacy") throw rejected("The order transaction uses an unexpected message version.");
  if (!info.programs.includes(program)) throw rejected("The order transaction does not call the order program.");
  const foreign = info.programs.filter((id) => id !== program && !SUPPORT_PROGRAMS.includes(id));
  if (foreign.length > 0) throw rejected(`The order transaction calls an unexpected program (${foreign[0]}).`);
  const { messageBytes } = decodeWire(base64);
  const message = getCompiledTransactionMessageDecoder().decode(messageBytes);
  if (message.version === 1) throw rejected("The order transaction uses an unexpected message version.");
  for (const instruction of message.instructions) {
    if (String(message.staticAccounts[instruction.programAddressIndex]) !== SOLANA_PROGRAM_IDS.computeBudget) continue;
    const mismatch = computeBudgetMismatch(Uint8Array.from(instruction.data ?? []));
    if (mismatch) throw rejected(`The order transaction ${mismatch}.`);
  }
  return sha256(messageBytes);
}

function mismatch(message: string): PlatformError {
  return new PlatformError("ORDER_SIGNATURE_MISMATCH", message, 422);
}

/**
 * The signed transaction carries exactly the prepared message (by sha256) and
 * a valid signature of `owner` over it, and no other signer. Returns the
 * transaction signature (base58).
 */
export async function verifySignedOrderTransaction(signedBase64: string, owner: string, messageHash: string): Promise<string> {
  if (typeof signedBase64 !== "string" || signedBase64.length === 0 || signedBase64.length > MAX_SIGNED_BASE64 || !/^[A-Za-z0-9+/]+=*$/u.test(signedBase64)) {
    throw mismatch("signedTransaction must be the base64 wire transaction the wallet signed.");
  }
  let decoded: ReturnType<typeof decodeWire>;
  try {
    decoded = decodeWire(signedBase64);
  } catch {
    throw mismatch("signedTransaction is not a readable Solana transaction.");
  }
  if (sha256(decoded.messageBytes) !== messageHash) {
    throw mismatch("The signed transaction is not the transaction Kletia prepared (its message changed).");
  }
  const signers = Object.keys(decoded.signatures);
  const signature = decoded.signatures[owner];
  if (signers.length !== 1 || !signature || signature.length !== 64) {
    throw mismatch("The transaction is not signed by the order owner alone.");
  }
  const key = await getPublicKeyFromAddress(address(owner));
  if (!(await verifySignature(key, signature, decoded.messageBytes))) {
    throw mismatch("The owner's signature does not verify over the prepared message.");
  }
  return getBase58Decoder().decode(signature);
}
