import type { SolanaTransactionRequest } from "@kletia/core";

import type { SolanaExecutionContext, SolanaSubmission } from "./solanaExecutor";

export type { SolanaExecutionContext, SolanaSubmission } from "./solanaExecutor";
export {
  SolanaConfirmationError,
  waitForSolanaConfirmation,
  type SolanaConfirmationEvidence,
} from "./confirmation";

let executorModule: Promise<typeof import("./solanaExecutor")> | null = null;

/** Loads the @solana/kit-backed executor on first use only. */
export function loadSolanaExecutor(): Promise<typeof import("./solanaExecutor")> {
  executorModule ??= import("./solanaExecutor").catch((error: unknown) => {
    executorModule = null;
    throw error;
  });
  return executorModule;
}

/**
 * Validate, sign and broadcast a prepared Solana transaction with the
 * connected Wallet Standard wallet. Confirmation is tracked separately with
 * `waitForSolanaConfirmation`.
 */
export async function signAndSendSolanaTransaction(
  request: SolanaTransactionRequest,
  context: SolanaExecutionContext,
): Promise<SolanaSubmission> {
  const executor = await loadSolanaExecutor();
  return executor.signAndSendSolanaTransaction(request, context);
}
