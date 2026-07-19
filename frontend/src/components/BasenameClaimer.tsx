import { useState } from 'react';
import { useAccount, useWaitForTransactionReceipt, useReadContract } from 'wagmi';
import { useSecureWriteContract } from '../hooks/useSecureTransaction';
import { formatEther } from 'viem';
import { Tag, Check, Loader2, AlertTriangle, ShieldAlert } from 'lucide-react';

const REGISTRAR_ABI = [{
    inputs: [{
        components: [
            { internalType: "string", name: "name", type: "string" },
            { internalType: "address", name: "owner", type: "address" },
            { internalType: "uint256", name: "duration", type: "uint256" },
            { internalType: "address", name: "resolver", type: "address" },
            { internalType: "bytes[]", name: "data", type: "bytes[]" },
            { internalType: "bool", name: "reverseRecord", type: "bool" }
        ],
        internalType: "struct RegistrarController.RegisterRequest",
        name: "request",
        type: "tuple"
    }],
    name: "register",
    outputs: [],
    stateMutability: "payable",
    type: "function"
}] as const;

const PRICE_ORACLE_ABI = [{
    inputs: [
        { internalType: "string", name: "name", type: "string" },
        { internalType: "uint256", name: "duration", type: "uint256" }
    ],
    name: "rentPrice",
    outputs: [{
        components: [
            { internalType: "uint256", name: "base", type: "uint256" },
            { internalType: "uint256", name: "premium", type: "uint256" }
        ],
        internalType: "struct IPriceOracle.Price",
        name: "price",
        type: "tuple"
    }],
    stateMutability: "view",
    type: "function"
}] as const;

