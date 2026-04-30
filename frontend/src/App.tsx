// frontend/src/App.tsx
import { useState, useRef, useEffect } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useSendTransaction, usePublicClient, useAccount } from 'wagmi';
import { erc20Abi, encodeFunctionData } from 'viem'; // ✨ DÜZELTME: Raw veri için encodeFunctionData eklendi
import { Send, Bot, User, Loader2, Zap, CheckCircle2, ChevronRight } from 'lucide-react';

type RouteData = { 
  name: string; expectedOutput: string; router: string; calldata: string; 
  primaryTokenAddress?: string; primaryAmountInWei?: string; 
  secondaryTokenAddress?: string; secondaryAmountInWei?: string; 
};

type WalletAsset = { symbol: string; formatted: string; balance?: string };
type PortfolioData = {
  wallet?: WalletAsset[];
  defiPositions?: {
    aave?: { suppliedCollateralUSD: string; totalDebtUSD: string; healthFactor: string };
    aerodrome?: { lockedAmount: string; votingPower: string; unlockDate: string };
  };
};

type IntentResponse = { 
  status: string; 
  message?: string; 
  action?: string; 
  data?: PortfolioData; 
  winner?: string; 
  expectedOutput?: string; 
  targetContract?: string; 
  calldata?: string;       
  tokenInAddress?: string; 
  amountInWei?: string;    
  isNativeIn?: boolean; 
  value?: string; 
  allRoutes?: RouteData[]; 
};

type ChatMessage = {
  id: string;
  role: 'user' | 'kletia';
  text: string;
  isLoading?: boolean;
  intentData?: IntentResponse; 
  terminalLogs?: string[]; 
  txHash?: string;
  selectedRouteIndex?: number;
};

// ✨ KLETIA AGGREGATOR ADRESİMİZ
const KLETIA_ROUTER_ADDRESS = "0xF97f807C95B02d4c4b221C67B587fD1a99b2A77F".toLowerCase();

