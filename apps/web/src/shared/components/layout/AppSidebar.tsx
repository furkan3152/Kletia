import React from "react";
import { useAccount } from "wagmi";
import {
  Briefcase,
  ChevronRight,
  FileKey2,
  Fingerprint,
  Hexagon,
  Layers,
  MessageSquare,
  Moon,
  Shield,
  ShieldAlert,
  Sun,
  TrendingUp,
  X,
  type LucideIcon,
} from "lucide-react";

import {
  type AppTab,
  type NavigationIcon,
  type NetworkNavigationItem,
  type NetworkNavigationSection,
} from "../../config/networks";
import {
  materializeIntentExample,
  requiresActiveWalletAddress,
} from "../../config/intentExamples";
import { useNetwork } from "../../hooks/useNetwork";
import { useAppStore } from "../../state/useAppStore";
import { NetworkSwitcher } from "./NetworkSwitcher";
import type { WorkspaceMode } from "./NetworkSwitcher";

interface AppSidebarProps {
  activeTab: string;
  setActiveTab: (tab: AppTab) => void;
  isPortfolioOpen: boolean;
  setIsPortfolioOpen: (open: boolean) => void;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  onWidgetClick: (prompt: string) => void;
  workspaceMode?: WorkspaceMode;
  onWorkspaceSelect?: (network: WorkspaceMode) => void | Promise<unknown>;
  onClearHistory?: () => void;
}

const NAVIGATION_ICONS: Record<NavigationIcon, LucideIcon> = {
  chat: MessageSquare,
  shield: Shield,
  allora: Fingerprint,
  basename: Hexagon,
  airdrop: ShieldAlert,
  x402: FileKey2,
  dashboard: Layers,
  lending: Briefcase,
  swap: TrendingUp,
  vault: Shield,
  staking: Hexagon,
  batch: Layers,
  memo: FileKey2,
  liquidity: TrendingUp,
};

const STELLAR_NAVIGATION: readonly NetworkNavigationSection[] = [
  {
    id: "stellar-intents",
    label: "Intent Center",
    items: [
      {
        id: "stellar-chat",
        label: "Ask Kletia",
        icon: "chat",
        action: { type: "tab", tab: "chat" },
      },
      {
        id: "stellar-dashboard",
        label: "Payment Center",
        icon: "dashboard",
        action: { type: "tab", tab: "stellar" },
      },
      {
        id: "stellar-payout",
        label: "Pay Worldwide",
        icon: "memo",
        action: {
          type: "prompt",
          prompt: "Pay 100 TRY to a bank account from Stellar USDC",
        },
      },
      {
        id: "stellar-balances",
        label: "Show Balances",
        icon: "dashboard",
        action: {
          type: "prompt",
          prompt: "Show my live XLM and USDC balances on Stellar",
        },
      },
      {
        id: "stellar-send",
        label: "Send Payment",
        icon: "memo",
        action: {
          type: "prompt",
          prompt: "Send 5 USDC to a Stellar address",
        },
      },
      {
        id: "stellar-swap",
        label: "Swap Assets",
        icon: "swap",
        action: {
          type: "prompt",
          prompt: "Swap 5 XLM to USDC using the best live Stellar route",
        },
      },
    ],
  },
] as const;

