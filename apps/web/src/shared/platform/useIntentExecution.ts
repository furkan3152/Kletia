/**
 * Shared wallet execution for Kletia intents (Studio, the console's Solana
 * "Ask" tab, the EVM chat handoff and anything else inside WalletProviders).
 *
 * Flow: plan with the REAL connected accounts (persisted `POST /v1/intents`,
 * never a dry run and never the demo preview accounts) -> the caller reviews
 * and confirms -> `executeIntent` prepares, has the matching wallet sign and
 * submits each step while the SSE stream (`/v1/intents/{id}/events`) pushes
 * live progress. Every step that settles or fails lands in the shared
 * activity feed and invalidates the portfolio views it touched.
 *
 * The executing intent id (plus what each wallet already produced) is kept in
 * sessionStorage so a reload can `resume()`: the intent is refreshed, stored
 * references are submitted instead of signing again, and a step whose
 * signature outcome is unknown pauses for an explicit confirmation.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  KletiaApiError,
  KletiaExecutionError,
  executeIntent,
  type KletiaClient,
} from "@kletia/sdk";
import type {
  AccountId,
  AnyKletiaEvent,
  IntentGraph,
  IntentRequest,
  IntentStep,
  StepStatus,
} from "@kletia/core";

import { syncIntentActivity } from "./intentActivity";
import {
  appendStepReference,
  clearIntentSession,
  forgetSteps,
  markStepSigning,
  readIntentSession,
  STUDIO_INTENT_SESSION_KEY,
  updateIntentSession,
  type StepSigningMark,
} from "./intentSession";
import {
  findBindingProblem,
  isNothingSentError,
  isPreviewAccount,
  observeSigners,
  sameOwner,
  transactionBindingProblem,
  type BindingProblem,
} from "./intentBinding";
import { describePlatformError, getKletiaClient, toPlatformError, type PlatformError } from "./kletiaClient";
import { useIntentSigners, type ConnectedIntentSigners } from "./useIntentSigners";

export type IntentExecutionStatus =
  /** Nothing planned yet. */
  | "idle"
  /** Creating the persisted intent with the connected accounts. */
  | "planning"
  /** Persisted plan ready; waiting for the user to confirm. */
  | "review"
  /** Preparing, signing, submitting or waiting for settlement. */
  | "executing"
  /** Stopped without a terminal status (needs the user before continuing). */
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

/** What the browser is doing for a step before the API reports it. */
export type LocalStepPhase = "preparing" | "signing" | "confirming";

export interface IntentExecutionError {
  readonly code: string;
  readonly message: string;
  readonly stepId: string | null;
  readonly retryable: boolean;
  /** Present when the API returned the error. */
  readonly platform: PlatformError | null;
}

/** An intent request whose accounts default to the connected wallets. */
export type IntentRequestInput = Omit<IntentRequest, "accounts"> & {
  readonly accounts?: readonly AccountId[];
};

export interface UseIntentExecutionOptions {
  /** sessionStorage key used to resume after a reload; `null` disables it. */
  readonly sessionKey?: string | null;
  /** Merged into every created intent's metadata (e.g. `{ surface: "studio" }`). */
  readonly metadata?: Readonly<Record<string, string>>;
  /** Settlement poll interval passed to `executeIntent` (default 4000 ms). */
  readonly pollIntervalMs?: number;
}

export interface ResumeOptions {
  /**
   * The user confirmed that a step whose signature was requested before a
   * reload may be signed again (they checked their wallet activity).
   */
  readonly confirmResign?: boolean;
}

