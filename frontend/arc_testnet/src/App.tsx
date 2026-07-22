import React, { useState, useRef, useEffect } from 'react';
import { useSendTransaction, usePublicClient, useAccount } from 'wagmi';
import { useCapabilities, useSendCalls } from 'wagmi/experimental';
import { WidgetId } from './types'; 
import { erc20Abi, encodeFunctionData } from 'viem'; 
import { Loader2, Zap, CheckCircle2, User, CreditCard, Bot } from 'lucide-react';
import sdk from '@farcaster/frame-sdk';
import { AgentVault } from './components/AgentVault';
import { BasenameClaimer } from './components/BasenameClaimer';
import { AirdropSimulator } from './components/widgets/AirdropSimulator';
import { X402ConsoleWidget } from './components/widgets/X402ConsoleWidget';
import { WebacyScanner } from './components/widgets/WebacyScanner';
import { ArcDashboardWidget } from './components/widgets/ArcDashboardWidget';
import { ArcLendingDashboard } from './components/ArcLendingDashboard';
import { AlloraDashboard } from './components/AlloraDashboard';
import { Navbar } from './components/layout/Navbar';
import { Sidebar } from './components/layout/Sidebar';
import { AppSidebar } from './components/layout/AppSidebar';
import { ChatInput } from './components/chat/ChatInput';
import { TerminalLogs } from './components/chat/TerminalLogs';


import { useAppStore } from './store/useAppStore';
import './App.css';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://127.0.0.1:3001';

const handleFundClick = async (targetAddress: string, e: React.MouseEvent) => {
  e.preventDefault();
  try {
    const res = await fetch(`${BACKEND_URL}/api/onramp-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: targetAddress })
    });
    const data = await res.json();
    if (data.status === 'success' && data.token) {
      const addresses = encodeURIComponent(JSON.stringify({ [targetAddress]: ['base'] }));
      const appId = "82ee9f72-74ba-4279-bf89-5f212261ce85";
      window.open(`https://pay.coinbase.com/buy/select-asset?appId=${appId}&sessionToken=${data.token}&addresses=${addresses}&defaultAsset=USDC`, '_blank');
    } else {
      alert("The funding service is currently unavailable. Please try again later.");
    }
  } catch (err) {
    console.error("Funding error:", err);
  }
};

