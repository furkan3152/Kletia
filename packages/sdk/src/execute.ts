import {
  CHAINS,
  normalizeAddress,
  parseAccountId,
  parseAssetId,
  type ContractReview,
  type ContractStepCall,
  type EvmTransactionRequest,
  type IntentGraph,
  type IntentStatus,
  type IntentStep,
  type StepExecutionPayload,
  type StepStatus,
  type TransactionRequest,
} from "@kletia/core";
import type { KletiaClient } from "./client.js";
import { KletiaApiError, KletiaExecutionError } from "./errors.js";
import { newIdempotencyKey } from "./retry.js";
import type { EvmSigner, SolanaSigner } from "./signers.js";
import type { PreparedStep, StepReviewContext } from "./types.js";
import { TERMINAL_INTENT_STATUSES } from "./watch.js";

export interface IntentSigners {
  readonly evm?: EvmSigner;
  readonly solana?: SolanaSigner;
}

export interface ExecuteIntentOptions {
  /** Called whenever Kletia returns a newer version of the intent. */
  readonly onUpdate?: (intent: IntentGraph) => void;
  /** Called before the wallet is asked to sign a step. Return false to stop. */
  readonly beforeStep?: (step: IntentStep, intent: IntentGraph) => boolean | Promise<boolean>;
  /**
   * Custom-contract steps (`call` / `action`): called after prepare and before
   * any wallet prompt with the review of exactly the prepared transactions
   * (integrator, decoded call, approvals, simulated asset changes, "Not
   * audited by Kletia"). Show it to the user and resolve `true` only once
   * they confirmed; anything else stops without signing and `executeIntent`
   * returns the intent. Required for those steps: without it they are
   * refused before prepare. A review whose simulation is not `ok`, or that
   * does not match the prepared transactions, is refused before this runs.
   */
  readonly onReview?: (step: IntentStep, review: ContractReview, context: StepReviewContext) => boolean | Promise<boolean>;
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

const TERMINAL: readonly IntentStatus[] = TERMINAL_INTENT_STATUSES;

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

/** Steps that run integrator code (custom contracts): their review must be confirmed before signing. */
function isContractStep(step: IntentStep): boolean {
  return (
    step.kind === "call" ||
    step.kind === "action" ||
    step.call !== undefined ||
    step.protocol === "custom-call" ||
    step.protocol === "solana-actions"
  );
}

function contractStepName(step: IntentStep): string {
  const call = step.call;
  if (!call) return `Step ${step.id} runs a custom contract`;
  return `Step ${step.id} runs ${call.label ?? call.entry} by ${call.integrator.name}, a custom contract Kletia has not audited`;
}

/** Decimal or hex integer string as bigint; null when it is not one. */
function integer(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^(?:\d{1,78}|0x[0-9a-f]{1,64})$/iu.test(value)) return null;
  return BigInt(value);
}

const APPROVE_CALL = /^0x095ea7b3(0{24}[0-9a-f]{40})([0-9a-f]{64})$/iu;

/** `approve(spender, amount)` calldata, exactly; null for anything else. */
function decodeApprove(data: string): { readonly spender: string; readonly amount: bigint } | null {
  const match = APPROVE_CALL.exec(data);
  if (!match) return null;
  return { spender: `0x${(match[1] as string).slice(24)}`.toLowerCase(), amount: BigInt(`0x${match[2] as string}`) };
}

function erc20Address(asset: string | undefined): string | null {
  const parsed = parseAssetId(asset);
  return parsed && parsed.assetNamespace === "erc20" ? parsed.reference.toLowerCase() : null;
}

/**
 * The prepared EVM transactions of a call step must be what the review shows
 * and the registration pins (the API guards the same, §4.6 of the design):
 * at most an allowance reset and one exact approval of the step input to the
 * pinned spender, then one call to the pinned target with the registered
 * selector and the reviewed value.
 */
function evmCallProblem(step: IntentStep, call: ContractStepCall, review: ContractReview, transactions: readonly TransactionRequest[]): string | null {
  const evm = transactions.filter((transaction): transaction is EvmTransactionRequest => transaction.vm === "evm");
  if (evm.length !== transactions.length || evm.length < 1 || evm.length > 3) {
    return `a contract call step signs one to three EVM transactions, not ${transactions.length}`;
  }
  const target = call.target.toLowerCase();
  if (!review.contract || review.contract.address.toLowerCase() !== target) return "the review shows a different contract than the step calls";
  const last = evm[evm.length - 1] as EvmTransactionRequest;
  if (last.to.toLowerCase() !== target) return `the last transaction is not sent to the registered contract ${call.target}`;
  if (!call.selector || last.data.slice(0, 10).toLowerCase() !== call.selector.toLowerCase()) {
    return `the call is not the registered function ${call.function ?? ""}`.trimEnd();
  }
  const value = integer(last.value);
  const reviewedValue = review.call?.value ? integer(review.call.value.amount) : 0n;
  if (value === null || reviewedValue === null || value !== reviewedValue) return "the call sends a different value than the review shows";
  if (value > 0n) {
    const cap = call.value ? integer(call.value.max) : null;
    if (cap === null || value > cap) return "the call sends more value than the registration allows";
  }
  const approvals = evm.slice(0, -1);
  const spender = call.approvalSpender?.toLowerCase();
  const token = erc20Address(step.input?.asset);
  const amounts: bigint[] = [];
  for (const [index, transaction] of approvals.entries()) {
    const decoded = decodeApprove(transaction.data);
    if (!decoded || integer(transaction.value) !== 0n) return `transaction ${index + 1} is not a token approval`;
    if (!spender || decoded.spender !== spender) return `transaction ${index + 1} approves a spender the registration does not pin`;
    if (!token || transaction.to.toLowerCase() !== token) return `transaction ${index + 1} approves a token other than the step input`;
    amounts.push(decoded.amount);
  }
  // [] | [exact] | [reset to 0, exact]
  const exact = amounts.at(-1);
  if (amounts.length === 2 && amounts[0] !== 0n) return "only an allowance reset may precede the approval";
  if (exact === 0n) return "the approval sets no allowance";
  if (review.approvals.length !== (exact === undefined ? 0 : 1)) return "the approvals differ from the review";
  if (exact !== undefined) {
    const shown = review.approvals[0];
    if (!shown || shown.spender.toLowerCase() !== spender || erc20Address(shown.token.asset) !== token || integer(shown.amount.amount) !== exact) {
      return "the approval differs from the one the review shows";
    }
  }
  return null;
}

