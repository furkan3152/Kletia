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
 *
 * Before any wallet prompt the user sees, and must approve:
 * - the fare (asset-change preview): plans ask for it, confirming approves
 *   the fare on screen, and its digest goes to prepare as
 *   `acknowledgedPreview`. A fare that changed (`PREVIEW_CHANGED`, or a
 *   prepared payload whose fare differs) opens a `fare` gate; nothing is
 *   signed until the user approves the new fare. A blocking preview issue
 *   is never signed through.
 * - every custom-contract step's prepared review (a `review` gate).
 * A Rule Book hold (`POLICY_APPROVAL_REQUIRED`) pauses with `policyHold`.
 *
 * The journey (where the money is after every step) is read with the plan
 * and on step changes only (the SDK spaces the reads; nothing polls it).
 * Its open blockers stop a run before the wallet until the user answers
 * them (`answerJourney`); answers are kept per intent and consequence,
 * with the facts they answered, in memory and the tab's sessionStorage.
 * Options act through the hook: `replan` plans again, `stop` ends the
 * intent at its current stop (`stop()`), `retry` resumes, `plan-new`
 * hands the sentence to the host (`onFollowUp`).
 *
 * A host that runs several executions (the desk at /app) passes a signing
 * lock (`acquireSigning` / `releaseSigning`): every run, a resume included,
 * takes the lock before anything is prepared and gives it back when the run
 * ends, so two wallet prompts can never race. A refused lock pauses with
 * nothing prepared. Each host instance resumes only its own `sessionKey`.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  KletiaExecutionError,
  KletiaPreviewChangedError,
  executeIntent,
  type KletiaClient,
  type PreviewGateContext,
} from "@kletia/sdk";
import {
  openBlockers,
  type AccountId,
  type IntentGraph,
  type IntentPreview,
  type IntentStep,
  type Journey,
  type StepPreview,
} from "@kletia/core";
import {
  blockingIssuesFor,
  cleanText,
  consequenceFactsKey,
  httpsUrl,
  JOURNEY_HANDLE_IT_OPTION,
  validJourneyAnswers,
  type JourneyAnswerMemory,
} from "@kletia/widget/review";
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
} from "./intentBinding";
import { getKletiaClient } from "./kletiaClient";
import { signingRefusal } from "./signingGuard";
import { useIntentSigners } from "./useIntentSigners";
import type {
  ExecutionGate,
  IntentExecution,
  IntentExecutionError,
  IntentExecutionStatus,
  IntentRequestInput,
  LocalStepPhase,
  PolicyHold,
  ResumeOptions,
  UseIntentExecutionOptions,
} from "./useIntentExecution/types";
import {
  applyEvent,
  isAbort,
  isIntentGraph,
  loadPreview,
  localError,
  LocalPlanError,
  MAX_STREAM_RECONNECTS,
  observeClient,
  readJourneyMemory,
  requestFromGraph,
  STABLE_STREAM_MS,
  stepTitle,
  stepWasSubmitted,
  TERMINAL_INTENT,
  terminalStatus,
  toExecutionError,
  wait,
  writeJourneyMemory,
} from "./useIntentExecution/helpers";

export * from "./useIntentExecution/types";
export { journeyAnswersKey } from "./useIntentExecution/helpers";

/**
 * Execute Kletia intents with the wallets connected in `WalletProviders`.
 * See the module comment for the full contract.
 */
