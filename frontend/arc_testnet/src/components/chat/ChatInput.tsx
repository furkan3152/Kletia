import React from 'react';
import { Send } from 'lucide-react';

interface ChatInputProps {
  input: string;
  setInput: (val: string) => void;
  handleSend: () => void;
}

export const ChatInput: React.FC<ChatInputProps> = ({ input, setInput, handleSend }) => {
  return (
    <div className="p-3 md:p-6 bg-transparent pb-6 md:pb-8 z-20 w-full px-4 md:px-6">
      <div className="max-w-4xl mx-auto relative flex items-center">
        <input 
          type="text" 
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSend() }}
          placeholder="What do you want to do? (e.g. Buy KLET with 10 USDC)"
          className="w-full bg-white dark:bg-[#1A2841] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] focus:bg-[#FAFAFA] dark:focus:bg-[#131E32] text-[#1A1A1A] dark:text-white font-black text-sm md:text-lg placeholder-gray-500 dark:placeholder-slate-400 py-3.5 px-4 pr-16 md:py-5 md:px-5 md:pr-20 outline-none shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#475569] md:shadow-[4px_4px_0_#1A1A1A] dark:md:shadow-[4px_4px_0_#475569] transition-colors"
        />
        <button 
          onClick={handleSend}
          disabled={!input.trim()}
          className="absolute right-2 md:right-3.5 p-2.5 md:p-3 bg-white dark:bg-[#131E32] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] text-[#1A1A1A] dark:text-white hover:bg-gray-100 dark:hover:bg-[#1A2841] disabled:bg-gray-200 dark:disabled:bg-slate-800 disabled:text-gray-400 dark:disabled:text-slate-500 shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#475569] active:translate-y-1 active:shadow-none transition-all"
        >
          <Send className="w-5 h-5 md:w-7 md:h-7" strokeWidth={4} />
        </button>
      </div>
      <p className="text-center text-[9px] md:text-[10px] text-gray-500 dark:text-slate-400 mt-2 md:mt-3 font-bold px-4">
        Kletia Omni-Engine can make mistakes, please double check before confirming transactions.
      </p>
    </div>
  );
};
