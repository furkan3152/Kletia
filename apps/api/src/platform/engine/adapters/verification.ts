/**
 * Shared on-chain verification of submitted references.
 *
 * EVM: every reference must be mined on the step chain from the bound account,
 * and the landed transactions (chain, from, to, calldata, value) must
 * reproduce the quote binding of a payload prepared for this step exactly;
 * each must be mined after that payload was first prepared. Only then does a
 * revert count as an on-chain failure of the step.
 *
 * Adapters that must prove an outcome from receipt logs (a Supply / Withdraw /
 * Mint / CreatedOrder event) call `verifyEvmReceipts` with a check; the check
 * runs only after the binding matched and every transaction succeeded.
 *
 * Solana: every signature must be confirmed/finalized with a readable body,
 * fee-paid by the bound account, land after the step was first prepared and
 * invoke the prepared primary program; adapters add amount checks.
 *
 * Failures whose code is in REJECTION_CODES prove that the references are not
 * this step's transactions. They never fail the step: the service refuses the
 * submission and the step keeps waiting for the right references.
 */
import { parseEventLogs, type Abi, type ContractEventName, type Log } from "viem";
import {
  explorerTxUrl,
  isEvmTransactionHash,
  isSolanaSignature,
  parseAccountId,
  WRAPPED_SOL_MINT,
  type AssetAmount,
  type IntentStep,
  type StepEvidence,
} from "@kletia/core";
import { isSolanaNetworkKey } from "../../../networks/solana/index.js";
import { quoteBindingForViews, type BindingView } from "../binding.js";
import { evmChainId, isEvmNetwork, observeEvmTransaction, type EvmTransactionObservation } from "../chains/evm.js";
import { observeSolanaTransaction, type SolanaTransactionObservation } from "../chains/solana.js";
import type { StepFailure, VerificationResult, VerifyContext } from "./types.js";

/** Landed transactions older than prepare time (minus clock skew) are refused. */
const CLOCK_SKEW_SECONDS = 300;
/** References unseen for this long are reported stale (never auto-failed: a nonce can still land). */
export const REFERENCE_STALE_MS = 60 * 60 * 1000;
/** Solana signatures unseen this long after prepare/submit can never land (blockhash expired). */
const SOLANA_EXPIRY_GRACE_MS = 180_000;
/**
 * Lamport tolerance for native-SOL amount checks: covers one token-account rent
 * created or reclaimed inside a swap transaction (historically 2,039,280
 * lamports; 1,488,440 for a 165-byte account as read on 2026-10-09).
 */
export const SOL_RENT_TOLERANCE_LAMPORTS = 2_100_000n;

/** Failure codes that mean "these references are not this step's transactions". */
export const REJECTION_CODES: ReadonlySet<string> = new Set([
  "REFERENCE_WRONG_SENDER",
  "REFERENCE_WRONG_CHAIN",
  "REFERENCE_MISMATCH",
  "REFERENCE_STALE",
  "REFERENCE_ALREADY_USED",
]);

export function isReferenceRejection(result: VerificationResult): result is Extract<VerificationResult, { status: "failed" }> {
  return result.status === "failed" && REJECTION_CODES.has(result.failure.code);
}

function failed(evidence: StepEvidence[], failure: StepFailure): VerificationResult {
  return { status: "failed", evidence, failure };
}

export function referenceFormatValid(step: IntentStep, reference: string): boolean {
  return step.chain.startsWith("eip155:") ? isEvmTransactionHash(reference) : isSolanaSignature(reference);
}

const BINDING_PATTERN = /^[0-9a-f]{64}$/u;

/**
 * Bindings of every payload prepared for this step (current one plus earlier
 * re-prepares), each mapped to the unix ms when it was first prepared.
 */
export function preparedBindings(step: IntentStep): Map<string, number> {
  const bindings = new Map<string, number>();
  const add = (binding: string | undefined, at: string) => {
    const time = Date.parse(at);
    if (!binding || !BINDING_PATTERN.test(binding) || !Number.isFinite(time)) return;
    const known = bindings.get(binding);
    if (known === undefined || time < known) bindings.set(binding, time);
  };
  if (step.prepared) add(step.prepared.quoteBinding, step.prepared.preparedAt);
  for (const entry of step.evidence) {
    if (entry.kind === "quote") add(entry.reference, entry.observedAt);
  }
  return bindings;
}

