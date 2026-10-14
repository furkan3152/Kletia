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
 * - Text always plans through clarify turns (`POST /v1/intents?clarify=true`):
 *   a sentence that leaves something open returns questions (phase
 *   `clarifying`) instead of a guess. Answers to a superseded or reset
 *   thread are ignored, and a refused turn keeps the open questions.
 * - With `journey`, open journey blockers stop `execute()` before the wallet
 *   prompt of the leg they concern until they are answered.
 */
import {
  openBlockers,
  type AccountId,
  type ClarifyAssumption,
  type ClarifyDraft,
  type ClarifyQuestion,
  type ClarifyThread,
  type IntentGraph,
  type IntentPreview,
  type IntentRequest,
  type IntentTurnRequest,
  type Journey,
  type SourceNetwork,
  type ThreadRef,
} from "@kletia/core";
import {
  KletiaExecutionError,
  executeIntent,
  isIntentTerminal,
  type ExecuteIntentOptions,
  type IntentSigners,
  type IntentTurnResult,
  type KletiaClient,
} from "@kletia/sdk";
import { leaseSigners } from "./signerLease.js";
import { createStore } from "./store.js";

export type IntentPhase = "idle" | "planning" | "clarifying" | "planned" | "executing" | "cancelling" | "finished";

/** The answer a clarify turn is sending (the card shows it pressed). */
export type ClarifyPending =
  | { readonly kind: "message" }
  | { readonly kind: "answer"; readonly questionId: string; readonly optionId?: string }
  | { readonly kind: "assumption"; readonly assumptionId: string; readonly optionId: string };

/** The task's clarify state: its open questions, Kletia's assumptions and the thread to send back. */
export interface ClarifyState {
  readonly status: "needs_input" | "planned";
  /** Open questions (needs_input); empty once planned. */
  readonly questions: readonly ClarifyQuestion[];
  /** Defaults Kletia picked, shown as editable chips. */
  readonly assumptions: readonly ClarifyAssumption[];
  readonly draft: ClarifyDraft | null;
  /** The planned sentence (Kletia's words); null while questions are open. */
  readonly sentence: string | null;
  /** The thread to send back with the next turn (client-held; a Kletia-held one is a ThreadRef). */
  readonly thread: ClarifyThread | ThreadRef | null;
  /** The turn in flight, if any. */
  readonly pending: ClarifyPending | null;
}

export interface IntentSessionState {
  readonly phase: IntentPhase;
  readonly intent: IntentGraph | null;
  /** The last failure (a `KletiaApiError`, `KletiaExecutionError` or wallet error); null after a success. */
  readonly error: unknown;
  /** Broadcast references Kletia has not recorded yet, by step id. `execute()` resubmits them instead of signing again. */
  readonly pendingReferences: Readonly<Record<string, readonly string[]>>;
  /** The plan's asset-change preview ("fare breakdown") when `preview` is on and the API returned one. */
  readonly preview: IntentPreview | null;
  /** The text task's clarify state; null for structured plans, opened intents and sessions. */
  readonly clarify: ClarifyState | null;
  /** Where the money is after every step (with `journey`): read with the plan and on step changes, never polled. */
  readonly journey: Journey | null;
  /** Answers to the journey's prompts, consequence id → option id (this intent only). */
  readonly journeyAnswers: Readonly<Record<string, string>>;
}

export type IntentSessionAction =
  | { readonly type: "plan_started" }
  | { readonly type: "plan_succeeded"; readonly intent: IntentGraph; readonly preview?: IntentPreview | null; readonly journey?: Journey | null }
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
  | { readonly type: "turn_started"; readonly pending: ClarifyPending; readonly fresh: boolean }
  | { readonly type: "turn_succeeded"; readonly response: IntentTurnResult }
  | { readonly type: "turn_failed"; readonly error: unknown }
  | { readonly type: "journey_updated"; readonly journey: Journey }
  | { readonly type: "journey_answered"; readonly consequenceId: string; readonly optionId: string }
  | { readonly type: "reset" };

export const INITIAL_INTENT_SESSION_STATE: IntentSessionState = Object.freeze({
  phase: "idle",
  intent: null,
  error: null,
  pendingReferences: Object.freeze({}),
  preview: null,
  clarify: null,
  journey: null,
  journeyAnswers: Object.freeze({}),
});

