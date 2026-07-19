import React from 'react';
import { Terminal as TerminalIcon } from 'lucide-react';
import { ChatMessage } from '../../types';
import { useAppStore } from '../../store/useAppStore';

interface TerminalLogsProps {
  msg: ChatMessage;
}

export const TerminalLogs: React.FC<TerminalLogsProps> = ({ msg }) => {
  const isArcMode = useAppStore(state => state.isArcMode);

  if (!msg.terminalLogs || msg.terminalLogs.length === 0) return null;

  const explorerUrl = isArcMode ? `https://testnet.arcscan.app/tx/${msg.txHash}` : `https://sepolia.basescan.org/tx/${msg.txHash}`;
  const explorerName = isArcMode ? 'Arc Explorer' : 'BaseScan';

  return (
    <div className="mt-4 md:mt-5 p-3 md:p-4 bg-[#1A1A1A] dark:bg-slate-900 border-[3px] border-gray-500 dark:border-[#4B5563] font-mono text-xs md:text-[13px] text-green-400 leading-relaxed overflow-x-hidden w-full sm:w-80 md:w-[450px] shadow-[3px_3px_0_#475569] dark:shadow-[3px_3px_0_#475569]">
      <div className="text-white font-black mb-2 md:mb-3 pb-1.5 md:pb-2 border-b-[3px] border-gray-600 dark:border-slate-700 flex items-center gap-2 uppercase tracking-wide">
          <TerminalIcon className="w-4 h-4 md:w-5 md:h-5"/> X-Ray Console
      </div>
      {msg.terminalLogs.map((log, i) => (
        <div key={i} className={`py-0.5 break-words ${log.includes('❌') ? 'text-red-400 font-black' : log.includes('⚠️') ? 'text-yellow-400' : log.includes('🛡️') ? 'text-blue-400' : log.includes('✅') ? 'text-green-500 font-black' : ''}`}>
           <span className="text-gray-500 dark:text-slate-500 mr-1.5">{'>'}</span>{log}
        </div>
      ))}
      {msg.txHash && (
        <a href={explorerUrl} target="_blank" rel="noreferrer" className="text-[#0052FF] hover:text-white hover:underline mt-3 md:mt-4 pt-2 md:pt-3 border-t-[3px] border-gray-600 dark:border-slate-700 block flex items-center gap-1 font-black transition-colors break-all">
          {explorerName} ↗
        </a>
      )}
    </div>
  );
};
