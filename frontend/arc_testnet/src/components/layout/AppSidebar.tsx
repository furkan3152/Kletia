import React from 'react';
import { MessageSquare, ChevronRight, Layers, Hexagon, Briefcase, Sun, Moon } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';

interface AppSidebarProps {
  activeTab: string;
  setActiveTab: (tab: 'chat' | 'basename' | 'allora' | 'airdrop' | 'x402' | 'webacy' | 'arc' | 'lending') => void;
  isPortfolioOpen: boolean;
  setIsPortfolioOpen: (open: boolean) => void;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  onWidgetClick: (prompt: string) => void;
}

export const AppSidebar: React.FC<AppSidebarProps> = ({ 
  activeTab, 
  setActiveTab, 
  isPortfolioOpen, 
  setIsPortfolioOpen,
  isOpen,
  setIsOpen,
  onWidgetClick
}) => {
  const { isDarkMode, toggleTheme, clearMessages } = useAppStore();

  const navItemClass = (isActive: boolean) => 
    `w-full flex items-center justify-between px-4 py-3 font-black border-[3px] border-[#1A1A1A] dark:border-[#4B5563] transition-all duration-100 ease-out group cursor-pointer ${
      isActive 
      ? 'bg-[#0052FF] text-white shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] translate-x-2' 
      : 'bg-white dark:bg-[#1E293B] text-[#1A1A1A] dark:text-white shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] hover:-translate-y-1 hover:-translate-x-1 hover:shadow-[8px_8px_0_#1A1A1A] dark:hover:shadow-[8px_8px_0_#475569]'
    }`;

  return (
    <>
      {/* Mobile Overlay */}
      {isOpen && (
        <div 
          className="md:hidden fixed inset-0 bg-black/50 z-40"
          onClick={() => setIsOpen(false)}
        />
      )}

      {/* Sidebar Container */}
      <aside className={`fixed md:relative top-0 left-0 h-full md:h-[calc(100%-2rem)] bg-white dark:bg-[#131E32] border-r-[4px] md:border-[4px] border-[#1A1A1A] dark:border-[#4B5563] md:shadow-[8px_8px_0_#1A1A1A] dark:md:shadow-[8px_8px_0_#475569] z-40 flex flex-col transition-all duration-300 ease-in-out pt-20 md:pt-0 md:m-4 md:rounded shrink-0 ${
        isOpen ? 'w-72 translate-x-0 md:mr-0' : 'w-0 -translate-x-full md:-ml-8 opacity-0 overflow-hidden md:m-0 border-none md:border-none shadow-none md:shadow-none'
      }`}>
        
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-8 custom-scrollbar">
          
          {/* KLETIA CORE */}
          <div className="space-y-3">
            <div className="flex items-center justify-between ml-2 mr-4">
              <h3 className="text-xs font-black text-gray-500 dark:text-slate-400 tracking-widest uppercase">Command Center</h3>
              
              {/* ARC Mode Toggle (Disabled for now) */}
              <div 
                title="Base Mode Coming Soon"
                className={`flex items-center gap-1.5 px-2 py-0.5 border-[2px] rounded-full text-[10px] font-black transition-all cursor-not-allowed bg-[#6D28D9] border-[#1A1A1A] dark:border-[#4B5563] text-white shadow-[2px_2px_0_#1A1A1A] dark:shadow-[2px_2px_0_#475569]`}
              >
                <Hexagon size={12} className="animate-pulse" />
                ARC MODE (Base Coming Soon)
              </div>
            </div>
            
            <button 
              onClick={() => { setActiveTab('chat'); setIsPortfolioOpen(false); if(window.innerWidth < 768) setIsOpen(false); }}
              className={navItemClass(activeTab === 'chat' && !isPortfolioOpen)}
            >
              <div className="flex items-center gap-3">
                <MessageSquare size={18} className={activeTab === 'chat' && !isPortfolioOpen ? 'text-white' : 'text-[#0052FF] dark:text-[#60A5FA]'} />
                <span>Omni-Engine</span>
              </div>
              <ChevronRight size={16} className="opacity-0 group-hover:opacity-100 transition-opacity" />
            </button>

            <button 
              onClick={() => { setActiveTab('arc'); setIsPortfolioOpen(false); if(window.innerWidth < 768) setIsOpen(false); }}
              className={navItemClass(activeTab === 'arc')}
            >
              <div className="flex items-center gap-3">
                <Layers size={18} className={activeTab === 'arc' ? 'text-white' : 'text-[#2563EB] dark:text-[#60A5FA]'} />
                <span>Dashboard</span>
              </div>
              <ChevronRight size={16} className="opacity-0 group-hover:opacity-100 transition-opacity" />
            </button>

            <button 
              onClick={() => { setActiveTab('lending'); setIsPortfolioOpen(false); if(window.innerWidth < 768) setIsOpen(false); }}
              className={navItemClass(activeTab === 'lending')}
            >
              <div className="flex items-center gap-3">
                <Briefcase size={18} className={activeTab === 'lending' ? 'text-white' : 'text-purple-500'} />
                <span>Lending & Borrow</span>
              </div>
              <ChevronRight size={16} className="opacity-0 group-hover:opacity-100 transition-opacity" />
            </button>
          </div>

          {/* ARC TOOLS (Only visible in ARC mode) */}
            <div className="space-y-3 pb-8">
              <h3 className="text-xs font-black text-gray-500 dark:text-slate-400 tracking-widest uppercase ml-2 flex items-center gap-2">
                <Hexagon size={12} className="text-[#6D28D9] animate-spin-slow" /> KLETIA <span className="text-[10px] lowercase text-gray-400 font-normal">(built on Arc)</span>
              </h3>
              
              <button 
                onClick={() => { onWidgetClick("Swap 5 USDC to KLET via Kletia Omni-Engine"); if(window.innerWidth < 768) setIsOpen(false); }}
                className={navItemClass(false)}
              >
                <div className="flex items-center gap-3">
                  <div className="w-6 h-6 flex items-center justify-center bg-[#3B82F6] border-[2px] border-[#1A1A1A] shadow-[2px_2px_0_#1A1A1A]">
                    <span className="text-xs">🔄</span>
                  </div>
                  <span>Swap</span>
                </div>
                <ChevronRight size={16} className="opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>

              <button 
                onClick={() => { onWidgetClick("Lock 50 USDC in my Kletia time vault"); if(window.innerWidth < 768) setIsOpen(false); }}
                className={navItemClass(false)}
              >
                <div className="flex items-center gap-3">
                  <div className="w-6 h-6 flex items-center justify-center bg-[#8B5CF6] border-[2px] border-[#1A1A1A] shadow-[2px_2px_0_#1A1A1A]">
                    <span className="text-xs">🔒</span>
                  </div>
                  <span>Vault</span>
                </div>
                <ChevronRight size={16} className="opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>

              <button 
                onClick={() => { onWidgetClick("Lock 25 USDC to Kletia staking contract"); if(window.innerWidth < 768) setIsOpen(false); }}
                className={navItemClass(false)}
              >
                <div className="flex items-center gap-3">
                  <div className="w-6 h-6 flex items-center justify-center bg-[#F59E0B] border-[2px] border-[#1A1A1A] shadow-[2px_2px_0_#1A1A1A]">
                    <span className="text-xs">💎</span>
                  </div>
                  <span>Staking</span>
                </div>
                <ChevronRight size={16} className="opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>

              <button 
                onClick={() => { onWidgetClick("Batch transfer 5 USDC to 0xFf... via Omni-Engine"); if(window.innerWidth < 768) setIsOpen(false); }}
                className={navItemClass(false)}
              >
                <div className="flex items-center gap-3">
                  <div className="w-6 h-6 flex items-center justify-center bg-[#10B981] border-[2px] border-[#1A1A1A] shadow-[2px_2px_0_#1A1A1A]">
                    <span className="text-xs">📦</span>
                  </div>
                  <span>Batch Pay</span>
                </div>
                <ChevronRight size={16} className="opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>

              <button 
                onClick={() => { onWidgetClick("Send 10 USDC with Rent Payment memo to 0xFf... via Omni-Engine"); if(window.innerWidth < 768) setIsOpen(false); }}
                className={navItemClass(false)}
              >
                <div className="flex items-center gap-3">
                  <div className="w-6 h-6 flex items-center justify-center bg-[#EC4899] border-[2px] border-[#1A1A1A] shadow-[2px_2px_0_#1A1A1A]">
                    <span className="text-xs">📝</span>
                  </div>
                  <span>Memo Transfer</span>
                </div>
                <ChevronRight size={16} className="opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>

              <button 
                disabled
                className="w-full flex items-center justify-between px-4 py-3 font-bold border-[3px] bg-gray-200 dark:bg-[#111] text-gray-400 dark:text-gray-600 border-[#1A1A1A] dark:border-[#333] shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] cursor-not-allowed opacity-80"
              >
                <div className="flex items-center gap-3">
                  <div className="w-6 h-6 flex items-center justify-center bg-gray-400 border-[2px] border-[#1A1A1A] shadow-[2px_2px_0_#1A1A1A] grayscale opacity-50">
                    <span className="text-xs">🤖</span>
                  </div>
                  <span className="line-through decoration-2">Agent Registry</span>
                </div>
                <span className="text-[9px] bg-[#FACC15] text-[#1A1A1A] border-[2px] border-[#1A1A1A] px-1.5 py-0.5 font-black uppercase tracking-widest rotate-[-3deg] shadow-[2px_2px_0_#1A1A1A]">SOON</span>
              </button>

              <button 
                onClick={() => { onWidgetClick("Add 100 USDC and equivalent KLET liquidity to Kletia pool"); if(window.innerWidth < 768) setIsOpen(false); }}
                className={navItemClass(false)}
              >
                <div className="flex items-center gap-3">
                  <div className="w-6 h-6 flex items-center justify-center bg-[#06B6D4] border-[2px] border-[#1A1A1A] shadow-[2px_2px_0_#1A1A1A]">
                    <span className="text-xs">💧</span>
                  </div>
                  <span>Liquidity Pool</span>
                </div>
                <ChevronRight size={16} className="opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>

              <button 
                onClick={() => { onWidgetClick("Lend 5 USDC to Kletia Lending on Arc network"); if(window.innerWidth < 768) setIsOpen(false); }}
                className={navItemClass(false)}
              >
                <div className="flex items-center gap-3">
                  <div className="w-6 h-6 flex items-center justify-center bg-[#10B981] border-[2px] border-[#1A1A1A] shadow-[2px_2px_0_#1A1A1A]">
                    <span className="text-xs">🏦</span>
                  </div>
                  <span>Lending</span>
                </div>
                <ChevronRight size={16} className="opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>

              <button 
                onClick={() => { onWidgetClick("Borrow 5 USDC from Kletia Lending on Arc network"); if(window.innerWidth < 768) setIsOpen(false); }}
                className={navItemClass(false)}
              >
                <div className="flex items-center gap-3">
                  <div className="w-6 h-6 flex items-center justify-center bg-[#EF4444] border-[2px] border-[#1A1A1A] shadow-[2px_2px_0_#1A1A1A]">
                    <span className="text-xs">💸</span>
                  </div>
                  <span>Borrowing</span>
                </div>
                <ChevronRight size={16} className="opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
            </div>

        </div>

        {/* Footer Area of Sidebar */}
        <div className="p-4 border-t-[4px] border-[#1A1A1A] dark:border-[#4B5563] bg-white dark:bg-[#1A2841] text-xs font-bold text-center text-[#1A1A1A] dark:text-gray-300 flex flex-col gap-3">
          <div className="flex items-center justify-between">
             <span>THEME</span>
             <button onClick={toggleTheme} className="p-1.5 border-[2px] border-[#1A1A1A] dark:border-[#4B5563] bg-[#EFEFEF] dark:bg-[#0F172A] shadow-[2px_2px_0_#1A1A1A] dark:shadow-[2px_2px_0_#475569] hover:-translate-y-0.5 active:translate-y-0 transition-all duration-100 ease-out">
               {isDarkMode ? <Sun className="w-4 h-4 text-[#FFD700]" /> : <Moon className="w-4 h-4 text-[#0052FF]" />}
             </button>
          </div>
          <button 
             onClick={clearMessages} 
             className="w-full p-2 mt-2 border-[2px] border-[#1A1A1A] dark:border-[#4B5563] bg-[#FF3B30] text-white shadow-[2px_2px_0_#1A1A1A] dark:shadow-[2px_2px_0_#475569] hover:-translate-y-0.5 hover:shadow-[4px_4px_0_#1A1A1A] active:translate-y-0 active:shadow-[1px_1px_0_#1A1A1A] transition-all duration-100 ease-out font-black flex items-center justify-center gap-2 uppercase tracking-widest"
          >
             <MessageSquare className="w-4 h-4" /> CLEAR HISTORY
          </button>
          <div>Kletia Omni Engine V2.0<br/>Powered by ARC Network</div>
        </div>
      </aside>
    </>
  );
};
