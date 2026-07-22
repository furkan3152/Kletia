import { publicClient } from '../config/client.js';
import { TOKENS } from '../config/constants.js';
import { erc20Abi } from 'viem';

export async function checkTokenSecurity(tokenAddress: string | undefined) {
    if (!tokenAddress || tokenAddress.toLowerCase() === "native") return true;
    try {
        const response = await fetch(`https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${tokenAddress}`);
        const data = await response.json();
        const security = data.result[tokenAddress.toLowerCase()];
        
        if (!security) return true;
        if (security.is_honeypot === "1" || security.is_blacklisted === "1" || security.is_scam === "1") {
            throw new Error(`🚨 GÜVENLİK RİSKİ: Bu token bir Honeypot or Scam olabilir! Kletia seni korumak için işlemi durdurdu.`);
        }
        return true;
    } catch (e: any) {
        if (e.message?.includes('GÜVENLİK RİSKİ')) throw e;
        return true;
    }
}

export async function xRaySimulate(router: `0x${string}`, data: `0x${string}`, user: string, val: string, name: string, tokensToCheck: {addr?: string, amt?: string}[] = []): Promise<{success: boolean, error?: any}> {
    try {
        await publicClient.call({ account: user as `0x${string}`, to: router, data, value: BigInt(val) });
        console.log(`✅ [X-RAY PROOF] ${name}: EVM Simülasyonu kusursuz!`);
        return { success: true };
    } catch (e: any) {
        const errMsg = (e.shortMessage || e.message || "").toLowerCase();
        let needsApproval = false;

        if (errMsg.includes('transfer_from_failed') || errMsg.includes('stf') || errMsg.includes('transferfrom failed') || errMsg.includes('allowance')) {
            needsApproval = true;
        }

        if (!needsApproval) {
            try {
                for (const token of tokensToCheck) {
                    if (token.addr && token.amt && token.addr !== TOKENS["ETH"]) {
                        const safeAddr = token.addr.toLowerCase() as `0x${string}`;
                        const allowance = await publicClient.readContract({ address: safeAddr, abi: erc20Abi, functionName: 'allowance', args: [user as `0x${string}`, router] });
                        if (allowance < BigInt(token.amt)) needsApproval = true;
                    }
                }
            } catch (err) {}
        }

        if (needsApproval) {
            console.log(`⚠️ [X-RAY DEDEKTİFİ] ${name}: İşlem onayı bekliyor (Allowance). Mantıksal rota doğru.`);
            return { success: true };
        }
        
        console.log(`❌ [X-RAY SIMULATION FAILED] ${name} -> Reason: ${e.shortMessage || "Reverted"}`);
        return { success: false, error: e };
    }
}
