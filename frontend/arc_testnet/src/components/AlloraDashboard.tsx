import React, { useEffect, useState } from 'react';

interface PredictionData {
  asset: string;
  currentPrice: string;
  predictedPrice: string;
  differencePercent: string;
  recommendation: 'BUY' | 'SELL' | 'HOLD' | 'ERROR';
}

interface AlloraDashboardProps {
  isDarkMode: boolean;
  onActionClick: (prompt: string) => void;
}

export const AlloraDashboard: React.FC<AlloraDashboardProps> = ({ isDarkMode, onActionClick }) => {
  const [data, setData] = useState<PredictionData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [timeframe, setTimeframe] = useState<'5m' | '8h'>('8h');

  const assets = ['ETH', 'BTC'];

  useEffect(() => {
    let isMounted = true;
    
    const fetchPredictions = async () => {
      setLoading(true);
      setError(null);
      try {
        const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://127.0.0.1:3001';
        const res = await fetch(`${BACKEND_URL}/api/allora/multi-prediction`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assets, timeframe })
        });
        const json = await res.json();
        
        if (json.success && isMounted) {
          setData(json.data);
        } else if (isMounted) {
          setError(json.error || 'Could not fetch data.');
        }
      } catch (err) {
        if (isMounted) setError('Connection error.');
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    fetchPredictions();
    const interval = setInterval(fetchPredictions, 30000); 
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [timeframe]); // Trigger re-fetch when timeframe changes

  const bgClass = isDarkMode ? 'bg-gray-900 text-gray-200' : 'bg-gray-50 text-black';
  const cardBg = isDarkMode ? 'bg-gray-800 border-[#CCA000] shadow-[4px_4px_0_#CCA000]' : 'bg-white border-[#1A1A1A] shadow-[4px_4px_0_#1A1A1A]';
  const headerText = isDarkMode ? 'text-[#CCA000]' : 'text-blue-600';

  return (
    <div className={`p-8 w-full max-w-7xl mx-auto min-h-[80vh] flex flex-col gap-6 ${bgClass}`}>
      
      {/* BAŞLIK & AYARLAR */}
      <div className="flex flex-col md:flex-row justify-between items-center border-b-4 border-current pb-4">
        <div>
          <h1 className={`text-4xl font-black uppercase tracking-tighter ${headerText}`}>
            Allora <span className={isDarkMode ? 'text-gray-100' : 'text-gray-900'}>Otonom Analiz</span>
          </h1>
          <p className="font-bold opacity-80 uppercase mt-2 tracking-widest text-sm">
            Live Price &gt; AI Prediction ➔ Auto Decision
          </p>
        </div>
        
        {/* TIMEFRAME SELECTION */}
        <div className="mt-4 md:mt-0 flex items-center gap-4">
          <label className="font-bold uppercase text-sm">Zaman Dilimi:</label>
          <select 
            value={timeframe} 
            onChange={(e) => setTimeframe(e.target.value as '5m' | '8h')}
            className={`p-2 border-2 font-bold focus:outline-none transition-all hover:translate-y-[-2px] ${
              isDarkMode ? 'bg-gray-800 border-[#CCA000] text-[#CCA000]' : 'bg-white border-blue-600 text-blue-600'
            }`}
          >
            <option value="5m">5 Minutes (Short Term)</option>
            <option value="8h">8 Saat (Orta Vade)</option>
          </select>
        </div>
      </div>

      {/* KARTLAR */}
      {loading && data.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1">
          <div className={`w-16 h-16 border-8 border-dashed rounded-full animate-spin ${isDarkMode ? 'border-[#CCA000]' : 'border-blue-600'}`}></div>
          <p className="mt-4 font-bold uppercase tracking-widest animate-pulse">Market Analysis in Progress...</p>
        </div>
      ) : error ? (
        <div className="bg-red-500 text-white font-bold p-6 border-4 border-red-900 uppercase tracking-widest">
          ❌ {error}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {data.map((item, idx) => {
            const diffPercent = parseFloat(item.differencePercent);
            const isPositive = diffPercent > 0;
            const diffColor = isPositive ? 'text-green-500' : diffPercent < 0 ? 'text-red-500' : 'text-gray-500';

            return (
              <div 
                key={idx} 
                className={`border-4 p-6 flex flex-col gap-4 transform transition-all duration-200 hover:-translate-y-2 hover:translate-x-2 ${cardBg}`}
              >
                <div className="flex justify-between items-center border-b-2 border-dashed border-gray-500 pb-2">
                  <h2 className="text-3xl font-black">{item.asset}</h2>
                  <span className={`text-sm font-bold uppercase px-2 py-1 border-2 ${
                    item.recommendation === 'BUY' ? 'border-green-500 text-green-500' : 
                    item.recommendation === 'SELL' ? 'border-red-500 text-red-500' : 
                    'border-gray-500 text-gray-500'
                  }`}>
                    {item.recommendation}
                  </span>
                </div>
                
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-bold uppercase opacity-70">Live Price (Binance)</span>
                  <span className="text-xl font-bold">${item.currentPrice}</span>
                </div>

                <div className="flex flex-col gap-1">
                  <span className="text-xs font-bold uppercase opacity-70">Allora Tahmini ({timeframe})</span>
                  <div className="flex items-end gap-2">
                    <span className={`text-3xl font-black ${headerText}`}>${item.predictedPrice}</span>
                    <span className={`text-lg font-bold mb-1 ${diffColor}`}>
                      {isPositive ? '▲' : '▼'} {item.differencePercent}%
                    </span>
                  </div>
                </div>

                <div className="flex flex-col gap-2 mt-auto pt-4 border-t-2 border-dashed border-gray-500">
                  {item.recommendation === 'BUY' && (
                    <button 
                      onClick={() => onActionClick(`Buy with USDC based on Allora's bullish prediction ${item.asset} buy`)}
                      className="w-full py-3 bg-green-500 text-white font-black uppercase tracking-wider border-b-4 border-green-800 hover:bg-green-400 active:translate-y-1 active:border-b-0 transition-all"
                    >
                      🚀 AI Önerisi: {item.asset} AL
                    </button>
                  )}
                  {item.recommendation === 'SELL' && (
                    <button 
                      onClick={() => onActionClick(`Sell to USDC based on Allora's bearish prediction ${item.asset}to USDC`)}
                      className="w-full py-3 bg-red-500 text-white font-black uppercase tracking-wider border-b-4 border-red-800 hover:bg-red-400 active:translate-y-1 active:border-b-0 transition-all"
                    >
                      📉 AI Önerisi: {item.asset} SAT
                    </button>
                  )}
                  {(item.recommendation === 'HOLD' || item.recommendation === 'ERROR') && (
                    <button 
                      disabled
                      className="w-full py-3 bg-gray-500 text-white font-black uppercase tracking-wider opacity-50 cursor-not-allowed"
                    >
                      ✋ Does not recommend action
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