/** Why the prepared payload of a step with a review cannot be signed; null when it can. */
function reviewProblem(step: IntentStep, payload: StepExecutionPayload): string | null {
  const review = payload.review;
  if (!review) return "Kletia returned no review for this custom-contract step";
  const vm = CHAINS[step.network].vm;
  if (review.kind !== (vm === "evm" ? "evm-call" : "solana-action")) return `the review (${String(review.kind)}) does not belong to a ${CHAINS[step.network].name} step`;
  if (review.simulation?.status !== "ok") return "the transactions could not be simulated, so there is nothing reliable to review";
  if (!Array.isArray(review.notices) || review.notices.length === 0) return "the review carries no notices";
  if (!isContractStep(step)) return null;
  const call = step.call;
  if (!call || call.vm !== (vm === "evm" ? "evm" : "svm")) return "the step carries no contract snapshot";
  if (vm === "evm") return evmCallProblem(step, call, review, payload.transactions);
  return payload.transactions.length === 1 ? null : `a Solana Action step signs one transaction, not ${payload.transactions.length}`;
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
  // One Idempotency-Key for every attempt (keyed clients only; the public tier
  // refuses the header): a retry after a lost response replays the first
  // answer. The bounded loop here replaces the client's own retries.
  const idempotencyKey = client.hasApiKey ? newIdempotencyKey() : null;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await client.intents.submitStep(intentId, stepId, references, {
        maxRetries: 0,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
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

/** Outcome of one step: the newest intent, and whether the review hook declined to sign. */
interface StepOutcome {
  readonly intent: IntentGraph;
  readonly declined: boolean;
}

async function executeStep(
  client: KletiaClient,
  intent: IntentGraph,
  step: IntentStep,
  signers: IntentSigners,
  options: Pick<ExecuteIntentOptions, "onReview" | "signal">,
): Promise<StepOutcome> {
  const { signal, onReview } = options;
  const key = unsubmittedKey(intent.id, step.id);
  const held = unsubmitted.get(key);
  // Already broadcast: report it, never prepare and sign the step again.
  if (held) return { intent: await submitBroadcast(client, intent.id, step.id, held, signal), declined: false };
  // Integrator code: the user must see and confirm its review. Refused before
  // prepare, so nothing is built (or counted against caps) without a reviewer.
  if (isContractStep(step) && !onReview) {
    throw new KletiaExecutionError(
      `${contractStepName(step)}. Pass onReview to executeIntent to show the user its review and confirm before signing.`,
      intent.id,
      step.id,
    );
  }
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
  // The step as prepared (its review is now the prepare review); the snapshot is fixed at plan.
  const current = prepared.intent.steps.find((candidate) => candidate.id === step.id) ?? step;
  if (isContractStep(step) || isContractStep(current) || payload.review) {
    const problem = reviewProblem({ ...current, call: current.call ?? step.call }, payload);
    if (problem) throw new KletiaExecutionError(`Refused to sign step ${step.id}: ${problem}.`, intent.id, step.id);
    const review = payload.review as ContractReview;
    if (!onReview) {
      throw new KletiaExecutionError(
        `Step ${step.id} comes with a review to show before signing. Pass onReview to executeIntent.`,
        intent.id,
        step.id,
      );
    }
    const context: StepReviewContext = {
      intent: prepared.intent,
      transactions: payload.transactions,
      ...(step.call?.review ? { planned: step.call.review } : {}),
      expiresAt: payload.expiresAt,
    };
    // Only an explicit `true` signs.
    if ((await onReview(current, review, context)) !== true) return { intent: prepared.intent, declined: true };
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
  return { intent: await submitBroadcast(client, intent.id, step.id, references, signal), declined: false };
}

/**
 * Drive an intent to a terminal state: prepare each ready step, have the
 * matching wallet sign it, submit the references for on-chain verification
 * and wait for cross-network settlement before unlocking dependent steps.
 * Custom-contract steps are signed only after `onReview` confirmed their
 * review (see `ExecuteIntentOptions.onReview`).
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
      const outcome = await executeStep(client, intent, step, signers, options);
      intent = outcome.intent;
      forgetAccepted(intent);
      options.onUpdate?.(intent);
      if (outcome.declined) return intent;
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
