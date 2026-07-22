import React from 'react';
import { MessageSquare, Fingerprint, Target, TrendingUp, Clock, FileKey2, ChevronRight, ShieldAlert, Shield, Hexagon, Sun, Moon } from 'lucide-react';
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
          </div>
            
          <div className="space-y-3">
              <h3 className="text-xs font-black text-gray-500 dark:text-slate-400 tracking-widest uppercase ml-2">Ekosistem & Safek</h3>
              
              <button 
                onClick={() => { onWidgetClick('Open Webacy security center'); if(window.innerWidth < 768) setIsOpen(false); }}
                className={navItemClass(activeTab === 'webacy' && !isPortfolioOpen)}
              >
                <div className="flex items-center gap-3">
                  <Shield size={18} className={activeTab === 'webacy' && !isPortfolioOpen ? 'text-white' : 'text-[#00d66f]'} />
                  <span>Webacy Safek Merkezi</span>
                </div>
                <ChevronRight size={16} className="opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>

              <button 
                onClick={() => { onWidgetClick('Open Allora AI center'); if(window.innerWidth < 768) setIsOpen(false); }}
                className={navItemClass(activeTab === 'allora' && !isPortfolioOpen)}
              >
                <div className="flex items-center gap-3">
                  <Fingerprint size={18} className={activeTab === 'allora' && !isPortfolioOpen ? 'text-white' : 'text-purple-500'} />
                  <span>Allora AI Hub</span>
                </div>
                <ChevronRight size={16} className="opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>

              <button 
                onClick={() => { onWidgetClick('Open Basename registration system'); if(window.innerWidth < 768) setIsOpen(false); }}
                className={navItemClass(activeTab === 'basename' && !isPortfolioOpen)}
              >
                <div className="flex items-center gap-3">
                  <div className="w-4 h-4 rounded-full bg-blue-500 flex items-center justify-center text-[10px] text-white">B</div>
                  <span>Basename Claim</span>
                </div>
                <ChevronRight size={16} className="opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>

              <button 
                onClick={() => { onWidgetClick('Open Airdrop simulator'); if(window.innerWidth < 768) setIsOpen(false); }}
                className={navItemClass(activeTab === 'airdrop' && !isPortfolioOpen)}
              >
                <div className="flex items-center gap-3">
                  <ShieldAlert size={18} className={activeTab === 'airdrop' && !isPortfolioOpen ? 'text-white' : 'text-orange-500'} />
                  <span>Airdrop Simulator</span>
                </div>
                <ChevronRight size={16} className="opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
              
              <button 
                onClick={() => { onWidgetClick('Open x402 payment console'); if(window.innerWidth < 768) setIsOpen(false); }}
                className={navItemClass(activeTab === 'x402' && !isPortfolioOpen)}
              >
                <div className="flex items-center gap-3">
                  <div className="w-5 h-5 flex items-center justify-center bg-transparent border-2 border-current rounded-sm">
                    <span className="text-[10px] font-black">402</span>
                  </div>
                  <span>x402 Console</span>
                </div>
                <ChevronRight size={16} className="opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>
            </div>
            <div className="space-y-3 pb-8">
              <h3 className="text-xs font-black text-gray-500 dark:text-slate-400 tracking-widest uppercase ml-2 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span> Autonomous Tools
              </h3>
              
              <button 
                onClick={() => { onWidgetClick('Start whale tracking (copy-trade)'); if(window.innerWidth < 768) setIsOpen(false); }}
                className={navItemClass(false)}
              >
                <div className="flex items-center gap-3">
                  <Target size={18} className="text-red-500" />
                  <span>Balina Takibi</span>
                </div>
                <ChevronRight size={16} className="opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>

              <button 
                onClick={() => { onWidgetClick('Start auto yield optimizer'); if(window.innerWidth < 768) setIsOpen(false); }}
                className={navItemClass(false)}
              >
                <div className="flex items-center gap-3">
                  <TrendingUp size={18} className="text-green-500" />
                  <span>Yield Hunter</span>
                </div>
                <ChevronRight size={16} className="opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>

              <button 
                onClick={() => { onWidgetClick('Start scheduled / conditional order (limit order)'); if(window.innerWidth < 768) setIsOpen(false); }}
                className={navItemClass(false)}
              >
                <div className="flex items-center gap-3">
                  <Clock size={18} className="text-blue-500" />
                  <span>Otomatik Emir</span>
                </div>
                <ChevronRight size={16} className="opacity-0 group-hover:opacity-100 transition-opacity" />
              </button>

              <button 
                disabled
                className="w-full flex items-center justify-between px-4 py-3 font-bold border-2 bg-gray-200 dark:bg-[#111] text-gray-400 dark:text-gray-600 border-[#1A1A1A] dark:border-[#333] shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] cursor-not-allowed opacity-60"
              >
                <div className="flex items-center gap-3">
                  <FileKey2 size={18} />
                  <span>Session Key</span>
                </div>
                <span className="text-[10px] bg-black text-white px-1.5 py-0.5 rounded">YAKINDA</span>
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
          <div>Kletia Omni Engine V2.0<br/>Powered by Base & Allora</div>
        </div>
      </aside>
    </>
  );
};
