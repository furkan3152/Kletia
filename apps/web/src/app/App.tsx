import React, { useCallback, useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { Loader2 } from "lucide-react";
import {
  NETWORKS,
  getWorkspacePresentation,
  type AppTab,
} from "../shared/config/networks";
import { BACKEND_URL } from "../shared/config/runtime";
import type { WidgetId } from "../shared/types";
import { Navbar } from "../shared/components/layout/Navbar";
import type { WorkspaceMode } from "../shared/components/layout/NetworkSwitcher";
import { Sidebar } from "../shared/components/layout/Sidebar";
import { AppSidebar } from "../shared/components/layout/AppSidebar";
import { ActivityDrawer } from "../shared/components/layout/ActivityDrawer";
import { readStorage, writeStorage } from "../shared/state/safeStorage";
import { emitNetworkSelected } from "../shared/sync/bus";
import type { SolanaTab } from "../networks/solana/solanaTabs";
import { ChatInput } from "../shared/components/chat/ChatInput";
import { IntentStarter } from "../shared/components/chat/IntentStarter";
import { IntentPrivacyDecisionCard } from "../shared/components/chat/IntentPrivacyDecisionCard";
import { useNetwork } from "../shared/hooks/useNetwork";
import { useAppStore } from "../shared/state/useAppStore";
import { LegacyMessageRow } from "./console/legacy/LegacyMessageBody";
import { useLegacyEngine } from "./console/legacy/useLegacyEngine";
import { useLegacyWorkflowResume } from "./console/legacy/useLegacyWorkflowResume";

/*
 * The classic console shell: the old layout (workspaces, sidebar tabs, chat,
 * portfolio and activity drawers) over the network engines, which live in
 * console/legacy (console design 6.2). It stays only until the desk replaces
 * it at /app; the engines' parity is proven against it.
 */

const X402ServiceRouter = React.lazy(() =>
  import("../networks/base/components/x402/X402ServiceRouter").then((module) => ({
    default: module.X402ServiceRouter,
  })),
);
const AlloraDashboard = React.lazy(() =>
  import("../integrations/allora/components/AlloraDashboard").then((module) => ({
    default: module.AlloraDashboard,
  })),
);
const BasenameClaimer = React.lazy(() =>
  import("../networks/base/components/BasenameClaimer").then((module) => ({
    default: module.BasenameClaimer,
  })),
);
const AirdropSimulator = React.lazy(() =>
  import("../networks/base/components/AirdropSimulator").then((module) => ({
    default: module.AirdropSimulator,
  })),
);
const WebacyScanner = React.lazy(() =>
  import("../integrations/webacy/components/WebacyScanner").then((module) => ({
    default: module.WebacyScanner,
  })),
);
const ArcDashboardWidget = React.lazy(() =>
  import("../networks/arc/components/ArcDashboardWidget").then((module) => ({
    default: module.ArcDashboardWidget,
  })),
);
const SolanaWorkspace = React.lazy(
  () => import("../networks/solana/components/SolanaWorkspace"),
);
const ArcLendingDashboard = React.lazy(() =>
  import("../networks/arc/components/ArcLendingDashboard").then((module) => ({
    default: module.ArcLendingDashboard,
  })),
);
const WORKSPACE_STORAGE_KEY = "kletia-workspace";

const handleFundClick = async (targetAddress: string, e: React.MouseEvent) => {
  e.preventDefault();
  try {
    const res = await fetch(`${BACKEND_URL}/api/onramp-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Kletia-Network": "base",
        "X-Kletia-Chain-Id": String(NETWORKS.base.chainId),
      },
      body: JSON.stringify({ address: targetAddress }),
    });
    const data = await res.json();
    if (data.status === "success" && data.token) {
      const addresses = encodeURIComponent(
        JSON.stringify({ [targetAddress]: ["base"] }),
      );
      const appId = "82ee9f72-74ba-4279-bf89-5f212261ce85";
      window.open(
        `https://pay.coinbase.com/buy/select-asset?appId=${appId}&sessionToken=${data.token}&addresses=${addresses}&defaultAsset=USDC`,
        "_blank",
        "noopener,noreferrer",
      );
    } else {
      alert(
        "The funding service is currently unavailable. Please try again later.",
      );
    }
  } catch {
    console.warn("Funding request failed.");
  }
};

