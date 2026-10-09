/**
 * Optional EAS offchain attestation of a receipt digest (receipts design §7):
 * a Version 2 offchain attestation in the EAS SDK's `SignedOffchainAttestation`
 * shape plus `signer`, verifiable fully offline with `ecrecover` (no chain
 * transaction is ever made). Only the digest, the spec and the sequence are
 * attested; the recipient stays the zero address, so attestations never link
 * a user to their receipts.
 *
 * Domain (verified live on Base, 2026-10-09): name `EAS Attestation`, version
 * `1.0.1`, chain 8453, verifying contract the EAS predeploy
 * 0x4200000000000000000000000000000000000021.
 */
import { randomBytes } from "node:crypto";
import { decodeAbiParameters, encodeAbiParameters, encodePacked, keccak256, parseAbiParameters, stringToBytes, toHex, verifyTypedData, zeroAddress, zeroHash, type Hex } from "viem";
import type { EasAttester } from "./signer.js";

export const EAS_CHAIN_ID = 8453;
export const EAS_CHAIN = "eip155:8453";
export const EAS_ADDRESS = "0x4200000000000000000000000000000000000021";
export const EAS_VERSION = "1.0.1";
export const EAS_SCHEMA = "bytes32 receiptDigest,string spec,uint32 sequence";
/** keccak256(abi.encodePacked(schema, resolver 0x0, revocable true)); not registered on Base (§7.1). */
export const EAS_SCHEMA_UID = keccak256(encodePacked(["string", "address", "bool"], [EAS_SCHEMA, zeroAddress, true]));

export const EAS_ATTEST_TYPES = {
  Attest: [
    { name: "version", type: "uint16" },
    { name: "schema", type: "bytes32" },
    { name: "recipient", type: "address" },
    { name: "time", type: "uint64" },
    { name: "expirationTime", type: "uint64" },
    { name: "revocable", type: "bool" },
    { name: "refUID", type: "bytes32" },
    { name: "data", type: "bytes" },
    { name: "salt", type: "bytes32" },
  ],
} as const;

export const EAS_DOMAIN = { name: "EAS Attestation", version: EAS_VERSION, chainId: EAS_CHAIN_ID, verifyingContract: EAS_ADDRESS } as const;

/** The envelope as stored and returned (JSON: bigints as decimal strings). */
export interface EasEnvelope {
  readonly signer: string;
  readonly sig: {
    readonly domain: typeof EAS_DOMAIN;
    readonly primaryType: "Attest";
    readonly types: typeof EAS_ATTEST_TYPES;
    readonly message: {
      readonly version: 2;
      readonly schema: string;
      readonly recipient: string;
      readonly time: string;
      readonly expirationTime: "0";
      readonly revocable: true;
      readonly refUID: string;
      readonly data: string;
      readonly salt: string;
    };
    readonly uid: string;
    readonly signature: { readonly r: string; readonly s: string; readonly v: number };
  };
}

function offchainUid(message: { schema: Hex; recipient: Hex; time: bigint; refUID: Hex; data: Hex; salt: Hex }): Hex {
  return keccak256(
    encodePacked(
      ["uint16", "bytes", "address", "address", "uint64", "uint64", "bool", "bytes32", "bytes", "bytes32", "uint32"],
      [2, toHex(stringToBytes(message.schema)), message.recipient, zeroAddress, message.time, 0n, true, message.refUID, message.data, message.salt, 0],
    ),
  );
}

function typedMessage(envelope: EasEnvelope["sig"]["message"]) {
  return {
    version: envelope.version,
    schema: envelope.schema as Hex,
    recipient: envelope.recipient as Hex,
    time: BigInt(envelope.time),
    expirationTime: 0n,
    revocable: true,
    refUID: envelope.refUID as Hex,
    data: envelope.data as Hex,
    salt: envelope.salt as Hex,
  };
}

/** Signs an EIP-712 offchain attestation of one receipt digest (an off-chain signature, never a transaction). */
export async function attestReceipt(
  attester: EasAttester,
  input: { readonly digest: string; readonly spec: string; readonly sequence: number; readonly issuedAt: string; readonly refUID?: string | null },
): Promise<EasEnvelope> {
  const time = BigInt(Math.floor(Date.parse(input.issuedAt) / 1000));
  const data = encodeAbiParameters(parseAbiParameters("bytes32, string, uint32"), [`0x${input.digest}`, input.spec, input.sequence]);
  const refUID = (input.refUID && /^0x[0-9a-f]{64}$/u.test(input.refUID) ? input.refUID : zeroHash) as Hex;
  const salt = toHex(randomBytes(32));
  const message = { version: 2, schema: EAS_SCHEMA_UID, recipient: zeroAddress, time, expirationTime: 0n, revocable: true, refUID, data, salt } as const;
  const signature = await attester.account.signTypedData({ domain: EAS_DOMAIN, types: EAS_ATTEST_TYPES, primaryType: "Attest", message });
  const r = `0x${signature.slice(2, 66)}`;
  const s = `0x${signature.slice(66, 130)}`;
  const v = Number.parseInt(signature.slice(130, 132), 16);
  return {
    signer: attester.address,
    sig: {
      domain: EAS_DOMAIN,
      primaryType: "Attest",
      types: EAS_ATTEST_TYPES,
      message: { version: 2, schema: EAS_SCHEMA_UID, recipient: zeroAddress, time: time.toString(), expirationTime: "0", revocable: true, refUID, data, salt },
      uid: offchainUid({ schema: EAS_SCHEMA_UID, recipient: zeroAddress, time, refUID, data, salt }),
      signature: { r, s, v: v < 27 ? v + 27 : v },
    },
  };
}

/** Offline check of an envelope: UID recomputed, EIP-712 signature by `signer`, attested digest. */
export async function verifyEasEnvelope(envelope: EasEnvelope, digest: string): Promise<boolean> {
  try {
    const domain = envelope.sig.domain;
    if (domain.name !== EAS_DOMAIN.name || domain.version !== EAS_DOMAIN.version || domain.chainId !== EAS_DOMAIN.chainId ||
      domain.verifyingContract.toLowerCase() !== EAS_DOMAIN.verifyingContract.toLowerCase() || envelope.sig.primaryType !== "Attest") return false;
    const message = typedMessage(envelope.sig.message);
    if (message.schema !== EAS_SCHEMA_UID || message.recipient !== zeroAddress) return false;
    const [attested, spec] = decodeAbiParameters(parseAbiParameters("bytes32, string, uint32"), message.data);
    if (attested.toLowerCase() !== `0x${digest}` || spec !== "kletia.receipt/v1") return false;
    if (offchainUid(message) !== envelope.sig.uid) return false;
    const { r, s, v } = envelope.sig.signature;
    const signature = `${r}${s.slice(2)}${v.toString(16).padStart(2, "0")}` as Hex;
    return await verifyTypedData({ address: envelope.signer as Hex, domain: EAS_DOMAIN, types: EAS_ATTEST_TYPES, primaryType: "Attest", message, signature });
  } catch {
    return false;
  }
}
