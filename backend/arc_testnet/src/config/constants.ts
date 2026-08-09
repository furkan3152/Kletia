

import { getAddress } from 'viem';
import { ARC_CONTRACTS } from './arcConfig.js';

export const TOKENS: Record<string, `0x${string}`> = {
    "USDC": getAddress(ARC_CONTRACTS.Token), 
    "KLET": getAddress(ARC_CONTRACTS.Token),
};

export const ROUTERS = {
    KLETIA_SWAP: getAddress(ARC_CONTRACTS.Swap),
    KLETIA_LENDING: getAddress(ARC_CONTRACTS.Lending),
    KLETIA_BATCHPAY: getAddress(ARC_CONTRACTS.BatchPay),
    KLETIA_VAULT: getAddress(ARC_CONTRACTS.Vault),
    KLETIA_MEMOTRANSFER: getAddress(ARC_CONTRACTS.MemoTransfer),
    KLETIA_AGENT_REGISTRY: getAddress(ARC_CONTRACTS.AgentRegistry),
    KLETIA_STAKING: getAddress(ARC_CONTRACTS.Staking),
    KLETIA_OTC: getAddress(ARC_CONTRACTS.OTC),
};