export default function App() {
  const { address, status: accountStatus } = useAccount();
  const {
    networkMode,
    network,
    chainId,
    switchNetwork,
    isSwitching,
    switchError,
  } = useNetwork();
  const [activeTab, setActiveTab] = useState<AppTab>("chat");
  const [activeArcWidget, setActiveArcWidget] = useState<WidgetId>(null);
  const [isPortfolioOpen, setIsPortfolioOpen] = useState(false);
  const [isActivityOpen, setIsActivityOpen] = useState(false);
  const [isAppSidebarOpen, setIsAppSidebarOpen] = useState(false);
  // EVM workspaces follow the wallet network (useNetwork). The Solana
  // workspace is stored separately and never asks the EVM wallet to switch.
  const [isSolanaWorkspace, setIsSolanaWorkspace] = useState(
    () => readStorage(WORKSPACE_STORAGE_KEY) === "solana",
  );
  const [solanaTab, setSolanaTab] = useState<SolanaTab>("overview");
  const workspaceMode: WorkspaceMode = isSolanaWorkspace ? "solana" : networkMode;
  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { isDarkMode, bindWalletHistory } = useAppStore();
  const setPortfolioDrawerOpen = useCallback((open: boolean) => {
    if (open) setIsActivityOpen(false);
    setIsPortfolioOpen(open);
  }, []);
  const engine = useLegacyEngine({
    network: networkMode,
    classic: true,
    onInputConsumed: () => setInput(""),
    onOpenWidget: (tab, subTarget) => {
      setActiveTab(tab);
      if (tab === "arc" && subTarget) {
        setActiveArcWidget(subTarget);
      }
      if (tab !== "chat") {
        setIsPortfolioOpen(false);
      }
    },
    onPortfolio: () => setPortfolioDrawerOpen(true),
    onEditPrompt: (prompt) => {
      setInput(prompt);
      setActiveTab("chat");
      setIsPortfolioOpen(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    },
  });
  const { messages, semanticAiSession, dismissPrivacyDecision } = engine;

  const selectWorkspace = async (selected: WorkspaceMode) => {
    if (selected === "solana") {
      setIsSolanaWorkspace(true);
      writeStorage(WORKSPACE_STORAGE_KEY, "solana");
      dismissPrivacyDecision();
      setIsPortfolioOpen(false);
      return true;
    }
    const switched = await switchNetwork(selected);
    if (switched) {
      setIsSolanaWorkspace(false);
      writeStorage(WORKSPACE_STORAGE_KEY, selected);
      dismissPrivacyDecision();
    }
    return switched;
  };

  const closeActivity = useCallback(() => setIsActivityOpen(false), []);
  const openActivity = useCallback(() => {
    setIsPortfolioOpen(false);
    setIsActivityOpen(true);
  }, []);

  const selectAppTab = useCallback((tab: AppTab) => {
    setIsActivityOpen(false);
    setActiveTab(tab);
  }, []);
  const selectSolanaTab = useCallback((tab: SolanaTab) => {
    setIsActivityOpen(false);
    setSolanaTab(tab);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.network = workspaceMode;
    document.documentElement.classList.toggle("arc-mode", workspaceMode === "arc");
    emitNetworkSelected(workspaceMode);
  }, [workspaceMode]);

  useEffect(() => {
    if (accountStatus === "connected" && address) {
      bindWalletHistory(address);
    } else if (accountStatus === "disconnected") {
      bindWalletHistory();
    }
  }, [accountStatus, address, bindWalletHistory]);

  useLegacyWorkflowResume();

  useEffect(() => {
    if (messages.length === 0) return;
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add("dark");
      writeStorage("kletia-theme", "dark");
    } else {
      document.documentElement.classList.remove("dark");
      writeStorage("kletia-theme", "light");
    }
  }, [isDarkMode]);

  // The old console clears its composer, tab, Arc widget, drawer and any
  // pending consent whenever the wallet, its chain, the workspace or the AI
  // session changes; the engine resets its own requests and conversation.
  useEffect(() => {
    setInput("");
    setActiveTab("chat");
    setActiveArcWidget(null);
    setIsPortfolioOpen(false);
    dismissPrivacyDecision();
  }, [address, chainId, network.chainId, networkMode, semanticAiSession, dismissPrivacyDecision]);

  const handleWidgetClick = (prompt: string) => {
    engine.resetForNewPrompt();
    setInput(prompt);
    setActiveTab("chat");
    setIsPortfolioOpen(false);
    setTimeout(() => {
      inputRef.current?.focus();
    }, 10);
  };

  const handleSend = () => {
    if (input.trim()) dismissPrivacyDecision();
    void engine.submitIntent(input);
  };

  const handleContextFunding = (
    targetAddress: string,
    event: React.MouseEvent,
  ) => {
    event.preventDefault();
    const funding = getWorkspacePresentation(workspaceMode).funding;
    if (funding.kind === "faucet") {
      window.open(funding.url, "_blank", "noopener,noreferrer");
      return;
    }
    if (funding.kind === "bridge") {
      window.location.assign(funding.url);
      return;
    }
    // Only Base uses the Coinbase onramp.
    if (networkMode === "base") void handleFundClick(targetAddress, event);
  };

  const scanPortfolioPrompt =
    networkMode === "arc"
      ? "Show my Arc portfolio"
      : networkMode === "arbitrum"
        ? "Show my Arbitrum portfolio"
        : "Show my portfolio";

  return (
    <div className="fixed inset-0 flex h-[100dvh] max-h-[100dvh] flex-col overflow-hidden bg-[#EFEFEF] font-sans text-[#1A1A1A] antialiased transition-colors duration-200 dark:bg-[#0B1120] dark:text-gray-100">
      <div aria-hidden="true" className="fixed inset-0 z-0 pointer-events-none select-none">
        <div className="absolute inset-0 bg-[radial-gradient(#1A1A1A33_2px,transparent_2px)] dark:bg-[radial-gradient(#ffffff15_2px,transparent_2px)] [background-size:30px_30px] opacity-70"></div>

        <div className="hidden md:block absolute -left-10 top-[15%] text-[180px] font-black text-black/[0.03] dark:text-white/[0.02] -rotate-12 tracking-tighter">
          KLETIA
        </div>
        <div className="hidden md:block absolute right-[-20px] bottom-[20%] text-[160px] font-black text-black/[0.03] dark:text-white/[0.02] rotate-12 tracking-widest">
          CONSOLE
        </div>

        <div className="hidden md:block absolute top-[15%] right-[10%] w-24 h-24 bg-[#0052FF] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] rotate-12 opacity-80 dark:opacity-50"></div>
        <div className="hidden md:block absolute bottom-[25%] left-[5%] md:left-[10%] w-24 md:w-40 h-12 md:h-16 bg-[#FFD700] dark:bg-[#CCA000] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] rounded-full shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] -rotate-6 opacity-80 dark:opacity-60"></div>
      </div>

      <Navbar
        address={address}
        handleFundClick={handleFundClick}
        onMenuClick={() => setIsAppSidebarOpen(!isAppSidebarOpen)}
        networkMode={workspaceMode}
        onNetworkSelect={selectWorkspace}
        isNetworkSwitching={isSwitching}
        networkSwitchError={switchError}
      />

      <div className="relative z-10 flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <AppSidebar
          activeTab={activeTab}
          setActiveTab={selectAppTab}
          isPortfolioOpen={isPortfolioOpen}
          setIsPortfolioOpen={setPortfolioDrawerOpen}
          isOpen={isAppSidebarOpen}
          setIsOpen={setIsAppSidebarOpen}
          onWidgetClick={handleWidgetClick}
          workspaceMode={workspaceMode}
          onWorkspaceSelect={selectWorkspace}
          solanaTab={solanaTab}
          onSolanaTabChange={selectSolanaTab}
          isActivityOpen={isActivityOpen}
          onOpenActivity={openActivity}
        />

        <div className="grid grid-rows-[1fr_auto] flex-1 overflow-hidden relative w-full h-full min-h-0 min-w-0">
          <React.Suspense
            fallback={
              <div className="flex h-full items-center justify-center">
                <div className="mx-3 flex max-w-full items-center gap-3 border-[4px] border-[#1A1A1A] bg-white p-4 font-black uppercase text-[#1A1A1A] shadow-[5px_5px_0_#1A1A1A] sm:p-5 sm:shadow-[6px_6px_0_#1A1A1A]">
                  <Loader2 className="h-5 w-5 animate-spin text-[#0052FF]" />
                  Loading workspace
                </div>
              </div>
            }
          >
          {isSolanaWorkspace ? (
            <SolanaWorkspace tab={solanaTab} onTabChange={selectSolanaTab} />
          ) : networkMode === "base" && activeTab === "allora" ? (
            <AlloraDashboard
              isDarkMode={isDarkMode}
              onActionClick={handleWidgetClick}
            />
          ) : networkMode === "base" && activeTab === "basename" ? (
            <BasenameClaimer onActionClick={handleWidgetClick} />
          ) : networkMode === "base" && activeTab === "airdrop" ? (
            <AirdropSimulator />
          ) : networkMode === "base" && activeTab === "x402" ? (
            <React.Suspense
              fallback={
                <div className="flex h-full items-center justify-center">
                  <div className="mx-3 flex max-w-full items-center gap-3 border-[4px] border-[#1A1A1A] bg-white p-4 font-black uppercase text-[#1A1A1A] shadow-[5px_5px_0_#1A1A1A] sm:p-5 sm:shadow-[6px_6px_0_#1A1A1A]">
                    <Loader2 className="h-5 w-5 animate-spin text-[#0052FF]" />
                    Loading x402 workspace
                  </div>
                </div>
              }
            >
              <X402ServiceRouter onIntentTemplate={handleWidgetClick} />
            </React.Suspense>
          ) : (networkMode === "base" || networkMode === "arbitrum") &&
            activeTab === "webacy" ? (
            <WebacyScanner network={networkMode} chainId={network.chainId} />
          ) : networkMode === "arc" && activeTab === "arc" ? (
            <div className="flex-1 overflow-y-auto p-4 md:p-6 custom-scrollbar block">
              <ArcDashboardWidget
                onWidgetClick={handleWidgetClick}
                activeWidget={activeArcWidget}
                setActiveWidget={setActiveArcWidget}
              />
            </div>
          ) : networkMode === "arc" && activeTab === "lending" ? (
            <div className="flex-1 overflow-y-auto p-4 md:p-6 custom-scrollbar block">
              <ArcLendingDashboard
                isDarkMode={isDarkMode}
                onActionClick={handleWidgetClick}
              />
            </div>
          ) : (
            <>
              <div
                className="custom-scrollbar min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain bg-transparent p-2.5 scroll-smooth sm:p-4 md:p-6"
                id="chat-container"
              >
                <div className="relative mx-auto w-full max-w-4xl min-w-0 pr-1 md:pr-0">
                  {messages.length === 0 && (
                    <IntentStarter
                      networkMode={networkMode}
                      walletAddress={address}
                      onSelect={handleWidgetClick}
                    />
                  )}
                  <div className="space-y-5 sm:space-y-6 md:space-y-8">
                    {messages.map((msg) => (
                      <LegacyMessageRow
                        key={msg.id}
                        msg={msg}
                        engine={engine}
                        onPrompt={handleWidgetClick}
                        onFund={handleContextFunding}
                        switchNetwork={switchNetwork}
                      />
                    ))}
                    <div ref={messagesEndRef} />
                  </div>
                </div>
              </div>

              {engine.pendingPrivacyDecision ? (
                <div className="shrink-0 px-2.5 pt-2 sm:px-4 md:px-6">
                  <IntentPrivacyDecisionCard
                    decision={engine.pendingPrivacyDecision.decision}
                    busy={false}
                    onSelect={engine.handlePrivacyDecisionSelection}
                  />
                </div>
              ) : null}

              {engine.activeSemanticAiSession ? (
                <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-3 px-2.5 pt-2 text-[10px] font-black uppercase sm:px-4 md:px-6">
                  <span className="border-2 border-[#1A1A1A] bg-[#EDE7FF] px-2 py-1 text-[#4F2A9B] dark:border-[#64748B] dark:bg-[#231C3D] dark:text-[#D8CCFF]">
                    Natural language on · this tab · expires automatically
                  </span>
                  <button
                    type="button"
                    onClick={engine.turnOffSemanticSession}
                    className="min-h-8 border-2 border-[#1A1A1A] bg-white px-2 py-1 text-[#1A1A1A] shadow-[2px_2px_0_#1A1A1A] dark:border-[#64748B] dark:bg-[#1A2841] dark:text-white dark:shadow-[2px_2px_0_#475569]"
                  >
                    Turn off
                  </button>
                </div>
              ) : null}

              <ChatInput
                inputRef={inputRef}
                input={input}
                setInput={setInput}
                handleSend={handleSend}
                networkMode={networkMode}
              />
            </>
          )}
          </React.Suspense>
        </div>

        {!isSolanaWorkspace ? (
          <Sidebar
            isPortfolioOpen={isPortfolioOpen}
            setIsPortfolioOpen={setPortfolioDrawerOpen}
            onScanPortfolio={() => handleWidgetClick(scanPortfolioPrompt)}
          />
        ) : null}
        <ActivityDrawer isOpen={isActivityOpen} onClose={closeActivity} />
      </div>
    </div>
  );
}