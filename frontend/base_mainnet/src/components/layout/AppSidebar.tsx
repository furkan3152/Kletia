import React from 'react';
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
  type LucideIcon,
} from 'lucide-react';

import {
  type AppTab,
  type NavigationIcon,
  type NetworkNavigationItem,
} from '../../config/networks';
import { useNetwork } from '../../hooks/useNetwork';
import { useAppStore } from '../../store/useAppStore';
import { NetworkSwitcher } from './NetworkSwitcher';

interface AppSidebarProps {
  activeTab: string;
  setActiveTab: (tab: AppTab) => void;
  isPortfolioOpen: boolean;
  setIsPortfolioOpen: (open: boolean) => void;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  onWidgetClick: (prompt: string) => void;
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

export const AppSidebar: React.FC<AppSidebarProps> = ({
  activeTab,
  setActiveTab,
  isPortfolioOpen,
  setIsPortfolioOpen,
  isOpen,
  setIsOpen,
  onWidgetClick,
}) => {
  const { isDarkMode, toggleTheme, clearMessages } = useAppStore();
  const {
    networkMode,
    network,
    toggleNetwork,
    isSwitching,
    switchError,
  } = useNetwork();

  const availableSections = React.useMemo(
    () =>
      network.navigation
        .map((section) => ({
          ...section,
          items: section.items.filter(
            (item) => !item.feature || network.features[item.feature],
          ),
        }))
        .filter((section) => section.items.length > 0),
    [network],
  );

  React.useEffect(() => {
    const supportedTabs = availableSections.flatMap((section) =>
      section.items.flatMap((item) =>
        item.action.type === 'tab' ? [item.action.tab] : [],
      ),
    );

    if (!supportedTabs.includes(activeTab as AppTab)) {
      setActiveTab('chat');
      setIsPortfolioOpen(false);
    }
  }, [
    activeTab,
    availableSections,
    setActiveTab,
    setIsPortfolioOpen,
  ]);

  const navItemClass = (isActive: boolean) =>
    `w-full flex items-center justify-between px-4 py-3 font-black border-[3px] border-[#1A1A1A] dark:border-[#4B5563] transition-all duration-100 ease-out group cursor-pointer ${
      isActive
        ? 'text-white shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] translate-x-2'
        : 'bg-white dark:bg-[#1E293B] text-[#1A1A1A] dark:text-white shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] hover:-translate-y-1 hover:-translate-x-1 hover:shadow-[8px_8px_0_#1A1A1A] dark:hover:shadow-[8px_8px_0_#475569]'
    }`;

  const handleNavigation = (item: NetworkNavigationItem) => {
    setIsPortfolioOpen(false);

    if (item.action.type === 'tab') {
      setActiveTab(item.action.tab);
    } else {
      onWidgetClick(item.action.prompt);
    }

    if (window.innerWidth < 768) {
      setIsOpen(false);
    }
  };

  return (
    <>
      {isOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/50 z-40"
          onClick={() => setIsOpen(false)}
        />
      )}

      <aside
        className={`fixed md:relative top-0 left-0 h-full md:h-[calc(100%-2rem)] bg-white dark:bg-[#131E32] border-r-[4px] md:border-[4px] border-[#1A1A1A] dark:border-[#4B5563] md:shadow-[8px_8px_0_#1A1A1A] dark:md:shadow-[8px_8px_0_#475569] z-40 flex flex-col transition-all duration-300 ease-in-out pt-20 md:pt-0 md:m-4 md:rounded shrink-0 ${
          isOpen
            ? 'w-72 translate-x-0 md:mr-0'
            : 'w-0 -translate-x-full md:-ml-8 opacity-0 overflow-hidden md:m-0 border-none md:border-none shadow-none md:shadow-none'
        }`}
      >
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-8 custom-scrollbar">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2 ml-2 mr-1">
              <div className="min-w-0">
                <h3 className="text-xs font-black text-gray-500 dark:text-slate-400 tracking-widest uppercase">
                  Network
                </h3>
                <p
                  className="text-[10px] font-black uppercase truncate"
                  style={{ color: network.color }}
                >
                  {network.name}
                </p>
              </div>
              <NetworkSwitcher
                networkMode={networkMode}
                onToggle={toggleNetwork}
                isSwitching={isSwitching}
                error={switchError}
                showStatusBadge={false}
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
                  item.action.type === 'tab' &&
                  activeTab === item.action.tab &&
                  !isPortfolioOpen;

                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => handleNavigation(item)}
                    className={navItemClass(isActive)}
                    style={
                      isActive ? { backgroundColor: network.color } : undefined
                    }
                  >
                    <div className="flex items-center gap-3">
                      <Icon
                        size={18}
                        className={isActive ? 'text-white' : undefined}
                        style={
                          isActive ? undefined : { color: network.color }
                        }
                      />
                      <span>{item.label}</span>
                    </div>
                    <ChevronRight
                      size={16}
                      className="opacity-0 group-hover:opacity-100 transition-opacity"
                    />
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
              className="p-1.5 border-[2px] border-[#1A1A1A] dark:border-[#4B5563] bg-[#EFEFEF] dark:bg-[#0F172A] shadow-[2px_2px_0_#1A1A1A] dark:shadow-[2px_2px_0_#475569] hover:-translate-y-0.5 active:translate-y-0 transition-all duration-100 ease-out"
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
            onClick={clearMessages}
            className="w-full p-2 mt-2 border-[2px] border-[#1A1A1A] dark:border-[#4B5563] bg-[#FF3B30] text-white shadow-[2px_2px_0_#1A1A1A] dark:shadow-[2px_2px_0_#475569] hover:-translate-y-0.5 hover:shadow-[4px_4px_0_#1A1A1A] active:translate-y-0 active:shadow-[1px_1px_0_#1A1A1A] transition-all duration-100 ease-out font-black flex items-center justify-center gap-2 uppercase tracking-widest"
          >
            <MessageSquare className="w-4 h-4" /> CLEAR HISTORY
          </button>
          <div>
            Kletia Omni Engine V2.0
            <br />
            Powered by {network.shortName}
          </div>
        </div>
      </aside>
    </>
  );
};
