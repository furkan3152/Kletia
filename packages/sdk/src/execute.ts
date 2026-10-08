import {
  CHAINS,
  normalizeAddress,
  parseAccountId,
  type IntentGraph,
  type IntentStatus,
  type IntentStep,
  type StepStatus,
  type TransactionRequest,
} from "@kletia/core";
import type { KletiaClient } from "./client.js";
import { KletiaApiError, KletiaExecutionError } from "./errors.js";
import type { EvmSigner, SolanaSigner } from "./signers.js";
import type { PreparedStep } from "./types.js";

export interface IntentSigners {
  readonly evm?: EvmSigner;
  readonly solana?: SolanaSigner;
}

export interface ExecuteIntentOptions {
  /** Called whenever Kletia returns a newer version of the intent. */
  readonly onUpdate?: (intent: IntentGraph) => void;
  /** Called before the wallet is asked to sign a step. Return false to stop. */
  readonly beforeStep?: (step: IntentStep, intent: IntentGraph) => boolean | Promise<boolean>;
  readonly signal?: AbortSignal;
  /** Poll interval while cross-network steps settle (default 4000 ms). */
  readonly pollIntervalMs?: number;
  /** Overall deadline (default 20 minutes). */
  readonly timeoutMs?: number;
  /**
   * References an earlier run broadcast but could not report, by step id
   * (`KletiaExecutionError.references`). They are submitted instead of
   * preparing that step again, so the wallet never signs it twice.
   */
  readonly pendingReferences?: Readonly<Record<string, readonly string[]>>;
}

const TERMINAL: readonly IntentStatus[] = [
  "completed",
  "partially_completed",
  "failed",
  "expired",
  "cancelled",
];

/** Attempts per submit while the API error is retryable (network, timeout, 429, 5xx). */
const SUBMIT_ATTEMPTS = 3;
const SUBMIT_BACKOFF_MS = 1_000;
const MAX_RETRY_AFTER_MS = 60_000;
const APPROVE_SELECTOR = "0x095ea7b3";

/**
 * References broadcast for a step that Kletia has not accepted yet, per
 * `intentId:stepId`. While an entry exists `executeIntent` resubmits it and
 * never prepares (and so never signs) that step again; it is removed once
 * a submit succeeds or Kletia shows the step's references accepted.
 */
const unsubmitted = new Map<string, readonly string[]>();
const unsubmittedKey = (intentId: string, stepId: string) => `${intentId}:${stepId}`;

/** Step states that mean Kletia accepted references for the step. */
const ACCEPTED: readonly StepStatus[] = ["submitted", "confirmed", "settling", "settled", "indeterminate"];

/**
 * Drops held references once a fresh response from Kletia shows it accepted
 * references for the step (never on the caller's possibly stale intent).
 */
function forgetAccepted(intent: IntentGraph): void {
  for (const step of intent.steps) {
    if (ACCEPTED.includes(step.status)) unsubmitted.delete(unsubmittedKey(intent.id, step.id));
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("Aborted"));
      },
      { once: true },
    );
  });

function signerAddressMatches(step: IntentStep, address: string): boolean {
  const account = parseAccountId(step.account);
  if (!account) return false;
  return (
    normalizeAddress(account.chain.namespace, account.address) ===
    normalizeAddress(account.chain.namespace, address)
  );
}

/**
 * A prepared transaction must belong to the step it was prepared for: same VM,
 * network and EVM chain, sent or fee-paid by the step account. Anything else
 * is refused before a wallet sees it.
 */
function transactionBindingProblem(step: IntentStep, transaction: TransactionRequest): string | null {
  const chain = CHAINS[step.network];
  const expectedVm = chain.vm === "evm" ? "evm" : "svm";
  if (transaction.vm !== expectedVm || transaction.network !== step.network) {
    return `a ${transaction.vm} transaction on ${transaction.network} does not belong to a ${chain.name} step`;
  }
  if (transaction.vm === "evm" && transaction.chainId !== chain.evmChainId) {
    return `chain ${transaction.chainId} does not match ${chain.name}`;
  }
  const sender = transaction.vm === "evm" ? transaction.from : transaction.feePayer;
  if (!signerAddressMatches(step, sender)) return `it is not sent by ${step.account}`;
  return null;
}