export function BasenameClaimer() {
    const { address } = useAccount();
    const [name, setName] = useState('');
    const { data: hash, isPending, isCheckingSecurity, securityError, writeContract, error } = useSecureWriteContract();
    
    const cleanName = name.toLowerCase().replace(/[^a-z0-9-]/g, '').replace('.base.eth', '');
    const duration = 31557600n; // 1 year in seconds

    const { data: rentPriceData } = useReadContract({
        address: "0x4cCb0BB02FCABA27e82a56646E81d8c5bC4119a5",
        abi: PRICE_ORACLE_ABI,
        functionName: "rentPrice",
        args: cleanName ? [cleanName, duration] : undefined,
        query: {
            enabled: cleanName.length >= 3,
        }
    });

    // The tuple return may be formatted as an object { base: bigint, premium: bigint } or an array [base, premium]
    // Let's handle both gracefully
    let totalPriceInWei = 0n;
    if (rentPriceData) {
        if (Array.isArray(rentPriceData)) {
            totalPriceInWei = rentPriceData[0] + rentPriceData[1];
        } else if (typeof rentPriceData === 'object' && rentPriceData !== null) {
            totalPriceInWei = (rentPriceData as any).base + (rentPriceData as any).premium;
        }
    }

    const { isLoading: isConfirming, isSuccess: isConfirmed } = 
        useWaitForTransactionReceipt({ hash });

    const handleRegister = async () => {
        if (!cleanName || !address || totalPriceInWei === 0n) return;
        
        writeContract({
            address: "0x4cCb0BB02FCABA27e82a56646E81d8c5bC4119a5",
            abi: REGISTRAR_ABI,
            functionName: "register",
            args: [{
                name: cleanName,
                owner: address,
                duration: duration,
                resolver: "0xC6d566A56A1aFf6508b41f6c90ff131615583BCD", // L2 Resolver
                data: [],
                reverseRecord: false
            }],
            value: totalPriceInWei
        });
    };

    return (
        <div className="flex-1 flex flex-col items-center justify-center p-6 w-full h-full">
            <div className="bg-white dark:bg-[#1A2841] border-[4px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[8px_8px_0_#1A1A1A] dark:shadow-[8px_8px_0_#475569] p-8 max-w-lg w-full flex flex-col items-center text-center">
                <div className="w-20 h-20 bg-[#0052FF] border-[3px] border-[#1A1A1A] dark:border-[#4B5563] rounded-full flex items-center justify-center mb-6 shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] -rotate-6">
                    <Tag className="w-10 h-10 text-white" strokeWidth={3} />
                </div>
                
                <h2 className="text-3xl font-black text-[#1A1A1A] dark:text-white uppercase tracking-tighter mb-2">Claim Your Base Identity</h2>
                <p className="text-gray-500 dark:text-gray-400 font-bold mb-8 text-sm px-4">Register your unique .base.eth username directly on the blockchain.</p>

                <div className="w-full relative mb-2">
                    <input 
                        type="text" 
                        value={name}
                        onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                        placeholder="yourname"
                        className="w-full bg-[#EFEFEF] dark:bg-slate-800 border-[3px] border-[#1A1A1A] dark:border-[#4B5563] text-2xl font-black text-[#1A1A1A] dark:text-white p-4 pl-4 pr-32 outline-none focus:bg-white dark:focus:bg-slate-700 transition-colors"
                    />
                    <div className="absolute right-4 top-1/2 -translate-y-1/2 text-xl font-black text-[#0052FF] opacity-80 pointer-events-none">
                        .base.eth
                    </div>
                </div>
                
                <div className="w-full text-right mb-4 min-h-[24px]">
                    {cleanName.length > 0 && cleanName.length < 3 && (
                        <span className="text-red-500 font-bold text-sm">Name must be at least 3 characters</span>
                    )}
                    {totalPriceInWei > 0n && (
                        <span className="text-green-600 dark:text-green-400 font-black text-sm">
                            Fiyat: {formatEther(totalPriceInWei)} ETH
                        </span>
                    )}
                </div>

                {!address ? (
                    <div className="w-full p-4 bg-yellow-100 border-[3px] border-yellow-400 text-yellow-800 font-bold flex items-center justify-center gap-2">
                        <AlertTriangle className="w-5 h-5" /> Please connect wallet first
                    </div>
                ) : (
                    <button 
                        onClick={handleRegister}
                        disabled={cleanName.length < 3 || isPending || isConfirming || isConfirmed || totalPriceInWei === 0n || isCheckingSecurity}
                        className="w-full flex items-center justify-center gap-3 bg-[#0052FF] hover:bg-blue-700 disabled:bg-gray-300 dark:disabled:bg-slate-700 disabled:text-gray-500 text-white font-black py-4 border-[3px] border-[#1A1A1A] dark:border-[#4B5563] shadow-[4px_4px_0_#1A1A1A] dark:shadow-[4px_4px_0_#475569] active:translate-y-1 active:shadow-none transition-all uppercase text-lg"
                    >
                        {isCheckingSecurity || isPending || isConfirming ? <Loader2 className="w-6 h-6 animate-spin" strokeWidth={4} /> : (isConfirmed ? <Check className="w-6 h-6" strokeWidth={4} /> : <Tag className="w-6 h-6" strokeWidth={4} />)}
                        {isCheckingSecurity ? 'Webacy Scan...' : isPending ? 'Pending Confirmation...' : isConfirming ? 'Processing on Network...' : isConfirmed ? 'Registration Success!' : totalPriceInWei > 0n ? `Register (${formatEther(totalPriceInWei)} ETH)` : 'Calculating...'}
                    </button>
                )}

                {securityError && (
                    <div className="mt-4 text-white font-bold text-sm bg-red-600 border-[3px] border-[#1A1A1A] p-4 w-full text-left break-words shadow-[4px_4px_0_#1A1A1A] flex items-start gap-3">
                        <ShieldAlert className="w-6 h-6 shrink-0" />
                        <div>{securityError}</div>
                    </div>
                )}
                
                {error && !securityError && (
                    <div className="mt-4 text-red-500 font-bold text-sm bg-red-100 border-[2px] border-red-500 p-2 w-full text-left break-words">
                        Error: {(error as any).shortMessage || error.message}
                    </div>
                )}
                
                {hash && (
                    <a href={`https://testnet.arcscan.app/tx/${hash}`} target="_blank" className="mt-4 text-[#0052FF] hover:underline font-black text-sm">
                        View Transaction on BaseScan ↗
                    </a>
                )}
            </div>
        </div>
    );
}
