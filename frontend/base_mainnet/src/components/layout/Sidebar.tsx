import React from 'react';
import { Zap, User } from 'lucide-react';
import { useAccount } from 'wagmi';
import { AlloraWidget } from '../AlloraWidget';
import { useAppStore } from '../../store/useAppStore';
import { useNetwork } from '../../hooks/useNetwork';
import PortfolioViewer from '../PortfolioViewer';
import ArcPortfolioViewer from '../ArcPortfolioViewer';
import {
  isArcPortfolioData,
  isBasePortfolioData,
} from '../../types';

interface SidebarProps {
  isPortfolioOpen: boolean;
  setIsPortfolioOpen: (open: boolean) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ isPortfolioOpen, setIsPortfolioOpen }) => {
  const { isDarkMode, messages } = useAppStore();
  const { networkMode, network } = useNetwork();
  const { address } = useAccount();

  if (!isPortfolioOpen) return null;

  return (
    <div className="absolute lg:relative right-0 top-0 h-full w-full sm:w-80 md:w-96 border-l-[3px] border-[#1A1A1A] dark:border-[#4B5563] bg-[#FDFDFD] dark:bg-[#0B1121] overflow-y-auto flex flex-col shadow-[[-4px_0_0_#1A1A1A]] dark:shadow-[[-4px_0_0_#475569]] shrink-0 z-30">
      <div className="sticky top-0 p-4 border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563] flex justify-between items-center bg-[#FFD700] dark:bg-[#60A5FA] text-[#1A1A1A] z-10">
        <h2 className="font-black text-lg uppercase tracking-wider flex items-center gap-2">
          <Zap className="w-5 h-5"/> {network.shortName.toUpperCase()} PORTFÖY
        </h2>
        <button 
          onClick={() => setIsPortfolioOpen(false)} 
          className="font-black text-xl border-[3px] border-[#1A1A1A] px-2 hover:bg-[#1A1A1A] hover:text-[#FFD700] dark:hover:text-[#60A5FA] transition-colors shadow-[2px_2px_0_#1A1A1A] dark:shadow-[2px_2px_0_#475569]"
        >
          X
        </button>
      </div>
      <div className="p-4 bg-[#FDFDFD] dark:bg-[#0B1121] flex-1 flex flex-col gap-4">
        {networkMode === 'base' && (
          <AlloraWidget isDarkMode={isDarkMode} asset="ETH" />
        )}
        {(() => {
          const latestPortfolioMessage = [...messages].reverse().find(
            (message) =>
              message.intentData?.action === 'portfolio' &&
              message.network === networkMode &&
              message.chainId === network.chainId &&
              message.intentData.network === networkMode &&
              message.intentData.chainId === network.chainId &&
              Boolean(address) &&
              message.walletAddress?.toLowerCase() === address?.toLowerCase(),
          );
          const latestPortfolio = latestPortfolioMessage?.intentData?.data;

          if (networkMode === 'base' && isBasePortfolioData(latestPortfolio)) {
            return <PortfolioViewer data={latestPortfolio} />;
          }
          if (networkMode === 'arc' && isArcPortfolioData(latestPortfolio)) {
            return <ArcPortfolioViewer data={latestPortfolio} />;
          }
          if (latestPortfolio) {
            return (
              <div className="p-5 mt-4 border-[3px] border-[#1A1A1A] bg-[#FEE2E2] dark:bg-red-950/30 dark:border-red-500 dark:text-white shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#EF4444] text-center font-bold">
                Portföy yanıtı aktif ağın doğrulanmış veri şemasıyla eşleşmedi.
                Güvenlik için gösterilmedi; lütfen yeniden taratın.
              </div>
            );
          }
          return (
            <div className="p-5 mt-4 border-[3px] border-[#1A1A1A] bg-white dark:bg-[#131E32] dark:border-[#4B5563] dark:text-white shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] text-center font-bold flex flex-col items-center gap-3">
              <User className="w-8 h-8 opacity-50" />
              <span>
                Bu cüzdan için {network.shortName} portföyü henüz taranmadı.
                Sohbete{' '}
                <b>
                  "{networkMode === 'arc'
                    ? 'Arc portföyümü göster'
                    : 'Portföyümü göster'}"
                </b>{' '}
                yazabilirsiniz.
              </span>
            </div>
          );
        })()}
      </div>
    </div>
  );
};