export default function App() {
  const { address } = useAccount(); 
  const { sendTransactionAsync } = useSendTransaction();
  const publicClient = usePublicClient();
  const { sendCallsAsync } = useSendCalls();
  const { data: availableCapabilities } = useCapabilities({ account: address });
  const hasPaymaster = availableCapabilities?.[publicClient?.chain?.id as number]?.paymasterService?.supported || false;
  const waitForReceiptWithRetry = async (hash: string, retries = 6, delay = 3000): Promise<any> => {
    if (!publicClient) throw new Error("Network connection failed.");
    for (let i = 0; i < retries; i++) {
      try {
        return await publicClient.waitForTransactionReceipt({ hash: hash as `0x${string}` });
      } catch (e: any) {
        if (i === retries - 1) throw e;
        console.warn(`Receipt check failed (attempt ${i + 1}/${retries}), retrying in ${delay}ms...`, e);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  };

  const executeTx = async (txConfig: { to: string; data: string; value: bigint; gas?: bigint; forceNormalTx?: boolean }, _msgId: string): Promise<string> => {
    const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://127.0.0.1:3001';

    // ── ARC MODE FALLBACK (Normal Tx) ──
    // Gasless logic removed, standard transaction will be used via the Base/Paymaster block below.

    // ── NORMAL BASE NETWORK (PAYMASTER OR NATIVE GAS) ──
    if (hasPaymaster && sendCallsAsync) {
      const callId = await sendCallsAsync({
        calls: [{ to: txConfig.to as `0x${string}`, data: txConfig.data as `0x${string}`, value: txConfig.value }],
        capabilities: {
          paymasterService: { url: `${BACKEND_URL}/api/paymaster/sponsor` }
        }
      });
      return callId as unknown as string;
    } else {
      return (await sendTransactionAsync({
        to: txConfig.to as `0x${string}`,
        data: txConfig.data as `0x${string}`,
        value: txConfig.value,
        gas: txConfig.gas
      })) as string;
    }
  };

  

  const [isAgentMode, setIsAgentMode] = useState(false);
  const [agentWallet, setAgentWallet] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'chat' | 'basename' | 'allora' | 'airdrop' | 'x402' | 'webacy' | 'arc' | 'lending'>('chat');
  const [activeArcWidget, setActiveArcWidget] = useState<WidgetId>(null);
  const [isPortfolioOpen, setIsPortfolioOpen] = useState(false);
  const [isAppSidebarOpen, setIsAppSidebarOpen] = useState(false);
  const [isLoadingVault, setIsLoadingVault] = useState(false);

  useEffect(() => {
    if (isAgentMode && address) {
      setIsLoadingVault(true);
      const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://127.0.0.1:3001';
      fetch(`${BACKEND_URL}/api/agent/vault?userAddress=${address}`)
        .then(res => res.json())
        .then(data => {
          if (data.address) {
            setAgentWallet(data.address);
          } else {
            setAgentWallet(null);
          }
        })
        .catch(console.error)
        .finally(() => setIsLoadingVault(false));
    } else {
      setAgentWallet(null);
      setIsLoadingVault(false);
    }
  }, [isAgentMode, address]);

  const [input, setInput] = useState('');
  const { isDarkMode, messages, addMessage, updateMessage, addTerminalLog, initSocket } = useAppStore();
  
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    initSocket();
  }, [initSocket]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('kletia-theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('kletia-theme', 'light');
    }
  }, [isDarkMode]);

  useEffect(() => {
    document.documentElement.classList.add('arc-mode');
    setIsAgentMode(false);
  }, [activeTab]);

  useEffect(() => {
    const initializeFarcaster = async () => {
      try {
        await sdk.actions.ready();
      } catch (err) {
        console.error("Farcaster SDK Error:", err);
      }
    };
    initializeFarcaster();
  }, []);

  // -------------------------------------------------------------------------
  // ✨ LOGIC BLOCKS (ENGINE WORKS THE SAME)
  // -------------------------------------------------------------------------
  const handleWidgetClick = (prompt: string) => {
    setInput(prompt);
    setActiveTab('chat');
    setIsPortfolioOpen(false);
    setTimeout(() => {
      const inputEl = document.querySelector('input[type="text"]') as HTMLInputElement;
      if (inputEl) inputEl.focus();
    }, 10);
  };

  const handleSend = async () => {
    if (!input.trim()) return;
    if (!address) {
      addMessage({ id: Date.now().toString(), role: 'kletia', text: '🚨 Please connect your wallet from the top right first, buddy.' });
      return;
    }

    const userText = input.trim();
    setInput('');
    const userMsgId = Date.now().toString();
    const kletiaMsgId = (Date.now() + 1).toString();

    addMessage({ id: userMsgId, role: 'user', text: userText });
    addMessage({ id: kletiaMsgId, role: 'kletia', text: 'Scanning network...', isLoading: true });

    try {
      const endpoint = '/api/intent';

      const response = await fetch(`${BACKEND_URL}${endpoint}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: userText, userAddress: address, msgId: kletiaMsgId, isArcMode: true })
      });



      // Normal Intent Engine Handling
      const data = await response.json();

      if (data.status === 'question') {
        updateMessage(kletiaMsgId, { isLoading: false, text: data.message });
        return;
      }

      if (data.status !== 'success') {
        updateMessage(kletiaMsgId, { isLoading: false, text: `❌ Transaction Cancelled: ${data.message}` });
        return;
      }

      if (data.action === 'open_widget') {
         updateMessage(kletiaMsgId, {
            isLoading: false, text: data.winnerMessage || "Opening the requested module...", terminalLogs: []
         });
         if (data.widgetTarget) {
            setActiveTab(data.widgetTarget);
            if (data.widgetTarget === 'arc' && data.subTarget) {
               setActiveArcWidget(data.subTarget);
            }
            if (data.widgetTarget !== 'chat') {
               setIsPortfolioOpen(false);
            }
         }
         return;
      }

      if (data.action === 'portfolio') {
        updateMessage(kletiaMsgId, {
          isLoading: false, text: data.message || "Portfolio scanned successfully. Details updated in the right panel.", intentData: data, terminalLogs: []
        });
        setIsPortfolioOpen(true);
        return;
      }

      if (data.action === 'agent_action' || data.action === 'bns_resolve') {
        updateMessage(kletiaMsgId, {
          isLoading: false, text: data.message || data.winnerMessage || "You need to enable Agent Mode to perform this action.", terminalLogs: []
        });
        return;
      }

      updateMessage(kletiaMsgId, { 
        isLoading: false, 
        text: `🏆 Routes found! Kletia engine mapped the most profitable strategy: **${data.winner}**`,
        intentData: data, selectedRouteIndex: 0, terminalLogs: []
      });

    } catch (error: unknown) {
      const err = error as { message: string };
      updateMessage(kletiaMsgId, { isLoading: false, text: `❌ System Error: ${err.message}` });
    }
  };

  const executeRoute = async (msgId: string) => {
    const msg = messages.find(m => m.id === msgId);
    if (!msg || !msg.intentData || !msg.intentData.allRoutes || !address || !sendTransactionAsync) return;

    const data = msg.intentData;
    const activeRoute = data.allRoutes![msg.selectedRouteIndex || 0];
    
    const targetAddress = data.targetContract || activeRoute.router;
    const txCalldata = data.calldata || activeRoute.calldata;
    const txValue = data.value || "0";

    updateMessage(msgId, { isLoading: true });
    addTerminalLog(msgId, `🛡️ ARC Engine engaged. Preparing transaction...`);
    
    addTerminalLog(msgId, `🚀 Initializing security protocols...`);
    addTerminalLog(msgId, `🔗 Target: ${targetAddress.substring(0, 8)}...`);

    // --- WEBACY TRANSACTION INTERCEPTION ---
    addTerminalLog(msgId, `🛡️ Running Webacy DD.xyz Risk Scan...`);
    try {
        const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://127.0.0.1:3001';
        const res = await fetch(`${BACKEND_URL}/api/webacy/scan/${targetAddress}`);
        const data = await res.json();
        
        if (data.status === 'success' && data.riskScore > 50) {
            addTerminalLog(msgId, `🚨 WEBACY FIREWALL: Target is High Risk! Score: ${data.riskScore}/100.`);
            if (data.tags && data.tags.length > 0) {
               addTerminalLog(msgId, `❌ Risk Tags: ${data.tags.join(', ')}`);
            }
            addTerminalLog(msgId, `⛔ [Transaction automatically halted by Webacy]`);
            updateMessage(msgId, { isLoading: false });
            return;
        } else if (data.status === 'success') {
            addTerminalLog(msgId, `✅ Webacy Approval Received (Score: ${data.riskScore}). Safe.`);
        } else {
            addTerminalLog(msgId, `⚠️ Webacy scan failed but continuing.`);
        }
    } catch (e) {
        addTerminalLog(msgId, `⚠️ Webacy API connection error.`);
    }
    // ----------------------------------------

    try {
      const tokensToApprove: { address: string; amount: string }[] = [];

      if (activeRoute.primaryTokenAddress && activeRoute.primaryAmountInWei) {
          tokensToApprove.push({ address: activeRoute.primaryTokenAddress, amount: activeRoute.primaryAmountInWei });
      }
      if (activeRoute.secondaryTokenAddress && activeRoute.secondaryAmountInWei) {
          tokensToApprove.push({ address: activeRoute.secondaryTokenAddress, amount: activeRoute.secondaryAmountInWei });
      }
      if (tokensToApprove.length === 0 && data.tokenInAddress && data.amountInWei && !data.isNativeIn) {
          tokensToApprove.push({ address: data.tokenInAddress, amount: data.amountInWei });
      }

      if (publicClient && tokensToApprove.length > 0) {
          for (const token of tokensToApprove) {
              addTerminalLog(msgId, `🔍 Checking permission: ${token.address.substring(0, 6)}...`);
              const currentAllowance = await publicClient.readContract({
                  address: token.address as `0x${string}`, abi: erc20Abi,
                  functionName: 'allowance', args: [address, targetAddress as `0x${string}`]
              });

              if (currentAllowance < BigInt(token.amount)) {
                  addTerminalLog(msgId, `⚠️ Missing permission. Please approve via MetaMask.`);
                  
                  const approveData = encodeFunctionData({
                      abi: erc20Abi, functionName: 'approve', args: [targetAddress as `0x${string}`, BigInt(token.amount)]
                  });

                  const approveHash = await executeTx({
                      to: token.address as `0x${string}`, data: approveData, value: 0n, forceNormalTx: true
                  }, msgId);

                  addTerminalLog(msgId, `⏳ Permission sent to network. Waiting for confirmation...`);
                  if (!hasPaymaster) {
                    await waitForReceiptWithRetry(approveHash);
                  } else {
                    await new Promise(resolve => setTimeout(resolve, 4000));
                  }
                  
                  addTerminalLog(msgId, `✅ Permission approved. Syncing (3 sec)...`);
                  await new Promise(resolve => setTimeout(resolve, 3000));
              } else {
                  addTerminalLog(msgId, `✅ Sufficient spending allowance exists.`);
              }
          }
      } else if (data.isNativeIn) {
          addTerminalLog(msgId, `⚡ Native ETH detected. Approve skipped.`);
      }

      addTerminalLog(msgId, `🔬 STARTING TRANSACTION SIMULATION (Dry Run)...`);
      let estimatedGas: bigint | undefined;
      if (publicClient) {
          try {
              estimatedGas = await publicClient.estimateGas({
                  account: address, to: targetAddress as `0x${string}`,
                  data: txCalldata as `0x${string}`, value: BigInt(txValue)
              });
              
              // Add a 20% buffer to estimated gas to prevent out-of-gas issues
              estimatedGas = (estimatedGas * 120n) / 100n;
              addTerminalLog(msgId, `✅ Simulation Successful! Contract approved transaction.`);
          } catch (error: unknown) {
              const err = error as { message: string; shortMessage?: string };
              addTerminalLog(msgId, `⚠️ SIMULATION FAILED: ${err.shortMessage || err.message}\n[Continuing with Default Gas Limit]`);
              estimatedGas = 2000000n; // Fallback to safe gas limit
          }
      }

      if (!hasPaymaster) {
          addTerminalLog(msgId, `⏳ Please confirm the main transaction in MetaMask.`);
      }
      
      const hash = await executeTx({
        to: targetAddress as `0x${string}`, data: txCalldata as `0x${string}`, value: BigInt(txValue), gas: estimatedGas
      }, msgId);

      updateMessage(msgId, { txHash: hash });
      addTerminalLog(msgId, `🚀 Transaction on Network! Hash: ${hash}\n⏳ Waiting for confirmation...`);

      if (publicClient) {
        if (!hasPaymaster) {
          const receipt = await waitForReceiptWithRetry(hash);
          addTerminalLog(msgId, receipt.status === 'success' ? `✅ SUCCESS! Kletia completed its task.` : `❌ TRANSACTION FAILED ON NETWORK.`);
        } else {
          addTerminalLog(msgId, `✅ SUCCESS (Sponsored Gasless)! Kletia completed its task.`);
        }
      }

    } catch (error: unknown) {
      const err = error as { message: string; shortMessage?: string };
      addTerminalLog(msgId, `❌ Cancelled / Error: ${err.shortMessage || err.message}`);
    } finally {
      updateMessage(msgId, { isLoading: false });
    }
  };

  // -------------------------------------------------------------------------
  // ✨ UI - FLAWLESS MOBILE SUPPORT & NEOBRUTALISM MATRIX
  // -------------------------------------------------------------------------
  return (
    <div className="absolute inset-0 flex flex-col bg-[#EFEFEF] dark:bg-[#0B1120] text-[#1A1A1A] dark:text-gray-100 font-sans antialiased overflow-hidden transition-colors duration-300">
      
      {/* ✨ GEOMETRIC CHAOS (NeoBrutalism Grid and Shapes) */}
      <div className="fixed inset-0 z-0 pointer-events-none select-none">
        {/* Engineering Paper Dots */}
        <div className="absolute inset-0 bg-[radial-gradient(#1A1A1A33_2px,transparent_2px)] dark:bg-[radial-gradient(#ffffff15_2px,transparent_2px)] [background-size:30px_30px] opacity-70"></div>

        {/* Mobile Friendly Large Typography */}
        <div className="hidden md:block absolute -left-10 top-[15%] text-[180px] font-black text-black/[0.03] dark:text-white/[0.02] -rotate-12 tracking-tighter">KLETIA</div>
        <div className="hidden md:block absolute right-[-20px] bottom-[20%] text-[160px] font-black text-black/[0.03] dark:text-white/[0.02] rotate-12 tracking-widest">KLET</div>

        {/* Brutalist Şekiller (Mobilde hafif gizlenir) */}
        <div className="hidden md:block absolute top-[15%] right-[10%] w-24 h-24 bg-[#0052FF] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] rotate-12 opacity-80 dark:opacity-50"></div>
        <div className="hidden md:block absolute bottom-[25%] left-[5%] md:left-[10%] w-24 md:w-40 h-12 md:h-16 bg-[#FFD700] dark:bg-[#CCA000] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] rounded-full shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] -rotate-6 opacity-80 dark:opacity-60"></div>
      </div>

      {/* ✨ HEADER: Dolu, Mobil Uyumlu ve Brutalist */}
      <Navbar 
        isAgentMode={isAgentMode}
        setIsAgentMode={setIsAgentMode}
        address={address}
        agentWallet={agentWallet}
        handleFundClick={handleFundClick}
        onMenuClick={() => setIsAppSidebarOpen(!isAppSidebarOpen)}
      />

      {/* ✨ ORTA ALAN: SOHBET VE PROMPT VEYA BASENAME */}
      <div className="flex flex-1 overflow-hidden z-10 relative min-h-0 min-w-0">
        
        {/* Left Menu (App Hub) */}
        <AppSidebar 
          activeTab={activeTab} 
          setActiveTab={setActiveTab} 
          isPortfolioOpen={isPortfolioOpen} 
          setIsPortfolioOpen={setIsPortfolioOpen}
          isOpen={isAppSidebarOpen}
          setIsOpen={setIsAppSidebarOpen}
          onWidgetClick={handleWidgetClick}
        />
        
        <div className="grid grid-rows-[1fr_auto] flex-1 overflow-hidden relative w-full h-full min-h-0 min-w-0">
        {activeTab === 'allora' ? (
           <AlloraDashboard isDarkMode={isDarkMode} onActionClick={(prompt) => { setInput(prompt); setActiveTab('chat'); }} />
        ) : activeTab === 'basename' ? (
           <BasenameClaimer />
        ) : activeTab === 'airdrop' ? (
           <AirdropSimulator />
        ) : activeTab === 'x402' ? (
           <X402ConsoleWidget />
        ) : activeTab === 'webacy' ? (
           <WebacyScanner />
        ) : activeTab === 'arc' ? (
           <div className="flex-1 overflow-y-auto p-4 md:p-6 custom-scrollbar block">
             <ArcDashboardWidget onWidgetClick={handleWidgetClick} activeWidget={activeArcWidget} setActiveWidget={setActiveArcWidget} />
           </div>
        ) : activeTab === 'lending' ? (
           <div className="flex-1 overflow-y-auto p-4 md:p-6 custom-scrollbar block">
             <ArcLendingDashboard isDarkMode={isDarkMode} onActionClick={(prompt) => { setInput(prompt); setActiveTab('chat'); }} />
           </div>
        ) : (
          <>
            {/* ✨ CHAT ALANI */}
            <div className="overflow-y-auto p-3 md:p-6 bg-transparent scroll-smooth min-h-0 custom-scrollbar" id="chat-container" style={{ maskImage: 'linear-gradient(to bottom, black 85%, transparent 100%)', WebkitMaskImage: 'linear-gradient(to bottom, black 85%, transparent 100%)' }}>
          <div className="max-w-4xl mx-auto relative w-full pr-1 md:pr-0">
            
            {/* OTONOM KASA KARTI */}
            {isAgentMode && isLoadingVault && (
              <div className="flex items-center gap-2 p-4 text-white">
                <Loader2 className="w-5 h-5 animate-spin text-[#0052FF]" /> Kasa kontrol ediliyor...
              </div>
            )}
            
            {/* AGENT WALLET EKRANI */}
            {isAgentMode && !isLoadingVault && agentWallet && (
              <AgentVault 
                agentWallet={agentWallet} 
                onQuickAction={(text: string) => {
                  setInput(text);
                  const inputEl = document.querySelector('input[type="text"]') as HTMLInputElement;
                  if (inputEl) setTimeout(() => inputEl.focus(), 10);
                }} 
              />
            )}

            
            <div className="space-y-6 md:space-y-8">
            {messages.map((msg) => (
              <div key={msg.id} className={`flex gap-3 md:gap-5 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                
                {/* KLETIA AVATAR (Closed Gri, Mobil Uyumlu Boyut) */}
                {msg.role === 'kletia' && (
                  <div className="w-10 h-10 md:w-12 md:h-12 bg-white dark:bg-slate-800 border-[3px] border-[#4B5563] dark:border-[#4B5563] shadow-[3px_3px_0_#475569] dark:shadow-[3px_3px_0_#475569] flex items-center justify-center shrink-0">
                    {msg.isLoading && !msg.terminalLogs?.length ? <Loader2 className="w-5 h-5 md:w-6 md:h-6 text-[#0052FF] animate-spin" strokeWidth={4} /> : <Bot className="w-5 h-5 md:w-6 md:h-6 text-gray-600 dark:text-slate-300" strokeWidth={4} />}
                  </div>
                )}

                {/* ✨ MESSAGE BUBBLE: Added break-words to prevent overflow */}
                <div className={`max-w-[85%] sm:w-auto px-4 py-3 md:px-6 md:py-5 border-[3px] border-[#1A1A1A] dark:border-[#4B5563] text-sm md:text-lg font-bold break-words
                  ${msg.role === 'user' 
                    ? 'bg-[#0052FF] text-white ml-auto shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#475569] md:shadow-[4px_4px_0_#1A1A1A] dark:md:shadow-[4px_4px_0_#475569]' 
                    : 'bg-white dark:bg-[#131E32] text-[#1A1A1A] dark:text-gray-100 shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#475569] md:shadow-[4px_4px_0_#1A1A1A] dark:md:shadow-[4px_4px_0_#475569]'}`}>
                  
                  {msg.role === 'kletia' ? (
                    <div>
                      <div dangerouslySetInnerHTML={{ __html: msg.text.replace('[SHOW_ONRAMP]', '').replace(/\*\*(.*?)\*\*/g, '<strong class="text-[#1A1A1A] dark:text-white font-black border-b-[3px] border-[#0052FF] pb-0.5">$1</strong>') }} />
                      {msg.text.includes('[SHOW_ONRAMP]') && (isAgentMode ? agentWallet : address) && (
                        <div className="mt-5 md:mt-6 p-4 md:p-5 bg-white dark:bg-[#0F172A] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#475569] md:shadow-[4px_4px_0_#1A1A1A] dark:md:shadow-[4px_4px_0_#475569] flex flex-col gap-4 w-full sm:w-80 md:w-[450px]">
                          <div className="text-xs md:text-sm text-[#1A1A1A] dark:text-white font-black uppercase tracking-widest border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563] pb-2 flex items-center justify-between">
                             <div className="flex items-center gap-2">
                               <CreditCard className="w-4 h-4 md:w-5 md:h-5 text-[#0052FF]" strokeWidth={3} /> {isAgentMode ? 'FUND VAULT' : 'FUND WALLET'}
                             </div>
                             <div className="text-[10px] bg-gray-100 dark:bg-slate-800 px-2 py-1 border-[2px] border-[#1A1A1A] dark:border-slate-500 truncate max-w-[120px] md:max-w-[150px] font-mono" title={isAgentMode ? agentWallet! : address!}>
                                {isAgentMode ? agentWallet : address}
                             </div>
                          </div>
                          <p className="text-sm md:text-base font-bold text-[#1A1A1A] dark:text-gray-300">You need USDC in your {isAgentMode ? 'vault' : 'wallet'} to continue. You can fund instantly with zero fees via Credit Card/Apple Pay.</p>
                          <button
                            onClick={(e) => handleFundClick(isAgentMode ? agentWallet! : address!, e)}
                            className="group relative w-full flex items-center justify-center gap-2 md:gap-3 bg-[#0052FF] hover:bg-blue-700 text-white font-black py-3 md:py-4 border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#475569] active:translate-y-1 active:shadow-none transition-all uppercase tracking-wide text-sm md:text-base cursor-pointer"
                          >
                            <CreditCard className="w-5 h-5 md:w-6 md:h-6" strokeWidth={4} /> {isAgentMode ? 'FUND YOUR VAULT NOW' : 'FUND YOUR WALLET NOW'}
                          </button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div>{msg.text}</div>
                  )}



                  {/* ROUTE SELECTOR AND CONFIRM BUTTON */}
                  {msg.intentData && msg.intentData.allRoutes && msg.intentData.action !== 'portfolio' && (
                    <div className="mt-5 md:mt-6 p-4 md:p-5 bg-white dark:bg-[#0F172A] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#475569] md:shadow-[4px_4px_0_#1A1A1A] dark:md:shadow-[4px_4px_0_#475569] flex flex-col gap-4 w-full sm:w-80 md:w-[450px]">
                      <div className="text-xs md:text-sm text-[#1A1A1A] dark:text-white font-black uppercase tracking-widest border-b-[3px] border-[#1A1A1A] dark:border-[#4B5563] pb-2 flex items-center gap-2">
                         <Zap className="w-4 h-4 md:w-5 md:h-5" strokeWidth={3}/> Autonomous Route Finder
                      </div>
                      
                      <select 
                        className="w-full bg-[#EFEFEF] dark:bg-slate-800 border-[3px] border-[#1A1A1A] dark:border-[#4B5563] text-[#1A1A1A] dark:text-white font-black text-sm md:text-base p-2.5 md:p-3 outline-none focus:bg-[#0052FF] dark:focus:bg-[#0052FF] focus:text-white transition-colors cursor-pointer"
                        value={msg.selectedRouteIndex}
                        onChange={(e) => updateMessage(msg.id, { selectedRouteIndex: Number(e.target.value) })}
                        disabled={msg.isLoading || !!msg.txHash}
                      >
                        {msg.intentData.allRoutes.map((route, idx) => {
                          const isSingleAction = msg.intentData?.actionType?.startsWith('basename_');
                          let prefix = idx === 0 ? '🏆 Most Profitable:' : '🔄 Alternative:';
                          if (isSingleAction) prefix = '🎯 Transaction Detail:';
                          
                          return (
                            <option key={idx} value={idx}>
                              {prefix} {route.name} ({route.expectedOutput || "No Estimate"})
                            </option>
                          );
                        })}
                      </select>

                      <button 
                        onClick={() => executeRoute(msg.id)}
                        disabled={msg.isLoading || !!msg.txHash}
                        className={`group relative w-full flex items-center justify-center gap-2 md:gap-3 text-white font-black py-3 md:py-4 border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#475569] active:translate-y-1 active:shadow-none transition-all uppercase tracking-wide text-sm md:text-base ${
                          !!msg.txHash 
                            ? 'bg-[#10B981]' 
                            : msg.isLoading 
                              ? 'bg-gray-400 dark:bg-slate-600' 
                              : 'bg-[#0052FF] hover:bg-blue-700'
                        }`}
                      >
                        {msg.isLoading ? <Loader2 className="w-5 h-5 md:w-6 md:h-6 animate-spin" strokeWidth={4} /> : (msg.txHash ? <CheckCircle2 className="w-5 h-5 md:w-6 md:h-6" strokeWidth={4} /> : <Zap className="w-5 h-5 md:w-6 md:h-6" strokeWidth={4} />)}
                        {msg.isLoading ? 'System Processing' : (msg.txHash ? 'Transaction Successful' : 'Execute Route')}
                      </button>
                    </div>
                  )}

                  {/* TERMINAL / X-RAY LOGLARI */}
                  <TerminalLogs msg={msg} />

                </div>

                {/* KULLANICI AVATAR */}
                {msg.role === 'user' && (
                  <div className="w-10 h-10 md:w-12 md:h-12 bg-[#0052FF] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[3px_3px_0_#1A1A1A] dark:shadow-[3px_3px_0_#475569] flex items-center justify-center shrink-0">
                    <User className="w-5 h-5 md:w-6 md:h-6 text-white" strokeWidth={4} />
                  </div>
                )}
              </div>
            ))}
            <div ref={messagesEndRef} />
            </div>
          </div>
          </div>


        {/* ✨ PROMPT KISMI */}
        <ChatInput input={input} setInput={setInput} handleSend={handleSend} />
        </>
        )}
        </div>

        {/* Portfolio Sidebar */}
        <Sidebar isPortfolioOpen={isPortfolioOpen} setIsPortfolioOpen={setIsPortfolioOpen} />

      </div>
    </div>
  );
}
