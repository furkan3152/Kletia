import React from 'react';

interface Props {
  title: string;
  children: React.ReactNode;
  onClose?: () => void;
}

export function AgentWidgetContainer({ title, children, onClose }: Props) {
  return (
    <div className="mt-4 border-2 border-[#1A1A1A] dark:border-[#333] rounded bg-white dark:bg-[#1A1A1A] shadow-[4px_4px_0px_#1A1A1A] dark:shadow-[4px_4px_0px_#CCA000] overflow-hidden transition-all">
      <div className="bg-[#60A5FA] dark:bg-[#CCA000] text-[#1A1A1A] px-4 py-2 font-bold flex justify-between items-center border-b-2 border-[#1A1A1A] dark:border-[#333]">
        <div className="flex items-center gap-2">
          <span className="text-xl">🤖</span>
          {title}
        </div>
        {onClose && (
          <button 
            onClick={onClose}
            className="hover:bg-[#1A1A1A] hover:text-[#60A5FA] dark:hover:text-[#CCA000] px-2 py-1 rounded transition-colors"
          >
            ✕
          </button>
        )}
      </div>
      <div className="p-4 text-[#1A1A1A] dark:text-[#E5E7EB]">
        {children}
      </div>
    </div>
  );
}
