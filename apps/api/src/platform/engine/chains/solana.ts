/**
 * Solana transaction inspection: unsigned payload checks before a wallet sees
 * a transaction, and landed-transaction evidence after a signature is
 * submitted (status, fee payer, invoked programs, balance deltas).
 */
import {
  type Base64EncodedWireTransaction,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  signature as toSignature,
} from "@solana/kit";
import { explorerTxUrl, isSolanaAddress, isSolanaSignature, WRAPPED_SOL_MINT } from "@kletia/core";
import { solanaRpc, type SolanaNetworkKey } from "../../../networks/solana/index.js";
import { rpcAbortSignal } from "../../../networks/solana/rpc.js";
import { PlatformError } from "../../errors.js";
import { isRecord } from "../util.js";

export const SOLANA_PROGRAM_IDS = Object.freeze({
  system: "11111111111111111111111111111111",
  token: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  token2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  associatedToken: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  computeBudget: "ComputeBudget111111111111111111111111111111",
  jupiterV6: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
});

export interface UnsignedSolanaTransactionInfo {
  readonly feePayer: string;
  readonly signers: readonly string[];
  /** Programs invoked by top-level instructions, in order, de-duplicated. */
  readonly programs: readonly string[];
}

/** Decodes an unsigned base64 wire transaction (legacy or v0 only). */
export function inspectUnsignedSolanaTransaction(base64: string): UnsignedSolanaTransactionInfo {
  if (typeof base64 !== "string" || base64.length === 0 || base64.length > 1_700 * 2 || !/^[A-Za-z0-9+/]+=*$/u.test(base64)) {
    throw new PlatformError("PROVIDER_TRANSACTION_INVALID", "The provider returned a malformed Solana transaction.", 502);
  }
  try {
    const bytes = getBase64Encoder().encode(base64);
    const transaction = getTransactionDecoder().decode(bytes);
    const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    if (message.version !== 0 && message.version !== "legacy") {
      throw new Error("unsupported version");
    }
    const feePayer = String(message.staticAccounts[0] ?? "");
    const signers = message.staticAccounts.slice(0, message.header.numSignerAccounts).map(String);
    const programs: string[] = [];
    for (const instruction of message.instructions) {
      const program = message.staticAccounts[instruction.programAddressIndex];
      if (program === undefined) throw new Error("program outside static accounts");
      if (!programs.includes(String(program))) programs.push(String(program));
    }
    return { feePayer, signers, programs };
  } catch (error) {
    if (error instanceof PlatformError) throw error;
    throw new PlatformError("PROVIDER_TRANSACTION_INVALID", "The provider returned an undecodable Solana transaction.", 502);
  }
}

/**
 * Refuses any payload whose fee payer is not the step account or which needs
 * a signature from anyone else.
 */
export function assertSolanaTransactionOwner(base64: string, owner: string): UnsignedSolanaTransactionInfo {
  const info = inspectUnsignedSolanaTransaction(base64);
  if (info.feePayer !== owner || info.signers.length !== 1 || info.signers[0] !== owner) {
    throw new PlatformError(
      "PROVIDER_TRANSACTION_REJECTED",
      "The provider transaction is not fee-paid and signed solely by the step account.",
      502,
    );
  }
  return info;
}

/**
 * Text form of an RPC transaction error. @solana/kit decodes the numbers inside
 * errors (e.g. `InstructionError: [2, { Custom: 1 }]`) as bigint, which plain
 * JSON.stringify refuses to serialise.
 */
export function rpcErrorText(error: unknown): string {
  try {
    const text = JSON.stringify(error, (_key, value: unknown) =>
      typeof value === "bigint" ? (value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= -BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString()) : value);
    return (text ?? "error").slice(0, 200);
  } catch {
    return "Transaction error";
  }
}

/**
 * Simulates an unsigned wire transaction (signature verification off, fresh
 * blockhash). Returns null when the RPC cannot simulate right now.
 */
export async function simulateSolanaTransaction(
  network: SolanaNetworkKey,
  base64: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string } | null> {
  try {
    const result = await solanaRpc(network)
      .simulateTransaction(base64 as Base64EncodedWireTransaction, {
        encoding: "base64",
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: "confirmed",
      })
      .send({ abortSignal: rpcAbortSignal() });
    return result.value.err === null ? { ok: true } : { ok: false, error: rpcErrorText(result.value.err) };
  } catch {
    return null;
  }
}

/**
 * Settles a simulation reported by the Solana module. That module reports any
 * simulation it could not serialise as "Simulation unavailable" (including
 * real instruction errors), so such results are re-simulated here.
 */
export async function confirmSimulation(
  network: SolanaNetworkKey,
  base64: string,
  simulation: { readonly ok: boolean; readonly error: string | null },
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string } | null> {
  if (simulation.ok) return { ok: true };
  if (simulation.error && simulation.error !== "Simulation unavailable") return { ok: false, error: simulation.error };
  return simulateSolanaTransaction(network, base64);
}

