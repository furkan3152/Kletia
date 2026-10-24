/**
 * The one desk at /app: a single composer that plans every sentence
 * through Platform API v1 on all nine networks, the departure board, task
 * cards with ticket and fare, holdings, activity and tools, with the
 * network engines (Base, Arbitrum One, Arc) as inline engine tasks loaded
 * only when one is needed.
 *
 * Views (/app, /app/tasks, /app/holdings, /app/activity, /app/tools, /app/perps,
 * /app/orders, /app/dashboard, /app/automations) are the same desk, grouped
 * into six nav sections with sub-tabs (state/deskNav.ts); Perps, Dashboard
 * and Automations load as their own chunks. The thread stays mounted under
 * every view, because unmounting a task's execution would cancel its run. One task signs at a time (the
 * store's signing lock, enforced by the execution hook).
 */
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";
import { CHAINS } from "@kletia/core";

import { useAppStore } from "../../shared/state/useAppStore";
import { useSolanaWallet } from "../../shared/wallet/solana/solanaWalletContext";
import { useSiteTheme } from "../site/useSiteTheme";
import { ActivityPeek, ActivityView } from "./activity/ActivityView";
import { Composer, type ComposerHandle } from "./composer/Composer";
import { DeparturePicker } from "./composer/DeparturePicker";
import { DESK_COPY } from "./content/copy";
import { enterDeskMode, leaveDeskMode } from "./deskMode";
import { HoldingsPanel } from "./holdings/HoldingsPanel";
import { OrdersView } from "./orders/OrdersView";
import { useDeskAccounts } from "./hooks/useDeskAccounts";
import { useDeskUrlState } from "./hooks/useDeskUrlState";
import { useHoldings } from "./hooks/useHoldings";
import { useNetworkStatus } from "./hooks/useNetworkStatus";
import { DeskActionsContext, type DeskActions } from "./shell/deskContext";
import { DeskEmptyState } from "./shell/DeskEmptyState";
import { DeskHeader } from "./shell/DeskHeader";
import { DeskShell } from "./shell/DeskShell";
import { DeskSubNav, DeskViewNav } from "./shell/DeskViewNav";
import { SubagentNotice } from "./shell/SubagentNotice";
import {
  departureCaption,
  departureOptions,
  isLegacyNetwork,
  laneOf,
  routeSubmission,
  type DeskView,
  type LegacyNetwork,
} from "./state/deskModel";
import { rememberView, sectionTarget, type DeskSection, type SectionMemory } from "./state/deskNav";
import { getDeskStore, useDeskStore } from "./state/deskStore";
import { formatUsd, mostFunded } from "./state/holdings";
import { EngineHosts } from "./tasks/EngineHosts";
import { TaskCard } from "./tasks/TaskCard";
import { TaskList } from "./tasks/TaskList";
import { TaskRail } from "./tasks/TaskRail";
import { TaskThread } from "./tasks/TaskThread";
import { ToolsView } from "./tools/ToolsView";

const copy = DESK_COPY;
/** Its own chunk: wallet sign-in and the automation forms load only when the view opens. */
const AutomationsView = lazy(() => import("./automations/AutomationsView"));

/** The Dashboard view, read-only and loaded only when opened. */
const DashboardView = lazy(() => import("./dashboard/DashboardView"));
/** Loaded only when the Perps view opens. */
const PerpsView = lazy(() => import("./perps/PerpsView"));

/** Networks whose engine must be mounted: engine tasks and restored workflow threads. */
function useEngineNetworks(): readonly LegacyNetwork[] {
  const tasks = useDeskStore((state) => state.tasks);
  const messagesByNetwork = useAppStore((state) => state.messagesByNetwork);
  return useMemo(() => {
    const networks = new Set<LegacyNetwork>();
    for (const task of tasks) if (task.engine.kind === "network") networks.add(task.engine.network);
    for (const [network, messages] of Object.entries(messagesByNetwork)) {
      if (isLegacyNetwork(network) && messages.some((message) => message.threadId?.startsWith("wf:"))) networks.add(network);
    }
    return (["base", "arbitrum", "arc"] as const).filter((network) => networks.has(network));
  }, [messagesByNetwork, tasks]);
}

