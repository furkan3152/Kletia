import { isSolanaError, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_UNSUPPORTED_TRANSACTION_VERSION, signature as toSignature } from "@solana/kit";
import { explorerTxUrl, isSolanaAddress, isSolanaSignature } from "@kletia/core";
import type { SolanaNetworkKey } from "./config.js";
import { SolanaProviderError, describeRpcError } from "./http.js";
import { rpcAbortSignal, solanaRpc } from "./rpc.js";

/**
 * Newest transaction version the landed-transaction readers understand. RPCs
 * refuse (`-32015`) to return a transaction newer than the version a request
 * names, and version 1 transactions are common on mainnet (live 2026-10-09:
 * 898 of 1,902 non-vote transactions in five blocks). Their json body
 * (`accountKeys`, `header`, `instructions`, `recentBlockhash`, plus
 * `transactionConfig`; no lookup tables) is read like legacy and v0 bodies.
 */
export const SOLANA_MAX_SUPPORTED_TRANSACTION_VERSION = 1;

/** True when the RPC refused a transaction because it is newer than the requested version (`-32015`). */
export function isUnsupportedTransactionVersion(error: unknown): boolean {
  return isSolanaError(error, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_UNSUPPORTED_TRANSACTION_VERSION);
}

const warnedVersions = new Set<string>();

/**
 * Logs once per signature that a landed transaction cannot be read because
 * its version is newer than SOLANA_MAX_SUPPORTED_TRANSACTION_VERSION. Callers
 * keep such a transaction unconfirmed (never failed: it may have succeeded).
 */
export function warnUnsupportedTransactionVersion(network: string, signatureValue: string): void {
  if (warnedVersions.has(signatureValue)) return;
  if (warnedVersions.size >= 1_000) warnedVersions.clear();
  warnedVersions.add(signatureValue);
  console.warn(
    `[solana] ${network} transaction ${signatureValue} uses a transaction version newer than ${SOLANA_MAX_SUPPORTED_TRANSACTION_VERSION}; its body cannot be read, so it stays unconfirmed.`,
  );
}

export type SolanaConfirmationStatus = "not_found" | "processed" | "confirmed" | "finalized" | "failed";

export interface SolanaTransactionEvidence {
  readonly network: SolanaNetworkKey;
  readonly signature: string;
  readonly status: SolanaConfirmationStatus;
  readonly slot: string | null;
  readonly error: string | null;
  readonly feeLamports: string | null;
  readonly signer: string | null;
  readonly blockTime: number | null;
  readonly explorerUrl: string;
  readonly observedAt: string;
}

/**
 * Reads a signature's status and, once landed, its fee payer. When
 * `expectedSigner` is given, a landed transaction from another fee payer is
 * reported as failed evidence rather than accepted, and one whose body cannot
 * be read yet stays `processed` until its fee payer can be checked.
 */
export async function verifySolanaTransaction(
  network: SolanaNetworkKey,
  signatureValue: string,
  expectedSigner?: string,
): Promise<SolanaTransactionEvidence> {
  if (!isSolanaSignature(signatureValue)) {
    throw new SolanaProviderError("A valid Solana transaction signature is required.", "SOLANA_SIGNATURE_INVALID", 400);
  }
  if (expectedSigner !== undefined && !isSolanaAddress(expectedSigner)) {
    throw new SolanaProviderError("Expected signer must be a Solana address.", "SOLANA_ADDRESS_INVALID", 400);
  }
  const rpc = solanaRpc(network);
  const sig = toSignature(signatureValue);
  const base = {
    network,
    signature: signatureValue,
    explorerUrl: explorerTxUrl(network, signatureValue),
    observedAt: new Date().toISOString(),
  };
  const statuses = await rpc
    .getSignatureStatuses([sig], { searchTransactionHistory: true })
    .send({ abortSignal: rpcAbortSignal() });
  const status = statuses.value[0];
  if (!status) {
    return { ...base, status: "not_found", slot: null, error: null, feeLamports: null, signer: null, blockTime: null };
  }
  const landedStatus: SolanaConfirmationStatus = status.err
    ? "failed"
    : (status.confirmationStatus ?? "processed");
  if (landedStatus === "processed") {
    return {
      ...base,
      status: "processed",
      slot: status.slot.toString(),
      error: null,
      feeLamports: null,
      signer: null,
      blockTime: null,
    };
  }
  const transaction = await rpc
    .getTransaction(sig, { maxSupportedTransactionVersion: SOLANA_MAX_SUPPORTED_TRANSACTION_VERSION, commitment: "confirmed", encoding: "json" })
    .send({ abortSignal: rpcAbortSignal() })
    .catch((error: unknown) => {
      // A body that cannot be read (yet) leaves the fee payer unknown; a version refusal is logged, not swallowed.
      if (isUnsupportedTransactionVersion(error)) warnUnsupportedTransactionVersion(network, signatureValue);
      return null;
    });
  const signer = transaction ? String(transaction.transaction.message.accountKeys[0] ?? "") || null : null;
  const signerMismatch = expectedSigner !== undefined && signer !== null && signer !== expectedSigner;
  // Without the body the fee payer is unknown: never report it confirmed for an expected signer.
  const signerUnchecked = expectedSigner !== undefined && signer === null && landedStatus !== "failed";
  return {
    ...base,
    status: signerMismatch ? "failed" : signerUnchecked ? "processed" : landedStatus,
    slot: status.slot.toString(),
    error: signerMismatch
      ? "Transaction fee payer does not match the bound account."
      : status.err
        ? describeRpcError(status.err)
        : null,
    feeLamports: transaction?.meta ? transaction.meta.fee.toString() : null,
    signer,
    blockTime: transaction?.blockTime === null || transaction?.blockTime === undefined ? null : Number(transaction.blockTime),
  };
}
