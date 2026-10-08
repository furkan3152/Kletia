import { useCallback, useRef, useState } from "react";
import {
  explorerTxUrl,
  formatAccountId,
  type SolanaTransactionRequest,
} from "@kletia/core";

import { emitPortfolioInvalidated } from "../../../shared/sync/bus";
import { recordActivity, updateActivity } from "../../../shared/sync/activityStore";
import {
  SolanaConfirmationError,
  signAndSendSolanaTransaction,
  waitForSolanaConfirmation,
} from "../../../shared/wallet/solana/executeSolanaTransaction";
import { useSolanaWallet } from "../../../shared/wallet/solana/solanaWalletContext";
import { errorMessage, isAbortError } from "../api";

export type SolanaExecutionPhase =
  | "idle"
  | "preparing"
  | "review"
  | "signing"
  | "confirming"
  | "confirmed"
  | "failed";

export interface PreparedSolanaAction<TDetails> {
  readonly request: SolanaTransactionRequest;
  /** Activity title, e.g. "Swap 1 SOL to USDC". */
  readonly title: string;
  readonly details: TDetails;
  /** When set, signing is refused and this reason is shown instead. */
  readonly blockedReason?: string | null;
}

export interface SolanaExecutionState<TDetails> {
  readonly phase: SolanaExecutionPhase;
  readonly prepared: PreparedSolanaAction<TDetails> | null;
  readonly signature: string | null;
  readonly explorerUrl: string | null;
  readonly error: string | null;
  readonly logs: readonly string[];
}

const INITIAL_STATE = {
  phase: "idle",
  prepared: null,
  signature: null,
  explorerUrl: null,
  error: null,
  logs: [],
} as const;

function walletErrorMessage(error: unknown): string {
  const message = errorMessage(error);
  if (/user rejected|rejected the request|declined|denied|cancel/iu.test(message)) {
    return "The signature request was declined in the wallet. Nothing was sent.";
  }
  if (/blockhash not found|block height exceeded|expired/iu.test(message)) {
    return "The prepared transaction expired before it was signed. Prepare it again.";
  }
  return message;
}

/**
 * Shared Solana execution flow: prepare (unsigned, server-built) -> review ->
 * wallet signature -> confirmation evidence -> activity + portfolio refresh.
 * A prepared transaction is consumed by the first signing attempt and is
 * never re-submitted automatically.
 */
export function useSolanaExecution<TDetails>() {
  const { wallet, account } = useSolanaWallet();
  const [state, setState] = useState<SolanaExecutionState<TDetails>>(INITIAL_STATE);
  const preparedRef = useRef<PreparedSolanaAction<TDetails> | null>(null);
  const prepareAbortRef = useRef<AbortController | null>(null);

  const appendLog = useCallback((line: string) => {
    setState((current) => ({ ...current, logs: [...current.logs, line].slice(-30) }));
  }, []);

  const reset = useCallback(() => {
    prepareAbortRef.current?.abort();
    prepareAbortRef.current = null;
    preparedRef.current = null;
    setState(INITIAL_STATE);
  }, []);

  const prepare = useCallback(
    async (build: (signal: AbortSignal) => Promise<PreparedSolanaAction<TDetails>>) => {
      prepareAbortRef.current?.abort();
      const controller = new AbortController();
      prepareAbortRef.current = controller;
      preparedRef.current = null;
      setState({
        ...INITIAL_STATE,
        phase: "preparing",
        logs: ["Kletia is building an unsigned transaction."],
      });
      try {
        const prepared = await build(controller.signal);
        if (controller.signal.aborted) return;
        preparedRef.current = prepared;
        setState((current) => ({
          ...current,
          phase: "review",
          prepared,
          logs: [
            ...current.logs,
            prepared.blockedReason
              ? "Prepared transaction did not pass review; signing is blocked."
              : "Unsigned transaction ready. Review it before signing.",
          ],
        }));
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) return;
        setState((current) => ({ ...current, phase: "failed", error: errorMessage(error) }));
      }
    },
    [],
  );

  const confirm = useCallback(async () => {
    const prepared = preparedRef.current;
    if (!prepared) return;
    if (!wallet || !account) {
      setState((current) => ({ ...current, error: "Connect a Solana wallet to sign." }));
      return;
    }
    if (prepared.blockedReason) return;
    if (prepared.request.feePayer !== account.address) {
      preparedRef.current = null;
      setState((current) => ({
        ...current,
        phase: "failed",
        error: "This transaction was prepared for a different Solana account. Prepare it again.",
      }));
      return;
    }
    // Consume the prepared transaction: one signing attempt per preparation.
    preparedRef.current = null;
    const network = prepared.request.network;
    const owner = account.address;
    setState((current) => ({ ...current, phase: "signing", error: null }));
    let signature: string | null = null;
    try {
      const submission = await signAndSendSolanaTransaction(prepared.request, {
        wallet,
        account,
        network,
        onLog: appendLog,
      });
      signature = submission.signature;
      const pendingUrl = explorerTxUrl(network, signature);
      recordActivity({
        id: signature,
        network,
        title: prepared.title,
        status: "pending",
        reference: signature,
        url: pendingUrl,
      });
      setState((current) => ({
        ...current,
        phase: "confirming",
        signature,
        explorerUrl: pendingUrl,
      }));
      const evidence = await waitForSolanaConfirmation(signature, network, owner, {
        onLog: appendLog,
      });
      updateActivity(signature, { status: "confirmed", url: evidence.explorerUrl });
      emitPortfolioInvalidated(formatAccountId(network, owner), network, prepared.title);
      setState((current) => ({
        ...current,
        phase: "confirmed",
        explorerUrl: evidence.explorerUrl,
        logs: [...current.logs, `Confirmed at ${evidence.status} commitment.`],
      }));
    } catch (error) {
      if (signature) {
        const stillPending =
          error instanceof SolanaConfirmationError &&
          error.code === "NOT_OBSERVED" &&
          error.lastStatus === "processed";
        if (!stillPending) updateActivity(signature, { status: "failed" });
        emitPortfolioInvalidated(formatAccountId(network, owner), network, prepared.title);
      }
      setState((current) => ({
        ...current,
        phase: "failed",
        error: signature ? errorMessage(error) : walletErrorMessage(error),
      }));
    }
  }, [account, appendLog, wallet]);

  return {
    ...state,
    prepare,
    confirm,
    reset,
    busy: state.phase === "preparing" || state.phase === "signing" || state.phase === "confirming",
  };
}

export type SolanaExecution<TDetails> = ReturnType<typeof useSolanaExecution<TDetails>>;