export type SolanaLandedStatus = "not_found" | "processed" | "confirmed" | "finalized" | "failed";

export interface SolanaTransactionObservation {
  readonly network: SolanaNetworkKey;
  readonly signature: string;
  readonly status: SolanaLandedStatus;
  readonly error: string | null;
  readonly feePayer: string | null;
  readonly programs: readonly string[];
  readonly blockTime: number | null;
  readonly slot: string | null;
  readonly explorerUrl: string;
  /** Token balance change per `${owner}:${mint}`. */
  readonly tokenDeltas: ReadonlyMap<string, bigint>;
  /** Lamport change per account address. */
  readonly lamportDeltas: ReadonlyMap<string, bigint>;
  /** Transaction fee in lamports (paid by the fee payer); null when unknown. */
  readonly fee: bigint | null;
  /** True when the transaction body could be read (statuses alone are not enough to accept). */
  readonly detailsAvailable: boolean;
}

function toBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/u.test(value)) return BigInt(value);
  return null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

function parseTokenBalances(value: unknown, keys: readonly string[]): Map<string, bigint> {
  const balances = new Map<string, bigint>();
  if (!Array.isArray(value)) return balances;
  for (const entry of value) {
    if (!isRecord(entry) || !isRecord(entry.uiTokenAmount)) continue;
    const mint = typeof entry.mint === "string" ? entry.mint : null;
    const index = typeof entry.accountIndex === "number" ? entry.accountIndex : null;
    const owner = typeof entry.owner === "string" ? entry.owner : index !== null ? keys[index] ?? null : null;
    const amount = toBigInt(entry.uiTokenAmount.amount);
    if (!mint || !owner || amount === null) continue;
    const key = `${owner}:${mint}`;
    balances.set(key, (balances.get(key) ?? 0n) + amount);
  }
  return balances;
}

interface SolanaTransactionDetails {
  readonly feePayer: string | null;
  readonly programs: readonly string[];
  readonly blockTime: number | null;
  readonly tokenDeltas: ReadonlyMap<string, bigint>;
  readonly lamportDeltas: ReadonlyMap<string, bigint>;
  readonly fee: bigint | null;
  readonly executionError: string | null;
}

interface SolanaSignatureRead {
  /** `null` when the signature is unknown to the cluster. */
  readonly confirmation: "processed" | "confirmed" | "finalized" | null;
  readonly statusError: string | null;
  readonly slot: string | null;
  /** Parsed transaction body; null when not (yet) readable. */
  readonly details: SolanaTransactionDetails | null;
}

/** Reads a signature's status and, once confirmed, its body and balance deltas. */
async function readSolanaSignature(network: SolanaNetworkKey, signatureValue: string): Promise<SolanaSignatureRead> {
  const rpc = solanaRpc(network);
  const sig = toSignature(signatureValue);
  const statuses = await rpc
    .getSignatureStatuses([sig], { searchTransactionHistory: true })
    .send({ abortSignal: rpcAbortSignal() });
  const status = statuses.value[0];
  if (!status) return { confirmation: null, statusError: null, slot: null, details: null };
  const slot = status.slot.toString();
  const statusError = status.err ? rpcErrorText(status.err) : null;
  const confirmation = status.confirmationStatus === "finalized" ? "finalized" : status.confirmationStatus === "confirmed" ? "confirmed" : "processed";
  if (!statusError && confirmation === "processed") return { confirmation, statusError, slot, details: null };
  const raw: unknown = await rpc
    .getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed", encoding: "json" })
    .send({ abortSignal: rpcAbortSignal() })
    .catch(() => null);
  if (!isRecord(raw) || !isRecord(raw.transaction) || !isRecord(raw.transaction.message) || !isRecord(raw.meta)) {
    return { confirmation, statusError, slot, details: null };
  }
  const message = raw.transaction.message;
  const meta = raw.meta;
  const staticKeys = stringList(message.accountKeys);
  const loaded = isRecord(meta.loadedAddresses) ? meta.loadedAddresses : {};
  const keys = [...staticKeys, ...stringList(loaded.writable), ...stringList(loaded.readonly)];
  const programs: string[] = [];
  if (Array.isArray(message.instructions)) {
    for (const instruction of message.instructions) {
      if (!isRecord(instruction) || typeof instruction.programIdIndex !== "number") continue;
      const program = staticKeys[instruction.programIdIndex];
      if (program && !programs.includes(program)) programs.push(program);
    }
  }
  const pre = parseTokenBalances(meta.preTokenBalances, keys);
  const post = parseTokenBalances(meta.postTokenBalances, keys);
  const tokenDeltas = new Map<string, bigint>();
  for (const key of new Set([...pre.keys(), ...post.keys()])) {
    tokenDeltas.set(key, (post.get(key) ?? 0n) - (pre.get(key) ?? 0n));
  }
  const lamportDeltas = new Map<string, bigint>();
  if (Array.isArray(meta.preBalances) && Array.isArray(meta.postBalances)) {
    keys.forEach((key, index) => {
      const before = toBigInt((meta.preBalances as unknown[])[index]);
      const after = toBigInt((meta.postBalances as unknown[])[index]);
      if (before !== null && after !== null) lamportDeltas.set(key, (lamportDeltas.get(key) ?? 0n) + after - before);
    });
  }
  const blockTime = toBigInt(raw.blockTime);
  return {
    confirmation,
    statusError,
    slot,
    details: {
      feePayer: staticKeys[0] ?? null,
      programs,
      blockTime: blockTime === null ? null : Number(blockTime),
      tokenDeltas,
      lamportDeltas,
      fee: toBigInt(meta.fee),
      executionError: meta.err !== null && meta.err !== undefined ? rpcErrorText(meta.err) : null,
    },
  };
}