/** An ERC-20 approval moves no funds, so signing it again is harmless. */
function isTokenApproval(transaction: TransactionRequest): boolean {
  return (
    transaction.vm === "evm" &&
    transaction.data.slice(0, 10).toLowerCase() === APPROVE_SELECTOR &&
    /^0*$/u.test(transaction.value)
  );
}

/**
 * Local deadline (ms) for signing a prepared payload. `expiresAt` is server
 * time, so the TTL is measured on the server's clock (`expiresAt` minus the
 * step's `preparedAt`) and applied from when prepare was requested; a device
 * clock that is off does not expire every payload.
 */
function signingDeadline(prepared: PreparedStep, stepId: string, requestedAt: number): number {
  const preparedAt = prepared.intent.steps.find((candidate) => candidate.id === stepId)?.prepared?.preparedAt;
  const issuedAt = preparedAt ? Date.parse(preparedAt) : Number.NaN;
  // Without the server's prepare time, fall back to the absolute timestamp.
  if (Number.isNaN(issuedAt)) return prepared.payload.expiresAt * 1000;
  return requestedAt + (prepared.payload.expiresAt * 1000 - issuedAt);
}

/**
 * Submits references, retrying a bounded number of times while the API error
 * is retryable. Resubmitting identical references is idempotent on the
 * server, so a retry after a lost response is safe.
 */
async function submitWithRetry(
  client: KletiaClient,
  intentId: string,
  stepId: string,
  references: readonly string[],
  signal?: AbortSignal,
): Promise<IntentGraph> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await client.intents.submitStep(intentId, stepId, references);
    } catch (error) {
      if (!(error instanceof KletiaApiError) || !error.retryable || attempt >= SUBMIT_ATTEMPTS) throw error;
      const delay =
        error.retryAfterSeconds !== null
          ? Math.min(error.retryAfterSeconds * 1000, MAX_RETRY_AFTER_MS)
          : SUBMIT_BACKOFF_MS * 2 ** (attempt - 1);
      // Stopped while waiting: report the submit failure, not the abort.
      await sleep(delay, signal).catch(() => {
        throw error;
      });
    }
  }
}

/** Submits references the wallet already broadcast; on failure the error carries them. */
async function submitBroadcast(
  client: KletiaClient,
  intentId: string,
  stepId: string,
  references: readonly string[],
  signal?: AbortSignal,
): Promise<IntentGraph> {
  try {
    const next = await submitWithRetry(client, intentId, stepId, references, signal);
    unsubmitted.delete(unsubmittedKey(intentId, stepId));
    return next;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Kletia did not respond.";
    throw new KletiaExecutionError(
      `Transactions for step ${stepId} were broadcast but could not be reported to Kletia (${reason}). Resubmit error.references instead of signing again; executeIntent does this on its next run.`,
      intentId,
      stepId,
      error,
      references,
    );
  }
}

