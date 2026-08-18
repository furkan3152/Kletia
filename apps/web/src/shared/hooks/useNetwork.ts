import { useCallback, useEffect, useState } from "react";
import { useAccount, useChainId, useSwitchChain } from "wagmi";

import {
  getNetwork,
  getNetworkByChainId,
  type NetworkMode,
} from "../config/networks";
import { useAppStore } from "../state/useAppStore";

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return "Network switch was rejected.";
};

export function useNetwork() {
  const chainId = useChainId();
  const { isConnected } = useAccount();
  const { switchChainAsync, isPending } = useSwitchChain();
  const activeNetwork = useAppStore((state) => state.activeNetwork);
  const setActiveNetwork = useAppStore((state) => state.setActiveNetwork);
  const [switchError, setSwitchError] = useState<string | null>(null);

  useEffect(() => {
    if (!isConnected) return;

    const connectedNetwork = getNetworkByChainId(chainId);
    if (connectedNetwork && connectedNetwork.key !== activeNetwork) {
      setActiveNetwork(connectedNetwork.key);
      localStorage.setItem("kletia-network-mode", connectedNetwork.key);
      setSwitchError(null);
    }
  }, [activeNetwork, chainId, isConnected, setActiveNetwork]);

  const switchNetwork = useCallback(
    async (mode: NetworkMode): Promise<boolean> => {
      const targetNetwork = getNetwork(mode);
      setSwitchError(null);
      if (!targetNetwork.enabled) {
        setSwitchError(`${targetNetwork.name} Public Beta is not enabled on this deployment.`);
        return false;
      }

      if (!isConnected) {
        setActiveNetwork(mode);
        localStorage.setItem("kletia-network-mode", mode);
        return true;
      }

      if (chainId === targetNetwork.chainId) {
        setActiveNetwork(mode);
        localStorage.setItem("kletia-network-mode", mode);
        return true;
      }

      try {
        const switchedChain = await switchChainAsync({
          chainId: targetNetwork.chainId,
        });

        if (switchedChain.id !== targetNetwork.chainId) {
          throw new Error(
            `Wallet switched to chain ${switchedChain.id} instead of ${targetNetwork.chainId}.`,
          );
        }

        setActiveNetwork(mode);
        localStorage.setItem("kletia-network-mode", mode);
        return true;
      } catch (error) {
        setSwitchError(getErrorMessage(error));
        return false;
      }
    },
    [chainId, isConnected, setActiveNetwork, switchChainAsync],
  );

  return {
    networkMode: activeNetwork,
    network: getNetwork(activeNetwork),
    chainId,
    switchNetwork,
    isSwitching: isPending,
    switchError,
    isArc: activeNetwork === "arc",
    isBase: activeNetwork === "base",
    isArbitrum: activeNetwork === "arbitrum",
  };
}
