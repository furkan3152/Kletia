import { createHash, randomBytes } from "node:crypto";
import { Address, StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";

export type SolverHex32 = `0x${string}`;

export interface SolverBidSecretV1 {
  readonly schemaVersion: "kletia_solver_bid_secret_v1";
  readonly auctionContract: string;
  readonly workflowRoot: SolverHex32;
  readonly solver: string;
  readonly routeHash: SolverHex32;
  readonly quoteEvidenceHash: SolverHex32;
  readonly promisedOutputAtomic: string;
  readonly solverFeeAtomic: string;
  readonly durationSeconds: number;
  readonly quoteExpiresAtLedger: number;
  readonly salt: SolverHex32;
}

function bytes32(value: string, field: string): Uint8Array {
  if (!/^0x[a-f\d]{64}$/iu.test(value) || /^0x0{64}$/u.test(value)) {
    throw new Error(`${field} must be a non-zero 32-byte hex value.`);
  }
  return Uint8Array.from(Buffer.from(value.slice(2), "hex"));
}

function atomic(value: string, field: string, positive: boolean): bigint {
  if (!/^\d+$/u.test(value)) throw new Error(`${field} must be an atomic integer.`);
  const parsed = BigInt(value);
  if ((positive && parsed <= 0n) || parsed > (1n << 127n) - 1n) {
    throw new Error(`${field} is outside the supported Soroban i128 range.`);
  }
  return parsed;
}

function u32(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffff_ffff) {
    throw new Error(`${field} must be a positive Soroban uint32.`);
  }
  return value;
}

function u64(value: number, field: string): bigint {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer.`);
  }
  return BigInt(value);
}

function hash(payload: Uint8Array | string): SolverHex32 {
  return `0x${createHash("sha256").update(payload).digest("hex")}`;
}

function scBytes32(value: string, field: string): xdr.ScVal {
  return xdr.ScVal.scvBytes(bytes32(value, field));
}

function struct(fields: Readonly<Record<string, xdr.ScVal>>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.entries(fields)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol(key),
        val: value,
      })),
  );
}

/**
 * Exact local reproduction of `BidCommitmentPreimage::to_xdr`. The secret bid
 * is never sent to an RPC provider before the onchain commit is accepted.
 */
export function computeSolverBidCommitment(secret: SolverBidSecretV1): SolverHex32 {
  if (
    secret.schemaVersion !== "kletia_solver_bid_secret_v1" ||
    !StrKey.isValidContract(secret.auctionContract) ||
    !StrKey.isValidEd25519PublicKey(secret.solver)
  ) {
    throw new Error("The solver bid identity is invalid.");
  }
  const preimage = struct({
    auction_contract: new Address(secret.auctionContract).toScVal(),
    domain_hash: scBytes32(hash("KLETIA_ROUTE_BID_V1"), "domainHash"),
    duration_seconds: nativeToScVal(u64(secret.durationSeconds, "durationSeconds"), { type: "u64" }),
    promised_output: nativeToScVal(atomic(secret.promisedOutputAtomic, "promisedOutputAtomic", true), { type: "i128" }),
    quote_evidence_hash: scBytes32(secret.quoteEvidenceHash, "quoteEvidenceHash"),
    quote_expires_at_ledger: nativeToScVal(u32(secret.quoteExpiresAtLedger, "quoteExpiresAtLedger"), { type: "u32" }),
    route_hash: scBytes32(secret.routeHash, "routeHash"),
    salt: scBytes32(secret.salt, "salt"),
    solver: new Address(secret.solver).toScVal(),
    solver_fee: nativeToScVal(atomic(secret.solverFeeAtomic, "solverFeeAtomic", false), { type: "i128" }),
    workflow_root: scBytes32(secret.workflowRoot, "workflowRoot"),
  });
  return hash(xdr.ScVal.schema.encode(preimage.toXdrObject()));
}

export function createSolverBidSalt(): SolverHex32 {
  let value = randomBytes(32);
  if (value.every((entry) => entry === 0)) {
    value = Buffer.from(value);
    value[0] = 1;
  }
  return `0x${value.toString("hex")}`;
}
