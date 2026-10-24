/**
 * Runs prepared prediction steps with the user's EVM wallet, one at a time,
 * under the desk's signing lock (one thing signs at a time):
 * - transaction steps (approvals, a USDC.e wrap, redemption) go through the
 *   same signer as intent steps (chain switch to Polygon) and wait for the
 *   receipt;
 * - the sign-in step (ClobAuth) is signed and kept in memory until the
 *   order is relayed with it;
 * - the order step is signed (eth_signTypedData_v4) and relayed by
 *   POST /v1/predictions/submit.
 * The venue session the relay returns (or the open-orders sign-in, `signIn`)
 * is kept in memory for this tab only (never in storage): reloading signs in
 * again. Nothing is retried on its own.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { EvmTransactionRequest, PredictionPrepared, PredictionStep } from "@kletia/core";
import { useWalletClient } from "wagmi";

import { toPlatformError } from "../../../shared/platform/kletiaClient";
import { useIntentSigners } from "../../../shared/platform/useIntentSigners";
import { getDeskStore } from "../state/deskStore";
import { predictApi } from "./predictApi";
import { PREDICT_COPY } from "./predictCopy";
import { nextStep, orderStatusLine, startRun, withStepState, type RunState } from "./predictModel";

const LOCK_ID = "predict";

/** Venue sessions per account, for this tab's life only. */
const sessions = new Map<string, { readonly session: string; readonly expiresAt: number }>();

export function heldSession(account: string, nowMs: number): string | null {
  const held = sessions.get(account.toLowerCase());
  return held && held.expiresAt * 1000 > nowMs + 60_000 ? held.session : null;
}

/** Keeps a venue session for this tab (the open-orders sign-in, or the one the relay returned). */
export function rememberSession(account: string, session: string, expiresAt: number): void {
  sessions.set(account.toLowerCase(), { session, expiresAt });
}

export interface PredictRun {
  readonly run: RunState | null;
  readonly busy: boolean;
  /** What is being signed: an order (with its quote) or a redemption. */
  readonly prepared: { readonly account: string; readonly warnings: readonly string[]; readonly order: PredictionPrepared | null } | null;
  begin(account: string, steps: readonly PredictionStep[], order: PredictionPrepared | null, warnings: readonly string[]): void;
  advance(): Promise<void>;
  reset(): void;
  /** Signs in to the venue's order book (ClobAuth, no funds move) and keeps the session; returns it. */
  signIn(account: string): Promise<string>;
}

export function usePredictRun(onFinished: () => void): PredictRun {
  const { signers } = useIntentSigners();
  const { data: walletClient } = useWalletClient();
  const [run, setRun] = useState<RunState | null>(null);
  const [prepared, setPrepared] = useState<PredictRun["prepared"]>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const auth = useRef<{ timestamp: number; signature: string } | null>(null);

  useEffect(() => () => getDeskStore().getState().releaseSigning(LOCK_ID), []);

  const begin = useCallback((account: string, steps: readonly PredictionStep[], order: PredictionPrepared | null, warnings: readonly string[]) => {
    auth.current = null;
    setPrepared({ account, order, warnings });
    setRun(startRun(steps));
  }, []);

  const reset = useCallback(() => {
    getDeskStore().getState().releaseSigning(LOCK_ID);
    auth.current = null;
    setPrepared(null);
    setRun(null);
  }, []);

  const advance = useCallback(async () => {
    if (!prepared || !run || inFlight.current) return;
    const index = nextStep(run);
    if (index < 0) return;
    const step = run.steps[index]!;
    if (prepared.order && Date.now() / 1000 >= prepared.order.expiresAt) {
      setRun(withStepState(run, index, "failed", PREDICT_COPY.steps.expired));
      return;
    }
    if (!getDeskStore().getState().acquireSigning(LOCK_ID)) {
      setRun(withStepState(run, index, "failed", PREDICT_COPY.steps.locked));
      return;
    }
    inFlight.current = true;
    setBusy(true);
    let current = withStepState(run, index, "signing");
    setRun(current);
    try {
      if (step.kind === "transaction") {
        if (!signers.evm) throw new Error("Connect an EVM wallet to sign this step.");
        const transaction = step.transaction as EvmTransactionRequest;
        const hash = await signers.evm.sendTransaction(transaction);
        current = withStepState(current, index, "confirming");
        setRun(current);
        await signers.evm.waitForTransaction(hash, transaction.chainId);
      } else {
        if (!walletClient?.account) throw new Error("Your EVM wallet is not ready to sign. Reconnect it and try again.");
        const typed = step.typedData;
        const signature = await walletClient.signTypedData({
          account: walletClient.account,
          domain: {
            name: typed.domain.name,
            version: typed.domain.version,
            chainId: typed.domain.chainId,
            ...(typed.domain.verifyingContract ? { verifyingContract: typed.domain.verifyingContract as `0x${string}` } : {}),
          },
          types: typed.types as Record<string, { name: string; type: string }[]>,
          primaryType: typed.primaryType,
          message: typed.message,
        });
        if (step.purpose === "clob-auth") {
          auth.current = { timestamp: Number(typed.message.timestamp), signature };
        } else if (prepared.order) {
          current = withStepState(current, index, "relaying");
          setRun(current);
          const session = heldSession(prepared.account, Date.now());
          const answer = await predictApi.submit({
            venue: "polymarket",
            account: prepared.account,
            order: prepared.order.order,
            ticket: prepared.order.ticket,
            signature,
            ...(auth.current ? { auth: auth.current } : session ? { session } : {}),
          });
          if (answer.session && answer.sessionExpiresAt) rememberSession(prepared.account, answer.session, answer.sessionExpiresAt);
          current = { ...current, result: orderStatusLine(answer.orderStatus) };
        }
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
  }, [onFinished, prepared, run, signers.evm, walletClient]);

  const signIn = useCallback(async (account: string): Promise<string> => {
    if (!walletClient?.account) throw new Error("Your EVM wallet is not ready to sign. Reconnect it and try again.");
    if (!getDeskStore().getState().acquireSigning(LOCK_ID)) throw new Error(PREDICT_COPY.steps.locked);
    try {
      const { typedData } = await predictApi.signIn(account);
      const signature = await walletClient.signTypedData({
        account: walletClient.account,
        domain: { name: typedData.domain.name, version: typedData.domain.version, chainId: typedData.domain.chainId },
        types: typedData.types as Record<string, { name: string; type: string }[]>,
        primaryType: typedData.primaryType,
        message: typedData.message,
      });
      const made = await predictApi.session(account, { timestamp: Number(typedData.message.timestamp), signature });
      rememberSession(account, made.session, made.expiresAt);
      return made.session;
    } finally {
      getDeskStore().getState().releaseSigning(LOCK_ID);
    }
  }, [walletClient]);

  return { run, busy, prepared, begin, advance, reset, signIn };
}
