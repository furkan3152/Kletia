// backend/arc_testnet/src/config/constants.ts
// Arc Testnet token ve kontrat adresleri
// Arc'ın native token'ı USDC'dir (gas olarak da kullanılır)
import { getAddress } from 'viem';
import { ARC_CONTRACTS } from './arcConfig.js';

// Arc Testnet'te kullanılan token adresleri
export const TOKENS: Record<string, `0x${string}`> = {
    "USDC": getAddress(ARC_CONTRACTS.Token), // KLET token (Arc native ERC20)
    "KLET": getAddress(ARC_CONTRACTS.Token),
};

// Arc Testnet'teki Kletia kontrat adresleri
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

// Arc Testnet'te DEX ABI'leri kullanılmıyor — tüm swap işlemleri Kletia Swap kontratı üzerinden yapılır
// Aşağıdaki ABI'ler Base Mainnet'e özgüdür ve arc_testnet'te kullanılmaz
// Kletia-specific ABI'ler arcConfig.ts'den import edilmelidir