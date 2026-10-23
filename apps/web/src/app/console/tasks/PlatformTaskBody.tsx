/**
 * A platform task (console design 3.6, 3.7 and 5.5; clarify design 5.4 and
 * 8): one sentence planned by Platform API v1 on all nine networks, through
 * clarify turns, and everything after it.
 *
 * - Every turn is a dry run with its fare and itinerary
 *   (`POST /v1/intents?clarify=true&dryRun=true&preview=true&journey=true`):
 *   the user's accounts where a wallet is connected, the demo accounts for
 *   the rest (never read, never signed for). Kletia asks (`needs_input`:
 *   the question slot), plans (the fare, the itinerary, "Kletia assumed"
 *   chips), or closes the task (`cancelled`).
 * - Answers, assumption chips and follow-ups ("make it 2", "undo",
 *   "cancel", typed with the composer's Editing chip) arrive as the task's
 *   turns and go out with this task's own thread, never another task's. A
 *   refused turn leaves the plan and the question as they were.
 * - "Review and sign" sends the commit turn (the thread, no input, not a
 *   dry run, the user's accounts only): the stored intent goes to
 *   `IntentExecutionFlow` (review with the journey and its prompts, signing,
 *   progress, outcome), with this task's own resume key and the desk's
 *   signing lock (one task signs at a time). An edit after that cancels the
 *   stored intent (nothing was signed) and plans again.
 * - SOURCE_REQUIRED: the candidate networks as one-tap chips that plan the
 *   task again from there; INTENT_UNSUPPORTED: a network engine task, the
 *   engine offer, or the "not supported" panel; any other refusal as is.
 *
 * Mounted for as long as the task exists: unmounting the execution would
 * cancel its run and refuse any open gate.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Map as MapIcon } from "lucide-react";
import {
  CHAINS,
  type AccountId,
  type ClarifyAssumption,
  type ClarifyThread,
  type IntentGraph,
  type IntentPreview,
  type IntentStep,
  type Journey,
  type NetworkKey,
} from "@kletia/core";

import { getKletiaClient, PLATFORM_ORIGIN } from "../../../shared/platform/kletiaClient";
import { postIntentTurn, turnResponseOf, type TurnResponse } from "../../../shared/platform/platformApi";
import { previewAccountsForLane } from "../../../shared/platform/previewAccounts";
import { sameOwner } from "../../../shared/platform/intentBinding";
import { useIntentExecution, type IntentExecutionError } from "../../../shared/platform/useIntentExecution";
import { shortenAddress } from "../../../shared/wallet/types";
import { IntentExecutionFlow } from "../../site/intent/IntentExecutionFlow";
import { displayDecimal } from "../../site/intent/format";
import { IntentGraphView } from "../../site/intent/IntentGraphView";
import { runPhaseOf } from "../../site/intent/stepPhase";
import { Button, ButtonLink } from "../../site/ui/Button";
import { DESK_COPY } from "../content/copy";
import { failureFromBody, type DeskPlanFailure } from "../hooks/planPreview";
import { useDeskSlots } from "../hooks/useDeskSlots";
import { useSigningLock } from "../hooks/useSigningLock";
import { useDeskActions } from "../shell/deskContext";
import { DESK_MORE_COPY } from "../shell/deskCopy";
import {
  accountsForLane,
  departureLine,
  departureRequestFields,
  journeyEnds,
  laneOf,
  type Departure,
} from "../state/deskModel";
import { deskIntentSessionKey } from "../state/deskSession";
import { getDeskStore, type TaskPatch, type TaskRecord } from "../state/deskStore";
import { ModelReadingCard } from "./ModelReadingCard";
import { mintReadingConsent, readingAvailable, readingPreference, rememberReadingPreference, walletOfAccount } from "./modelReading";
import { PlanFailurePanel } from "./PlanFailurePanel";
import { RoutePanel } from "./RoutePanel";
import { PlanningSkeleton } from "./PlanningSkeleton";
import { PreviewTaskBody } from "./PreviewTaskBody";
import { answerTarget, deskQuestionFrom, responseLabel, turnRequest, type TurnContext, type TurnInput } from "./questionModel";
import type { DeskQuestion } from "./slots";
import { SourceChips } from "./SourceChips";
import { TaskTicket } from "./TaskTicket";
import { missingWallets, routePlanFailure, signatureStateOf, taskStatusOf, venueChangeNote } from "./taskModel";

const copy = DESK_COPY.tasks;

interface DryPlan {
  readonly intent: IntentGraph;
  readonly preview: IntentPreview | null;
  readonly journey: Journey | null;
  readonly assumptions: readonly ClarifyAssumption[];
}

/** How the next plan is asked for: the departure (a source chip may change it), or a defaultNetwork-only retry. */
interface PlanOptions {
  readonly departure: Departure;
  readonly defaultOnly: NetworkKey | null;
}

