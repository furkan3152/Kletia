/**
 * Signature checks for admin messages. Never "valid on doubt":
 * - EVM: EOA recovery first (no network read); otherwise the chain checks
 *   the signature (ERC-1271 / ERC-6492). A failed read is 502, not valid.
 * - Solana: ed25519 over the UTF-8 message bytes (node:crypto), public key
 *   from the base58 address.
 */
import { createPublicKey, verify as verifyEd25519 } from "node:crypto";
import { getBase58Encoder } from "@solana/kit";
import { verifyMessage, type Address, type Hex, type PublicClient } from "viem";
import { rpcUnavailable } from "../http/errors.js";

export async function verifyEvmMessageSignature(input: {
  readonly client: () => PublicClient;
  readonly network: string;
  readonly address: string;
  readonly message: string;
  readonly signature: string;
}): Promise<boolean> {
  if (!/^0x[0-9a-fA-F]+$/u.test(input.signature) || input.signature.length < 132) return false;
  const address = input.address as Address;
  const signature = input.signature as Hex;
  try {
    if (await verifyMessage({ address, message: input.message, signature })) return true;
  } catch {
    // Not a 65-byte ECDSA signature: a smart account's signature, checked on chain below.
  }
  try {
    return await input.client().verifyMessage({ address, message: input.message, signature });
  } catch {
    throw rpcUnavailable(input.network);
  }
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** A 64-byte signature from base58 or base64 text, or null. */
export function decodeSolanaSignature(value: string): Uint8Array | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) return null;
  if (/^[1-9A-HJ-NP-Za-km-z]+$/u.test(value)) {
    try {
      const bytes = getBase58Encoder().encode(value);
      if (bytes.length === 64) return new Uint8Array(bytes);
    } catch {
      // Not base58: try base64.
    }
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.length === 64 ? new Uint8Array(bytes) : null;
}

export function verifySolanaMessageSignature(address: string, message: string, signature: string): boolean {
  const signatureBytes = decodeSolanaSignature(signature);
  if (!signatureBytes) return false;
  let publicKey: Uint8Array;
  try {
    publicKey = new Uint8Array(getBase58Encoder().encode(address));
  } catch {
    return false;
  }
  if (publicKey.length !== 32) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey)]), format: "der", type: "spki" });
    return verifyEd25519(null, Buffer.from(message, "utf8"), key, Buffer.from(signatureBytes));
  } catch {
    return false;
  }
}