/**
 * Observes a submitted signature. A landed transaction from another fee payer
 * is reported as `failed` so it can never advance a step; a transaction whose
 * body cannot be read is never reported as confirmed.
 */
export async function observeSolanaTransaction(
  network: SolanaNetworkKey,
  signatureValue: string,
  expectedFeePayer: string,
): Promise<SolanaTransactionObservation> {
  if (!isSolanaSignature(signatureValue)) {
    throw new PlatformError("REFERENCE_INVALID", "A valid Solana transaction signature is required.", 400);
  }
  if (!isSolanaAddress(expectedFeePayer)) {
    throw new PlatformError("ACCOUNT_INVALID", "The step account is not a Solana address.", 500);
  }
  const read = await readSolanaSignature(network, signatureValue);
  const base = {
    network,
    signature: signatureValue,
    explorerUrl: explorerTxUrl(network, signatureValue),
    slot: read.slot,
  };
  const empty = {
    feePayer: null,
    programs: [],
    blockTime: null,
    tokenDeltas: new Map<string, bigint>(),
    lamportDeltas: new Map<string, bigint>(),
    fee: null,
    detailsAvailable: false,
  };
  if (read.confirmation === null) return { ...base, ...empty, status: "not_found", error: null };
  const details = read.details;
  if (!details) {
    // Confirmed (or failed) per status, but the body is not readable yet: report it unconfirmed.
    return { ...base, ...empty, status: read.statusError ? "failed" : "processed", error: read.statusError };
  }
  const payerMismatch = details.feePayer !== expectedFeePayer;
  const landed: SolanaLandedStatus = read.confirmation === "finalized" ? "finalized" : "confirmed";
  return {
    ...base,
    status: details.executionError || read.statusError || payerMismatch ? "failed" : landed,
    error: payerMismatch
      ? "Transaction fee payer does not match the step account."
      : details.executionError ?? read.statusError,
    feePayer: details.feePayer,
    programs: details.programs,
    blockTime: details.blockTime,
    tokenDeltas: details.tokenDeltas,
    lamportDeltas: details.lamportDeltas,
    fee: details.fee,
    detailsAvailable: true,
  };
}

/** Destination-side check for solver fills: the signature landed without error. */
export async function readSolanaSignatureStatus(
  network: SolanaNetworkKey,
  signatureValue: string,
): Promise<"success" | "failed" | "not_found" | "processed"> {
  if (!isSolanaSignature(signatureValue)) return "not_found";
  const statuses = await solanaRpc(network)
    .getSignatureStatuses([toSignature(signatureValue)], { searchTransactionHistory: true })
    .send({ abortSignal: rpcAbortSignal() });
  const status = statuses.value[0];
  if (!status) return "not_found";
  if (status.err) return "failed";
  return status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized" ? "success" : "processed";
}

/**
 * Destination-side evidence for a solver fill on Solana: the signature landed
 * without error and credited `owner` (SPL `mint`, or lamports plus wrapped SOL
 * when `mint` is null). `credited` is null when the body is not readable yet.
 */
export async function readSolanaCredit(
  network: SolanaNetworkKey,
  signatureValue: string,
  owner: string,
  mint: string | null,
): Promise<{ readonly status: "success" | "failed" | "pending"; readonly credited: bigint | null }> {
  if (!isSolanaSignature(signatureValue) || !isSolanaAddress(owner)) return { status: "pending", credited: null };
  const read = await readSolanaSignature(network, signatureValue);
  if (read.confirmation === null || read.confirmation === "processed") return { status: "pending", credited: null };
  if (read.statusError || read.details?.executionError) return { status: "failed", credited: null };
  if (!read.details) return { status: "pending", credited: null };
  const credited = mint === null
    ? (read.details.lamportDeltas.get(owner) ?? 0n) + (read.details.tokenDeltas.get(`${owner}:${WRAPPED_SOL_MINT}`) ?? 0n)
    : (read.details.tokenDeltas.get(`${owner}:${mint}`) ?? 0n);
  return { status: "success", credited };
}
