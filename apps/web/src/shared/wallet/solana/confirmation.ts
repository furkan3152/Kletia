import {
  CHAINS,
  explorerTxUrl,
  isSolanaAddress,
  isSolanaSignature,
  type NetworkKey,
} from "@kletia/core";

import { BACKEND_URL } from "../../config/runtime";

export type SolanaConfirmationStatus =
  | "not_found"
  | "processed"
  | "confirmed"
  | "finalized"
  | "failed";

export interface SolanaConfirmationEvidence {
  readonly network: NetworkKey;
  readonly signature: string;
  readonly status: "confirmed" | "finalized";
  readonly slot: string | null;
  readonly feeLamports: string | null;
  readonly explorerUrl: string;
  readonly observedAt: string;
}

export interface WaitForConfirmationOptions {
  /** Upper bound for the wait; defaults to ~90 s, the blockhash validity window. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onLog?: (line: string) => void;
}

export class SolanaConfirmationError extends Error {
  readonly code: "TRANSACTION_FAILED" | "NOT_OBSERVED" | "SIGNER_MISMATCH" | "ABORTED";
  readonly signature: string;
  /** Last status Kletia observed before giving up (null when never seen). */
  readonly lastStatus: SolanaConfirmationStatus | null;
  constructor(
    code: SolanaConfirmationError["code"],
    message: string,
    signature: string,
    lastStatus: SolanaConfirmationStatus | null = null,
  ) {
    super(message);
    this.name = "SolanaConfirmationError";
    this.code = code;
    this.signature = signature;
    this.lastStatus = lastStatus;
  }
}

const STATUSES: readonly SolanaConfirmationStatus[] = [
  "not_found",
  "processed",
  "confirmed",
  "finalized",
  "failed",
];

interface RawEvidence {
  status: SolanaConfirmationStatus;
  slot: string | null;
  error: string | null;
  feeLamports: string | null;
  signer: string | null;
  explorerUrl: string | null;
}

function readEvidence(body: unknown, signature: string): RawEvidence | null {
  if (!body || typeof body !== "object") return null;
  const envelope = body as { success?: unknown; evidence?: unknown };
  if (envelope.success !== true || !envelope.evidence || typeof envelope.evidence !== "object") {
    return null;
  }
  const evidence = envelope.evidence as Record<string, unknown>;
  if (
    evidence.signature !== signature ||
    !STATUSES.includes(evidence.status as SolanaConfirmationStatus)
  ) {
    return null;
  }
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  return {
    status: evidence.status as SolanaConfirmationStatus,
    slot: text(evidence.slot),
    error: text(evidence.error),
    feeLamports: text(evidence.feeLamports),
    signer: text(evidence.signer),
    explorerUrl:
      typeof evidence.explorerUrl === "string" && evidence.explorerUrl.startsWith("https://")
        ? evidence.explorerUrl
        : null,
  };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = window.setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });

/**
 * Poll Kletia's Solana evidence endpoint until the signature is observed at
 * `confirmed` or `finalized` commitment from the expected fee payer. A
 * signature that fails, lands from another signer or is not observed inside
 * the blockhash validity window resolves to a clear error. Never resubmits.
 */
export async function waitForSolanaConfirmation(
  signature: string,
  network: NetworkKey,
  signer: string,
  options: WaitForConfirmationOptions = {},
): Promise<SolanaConfirmationEvidence> {
  if (CHAINS[network].vm !== "svm") throw new Error(`${network} is not a Solana network.`);
  if (!isSolanaSignature(signature)) throw new Error("Invalid Solana transaction signature.");
  if (!isSolanaAddress(signer)) throw new Error("Invalid Solana signer address.");
  const timeoutMs = options.timeoutMs ?? 90_000;
  const startedAt = Date.now();
  let attempt = 0;
  let lastStatus: SolanaConfirmationStatus | null = null;
  const url = `${BACKEND_URL}/api/solana/tx/${encodeURIComponent(signature)}?network=${encodeURIComponent(network)}&signer=${encodeURIComponent(signer)}`;

  while (Date.now() - startedAt < timeoutMs) {
    if (options.signal?.aborted) {
      throw new SolanaConfirmationError("ABORTED", "Confirmation tracking was stopped.", signature);
    }
    attempt += 1;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 10_000);
    const forwardAbort = () => controller.abort();
    options.signal?.addEventListener("abort", forwardAbort, { once: true });
    let evidence: RawEvidence | null;
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      evidence = readEvidence(await response.json().catch(() => null), signature);
    } catch {
      evidence = null;
    } finally {
      window.clearTimeout(timer);
      options.signal?.removeEventListener("abort", forwardAbort);
    }

    if (evidence && evidence.status !== lastStatus) {
      lastStatus = evidence.status;
      options.onLog?.(`Solana status: ${evidence.status.replace("_", " ")}.`);
    }
    if (evidence?.status === "failed") {
      const mismatch = evidence.signer !== null && evidence.signer !== signer;
      throw new SolanaConfirmationError(
        mismatch ? "SIGNER_MISMATCH" : "TRANSACTION_FAILED",
        mismatch
          ? "The landed transaction was not paid by the connected account."
          : `The transaction failed on-chain${evidence.error ? `: ${evidence.error.slice(0, 160)}` : "."}`,
        signature,
        "failed",
      );
    }
    if (evidence && (evidence.status === "confirmed" || evidence.status === "finalized")) {
      return {
        network,
        signature,
        status: evidence.status,
        slot: evidence.slot,
        feeLamports: evidence.feeLamports,
        explorerUrl: evidence.explorerUrl ?? explorerTxUrl(network, signature),
        observedAt: new Date().toISOString(),
      };
    }
    // Poll quickly while the transaction is fresh, then back off to stay well
    // inside the Solana endpoint's rate limit.
    await sleep(attempt < 5 ? 2_000 : 4_000, options.signal).catch(() => {
      throw new SolanaConfirmationError("ABORTED", "Confirmation tracking was stopped.", signature);
    });
  }

  throw new SolanaConfirmationError(
    "NOT_OBSERVED",
    lastStatus === "processed"
      ? "The transaction was processed but not confirmed within the blockhash validity window. Check the explorer before trying again."
      : "The transaction was not observed on-chain within the blockhash validity window, so it can no longer land. Prepare a new transaction to try again.",
    signature,
    lastStatus,
  );
}