export interface IntentExecution extends ConnectedIntentSigners {
  readonly intent: IntentGraph | null;
  readonly status: IntentExecutionStatus;
  readonly error: IntentExecutionError | null;
  /** Step the executor is working on (preparing, signing or confirming). */
  readonly activeStepId: string | null;
  readonly stepPhases: Readonly<Record<string, LocalStepPhase>>;
  /** Why execution is paused, when `status === "paused"`. */
  readonly pauseReason: string | null;
  /** Steps that need an explicit "sign again" confirmation to continue. */
  readonly reconfirmStepIds: readonly string[];
  /** True while the live event stream is connected. */
  readonly streaming: boolean;
  /** Intent stored by a previous page load of this tab, if not yet resumed. */
  readonly resumableIntentId: string | null;
  /**
   * Why the current (non-terminal) intent cannot be signed with the wallets
   * connected right now: a preview account, or a step account that is not
   * connected. Execution refuses to start while this is set.
   */
  readonly bindingProblem: BindingProblem | null;
  /** Persist a plan with the connected accounts for review. No wallet prompt. */
  plan: (request: IntentRequestInput) => Promise<IntentGraph | null>;
  /**
   * Execute an intent. A request (or a graph this hook did not create, such as
   * a dry-run preview) is planned again with the connected accounts first.
   */
  start: (input: IntentRequestInput | IntentGraph) => Promise<IntentGraph | null>;
  /** Refresh a stored or given intent and continue it. Never re-signs a submitted step. */
  resume: (intentId?: string, options?: ResumeOptions) => Promise<IntentGraph | null>;
  /** Stop executing. Cancels the intent server-side when nothing was submitted yet. */
  cancel: () => Promise<void>;
  /** Forget the current intent (a stored resumable record is kept while steps are in flight). */
  reset: () => void;
  /** Drop the stored resumable record. */
  forgetResumable: () => void;
}

const TERMINAL_INTENT = new Set<IntentGraph["status"]>([
  "completed",
  "partially_completed",
  "failed",
  "expired",
  "cancelled",
]);

const STEP_RANK: Readonly<Record<StepStatus, number>> = {
  pending: 0,
  ready: 1,
  awaiting_signature: 2,
  submitted: 3,
  confirmed: 4,
  settling: 5,
  indeterminate: 5,
  settled: 6,
  failed: 6,
  skipped: 6,
};

const MAX_STREAM_RECONNECTS = 3;
/** A stream that stayed open this long is considered healthy when it ends. */
const STABLE_STREAM_MS = 60_000;

function isIntentGraph(value: unknown): value is IntentGraph {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as IntentGraph).id === "string" &&
    Array.isArray((value as IntentGraph).steps)
  );
}

export function isTerminalIntent(intent: IntentGraph | null | undefined): boolean {
  return Boolean(intent && TERMINAL_INTENT.has(intent.status));
}

function terminalStatus(intent: IntentGraph): IntentExecutionStatus | null {
  if (intent.status === "completed") return "completed";
  if (intent.status === "cancelled") return "cancelled";
  if (TERMINAL_INTENT.has(intent.status)) return "failed";
  return null;
}

/** True once the API has accepted a reference for the step (or it moved past signing). */
function stepWasSubmitted(step: IntentStep): boolean {
  return STEP_RANK[step.status] >= STEP_RANK.submitted || (step.references?.length ?? 0) > 0;
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}

function walletMessage(message: string): string {
  if (/user rejected|rejected the request|declined|denied|cancel/iu.test(message)) {
    return "The signature request was declined in your wallet. Nothing was sent for this step.";
  }
  if (/blockhash not found|block height exceeded|expired/iu.test(message)) {
    return "The prepared transaction expired before it was signed. Retry to prepare it again.";
  }
  return message;
}

function toExecutionError(error: unknown): IntentExecutionError {
  if (error instanceof KletiaExecutionError) {
    const cause = error.cause;
    if (cause instanceof KletiaApiError) {
      const platform = toPlatformError(cause);
      return {
        code: platform.code,
        message: describePlatformError(platform),
        stepId: error.stepId,
        retryable: true,
        platform,
      };
    }
    return {
      code: "EXECUTION_FAILED",
      message: walletMessage(error.message),
      stepId: error.stepId,
      retryable: true,
      platform: null,
    };
  }
  if (error instanceof KletiaApiError) {
    const platform = toPlatformError(error);
    return {
      code: platform.code,
      message: describePlatformError(platform),
      stepId: null,
      retryable: platform.retryable || platform.status === 409,
      platform,
    };
  }
  const message = error instanceof Error && error.message ? error.message : "Execution failed.";
  return { code: "CLIENT_ERROR", message: walletMessage(message), stepId: null, retryable: true, platform: null };
}

function localError(code: string, message: string, stepId: string | null = null): IntentExecutionError {
  return { code, message, stepId, retryable: true, platform: null };
}

class LocalPlanError extends Error {
  readonly detail: IntentExecutionError;
  constructor(detail: IntentExecutionError) {
    super(detail.message);
    this.detail = detail;
  }
}

