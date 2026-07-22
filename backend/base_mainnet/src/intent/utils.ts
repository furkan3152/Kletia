import { namehash, normalize } from 'viem/ens';
import { publicClient } from '../config/client.js';
import { TOKENS, ROUTERS } from '../config/constants.js';
import { getAddress } from 'viem';

export const getAddressSafe = (tokenSymbol: string | undefined): `0x${string}` | undefined => {
    if (!tokenSymbol) return undefined;
    const clean = tokenSymbol.trim();
    if (clean.startsWith("0x") || clean.startsWith("0X")) {
        try {
            return getAddress(clean.toLowerCase()) as `0x${string}`;
        } catch {
            return undefined;
        }
    }
    return TOKENS[clean.toUpperCase()] as `0x${string}`;
};

export async function resolveBasename(name: string): Promise<string | null> {
    if (!name || (!name.endsWith('.base') && !name.endsWith('.base.eth'))) return null;
    
    let normalizedName = name.trim().toLowerCase();
    if (normalizedName.endsWith('.base')) {
        normalizedName = normalizedName + '.eth';
    }

    try {
        const node = namehash(normalize(normalizedName));
        const L2Resolver = ROUTERS.BNS_RESOLVER;
        const addr = await publicClient.readContract({
            address: L2Resolver,
            abi: [{"inputs":[{"internalType":"bytes32","name":"node","type":"bytes32"}],"name":"addr","outputs":[{"internalType":"address payable","name":"","type":"address"}],"stateMutability":"view","type":"function"}],
            functionName: 'addr',
            args: [node]
        });
        
        if (addr && addr !== "0x0000000000000000000000000000000000000000") {
            return addr as string;
        }
    } catch (e) {
        console.error("BNS Resolution Error:", e);
    }
    return null;
}