export default function App() {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: 'welcome', role: 'kletia', text: 'Selam Patron. Ben Kletia Omni-Engine. Bugün blokzincirde nasıl bir strateji izliyoruz?' }
  ]);

  const { address } = useAccount(); 
  const { sendTransactionAsync } = useSendTransaction();
  const publicClient = usePublicClient();
  
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const updateMessage = (id: string, updates: Partial<ChatMessage>) => {
    setMessages(prev => prev.map(msg => msg.id === id ? { ...msg, ...updates } : msg));
  };

  const addTerminalLog = (id: string, log: string) => {
    setMessages(prev => prev.map(msg => {
      if (msg.id === id) {
        const currentLogs = msg.terminalLogs || [];
        return { ...msg, terminalLogs: [...currentLogs, log] };
      }
      return msg;
    }));
  };

  const handleSend = async () => {
    if (!input.trim()) return;
    if (!address) {
      setMessages(prev => [...prev, { id: Date.now().toString(), role: 'kletia', text: '🚨 Lütfen önce sağ üstten cüzdanını bağla Patron.' }]);
      return;
    }

    const userText = input.trim();
    setInput('');
    const userMsgId = Date.now().toString();
    const kletiaMsgId = (Date.now() + 1).toString();

    setMessages(prev => [...prev, { id: userMsgId, role: 'user', text: userText }]);
    setMessages(prev => [...prev, { id: kletiaMsgId, role: 'kletia', text: 'Ağ taranıyor...', isLoading: true }]);

    try {
      const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://127.0.0.1:3000';

      const response = await fetch(`${BACKEND_URL}/api/intent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: userText, userAddress: address })
      });

      const data = await response.json();

      if (data.status === 'question') {
        updateMessage(kletiaMsgId, { isLoading: false, text: data.message });
        return;
      }

      if (data.status !== 'success') {
        updateMessage(kletiaMsgId, { isLoading: false, text: `❌ İşlem İptal: ${data.message}` });
        return;
      }

      if (data.action === 'portfolio') {
        updateMessage(kletiaMsgId, {
          isLoading: false,
          text: data.message || "Portföyünüz başarıyla tarandı.",
          intentData: data,
          terminalLogs: []
        });
        return;
      }

      updateMessage(kletiaMsgId, { 
        isLoading: false, 
        text: `🏆 Rotalar bulundu! Kletia motoru en kârlı stratejiyi çizdi: **${data.winner}**`,
        intentData: data,
        selectedRouteIndex: 0, 
        terminalLogs: []
      });

    } catch (error: unknown) {
      const err = error as { message: string };
      updateMessage(kletiaMsgId, { isLoading: false, text: `❌ Sistem Hatası: ${err.message}` });
    }
  };

  const executeRoute = async (msgId: string) => {
    const msg = messages.find(m => m.id === msgId);
    if (!msg || !msg.intentData || !msg.intentData.allRoutes || !address) return;

    const data = msg.intentData;
    const activeRoute = data.allRoutes![msg.selectedRouteIndex || 0];
    
    // YENİ AKILLI YÖNLENDİRME
    const isWrapped = data.targetContract?.toLowerCase() === KLETIA_ROUTER_ADDRESS;
    const targetAddress = isWrapped ? data.targetContract! : activeRoute.router;
    const txCalldata = isWrapped ? data.calldata! : activeRoute.calldata;
    const txValue = data.value || "0";

    updateMessage(msgId, { isLoading: true });
    
    if (isWrapped) {
        addTerminalLog(msgId, `🛡️ Kletia Smart Router devrede (%0.1 Protokol Komisyonlu).`);
    } else {
        addTerminalLog(msgId, `⚡ Fee-Exempt (Ücretsiz) işlem. Doğrudan protokole bağlanılıyor.`);
    }
    
    addTerminalLog(msgId, `🚀 Güvenlik protokolleri başlatılıyor...`);
    addTerminalLog(msgId, `🔗 Hedef: ${targetAddress.substring(0, 8)}...`);

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
              addTerminalLog(msgId, `🔍 İzin kontrol ediliyor: ${token.address.substring(0, 6)}...`);
              const currentAllowance = await publicClient.readContract({
                  address: token.address as `0x${string}`, abi: erc20Abi,
                  functionName: 'allowance', args: [address, targetAddress as `0x${string}`]
              });

              if (currentAllowance < BigInt(token.amount)) {
                  addTerminalLog(msgId, `⚠️ İzin eksik. Lütfen MetaMask üzerinden onay verin.`);
                  
                  // ✨ BAŞ MİMAR ÇÖZÜMÜ: Wagmi'nin Decode hatasını aşmak için "Raw Transaction" ile Approve atıyoruz!
                  const approveData = encodeFunctionData({
                      abi: erc20Abi,
                      functionName: 'approve',
                      args: [targetAddress as `0x${string}`, BigInt(token.amount)]
                  });

                  const approveHash = await sendTransactionAsync({
                      to: token.address as `0x${string}`,
                      data: approveData,
                      value: 0n
                  });

                  addTerminalLog(msgId, `⏳ İzin ağa gönderildi. Onay bekleniyor...`);
                  await publicClient.waitForTransactionReceipt({ hash: approveHash });
                  
                  addTerminalLog(msgId, `✅ İzin onaylandı. Senkronizasyon (3 sn)...`);
                  await new Promise(resolve => setTimeout(resolve, 3000));
              } else {
                  addTerminalLog(msgId, `✅ Yeterli harcama izni mevcut.`);
              }
          }
      } else if (data.isNativeIn) {
          addTerminalLog(msgId, `⚡ Native ETH tespit edildi. İzin (Approve) atlandı.`);
      }

      const WETH_CONTRACT = "0x4200000000000000000000000000000000000006".toLowerCase();
      if (targetAddress.toLowerCase() === WETH_CONTRACT) {
          addTerminalLog(msgId, `⚡ WETH Bypass aktif. Simülasyon atlanıyor...`);
          addTerminalLog(msgId, `⏳ Lütfen işlemi MetaMask'tan onaylayın.`);
          
          const msgValue = data.isNativeIn ? BigInt(data.amountInWei || "0") : 0n;

          const hash = await sendTransactionAsync({
              to: targetAddress as `0x${string}`,
              data: txCalldata as `0x${string}`, 
              value: msgValue
          });
          
          updateMessage(msgId, { txHash: hash });
          addTerminalLog(msgId, `🚀 İşlem Ağda! Hash: ${hash}\n⏳ Onay bekleniyor...`);
          
          if (publicClient) {
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            addTerminalLog(msgId, receipt.status === 'success' ? `✅ BAŞARILI! WETH dönüşümü tamamlandı.` : `❌ İŞLEM BAŞARISIZ OLDU.`);
          }
          updateMessage(msgId, { isLoading: false });
          return;
      }

      addTerminalLog(msgId, `🔬 İŞLEM SİMÜLASYONU (Dry Run) BAŞLATILIYOR...`);
      if (publicClient) {
          try {
              await publicClient.estimateGas({
                  account: address, to: targetAddress as `0x${string}`,
                  data: txCalldata as `0x${string}`, value: BigInt(txValue)
              });
              addTerminalLog(msgId, `✅ Simülasyon Başarılı! Kontrat işlemi onayladı.`);
          } catch (error: unknown) {
              const err = error as { message: string; shortMessage?: string };
              addTerminalLog(msgId, `❌ SİMÜLASYON ÇÖKTÜ: ${err.shortMessage || err.message}\n[İşlem durduruldu]`);
              updateMessage(msgId, { isLoading: false });
              return; 
          }
      }

      addTerminalLog(msgId, `⏳ Lütfen asıl işlemi MetaMask'tan onaylayın.`);
      const hash = await sendTransactionAsync({
        to: targetAddress as `0x${string}`, data: txCalldata as `0x${string}`, value: BigInt(txValue)
      });

      updateMessage(msgId, { txHash: hash });
      addTerminalLog(msgId, `🚀 İşlem Ağda! Hash: ${hash}\n⏳ Onay bekleniyor...`);

      if (publicClient) {
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        addTerminalLog(msgId, receipt.status === 'success' ? `✅ BAŞARILI! Kletia görevini tamamladı.` : `❌ İŞLEM AĞDA BAŞARISIZ OLDU.`);
      }

    } catch (error: unknown) {
      const err = error as { message: string; shortMessage?: string };
      addTerminalLog(msgId, `❌ İptal / Hata: ${err.shortMessage || err.message}`);
    } finally {
      updateMessage(msgId, { isLoading: false });
    }
  };

  return (
    <div className="flex flex-col h-screen bg-kletiaDark text-gray-200">
      <header className="flex justify-between items-center px-6 py-4 border-b border-[#222]">
        <div className="flex items-center gap-2">
          <Zap className="text-kletiaBlue w-6 h-6" />
          <h1 className="text-xl font-bold text-white tracking-wide">KLETIA OMNI</h1>
        </div>
        <ConnectButton showBalance={false} />
      </header>

      <div className="flex-1 overflow-y-auto p-4 md:p-10 space-y-6 scrollbar-hide">
        <div className="max-w-4xl mx-auto space-y-8">
          {messages.map((msg) => (
            <div key={msg.id} className={`flex gap-4 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              
              {msg.role === 'kletia' && (
                <div className="w-10 h-10 rounded-full bg-[#1A1A1A] border border-[#333] flex items-center justify-center shrink-0">
                  {msg.isLoading && !msg.terminalLogs?.length ? <Loader2 className="w-5 h-5 text-kletiaBlue animate-spin" /> : <Bot className="w-5 h-5 text-gray-400" />}
                </div>
              )}

              <div className={`max-w-[85%] w-full sm:w-auto rounded-2xl px-5 py-4 ${msg.role === 'user' ? 'bg-[#212121] text-white rounded-br-none' : 'bg-transparent text-gray-300'}`}>
                
                {msg.role === 'kletia' ? (
                  <div dangerouslySetInnerHTML={{ __html: msg.text.replace(/\*\*(.*?)\*\*/g, '<strong class="text-white">$1</strong>') }} />
                ) : (
                  <div>{msg.text}</div>
                )}

                {msg.intentData?.action === 'portfolio' && msg.intentData.data && (
                  <div className="mt-4 space-y-4 text-sm w-full sm:w-96">
                    {msg.intentData.data.wallet && msg.intentData.data.wallet.length > 0 && (
                      <div className="p-4 bg-[#111] rounded-xl border border-[#333]">
                        <h4 className="text-gray-400 font-bold mb-3 border-b border-[#222] pb-2">CÜZDAN (WALLET)</h4>
                        {msg.intentData.data.wallet.map((w: WalletAsset, idx: number) => (
                          <div key={idx} className="flex justify-between items-center py-1">
                            <span className="text-gray-300 font-mono">{w.symbol}</span>
                            <span className="text-white font-bold">{w.formatted}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    
                    {msg.intentData.data.defiPositions?.aave && (
                      <div className="p-4 bg-[#111] rounded-xl border border-blue-900/30">
                        <h4 className="text-kletiaBlue font-bold mb-3 border-b border-[#222] pb-2">AAVE V3 (BANKA)</h4>
                        <div className="flex justify-between py-1"><span className="text-gray-400">Yatırılan Teminat:</span><span className="text-green-400 font-bold">{msg.intentData.data.defiPositions.aave.suppliedCollateralUSD}</span></div>
                        <div className="flex justify-between py-1"><span className="text-gray-400">Toplam Borç:</span><span className="text-red-400 font-bold">{msg.intentData.data.defiPositions.aave.totalDebtUSD}</span></div>
                        <div className="flex justify-between py-1"><span className="text-gray-400">Sağlık (Health Factor):</span><span className="text-yellow-400 font-bold">{msg.intentData.data.defiPositions.aave.healthFactor}</span></div>
                      </div>
                    )}

                    {msg.intentData.data.defiPositions?.aerodrome && (
                      <div className="p-4 bg-[#111] rounded-xl border border-purple-900/30">
                        <h4 className="text-purple-400 font-bold mb-3 border-b border-[#222] pb-2">AERODROME (STAKING)</h4>
                        <div className="flex justify-between py-1"><span className="text-gray-400">Kilitli Miktar:</span><span className="text-white font-bold">{msg.intentData.data.defiPositions.aerodrome.lockedAmount}</span></div>
                        <div className="flex justify-between py-1"><span className="text-gray-400">Oy Gücü:</span><span className="text-purple-300 font-bold">{msg.intentData.data.defiPositions.aerodrome.votingPower}</span></div>
                        <div className="flex justify-between py-1"><span className="text-gray-400">Kilit Açılış (Unlock):</span><span className="text-gray-300">{msg.intentData.data.defiPositions.aerodrome.unlockDate}</span></div>
                      </div>
                    )}

                    {(!msg.intentData.data.wallet || msg.intentData.data.wallet.length === 0) && !msg.intentData.data.defiPositions?.aave && !msg.intentData.data.defiPositions?.aerodrome && (
                        <div className="p-4 bg-[#111] rounded-xl border border-[#333] text-gray-400 text-center">
                            Defi ağında desteklenen bir varlık bulunamadı.
                        </div>
                    )}
                  </div>
                )}

                {msg.intentData && msg.intentData.allRoutes && msg.intentData.action !== 'portfolio' && (
                  <div className="mt-5 p-4 rounded-xl bg-[#111] border border-[#333] flex flex-col gap-3 shadow-lg w-full sm:w-[450px]">
                    <div className="text-xs text-gray-500 font-semibold uppercase tracking-wider">🗺️ Otonom Rota Bulucu</div>
                    <select 
                      className="bg-[#1A1A1A] border border-[#333] text-sm text-gray-200 rounded-lg p-3 outline-none focus:border-kletiaBlue cursor-pointer"
                      value={msg.selectedRouteIndex}
                      onChange={(e) => updateMessage(msg.id, { selectedRouteIndex: Number(e.target.value) })}
                      disabled={msg.isLoading || !!msg.txHash}
                    >
                      {msg.intentData.allRoutes.map((route, idx) => (
                        <option key={idx} value={idx}>
                          {idx === 0 ? '🏆 En Kârlı: ' : '🔄 Alternatif: '} {route.name} ({route.expectedOutput})
                        </option>
                      ))}
                    </select>

                    <button 
                      onClick={() => executeRoute(msg.id)}
                      disabled={msg.isLoading || !!msg.txHash}
                      className="flex items-center justify-center gap-2 w-full bg-kletiaBlue hover:bg-blue-600 disabled:bg-[#222] disabled:text-gray-500 text-white font-bold py-3 rounded-lg transition-all"
                    >
                      {msg.isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : (msg.txHash ? <CheckCircle2 className="w-5 h-5 text-green-400" /> : <Zap className="w-5 h-5" />)}
                      {msg.isLoading ? 'Sistem Çalışıyor...' : (msg.txHash ? 'İşlem Başarılı' : 'Seçili Rotayı Çalıştır')}
                    </button>
                  </div>
                )}

                {msg.terminalLogs && msg.terminalLogs.length > 0 && (
                  <div className="mt-3 p-3 bg-black rounded-lg border border-[#222] font-mono text-[11px] text-green-400/90 leading-relaxed overflow-x-hidden w-full sm:w-[450px]">
                    <div className="text-[#555] mb-2 flex items-center gap-2"><ChevronRight className="w-3 h-3"/> KLETIA X-RAY KONSOLU</div>
                    {msg.terminalLogs.map((log, i) => (
                      <div key={i} className={`${log.includes('❌') ? 'text-red-400' : log.includes('⚠️') ? 'text-yellow-400' : log.includes('🛡️') ? 'text-blue-400' : ''}`}>{log}</div>
                    ))}
                    {msg.txHash && (
                      <a href={`https://basescan.org/tx/${msg.txHash}`} target="_blank" className="text-kletiaBlue hover:underline mt-2 block flex items-center gap-1">
                        BaseScan'de Görüntüle ↗
                      </a>
                    )}
                  </div>
                )}

              </div>

              {msg.role === 'user' && (
                <div className="w-10 h-10 rounded-full bg-kletiaBlue flex items-center justify-center shrink-0">
                  <User className="w-5 h-5 text-white" />
                </div>
              )}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
      </div>

      <div className="p-4 md:p-6 bg-kletiaDark border-t border-[#1a1a1a]">
        <div className="max-w-4xl mx-auto relative flex items-center">
          <input 
            type="text" 
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSend() }}
            placeholder="Kletia'ya bir emir ver... (Örn: Elimde neler var?, 0.1 USDC ile ETH al)"
            className="w-full bg-[#1A1A1A] border border-[#333] focus:border-kletiaBlue text-white rounded-2xl pl-5 pr-14 py-4 outline-none transition-all"
          />
          <button 
            onClick={handleSend}
            disabled={!input.trim()}
            className="absolute right-2 p-2 bg-kletiaBlue disabled:bg-gray-700 text-white rounded-xl transition-all"
          >
            <Send className="w-5 h-5" />
          </button>
        </div>
        <p className="text-center text-[10px] text-gray-600 mt-3">Kletia Omni-Engine Web3 işlemlerinde hata yapabilir. Önemli işlemleri onaylarken dikkatli olun.</p>
      </div>
    </div>
  );
}