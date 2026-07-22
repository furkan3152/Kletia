import React, { useState } from 'react';
import { Search, RefreshCw, Fingerprint, Database, Cpu, Wallet, Calendar, Activity, Clock } from 'lucide-react';
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';

const publicClient = createPublicClient({
  chain: base,
  transport: http()
});

const BNS_NFT = "0x03c4738Ee98aE44591e1A4A4F3CaB6641d95DD9a";
const BNS_ABI = [
  { "inputs": [{ "internalType": "address", "name": "owner", "type": "address" }], "name": "balanceOf", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" }
] as const;

async function fetchPrices(addresses: string[]): Promise<Record<string, number>> {
  const priceMap: Record<string, number> = {};
  for (let i = 0; i < addresses.length; i += 30) {
    const chunk = addresses.slice(i, i + 30).join(',');
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${chunk}`);
      const json = await res.json();
      if (json?.pairs) {
        for (const pair of json.pairs) {
          const addr = pair.baseToken.address.toLowerCase();
          if (!priceMap[addr] && pair.priceUsd) {
            priceMap[addr] = parseFloat(pair.priceUsd);
          }
        }
      }
    } catch (e) {
      console.error('DexScreener fetch error:', e);
    }
  }
  return priceMap;
}

export const AirdropSimulator: React.FC = () => {
  const [inputAddress, setInputAddress] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [result, setResult] = useState<null | any>(null);
  const [hasBasename, setHasBasename] = useState(false);
  
  // AI Agent States
  const [agentLogs, setAgentLogs] = useState<string[]>([]);
  const [agentStatus, setAgentStatus] = useState<'idle' | 'running' | 'done'>('idle');

  const handleDeepAnalysis = async () => {
    setAgentStatus('running');
    setAgentLogs(["Starting AI agent... X402 payment protocol engaged."]);
    try {
      const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';
      const response = await fetch(`${BACKEND_URL}/api/agent/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userAddress: inputAddress,
          prompt: `${inputAddress} I want to do advanced sybil analysis for wallet. Please fetch Premium Sybil Analysis data by paying x402 to '${BACKEND_URL}/api/premium/sybil-report?address=${inputAddress}' and explain results (active days, wallet age, tx variance) to me in detail.`
        })
      });

      if (!response.body) throw new Error("Could not connect to agent.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() || "";
        
        for (const evt of events) {
          const lines = evt.split('\n');
          let eventName = '';
          let data = '';
          for (const line of lines) {
            if (line.startsWith('event: ')) eventName = line.replace('event: ', '').trim();
            if (line.startsWith('data: ')) data = line.substring(6).trim(); // Remove "data: "
          }
          
          if (data) {
            try {
              const parsedData = JSON.parse(data);
              if (eventName === 'log') {
                setAgentLogs(prev => [...prev, `[SYSTEM]: ${parsedData}`]);
              } else if (eventName === 'agent') {
                setAgentLogs(prev => [...prev, `[KLETIA AI]: ${parsedData}`]);
              } else if (eventName === 'tools') {
                setAgentLogs(prev => [...prev, `[TOOL CALL]: Agent is using authorization tools...`]);
              } else if (eventName === 'error') {
                setAgentLogs(prev => [...prev, `[HATA]: ${parsedData}`]);
              }
            } catch(e) {
              // ignore
            }
          }
        }
      }
    } catch (e: any) {
      setAgentLogs(prev => [...prev, `[SYSTEM ERROR]: ${e.message}`]);
    } finally {
      setAgentStatus('done');
    }
  };

  const handleScan = async () => {
    if (!inputAddress || !inputAddress.startsWith('0x') || inputAddress.length !== 42) {
      alert('Please enter a valid 0x wallet address.');
      return;
    }

    setIsScanning(true);
    setResult(null);

    try {
      // 2. AI SYBIL SCORING (Trusta/Nomis Aggregator)
      let aiScore = 0;
      let aiRiskLevel = 'Bilinmiyor';
      let aiSource = 'Nomis AI / Trusta (Fallback)';
      try {
        const nomisRes = await fetch(`https://api.nomis.cc/api/v1/base/wallet/${inputAddress}/score`);
        if (nomisRes.ok) {
           const nomisData = await nomisRes.json();
           aiScore = nomisData.data?.score || 0;
           aiSource = 'Nomis AI Platform';
           aiRiskLevel = aiScore > 60 ? 'Low Risk' : 'High Risk';
        } else {
           throw new Error('API Key Required / Limit Reached');
        }
      } catch (e) {
        // FALLBACK: Kletia Local AI Heuristic
        aiSource = 'Kletia AI Engine (Local)';
      }

      try {
        const bnsBalance = await publicClient.readContract({
          address: BNS_NFT,
          abi: BNS_ABI,
          functionName: 'balanceOf',
          args: [inputAddress as `0x${string}`]
        });
        if (bnsBalance > 0n) {
          setHasBasename(true);
        } else {
          setHasBasename(false);
        }
      } catch (e) {
        console.error("BNS fetch failed", e);
      }

      // 3. BLOCKSCOUT RAW DATA (Promise.all)
      const baseUrl = `https://base.blockscout.com/api`;
      const [txRes, internalRes, tokenRes, nftRes, nft1155Res, priceRes] = await Promise.all([
        fetch(`${baseUrl}?module=account&action=txlist&address=${inputAddress}&startblock=0&endblock=99999999&page=1&offset=10000&sort=asc`),
        fetch(`${baseUrl}?module=account&action=txlistinternal&address=${inputAddress}&startblock=0&endblock=99999999&page=1&offset=10000&sort=asc`),
        fetch(`${baseUrl}?module=account&action=tokentx&address=${inputAddress}&startblock=0&endblock=99999999&page=1&offset=10000&sort=asc`),
        fetch(`${baseUrl}?module=account&action=tokennfttx&address=${inputAddress}&startblock=0&endblock=99999999&page=1&offset=10000&sort=asc`),
        fetch(`${baseUrl}?module=account&action=token1155tx&address=${inputAddress}&startblock=0&endblock=99999999&page=1&offset=10000&sort=asc`),
        fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot')
      ]);

      const [txData, internalData, tokenData, nftData, nft1155Data, priceData] = await Promise.all([
        txRes.json(), internalRes.json(), tokenRes.json(), nftRes.json(), nft1155Res.json(), priceRes.json()
      ]);

      const ethPrice = parseFloat(priceData.data.amount);
      const normalTxs = txData.status === "1" ? txData.result : [];
      const internalTxs = internalData.status === "1" ? internalData.result : [];
      const tokenTxs = tokenData.status === "1" ? tokenData.result : [];
      const nftTxs = nftData.status === "1" ? nftData.result : [];
      const nft1155Txs = nft1155Data.status === "1" ? nft1155Data.result : [];

      const uniqueContracts = new Set<string>();
      let totalEthVolume = 0;
      let totalTokenVolumeUsd = 0;
      let totalGasSpentEth = 0;
      let dustTxCount = 0;
      const lowerAddress = inputAddress.toLowerCase();
      
      const activeMonthsSet = new Set<string>();
      let firstTxTimestamp = Date.now();

      for (const tx of normalTxs) {
        const isFromMe = tx.from.toLowerCase() === lowerAddress;
        const isToMe = tx.to && tx.to.toLowerCase() === lowerAddress;
        
        const timestamp = parseInt(tx.timeStamp) * 1000;
        if (timestamp < firstTxTimestamp) firstTxTimestamp = timestamp;
        
        const date = new Date(timestamp);
        activeMonthsSet.add(`${date.getFullYear()}-${date.getMonth()}`);

        // Add to contracts only if we interacted with a smart contract (input !== '0x' or '0x00')
        if (tx.to && tx.to.toLowerCase() !== lowerAddress && tx.input && tx.input !== '0x' && tx.input !== '0x00') {
          uniqueContracts.add(tx.to.toLowerCase());
        }
        if (tx.contractAddress) {
          uniqueContracts.add(tx.contractAddress.toLowerCase());
        }

        if (isFromMe || isToMe) {
          const valEth = Number(tx.value) / 1e18;
          totalEthVolume += valEth;
        }

        if (isFromMe) {
          // Add 1.35x multiplier to roughly estimate L1 Data fee on Base which is missing in txlist API
          totalGasSpentEth += ((Number(tx.gasUsed) * Number(tx.gasPrice)) / 1e18) * 1.35;
          const valEth = Number(tx.value) / 1e18;
          if (valEth > 0 && valEth < 0.001) dustTxCount++;
        }
      }

      for (const tx of internalTxs) {
        if (tx.from && tx.from.toLowerCase() !== lowerAddress) uniqueContracts.add(tx.from.toLowerCase());
        if (tx.to && tx.to.toLowerCase() !== lowerAddress) uniqueContracts.add(tx.to.toLowerCase());
        
        const isFromMe = tx.from && tx.from.toLowerCase() === lowerAddress;
        const isToMe = tx.to && tx.to.toLowerCase() === lowerAddress;
        
        if (isFromMe || isToMe) {
          totalEthVolume += Number(tx.value) / 1e18;
        }
      }

      const tokenAddressesToFetch = new Set<string>();
      for (const tx of tokenTxs) {
        if (tx.contractAddress) {
          uniqueContracts.add(tx.contractAddress.toLowerCase());
          tokenAddressesToFetch.add(tx.contractAddress.toLowerCase());
        }
      }

      // Fetch dynamic prices for all traded tokens
      const tokenPrices = await fetchPrices(Array.from(tokenAddressesToFetch));

      for (const tx of tokenTxs) {
        const isFromMe = tx.from.toLowerCase() === lowerAddress;
        const isToMe = tx.to && tx.to.toLowerCase() === lowerAddress;

        if (isFromMe || isToMe) {
          const symbol = tx.tokenSymbol ? tx.tokenSymbol.toUpperCase() : '';
          const decimals = Number(tx.tokenDecimal || 18);
          const amountStr = tx.value || "0";
          const amount = Number(amountStr) / Math.pow(10, decimals);

          if (symbol === 'WETH') {
            totalEthVolume += amount;
          } else {
            const price = tokenPrices[tx.contractAddress.toLowerCase()] || 0;
            totalTokenVolumeUsd += amount * price;
          }
        }
      }

      for (const tx of nftTxs) {
         if (tx.contractAddress) uniqueContracts.add(tx.contractAddress.toLowerCase());
      }
      
      for (const tx of nft1155Txs) {
         if (tx.contractAddress) uniqueContracts.add(tx.contractAddress.toLowerCase());
      }

      const totalVolumeUsd = (totalEthVolume * ethPrice) + totalTokenVolumeUsd;
      const totalGasSpentUsd = totalGasSpentEth * ethPrice;
      const activeMonths = activeMonthsSet.size || 1;
      const accountAgeDays = Math.max(1, Math.floor((Date.now() - firstTxTimestamp) / (1000 * 60 * 60 * 24)));
      const totalTxs = normalTxs.length;

      // Fallback Engine calculations
      if (aiSource === 'Kletia AI Engine (Local)') {
        let fallbackScore = 30;
        if (totalVolumeUsd > 1000) fallbackScore += 15;
        if (totalVolumeUsd > 10000) fallbackScore += 20;
        if (uniqueContracts.size > 20) fallbackScore += 10;
        if (uniqueContracts.size > 100) fallbackScore += 15;
        if (dustTxCount < 10) fallbackScore += 10;
        if (activeMonths > 3) fallbackScore += 10;
        
        aiScore = fallbackScore > 100 ? 100 : fallbackScore;
        aiRiskLevel = dustTxCount > 15 ? 'High Risk (Sybil)' : 'Low Risk (Organik)';
      }

      setResult({
        aiScore,
        aiSource,
        aiRiskLevel,
        totalVolumeUsd,
        contractsCount: uniqueContracts.size,
        totalGasSpentUsd,
        dustTxCount,
        activeMonths,
        accountAgeDays,
        totalTxs
      });

    } catch (err) {
      console.error(err);
      alert("Multiple API Fetch Error! Network issue on Kletia Servers.");
    } finally {
      setIsScanning(false);
    }
  };

  // Kletia Super Score Formula (60% AI, 40% Real Onchain Data)
  let superScore = 0;
  if (result) {
    const aiWeight = result.aiScore * 0.6;
    
    let volScore = result.totalVolumeUsd > 5000 ? 100 : (result.totalVolumeUsd > 1000 ? 70 : 30);
    let contractScore = result.contractsCount > 100 ? 100 : (result.contractsCount > 30 ? 70 : 30);
    const dataWeight = ((volScore + contractScore) / 2) * 0.4;
    
    superScore = Math.round(aiWeight + dataWeight);
    if (hasBasename) superScore += 5; // Basename Bonus
    if (superScore > 100) superScore = 100;
  }

  return (
    <div className="w-full h-full p-4 md:p-8 overflow-y-auto custom-scrollbar flex flex-col items-center">
      <div className="w-full max-w-5xl space-y-6">
        
        {/* HEADER */}
        <div className="bg-white dark:bg-[#131E32] border-[4px] border-[#1A1A1A] dark:border-[#4B5563] p-6 md:p-8 shadow-[8px_8px_0_#1A1A1A] dark:shadow-[8px_8px_0_#475569] flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl md:text-4xl font-black text-[#1A1A1A] dark:text-white uppercase tracking-tighter flex items-center gap-3">
              <Database className="w-8 h-8 md:w-10 md:h-10 text-indigo-500" />
              Multi-API Aggregator
            </h1>
            <p className="text-gray-600 dark:text-slate-400 font-bold mt-2 text-sm md:text-base">
              Kletia Super Score: Merges TrustaLabs AI, Nomis, Coinbase SDK and Blockscout data.
            </p>
          </div>
        </div>

        {/* SEARCH BAR */}
        <div className="flex flex-col md:flex-row gap-4">
          <div className="flex-1 relative">
            <Fingerprint className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 w-6 h-6" />
            <input 
              type="text" 
              placeholder="Enter wallet address (0x...) to analyze"
              value={inputAddress}
              onChange={(e) => setInputAddress(e.target.value)}
              className="w-full bg-white dark:bg-[#1A2841] border-[4px] border-[#1A1A1A] dark:border-[#4B5563] p-4 pl-12 font-bold text-lg text-[#1A1A1A] dark:text-white placeholder-gray-400 outline-none shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] focus:translate-y-1 focus:shadow-none transition-all"
            />
          </div>
          <button 
            onClick={handleScan}
            disabled={isScanning || !inputAddress}
            className="shrink-0 bg-[#0052FF] hover:bg-blue-700 disabled:bg-gray-400 text-white font-black px-8 py-4 border-[4px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] active:translate-y-1 active:shadow-none transition-all flex items-center gap-2 justify-center uppercase"
          >
            {isScanning ? <RefreshCw className="animate-spin" /> : <Search />}
            {isScanning ? 'API\'lere Connecting...' : 'Calculate Super Score'}
          </button>
        </div>

        {/* RESULTS SECTION */}
        {result && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-in slide-in-from-bottom-4 duration-500">
            
            {/* SUPER SCORE CARD */}
            <div className="lg:col-span-1 bg-white dark:bg-[#131E32] border-[4px] border-[#1A1A1A] dark:border-[#4B5563] p-6 flex flex-col items-center justify-center shadow-[6px_6px_0_#1A1A1A] dark:shadow-[6px_6px_0_#475569] text-center">
              <h3 className="text-xl font-black uppercase tracking-wide text-gray-500 dark:text-slate-400 mb-4">Kletia Super Score</h3>
              
              <div className="relative w-40 h-40 flex items-center justify-center rounded-full border-[8px] border-[#EFEFEF] dark:border-slate-700">
                <div className={`absolute inset-0 rounded-full border-[8px] ${superScore > 80 ? 'border-green-500' : superScore > 50 ? 'border-orange-500' : 'border-red-500'}`} style={{ clipPath: `polygon(0 0, 100% 0, 100% 100%, 0 ${100 - superScore}%)` }}></div>
                <div className="text-6xl font-black text-[#1A1A1A] dark:text-white">{superScore}</div>
              </div>
              
              <p className="mt-6 font-bold text-sm text-gray-600 dark:text-slate-300">
                Calculated using 60% AI Reputation and 40% Onchain History.
              </p>
            </div>

            {/* API PROVIDERS METRICS */}
            <div className="lg:col-span-2 flex flex-col gap-4">
              
              {/* Trusta/Nomis AI Card */}
              <div className="bg-white dark:bg-[#131E32] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] p-5 shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <Cpu className="w-8 h-8 text-purple-500" />
                  <div>
                    <h4 className="font-black text-[#1A1A1A] dark:text-white text-lg uppercase tracking-tight">{result.aiSource}</h4>
                    <p className="text-xs font-bold text-gray-500">Sybil / Bot Tespiti Analizi</p>
                  </div>
                </div>
                <div className="text-right">
                  <div className={`text-xl font-black ${result.aiRiskLevel.includes('Low') ? 'text-green-500' : 'text-red-500'}`}>
                    {result.aiRiskLevel}
                  </div>
                  <div className="text-sm font-bold text-gray-600 dark:text-slate-400">Puan: {result.aiScore}/100</div>
                </div>
              </div>

              {/* Blockscout Data Card */}
              <div className="bg-white dark:bg-[#131E32] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] p-5 shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <Database className="w-8 h-8 text-blue-500" />
                  <div>
                    <h4 className="font-black text-[#1A1A1A] dark:text-white text-lg uppercase tracking-tight">Blockscout API</h4>
                    <p className="text-xs font-bold text-gray-500">In-Network Raw Data Analysis</p>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-lg font-black text-[#1A1A1A] dark:text-white">
                    {result.contractsCount} Kontrat
                  </div>
                  <div className="text-sm font-bold text-gray-600 dark:text-slate-400">Hacim: ${Math.round(result.totalVolumeUsd).toLocaleString()}</div>
                </div>
              </div>

              {/* Coinbase CDP Card */}
              <div className="bg-white dark:bg-[#131E32] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] p-5 shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <Wallet className="w-8 h-8 text-[#0052FF]" />
                  <div>
                    <h4 className="font-black text-[#1A1A1A] dark:text-white text-lg uppercase tracking-tight">Coinbase OnchainKit</h4>
                    <p className="text-xs font-bold text-gray-500">Official Web3 Identity Resolver</p>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-lg font-black text-[#1A1A1A] dark:text-white">
                    {hasBasename ? 'Base Name Owner' : 'Unknown Wallet'}
                  </div>
                  <div className="text-sm font-bold text-gray-600 dark:text-slate-400">Net Gas Spent: ${result.totalGasSpentUsd.toFixed(2)}</div>
                </div>
              </div>

              {/* Extra Kriterler Card */}
              <div className="bg-white dark:bg-[#131E32] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] p-5 shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <Activity className="w-8 h-8 text-emerald-500" />
                  <div>
                    <h4 className="font-black text-[#1A1A1A] dark:text-white text-lg uppercase tracking-tight">Onchain Footprint</h4>
                    <p className="text-xs font-bold text-gray-500">Ek Sybil & Airdrop Kriterleri</p>
                  </div>
                </div>
                <div className="flex gap-4 md:gap-8 text-right">
                  <div>
                    <div className="text-lg font-black text-[#1A1A1A] dark:text-white flex items-center justify-end gap-1">
                      <Calendar className="w-4 h-4 text-gray-400" /> {result.activeMonths} Ay
                    </div>
                    <div className="text-xs font-bold text-gray-500">Aktif Aylar</div>
                  </div>
                  <div>
                    <div className="text-lg font-black text-[#1A1A1A] dark:text-white flex items-center justify-end gap-1">
                      <Clock className="w-4 h-4 text-gray-400" /> {result.accountAgeDays} Days
                    </div>
                    <div className="text-xs font-bold text-gray-500">Wallet Age</div>
                  </div>
                  <div>
                    <div className="text-lg font-black text-[#1A1A1A] dark:text-white">
                      {result.totalTxs}
                    </div>
                    <div className="text-xs font-bold text-gray-500">Total Transactions</div>
                  </div>
                </div>
              </div>

            </div>

            {/* AI AGENT PREMIUM ANALYSIS TRIGGER */}
            <div className="lg:col-span-3 mt-4 flex flex-col items-center justify-center">
              <button 
                onClick={handleDeepAnalysis}
                disabled={agentStatus === 'running'}
                className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-500 text-white font-black px-8 py-4 border-[4px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[6px_6px_0_#1A1A1A] dark:shadow-[6px_6px_0_#475569] active:translate-y-1 active:shadow-none transition-all flex items-center gap-3 uppercase w-full md:w-auto"
              >
                {agentStatus === 'running' ? <RefreshCw className="animate-spin w-6 h-6" /> : <Cpu className="w-6 h-6" />}
                {agentStatus === 'running' ? 'Autonomous X402 Process Running...' : '🤖 Deep Analysis with AI Agent (X402 Premium)'}
              </button>
            </div>

            {/* AGENT TERMINAL OUTPUT */}
            {agentLogs.length > 0 && (
              <div className="lg:col-span-3 mt-4 bg-black border-[4px] border-[#1A1A1A] dark:border-[#4B5563] p-6 shadow-[8px_8px_0_#1A1A1A] dark:shadow-[8px_8px_0_#475569] font-mono text-sm">
                <div className="flex items-center gap-2 mb-4 text-green-500 border-b border-green-900 pb-2">
                  <div className="w-3 h-3 bg-green-500 rounded-full animate-pulse"></div>
                  <span className="font-bold">Kletia Omni-Engine Otonom Terminal (X402 Aktif)</span>
                </div>
                <div className="flex flex-col gap-2 max-h-[400px] overflow-y-auto custom-scrollbar">
                  {agentLogs.map((log, idx) => (
                    <div key={idx} className={`${log.startsWith('[HATA]') ? 'text-red-500' : log.startsWith('[KLETIA AI]') ? 'text-cyan-400 font-bold' : log.startsWith('[ARAÇ ÇAĞRISI]') ? 'text-yellow-500' : 'text-green-400'}`}>
                      <span className="opacity-50 mr-2">{new Date().toLocaleTimeString()}</span>
                      {log}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