export function useIntentExecution(options: UseIntentExecutionOptions = {}): IntentExecution {
  const sessionKey = options.sessionKey === undefined ? STUDIO_INTENT_SESSION_KEY : options.sessionKey;
  const pollIntervalMs = options.pollIntervalMs;
  const connected = useIntentSigners();
  const lockRef = useRef({
    acquire: options.acquireSigning,
    release: options.releaseSigning,
    reason: options.signingLockedReason,
  });

  const [intent, setIntent] = useState<IntentGraph | null>(null);
  const [status, setStatus] = useState<IntentExecutionStatus>("idle");
  const [error, setError] = useState<IntentExecutionError | null>(null);
  const [activeStepId, setActiveStepId] = useState<string | null>(null);
  const [stepPhases, setStepPhases] = useState<Readonly<Record<string, LocalStepPhase>>>({});
  const [pauseReason, setPauseReason] = useState<string | null>(null);
  const [reconfirmStepIds, setReconfirmStepIds] = useState<readonly string[]>([]);
  const [requestedStepIds, setRequestedStepIds] = useState<readonly string[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [resumableIntentId, setResumableIntentId] = useState<string | null>(() =>
    sessionKey ? readIntentSession(sessionKey)?.intentId ?? null : null,
  );
  const [preview, setPreviewState] = useState<IntentPreview | null>(null);
  const [gate, setGate] = useState<ExecutionGate | null>(null);
  const [policyHold, setPolicyHold] = useState<PolicyHold | null>(null);
  const [journey, setJourneyState] = useState<Journey | null>(null);
  const [journeyMemory, setJourneyMemory] = useState<Readonly<Record<string, JourneyAnswerMemory>>>({});
  const [journeyPending, setJourneyPending] = useState<string | null>(null);

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
  const previewRef = useRef<IntentPreview | null>(null);
  /** Digests of fares the user approved (confirming the review approves the fare on screen). */
  const approvedDigestsRef = useRef(new Set<string>());
  const gateResolveRef = useRef<((approved: boolean) => void) | null>(null);
  const journeyRef = useRef<Journey | null>(null);
  const journeyAnswersRef = useRef<Readonly<Record<string, string>>>({});
  const followUpRef = useRef(options.onFollowUp);

  useLayoutEffect(() => {
    connectedRef.current = connected;
    metadataRef.current = options.metadata;
    lockRef.current = { acquire: options.acquireSigning, release: options.releaseSigning, reason: options.signingLockedReason };
    reconfirmStepIdsRef.current = reconfirmStepIds;
    followUpRef.current = options.onFollowUp;
  });

  /** Remembered answers that still fit this journey (asked again when their facts changed). */
  const journeyAnswers = useMemo(() => validJourneyAnswers(journey, journeyMemory), [journey, journeyMemory]);
  useLayoutEffect(() => {
    journeyAnswersRef.current = journeyAnswers;
  }, [journeyAnswers]);

  /** The journey of the current intent (one for another intent is never shown). */
  const setJourney = useCallback((next: Journey | null, intentId: string | null) => {
    const accepted = next && intentId && next.intentId === intentId && Array.isArray(next.consequences) ? next : null;
    const previous = journeyRef.current;
    journeyRef.current = accepted;
    setJourneyState(accepted);
    // A new intent starts with the answers this tab kept for it (none for a fresh plan).
    if (accepted && previous?.intentId !== accepted.intentId) setJourneyMemory(readJourneyMemory(accepted.intentId));
    if (!accepted && intentId === null) setJourneyMemory({});
  }, []);

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

  const setPreview = useCallback((next: IntentPreview | null) => {
    previewRef.current = next;
    setPreviewState(next);
  }, []);

  /** Closes the open gate; anything but an explicit approval means "stop, do not sign". */
  const resolveGate = useCallback((approved: boolean) => {
    const resolve = gateResolveRef.current;
    gateResolveRef.current = null;
    setGate(null);
    resolve?.(approved === true);
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
        setRequestedStepIds((current) => (current.some((stepId) => accepted.includes(stepId)) ? current.filter((stepId) => !accepted.includes(stepId)) : current));
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
      // A pending review never turns into a signature once the view is gone.
      const resolve = gateResolveRef.current;
      gateResolveRef.current = null;
      resolve?.(false);
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
      setRequestedStepIds([]);
      setPolicyHold(null);
      resolveGate(false);
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
        const planned = await client.intents.create(
          {
            ...request,
            accounts,
            ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
          },
          // The journey is read with the plan (it implies the fare); never polled afterwards.
          { journey: true },
        );
        const created = planned.intent;
        if (streamRef.current && streamRef.current.intentId !== created.id) stopStream();
        createdIdsRef.current.add(created.id);
        approvedDigestsRef.current.clear();
        setPreview(planned.preview && planned.preview.intentId === created.id ? planned.preview : null);
        setJourney(planned.journey, created.id);
        commitIntent(created);
        setStatus("review");
        return created;
      } catch (caught) {
        setError(toExecutionError(caught));
        setStatus("failed");
        return null;
      }
    },
    [clearPhases, commitIntent, getClient, resolveAccounts, resolveGate, setJourney, setPreview, stopStream],
  );

  const adopt = useCallback(
    (planned: IntentGraph, plannedPreview: IntentPreview | null, plannedJourney: Journey | null): IntentGraph | null => {
      runRef.current?.controller.abort();
      runRef.current = null;
      setError(null);
      setPauseReason(null);
      setReconfirmStepIds([]);
      setRequestedStepIds([]);
      setPolicyHold(null);
      resolveGate(false);
      clearPhases();
      try {
        // The same refusal as a plan made here: never preview accounts, only wallets connected in this browser.
        resolveAccounts(planned.request.accounts);
        for (const step of planned.steps) if (step.mode === "wallet") resolveAccounts([step.account]);
      } catch (caught) {
        setError(caught instanceof LocalPlanError ? caught.detail : toExecutionError(caught));
        setStatus("failed");
        return null;
      }
      if (streamRef.current && streamRef.current.intentId !== planned.id) stopStream();
      createdIdsRef.current.add(planned.id);
      approvedDigestsRef.current.clear();
      setPreview(plannedPreview && plannedPreview.intentId === planned.id ? plannedPreview : null);
      setJourney(plannedJourney, planned.id);
      commitIntent(planned);
      setStatus(terminalStatus(planned) ?? "review");
      return planned;
    },
    [clearPhases, commitIntent, resolveAccounts, resolveGate, setJourney, setPreview, stopStream],
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

  /** References this tab holds for a step that the API has not accepted (memory first, then the session record). */
  const recordedReferences = useCallback(
    (intentId: string, stepId: string): readonly string[] => {
      const fromMemory = referencesRef.current.get(`${intentId}:${stepId}`) ?? [];
      if (fromMemory.length > 0) return fromMemory;
      const stored = sessionKey ? readIntentSession(sessionKey) : null;
      return stored?.intentId === intentId ? stored.references[stepId] ?? [] : [];
    },
    [sessionKey],
  );

  /**
   * `confirmedFare`: the user just confirmed the review of this exact plan,
   * so the fare on screen counts as approved. Otherwise (resume, a plan made
   * without a review) the fare is shown again before the first signature.
   */
  const execute = useCallback(
    async (graph: IntentGraph, confirmedFare = false): Promise<IntentGraph | null> => {
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
      // Requests of another intent say nothing about this one.
      if (intentRef.current?.id !== graph.id) setRequestedStepIds([]);
      setResumableIntentId(null);
      setPolicyHold(null);
      resolveGate(false);
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

      // Fail closed: an open journey blocker is answered before anything is prepared.
      const shownJourney = journeyRef.current && journeyRef.current.intentId === graph.id ? journeyRef.current : null;
      if (shownJourney && openBlockers(shownJourney, journeyAnswersRef.current).length > 0) {
        const reason = "Answer the question in the itinerary before the next signature. Nothing was signed.";
        // Nothing sent yet: back to the review, where the question waits; otherwise paused at the stop.
        setStatus(graph.steps.some(stepWasSubmitted) ? "paused" : "review");
        setPauseReason(reason);
        runRef.current = null;
        return null;
      }

      // One execution signs at a time: nothing is prepared without the lock.
      const lock = lockRef.current;
      if (lock.acquire && !lock.acquire()) {
        const reason = lock.reason ?? "Another intent is signing. Finish or stop it first.";
        setError(localError("SIGNING_LOCKED", reason));
        setStatus("paused");
        setPauseReason(reason);
        runRef.current = null;
        return null;
      }
      // The lock goes back when this run ends, unless a newer run of this hook took over.
      const releaseLock = () => {
        if (tokenRef.current === token) lock.release?.();
      };

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
          // The newest version of the step decides: a step whose transaction was already sent is never signed again.
          const latest = intentRef.current?.id === intentId ? intentRef.current.steps.find((step) => step.id === runStep?.id) : undefined;
          const refusal = signingRefusal(latest ?? runStep);
          if (refusal) throw new Error(refusal);
          const problem = transactionBindingProblem(runStep, request);
          if (problem) throw new Error(problem);
        },
        onRequest: () => {
          const step = runStep;
          if (!step) return;
          // A "sign again" confirmation covers one new request only: if this
          // one also ends without a known outcome, the user is asked again.
          allowResignRef.current.delete(markKey(step.id));
          marksRef.current.set(markKey(step.id), "requested");
          if (sessionKey) markStepSigning(sessionKey, intentId, step.id, "requested");
          if (isCurrent()) {
            setRequestedStepIds((current) => (current.includes(step.id) ? current : [...current, step.id]));
            setPhase(step.id, "signing");
          }
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
            if (isCurrent()) setRequestedStepIds((current) => current.filter((stepId) => stepId !== step.id));
          }
          if (isCurrent()) setPhase(step.id, null);
        },
      });

      let pausedFor: IntentStep[] = [];
      /** Why this run stopped without an error (the user stopped at a gate, or a Rule Book hold). */
      let stoppedFor: string | null = null;
      // With a journey for this intent, the SDK reads it on step changes only and stops before
      // a wallet prompt while a blocker of that step is unanswered (fail closed).
      const tracked = journeyRef.current && journeyRef.current.intentId === graph.id;
      const journeyOptions = tracked
        ? {
            journeyAnswers: journeyAnswersRef.current,
            onJourney: (next: Journey) => {
              if (isCurrent()) setJourney(next, graph.id);
            },
            onJourneyBlocked: () => {
              stoppedFor = "Answer the question in the itinerary before the next signature. Nothing was signed for that step.";
            },
          }
        : {};
      const ask = (next: ExecutionGate): Promise<boolean> =>
        new Promise<boolean>((resolve) => {
          if (controller.signal.aborted || !isCurrent()) {
            resolve(false);
            return;
          }
          gateResolveRef.current?.(false);
          gateResolveRef.current = resolve;
          controller.signal.addEventListener("abort", () => {
            if (gateResolveRef.current === resolve) resolveGate(false);
            else resolve(false);
          }, { once: true });
          setGate(next);
        });
      try {
        // The fare the user confirmed in the review; after a reload, the latest kept fare (shown again before signing).
        let shown = previewRef.current && previewRef.current.intentId === graph.id ? previewRef.current : null;
        if (shown && confirmedFare) approvedDigestsRef.current.add(shown.digest);
        // Intents with a plan record come from an API that keeps fares (older APIs and dry runs have none).
        if (!shown && !confirmedFare && graph.plan) {
          shown = await loadPreview(client, graph.id, controller.signal);
          if (!isCurrent()) return null;
          if (shown && shown.intentId === graph.id) setPreview(shown);
          else shown = null;
        }
        const gated = shown;
        let current = await submitStoredReferences(client, graph);
        const ambiguous = ambiguousSteps(current);
        if (ambiguous.length > 0) {
          pausedFor = ambiguous;
        } else {
          current = await executeIntent(observeClient(client, commitIntent), current, signers, {
            signal: controller.signal,
            ...(pollIntervalMs ? { pollIntervalMs } : {}),
            onUpdate: (next) => commitIntent(next),
            ...journeyOptions,
            // The fare gate runs only against an API that returned a fare; without one the
            // SDK still refuses any blocking preview issue on its own.
            ...(gated
              ? {
                  preview: gated,
                  onPreview: async (next: IntentPreview, stepPreview: StepPreview | null, context: PreviewGateContext) => {
                    // Never sign through an issue Kletia marked as blocking, whatever the user clicks.
                    const blocking = blockingIssuesFor(context.step.id, stepPreview, next);
                    if (blocking.length > 0) {
                      if (isCurrent()) setPreview(next);
                      throw new KletiaExecutionError(
                        `Kletia will not sign “${context.step.title}”: ${blocking.map((issue) => issue.message || issue.code).join(" ")}`,
                        context.intent.id,
                        context.step.id,
                      );
                    }
                    if (context.reason === "before-prepare" && approvedDigestsRef.current.has(next.digest)) return true;
                    const approved = await ask({
                      kind: "fare",
                      stepId: context.step.id,
                      stepTitle: stepTitle(context.step),
                      preview: next,
                      previous: previewRef.current,
                      changes: context.changes,
                      reason: context.reason,
                    });
                    if (approved) {
                      approvedDigestsRef.current.add(next.digest);
                      if (isCurrent()) setPreview(next);
                    } else {
                      stoppedFor = `You stopped before signing “${context.step.title}”. Nothing was signed for it. Resume to see its fare again.`;
                    }
                    return approved;
                  },
                }
              : {}),
            onReview: async (step, review, context) => {
              const approved = await ask({
                kind: "review",
                stepId: step.id,
                stepTitle: stepTitle(step),
                stepIndex: step.index,
                review,
                planned: context.planned ?? null,
              });
              if (!approved) stoppedFor = `You stopped before signing “${step.title}”. Nothing was signed for it.`;
              return approved;
            },
            onApprovalRequired: (_approval, policyError) => {
              if (!isCurrent()) return;
              setPolicyHold({ code: policyError.code, message: policyError.message, policy: policyError.policy });
              stoppedFor = "Held for approval: the owner's rule book asks a person to approve this intent before Kletia prepares anything to sign.";
            },
            beforeStep: async (step, latest) => {
              if (controller.signal.aborted || !isCurrent()) return false;
              const blocked = ambiguousSteps(latest).filter((candidate) => candidate.id === step.id);
              if (blocked.length > 0) {
                pausedFor = blocked;
                return false;
              }
              // A transaction this tab recorded for the step: read the step again (the API checks the chain) before any new prompt.
              const recorded = recordedReferences(intentId, step.id);
              if (recorded.length > 0) {
                const fresh = await client.intents.refresh(intentId);
                if (!isCurrent()) return false;
                commitIntent(fresh);
                const again = fresh.steps.find((candidate) => candidate.id === step.id) ?? step;
                const refusal = signingRefusal(again, recordedReferences(intentId, step.id));
                if (refusal) {
                  stoppedFor = refusal;
                  return false;
                }
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
          // Where the money is now: one read once the intent is over.
          if (tracked) void client.intents.journey(current.id).then((next) => setJourney(next, current.id)).catch(() => undefined);
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
          setPauseReason(stoppedFor ?? "Execution stopped before the intent finished. Resume to keep going.");
        }
        return current;
      } catch (caught) {
        if (isAbort(caught, controller.signal) || !isCurrent()) return null;
        runRef.current = null;
        if (caught instanceof KletiaPreviewChangedError) setPreview(caught.preview);
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
      } finally {
        releaseLock();
      }
    },
    [
      ambiguousSteps,
      clearPhases,
      commitIntent,
      getClient,
      pollIntervalMs,
      recordedReferences,
      resolveGate,
      sessionKey,
      setJourney,
      setPhase,
      setPreview,
      startStream,
      submitStoredReferences,
    ],
  );

  const start = useCallback(
    async (input: IntentRequestInput | IntentGraph): Promise<IntentGraph | null> => {
      if (isIntentGraph(input)) {
        if (createdIdsRef.current.has(input.id)) return execute(input, true);
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
      const approved = resumeOptions.approvedPreview && resumeOptions.approvedPreview.intentId === id ? resumeOptions.approvedPreview : null;
      if (approved) {
        createdIdsRef.current.add(id);
        setPreview(approved);
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
      // An intent this hook has no journey for (a reload, a link, an approval): read it once.
      if (journeyRef.current?.intentId !== id) {
        const loaded = await client.intents.journey(id).catch(() => null);
        setJourney(loaded, id);
      }
      const finished = terminalStatus(refreshed);
      if (finished) {
        setStatus(finished);
        if (sessionKey) clearIntentSession(sessionKey);
        return refreshed;
      }
      return execute(refreshed, approved !== null);
    },
    [commitIntent, execute, getClient, sessionKey, setJourney, setPreview],
  );

  const load = useCallback(
    async (intentId: string): Promise<IntentGraph | null> => {
      const client = getClient();
      if (!client) return null;
      let refreshed: IntentGraph;
      try {
        refreshed = await client.intents.refresh(intentId);
      } catch (caught) {
        setError(toExecutionError(caught));
        return null;
      }
      commitIntent(refreshed);
      if (journeyRef.current?.intentId !== intentId) setJourney(await client.intents.journey(intentId).catch(() => null), intentId);
      const finished = terminalStatus(refreshed);
      setError(null);
      setStatus(finished ?? "paused");
      setPauseReason(
        finished
          ? null
          : refreshed.steps.some(stepWasSubmitted)
            ? "Kletia stopped following this intent while you were away. Steps already sent keep settling on-chain and are never signed again; resume to keep tracking them."
            : "Kletia stopped following this intent while you were away. Nothing was signed for it; resume to see its fare again before signing.",
      );
      return refreshed;
    },
    [commitIntent, getClient, setJourney],
  );

  const cancel = useCallback(async () => {
    const current = intentRef.current;
    const signing = Object.values(phasesRef.current).includes("signing");
    resolveGate(false);
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
  }, [clearPhases, commitIntent, getClient, resolveGate, sessionKey, stopStream]);

  const reset = useCallback(() => {
    const current = intentRef.current;
    resolveGate(false);
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
    setPreview(null);
    setJourney(null, null);
    setJourneyPending(null);
    setPolicyHold(null);
    approvedDigestsRef.current.clear();
    setStatus("idle");
    setError(null);
    setPauseReason(null);
    setReconfirmStepIds([]);
    setRequestedStepIds([]);
  }, [clearPhases, resolveGate, sessionKey, setJourney, setPreview, stopStream]);

  const stop = useCallback(async (): Promise<IntentGraph | null> => {
    const current = intentRef.current;
    if (!current || TERMINAL_INTENT.has(current.status)) return current;
    // Never while a wallet is showing a request: rejecting it there is the way to stop now.
    if (Object.values(phasesRef.current).includes("signing")) {
      setError(localError("SIGNING_IN_PROGRESS", "Your wallet is showing a request: reject it there first, then end the journey here."));
      return null;
    }
    const client = getClient();
    if (!client) return null;
    resolveGate(false);
    runRef.current?.controller.abort();
    runRef.current = null;
    clearPhases();
    setJourneyPending("stop");
    try {
      const stopped = await client.intents.stop(current.id);
      commitIntent(stopped.intent);
      setJourney(stopped.journey, stopped.intent.id);
      setError(null);
      setPauseReason(null);
      const finished = terminalStatus(stopped.intent);
      setStatus(finished ?? "paused");
      if (finished && sessionKey) clearIntentSession(sessionKey);
      if (!finished) setPauseReason("The journey ends at its current stop: nothing more will be signed.");
      return stopped.intent;
    } catch (caught) {
      // 409 INTENT_IN_FLIGHT: a step is still moving; the error says when to try again.
      setError(toExecutionError(caught));
      setStatus((previous) => (previous === "executing" ? "paused" : previous));
      return null;
    } finally {
      setJourneyPending(null);
    }
  }, [clearPhases, commitIntent, getClient, resolveGate, sessionKey, setJourney]);

  const answerJourney = useCallback(
    (consequenceId: string, optionId: string) => {
      const current = intentRef.current;
      const shown = journeyRef.current;
      const consequence = shown?.consequences.find((entry) => entry.id === consequenceId);
      if (!current || !shown || shown.intentId !== current.id || !consequence) return;
      const option = consequence.options.find((entry) => entry.id === optionId) ?? null;
      // Only an option the consequence offers counts (or "I will handle it" when it offers no acknowledgement).
      if (!option && optionId !== JOURNEY_HANDLE_IT_OPTION) return;
      setJourneyMemory((memory) => {
        const next = { ...memory, [consequenceId]: { option: optionId, facts: consequenceFactsKey(consequence) } };
        writeJourneyMemory(current.id, next);
        return next;
      });
      const action = option?.action;
      if (!action) return;
      switch (action.type) {
        case "replan":
          // A new plan with its own fare and journey, reviewed before anything is signed.
          setJourneyPending(optionId);
          void plan({ ...action.request, ...(options.metadata && !action.request.metadata ? { metadata: options.metadata } : {}) }).finally(() => setJourneyPending(null));
          return;
        case "plan-new":
          followUpRef.current?.(cleanText(action.text, 1000));
          return;
        case "retry":
          if (!TERMINAL_INTENT.has(current.status)) void resume(current.id);
          return;
        case "stop":
          void stop();
          return;
        case "link": {
          const url = httpsUrl(action.url);
          if (url && typeof window !== "undefined") window.open(url.href, "_blank", "noopener,noreferrer");
          return;
        }
        default:
          // acknowledge: remembered; the next signature may go ahead.
          return;
      }
    },
    [options.metadata, plan, resume, stop],
  );

  const journeyBlockers = useMemo(
    () => (journey && intent && journey.intentId === intent.id && !TERMINAL_INTENT.has(intent.status) ? openBlockers(journey, journeyAnswers) : []),
    [intent, journey, journeyAnswers],
  );

  const accountsForBinding = connected.accounts;
  const bindingProblem = useMemo(
    () => (intent && !TERMINAL_INTENT.has(intent.status) ? findBindingProblem(intent, accountsForBinding) : null),
    [accountsForBinding, intent],
  );

  const signatureUnknownStepIds = useMemo(
    () => [...new Set([...requestedStepIds, ...reconfirmStepIds])],
    [reconfirmStepIds, requestedStepIds],
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
    signatureUnknownStepIds,
    streaming,
    resumableIntentId,
    preview,
    gate,
    resolveGate,
    policyHold,
    bindingProblem,
    plan,
    start,
    resume,
    load,
    cancel,
    reset,
    forgetResumable,
    journey: journey && intent && journey.intentId === intent.id ? journey : null,
    journeyAnswers,
    journeyBlockers,
    journeyPending,
    answerJourney,
    stop,
    adopt,
  };
}