type TurnOutcome = { readonly ok: true; readonly response: TurnResponse } | { readonly ok: false; readonly failure: DeskPlanFailure };

function toDeskFailure(error: IntentExecutionError): DeskPlanFailure {
  return {
    code: error.code,
    message: error.message,
    status: error.platform?.status ?? 0,
    issues: error.platform?.issues.map((issue) => ({ path: issue.path ?? "", message: issue.message })) ?? [],
    hints: error.hints ?? [],
    details: error.details ?? null,
    requestId: error.platform?.requestId ?? null,
    retryable: error.retryable,
  };
}

const UNREACHABLE: DeskPlanFailure = {
  code: "UNREACHABLE",
  message: "The Kletia API is unreachable from this browser right now.",
  status: 0,
  issues: [],
  hints: [],
  details: null,
  requestId: null,
  retryable: true,
};

/** A client-held thread blob (the desk never asks Kletia to hold one). */
function threadOf(response: TurnResponse): ClarifyThread | null {
  const thread = response.thread as Partial<ClarifyThread> | null;
  return thread && thread.spec === "kletia.thread/v1" && typeof thread.id === "string" ? (thread as ClarifyThread) : null;
}

function studioHref(text: string, departure: Departure): string {
  const params = new URLSearchParams({ q: text });
  if (departure !== "auto") params.set("from", departure);
  return `/studio?${params.toString()}`;
}