/** Unix ms of the first prepare of this step, or null when it was never prepared. */
export function firstPreparedAt(step: IntentStep): number | null {
  const times = [...preparedBindings(step).values()];
  return times.length > 0 ? Math.min(...times) : null;
}

type LandedEvm = Extract<EvmTransactionObservation, { state: "landed" }>;

/** A landed EVM transaction of the step, in prepared order, with its receipt logs. */
export type LandedEvmReceipt = LandedEvm & { readonly reference: string };

export interface EvmOutcome {
  /** The outcome is not proven (e.g. a required event is missing): the step fails with this code. */
  readonly failure?: StepFailure;
  /** Output measured from the receipts (e.g. the amount in a Withdraw event). */
  readonly actualOutput?: AssetAmount;
  /** Extra evidence (decoded events) appended after the receipts. */
  readonly evidence?: readonly StepEvidence[];
}

/**
 * Outcome check over the landed receipts. It runs only after the binding
 * matched (the receipts are this step's prepared transactions) and every
 * transaction succeeded. A failure code in REJECTION_CODES is rewritten to
 * OUTCOME_NOT_PROVEN: the references are proven to be the step's own, so a
 * missing event is an on-chain outcome failure, never a rejected submission.
 */
export interface EvmVerificationCheck {
  (receipts: readonly LandedEvmReceipt[]): EvmOutcome | void | Promise<EvmOutcome | void>;
}

/**
 * Decoded `eventName` events emitted by `address` across `receipts` (strict
 * ABI decoding: logs that do not match the event signature are skipped).
 */
export function evmEvents<const abi extends Abi, eventName extends ContractEventName<abi>>(
  receipts: readonly { readonly logs: readonly Log[] }[],
  filter: { readonly address: string; readonly abi: abi; readonly eventName: eventName },
) {
  const address = filter.address.toLowerCase();
  const logs = receipts.flatMap((receipt) => receipt.logs.filter((log) => log.address.toLowerCase() === address));
  return parseEventLogs({ abi: filter.abi, logs: [...logs], eventName: filter.eventName, strict: true });
}

export async function verifyEvmReferences(context: VerifyContext): Promise<VerificationResult> {
  return (await verifyEvmReceipts(context)).result;
}

/**
 * verifyEvmReferences plus the landed receipts (with logs) and an optional
 * outcome check. `receipts` is filled once every reference has landed, also
 * when the result is a failure; it is empty while any reference is pending.
 */
