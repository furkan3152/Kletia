/**
 * Runs prepared perps steps with the user's wallets, one at a time, under
 * the desk's signing lock (one thing signs at a time):
 * - transaction steps go through the same SDK signers as intent steps
 *   (`useIntentSigners`: chain switch to the step's network, Solana pre-sign
 *   checks), then wait for the receipt;
 * - typed-data steps are signed by the connected EVM wallet
 *   (`eth_signTypedData_v4`) and relayed by POST /v1/perps/submit.
 * A step with `settleSeconds` (a bridge deposit) waits for the user to
 * continue once that time has passed. Nothing is retried on its own.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { EvmTransactionRequest, PerpsPrepared, SolanaTransactionRequest } from "@kletia/core";
import { useWalletClient } from "wagmi";

import { toPlatformError } from "../../../shared/platform/kletiaClient";
import { useIntentSigners } from "../../../shared/platform/useIntentSigners";
import { getDeskStore } from "../state/deskStore";
import { perpsApi } from "./perpsApi";
import { PERPS_COPY } from "./perpsCopy";
import { nextStep, preparedExpired, startRun, withStepState, type RunState } from "./perpsModel";

const LOCK_ID = "perps";

export interface PerpsRun {
  /** What is being signed (its quote and warnings). */
  readonly prepared: PerpsPrepared | null;
  readonly run: RunState | null;
  readonly busy: boolean;
  /** Seconds left before a settling step lets the user continue. */
  readonly settleLeft: number;
  begin(prepared: PerpsPrepared): void;
  /** Signs (or relays) the next step. */
  advance(): Promise<void>;
  reset(): void;
}

export function usePerpsRun(onFinished: () => void): PerpsRun {
  const { signers } = useIntentSigners();
  const { data: walletClient } = useWalletClient();
  const [prepared, setPrepared] = useState<PerpsPrepared | null>(null);
  const [run, setRun] = useState<RunState | null>(null);
  const [busy, setBusy] = useState(false);
  const [settleUntil, setSettleUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const inFlight = useRef(false);

  useEffect(() => {
    if (settleUntil <= Date.now()) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [settleUntil]);
  useEffect(() => () => getDeskStore().getState().releaseSigning(LOCK_ID), []);

  const begin = useCallback((next: PerpsPrepared) => {
    setPrepared(next);
    setRun(startRun(next.steps));
    setSettleUntil(0);
  }, []);

  const reset = useCallback(() => {
    getDeskStore().getState().releaseSigning(LOCK_ID);
    setPrepared(null);
    setRun(null);
    setSettleUntil(0);
  }, []);

  const advance = useCallback(async () => {
    if (!prepared || !run || inFlight.current) return;
    const index = nextStep(run);
    if (index < 0) return;
    const step = run.steps[index]!;
    // Only the first step checks the 60 s validity: later ones wait out a deposit's credit, and their
    // limit price and the relay's 10-minute nonce window still bound them.
    if (index === 0 && preparedExpired(prepared.expiresAt, Date.now())) {
      setRun(withStepState(run, index, "failed", PERPS_COPY.steps.expired));
      return;
    }
    if (!getDeskStore().getState().acquireSigning(LOCK_ID)) {
      setRun(withStepState(run, index, "failed", PERPS_COPY.steps.locked));
      return;
    }
    inFlight.current = true;
    setBusy(true);
    let current = withStepState(run, index, "signing");
    setRun(current);
    try {
      if (step.kind === "transaction") {
        const transaction = step.transaction;
        if (transaction.vm === "evm") {
          if (!signers.evm) throw new Error("Connect an EVM wallet to sign this step.");
          const hash = await signers.evm.sendTransaction(transaction as EvmTransactionRequest);
          current = withStepState(current, index, "confirming");
          setRun(current);
          await signers.evm.waitForTransaction(hash, (transaction as EvmTransactionRequest).chainId);
        } else {
          if (!signers.solana) throw new Error("Connect a Solana wallet to sign this step.");
          await signers.solana.signAndSendTransaction(transaction as SolanaTransactionRequest);
        }
        if (step.settleSeconds) setSettleUntil(Date.now() + step.settleSeconds * 1000);
      } else {
        if (!walletClient?.account) throw new Error("Your EVM wallet is not ready to sign. Reconnect it and try again.");
        const signature = await walletClient.signTypedData({
          account: walletClient.account,
          domain: { ...step.typedData.domain, verifyingContract: step.typedData.domain.verifyingContract as `0x${string}` },
          types: step.typedData.types as Record<string, { name: string; type: string }[]>,
          primaryType: step.typedData.primaryType,
          message: step.typedData.message,
        });
        current = withStepState(current, index, "relaying");
        setRun(current);
        await perpsApi.submit({ venue: "hyperliquid", account: prepared.account, action: step.relay.action, nonce: step.relay.nonce, signature });
      }
      current = withStepState(current, index, "done");
      setRun(current);
      if (nextStep(current) < 0) onFinished();
    } catch (error) {
      setRun(withStepState(current, index, "failed", toPlatformError(error).message));
    } finally {
      inFlight.current = false;
      setBusy(false);
      getDeskStore().getState().releaseSigning(LOCK_ID);
    }
  }, [onFinished, prepared, run, signers.evm, signers.solana, walletClient]);

  return { prepared, run, busy, settleLeft: Math.max(0, Math.ceil((settleUntil - now) / 1000)), begin, advance, reset };
}