export default function DeskApp() {
  // The site's document mode and theme; the entry already applied both before the first paint of /app.
  useLayoutEffect(() => {
    enterDeskMode();
    return () => leaveDeskMode();
  }, []);
  const { theme, toggle } = useSiteTheme();

  const departure = useDeskStore((state) => state.departure);
  const view = useDeskStore((state) => state.view);
  const toolId = useDeskStore((state) => state.toolId);
  const tasks = useDeskStore((state) => state.tasks);
  const signingTaskId = useDeskStore((state) => state.signingTaskId);
  const enginePin = useDeskStore((state) => state.enginePin);
  const answering = useDeskStore((state) => state.answering);
  const lane = laneOf(departure);

  const accounts = useDeskAccounts(lane, departure);
  const status = useNetworkStatus();
  const holdings = useHoldings(lane, accounts.holdings, signingTaskId !== null);
  const composerRef = useRef<ComposerHandle>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const [boardOpen, setBoardOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const { openConnectModal } = useConnectModal();
  const { openPicker } = useSolanaWallet();
  const workflowResume = useAppStore((state) => state.workflowResume);
  const bindWalletHistory = useAppStore((state) => state.bindWalletHistory);
  const { address, status: accountStatus } = useAccount();
  const engineNetworks = useEngineNetworks();

  // Engine messages belong to the wallet that wrote them (the old console bound them the same way).
  useEffect(() => {
    if (accountStatus === "connected" && address) bindWalletHistory(address);
    else if (accountStatus === "disconnected") bindWalletHistory();
  }, [accountStatus, address, bindWalletHistory]);

  // "Kletia has a question about <title>": once per question that opens (the slot renders it),
  // and cleared once that question is answered or gone, so a screen reader never finds it stale.
  const askedRef = useRef(new Set<string>());
  const announcedRef = useRef<{ readonly taskId: string; readonly questionId: string } | null>(null);
  useEffect(() => {
    for (const task of tasks) {
      if (!task.question || askedRef.current.has(task.question.id)) continue;
      askedRef.current.add(task.question.id);
      announcedRef.current = { taskId: task.id, questionId: task.question.id };
      setAnnouncement(copy.tasks.announcements.question(task.title));
    }
    const announced = announcedRef.current;
    if (announced && tasks.find((task) => task.id === announced.taskId)?.question?.id !== announced.questionId) {
      announcedRef.current = null;
      setAnnouncement("");
    }
  }, [tasks]);

  const submit = useCallback((text: string) => {
    const store = getDeskStore().getState();
    if (store.answering) {
      // Answering mode: the sentence answers that task's open question; it never starts a new task.
      store.patchTask(store.answering, { question: null, turn: { kind: "answer", at: Date.now(), label: text } });
      store.answer(null);
      return;
    }
    const route = routeSubmission({ text, departure: store.departure, enginePin: store.enginePin });
    if (route.engine === "network") {
      store.addTask({ sentence: text, departure: route.network, engine: { kind: "network", network: route.network, why: "tool" }, status: "engine" });
    } else if (route.engine === "rates") {
      // Read-only: answered from the venue list, without a wallet; an engine pin is not needed for it.
      store.addTask({ sentence: text, departure: store.departure, engine: { kind: "rates" } });
    } else if (route.engine === "assistant") {
      // Read-only: answered from the signed-in wallet's data; an action request comes back as sentences to plan.
      store.addTask({ sentence: text, departure: store.departure, engine: { kind: "assistant" } });
    } else {
      store.addTask({ sentence: text, departure: store.departure });
    }
    if (store.view !== "desk") store.setView("desk");
    announcedRef.current = null;
    setAnnouncement(copy.tasks.announcements.added);
  }, []);

  const url = useDeskUrlState(submit);
  const openView = url.openView;
  // Each section reopens on the view the user last had open in it.
  const sectionMemory = useRef<SectionMemory>({});
  useEffect(() => {
    sectionMemory.current = rememberView(sectionMemory.current, view);
  }, [view]);
  const openSection = useCallback((section: DeskSection) => openView(sectionTarget(section, view, sectionMemory.current)), [openView, view]);

  const actions = useMemo<DeskActions>(
    () => ({
      fill(text, options = {}) {
        const store = getDeskStore().getState();
        if (options.engine !== undefined) store.pinEngine(options.engine);
        if (options.departure) store.setDeparture(options.departure);
        composerRef.current?.fill(text);
      },
      openView,
      openWallet(namespace) {
        if (namespace === "eip155") openConnectModal?.();
        else openPicker();
      },
      startEngineTask(sentence, network, why) {
        const store = getDeskStore().getState();
        store.addTask({ sentence, departure: network, engine: { kind: "network", network, why }, status: "engine" });
        openView("desk");
      },
      setDeparture(network) {
        getDeskStore().getState().setDeparture(network);
        composerRef.current?.focus();
      },
      holdings: holdings.snapshot,
      accounts,
    }),
    [accounts, holdings.snapshot, openConnectModal, openPicker, openView],
  );

  const board = useMemo(
    () =>
      departureOptions({
        health: status.health,
        holdings: holdings.snapshot?.byNetwork ?? {},
        wallets: accounts.connected,
        offered: status.offered,
        current: departure,
      }),
    [accounts.connected, departure, holdings.snapshot, status.health, status.offered],
  );
  const best = mostFunded(holdings.snapshot);
  const caption = departureCaption({
    departure,
    holdings: departure === "auto" ? null : (holdings.snapshot?.byNetwork[departure] ?? null),
    walletsConnected: accounts.connected.evm || accounts.connected.solana,
    mostFundedNetwork: best,
  });
  const mostFunds = best && holdings.snapshot ? copy.departure.autoMostFunds(CHAINS[best].shortName, formatUsd(holdings.snapshot.byNetwork[best]!.totalUsd) ?? "") : null;
  const answeringTask = answering ? tasks.find((task) => task.id === answering) ?? null : null;

  const openTask = useCallback(
    (taskId: string) => {
      openView("desk");
      getDeskStore().getState().focusTask(taskId);
    },
    [openView],
  );
  const newTask = useCallback(() => {
    const store = getDeskStore().getState();
    store.answer(null);
    store.focusTask(null);
    openView("desk");
    composerRef.current?.focus();
  }, [openView]);
  const closeBoard = useCallback(() => {
    setBoardOpen(false);
    chipRef.current?.focus();
  }, []);

  const holdingsPanel = (level: 2 | 3, asView = false) => (
    <HoldingsPanel
      lane={lane}
      snapshot={holdings.snapshot}
      loading={holdings.loading}
      failed={holdings.failed}
      perAccount={holdings.perAccount}
      onRefresh={holdings.refresh}
      headingLevel={level}
      asView={asView}
    />
  );

  const emptyDesk = view === "desk" && tasks.length === 0;

  return (
    <DeskActionsContext.Provider value={actions}>
      <DeskShell
        header={
          <DeskHeader
            view={view}
            onSection={openSection}
            taskCount={tasks.length}
            onOpenTask={openTask}
            onNewTask={newTask}
            theme={theme}
            onToggleTheme={toggle}
          />
        }
        viewNav={<DeskViewNav view={view} onSection={openSection} taskCount={tasks.length} />}
        leftRail={<TaskRail onOpenTask={openTask} onNewTask={newTask} />}
        rightRail={
          <>
            <SubagentNotice evm={accounts.evm?.address ?? null} solana={accounts.solana?.address ?? null} />
            {holdingsPanel(2)}
            <ActivityPeek onOpenAll={() => openView("activity")} />
          </>
        }
      >
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {announcement}
        </p>
        {emptyDesk ? null : <h1 className="sr-only">{copy.page.title}</h1>}
        <DeskSubNav view={view} onView={(next: DeskView) => openView(next)} />
        {view === "tasks" ? (
          <section className="pb-8">
            <TaskList onOpenTask={openTask} onNewTask={newTask} asView />
          </section>
        ) : null}
        {view === "holdings" ? <section className="pb-8">{holdingsPanel(2, true)}</section> : null}
        {view === "tools" ? <ToolsView toolId={toolId} /> : null}
        {view === "activity" ? <ActivityView /> : null}
        {view === "dashboard" ? (
          <Suspense fallback={<p className="text-sm font-bold">{copy.dashboard.loading}</p>}>
            <DashboardView lane={lane} />
          </Suspense>
        ) : null}
        {view === "automations" ? (
          <Suspense fallback={null}>
            <AutomationsView />
          </Suspense>
        ) : null}
        {view === "orders" ? <OrdersView /> : null}
        {view === "perps" ? (
          <Suspense fallback={<p role="status">{copy.perps.loading}</p>}>
            <PerpsView />
          </Suspense>
        ) : null}
        {emptyDesk ? (
          <DeskEmptyState departure={departure} actions={status.actions} health={status.health} healthAt={status.healthAt} onPick={(sentence) => composerRef.current?.fill(sentence)} />
        ) : null}
        {/* The thread stays mounted under every view (an execution must never unmount). */}
        <div hidden={view !== "desk"} className={view === "desk" ? "flex flex-1 flex-col" : "hidden"}>
          <TaskThread renderTask={(task, newest) => <TaskCard key={task.id} task={task} newest={newest} />} />
        </div>
        <Composer
          ref={composerRef}
          departure={departure}
          departureCaption={caption}
          boardOpen={boardOpen}
          onOpenBoard={() => setBoardOpen((open) => !open)}
          chipRef={chipRef}
          enginePin={enginePin}
          onClearPin={() => getDeskStore().getState().pinEngine(null)}
          answeringTitle={answeringTask?.title ?? null}
          onClearAnswering={() => getDeskStore().getState().answer(null)}
          actions={status.actions}
          onSubmit={submit}
          onCommand={(next) => openView(next)}
          picker={
            <DeparturePicker
              open={boardOpen}
              board={board}
              value={departure}
              mostFunds={mostFunds}
              holdingsAt={holdings.snapshot?.observedAt ?? null}
              onRefreshHoldings={holdings.refresh}
              onChoose={(next) => getDeskStore().getState().setDeparture(next)}
              onClose={closeBoard}
              anchorRef={chipRef}
            />
          }
        />
      </DeskShell>
      <EngineHosts
        networks={engineNetworks}
        resumeWorkflow={Boolean(workflowResume)}
        onEditPrompt={(prompt, network) => actions.fill(prompt, { engine: network })}
        onOpenTool={(id) => openView("tools", id)}
      />
    </DeskActionsContext.Provider>
  );
}