export const AppSidebar: React.FC<AppSidebarProps> = ({
  activeTab,
  setActiveTab,
  isPortfolioOpen,
  setIsPortfolioOpen,
  isOpen,
  setIsOpen,
  onWidgetClick,
  workspaceMode,
  onWorkspaceSelect,
  onClearHistory,
}) => {
  const { isDarkMode, toggleTheme, clearMessages } = useAppStore();
  const { address } = useAccount();
  const { networkMode, network, switchNetwork, isSwitching, switchError } =
    useNetwork();
  const effectiveWorkspace = workspaceMode ?? networkMode;
  const selectWorkspace =
    onWorkspaceSelect ??
    ((selected: WorkspaceMode) =>
      selected === "stellar" ? Promise.resolve(false) : switchNetwork(selected));
  const isStellarWorkspace = effectiveWorkspace === "stellar";
  const workspaceAccent = isStellarWorkspace ? "#8B5CF6" : network.color;

  const availableSections = React.useMemo(
    () =>
      (isStellarWorkspace ? STELLAR_NAVIGATION : network.navigation)
        .map((section) => ({
          ...section,
          items: section.items.filter(
            (item) => !item.feature || network.features[item.feature],
          ),
        }))
        .filter((section) => section.items.length > 0),
    [isStellarWorkspace, network],
  );

  React.useEffect(() => {
    if (isStellarWorkspace) return;
    const supportedTabs = availableSections.flatMap((section) =>
      section.items.flatMap((item) =>
        item.action.type === "tab" ? [item.action.tab] : [],
      ),
    );

    if (!supportedTabs.includes(activeTab as AppTab)) {
      setActiveTab("chat");
      setIsPortfolioOpen(false);
    }
  }, [activeTab, availableSections, isStellarWorkspace, setActiveTab, setIsPortfolioOpen]);

  const navItemClass = (isActive: boolean) =>
    `group flex min-h-12 w-full items-center justify-between border-[3px] border-[#1A1A1A] px-4 py-3 font-black transition-[transform,box-shadow,background-color] duration-100 ease-out focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#0052FF] dark:border-[#4B5563] ${
      isActive
        ? "text-white shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] translate-x-2"
        : "bg-white dark:bg-[#1E293B] text-[#1A1A1A] dark:text-white shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] hover:-translate-y-1 hover:-translate-x-1 hover:shadow-[8px_8px_0_#1A1A1A] dark:hover:shadow-[8px_8px_0_#475569]"
    }`;

  const handleNavigation = (item: NetworkNavigationItem) => {
    setIsPortfolioOpen(false);

    if (item.action.type === "tab") {
      setActiveTab(item.action.tab);
    } else {
      const prompt = materializeIntentExample(item.action.prompt, address);
      onWidgetClick(prompt);
    }

    if (window.innerWidth < 768) {
      setIsOpen(false);
    }
  };

  React.useEffect(() => {
    if (!isOpen) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [isOpen, setIsOpen]);

  return (
    <>
      {isOpen && (
        <button
          type="button"
          aria-label="Close Kletia navigation"
          className="fixed inset-0 z-[55] bg-black/60 md:hidden"
          onClick={() => setIsOpen(false)}
        />
      )}

      <aside
        aria-label="Kletia workspace navigation"
        aria-hidden={!isOpen}
        className={`fixed left-0 top-0 z-[60] flex h-[100dvh] w-[min(20rem,calc(100vw-1rem))] shrink-0 flex-col border-r-[4px] border-[#1A1A1A] bg-white transition-[transform,opacity] duration-200 ease-in-out dark:border-[#4B5563] dark:bg-[#131E32] md:relative md:z-40 md:m-4 md:h-[calc(100%-2rem)] md:rounded md:border-[4px] md:shadow-[8px_8px_0_#1A1A1A] dark:md:shadow-[8px_8px_0_#475569] ${
          isOpen
            ? "translate-x-0 opacity-100 md:w-72 md:mr-0"
            : "pointer-events-none -translate-x-full overflow-hidden opacity-0 md:m-0 md:-ml-8 md:w-0 md:border-none md:shadow-none"
        }`}
      >
        <div className="flex min-h-16 items-center justify-between border-b-[4px] border-[#1A1A1A] px-4 pt-[env(safe-area-inset-top)] dark:border-[#4B5563] md:hidden">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-gray-500 dark:text-slate-400">
              Workspace
            </p>
            <p className="font-black uppercase text-[#1A1A1A] dark:text-white">
              Kletia navigation
            </p>
          </div>
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            aria-label="Close navigation"
            className="flex h-11 w-11 items-center justify-center border-[3px] border-[#1A1A1A] bg-white shadow-[3px_3px_0_#1A1A1A] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#0052FF] active:translate-y-0.5 active:shadow-none dark:border-[#4B5563] dark:bg-[#1A2841] dark:shadow-[3px_3px_0_#475569]"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <div className="custom-scrollbar flex-1 space-y-8 overflow-y-auto px-4 py-4">
          <div className="space-y-3">
            <div className="mx-1 space-y-2">
              <div className="min-w-0">
                <h3 className="text-xs font-black text-gray-500 dark:text-slate-400 tracking-widest uppercase">
                  Network
                </h3>
                <p
                  className="text-[10px] font-black uppercase truncate"
                  style={{ color: workspaceAccent }}
                >
                  {isStellarWorkspace ? "Stellar Payment Center" : network.name}
                </p>
              </div>
              <NetworkSwitcher
                networkMode={effectiveWorkspace}
                onSelect={selectWorkspace}
                isSwitching={isSwitching}
                error={switchError}
                className="w-full"
              />
            </div>
          </div>

          {availableSections.map((section) => (
            <div key={section.id} className="space-y-3">
              <h3 className="text-xs font-black text-gray-500 dark:text-slate-400 tracking-widest uppercase ml-2">
                {section.label}
              </h3>

              {section.items.map((item) => {
                const Icon = NAVIGATION_ICONS[item.icon];
                const isActive =
                  item.action.type === "tab" &&
                  activeTab === item.action.tab &&
                  !isPortfolioOpen;
                const needsWallet =
                  item.action.type === "prompt" &&
                  requiresActiveWalletAddress(item.action.prompt);

                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleNavigation(item)}
                    title={
                      needsWallet && !address
                        ? "Opens an editable example. Replace the recipient before sending, or connect a wallet to insert its address."
                        : undefined
                    }
                    className={navItemClass(isActive)}
                    style={
                      isActive ? { backgroundColor: workspaceAccent } : undefined
                    }
                  >
                    <div className="flex items-center gap-3">
                      <Icon
                        size={18}
                        className={isActive ? "text-white" : undefined}
                        style={isActive ? undefined : { color: workspaceAccent }}
                      />
                      <span>{item.label}</span>
                    </div>
                    <span className="flex shrink-0 items-center gap-1.5">
                      {needsWallet && !address ? (
                        <span className="border-2 border-[#1A1A1A] bg-[#FFF36D] px-1.5 py-0.5 text-[9px] font-black uppercase text-[#1A1A1A] dark:border-[#64748B]">
                          Edit
                        </span>
                      ) : null}
                      <ChevronRight
                        size={16}
                        className="opacity-60 transition-opacity duration-100 group-hover:opacity-100"
                        aria-hidden="true"
                      />
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="p-4 border-t-[4px] border-[#1A1A1A] dark:border-[#4B5563] bg-white dark:bg-[#1A2841] text-xs font-bold text-center text-[#1A1A1A] dark:text-gray-300 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span>THEME</span>
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={isDarkMode ? "Use light theme" : "Use dark theme"}
              className="flex h-11 w-11 items-center justify-center border-[2px] border-[#1A1A1A] bg-[#EFEFEF] shadow-[2px_2px_0_#1A1A1A] transition-[transform,box-shadow] duration-100 ease-out hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#0052FF] active:translate-y-0.5 active:shadow-none dark:border-[#4B5563] dark:bg-[#0F172A] dark:shadow-[2px_2px_0_#475569]"
            >
              {isDarkMode ? (
                <Sun className="w-4 h-4 text-[#FFD700]" />
              ) : (
                <Moon className="w-4 h-4 text-[#0052FF]" />
              )}
            </button>
          </div>
          <button
            type="button"
            onClick={onClearHistory ?? clearMessages}
            className="mt-2 flex min-h-11 w-full items-center justify-center gap-2 border-[2px] border-[#1A1A1A] bg-[#FF3B30] p-2 font-black uppercase tracking-widest text-white shadow-[2px_2px_0_#1A1A1A] transition-[transform,box-shadow] duration-100 ease-out hover:-translate-y-0.5 hover:shadow-[4px_4px_0_#1A1A1A] focus-visible:outline focus-visible:outline-4 focus-visible:outline-offset-2 focus-visible:outline-[#FFD700] active:translate-y-0.5 active:shadow-none dark:border-[#4B5563] dark:shadow-[2px_2px_0_#475569]"
          >
            <MessageSquare className="w-4 h-4" /> CLEAR HISTORY
          </button>
          <div>
            Kletia Omni Engine V2.0
            <br />
            Powered by {isStellarWorkspace ? "Stellar Testnet" : network.shortName}
          </div>
        </div>
      </aside>
    </>
  );
};
