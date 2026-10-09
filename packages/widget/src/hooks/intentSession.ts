/**
 * Framework-neutral state machine behind `useKletiaIntent`: plan an intent,
 * execute it with the user's wallets, cancel or reset it. React-free so the
 * logic is testable with `node --test`; the hook only subscribes to it.
 *
 * Safety rules it keeps:
 * - Results of a superseded plan or execution (after `plan`, `reset` or
 *   unmount) are ignored.
 * - Detaching (unmount) or replacing the plan aborts the executor, and the
 *   leased signers refuse any later wallet request, so nothing is signed for
 *   a component that is gone.
 * - Transactions a wallet broadcast but Kletia did not record are kept in
 *   `pendingReferences` and resubmitted by the next `execute()`: the step is
 *   never signed twice.
 */
import type { AccountId, IntentGraph, IntentRequest } from "@kletia/core";
import {
  KletiaExecutionError,
  executeIntent,
  isIntentTerminal,
  type IntentSigners,
  type KletiaClient,
} from "@kletia/sdk";
import { leaseSigners } from "./signerLease.js";
import { createStore } from "./store.js";

export type IntentPhase = "idle" | "planning" | "planned" | "executing" | "cancelling" | "finished";

export interface IntentSessionState {
  readonly phase: IntentPhase;
  readonly intent: IntentGraph | null;
  /** The last failure (a `KletiaApiError`, `KletiaExecutionError` or wallet error); null after a success. */
  readonly error: unknown;
  /** Broadcast references Kletia has not recorded yet, by step id. `execute()` resubmits them instead of signing again. */
  readonly pendingReferences: Readonly<Record<string, readonly string[]>>;
}

export type IntentSessionAction =
  | { readonly type: "plan_started" }
  | { readonly type: "plan_succeeded"; readonly intent: IntentGraph }
  | { readonly type: "plan_failed"; readonly error: unknown }
  | { readonly type: "execute_started" }
  | { readonly type: "intent_updated"; readonly intent: IntentGraph }
  | { readonly type: "execute_succeeded"; readonly intent: IntentGraph }
  | {
      readonly type: "execute_failed";
      readonly error: unknown;
      readonly pendingReferences: Readonly<Record<string, readonly string[]>>;
    }
  | {
      /** References a stopped execution left unreported, kept for the next execute(). */
      readonly type: "references_held";
      readonly intentId: string;
      readonly pendingReferences: Readonly<Record<string, readonly string[]>>;
    }
  | { readonly type: "cancel_started" }
  | { readonly type: "cancel_succeeded"; readonly intent: IntentGraph }
  | { readonly type: "cancel_failed"; readonly error: unknown }
  | { readonly type: "reset" };

export const INITIAL_INTENT_SESSION_STATE: IntentSessionState = Object.freeze({
  phase: "idle",
  intent: null,
  error: null,
  pendingReferences: Object.freeze({}),
});

/** The resting phase for an intent: finished once terminal, planned otherwise. */
function restingPhase(intent: IntentGraph | null): IntentPhase {
  if (!intent) return "idle";
  return isIntentTerminal(intent) ? "finished" : "planned";
}

export function intentSessionReducer(state: IntentSessionState, action: IntentSessionAction): IntentSessionState {
  switch (action.type) {
    case "plan_started":
      return { phase: "planning", intent: null, error: null, pendingReferences: {} };
    case "plan_succeeded":
      return { phase: restingPhase(action.intent), intent: action.intent, error: null, pendingReferences: {} };
    case "plan_failed":
      return { phase: "idle", intent: null, error: action.error, pendingReferences: {} };
    case "execute_started":
      if (!state.intent) return state;
      return { ...state, phase: "executing", error: null };
    case "intent_updated":
      // Only newer versions of the intent this session holds.
      if (!state.intent || action.intent.id !== state.intent.id || action.intent.updatedAt < state.intent.updatedAt) return state;
      return {
        ...state,
        intent: action.intent,
        phase: state.phase === "executing" || state.phase === "cancelling" ? state.phase : restingPhase(action.intent),
      };
    case "execute_succeeded":
      if (!state.intent || action.intent.id !== state.intent.id) return state;
      return { phase: restingPhase(action.intent), intent: action.intent, error: null, pendingReferences: {} };
    case "execute_failed":
      return { ...state, phase: restingPhase(state.intent), error: action.error, pendingReferences: action.pendingReferences };
    case "references_held":
      if (!state.intent || state.intent.id !== action.intentId) return state;
      return { ...state, pendingReferences: { ...state.pendingReferences, ...action.pendingReferences } };
    case "cancel_started":
      if (!state.intent) return state;
      return { ...state, phase: "cancelling", error: null };
    case "cancel_succeeded":
      if (!state.intent || action.intent.id !== state.intent.id) return state;
      return { ...state, phase: restingPhase(action.intent), intent: action.intent, error: null };
    case "cancel_failed":
      return { ...state, phase: restingPhase(state.intent), error: action.error };
    case "reset":
      return INITIAL_INTENT_SESSION_STATE;
  }
}

