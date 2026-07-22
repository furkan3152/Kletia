import { useState, useCallback } from 'react';
import { NetworkMode, getNetwork } from '../config/networks';

export function useNetwork() {
  const [networkMode, setNetworkMode] = useState<NetworkMode>(() => {
    const saved = localStorage.getItem('kletia-network-mode');
    return (saved === 'arc' ? 'arc' : 'base') as NetworkMode;
  });

  const network = getNetwork(networkMode);

  const switchNetwork = useCallback((mode: NetworkMode) => {
    setNetworkMode(mode);
    localStorage.setItem('kletia-network-mode', mode);
  }, []);

  const toggleNetwork = useCallback(() => {
    switchNetwork(networkMode === 'base' ? 'arc' : 'base');
  }, [networkMode, switchNetwork]);

  return {
    networkMode,
    network,
    switchNetwork,
    toggleNetwork,
    isArc: networkMode === 'arc',
    isBase: networkMode === 'base',
  };
}