export async function verifyEvmReceipts(
  context: VerifyContext,
  check?: EvmVerificationCheck,
): Promise<{ result: VerificationResult; receipts: LandedEvmReceipt[] }> {
  const { step, references } = context;
  const prepared = step.prepared;
  const account = parseAccountId(step.account);
  const receipts: LandedEvmReceipt[] = [];
  const done = (result: VerificationResult) => ({ result, receipts });
  if (!prepared || !account || !isEvmNetwork(step.network)) {
    return done(failed([], { code: "STEP_NOT_PREPARED", message: "The step has no prepared EVM payload." }));
  }
  const chainId = evmChainId(step.network);
  const observedAt = new Date(context.now).toISOString();
  const landed: LandedEvm[] = [];
  for (const reference of references) {
    const observation = await observeEvmTransaction(step.network, reference);
    if (observation.state !== "landed") {
      return done({
        status: "pending",
        evidence: [],
        reason: observation.state === "pending" ? "Transaction is pending." : "Transaction is not visible yet.",
        stale: context.now - context.submittedAt > REFERENCE_STALE_MS,
      });
    }
    // Fail closed: without a block time the transaction cannot be ordered against prepare.
    if (observation.blockTimestamp === null) {
      return done({ status: "pending", evidence: [], reason: "Block time is not readable yet.", stale: false });
    }
    landed.push(observation);
  }
  receipts.push(...landed.map((observation, index) => ({ ...observation, reference: references[index] as string })));
  for (const [index, observation] of landed.entries()) {
    if (observation.chainId !== null && observation.chainId !== chainId) {
      return done(failed([], { code: "REFERENCE_WRONG_CHAIN", message: `Transaction ${index + 1} is not on ${step.network}.` }));
    }
    if (observation.from.toLowerCase() !== account.address.toLowerCase()) {
      return done(failed([], { code: "REFERENCE_WRONG_SENDER", message: `Transaction ${index + 1} was not sent by the step account.` }));
    }
  }
  // The binding covers chain, sender, target, calldata and value of every
  // transaction, so a match proves each receipt.to equals the prepared target.
  const views: BindingView[] = landed.map((observation) => ({
    vm: "evm",
    chainId,
    from: observation.from.toLowerCase(),
    to: (observation.to ?? "").toLowerCase(),
    data: observation.input.toLowerCase(),
    value: observation.value.toString(),
  }));
  const preparedAtMs = preparedBindings(step).get(quoteBindingForViews(views));
  if (preparedAtMs === undefined) {
    return done(failed([], {
      code: "REFERENCE_MISMATCH",
      message: "The submitted transactions do not match a payload prepared for this step (target, calldata or value differ).",
    }));
  }
  const notBefore = Math.floor(preparedAtMs / 1000) - CLOCK_SKEW_SECONDS;
  for (const [index, observation] of landed.entries()) {
    if ((observation.blockTimestamp ?? 0) < notBefore) {
      return done(failed([], { code: "REFERENCE_STALE", message: `Transaction ${index + 1} was mined before this step's payload was prepared.` }));
    }
  }
  const evidence: StepEvidence[] = landed.map((observation, index) => {
    const reference = references[index] as string;
    return {
      kind: "receipt",
      network: step.network,
      reference,
      url: explorerTxUrl(step.network, reference),
      observedAt,
      detail: `${observation.status === "success" ? "Succeeded" : "Reverted"} in block ${observation.blockNumber}.`,
    };
  });
  const reverted = landed.findIndex((observation) => observation.status !== "success");
  if (reverted !== -1) {
    return done(failed(evidence, { code: "TRANSACTION_REVERTED", message: `Transaction ${reverted + 1} reverted on-chain.` }));
  }
  const outcome = check ? await check(receipts) : undefined;
  const allEvidence = [...evidence, ...(outcome?.evidence ?? [])];
  if (outcome?.failure) {
    const failure = REJECTION_CODES.has(outcome.failure.code)
      ? { code: "OUTCOME_NOT_PROVEN", message: outcome.failure.message }
      : outcome.failure;
    return done(failed(allEvidence, failure));
  }
  return done({
    status: "confirmed",
    evidence: allEvidence,
    ...(outcome?.actualOutput ? { actualOutput: outcome.actualOutput } : {}),
  });
}

export interface SolanaVerificationCheck {
  /** Inspect landed transactions; return a failure to reject or an observed output. */
  (observations: readonly SolanaTransactionObservation[]): { failure?: StepFailure } | void;
}