async function executeStep(
  client: KletiaClient,
  intent: IntentGraph,
  step: IntentStep,
  signers: IntentSigners,
  signal?: AbortSignal,
): Promise<IntentGraph> {
  const key = unsubmittedKey(intent.id, step.id);
  const held = unsubmitted.get(key);
  // Already broadcast: report it, never prepare and sign the step again.
  if (held) return submitBroadcast(client, intent.id, step.id, held, signal);
  const vm = CHAINS[step.network].vm;
  const signer = vm === "evm" ? signers.evm : signers.solana;
  if (!signer) {
    throw new KletiaExecutionError(
      `Step ${step.id} needs a ${vm === "evm" ? "EVM" : "Solana"} wallet.`,
      intent.id,
      step.id,
    );
  }
  if (!signerAddressMatches(step, signer.address)) {
    throw new KletiaExecutionError(
      `Step ${step.id} is bound to ${step.account}; the connected wallet is different.`,
      intent.id,
      step.id,
    );
  }
  const requestedAt = Date.now();
  const prepared = await client.intents.prepareStep(intent.id, step.id);
  const { payload } = prepared;
  const deadline = signingDeadline(prepared, step.id, requestedAt);
  for (const [index, transaction] of payload.transactions.entries()) {
    const problem = transactionBindingProblem(step, transaction);
    if (problem) {
      throw new KletiaExecutionError(`Refused to sign transaction ${index + 1} of step ${step.id}: ${problem}.`, intent.id, step.id);
    }
  }
  const references: string[] = [];
  for (const transaction of payload.transactions) {
    try {
      // Stopping between prepare and a wallet prompt must never open the prompt.
      if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
      if (Date.now() > deadline) throw new Error("Prepared transactions expired before signing.");
      if (transaction.vm === "evm") {
        const evm = signers.evm as EvmSigner;
        const hash = await evm.sendTransaction(transaction);
        references.push(hash);
        await evm.waitForTransaction(hash, transaction.chainId);
      } else {
        const solana = signers.solana as SolanaSigner;
        references.push(await solana.signAndSendTransaction(transaction));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Wallet rejected the transaction.";
      if (references.length === 0) throw new KletiaExecutionError(message, intent.id, step.id, error);
      // Something already landed. Unless it is only approvals of a step that
      // stopped part-way, hold it so the step is never signed again.
      const broadcast = payload.transactions.slice(0, references.length);
      const hold = references.length === payload.transactions.length || !broadcast.every(isTokenApproval);
      if (hold) unsubmitted.set(key, [...references]);
      // Report what already landed so Kletia can recover the step state.
      let reported = false;
      try {
        await submitWithRetry(client, intent.id, step.id, references, signal);
        unsubmitted.delete(key);
        reported = true;
      } catch {
        // Kept on the error (and held above) for the caller to resubmit.
      }
      throw new KletiaExecutionError(
        message,
        intent.id,
        step.id,
        error,
        reported || !hold ? undefined : [...references],
      );
    }
  }
  unsubmitted.set(key, [...references]);
  return submitBroadcast(client, intent.id, step.id, references, signal);
}

/**
 * Drive an intent to a terminal state: prepare each ready step, have the
 * matching wallet sign it, submit the references for on-chain verification
 * and wait for cross-network settlement before unlocking dependent steps.
 */
export async function executeIntent(
  client: KletiaClient,
  intentOrId: IntentGraph | string,
  signers: IntentSigners,
  options: ExecuteIntentOptions = {},
): Promise<IntentGraph> {
  const pollIntervalMs = options.pollIntervalMs ?? 4_000;
  const deadline = Date.now() + (options.timeoutMs ?? 20 * 60_000);
  let intent = typeof intentOrId === "string" ? await client.intents.get(intentOrId) : intentOrId;
  for (const [stepId, references] of Object.entries(options.pendingReferences ?? {})) {
    if (references.length > 0) unsubmitted.set(unsubmittedKey(intent.id, stepId), [...references]);
  }
  if (typeof intentOrId === "string") forgetAccepted(intent);
  options.onUpdate?.(intent);
  while (!TERMINAL.includes(intent.status)) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("Aborted");
    if (Date.now() > deadline) throw new Error(`Intent ${intent.id} did not finish before the deadline.`);
    const ready = intent.steps.filter((step) => step.status === "ready" || step.status === "awaiting_signature");
    if (ready.length > 0) {
      const step = ready[0] as IntentStep;
      if (options.beforeStep && !(await options.beforeStep(step, intent))) return intent;
      intent = await executeStep(client, intent, step, signers, options.signal);
      forgetAccepted(intent);
      options.onUpdate?.(intent);
      continue;
    }
    const inFlight = intent.steps.some(
      (step) =>
        step.status === "submitted" ||
        step.status === "confirmed" ||
        step.status === "settling" ||
        step.status === "indeterminate",
    );
    if (!inFlight) return intent;
    await sleep(pollIntervalMs, options.signal);
    intent = await client.intents.refresh(intent.id);
    forgetAccepted(intent);
    options.onUpdate?.(intent);
  }
  return intent;
}
