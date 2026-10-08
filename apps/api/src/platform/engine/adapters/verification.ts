/**
 * Shared on-chain verification of submitted references.
 *
 * EVM: every reference must have a successful receipt from the bound account
 * to the prepared target on the step chain, mined after the payload was
 * prepared, and the landed transactions must reproduce the prepared quote
 * binding exactly.
 *
 * Solana: every signature must be confirmed/finalized, fee-paid by the bound
 * account, land after prepare and invoke the prepared primary program.
 */
import {
  explorerTxUrl,
  isEvmTransactionHash,
  isSolanaSignature,
  parseAccountId,
  type IntentStep,
  type StepEvidence,
} from "@kletia/core";
import { isSolanaNetworkKey } from "../../../networks/solana/index.js";
import { quoteBindingForViews, type BindingView } from "../binding.js";
import { evmChainId, isEvmNetwork, observeEvmTransaction } from "../chains/evm.js";
import { observeSolanaTransaction, type SolanaTransactionObservation } from "../chains/solana.js";
import type { StepFailure, VerificationResult, VerifyContext } from "./types.js";

/** Landed transactions older than prepare time (minus clock skew) are refused. */
const CLOCK_SKEW_SECONDS = 300;
/** EVM references unseen for this long are reported stale (never auto-failed: a nonce can still land). */
const EVM_STALE_MS = 60 * 60 * 1000;
/** Solana signatures unseen this long after prepare/submit can never land (blockhash expired). */
const SOLANA_EXPIRY_GRACE_MS = 180_000;

function failed(evidence: StepEvidence[], failure: StepFailure): VerificationResult {
  return { status: "failed", evidence, failure };
}

export function referenceFormatValid(step: IntentStep, reference: string): boolean {
  return step.chain.startsWith("eip155:") ? isEvmTransactionHash(reference) : isSolanaSignature(reference);
}

export async function verifyEvmReferences(context: VerifyContext): Promise<VerificationResult> {
  const { step, references } = context;
  const prepared = step.prepared;
  const account = parseAccountId(step.account);
  if (!prepared || !account || !isEvmNetwork(step.network)) {
    return failed([], { code: "STEP_NOT_PREPARED", message: "The step has no prepared EVM payload." });
  }
  const chainId = evmChainId(step.network);
  const preparedAtSeconds = Math.floor(Date.parse(prepared.preparedAt) / 1000);
  const evidence: StepEvidence[] = [];
  const views: BindingView[] = [];
  for (const [index, reference] of references.entries()) {
    const record = prepared.transactions[index];
    if (!record?.to) return failed(evidence, { code: "STEP_NOT_PREPARED", message: "Prepared transaction record is missing." });
    const observation = await observeEvmTransaction(step.network, reference);
    const observedAt = new Date(context.now).toISOString();
    if (observation.state !== "landed") {
      return {
        status: "pending",
        evidence,
        reason: observation.state === "pending" ? "Transaction is pending." : "Transaction is not visible yet.",
        stale: context.now - context.submittedAt > EVM_STALE_MS,
      };
    }
    const base = { network: step.network, reference, url: explorerTxUrl(step.network, reference), observedAt };
    if (observation.chainId !== null && observation.chainId !== chainId) {
      return failed(evidence, { code: "REFERENCE_WRONG_CHAIN", message: `Transaction ${index + 1} is not on ${step.network}.` });
    }
    if (observation.from.toLowerCase() !== account.address.toLowerCase()) {
      return failed(evidence, {
        code: "REFERENCE_WRONG_SENDER",
        message: `Transaction ${index + 1} was not sent by the step account.`,
      });
    }
    if ((observation.to ?? "").toLowerCase() !== record.to.toLowerCase()) {
      return failed(evidence, {
        code: "REFERENCE_WRONG_TARGET",
        message: `Transaction ${index + 1} does not call the prepared contract.`,
      });
    }
    if (observation.blockTimestamp !== null && observation.blockTimestamp < preparedAtSeconds - CLOCK_SKEW_SECONDS) {
      return failed(evidence, {
        code: "REFERENCE_STALE",
        message: `Transaction ${index + 1} was mined before this step was prepared.`,
      });
    }
    if (observation.status !== "success") {
      evidence.push({ ...base, kind: "receipt", detail: `Reverted in block ${observation.blockNumber}.` });
      return failed(evidence, { code: "TRANSACTION_REVERTED", message: `Transaction ${index + 1} reverted on-chain.` });
    }
    evidence.push({ ...base, kind: "receipt", detail: `Succeeded in block ${observation.blockNumber}.` });
    views.push({
      vm: "evm",
      chainId,
      from: observation.from.toLowerCase(),
      to: (observation.to ?? "").toLowerCase(),
      data: observation.input.toLowerCase(),
      value: observation.value.toString(),
    });
  }
  if (quoteBindingForViews(views) !== prepared.quoteBinding) {
    return failed(evidence, {
      code: "REFERENCE_MISMATCH",
      message: "The submitted transactions do not match the prepared payload.",
    });
  }
  return { status: "confirmed", evidence };
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
  const preparedAt = Date.parse(prepared.preparedAt);
  const evidence: StepEvidence[] = [];
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
      return {
        result: {
          status: "pending",
          evidence,
          reason: observation.status === "processed" ? "Transaction is processed but not yet confirmed." : "Signature is not visible yet.",
          stale: false,
        },
        observations,
      };
    }
    if (observation.status === "failed") {
      evidence.push({ ...base, kind: "transaction", detail: observation.error ?? "Transaction failed." });
      const wrongPayer = observation.feePayer !== null && observation.feePayer !== account.address;
      return {
        result: failed(evidence, wrongPayer
          ? { code: "REFERENCE_WRONG_SENDER", message: `Transaction ${index + 1} was not fee-paid by the step account.` }
          : { code: "TRANSACTION_FAILED", message: `Transaction ${index + 1} failed on-chain.` }),
        observations,
      };
    }
    if (observation.blockTime !== null && observation.blockTime < Math.floor(preparedAt / 1000) - CLOCK_SKEW_SECONDS) {
      return {
        result: failed(evidence, { code: "REFERENCE_STALE", message: `Transaction ${index + 1} landed before this step was prepared.` }),
        observations,
      };
    }
    if (record?.to && !observation.programs.includes(record.to)) {
      return {
        result: failed(evidence, {
          code: "REFERENCE_MISMATCH",
          message: `Transaction ${index + 1} does not invoke the prepared program.`,
        }),
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

export function referenceKey(step: IntentStep, reference: string): string {
  return step.chain.startsWith("eip155:") ? `${step.chain}:${reference.toLowerCase()}` : `${step.chain}:${reference}`;
}

export function stepOwner(step: IntentStep): string {
  return step.account.slice(step.account.lastIndexOf(":") + 1);
}
