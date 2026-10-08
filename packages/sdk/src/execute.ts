import {
  CHAINS,
  normalizeAddress,
  parseAccountId,
  type IntentGraph,
  type IntentStatus,
  type IntentStep,
} from "@kletia/core";
import type { KletiaClient } from "./client.js";
import { KletiaExecutionError } from "./errors.js";
import type { EvmSigner, SolanaSigner } from "./signers.js";

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
}

const TERMINAL: readonly IntentStatus[] = [
  "completed",
  "partially_completed",
  "failed",
  "expired",
  "cancelled",
];

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
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

async function executeStep(
  client: KletiaClient,
  intent: IntentGraph,
  step: IntentStep,
  signers: IntentSigners,
): Promise<IntentGraph> {
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
  const { payload } = await client.intents.prepareStep(intent.id, step.id);
  const references: string[] = [];
  for (const transaction of payload.transactions) {
    if (Date.now() / 1000 > payload.expiresAt) {
      throw new KletiaExecutionError("Prepared transactions expired before signing.", intent.id, step.id);
    }
    try {
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
      if (references.length > 0) {
        // Report what already landed so Kletia can recover the step state.
        await client.intents.submitStep(intent.id, step.id, references).catch(() => undefined);
      }
      throw new KletiaExecutionError(
        error instanceof Error ? error.message : "Wallet rejected the transaction.",
        intent.id,
        step.id,
        error,
      );
    }
  }
  return client.intents.submitStep(intent.id, step.id, references);
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
  options.onUpdate?.(intent);
  while (!TERMINAL.includes(intent.status)) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("Aborted");
    if (Date.now() > deadline) throw new Error(`Intent ${intent.id} did not finish before the deadline.`);
    const ready = intent.steps.filter((step) => step.status === "ready" || step.status === "awaiting_signature");
    if (ready.length > 0) {
      const step = ready[0] as IntentStep;
      if (options.beforeStep && !(await options.beforeStep(step, intent))) return intent;
      intent = await executeStep(client, intent, step, signers);
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
    options.onUpdate?.(intent);
  }
  return intent;
}