export interface IntentSessionConfig {
  /** CAIP-10 accounts the user controls. Required to plan. */
  readonly accounts: readonly AccountId[];
  /** Wallet signers. Without them the session plans but cannot execute. */
  readonly signers?: IntentSigners;
  /** Opaque metadata attached to created intents (e.g. your order id). */
  readonly metadata?: Readonly<Record<string, string>>;
  /** Per-swap slippage ceiling in basis points. */
  readonly maxSlippageBps?: number;
  /** Plan without storing the intent (preview only; it cannot be executed). */
  readonly dryRun?: boolean;
}

/** What to plan: intent text, or a request without `accounts` (taken from the config). */
export type PlanInput = string | (Omit<IntentRequest, "accounts"> & { readonly accounts?: readonly AccountId[] });

export interface IntentSession {
  getState(): IntentSessionState;
  subscribe(listener: () => void): () => void;
  /** Latest accounts, signers and options (the hook calls it after every render). */
  configure(config: IntentSessionConfig): void;
  /** Plans an intent; resolves with it, or null when it failed or was superseded (see `error`). */
  plan(input: PlanInput): Promise<IntentGraph | null>;
  /** Executes the planned intent with the configured signers; resolves with the latest intent, or null. */
  execute(): Promise<IntentGraph | null>;
  /** Stops a running execution, then cancels the intent on Kletia (refused once a step was submitted). */
  cancel(): Promise<IntentGraph | null>;
  /** Forgets the intent and stops a running execution. */
  reset(): void;
  /** Starts accepting work (mount). The returned function detaches (unmount): it aborts execution and ignores late results. */
  attach(): () => void;
}

function missing(message: string): Error {
  return new Error(message);
}