export function PlatformTaskBody({ task }: { readonly task: TaskRecord }) {
  const actions = useDeskActions();
  const lock = useSigningLock(task.id);
  const slots = useDeskSlots();
  const execution = useIntentExecution({
    sessionKey: deskIntentSessionKey(task.id),
    metadata: { surface: "console" },
    acquireSigning: lock.acquire,
    releaseSigning: lock.release,
    signingLockedReason: copy.signingLocked,
    // A journey option that suggests a new intent fills the composer; nothing is planned on its own.
    onFollowUp: (text) => actions.fill(text),
  });
  const [options, setOptions] = useState<PlanOptions>({ departure: task.departure, defaultOnly: null });
  const [dry, setDry] = useState<DryPlan | null>(null);
  const [venueNote, setVenueNote] = useState<string | null>(null);
  const [failure, setFailure] = useState<DeskPlanFailure | null>(null);
  const [turnError, setTurnError] = useState<DeskPlanFailure | null>(null);
  const [turning, setTurning] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [changing, setChanging] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const aliveRef = useRef(false);
  const startedRef = useRef(false);
  const handledErrorRef = useRef<IntentExecutionError | null>(null);
  const replannedForRef = useRef<string | null>(null);
  /** This task's own clarify thread (memory only; mirrored on the task record). */
  const threadRef = useRef<ClarifyThread | null>(task.thread ?? null);
  /** The open question a typed answer (composer Answering chip) is for. */
  const questionRef = useRef<DeskQuestion | null>(null);
  const handledTurnsRef = useRef(task.turns.length);
  /** Model-assisted reading consent for this task's text (A.7.6): sent only after the person chose it. */
  const readingRef = useRef<string | null>(null);
  /** A confirm token, minted when the person clicks "Yes" on a model reading's confirm. */
  const confirmRef = useRef<string | null>(null);
  const [readingBusy, setReadingBusy] = useState(false);
  /** The last first turn ran with demo accounts only (no wallet connected). */
  const plannedWithoutWallet = useRef(false);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const optionsRef = useRef(options);
  const executionRef = useRef(execution);
  const dryRef = useRef(dry);
  useEffect(() => {
    optionsRef.current = options;
    executionRef.current = execution;
    dryRef.current = dry;
  });

  const patch = useCallback((next: TaskPatch) => getDeskStore().getState().patchTask(task.id, next), [task.id]);
  const evmAddress = actions.accounts.evm?.address ?? null;
  const solanaAddress = actions.accounts.solana?.address ?? null;
  const plannerFor = useCallback(
    (departure: Departure) => accountsForLane({ evm: evmAddress, solana: solanaAddress }, laneOf(departure), departure),
    [evmAddress, solanaAddress],
  );

  /** The request context: the user's accounts, plus demo accounts for the namespaces not connected on a dry run. */
  const contextFor = useCallback(
    (plan: PlanOptions, mode: "dry" | "commit"): TurnContext => {
      const real = plannerFor(plan.departure);
      const demo = previewAccountsForLane(laneOf(plan.departure)).filter(
        (preview) => !real.some((account) => account.split(":")[0] === preview.split(":")[0]),
      );
      const accounts: AccountId[] = mode === "commit" ? real : [...real, ...demo];
      return {
        accounts,
        ...(plan.defaultOnly ? { defaultNetwork: plan.defaultOnly } : departureRequestFields(plan.departure)),
        metadata: { surface: "console" },
      };
    },
    [plannerFor],
  );

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  /** One clarify turn with this task's thread. Never throws. */
  const sendTurn = useCallback(
    async (input: TurnInput, plan: PlanOptions, mode: "dry" | "commit"): Promise<TurnOutcome> => {
      const base = turnRequest(contextFor(plan, mode), threadRef.current, input, task.sentence);
      // A consent the person gave goes with text turns; text typed in the desk input is "typed" (session consent).
      const consent = input.kind === "answer" ? confirmRef.current : readingRef.current;
      const request =
        consent && (input.kind === "answer" || base.text !== undefined)
          ? { ...base, ...(input.kind === "answer" ? {} : { modelReading: "on" as const }), consent, textOrigin: task.origin ? ("prefilled" as const) : ("typed" as const) }
          : base;
      try {
        const exchange = await postIntentTurn(
          PLATFORM_ORIGIN,
          request,
          mode === "dry" ? { dryRun: true, preview: true, journey: true } : { dryRun: false, preview: true, journey: true },
        );
        const response = turnResponseOf(exchange);
        if (response) return { ok: true, response };
        if (exchange.ok) {
          return { ok: false, failure: { ...failureFromBody(502, null, exchange.requestId), code: "INVALID_RESPONSE", message: "The Kletia API returned a turn this page cannot read." } };
        }
        return { ok: false, failure: failureFromBody(exchange.status, exchange.body, exchange.requestId) };
      } catch {
        return { ok: false, failure: UNREACHABLE };
      }
    },
    [contextFor, task.origin, task.sentence],
  );

  /** What a turn's response does to the task (both dry runs and the commit turn). */
  const apply = useCallback(
    (response: TurnResponse, mode: "dry" | "commit"): void => {
      const thread = threadOf(response);
      threadRef.current = thread ?? threadRef.current;
      const turn = { kind: "kletia" as const, at: Date.now(), label: responseLabel(response) };
      setTurnError(null);
      setFailure(null);
      if (response.status === "needs_input") {
        const question = deskQuestionFrom(response);
        questionRef.current = question;
        setDry(null);
        if (!question) {
          setFailure({ ...UNREACHABLE, code: "NEEDS_INPUT", status: 200, retryable: false, message: "Kletia needs more detail than it can ask here. Type the task again with the amount, the asset and the networks." });
          patch({ status: "failed", question: null, thread: threadRef.current, turn });
          return;
        }
        // One answer field: the card's own (the composer is not armed as a second one; 1-9 still chooses from it).
        patch({ status: "question", question, thread: threadRef.current, turn });
        return;
      }
      if (response.status === "cancelled") {
        questionRef.current = null;
        setDry(null);
        patch({ status: "cancelled", question: null, thread: threadRef.current, turn });
        return;
      }
      questionRef.current = null;
      const intent = response.intent;
      const journey = response.journey && response.journey.intentId === intent.id ? response.journey : null;
      const preview = response.preview && response.preview.intentId === intent.id ? response.preview : null;
      if (mode === "commit") {
        const adopted = executionRef.current.adopt(intent, preview, journey);
        if (adopted) {
          // The stored plan is quoted afresh: say so when it moved to another venue (never silently).
          const note = venueChangeNote(dryRef.current?.intent ?? null, intent);
          setVenueNote(note);
          if (note) patch({ turn: { kind: "note", at: Date.now(), text: note } });
          setDry(null);
          patch({ question: null, intentId: intent.id, title: intent.summary.title, ends: journeyEnds(intent), thread: threadRef.current });
        }
        return;
      }
      setDry({ intent, preview, journey, assumptions: response.assumptions ?? [] });
      patch({ status: "preview", question: null, title: intent.summary.title, ends: journeyEnds(intent), thread: threadRef.current, turn });
    },
    [patch],
  );

  /** Routes a failed first turn (console design 3.6). */
  const handleFailure = useCallback(
    (planFailure: DeskPlanFailure, plan: PlanOptions) => {
      const route = routePlanFailure(planFailure, { text: task.sentence, departure: plan.departure });
      switch (route.kind) {
        case "source":
          setFailure(planFailure);
          patch({ status: "question" });
          return;
        case "understood":
          // Understood but not routable: a neutral note (and a wallet to connect), never a network engine.
          setFailure(planFailure);
          patch({ status: "unsupported" });
          return;
        case "unsupported":
          if (route.route.engine === "network") {
            patch({ engine: { kind: "network", network: route.route.network, why: "fallback" }, status: "engine" });
            return;
          }
          setFailure(planFailure);
          patch({ status: "unsupported" });
          return;
        default:
          setFailure(planFailure);
          patch({ status: "failed" });
      }
    },
    [patch, task.sentence],
  );

  /** Runs one step at a time: turns never overlap, so each one carries the thread the last one returned. */
  const enqueue = useCallback((step: () => Promise<void>) => {
    queueRef.current = queueRef.current.then(step).catch(() => undefined);
  }, []);

  /** Plans the task from its sentence (a new thread): first turn, a source chip, "start from" instead. */
  const run = useCallback(
    (plan: PlanOptions) => {
      if (!task.sentence) return;
      enqueue(async () => {
        setOptions(plan);
        optionsRef.current = plan;
        setFailure(null);
        setTurnError(null);
        setChanging(false);
        setDry(null);
        setVenueNote(null);
        handledErrorRef.current = null;
        threadRef.current = null;
        setTurning(true);
        patch({ status: "planning", question: null, thread: null });
        plannedWithoutWallet.current = plannerFor(plan.departure).length === 0;
        const outcome = await sendTurn({ kind: "text", text: task.sentence }, plan, "dry");
        if (!aliveRef.current) return;
        setTurning(false);
        if (outcome.ok) apply(outcome.response, "dry");
        else handleFailure(outcome.failure, plan);
      });
    },
    [apply, enqueue, handleFailure, patch, plannerFor, sendTurn, task.sentence],
  );

  /** A stored plan that was never signed is cancelled before the task plans again (clarify 5.4). */
  const dropStoredPlan = useCallback(async (): Promise<boolean> => {
    const current = executionRef.current;
    const intent = current.intent;
    if (!intent) return true;
    if (current.status !== "review" && current.status !== "idle" && !(current.status === "failed" && !intent.steps.some((step) => (step.references?.length ?? 0) > 0))) {
      return false;
    }
    try {
      await getKletiaClient().intents.cancel(intent.id);
    } catch {
      // It expires on its own after 30 minutes unprepared; nothing was signed for it.
    }
    current.reset();
    return true;
  }, []);

  /** A follow-up on this task: an answer, an assumption chip, an edit, or a plan again with the same thread. */
  const followUp = useCallback(
    (input: TurnInput, restoreQuestion: DeskQuestion | null) => {
      enqueue(async () => {
        if (!threadRef.current) {
          patch({ turn: { kind: "note", at: Date.now(), text: "This task's memory is gone (the page reloaded). Type the task again." } });
          return;
        }
        if (!(await dropStoredPlan())) {
          patch({ turn: { kind: "note", at: Date.now(), text: "This task is signing: it cannot change now. Type a new task instead." } });
          return;
        }
        setTurning(true);
        setTurnError(null);
        let outcome = await sendTurn(input, optionsRef.current, "dry");
        // The person clicked "Yes" on a model reading's confirm: the desk mints the wallet-bound confirm token and sends it once.
        const wallet = walletOfAccount(contextFor(optionsRef.current, "dry").accounts?.[0]);
        if (!outcome.ok && outcome.failure.code === "CONFIRM_AUTHORITY_REQUIRED" && input.kind === "answer" && wallet && threadRef.current) {
          confirmRef.current = await mintReadingConsent(PLATFORM_ORIGIN, { scope: "confirm", wallet, threadId: threadRef.current.id });
          if (confirmRef.current) outcome = await sendTurn(input, optionsRef.current, "dry");
          confirmRef.current = null;
        }
        if (!aliveRef.current) return;
        setTurning(false);
        if (outcome.ok) {
          apply(outcome.response, "dry");
          return;
        }
        // A refused turn changes nothing: the plan and the question stay as they were.
        setTurnError(outcome.failure);
        patch({
          turn: { kind: "note", at: Date.now(), text: outcome.failure.message },
          ...(restoreQuestion ? { question: restoreQuestion, status: "question" as const } : {}),
        });
      });
    },
    [apply, contextFor, dropStoredPlan, enqueue, patch, sendTurn],
  );

  /** "Read once" / "Allow for this session": mint the consent, then plan the task again with model-assisted reading. */
  const readWithModel = useCallback(
    (scope: "once" | "session") => {
      void (async () => {
        const wallet = walletOfAccount(contextFor(optionsRef.current, "dry").accounts?.[0]);
        if (!wallet || !task.sentence) return;
        setReadingBusy(true);
        const token = await mintReadingConsent(PLATFORM_ORIGIN, scope === "once" ? { scope, wallet, text: task.sentence } : { scope, wallet });
        if (!aliveRef.current) return;
        setReadingBusy(false);
        if (!token) {
          patch({ turn: { kind: "note", at: Date.now(), text: "Model-assisted reading is not available right now. Rewrite the task in Kletia's words." } });
          return;
        }
        if (scope === "session") rememberReadingPreference("session");
        readingRef.current = token;
        run(optionsRef.current);
      })();
    },
    [contextFor, patch, run, task.sentence],
  );

  /** "Review and sign": the commit turn stores the plan with the user's accounts. */
  const review = useCallback(() => {
    enqueue(async () => {
      if (!threadRef.current) return;
      setCommitting(true);
      setTurnError(null);
      const outcome = await sendTurn({ kind: "none" }, optionsRef.current, "commit");
      if (!aliveRef.current) return;
      setCommitting(false);
      if (!outcome.ok) {
        setTurnError(outcome.failure);
        patch({ turn: { kind: "note", at: Date.now(), text: outcome.failure.message } });
        return;
      }
      apply(outcome.response, outcome.response.status === "planned" ? "commit" : "dry");
    });
  }, [apply, enqueue, patch, sendTurn]);

  // A new task plans once (StrictMode remounts keep the started flag).
  useEffect(() => {
    if (startedRef.current || task.restored || !task.sentence) return;
    startedRef.current = true;
    run(options);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per task
  }, []);

  // Answers, assumption chips and edits arrive as the task's turns (the card, the composer's chips).
  useEffect(() => {
    const turns = task.turns;
    for (let index = handledTurnsRef.current; index < turns.length; index += 1) {
      const turn = turns[index];
      if (!turn) continue;
      if (turn.kind === "answer") {
        const question = questionRef.current;
        const answer = turn.answer ?? (question ? { question: answerTarget(question), text: turn.label } : null);
        if (answer) followUp({ kind: "answer", answer }, question);
      } else if (turn.kind === "edit") {
        followUp({ kind: "text", text: turn.text }, null);
      } else if (turn.kind === "assumption") {
        followUp({ kind: "assumption", id: turn.id, option: turn.option }, null);
      }
    }
    handledTurnsRef.current = turns.length;
  }, [followUp, task.turns]);

  // The stored plan failed before it existed (the commit was refused by the hook): route it.
  useEffect(() => {
    const error = execution.error;
    if (execution.status !== "failed" || execution.intent || !error || handledErrorRef.current === error) return;
    handledErrorRef.current = error;
    handleFailure(toDeskFailure(error), options);
  }, [execution.error, execution.intent, execution.status, handleFailure, options]);

  // The task follows its execution (status, intent, title, where it starts and ends, and
  // whether anything was signed: the ticket never reads "signed" before a signature exists).
  const intentId = execution.intent?.id ?? null;
  const intentTitle = execution.intent?.summary.title ?? null;
  const signature = signatureStateOf(execution.intent, execution.stepPhases, execution.signatureUnknownStepIds);
  useEffect(() => {
    const status = taskStatusOf(execution.status);
    if (!status || (status === "failed" && !intentId)) return;
    const intent = execution.intent;
    patch({ status, signature, ...(intent ? { intentId: intent.id, title: intent.summary.title, ends: journeyEnds(intent) } : {}) });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the intent's identity and title are the dependencies
  }, [execution.status, intentId, intentTitle, patch, signature]);

  // A dry plan made with demo accounts: plan the same thread again once every wallet it needs is connected.
  const connectedKey = `${evmAddress ?? ""}|${solanaAddress ?? ""}`;
  useEffect(() => {
    if (!dry || execution.intent || turning) return;
    if (missingWallets(dry.intent, actions.accounts.connected).length > 0) return;
    const usedDemo = dry.intent.request.accounts.some((account) => previewAccountsForLane(laneOf(options.departure)).includes(account));
    if (!usedDemo || replannedForRef.current === connectedKey) return;
    replannedForRef.current = connectedKey;
    followUp({ kind: "none" }, null);
  }, [actions.accounts.connected, connectedKey, dry, execution.intent, followUp, options.departure, turning]);

  // A sentence understood but not routable from demo accounts: plan it again once a wallet is connected.
  const anyWallet = actions.accounts.connected.evm || actions.accounts.connected.solana;
  const understoodRef = useRef<string | null>(null);
  useEffect(() => {
    if (!failure || turning || !anyWallet) return;
    if (routePlanFailure(failure, { text: task.sentence, departure: options.departure }).kind !== "understood") return;
    if (understoodRef.current === connectedKey) return;
    understoodRef.current = connectedKey;
    if (failure.status !== 0 && plannedWithoutWallet.current) run(options);
  }, [anyWallet, connectedKey, failure, options, run, task.sentence, turning]);

  const shown: IntentGraph | null = execution.intent ?? dry?.intent ?? null;
  const line = useMemo(() => {
    if (!shown) return null;
    const first = [...shown.steps].sort((a, b) => a.index - b.index)[0];
    const network = shown.interpretation?.departure?.network ?? first?.network;
    const symbol = first?.input?.symbol;
    const holding = network && symbol ? actions.holdings?.byNetwork[network]?.top.find((entry) => entry.symbol === symbol) : undefined;
    return departureLine({ requested: options.departure, intent: shown, holding: holding ? `${displayDecimal(holding.formatted)} ${holding.symbol}` : null });
  }, [actions.holdings, options.departure, shown]);

  const replannable = !turning && (execution.status === "idle" || execution.status === "review" || execution.status === "failed");
  const lineAction =
    line?.action === "change" && replannable ? (
      <button type="button" className="underline underline-offset-2" onClick={() => setChanging((current) => !current)} aria-expanded={changing}>
        {DESK_COPY.ticket.lines.change}
      </button>
    ) : line?.action === "start-from-requested" && options.departure !== "auto" ? (
      <button type="button" className="underline underline-offset-2" onClick={() => run({ departure: options.departure, defaultOnly: options.departure as NetworkKey })}>
        {DESK_COPY.ticket.lines.startFromInstead(CHAINS[options.departure as NetworkKey].shortName)}
      </button>
    ) : null;

  const describeAccount = useCallback(
    (accountId: AccountId) => {
      for (const account of [actions.accounts.evm, actions.accounts.solana]) {
        if (account && sameOwner(account.accountId, accountId)) return `${account.walletName} · ${shortenAddress(account.address)}`;
      }
      return null;
    },
    [actions.accounts.evm, actions.accounts.solana],
  );
  const walletFor = useCallback(
    (step: IntentStep) => {
      for (const account of [actions.accounts.evm, actions.accounts.solana]) {
        if (account && sameOwner(account.accountId, step.account)) return account.walletName;
      }
      return null;
    },
    [actions.accounts.evm, actions.accounts.solana],
  );

  const lane = laneOf(options.departure);
  const { Journey } = slots;
  const ends = shown ? journeyEnds(shown) : task.ends;
  const terminal = execution.status === "completed" || execution.status === "cancelled";
  const signingBlocked = lock.lockedByOther ? copy.signingLocked : null;
  const resumable = task.restored && execution.status === "idle" ? execution.resumableIntentId : null;
  // Refresh quotes, or retry after a failed plan: the same thread plans again (a stored, unsigned plan is dropped first).
  const replan = () => (threadRef.current ? followUp({ kind: "none" }, null) : run(options));

  const sourceChips = (planFailure: DeskPlanFailure | null) => (
    <SourceChips
      lane={lane}
      details={planFailure?.details ?? null}
      holdings={actions.holdings}
      exclude={options.departure}
      onChoose={(network) => run({ departure: network, defaultOnly: null })}
    />
  );

  const outcomeFooter = (
    <div className="flex flex-wrap gap-3">
      {ends && ends.to !== ends.from ? (
        <Button size="sm" onClick={() => actions.setDeparture(ends.to)}>
          {DESK_COPY.departure.continueFrom(CHAINS[ends.to].shortName)}
        </Button>
      ) : null}
      <Button size="sm" variant="secondary" onClick={() => actions.fill("")}>
        {copy.planAnother}
      </Button>
      {task.sentence ? (
        <ButtonLink to={studioHref(task.sentence, options.departure)} size="sm" variant="ghost">
          {copy.openInStudio}
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
        </ButtonLink>
      ) : null}
    </div>
  );

  const turnErrorPanel = turnError ? (
    <p role="alert" className="border-l-4 border-[var(--kl-danger)] bg-[var(--kl-danger-bg)] px-3 py-2 text-sm font-bold text-[var(--kl-danger)]">
      {turnError.message}
    </p>
  ) : null;

  let body: React.ReactNode;
  if (resumable) {
    body = (
      <div className="kl-rise flex flex-col gap-3 border-[3px] border-control bg-surface p-4 shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569]">
        <p className="font-display text-lg font-bold">{copy.pickUp}</p>
        <p className="text-sm">{task.origin === "automation" ? copy.automationRun : copy.sentenceForgotten}</p>
        {signingBlocked ? <p className="text-sm font-bold">{signingBlocked}</p> : null}
        <div className="flex flex-wrap gap-3">
          <Button size="sm" disabled={Boolean(signingBlocked)} onClick={() => void execution.resume(resumable)}>
            {copy.resume}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => {
            execution.forgetResumable();
            patch({ status: "cancelled" });
          }}>
            {DESK_MORE_COPY.tasks.dismiss}
          </Button>
        </div>
      </div>
    );
  } else if (task.restored && !task.sentence && task.status === "question") {
    // An open question does not survive a reload (its thread lived in memory only).
    body = (
      <div className="flex flex-col items-start gap-3 border-2 border-dashed border-control bg-surface-2 p-4">
        <p className="text-sm font-semibold">{copy.questionCleared}</p>
        <Button size="sm" variant="secondary" onClick={() => actions.fill("")}>
          Type it again
        </Button>
      </div>
    );
  } else if (failure) {
    const offer = readingAvailable(failure) && readingPreference() !== "off";
    body = (
      <>
      {offer ? <ModelReadingCard busy={readingBusy} typed={!task.origin} onRead={readWithModel} onRewrite={() => actions.fill(task.sentence)} /> : null}
      <PlanFailurePanel
        failure={failure}
        route={routePlanFailure(failure, { text: task.sentence, departure: options.departure })}
        sourceChips={sourceChips(failure)}
        onRetry={replan}
        onAskEngine={(network) => patch({ engine: { kind: "network", network, why: "offer" }, status: "engine" })}
        onHint={(hint) => actions.fill(hint)}
        connect={anyWallet ? [] : ["eip155", "solana"]}
        onConnect={actions.openWallet}
      />
      </>
    );
  } else if (execution.intent) {
    body = (
      <>
        {changing ? sourceChips(null) : null}
        {turnErrorPanel}
        {venueNote && execution.status === "review" ? (
          <p role="status" className="border-l-4 border-[var(--kl-warning)] bg-[var(--kl-warning-bg)] px-3 py-2 text-sm font-bold text-fg">
            {venueNote}
          </p>
        ) : null}
        <IntentExecutionFlow
          execution={execution}
          describeAccount={describeAccount}
          walletFor={walletFor}
          onReplan={replan}
          showGraph={false}
          notifyProgress
          signingBlockedReason={terminal ? null : signingBlocked}
          holdJourneyPrompt={Boolean(task.question)}
          outcomeFooter={outcomeFooter}
        />
        <details className="border-2 border-control bg-surface" onToggle={(event) => setMapOpen(event.currentTarget.open)}>
          <summary className="flex min-h-11 cursor-pointer items-center gap-2 px-3 text-xs font-black uppercase tracking-wider">
            <MapIcon className="h-4 w-4" aria-hidden="true" />
            {copy.routeMap}
          </summary>
          {mapOpen ? (
            <div className="overflow-x-auto p-3">
              <IntentGraphView intent={execution.intent} phases={execution.stepPhases} phaseOf={runPhaseOf(execution)} />
            </div>
          ) : null}
        </details>
      </>
    );
  } else if (dry) {
    const missing = missingWallets(dry.intent, actions.accounts.connected);
    body = (
      <>
        {changing ? sourceChips(null) : null}
        {turnErrorPanel}
        <PreviewTaskBody
          intent={dry.intent}
          preview={dry.preview}
          missing={missing}
          replanning={turning}
          assumptions={dry.assumptions}
          onAssumption={(id, option) => {
            const alternative = dry.assumptions.find((assumption) => assumption.id === id)?.alternatives.find((entry) => entry.id === option);
            patch({ turn: { kind: "assumption", at: Date.now(), id, option, label: alternative?.label ?? option } });
          }}
          {...(missing.length === 0 ? { onReview: review } : {})}
          reviewing={committing}
          reviewBlocked={signingBlocked}
          journey={<Journey taskId={task.id} phase="review" intent={dry.intent} preview={dry.preview} journey={dry.journey} holdings={actions.holdings} lane={lane} onFollowUp={(text, departure) => actions.fill(text, departure ? { departure } : {})} />}
        />
        <RoutePanel intent={dry.intent} assumptions={dry.assumptions} />
      </>
    );
  } else if (task.question) {
    // The question slot above carries the card; a refused answer explains itself here.
    body = turnErrorPanel ?? (turning ? <PlanningSkeleton label={copy.planning} /> : null);
  } else if (turning || task.status === "planning") {
    body = <PlanningSkeleton label={plannerFor(options.departure).length === 0 ? copy.planningPreview : copy.planning} />;
  } else {
    body = turnErrorPanel ?? <p className="text-sm font-semibold text-muted">{task.restored ? copy.sentenceForgotten : copy.planning}</p>;
  }

  return (
    <>
      <TaskTicket task={task} ends={ends} departureLine={line} lineAction={lineAction} />
      {body}
    </>
  );
}
