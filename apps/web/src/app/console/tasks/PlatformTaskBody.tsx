/**
 * A platform task (console design 3.6, 3.7 and 5.5): one sentence planned by
 * Platform API v1 on all nine networks, and everything after it.
 *
 * - No wallet: a dry run with the preview accounts and its fare
 *   (`?dryRun=true&preview=true`), plus the exact connect buttons the plan
 *   needs; once they are connected it plans again with the user's accounts.
 * - Wallets: a persisted plan with the lane-homed accounts (never the
 *   wallet's current chain), then review, signing and progress through
 *   `IntentExecutionFlow`, with this task's own resume key and the desk's
 *   signing lock (one task signs at a time).
 * - SOURCE_REQUIRED: the candidate networks as one-tap chips that plan the
 *   task again from there; SOURCE_UNREACHABLE: its message.
 * - INTENT_UNSUPPORTED: a network engine task (the sentence or departure
 *   names Base, Arbitrum One or Arc), the engine offer, or the "not
 *   supported" panel. Every other refusal is shown as is.
 *
 * Mounted for as long as the task exists: unmounting the execution would
 * cancel its run and refuse any open gate.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Map as MapIcon } from "lucide-react";
import { CHAINS, type AccountId, type IntentGraph, type IntentPreview, type IntentStep, type NetworkKey } from "@kletia/core";

import { PLATFORM_ORIGIN } from "../../../shared/platform/kletiaClient";
import { previewAccountsForLane } from "../../../shared/platform/previewAccounts";
import { sameOwner } from "../../../shared/platform/intentBinding";
import { useIntentExecution, type IntentExecutionError } from "../../../shared/platform/useIntentExecution";
import { shortenAddress } from "../../../shared/wallet/types";
import { IntentExecutionFlow } from "../../site/intent/IntentExecutionFlow";
import { IntentGraphView } from "../../site/intent/IntentGraphView";
import { Button, ButtonLink } from "../../site/ui/Button";
import { DESK_COPY } from "../content/copy";
import { planPreview, type DeskPlanFailure } from "../hooks/planPreview";
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
import { PlanFailurePanel } from "./PlanFailurePanel";
import { PlanningSkeleton } from "./PlanningSkeleton";
import { PreviewTaskBody } from "./PreviewTaskBody";
import { SourceChips } from "./SourceChips";
import { TaskTicket } from "./TaskTicket";
import { missingWallets, routePlanFailure, taskStatusOf } from "./taskModel";

const copy = DESK_COPY.tasks;

interface DryRun {
  readonly intent: IntentGraph;
  readonly preview: IntentPreview | null;
}

/** How the next plan is asked for: the departure (a source chip may change it), or a defaultNetwork-only retry. */
interface PlanOptions {
  readonly departure: Departure;
  readonly defaultOnly: NetworkKey | null;
}

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
  });
  const [options, setOptions] = useState<PlanOptions>({ departure: task.departure, defaultOnly: null });
  const [dry, setDry] = useState<DryRun | null>(null);
  const [failure, setFailure] = useState<DeskPlanFailure | null>(null);
  const [dryRunning, setDryRunning] = useState(false);
  const [changing, setChanging] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const aliveRef = useRef(false);
  const startedRef = useRef(false);
  const handledErrorRef = useRef<IntentExecutionError | null>(null);
  const replannedForRef = useRef<string | null>(null);
  /** Breaks the cycle between the dry run and failure routing (a missing wallet runs a dry run). */
  const handleFailureRef = useRef<(failure: DeskPlanFailure, plan: PlanOptions, source: "dry" | "plan") => void>(() => undefined);

  const patch = useCallback((next: TaskPatch) => getDeskStore().getState().patchTask(task.id, next), [task.id]);
  const evmAddress = actions.accounts.evm?.address ?? null;
  const solanaAddress = actions.accounts.solana?.address ?? null;
  const plannerFor = useCallback(
    (departure: Departure) => accountsForLane({ evm: evmAddress, solana: solanaAddress }, laneOf(departure), departure),
    [evmAddress, solanaAddress],
  );

  const requestFor = useCallback(
    (accounts: readonly AccountId[], plan: PlanOptions) => ({
      text: task.sentence,
      accounts,
      ...(plan.defaultOnly ? { defaultNetwork: plan.defaultOnly } : departureRequestFields(plan.departure)),
      metadata: { surface: "console" },
    }),
    [task.sentence],
  );

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const dryRun = useCallback(
    async (accounts: readonly AccountId[], plan: PlanOptions): Promise<void> => {
      setDryRunning(true);
      patch({ status: "planning" });
      const result = await planPreview(PLATFORM_ORIGIN, requestFor(accounts, plan)).catch(() => null);
      if (!aliveRef.current) return;
      setDryRunning(false);
      if (!result) return;
      if (result.ok) {
        setDry({ intent: result.intent, preview: result.preview });
        patch({ status: "preview", title: result.intent.summary.title, ends: journeyEnds(result.intent) });
        return;
      }
      handleFailureRef.current(result.failure, plan, "dry");
    },
    [patch, requestFor],
  );

  /** Routes a failed plan (console design 3.6). `source` says which call failed. */
  const handleFailure = useCallback(
    (planFailure: DeskPlanFailure, plan: PlanOptions, source: "dry" | "plan") => {
      const route = routePlanFailure(planFailure, { text: task.sentence, departure: plan.departure });
      switch (route.kind) {
        case "needs-wallet": {
          // A dry run already had demo accounts for every namespace: never loop, show the refusal.
          if (source === "dry") {
            setFailure(planFailure);
            patch({ status: "failed" });
            return;
          }
          // Show the fare with demo accounts for the namespaces that are not connected.
          const real = plannerFor(plan.departure);
          const demo = previewAccountsForLane(laneOf(plan.departure)).filter(
            (preview) => !real.some((account) => account.split(":")[0] === preview.split(":")[0]),
          );
          void dryRun([...real, ...demo], plan);
          return;
        }
        case "source": {
          setFailure(planFailure);
          patch({ status: "question" });
          // The SDK in this round drops `details`: ask the dry run once for the candidates.
          if (source === "plan" && !planFailure.details) {
            void planPreview(PLATFORM_ORIGIN, requestFor(plannerFor(plan.departure), plan))
              .then((result) => {
                if (aliveRef.current && !result.ok && result.failure.code === planFailure.code) setFailure(result.failure);
              })
              .catch(() => undefined);
          }
          return;
        }
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
    [dryRun, patch, plannerFor, requestFor, task.sentence],
  );
  useEffect(() => {
    handleFailureRef.current = handleFailure;
  }, [handleFailure]);

  /** Plans the task (again): with the user's accounts when a wallet is connected, else a dry run. */
  const run = useCallback(
    async (plan: PlanOptions) => {
      if (!task.sentence) return;
      setOptions(plan);
      setFailure(null);
      setChanging(false);
      handledErrorRef.current = null;
      const accounts = plannerFor(plan.departure);
      if (accounts.length === 0) {
        setDry(null);
        await dryRun(previewAccountsForLane(laneOf(plan.departure)), plan);
        return;
      }
      patch({ status: "planning" });
      await execution.plan(requestFor(accounts, plan));
    },
    [dryRun, execution, patch, plannerFor, requestFor, task.sentence],
  );

  // A new task plans once (StrictMode remounts keep the started flag).
  useEffect(() => {
    if (startedRef.current || task.restored || !task.sentence) return;
    startedRef.current = true;
    void run(options);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per task
  }, []);

  // A plan with the user's accounts failed: route it.
  useEffect(() => {
    const error = execution.error;
    if (execution.status !== "failed" || execution.intent || !error || handledErrorRef.current === error) return;
    handledErrorRef.current = error;
    handleFailure(toDeskFailure(error), options, "plan");
  }, [execution.error, execution.intent, execution.status, handleFailure, options]);

  // The task follows its execution (status, intent, title, where it starts and ends).
  const intentId = execution.intent?.id ?? null;
  const intentTitle = execution.intent?.summary.title ?? null;
  useEffect(() => {
    const status = taskStatusOf(execution.status);
    if (!status || (status === "failed" && !intentId)) return;
    const intent = execution.intent;
    patch({ status, ...(intent ? { intentId: intent.id, title: intent.summary.title, ends: journeyEnds(intent) } : {}) });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the intent's identity and title are the dependencies
  }, [execution.status, intentId, intentTitle, patch]);

  // In preview: plan again with the user's accounts once every wallet the plan needs is connected.
  const connectedKey = `${evmAddress ?? ""}|${solanaAddress ?? ""}`;
  useEffect(() => {
    if (!dry || execution.intent || execution.status === "planning") return;
    if (missingWallets(dry.intent, actions.accounts.connected).length > 0) return;
    if (replannedForRef.current === connectedKey) return;
    replannedForRef.current = connectedKey;
    void run(options);
  }, [actions.accounts.connected, connectedKey, dry, execution.intent, execution.status, options, run]);

  const shown: IntentGraph | null = execution.intent ?? dry?.intent ?? null;
  const line = useMemo(() => {
    if (!shown) return null;
    const first = [...shown.steps].sort((a, b) => a.index - b.index)[0];
    const network = shown.interpretation?.departure?.network ?? first?.network;
    const symbol = first?.input?.symbol;
    const holding = network && symbol ? actions.holdings?.byNetwork[network]?.top.find((entry) => entry.symbol === symbol) : undefined;
    return departureLine({ requested: options.departure, intent: shown, holding: holding ? `${holding.formatted} ${holding.symbol}` : null });
  }, [actions.holdings, options.departure, shown]);

  const replannable = execution.status === "idle" || execution.status === "review" || execution.status === "failed";
  const lineAction =
    line?.action === "change" && replannable ? (
      <button type="button" className="underline underline-offset-2" onClick={() => setChanging((current) => !current)} aria-expanded={changing}>
        {DESK_COPY.ticket.lines.change}
      </button>
    ) : line?.action === "start-from-requested" && options.departure !== "auto" ? (
      <button type="button" className="underline underline-offset-2" onClick={() => void run({ departure: options.departure, defaultOnly: options.departure as NetworkKey })}>
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
  const replan = () => void run(options);

  const sourceChips = (planFailure: DeskPlanFailure | null) => (
    <SourceChips
      lane={lane}
      details={planFailure?.details ?? null}
      holdings={actions.holdings}
      exclude={options.departure}
      onChoose={(network) => void run({ departure: network, defaultOnly: null })}
    />
  );

  const outcomeFooter = (
    <div className="flex flex-col gap-4">
      {execution.intent ? (
        <Journey taskId={task.id} phase="after" intent={execution.intent} preview={execution.preview} holdings={actions.holdings} lane={lane} onFollowUp={(text, departure) => actions.fill(text, departure ? { departure } : {})} />
      ) : null}
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
    </div>
  );

  let body: React.ReactNode;
  if (resumable) {
    body = (
      <div className="kl-rise flex flex-col gap-3 border-[3px] border-control bg-surface p-4 shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569]">
        <p className="font-display text-lg font-bold">{copy.pickUp}</p>
        <p className="text-sm">{copy.sentenceForgotten}</p>
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
  } else if (failure) {
    body = (
      <PlanFailurePanel
        failure={failure}
        route={routePlanFailure(failure, { text: task.sentence, departure: options.departure })}
        sourceChips={sourceChips(failure)}
        onRetry={replan}
        onAskEngine={(network) => patch({ engine: { kind: "network", network, why: "offer" }, status: "engine" })}
        onHint={(hint) => actions.fill(hint)}
      />
    );
  } else if (execution.intent) {
    body = (
      <>
        {changing ? sourceChips(null) : null}
        <IntentExecutionFlow
          execution={execution}
          describeAccount={describeAccount}
          walletFor={walletFor}
          onReplan={replan}
          showGraph={false}
          notifyProgress
          signingBlockedReason={terminal ? null : signingBlocked}
          beforeBody={
            execution.intent && !terminal ? (
              <Journey
                taskId={task.id}
                phase={execution.status === "review" || execution.status === "planning" ? "review" : "live"}
                intent={execution.intent}
                preview={execution.preview}
                holdings={actions.holdings}
                lane={lane}
                onFollowUp={(text, departure) => actions.fill(text, departure ? { departure } : {})}
              />
            ) : null
          }
          outcomeFooter={outcomeFooter}
        />
        {execution.intent ? (
          <details className="border-2 border-control bg-surface" onToggle={(event) => setMapOpen(event.currentTarget.open)}>
            <summary className="flex min-h-11 cursor-pointer items-center gap-2 px-3 text-xs font-black uppercase tracking-wider">
              <MapIcon className="h-4 w-4" aria-hidden="true" />
              {copy.routeMap}
            </summary>
            {mapOpen ? (
              <div className="overflow-x-auto p-3">
                <IntentGraphView intent={execution.intent} phases={execution.stepPhases} />
              </div>
            ) : null}
          </details>
        ) : null}
      </>
    );
  } else if (dry) {
    body = (
      <>
        {changing ? sourceChips(null) : null}
        <PreviewTaskBody
          intent={dry.intent}
          preview={dry.preview}
          missing={missingWallets(dry.intent, actions.accounts.connected)}
          replanning={execution.status === "planning"}
          journey={<Journey taskId={task.id} phase="review" intent={dry.intent} preview={dry.preview} holdings={actions.holdings} lane={lane} onFollowUp={(text, departure) => actions.fill(text, departure ? { departure } : {})} />}
        />
      </>
    );
  } else if (dryRunning || execution.status === "planning" || task.status === "planning") {
    body = <PlanningSkeleton label={dryRunning || plannerFor(options.departure).length === 0 ? copy.planningPreview : copy.planning} />;
  } else {
    body = <p className="text-sm font-semibold text-muted">{task.restored ? copy.sentenceForgotten : copy.planning}</p>;
  }

  return (
    <>
      <TaskTicket task={task} ends={ends} departureLine={line} lineAction={lineAction} />
      {body}
    </>
  );
}