export function createIntentSession(client: KletiaClient, initial: IntentSessionConfig = { accounts: [] }): IntentSession {
  const store = createStore<IntentSessionState>(INITIAL_INTENT_SESSION_STATE);
  const dispatch = (action: IntentSessionAction) => store.setState(intentSessionReducer(store.getState(), action));
  let config = initial;
  let attached = 0;
  /** Bumped whenever earlier work must stop counting (plan, reset, detach). */
  let epoch = 0;
  let running: { readonly controller: AbortController; readonly done: Promise<void>; readonly endLease: () => void } | null = null;
  let planning: AbortController | null = null;

  const stopExecution = () => {
    if (!running) return;
    running.controller.abort(new DOMException("Execution stopped.", "AbortError"));
    running.endLease();
  };

  const plan = async (input: PlanInput): Promise<IntentGraph | null> => {
    if (attached === 0) return null;
    stopExecution();
    planning?.abort();
    epoch += 1;
    const mine = epoch;
    const request = typeof input === "string" ? { text: input.trim() } : input;
    const accounts = request.accounts ?? config.accounts;
    dispatch({ type: "plan_started" });
    if ((request.text === undefined || request.text === "") && !request.actions?.length) {
      dispatch({ type: "plan_failed", error: missing("Describe the intent to plan.") });
      return null;
    }
    if (accounts.length === 0) {
      dispatch({ type: "plan_failed", error: missing("Connect at least one account to plan an intent.") });
      return null;
    }
    const controller = new AbortController();
    planning = controller;
    const constraints =
      config.maxSlippageBps !== undefined && request.constraints?.maxSlippageBps === undefined
        ? { ...request.constraints, maxSlippageBps: config.maxSlippageBps }
        : request.constraints;
    const metadata = request.metadata ?? config.metadata;
    try {
      const intent = await client.intents.create(
        {
          ...request,
          accounts,
          ...(constraints ? { constraints } : {}),
          ...(metadata ? { metadata } : {}),
        },
        { signal: controller.signal, ...(config.dryRun ? { dryRun: true } : {}) },
      );
      if (mine !== epoch) return null;
      dispatch({ type: "plan_succeeded", intent });
      return intent;
    } catch (error) {
      if (mine !== epoch) return null;
      dispatch({ type: "plan_failed", error });
      return null;
    } finally {
      if (planning === controller) planning = null;
    }
  };

  const execute = async (): Promise<IntentGraph | null> => {
    const state = store.getState();
    const intent = state.intent;
    if (attached === 0 || running || !intent || state.phase !== "planned") return null;
    if (config.dryRun) {
      dispatch({ type: "execute_failed", error: missing("A dry-run plan cannot be executed; plan it without dryRun."), pendingReferences: state.pendingReferences });
      return null;
    }
    const signers = config.signers;
    if (!signers || (!signers.evm && !signers.solana)) {
      dispatch({ type: "execute_failed", error: missing("Connect a wallet to execute this intent."), pendingReferences: state.pendingReferences });
      return null;
    }
    const mine = epoch;
    const controller = new AbortController();
    const lease = leaseSigners(signers);
    const endLease = lease.activate();
    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    running = { controller, done, endLease };
    dispatch({ type: "execute_started" });
    try {
      const final = await executeIntent(client, intent, lease.signers, {
        signal: controller.signal,
        pendingReferences: state.pendingReferences,
        onUpdate: (next) => {
          if (mine === epoch) dispatch({ type: "intent_updated", intent: next });
        },
      });
      if (mine !== epoch) return null;
      dispatch({ type: "execute_succeeded", intent: final });
      return final;
    } catch (error) {
      // Keep only what this failure left unreported; the next execute() resubmits it.
      const pendingReferences =
        error instanceof KletiaExecutionError && error.references && error.intentId === intent.id
          ? { [error.stepId]: error.references }
          : {};
      if (mine !== epoch) {
        // Detached mid-step: still keep broadcast references while this intent is shown.
        if (Object.keys(pendingReferences).length > 0) dispatch({ type: "references_held", intentId: intent.id, pendingReferences });
        return null;
      }
      dispatch({ type: "execute_failed", error, pendingReferences });
      // Show what Kletia recorded (a failed step, a partial submission).
      try {
        const latest = await client.intents.get(intent.id);
        if (mine === epoch) dispatch({ type: "intent_updated", intent: latest });
      } catch {
        // The error above already describes the failure.
      }
      return mine === epoch ? store.getState().intent : null;
    } finally {
      endLease();
      if (running?.controller === controller) running = null;
      settle();
    }
  };

  const cancel = async (): Promise<IntentGraph | null> => {
    const state = store.getState();
    const intent = state.intent;
    if (attached === 0 || !intent || state.phase === "cancelling" || state.phase === "finished" || state.phase === "planning") return null;
    const mine = epoch;
    if (running) {
      const { done } = running;
      stopExecution();
      // Let the executor record anything the wallet already broadcast first.
      await done;
      if (mine !== epoch) return null;
    }
    dispatch({ type: "cancel_started" });
    try {
      const cancelled = await client.intents.cancel(intent.id);
      if (mine !== epoch) return null;
      dispatch({ type: "cancel_succeeded", intent: cancelled });
      return cancelled;
    } catch (error) {
      if (mine !== epoch) return null;
      dispatch({ type: "cancel_failed", error });
      return null;
    }
  };

  const reset = () => {
    epoch += 1;
    stopExecution();
    planning?.abort();
    planning = null;
    dispatch({ type: "reset" });
  };

  const attach = () => {
    attached += 1;
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      attached -= 1;
      if (attached > 0) return;
      epoch += 1;
      stopExecution();
      planning?.abort();
      planning = null;
      // A plan or execution cut short by unmounting leaves a resting state for a remount (StrictMode).
      const state = store.getState();
      if (state.phase === "planning") dispatch({ type: "reset" });
      else if (state.phase === "executing" || state.phase === "cancelling") {
        dispatch({ type: "execute_failed", error: null, pendingReferences: state.pendingReferences });
      }
    };
  };

  return {
    getState: store.getState,
    subscribe: store.subscribe,
    configure: (next) => {
      config = next;
    },
    plan,
    execute,
    cancel,
    reset,
    attach,
  };
}
