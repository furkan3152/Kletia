/**
 * Checks of EIP-712 order signatures before Kletia relays them: the typed
 * data Kletia stored still hashes to the digest it showed, and the signature
 * over that digest is the owner's (ecrecover for accounts without code,
 * ERC-1271 `isValidSignature` for contract wallets). Fail closed.
 */
import { encodeFunctionData, hashTypedData, isAddressEqual, recoverAddress, type Hex, type TypedDataDefinition } from "viem";
import { PlatformError } from "../errors.js";
import { rawEthCall, type EvmNetworkKey } from "../engine/chains/evm.js";
import type { Eip712Payload } from "./types.js";

const ERC1271_MAGIC = "0x1626ba7e";
const ERC1271_ABI = [
  {
    type: "function",
    name: "isValidSignature",
    stateMutability: "view",
    inputs: [{ name: "hash", type: "bytes32" }, { name: "signature", type: "bytes" }],
    outputs: [{ name: "", type: "bytes4" }],
  },
] as const;

/** Typed data as viem hashes it: integer fields become bigint (JSON carries them as decimal strings). */
export function viemTypedData(payload: Eip712Payload): TypedDataDefinition {
  const fields = payload.types[payload.primaryType] ?? [];
  const message: Record<string, unknown> = { ...payload.message };
  for (const field of fields) {
    if (/^u?int\d*$/u.test(field.type) && typeof message[field.name] === "string") message[field.name] = BigInt(message[field.name] as string);
  }
  return {
    domain: { ...payload.domain, verifyingContract: payload.domain.verifyingContract as Hex },
    types: payload.types as TypedDataDefinition["types"],
    primaryType: payload.primaryType,
    message,
  } as TypedDataDefinition;
}

export function typedDataDigest(payload: Eip712Payload): Hex {
  return hashTypedData(viemTypedData(payload));
}

function mismatch(message: string): PlatformError {
  return new PlatformError("ORDER_SIGNATURE_MISMATCH", message, 422);
}

export async function verifyTypedDataSignature(
  network: EvmNetworkKey,
  payload: Eip712Payload,
  digest: string,
  owner: string,
  signature: unknown,
  ownerIsContract: boolean,
): Promise<Hex> {
  if (typeof signature !== "string" || !/^0x(?:[0-9a-fA-F]{2}){65,2048}$/u.test(signature)) {
    throw mismatch("signature must be the 0x hex signature the wallet returned.");
  }
  if (typedDataDigest(payload).toLowerCase() !== digest.toLowerCase()) {
    throw new PlatformError("INTERNAL_ERROR", "The stored order no longer hashes to its digest.", 500);
  }
  const sig = signature as Hex;
  if (!ownerIsContract) {
    if (sig.length !== 132) throw mismatch("An account without code signs with a 65-byte signature.");
    let signer: string;
    try {
      signer = await recoverAddress({ hash: digest as Hex, signature: sig });
    } catch {
      throw mismatch("The signature does not recover to an address.");
    }
    if (!isAddressEqual(signer as Hex, owner as Hex)) throw mismatch("The signature is not the owner's signature over the prepared order.");
    return sig;
  }
  const data = encodeFunctionData({ abi: ERC1271_ABI, functionName: "isValidSignature", args: [digest as Hex, sig] });
  const result = await rawEthCall(network, owner, data);
  if (!result || !result.toLowerCase().startsWith(ERC1271_MAGIC)) {
    throw mismatch("The owner contract does not accept this signature for the prepared order (ERC-1271).");
  }
  return sig;
}
