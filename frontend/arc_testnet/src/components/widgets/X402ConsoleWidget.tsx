import React, { useState, useEffect, useCallback } from 'react';
import { Wallet, Settings, ExternalLink, RefreshCw, Copy, Plus, CheckCircle, ArrowDownToLine, DollarSign, Cpu, AlertTriangle, Zap, Info, Shield } from 'lucide-react';
import { useAccount, useReadContract, usePublicClient, useWalletClient } from 'wagmi';
import { useSecureWriteContract } from '../../hooks/useSecureTransaction';
import { decodeEventLog, formatUnits } from 'viem';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { BatchSettlementEvmScheme } from '@x402/evm/batch-settlement/client';
import { X402FactoryABI, X402GatewayABI, USDC_ADDRESS, X402_FACTORY_ADDRESS } from '../../contracts/X402';

interface ContractData {
  address: string;
  owner: string;
  price: string;
  collected: string;
  label: string;
}

interface X402DebugInfo {
  status: number;
  payTo: string;
  price: string;
  network: string;
  error?: string;
}

const ERC20_BALANCE_ABI = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  }
] as const;

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

export const X402ConsoleWidget: React.FC = () => {

  const [contractLabel, setContractLabel] = useState('My x402 Gateway');
  const [initialPrice, setInitialPrice] = useState('0.01');
  const [activeContract, setActiveContract] = useState<ContractData | null>(null);
  const [isDeploying, setIsDeploying] = useState(false);
  const [isTestingPay, setIsTestingPay] = useState(false);
  const [newPrice, setNewPrice] = useState('0.01');
  const [loadAddress, setLoadAddress] = useState('');
  const [statusLog, setStatusLog] = useState<string[]>([]);
  const [debugInfo, setDebugInfo] = useState<X402DebugInfo | null>(null);
  const [payResult, setPayResult] = useState<any>(null);

  const { address } = useAccount();
  const { writeContractAsync, isCheckingSecurity, securityError, clearSecurityError } = useSecureWriteContract();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();

  // ── Read on-chain data ─────────────────────────────────────────────────
  const { data: onChainPrice, refetch: refetchPrice } = useReadContract({
    address: activeContract?.address as `0x${string}`,
    abi: X402GatewayABI,
    functionName: 'pricePerCall',
    query: { enabled: !!activeContract }
  });

  const { data: gatewayUsdcBalance, refetch: refetchBalance } = useReadContract({
    address: USDC_ADDRESS as `0x${string}`,
    abi: ERC20_BALANCE_ABI,
    functionName: 'balanceOf',
    args: activeContract ? [activeContract.address as `0x${string}`] : undefined,
    query: { enabled: !!activeContract }
  });

  useEffect(() => {
    if (activeContract && onChainPrice !== undefined) {
      const priceStr = formatUnits(onChainPrice as bigint, 6);
      setActiveContract(prev => prev ? { ...prev, price: priceStr } : null);
    }
  }, [onChainPrice]);

  useEffect(() => {
    if (activeContract && gatewayUsdcBalance !== undefined) {
      const balStr = formatUnits(gatewayUsdcBalance as bigint, 6);
      setActiveContract(prev => prev ? { ...prev, collected: balStr } : null);
    }
  }, [gatewayUsdcBalance]);

  const log = useCallback((msg: string) => {
    setStatusLog(prev => [...prev.slice(-19), `[${new Date().toLocaleTimeString()}] ${msg}`]);
  }, []);

  const handleDeploy = async () => {
    if (!address) return alert("Connect your wallet first.");
    setIsDeploying(true);
    log("🚀 Deploying gateway contract...");

    try {
      const priceAtomic = BigInt(Math.round(parseFloat(initialPrice) * 1e6));

      const txHash = await writeContractAsync({
        address: X402_FACTORY_ADDRESS as `0x${string}`,
        abi: X402FactoryABI,
        functionName: 'createGateway',
        args: [USDC_ADDRESS, priceAtomic],
      });

      log(`📤 TX sent: ${txHash.substring(0, 16)}...`);

      if (publicClient) {
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        log(`✅ TX confirmed! Block: ${receipt.blockNumber}`);

        let deployedGateway = "";
        for (const logEntry of receipt.logs) {
          try {
            const decoded = decodeEventLog({
              abi: X402FactoryABI,
              data: logEntry.data,
              topics: logEntry.topics,
            });
            if (decoded.eventName === 'GatewayCreated') {
              deployedGateway = (decoded.args as any).gatewayAddress;
              break;
            }
          } catch (e) { /* skip non-matching logs */ }
        }

        if (deployedGateway) {
          const newContract: ContractData = {
            address: deployedGateway,
            owner: address,
            price: initialPrice,
            collected: '0',
            label: contractLabel
          };
          setActiveContract(newContract);
          log(`🎉 Gateway deployed: ${deployedGateway.substring(0, 10)}...`);
        } else {
          log("⚠️ Contract created but address could not be read from event.");
        }
      }
    } catch (error: any) {
      log(`❌ Deploy error: ${error.message?.substring(0, 100)}`);
      console.error(error);
    }
    setIsDeploying(false);
  };

  // ── Load Existing Contract ─────────────────────────────────────────────
  const handleLoadContract = async () => {
    if (!loadAddress || !loadAddress.startsWith('0x')) {
      return alert("Enter a valid contract address.");
    }

    log(`🔄 Loading contract: ${loadAddress.substring(0, 10)}...`);

    try {
      if (publicClient) {
        const price = await publicClient.readContract({
          address: loadAddress as `0x${string}`,
          abi: X402GatewayABI,
          functionName: 'pricePerCall',
        });
        const owner = await publicClient.readContract({
          address: loadAddress as `0x${string}`,
          abi: X402GatewayABI,
          functionName: 'owner',
        });
        const balance = await publicClient.readContract({
          address: USDC_ADDRESS as `0x${string}`,
          abi: ERC20_BALANCE_ABI,
          functionName: 'balanceOf',
          args: [loadAddress as `0x${string}`],
        });

        setActiveContract({
          address: loadAddress,
          owner: owner as string,
          price: formatUnits(price as bigint, 6),
          collected: formatUnits(balance as bigint, 6),
          label: 'Loaded Gateway'
        });
        log(`✅ Contract loaded. Owner: ${(owner as string).substring(0, 8)}...`);
      }
    } catch (e: any) {
      log(`❌ Contract load failed: ${e.message?.substring(0, 80)}`);
    }
  };

  // ── Test Pay with x402 Protocol ────────────────────────────────────────
  const handleTestPay = async () => {
    if (!address || !activeContract) return alert("Wallet must be connected and contract loaded.");
    if (!walletClient) return alert("Wallet client not connected.");

    setIsTestingPay(true);
    setPayResult(null);
    log("💳 x402 payment flow starting...");

    try {
      // Step 1: Create signer from wagmi wallet client
      const signer = {
        address: address,
        signTypedData: async (params: any) => {
          log("🖊️ MetaMask EIP-712 imza isteniyor...");
          return await walletClient.signTypedData({
            domain: params.domain,
            types: params.types,
            primaryType: params.primaryType,
            message: params.message
          });
        },
        readContract: publicClient ? publicClient.readContract.bind(publicClient) : undefined,
        writeContract: walletClient.writeContract.bind(walletClient),
        sendTransaction: walletClient.sendTransaction.bind(walletClient),
      };

      // Step 2: Create x402 wrapped fetch
      const x402Fetch = wrapFetchWithPaymentFromConfig(window.fetch.bind(window), {
        schemes: [
          {
            network: "eip155:8453",
            client: new BatchSettlementEvmScheme(signer as any),
          }
        ]
      });

      const endpoint = `${BACKEND_URL}/api/premium/alpha-signals?gateway=${activeContract.address}&price=${activeContract.price}`;
      log(`📡 Request: ${endpoint}`);

      const response = await x402Fetch(endpoint);

      if (response.ok) {
        const data = await response.json();
        setPayResult(data);
        log("🎉 SUCCESS! x402 payment processed and data received.");

        refetchBalance();
        refetchPrice();
      } else {
        const errorText = await response.text();
        log(`⚠️ Response ${response.status}: ${errorText.substring(0, 200)}`);
        setPayResult({ error: true, status: response.status, body: errorText });
      }
    } catch (e: any) {
      log(`❌ Payment error: ${e.message?.substring(0, 200)}`);
      console.error("x402 Pay Error:", e);
      setPayResult({ error: true, message: e.message });
    }
    setIsTestingPay(false);
  };

  const handleDebug = async () => {
    if (!activeContract) return;
    log("🔍 Fetching x402 debug info...");

    try {
      const res = await fetch(`${BACKEND_URL}/api/premium/debug-x402?gateway=${activeContract.address}`);
      const data = await res.json();
      setDebugInfo({
        status: data.x402_status,
        payTo: data.decoded_payment_required?.resource?.payTo || data.payTo_used || 'N/A',
        price: data.decoded_payment_required?.resource?.amount || 'N/A',
        network: data.decoded_payment_required?.resource?.network || 'eip155:8453',
        error: data.decoded_payment_required?.error
      });
      log(`✅ Debug: Status=${data.x402_status}, PayTo=${data.payTo_used?.substring(0, 10)}...`);
    } catch (e: any) {
      log(`❌ Debug error: ${e.message}`);
    }
  };

  const handleSetPrice = async () => {
    if (!address || !activeContract) return alert("Wallet ve kontrat gerekli.");
    log(`💰 Updating price: ${newPrice} USDC...`);

    try {
      const priceAtomic = BigInt(Math.round(parseFloat(newPrice) * 1e6));
      const txHash = await writeContractAsync({
        address: activeContract.address as `0x${string}`,
        abi: X402GatewayABI,
        functionName: 'setPrice',
        args: [priceAtomic],
      });
      log(`📤 Set Price TX: ${txHash.substring(0, 16)}...`);

      if (publicClient) {
        await publicClient.waitForTransactionReceipt({ hash: txHash });
        refetchPrice();
        log(`✅ Price updated: ${newPrice} USDC`);
      }
    } catch (e: any) {
      log(`❌ Price update error: ${e.message?.substring(0, 100)}`);
    }
  };

  const handleWithdraw = async () => {
    if (!address || !activeContract) return alert("Wallet ve kontrat gerekli.");
    log("💸 Starting USDC withdrawal...");

    try {
      const txHash = await writeContractAsync({
        address: activeContract.address as `0x${string}`,
        abi: X402GatewayABI,
        functionName: 'withdraw',
        args: [address],
      });
      log(`📤 Withdraw TX: ${txHash.substring(0, 16)}...`);

      if (publicClient) {
        await publicClient.waitForTransactionReceipt({ hash: txHash });
        refetchBalance();
        log("✅ USDC withdrawn successfully!");
      }
    } catch (e: any) {
      log(`❌ Withdrawal error: ${e.message?.substring(0, 100)}`);
    }
  };

  const handleRefresh = () => {
    refetchPrice();
    refetchBalance();
    handleDebug();
    log("🔄 On-chain veriler yenilendi.");
  };

  const copyGatewayUrl = () => {
    if (!activeContract) return;
    const url = `${BACKEND_URL}/api/premium/alpha-signals?gateway=${activeContract.address}`;
    navigator.clipboard.writeText(url);
    log("📋 Gateway URL copied.");
  };

  return (
    <div className="w-full h-full p-4 md:p-8 overflow-y-auto custom-scrollbar flex flex-col items-center">
      <div className="w-full max-w-5xl space-y-6">

        {}
        <div className="bg-white dark:bg-[#131E32] border-[4px] border-[#1A1A1A] dark:border-[#4B5563] p-6 shadow-[8px_8px_0_#1A1A1A] dark:shadow-[8px_8px_0_#475569]">
          <h1 className="text-3xl font-black text-[#1A1A1A] dark:text-white uppercase flex items-center gap-3">
            <Cpu className="text-[#0052FF]" />
            x402 Payment Console
          </h1>
          <p className="text-gray-600 dark:text-slate-400 font-bold mt-2">
            Deploy a payment-required endpoint contract from your own wallet. Set the USDC price, collect payments, then withdraw as the owner.
          </p>
          <div className="flex gap-2 mt-3">
            <span className="text-[10px] font-black bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 px-2 py-1 uppercase">Base Mainnet</span>
            <span className="text-[10px] font-black bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 px-2 py-1 uppercase">x402 V2</span>
            <span className="text-[10px] font-black bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 px-2 py-1 uppercase">CDP Facilitator</span>
          </div>
        </div>

        {securityError && (
          <div className="bg-red-600 border-[4px] border-[#1A1A1A] p-4 shadow-[4px_4px_0_#1A1A1A] flex items-start gap-3">
            <Shield className="w-6 h-6 text-white shrink-0" />
            <div className="flex-1">
              <h3 className="font-black text-white uppercase text-sm mb-1">Security Intercepted</h3>
              <p className="text-white text-sm font-bold">{securityError}</p>
            </div>
            <button onClick={clearSecurityError} className="text-white font-black hover:opacity-70">X</button>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

          {}
          <div className="space-y-6">
            <div className="bg-white dark:bg-[#1A2841] border-[4px] border-[#1A1A1A] dark:border-[#4B5563] p-6 shadow-[6px_6px_0_#1A1A1A] dark:shadow-[6px_6px_0_#475569]">
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-black text-gray-500 uppercase mb-2">Contract Label</label>
                  <input
                    type="text"
                    value={contractLabel}
                    onChange={(e) => setContractLabel(e.target.value)}
                    className="w-full bg-gray-50 dark:bg-[#131E32] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] p-3 font-bold text-[#1A1A1A] dark:text-white outline-none focus:border-[#0052FF] transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-sm font-black text-gray-500 uppercase mb-2">Price / Call (USDC)</label>
                  <input
                    type="number"
                    step="0.001"
                    min="0.001"
                    value={initialPrice}
                    onChange={(e) => setInitialPrice(e.target.value)}
                    className="w-full bg-gray-50 dark:bg-[#131E32] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] p-3 font-bold text-[#1A1A1A] dark:text-white outline-none focus:border-[#0052FF] transition-colors"
                  />
                </div>
                <button
                  onClick={handleDeploy}
                  disabled={isDeploying || !!activeContract || isCheckingSecurity}
                  className="w-full bg-[#0052FF] hover:bg-blue-700 disabled:bg-gray-400 text-white font-black p-4 border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] active:translate-y-1 active:shadow-none transition-all uppercase flex justify-center items-center gap-2"
                >
                  {isDeploying || isCheckingSecurity ? <RefreshCw className="animate-spin" size={18} /> : <Plus size={18} />}
                  {isCheckingSecurity ? 'Scanning...' : isDeploying ? 'Deploying...' : 'Deploy My x402 Contract'}
                </button>

              </div>
            </div>

            {}
            <div className="bg-gray-100 dark:bg-[#131E32] border-[3px] border-dashed border-gray-300 dark:border-[#4B5563] p-6 rounded-xl">
              <h3 className="font-black text-gray-400 uppercase tracking-widest mb-4">FLOW</h3>
              <div className="space-y-4">
                {[
                  { step: '1', title: 'Deploy', desc: 'Your wallet creates a contract that requires USDC before serving a paid endpoint.' },
                  { step: '2', title: 'Price', desc: 'Each call reads the on-chain price, so you can update the fee later as the owner.' },
                  { step: '3', title: 'Pay', desc: 'Visitors sign an x402 EIP-712 authorization. CDP Facilitator settles via Permit2.' },
                  { step: '4', title: 'Withdraw', desc: 'Only the owner wallet can withdraw collected USDC from the contract.' },
                ].map(f => (
                  <div key={f.step} className="flex gap-3">
                    <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-slate-700 flex items-center justify-center font-black text-sm shrink-0">{f.step}</div>
                    <div>
                      <h4 className="font-bold text-[#1A1A1A] dark:text-white">{f.title}</h4>
                      <p className="text-sm text-gray-500 dark:text-slate-400">{f.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {}
          <div className="space-y-6">
            {!activeContract ? (
              <div className="bg-white dark:bg-[#1A2841] border-[4px] border-[#1A1A1A] dark:border-[#4B5563] p-6 shadow-[6px_6px_0_#1A1A1A] dark:shadow-[6px_6px_0_#475569] flex flex-col items-center justify-center text-center min-h-[300px]">
                <Settings className="w-16 h-16 text-gray-300 dark:text-slate-600 mb-4" />
                <h3 className="text-xl font-black text-gray-400">NO ACTIVE CONTRACT</h3>
                <p className="text-sm text-gray-500 mt-2 font-bold">Deploy a new contract or load an existing one.</p>

                <div className="w-full mt-8 pt-6 border-t-[3px] border-dashed border-gray-200 dark:border-[#4B5563]">
                  <label className="block text-sm font-black text-gray-500 uppercase mb-2">Load Existing Contract</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="0x..."
                      value={loadAddress}
                      onChange={(e) => setLoadAddress(e.target.value)}
                      className="flex-1 bg-gray-50 dark:bg-[#131E32] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] p-2 font-mono text-sm text-[#1A1A1A] dark:text-white outline-none"
                    />
                    <button
                      onClick={handleLoadContract}
                      className="bg-gray-800 text-white font-black px-4 border-[3px] border-[#1A1A1A] uppercase hover:bg-gray-700 transition-colors"
                    >
                      Load
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="bg-[#E8F5E9] dark:bg-[#132A1D] border-[4px] border-green-600 p-6 shadow-[6px_6px_0_#16A34A]">
                <div className="flex items-center gap-2 text-green-700 dark:text-green-400 font-black mb-4">
                  <CheckCircle size={20} />
                  Ready. Test an x402 payment or manage your gateway.
                </div>

                {}
                <div className="bg-white dark:bg-[#1A2841] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] p-4 mb-6">
                  <h3 className="font-black text-lg mb-4 text-[#1A1A1A] dark:text-white flex items-center justify-between">
                    ACTIVE x402 CONTRACT
                    <span className="text-xs bg-green-200 dark:bg-green-900/50 text-green-800 dark:text-green-300 px-2 py-1 uppercase font-black">LIVE</span>
                  </h3>

                  <div className="space-y-3 font-mono text-sm">
                    {[
                      { label: 'Address', value: `${activeContract.address.substring(0, 10)}...${activeContract.address.substring(36)}`, color: 'text-[#0052FF]' },
                      { label: 'Owner', value: `${activeContract.owner.substring(0, 8)}...${activeContract.owner.substring(38)}`, color: 'text-[#1A1A1A] dark:text-white' },
                      { label: 'Price', value: `${activeContract.price} USDC`, color: 'text-[#1A1A1A] dark:text-white' },
                      { label: 'Collected', value: `${activeContract.collected} USDC`, color: 'font-black text-green-600 dark:text-green-400' },
                    ].map(row => (
                      <div key={row.label} className="flex justify-between items-center border-b border-gray-100 dark:border-slate-700 pb-2 last:border-0">
                        <span className="text-gray-500 font-sans font-bold uppercase">{row.label}</span>
                        <span className={`font-bold ${row.color}`}>{row.value}</span>
                      </div>
                    ))}
                  </div>

                  {}
                  <div className="flex gap-2 mt-4">
                    <button onClick={copyGatewayUrl} className="flex-1 flex items-center justify-center gap-2 bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-white font-bold p-2 text-xs uppercase hover:bg-gray-200 dark:hover:bg-slate-600 transition-colors">
                      <Copy size={14} /> Copy Link
                    </button>
                    <a href={`https://testnet.arcscan.app/address/${activeContract.address}`} target="_blank" rel="noreferrer" className="flex-1 flex items-center justify-center gap-2 bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-white font-bold p-2 text-xs uppercase hover:bg-gray-200 dark:hover:bg-slate-600 transition-colors cursor-pointer">
                      <ExternalLink size={14} /> Basescan
                    </a>
                    <button onClick={handleRefresh} className="flex-none flex items-center justify-center w-10 bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-white font-bold p-2 hover:bg-gray-200 dark:hover:bg-slate-600 transition-colors">
                      <RefreshCw size={14} />
                    </button>
                  </div>
                </div>

                {}
                <div className="space-y-4">
                  {}
                  <button
                    onClick={handleTestPay}
                    disabled={isTestingPay}
                    className="w-full bg-[#1A1A1A] dark:bg-white text-white dark:text-[#1A1A1A] hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-50 font-black p-3 border-[3px] border-[#1A1A1A] dark:border-[#4B5563] uppercase flex justify-center items-center gap-2 shadow-[3px_3px_0_#1A1A1A] active:translate-y-1 active:shadow-none transition-all"
                  >
                    {isTestingPay ? <RefreshCw className="animate-spin" size={16} /> : <DollarSign size={16} />}
                    {isTestingPay ? 'Processing x402...' : `Test Pay ${activeContract.price} USDC`}
                  </button>

                  {}
                  <div className="flex gap-2">
                    <input
                      type="number"
                      step="0.001"
                      min="0.001"
                      value={newPrice}
                      onChange={(e) => setNewPrice(e.target.value)}
                      className="w-24 bg-white dark:bg-[#131E32] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] p-2 font-bold text-[#1A1A1A] dark:text-white text-center outline-none"
                    />
                    <button disabled={isCheckingSecurity} onClick={handleSetPrice} className="flex-1 bg-white dark:bg-slate-800 text-[#1A1A1A] dark:text-white hover:bg-gray-50 border-[3px] border-[#1A1A1A] dark:border-[#4B5563] font-black p-2 uppercase shadow-[2px_2px_0_#1A1A1A] dark:shadow-[2px_2px_0_#475569] active:translate-y-1 active:shadow-none transition-all disabled:opacity-50">
                      <Settings size={14} className="inline mr-2" />{isCheckingSecurity ? 'Wait' : 'Set Price'}
                    </button>
                  </div>

                  {}
                  <button onClick={handleDebug} className="w-full bg-gray-200 dark:bg-slate-700 text-gray-700 dark:text-white hover:bg-gray-300 dark:hover:bg-slate-600 font-bold p-2 border-[2px] border-gray-300 dark:border-[#4B5563] uppercase text-sm flex justify-center items-center gap-2 transition-colors">
                    <Info size={14} /> Debug x402 Response
                  </button>

                  {}
                  <button onClick={handleWithdraw} className="w-full bg-amber-400 hover:bg-amber-500 text-amber-950 font-black p-3 border-[3px] border-[#1A1A1A] uppercase flex justify-center items-center gap-2 shadow-[4px_4px_0_#1A1A1A] active:translate-y-1 active:shadow-none transition-all">
                    <ArrowDownToLine size={18} /> Withdraw Collected USDC
                  </button>

                  {}
                  <button
                    onClick={() => { setActiveContract(null); setDebugInfo(null); setPayResult(null); log("🗑️ Contract reset."); }}
                    className="w-full text-gray-400 hover:text-red-500 font-bold text-xs uppercase py-2 transition-colors"
                  >
                    Reset / Load Different Contract
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {}
        {debugInfo && (
          <div className="bg-gray-900 border-[3px] border-[#0052FF] p-4 shadow-[4px_4px_0_#0052FF]">
            <h3 className="font-black text-[#0052FF] uppercase mb-3 flex items-center gap-2">
              <Shield size={16} /> x402 Debug Info
            </h3>
            <div className="grid grid-cols-2 gap-2 font-mono text-xs text-gray-300">
              <div>Status: <span className={debugInfo.status === 402 ? 'text-yellow-400' : 'text-green-400'}>{debugInfo.status}</span></div>
              <div>Network: <span className="text-blue-400">{debugInfo.network}</span></div>
              <div className="col-span-2">PayTo: <span className="text-white">{debugInfo.payTo}</span></div>
              <div className="col-span-2">Price: <span className="text-green-400">{debugInfo.price}</span></div>
              {debugInfo.error && <div className="col-span-2 text-red-400">Error: {debugInfo.error}</div>}
            </div>
          </div>
        )}

        {}
        {payResult && (
          <div className={`border-[3px] p-4 shadow-[4px_4px_0] ${payResult.error ? 'bg-red-50 dark:bg-red-900/20 border-red-500 shadow-red-500' : 'bg-green-50 dark:bg-green-900/20 border-green-500 shadow-green-500'}`}>
            <h3 className={`font-black uppercase mb-2 flex items-center gap-2 ${payResult.error ? 'text-red-600' : 'text-green-600'}`}>
              {payResult.error ? <AlertTriangle size={16} /> : <Zap size={16} />}
              {payResult.error ? 'Payment Failed' : 'Payment Success!'}
            </h3>
            <pre className="text-xs font-mono overflow-auto max-h-32 text-gray-700 dark:text-gray-300">
              {JSON.stringify(payResult, null, 2)}
            </pre>
          </div>
        )}

        {}
        <div className="bg-gray-900 border-[3px] border-gray-700 p-4">
          <h3 className="font-black text-gray-500 uppercase tracking-widest mb-2 text-xs">Console Log</h3>
          <div className="space-y-1 font-mono text-xs max-h-40 overflow-y-auto custom-scrollbar">
            {statusLog.length === 0 ? (
              <div className="text-gray-600">Waiting for action...</div>
            ) : (
              statusLog.map((msg, i) => (
                <div key={i} className="text-gray-400">{msg}</div>
              ))
            )}
          </div>
        </div>

        {}
        <div className="pt-6 border-t-[4px] border-[#1A1A1A] dark:border-[#4B5563]">
          <h2 className="text-xl font-black text-[#1A1A1A] dark:text-white uppercase mb-4 flex items-center gap-2">
            <Wallet size={20} /> My x402 Contracts
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {activeContract && (
              <div className="bg-white dark:bg-[#1A2841] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] p-4 shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] flex justify-between items-center">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[10px] font-black bg-green-100 text-green-800 px-1.5 py-0.5 uppercase">Active</span>
                    <span className="font-bold text-[#1A1A1A] dark:text-white">{activeContract.label}</span>
                  </div>
                  <div className="font-mono text-xs text-gray-500">{activeContract.address.substring(0, 8)}...{activeContract.address.substring(38)}</div>
                </div>
                <div className="text-right">
                  <div className="font-bold text-sm text-[#1A1A1A] dark:text-white">{activeContract.price} USDC/call</div>
                  <div className="font-black text-green-600 text-sm">{activeContract.collected} USDC</div>
                </div>
              </div>
            )}

            <div className="bg-gray-50 dark:bg-[#131E32] border-[3px] border-dashed border-gray-300 dark:border-[#4B5563] p-4 flex items-center justify-center text-center opacity-70">
              <div className="text-gray-400 text-sm font-bold">
                <Plus size={20} className="inline mr-2" />
                Deploy or load more contracts
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
};