const NO_CLARIFY = { clarify: null, journey: null, journeyAnswers: {} } as const;

/** The resting phase for an intent: finished once terminal, planned otherwise. */
function restingPhase(intent: IntentGraph | null): IntentPhase {
  if (!intent) return "idle";
  return isIntentTerminal(intent) ? "finished" : "planned";
}

export function intentSessionReducer(state: IntentSessionState, action: IntentSessionAction): IntentSessionState {
  switch (action.type) {
    case "plan_started":
      return { phase: "planning", intent: null, error: null, pendingReferences: {}, preview: null, ...NO_CLARIFY };
    case "plan_succeeded":
      return {
        phase: restingPhase(action.intent),
        intent: action.intent,
        error: null,
        pendingReferences: {},
        preview: action.preview ?? null,
        ...NO_CLARIFY,
        journey: action.journey && action.journey.intentId === action.intent.id ? action.journey : null,
      };
    case "plan_failed":
      return { phase: "idle", intent: null, error: action.error, pendingReferences: {}, preview: null, ...NO_CLARIFY };
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
      return { ...state, phase: restingPhase(action.intent), intent: action.intent, error: null, pendingReferences: {} };
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
    case "turn_started":
      // A new sentence starts a new task; an answer or a chip keeps the card (and the plan) on screen.
      if (action.fresh) {
        return { phase: "planning", intent: null, error: null, pendingReferences: {}, preview: null, ...NO_CLARIFY };
      }
      return { ...state, phase: "planning", error: null, clarify: state.clarify ? { ...state.clarify, pending: action.pending } : null };
    case "turn_succeeded": {
      const response = action.response;
      if (response.status === "needs_input") {
        return {
          phase: "clarifying",
          intent: null,
          error: null,
          pendingReferences: {},
          preview: null,
          journey: null,
          journeyAnswers: {},
          clarify: {
            status: "needs_input",
            questions: response.questions,
            assumptions: response.assumptions,
            draft: response.draft ?? null,
            sentence: null,
            thread: response.thread ?? null,
            pending: null,
          },
        };
      }
      if (response.status === "planned") {
        return {
          phase: restingPhase(response.intent),
          intent: response.intent,
          error: null,
          pendingReferences: {},
          preview: response.preview ?? null,
          journey: response.journey && response.journey.intentId === response.intent.id ? response.journey : null,
          journeyAnswers: {},
          clarify: {
            status: "planned",
            questions: [],
            assumptions: response.assumptions,
            draft: null,
            sentence: response.sentence,
            thread: response.thread ?? null,
            pending: null,
          },
        };
      }
      // Cancelled: the task is closed.
      return INITIAL_INTENT_SESSION_STATE;
    }
    case "turn_failed": {
      // A refusal keeps the card and the thread as they were (nothing lost).
      const clarify = state.clarify ? { ...state.clarify, pending: null } : null;
      if (clarify?.status === "needs_input") return { ...state, phase: "clarifying", error: action.error, clarify };
      if (state.intent) return { ...state, phase: restingPhase(state.intent), error: action.error, clarify };
      return { ...state, phase: "idle", error: action.error, clarify };
    }
    case "journey_updated":
      if (!state.intent || action.journey.intentId !== state.intent.id) return state;
      return { ...state, journey: action.journey };
    case "journey_answered": {
      const consequence = state.journey?.consequences.find((entry) => entry.id === action.consequenceId);
      if (!consequence || !consequence.options.some((option) => option.id === action.optionId)) return state;
      return { ...state, journeyAnswers: { ...state.journeyAnswers, [action.consequenceId]: action.optionId } };
    }
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
  /**
   * Ask for the asset-change preview ("fare breakdown") with every plan
   * (`state.preview`). With `onPreview`, `execute()` hands that preview to
   * the SDK's preview gate, so a fare that changes is shown again first.
   */
  readonly preview?: boolean;
  /** `executeIntent`'s preview gate: resolve true only once the user approved the fare. */
  readonly onPreview?: ExecuteIntentOptions["onPreview"];
  /** `executeIntent`'s review hook for custom-contract steps: resolve true only once the user confirmed. */
  readonly onReview?: ExecuteIntentOptions["onReview"];
  /** Called when the owner's rule book holds the intent for approval; `execute()` then stops without signing. */
  readonly onApprovalRequired?: ExecuteIntentOptions["onApprovalRequired"];
  /** Where the money starts: a network key or `"auto"` (sent with every turn). */
  readonly sourceNetwork?: SourceNetwork;
  /**
   * Read the journey (where the money is after every step) with every plan
   * and on step changes during `execute()` (`state.journey`); its open
   * blockers stop `execute()` before the wallet until `answerJourney`.
   */
  readonly journey?: boolean;
}

/**
 * What to plan: intent text (a clarify turn starting a new task), or a
 * structured request without `accounts` (taken from the config).
 */
export type PlanInput = string | (Omit<IntentRequest, "accounts"> & { readonly accounts?: readonly AccountId[] });

/** An answer to an open clarify question: one of its options, or typed text. */
export type ClarifyAnswerInput =
  | { readonly questionId: string; readonly optionId: string }
  | { readonly questionId: string; readonly text: string };

export interface IntentSession {
  getState(): IntentSessionState;
  subscribe(listener: () => void): () => void;
  /** Latest accounts, signers and options (the hook calls it after every render). */
  configure(config: IntentSessionConfig): void;
  /**
   * Plans an intent; resolves with it, or null when it asked a question
   * (`phase: "clarifying"`), failed or was superseded (see `error`). Text
   * always goes through a clarify turn and starts a new task.
   */
  plan(input: PlanInput): Promise<IntentGraph | null>;
  /**
   * A message for the current task (a follow-up such as "make it 50", or an
   * answer typed as text); without a task it starts one like `plan(text)`.
   */
  say(text: string): Promise<IntentGraph | null>;
  /** Answers an open question; ignored (null) when that question is no longer open. */
  answer(input: ClarifyAnswerInput): Promise<IntentGraph | null>;
  /** Picks another value for one of Kletia's assumptions and re-plans. */
  chooseAssumption(assumptionId: string, optionId: string): Promise<IntentGraph | null>;
  /** Records the answer to a journey prompt (an option the consequence offers). */
  answerJourney(consequenceId: string, optionId: string): void;
  /**
   * Opens a stored intent (e.g. one your backend created with its key) so
   * `execute()` can run it; with `preview`, its latest preview is loaded too.
   */
  open(intentId: string): Promise<IntentGraph | null>;
  /**
   * Turns a session your backend created (`cs_…`) into an intent for the
   * configured accounts (`POST /v1/sessions/{id}/intents`) so `execute()`
   * can run it. `hostOrigin` (default `location.origin`) must be one of the
   * session's `allowedOrigins`; `amount` must be within its bounds.
   */
  startSession(sessionId: string, options?: StartSessionOptions): Promise<IntentGraph | null>;
  /** Executes the planned intent with the configured signers; resolves with the latest intent, or null. */
  execute(): Promise<IntentGraph | null>;
  /** Stops a running execution, then cancels the intent on Kletia (refused once a step was submitted). */
  cancel(): Promise<IntentGraph | null>;
  /** Forgets the intent and stops a running execution. */
  reset(): void;
  /** Starts accepting work (mount). The returned function detaches (unmount): it aborts execution and ignores late results. */
  attach(): () => void;
}

export interface StartSessionOptions {
  readonly hostOrigin?: string;
  readonly amount?: string;
}

function pageOrigin(): string | null {
  const value = (globalThis as { location?: { origin?: unknown } }).location?.origin;
  return typeof value === "string" && value !== "null" ? value : null;
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

  /** The request context every plan and turn carries (accounts, departure, slippage, metadata). */
  const contextOf = (request: { readonly constraints?: IntentRequest["constraints"]; readonly metadata?: Readonly<Record<string, string>> } = {}) => {
    const constraints =
      config.maxSlippageBps !== undefined && request.constraints?.maxSlippageBps === undefined
        ? { ...request.constraints, maxSlippageBps: config.maxSlippageBps }
        : request.constraints;
    const metadata = request.metadata ?? config.metadata;
    return {
      ...(config.sourceNetwork ? { sourceNetwork: config.sourceNetwork } : {}),
      ...(constraints ? { constraints } : {}),
      ...(metadata ? { metadata } : {}),
    };
  };

  /**
   * One clarify turn. `fresh` starts a new task (a new sentence); otherwise
   * the turn continues the thread on screen. A response for a thread that
   * was superseded or reset meanwhile is dropped.
   */
  const runTurn = async (input: Pick<IntentTurnRequest, "text" | "answer" | "assumption">, pending: ClarifyPending, fresh: boolean): Promise<IntentGraph | null> => {
    if (attached === 0) return null;
    const thread = fresh ? null : store.getState().clarify?.thread ?? null;
    stopExecution();
    planning?.abort();
    epoch += 1;
    const mine = epoch;
    dispatch({ type: "turn_started", pending, fresh });
    if (config.accounts.length === 0) {
      dispatch({ type: "turn_failed", error: missing("Connect at least one account to plan an intent.") });
      return null;
    }
    const controller = new AbortController();
    planning = controller;
    const memory = thread ? ("spec" in thread ? { thread } : { threadId: thread.id }) : {};
    try {
      const response = await client.intents.turn(
        { accounts: config.accounts, ...contextOf(), ...memory, ...input },
        {
          signal: controller.signal,
          ...(config.dryRun ? { dryRun: true } : {}),
          ...(config.preview ? { preview: true } : {}),
          ...(config.journey ? { journey: true } : {}),
        },
      );
      if (mine !== epoch) return null;
      dispatch({ type: "turn_succeeded", response });
      return response.status === "planned" ? response.intent : null;
    } catch (error) {
      if (mine !== epoch) return null;
      dispatch({ type: "turn_failed", error });
      return null;
    } finally {
      if (planning === controller) planning = null;
    }
  };

  const plan = async (input: PlanInput): Promise<IntentGraph | null> => {
    if (attached === 0) return null;
    if (typeof input === "string") {
      const text = input.trim();
      if (!text) {
        stopExecution();
        planning?.abort();
        epoch += 1;
        dispatch({ type: "plan_failed", error: missing("Describe the intent to plan.") });
        return null;
      }
      return runTurn({ text }, { kind: "message" }, true);
    }
    stopExecution();
    planning?.abort();
    epoch += 1;
    const mine = epoch;
    const request = input;
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
    try {
      const body = { ...request, accounts, ...contextOf(request) };
      const options = { signal: controller.signal, ...(config.dryRun ? { dryRun: true } : {}) };
      const created = config.journey
        ? await client.intents.create(body, { ...options, journey: true })
        : config.preview
          ? { ...(await client.intents.create(body, { ...options, preview: true })), journey: null }
          : { intent: await client.intents.create(body, options), preview: null, journey: null };
      if (mine !== epoch) return null;
      dispatch({ type: "plan_succeeded", intent: created.intent, preview: created.preview, journey: created.journey });
      return created.intent;
    } catch (error) {
      if (mine !== epoch) return null;
      dispatch({ type: "plan_failed", error });
      return null;
    } finally {
      if (planning === controller) planning = null;
    }
  };

  const say = async (text: string): Promise<IntentGraph | null> => {
    const message = text.trim();
    if (!message) return null;
    const state = store.getState();
    return runTurn({ text: message }, { kind: "message" }, !state.clarify?.thread);
  };

  const answer = async (input: ClarifyAnswerInput): Promise<IntentGraph | null> => {
    const clarify = store.getState().clarify;
    // After a reset, a new sentence or a planned turn, the question is gone: nothing is sent.
    if (!clarify || clarify.status !== "needs_input" || clarify.pending || !clarify.questions.some((question) => question.id === input.questionId)) return null;
    if ("optionId" in input) {
      return runTurn({ answer: { question: input.questionId, option: input.optionId } }, { kind: "answer", questionId: input.questionId, optionId: input.optionId }, false);
    }
    const text = input.text.trim();
    if (!text) return null;
    return runTurn({ answer: { question: input.questionId, text } }, { kind: "answer", questionId: input.questionId }, false);
  };

  const chooseAssumption = async (assumptionId: string, optionId: string): Promise<IntentGraph | null> => {
    const state = store.getState();
    const clarify = state.clarify;
    if (!clarify || clarify.pending || state.phase === "executing" || state.phase === "cancelling") return null;
    const assumption = clarify.assumptions.find((entry) => entry.id === assumptionId);
    if (!assumption || !assumption.alternatives.some((option) => option.id === optionId)) return null;
    return runTurn({ assumption: { id: assumptionId, option: optionId } }, { kind: "assumption", assumptionId, optionId }, false);
  };

  /** The journey after the steps changed (where the money is now); a failed read keeps the last one. */
  const readJourney = async (intentId: string, mine: number) => {
    try {
      const journey = await client.intents.journey(intentId);
      if (mine === epoch) dispatch({ type: "journey_updated", journey });
    } catch {
      // The last journey stays on screen.
    }
  };

  const answerJourney = (consequenceId: string, optionId: string) => {
    dispatch({ type: "journey_answered", consequenceId, optionId });
  };

  const open = async (intentId: string): Promise<IntentGraph | null> => {
    if (attached === 0) return null;
    stopExecution();
    planning?.abort();
    epoch += 1;
    const mine = epoch;
    const controller = new AbortController();
    planning = controller;
    dispatch({ type: "plan_started" });
    try {
      const intent = await client.intents.get(intentId, { signal: controller.signal });
      let preview: IntentPreview | null = null;
      if (config.preview) {
        preview = await client.intents.getPreview(intent.id, { signal: controller.signal }).catch(() =>
          client.intents.preview(intent.id, { signal: controller.signal }).catch(() => null),
        );
      }
      if (mine !== epoch) return null;
      dispatch({ type: "plan_succeeded", intent, preview });
      return intent;
    } catch (error) {
      if (mine !== epoch) return null;
      dispatch({ type: "plan_failed", error });
      return null;
    } finally {
      if (planning === controller) planning = null;
    }
  };

  const startSession = async (sessionId: string, options: StartSessionOptions = {}): Promise<IntentGraph | null> => {
    if (attached === 0) return null;
    stopExecution();
    planning?.abort();
    epoch += 1;
    const mine = epoch;
    dispatch({ type: "plan_started" });
    const hostOrigin = options.hostOrigin ?? pageOrigin();
    if (config.accounts.length === 0) {
      dispatch({ type: "plan_failed", error: missing("Connect at least one account to run this session.") });
      return null;
    }
    if (!hostOrigin) {
      dispatch({ type: "plan_failed", error: missing("A session runs only on an http(s) page listed in its allowedOrigins.") });
      return null;
    }
    const controller = new AbortController();
    planning = controller;
    try {
      const { intent } = await client.sessions.createIntent(
        sessionId,
        { accounts: config.accounts, hostOrigin, ...(options.amount ? { amount: options.amount } : {}) },
        { signal: controller.signal },
      );
      let preview: IntentPreview | null = null;
      if (config.preview) {
        preview = await client.intents.preview(intent.id, { signal: controller.signal, maxRetries: 0 }).catch(() =>
          client.intents.getPreview(intent.id, { signal: controller.signal }).catch(() => null),
        );
      }
      if (mine !== epoch) return null;
      dispatch({ type: "plan_succeeded", intent, preview: preview && preview.intentId === intent.id ? preview : null });
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
    if (state.journey && openBlockers(state.journey, state.journeyAnswers).length > 0) {
      dispatch({ type: "execute_failed", error: missing("Answer the journey's open question before signing."), pendingReferences: state.pendingReferences });
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
        // The preview gate only runs with the preview the user saw (an API without previews keeps the SDK default).
        ...(config.onPreview && state.preview ? { onPreview: config.onPreview, preview: state.preview } : {}),
        ...(config.onReview ? { onReview: config.onReview } : {}),
        ...(config.onApprovalRequired ? { onApprovalRequired: config.onApprovalRequired } : {}),
        // The journey is read on step changes only (the SDK spaces reads); open blockers stop before the wallet.
        ...(config.journey && state.journey
          ? {
              journeyAnswers: state.journeyAnswers,
              onJourney: (journey: Journey) => {
                if (mine === epoch) dispatch({ type: "journey_updated", journey });
              },
            }
          : {}),
      });
      if (mine !== epoch) return null;
      dispatch({ type: "execute_succeeded", intent: final });
      if (config.journey && state.journey) void readJourney(final.id, mine);
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
        if (mine === epoch && config.journey && state.journey) void readJourney(intent.id, mine);
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
    say,
    answer,
    chooseAssumption,
    answerJourney,
    open,
    startSession,
    execute,
    cancel,
    reset,
    attach,
  };
}
