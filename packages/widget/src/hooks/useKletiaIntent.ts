import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { IntentGraph } from "@kletia/core";
import type { KletiaClient } from "@kletia/sdk";
import { useKletiaClient } from "./context.js";
import {
  createIntentSession,
  type ClarifyAnswerInput,
  type IntentSessionConfig,
  type IntentSessionState,
  type PlanInput,
  type StartSessionOptions,
} from "./intentSession.js";

export interface UseKletiaIntentOptions extends IntentSessionConfig {
  /** Overrides the client from `KletiaProvider`. */
  readonly client?: KletiaClient;
}

export interface UseKletiaIntentResult extends IntentSessionState {
  /**
   * Plans an intent from text (a clarify turn: it may ask first, `phase:
   * "clarifying"` with `clarify.questions`) or from a request without
   * accounts; resolves with the intent, or null (see `error` and `clarify`).
   */
  plan(input: PlanInput): Promise<IntentGraph | null>;
  /** A follow-up for the current task ("make it 50"), or a new task when there is none. */
  say(text: string): Promise<IntentGraph | null>;
  /** Answers an open question; ignored once the question is gone (after `reset` or a new sentence). */
  answer(input: ClarifyAnswerInput): Promise<IntentGraph | null>;
  /** Picks another value for one of Kletia's assumptions (`clarify.assumptions`) and re-plans. */
  chooseAssumption(assumptionId: string, optionId: string): Promise<IntentGraph | null>;
  /** Records the answer to a journey prompt; open blockers keep `execute()` from signing. */
  answerJourney(consequenceId: string, optionId: string): void;
  /** Opens a stored intent (e.g. one your backend created) to review and execute it. */
  open(intentId: string): Promise<IntentGraph | null>;
  /** Turns a session your backend created (`cs_…`) into an intent for `accounts`, to review and execute it. */
  startSession(sessionId: string, options?: StartSessionOptions): Promise<IntentGraph | null>;
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
 * const { plan, answer, clarify, execute, intent, phase, error } = useKletiaIntent({ accounts, signers, journey: true });
 * <button onClick={() => plan("bridge 25 USDC from base to solana")}>Plan</button>
 * {phase === "clarifying" && clarify?.questions[0]?.options.map((option) => (
 *   <button key={option.id} onClick={() => answer({ questionId: clarify.questions[0].id, optionId: option.id })}>{option.label}</button>
 * ))}
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
    () => ({
      ...state,
      plan: session.plan,
      say: session.say,
      answer: session.answer,
      chooseAssumption: session.chooseAssumption,
      answerJourney: session.answerJourney,
      open: session.open,
      startSession: session.startSession,
      execute: session.execute,
      cancel: session.cancel,
      reset: session.reset,
    }),
    [state, session],
  );
}