export async function verifySolanaReferences(
  context: VerifyContext,
  check?: SolanaVerificationCheck,
): Promise<{ result: VerificationResult; observations: SolanaTransactionObservation[] }> {
  const { step, references } = context;
  const prepared = step.prepared;
  const account = parseAccountId(step.account);
  const observations: SolanaTransactionObservation[] = [];
  if (!prepared || !account || !isSolanaNetworkKey(step.network)) {
    return { result: failed([], { code: "STEP_NOT_PREPARED", message: "The step has no prepared Solana payload." }), observations };
  }
  // Wallets re-sign Solana payloads, so the earliest prepare bounds every payload of this step.
  const notBefore = Math.floor((firstPreparedAt(step) ?? Date.parse(prepared.preparedAt)) / 1000) - CLOCK_SKEW_SECONDS;
  const evidence: StepEvidence[] = [];
  const pending = (reason: string, stale = false) => ({
    result: { status: "pending" as const, evidence, reason, stale },
    observations,
  });
  for (const [index, reference] of references.entries()) {
    const record = prepared.transactions[index];
    const observation = await observeSolanaTransaction(step.network, reference, account.address);
    const observedAt = new Date(context.now).toISOString();
    const base = { network: step.network, reference, url: observation.explorerUrl, observedAt };
    if (observation.status === "not_found" || observation.status === "processed") {
      const deadline = Math.max(prepared.expiresAt * 1000, context.submittedAt) + SOLANA_EXPIRY_GRACE_MS;
      if (observation.status === "not_found" && context.now > deadline) {
        return {
          result: failed(evidence, {
            code: "TRANSACTION_EXPIRED",
            message: `Transaction ${index + 1} never landed and its blockhash has expired. Prepare the step again.`,
          }),
          observations,
        };
      }
      return pending(observation.status === "processed" ? "Transaction is processed but not yet confirmed." : "Signature is not visible yet.");
    }
    if (!observation.detailsAvailable) {
      // A status alone (even a failed one) does not prove who sent the transaction.
      return pending("Transaction details are not readable yet.", context.now - context.submittedAt > REFERENCE_STALE_MS);
    }
    if (observation.feePayer !== account.address) {
      return {
        result: failed(evidence, { code: "REFERENCE_WRONG_SENDER", message: `Transaction ${index + 1} was not fee-paid by the step account.` }),
        observations,
      };
    }
    if (observation.blockTime === null) {
      return pending("Block time is not readable yet.");
    }
    if (observation.blockTime < notBefore) {
      return {
        result: failed(evidence, { code: "REFERENCE_STALE", message: `Transaction ${index + 1} landed before this step was prepared.` }),
        observations,
      };
    }
    if (record?.to && !observation.programs.includes(record.to)) {
      return {
        result: failed(evidence, { code: "REFERENCE_MISMATCH", message: `Transaction ${index + 1} does not invoke the prepared program.` }),
        observations,
      };
    }
    if (observation.status === "failed") {
      evidence.push({ ...base, kind: "transaction", detail: observation.error ?? "Transaction failed." });
      return {
        result: failed(evidence, { code: "TRANSACTION_FAILED", message: `Transaction ${index + 1} failed on-chain.` }),
        observations,
      };
    }
    evidence.push({ ...base, kind: "transaction", detail: `${observation.status === "finalized" ? "Finalized" : "Confirmed"} in slot ${observation.slot ?? "?"}.` });
    observations.push(observation);
  }
  const outcome = check?.(observations);
  if (outcome && outcome.failure) return { result: failed(evidence, outcome.failure), observations };
  return { result: { status: "confirmed", evidence }, observations };
}

/**
 * Net native-SOL movement of `owner` across observations, with the fee added
 * back and wrapped-SOL token balance changes folded in (Jupiter wraps and
 * unwraps SOL inside the swap transaction).
 */
export function effectiveSolDelta(observations: readonly SolanaTransactionObservation[], owner: string): bigint {
  return observations.reduce((total, observation) => {
    const lamports = observation.lamportDeltas.get(owner) ?? 0n;
    const fee = observation.feePayer === owner ? (observation.fee ?? 0n) : 0n;
    const wrapped = observation.tokenDeltas.get(`${owner}:${WRAPPED_SOL_MINT}`) ?? 0n;
    return total + lamports + fee + wrapped;
  }, 0n);
}

/** Net SPL token movement of `owner` for `mint` across observations. */
export function tokenDelta(observations: readonly SolanaTransactionObservation[], owner: string, mint: string): bigint {
  return observations.reduce((total, observation) => total + (observation.tokenDeltas.get(`${owner}:${mint}`) ?? 0n), 0n);
}

export function referenceKey(step: IntentStep, reference: string): string {
  return step.chain.startsWith("eip155:") ? `${step.chain}:${reference.toLowerCase()}` : `${step.chain}:${reference}`;
}

export function stepOwner(step: IntentStep): string {
  return step.account.slice(step.account.lastIndexOf(":") + 1);
}
