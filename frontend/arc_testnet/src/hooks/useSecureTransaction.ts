import { useWriteContract } from 'wagmi';
import { useState } from 'react';

export function useSecureWriteContract() {
  const { writeContract: originalWriteContract, writeContractAsync: originalWriteContractAsync, ...rest } = useWriteContract();
  const [isCheckingSecurity, setIsCheckingSecurity] = useState(false);
  const [securityError, setSecurityError] = useState<string | null>(null);

  const checkWebacySecurity = async (address: string) => {
    if (!address) return { safe: true };
    try {
      const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';
      const res = await fetch(`${BACKEND_URL}/api/webacy/scan/${address}`);
      if (res.ok) {
        const data = await res.json();
        if (data.status === 'success' && data.riskScore > 50) {
          return { safe: false, data };
        }
      }
    } catch (err) {
      console.error("Webacy Security Check failed:", err);
    }
    return { safe: true };
  };

  const writeContract = async (args: any, options?: any) => {
    setIsCheckingSecurity(true);
    setSecurityError(null);
    const check = await checkWebacySecurity(args.address);
    setIsCheckingSecurity(false);

    if (!check.safe) {
      const errMessage = `Webacy Blocked Transaction: Target contract has a high risk score (${check.data.riskScore}/100). Risks: ${check.data.tags?.join(', ')}`;
      setSecurityError(errMessage);
      console.error(errMessage);
      if (options?.onError) {
        options.onError(new Error(errMessage));
      }
      return;
    }

    console.log(`%c[Webacy Security] Target Address Risk Score: ${check.data?.riskScore || 0}/100 (Safe to proceed)`, 'color: #00ff00; font-weight: bold;');
    return originalWriteContract(args, options);
  };

  const writeContractAsync = async (args: any, options?: any) => {
    setIsCheckingSecurity(true);
    setSecurityError(null);
    const check = await checkWebacySecurity(args.address);
    setIsCheckingSecurity(false);

    if (!check.safe) {
      const errMessage = `Webacy Blocked Transaction: Target contract has a high risk score (${check.data.riskScore}/100). Risks: ${check.data.tags?.join(', ')}`;
      setSecurityError(errMessage);
      console.error(errMessage);
      throw new Error(errMessage);
    }

    console.log(`%c[Webacy Security] Target Address Risk Score: ${check.data?.riskScore || 0}/100 (Safe to proceed)`, 'color: #00ff00; font-weight: bold;');
    return originalWriteContractAsync(args, options);
  };

  return { 
    ...rest, 
    writeContract, 
    writeContractAsync, 
    isCheckingSecurity, 
    securityError,
    clearSecurityError: () => setSecurityError(null)
  };
}