function requestFromGraph(graph: IntentGraph): IntentRequestInput {
  const { request } = graph;
  return {
    ...(request.text ? { text: request.text } : {}),
    ...(request.actions ? { actions: request.actions } : {}),
    ...(request.defaultNetwork ? { defaultNetwork: request.defaultNetwork } : {}),
    ...(request.constraints ? { constraints: request.constraints } : {}),
    ...(request.metadata ? { metadata: request.metadata } : {}),
  };
}

/** Apply one stream event to the local graph. Step status only moves forward. */
function applyEvent(intent: IntentGraph, event: AnyKletiaEvent): IntentGraph | null {
  if (event.type === "intent.step_updated") {
    const { data } = event;
    if (data.intentId !== intent.id) return null;
    let changed = false;
    const steps = intent.steps.map((step) => {
      if (step.id !== data.stepId) return step;
      const nextStatus = STEP_RANK[data.status] > STEP_RANK[step.status] ? data.status : step.status;
      const evidence = data.evidence;
      const hasEvidence =
        !evidence ||
        step.evidence.some(
          (item) =>
            item.kind === evidence.kind &&
            item.network === evidence.network &&
            item.reference === evidence.reference &&
            item.url === evidence.url,
        );
      if (nextStatus === step.status && hasEvidence) return step;
      changed = true;
      return {
        ...step,
        status: nextStatus,
        evidence: hasEvidence || !evidence ? step.evidence : [...step.evidence, evidence],
      };
    });
    return changed ? { ...intent, steps } : null;
  }
  if (event.type === "intent.status_changed") {
    const { data } = event;
    if (data.intentId !== intent.id || data.status === intent.status || TERMINAL_INTENT.has(intent.status)) {
      return null;
    }
    return { ...intent, status: data.status };
  }
  return null;
}

/**
 * The same client, but the intent returned by `prepareStep` (step now
 * awaiting a signature) is committed too; `executeIntent` only reports the
 * versions returned by submit and refresh.
 */
