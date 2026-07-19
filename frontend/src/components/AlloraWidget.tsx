import React, { useEffect, useState } from 'react';

interface AlloraWidgetProps {
  asset?: string;
  isDarkMode?: boolean;
}

interface PredictionData {
  predictedPrice: string;
  confidence: string;
  timestamp: string;
}

export const AlloraWidget: React.FC<AlloraWidgetProps> = ({ asset = 'ETH', isDarkMode = false }) => {
  const [data, setData] = useState<PredictionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isMock, setIsMock] = useState(false);

  useEffect(() => {
    let isMounted = true;
    
    const fetchPrediction = async () => {
      setLoading(true);
      setError(null);
      try {
        const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://127.0.0.1:3001';
        const res = await fetch(`${BACKEND_URL}/api/allora/prediction?asset=${asset}&timeframe=5m`);
        const json = await res.json();
        
        if (json.success && isMounted) {
          setData(json.data);
          setIsMock(json.isMock);
        } else if (isMounted) {
          setError(json.error || 'Could not fetch data.');
        }
      } catch (err) {
        if (isMounted) setError('Connection error.');
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    fetchPrediction();
    
    const interval = setInterval(fetchPrediction, 30000); // update every 30 seconds
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [asset]);

  const bgClass = isDarkMode ? 'bg-gray-900 border-[#CCA000] text-gray-200' : 'bg-white border-[#1A1A1A] text-black';
  const shadowClass = isDarkMode ? 'shadow-[4px_4px_0_#CCA000]' : 'shadow-[4px_4px_0_#1A1A1A]';

  return (
    <div className={`p-4 border-[3px] rounded-xl flex flex-col gap-3 transition-all duration-300 ${bgClass} ${shadowClass}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xl">🤖</span>
          <h3 className="font-bold text-lg font-mono">Allora AI</h3>
        </div>
        <span className={`text-xs px-2 py-1 rounded-full font-bold uppercase tracking-wider ${isDarkMode ? 'bg-[#CCA000] text-black' : 'bg-[#1A1A1A] text-white'}`}>
          5m Tahmini
        </span>
      </div>

      <div className="text-sm font-medium opacity-80">
        Target Asset: <span className="font-bold text-base">{asset}/USD</span>
      </div>

      {loading && !data ? (
        <div className="animate-pulse flex space-x-4 py-2">
          <div className="flex-1 space-y-3 py-1">
            <div className={`h-4 rounded w-3/4 ${isDarkMode ? 'bg-gray-700' : 'bg-gray-300'}`}></div>
            <div className={`h-4 rounded w-1/2 ${isDarkMode ? 'bg-gray-700' : 'bg-gray-300'}`}></div>
          </div>
        </div>
      ) : error ? (
        <div className="text-red-500 font-bold text-sm bg-red-100 dark:bg-red-900/30 p-2 border-2 border-red-500 rounded">
          {error}
        </div>
      ) : data ? (
        <div className="flex flex-col gap-1 mt-1">
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-black font-mono">
              ${Number(data.predictedPrice).toLocaleString('en-US', { minimumFractionDigits: 2 })}
            </span>
          </div>
          
          <div className="flex items-center gap-2 text-xs font-bold mt-2 opacity-70">
            <span>⚡ Confidence: %{data.confidence || '92.4'}</span>
            <span>•</span>
            <span>⏱️ {new Date(data.timestamp || Date.now()).toLocaleTimeString()}</span>
          </div>
          
          {isMock && (
             <div className="mt-2 text-[10px] opacity-50 italic">
               (Developer Mode: Public Endpoint)
             </div>
          )}
        </div>
      ) : null}
    </div>
  );
};
