
import { Target, TrendingUp, Clock, FileKey2 } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';

export function WidgetLauncher() {
  const { addMessage } = useAppStore();

  const launchWidget = (type: 'copy_trade' | 'yield_optimizer' | 'limit_order', title: string) => {
    addMessage({
      id: Date.now().toString(),
      role: 'kletia',
      text: `🚀 **${title}** module activated. Relevant UI is ready below:`,
      widgetType: type
    });

    setTimeout(() => {
        const chatContainer = document.getElementById('chat-container');
        if (chatContainer) {
            chatContainer.scrollTop = chatContainer.scrollHeight;
        }
    }, 100);
  };

  return (
    <div className="w-full flex items-center gap-2 overflow-x-auto pb-4 mb-2 mt-2 hide-scrollbar">
      <button 
        onClick={() => launchWidget('copy_trade', 'Balina Takibi (Copy-Trade)')}
        className="flex-shrink-0 flex items-center gap-2 px-4 py-2 bg-white dark:bg-[#1A1A1A] border-2 border-[#1A1A1A] dark:border-[#333] shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#CCA000] font-bold text-sm hover:-translate-y-0.5 hover:shadow-[4px_4px_0_#1A1A1A] transition-all"
      >
        <Target size={16} className="text-red-500" />
        Balina Takibi
      </button>

      <button 
        onClick={() => launchWidget('yield_optimizer', 'Otonom Yield Hunter')}
        className="flex-shrink-0 flex items-center gap-2 px-4 py-2 bg-white dark:bg-[#1A1A1A] border-2 border-[#1A1A1A] dark:border-[#333] shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#60A5FA] font-bold text-sm hover:-translate-y-0.5 hover:shadow-[4px_4px_0_#1A1A1A] transition-all"
      >
        <TrendingUp size={16} className="text-green-500" />
        Yield Hunter
      </button>

      <button 
        onClick={() => launchWidget('limit_order', 'Scheduled / Conditional Order')}
        className="flex-shrink-0 flex items-center gap-2 px-4 py-2 bg-white dark:bg-[#1A1A1A] border-2 border-[#1A1A1A] dark:border-[#333] shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#CCA000] font-bold text-sm hover:-translate-y-0.5 hover:shadow-[4px_4px_0_#1A1A1A] transition-all"
      >
        <Clock size={16} className="text-[#0052FF]" />
        Otomatik Emir
      </button>

      <button 
        className="flex-shrink-0 flex items-center gap-2 px-4 py-2 bg-gray-200 dark:bg-[#111] border-2 border-[#1A1A1A] dark:border-[#333] font-bold text-sm opacity-50 cursor-not-allowed"
        title="Soon"
      >
        <FileKey2 size={16} />
        Session Key
      </button>

      <style>{`
        .hide-scrollbar::-webkit-scrollbar { display: none; }
        .hide-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
      `}</style>
    </div>
  );
}