function observeClient(client: KletiaClient, onIntent: (intent: IntentGraph) => void): KletiaClient {
  const observed = Object.create(client) as KletiaClient;
  Object.defineProperty(observed, "intents", {
    value: {
      ...client.intents,
      prepareStep: async (id: string, stepId: string) => {
        const prepared = await client.intents.prepareStep(id, stepId);
        if (prepared?.intent && prepared.intent.id === id) onIntent(prepared.intent);
        return prepared;
      },
    },
  });
  return observed;
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * Execute Kletia intents with the wallets connected in `WalletProviders`.
 * See the module comment for the full contract.
 */
export function useIntentExecution(options: UseIntentExecutionOptions = {}): IntentExecution {
  const sessionKey = options.sessionKey === undefined ? STUDIO_INTENT_SESSION_KEY : options.sessionKey;
  const pollIntervalMs = options.pollIntervalMs;
  const connected = useIntentSigners();

  const [intent, setIntent] = useState<IntentGraph | null>(null);
  const [status, setStatus] = useState<IntentExecutionStatus>("idle");
  const [error, setError] = useState<IntentExecutionError | null>(null);
  const [activeStepId, setActiveStepId] = useState<string | null>(null);
  const [stepPhases, setStepPhases] = useState<Readonly<Record<string, LocalStepPhase>>>({});
  const [pauseReason, setPauseReason] = useState<string | null>(null);
  const [reconfirmStepIds, setReconfirmStepIds] = useState<readonly string[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [resumableIntentId, setResumableIntentId] = useState<string | null>(() =>
    sessionKey ? readIntentSession(sessionKey)?.intentId ?? null : null,
  );

  const intentRef = useRef<IntentGraph | null>(null);
  const connectedRef = useRef(connected);
  const metadataRef = useRef(options.metadata);
  const runRef = useRef<{ token: number; controller: AbortController } | null>(null);
  const tokenRef = useRef(0);
  const streamRef = useRef<{ intentId: string; controller: AbortController } | null>(null);
  const createdIdsRef = useRef(new Set<string>());
  const phasesRef = useRef<Readonly<Record<string, LocalStepPhase>>>({});
  /** In-memory mirror of the session marks (storage may be unavailable). */
  const marksRef = useRef(new Map<string, StepSigningMark>());
  /**
   * In-memory mirror of the references each wallet returned, per
   * `intentId:stepId`. A retry in the same page submits these instead of
   * signing again even when sessionStorage is unavailable.
   */
  const referencesRef = useRef(new Map<string, readonly string[]>());
  const allowResignRef = useRef(new Set<string>());
  const reconfirmStepIdsRef = useRef<readonly string[]>([]);

  useLayoutEffect(() => {
    connectedRef.current = connected;
    metadataRef.current = options.metadata;
    reconfirmStepIdsRef.current = reconfirmStepIds;
  });

  const setPhase = useCallback((stepId: string, phase: LocalStepPhase | null) => {
    const next = { ...phasesRef.current };
    if (phase) next[stepId] = phase;
    else delete next[stepId];
    phasesRef.current = next;
    setStepPhases(next);
  }, []);

  const clearPhases = useCallback(() => {
    phasesRef.current = {};
    setStepPhases({});
    setActiveStepId(null);
  }, []);

  const stopStream = useCallback(() => {
    streamRef.current?.controller.abort();
    streamRef.current = null;
    setStreaming(false);
  }, []);

  /** Single entry point for every new version of the intent. */
  const commitIntent = useCallback(
    (next: IntentGraph) => {
      intentRef.current = next;
      setIntent(next);
      syncIntentActivity(next);
      const accepted = next.steps.filter(stepWasSubmitted).map((step) => step.id);
      if (accepted.length > 0) {
        if (sessionKey) forgetSteps(sessionKey, next.id, accepted);
        for (const stepId of accepted) {
          marksRef.current.delete(`${next.id}:${stepId}`);
          referencesRef.current.delete(`${next.id}:${stepId}`);
        }
        const phases = phasesRef.current;
        if (accepted.some((stepId) => phases[stepId])) {
          const remaining = Object.fromEntries(
            Object.entries(phases).filter(([stepId]) => !accepted.includes(stepId)),
          );
          phasesRef.current = remaining;
          setStepPhases(remaining);
        }
      }
      if (TERMINAL_INTENT.has(next.status) && streamRef.current?.intentId === next.id) {
        // Let the final frames arrive, then close the stream.
        const stream = streamRef.current;
        window.setTimeout(() => {
          if (streamRef.current === stream) {
            stream.controller.abort();
            streamRef.current = null;
            setStreaming(false);
          }
        }, 1_500);
      }
    },
    [sessionKey],
  );

  const startStream = useCallback(
    (client: KletiaClient, intentId: string) => {
      if (streamRef.current?.intentId === intentId) return;
      streamRef.current?.controller.abort();
      const controller = new AbortController();
      const handle = { intentId, controller };
      streamRef.current = handle;
      setStreaming(true);
      void (async () => {
        let lastEventId: string | undefined;
        let failures = 0;
        while (!controller.signal.aborted && failures <= MAX_STREAM_RECONNECTS) {
          const openedAt = Date.now();
          try {
            await client.intents.stream(
              intentId,
              (event) => {
                lastEventId = event.id;
                const current = intentRef.current;
                if (!current || current.id !== intentId) return;
                const patched = applyEvent(current, event);
                if (patched) commitIntent(patched);
              },
              { signal: controller.signal, ...(lastEventId ? { lastEventId } : {}) },
            );
          } catch {
            // Unavailable stream (older API, proxy, network): polling still drives progress.
          }
          if (controller.signal.aborted) break;
          // A long-lived stream that ended normally (the API closes streams after
          // 30 minutes) reconnects freely; short-lived ones count as failures so
          // a misbehaving endpoint cannot turn into a request loop.
          failures = Date.now() - openedAt > STABLE_STREAM_MS ? 1 : failures + 1;
          await wait(3_000 * failures, controller.signal);
        }
        if (streamRef.current === handle) {
          streamRef.current = null;
          setStreaming(false);
        }
      })();
    },
    [commitIntent],
  );

  useEffect(
    () => () => {
      runRef.current?.controller.abort();
      runRef.current = null;
      streamRef.current?.controller.abort();
      streamRef.current = null;
    },
    [],
  );

  const getClient = useCallback((): KletiaClient | null => {
    try {
      return getKletiaClient();
    } catch (caught) {
      setError(toExecutionError(caught));
      setStatus("failed");
      return null;
    }
  }, []);

  /** Connected accounts to plan with; refuses preview accounts and unknown wallets. */
  const resolveAccounts = useCallback((requested?: readonly AccountId[]): readonly AccountId[] => {
    const available = connectedRef.current.accounts.filter((account) => !isPreviewAccount(account));
    if (available.length === 0) {
      throw new LocalPlanError(
        localError("WALLET_REQUIRED", "Connect a wallet first: Kletia plans with your own accounts before you sign."),
      );
    }
    if (!requested || requested.length === 0) return available;
    for (const account of requested) {
      if (isPreviewAccount(account)) {
        throw new LocalPlanError(
          localError("PREVIEW_ACCOUNT", "Demo preview accounts cannot execute. Plan with your connected wallets."),
        );
      }
      if (!available.some((candidate) => sameOwner(candidate, account))) {
        throw new LocalPlanError(
          localError("ACCOUNT_NOT_CONNECTED", "Plan accounts must belong to wallets connected in this browser."),
        );
      }
    }
    return requested;
  }, []);

  const plan = useCallback(
    async (request: IntentRequestInput): Promise<IntentGraph | null> => {
      const client = getClient();
      if (!client) return null;
      runRef.current?.controller.abort();
      runRef.current = null;
      setError(null);
      setPauseReason(null);
      setReconfirmStepIds([]);
      let accounts: readonly AccountId[];
      try {
        accounts = resolveAccounts(request.accounts);
      } catch (caught) {
        setError(caught instanceof LocalPlanError ? caught.detail : toExecutionError(caught));
        setStatus("failed");
        return null;
      }
      setStatus("planning");
      clearPhases();
      const metadata = { ...(metadataRef.current ?? {}), ...(request.metadata ?? {}) };
      try {
        const created = await client.intents.create({
          ...request,
          accounts,
          ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        });
        if (streamRef.current && streamRef.current.intentId !== created.id) stopStream();
        createdIdsRef.current.add(created.id);
        commitIntent(created);
        setStatus("review");
        return created;
      } catch (caught) {
        setError(toExecutionError(caught));
        setStatus("failed");
        return null;
      }
    },
    [clearPhases, commitIntent, getClient, resolveAccounts, stopStream],
  );

  /** Steps prepared before a reload whose signature outcome is unknown. */
  const ambiguousSteps = useCallback(
    (graph: IntentGraph): IntentStep[] => {
      const session = sessionKey ? readIntentSession(sessionKey) : null;
      return graph.steps.filter((step) => {
        if (step.mode !== "wallet" || step.status !== "awaiting_signature") return false;
        if (allowResignRef.current.has(`${graph.id}:${step.id}`)) return false;
        const mark =
          marksRef.current.get(`${graph.id}:${step.id}`) ??
          (session?.intentId === graph.id ? session.signing[step.id] : undefined);
        return mark !== "rejected";
      });
    },
    [sessionKey],
  );

  /** Submit references the wallet already produced (instead of signing again). */
  const submitStoredReferences = useCallback(
    async (client: KletiaClient, graph: IntentGraph): Promise<IntentGraph> => {
      const stored = sessionKey ? readIntentSession(sessionKey) : null;
      const session = stored?.intentId === graph.id ? stored : null;
      let current = graph;
      for (const step of graph.steps) {
        const fromSession = session?.references[step.id] ?? [];
        const fromMemory = referencesRef.current.get(`${graph.id}:${step.id}`) ?? [];
        // Both lists grow in signing order; the longer one has everything the other has.
        const references = fromMemory.length >= fromSession.length ? fromMemory : fromSession;
        if (!references.length) continue;
        if (step.status !== "ready" && step.status !== "awaiting_signature") continue;
        current = await client.intents.submitStep(graph.id, step.id, references);
        commitIntent(current);
      }
      return current;
    },
    [commitIntent, sessionKey],
  );

  const execute = useCallback(
    async (graph: IntentGraph): Promise<IntentGraph | null> => {
      const client = getClient();
      if (!client) return null;
      runRef.current?.controller.abort();
      const controller = new AbortController();
      const token = ++tokenRef.current;
      runRef.current = { token, controller };
      const isCurrent = () => runRef.current?.token === token;

      setError(null);
      setPauseReason(null);
      setReconfirmStepIds([]);
      setResumableIntentId(null);
      clearPhases();
      commitIntent(graph);

      const binding = findBindingProblem(graph, connectedRef.current.accounts);
      if (binding) {
        setError(localError("ACCOUNT_MISMATCH", binding.message, binding.stepId));
        setStatus("paused");
        setPauseReason(binding.message);
        runRef.current = null;
        return null;
      }

      setStatus("executing");
      if (sessionKey) updateIntentSession(sessionKey, graph.id, (session) => session);
      startStream(client, graph.id);

      const intentId = graph.id;
      const markKey = (stepId: string) => `${intentId}:${stepId}`;
      // The step this run is signing. Kept per run (not per hook) so a wallet
      // that answers after a cancel still records its reference for the
      // right step, and a stale run never touches the visible phases.
      let runStep: IntentStep | null = null;
      const signers = observeSigners(connectedRef.current.signers, {
        beforeRequest: (request) => {
          // A cancelled, superseded or unmounted run never opens a wallet prompt.
          if (controller.signal.aborted || !isCurrent()) {
            throw new DOMException("Execution was stopped before signing.", "AbortError");
          }
          if (!runStep) throw new Error("Kletia refused to sign: no step is being executed.");
          const problem = transactionBindingProblem(runStep, request);
          if (problem) throw new Error(problem);
        },
        onRequest: () => {
          const step = runStep;
          if (!step) return;
          marksRef.current.set(markKey(step.id), "requested");
          if (sessionKey) markStepSigning(sessionKey, intentId, step.id, "requested");
          if (isCurrent()) setPhase(step.id, "signing");
        },
        onReference: (reference) => {
          const step = runStep;
          if (!step) return;
          const key = markKey(step.id);
          referencesRef.current.set(key, [...(referencesRef.current.get(key) ?? []), reference]);
          if (sessionKey) appendStepReference(sessionKey, intentId, step.id, reference);
          if (isCurrent()) setPhase(step.id, "confirming");
        },
        onReject: (rejection) => {
          const step = runStep;
          if (!step) return;
          // Only a failure that guarantees nothing was broadcast clears the
          // step for a new signature; anything else stays "requested" so the
          // next attempt pauses for an explicit confirmation.
          if (isNothingSentError(rejection)) {
            marksRef.current.set(markKey(step.id), "rejected");
            if (sessionKey) markStepSigning(sessionKey, intentId, step.id, "rejected");
          }
          if (isCurrent()) setPhase(step.id, null);
        },
      });

      let pausedFor: IntentStep[] = [];
      try {
        let current = await submitStoredReferences(client, graph);
        const ambiguous = ambiguousSteps(current);
        if (ambiguous.length > 0) {
          pausedFor = ambiguous;
        } else {
          current = await executeIntent(observeClient(client, commitIntent), current, signers, {
            signal: controller.signal,
            ...(pollIntervalMs ? { pollIntervalMs } : {}),
            onUpdate: (next) => commitIntent(next),
            beforeStep: (step, latest) => {
              if (controller.signal.aborted || !isCurrent()) return false;
              const blocked = ambiguousSteps(latest).filter((candidate) => candidate.id === step.id);
              if (blocked.length > 0) {
                pausedFor = blocked;
                return false;
              }
              runStep = step;
              setActiveStepId(step.id);
              setPhase(step.id, "preparing");
              return true;
            },
          });
        }
        if (!isCurrent()) return current;
        runRef.current = null;
        commitIntent(current);
        clearPhases();
        const finished = terminalStatus(current);
        if (finished) {
          setStatus(finished);
          if (sessionKey) clearIntentSession(sessionKey);
          return current;
        }
        setStatus("paused");
        if (pausedFor.length > 0) {
          setReconfirmStepIds(pausedFor.map((step) => step.id));
          const titles = pausedFor.map((step) => `“${step.title}”`).join(", ");
          setPauseReason(
            `A signature for ${titles} was requested earlier and Kletia never received the result. Check your wallet's recent activity: sign again only if nothing was sent.`,
          );
        } else {
          setPauseReason("Execution stopped before the intent finished. Resume to keep going.");
        }
        return current;
      } catch (caught) {
        if (isAbort(caught, controller.signal) || !isCurrent()) return null;
        runRef.current = null;
        const failure = toExecutionError(caught);
        setError(failure);
        setStatus("failed");
        clearPhases();
        try {
          commitIntent(await client.intents.get(intentId));
        } catch {
          // The last known version stays on screen.
        }
        return null;
      }
    },
    [
      ambiguousSteps,
      clearPhases,
      commitIntent,
      getClient,
      pollIntervalMs,
      sessionKey,
      setPhase,
      startStream,
      submitStoredReferences,
    ],
  );

  const start = useCallback(
    async (input: IntentRequestInput | IntentGraph): Promise<IntentGraph | null> => {
      if (isIntentGraph(input)) {
        if (createdIdsRef.current.has(input.id)) return execute(input);
        // Not persisted with the connected accounts (e.g. a dry-run preview): plan it again.
        const planned = await plan(requestFromGraph(input));
        return planned ? execute(planned) : null;
      }
      const planned = await plan(input);
      return planned ? execute(planned) : null;
    },
    [execute, plan],
  );

  const resume = useCallback(
    async (intentId?: string, resumeOptions: ResumeOptions = {}): Promise<IntentGraph | null> => {
      const id =
        intentId ??
        intentRef.current?.id ??
        (sessionKey ? readIntentSession(sessionKey)?.intentId : undefined);
      if (!id) return null;
      const client = getClient();
      if (!client) return null;
      runRef.current?.controller.abort();
      runRef.current = null;
      if (resumeOptions.confirmResign) {
        for (const stepId of reconfirmStepIdsRef.current) allowResignRef.current.add(`${id}:${stepId}`);
      }
      setError(null);
      setPauseReason(null);
      setResumableIntentId(null);
      setStatus("executing");
      let refreshed: IntentGraph;
      try {
        refreshed = await client.intents.refresh(id);
      } catch (caught) {
        setError(toExecutionError(caught));
        setStatus("failed");
        return null;
      }
      commitIntent(refreshed);
      const finished = terminalStatus(refreshed);
      if (finished) {
        setStatus(finished);
        if (sessionKey) clearIntentSession(sessionKey);
        return refreshed;
      }
      return execute(refreshed);
    },
    [commitIntent, execute, getClient, sessionKey],
  );

  const cancel = useCallback(async () => {
    const current = intentRef.current;
    const signing = Object.values(phasesRef.current).includes("signing");
    runRef.current?.controller.abort();
    runRef.current = null;
    stopStream();
    clearPhases();
    if (!current || TERMINAL_INTENT.has(current.status)) {
      setStatus(current ? terminalStatus(current) ?? "idle" : "idle");
      return;
    }
    const submitted = current.steps.some(stepWasSubmitted);
    if (submitted || signing) {
      setStatus("paused");
      setPauseReason(
        signing
          ? "Stopped following this intent. If your wallet is still showing a request, reject it there."
          : "Stopped following this intent. Steps already submitted keep settling on-chain; resume to keep tracking them.",
      );
      return;
    }
    const client = getClient();
    if (!client) return;
    try {
      commitIntent(await client.intents.cancel(current.id));
      setStatus("cancelled");
      if (sessionKey) clearIntentSession(sessionKey);
    } catch (caught) {
      setError(toExecutionError(caught));
      setStatus("paused");
    }
  }, [clearPhases, commitIntent, getClient, sessionKey, stopStream]);

  const reset = useCallback(() => {
    const current = intentRef.current;
    runRef.current?.controller.abort();
    runRef.current = null;
    stopStream();
    clearPhases();
    if (sessionKey && current && (TERMINAL_INTENT.has(current.status) || !current.steps.some(stepWasSubmitted))) {
      const stored = readIntentSession(sessionKey);
      if (stored?.intentId === current.id) clearIntentSession(sessionKey);
    }
    intentRef.current = null;
    setIntent(null);
    setStatus("idle");
    setError(null);
    setPauseReason(null);
    setReconfirmStepIds([]);
  }, [clearPhases, sessionKey, stopStream]);

  const accountsForBinding = connected.accounts;
  const bindingProblem = useMemo(
    () => (intent && !TERMINAL_INTENT.has(intent.status) ? findBindingProblem(intent, accountsForBinding) : null),
    [accountsForBinding, intent],
  );

  const forgetResumable = useCallback(() => {
    if (sessionKey) clearIntentSession(sessionKey);
    setResumableIntentId(null);
  }, [sessionKey]);

  return {
    ...connected,
    intent,
    status,
    error,
    activeStepId,
    stepPhases,
    pauseReason,
    reconfirmStepIds,
    streaming,
    resumableIntentId,
    bindingProblem,
    plan,
    start,
    resume,
    cancel,
    reset,
    forgetResumable,
  };
}
