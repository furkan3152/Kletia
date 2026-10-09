import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { IntentGraph } from "@kletia/core";
import type { KletiaClient } from "@kletia/sdk";
import { useKletiaClient } from "./context.js";
import {
  createIntentSession,
  type IntentSessionConfig,
  type IntentSessionState,
  type PlanInput,
} from "./intentSession.js";

export interface UseKletiaIntentOptions extends IntentSessionConfig {
  /** Overrides the client from `KletiaProvider`. */
  readonly client?: KletiaClient;
}

export interface UseKletiaIntentResult extends IntentSessionState {
  /** Plans an intent from text (or a request without accounts); resolves with it, or null (see `error`). */
  plan(input: PlanInput): Promise<IntentGraph | null>;
  /** Opens a stored intent (e.g. one your backend created) to review and execute it. */
  open(intentId: string): Promise<IntentGraph | null>;
  /** Executes the planned intent with `signers`; resubmits `pendingReferences` instead of signing again. */
  execute(): Promise<IntentGraph | null>;
  /** Stops a running execution and cancels the intent on Kletia (refused once a step was submitted). */
  cancel(): Promise<IntentGraph | null>;
  /** Forgets the intent and stops a running execution. */
  reset(): void;
}

/**
 * Plan and execute one intent at a time with the user's wallets.
 *
 * ```tsx
 * const { plan, execute, intent, phase, error } = useKletiaIntent({ accounts, signers });
 * <button onClick={() => plan("bridge 25 USDC from base to solana")}>Plan</button>
 * <button disabled={phase !== "planned"} onClick={execute}>Execute</button>
 * ```
 *
 * Unmounting aborts the executor and revokes the signers it was given, so
 * no wallet prompt opens for a component that is gone.
 */
export function useKletiaIntent(options: UseKletiaIntentOptions): UseKletiaIntentResult {
  const client = useKletiaClient(options.client);
  // One session per client; accounts, signers and options flow in through configure.
  const [initial] = useState(options);
  const session = useMemo(() => createIntentSession(client, initial), [client, initial]);
  // React flushes these effects before it handles the next click, so plan()
  // and execute() always see the accounts and signers of the last render.
  useEffect(() => {
    session.configure(options);
  });
  useEffect(() => session.attach(), [session]);
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  return useMemo(
    () => ({ ...state, plan: session.plan, open: session.open, execute: session.execute, cancel: session.cancel, reset: session.reset }),
    [state, session],
  );
}
