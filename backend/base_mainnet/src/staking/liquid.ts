// backend/src/staking/liquid.ts
// Liquid Staking Derivatives (LSD) modülü — Base mainnet
// Lido wstETH, Rocket Pool rETH, Coinbase cbETH
// Base üzerinde bu tokenlar köprülenmiş ERC20'dir; stake/unstake DEX swap ile yapılır.

import { encodeFunctionData, parseUnits, formatUnits, erc20Abi, getAddress } from 'viem';
import { publicClient } from '../config/client.js';
import { TOKENS } from '../config/constants.js';

// ─── Resmi Base mainnet LSD token adresleri ───
const LSD_TOKENS = {
    wstETH: getAddress("0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452"),
    cbETH:  getAddress("0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22"),
    rETH:   getAddress("0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c"),
} as const;

// ─── Protokol meta verileri ───
const PROTOCOL_META: Record<string, { name: string; symbol: string; tokenAddress: `0x${string}` }> = {
    wstETH: { name: "Lido (wstETH)",        symbol: "wstETH", tokenAddress: LSD_TOKENS.wstETH },
    cbETH:  { name: "Coinbase (cbETH)",      symbol: "cbETH",  tokenAddress: LSD_TOKENS.cbETH  },
    rETH:   { name: "Rocket Pool (rETH)",    symbol: "rETH",   tokenAddress: LSD_TOKENS.rETH   },
};

// ─── WETH adresi (ETH tarafı için kullanılır) ───
const WETH = TOKENS["WETH"];

/**
 * Liquid staking rotalarını üretir.
 *
 * liquid_stake  → ETH'yi wstETH / cbETH / rETH'e swap eder (DEX üzerinden)
 * liquid_unstake → wstETH / cbETH / rETH'i ETH'ye geri swap eder
 *
 * @param action          - 'liquid_stake' or 'liquid_unstake'
 * @param tokenSymbol     - Hedef LSD token sembolü (ör. 'wstETH', 'cbETH', 'rETH') or 'all'
 * @param amountStr       - Miktar (insanca okunur string, ör. '0.5')
 * @param userAddress     - Kullanıcının cüzdan adresi
 * @param requestedProtocol - Opsiyonel; sadece belirli bir protokol rotası döndürülür
 */
export async function getLiquidStakingRoutes(
    action: 'liquid_stake' | 'liquid_unstake',
    tokenSymbol: string,
    amountStr: string,
    userAddress: string,
    requestedProtocol?: string
) {
    const safeUser = getAddress(userAddress) as `0x${string}`;

    // ─── LIQUID STAKE: ETH → LSD token ───
    if (action === 'liquid_stake') {
        // Kullanıcının ETH (WETH) bakiyesini oku
        const ethBalance = await publicClient.getBalance({ address: safeUser });
        const amountInWei = parseUnits(amountStr || "0", 18);

        if (amountInWei <= 0n || ethBalance < amountInWei) {
            throw new Error(`❌ Yetersiz ETH bakiyesi! Mevcut: ${formatUnits(ethBalance, 18)} ETH`);
        }

        const formattedAmount = formatUnits(amountInWei, 18);

        // Hangi protokollere rota üretilecek belirlenir
        const targetKeys = resolveTargetKeys(tokenSymbol);

        const rawRoutes = targetKeys.map(key => {
            const meta = PROTOCOL_META[key];
            return {
                name: meta.name,
                amount: amountInWei,
                expectedOutput: `${formattedAmount} ETH ➝ ${meta.symbol} (DEX swap ile)`,
                routePath: `ETH ➝ [DEX Swap] ➝ ${meta.symbol}`,
                router: meta.tokenAddress,              // Hedef LSD token adresi
                calldata: '0x0' as `0x${string}`,       // Gerçek calldata DEX modülünden gelir
                primaryTokenAddress: WETH,               // Kaynak token
                primaryAmountInWei: amountInWei,
                value: amountInWei,                      // Native ETH gönderilir
            };
        });

        // Protokol filtresi varsa uygula
        if (requestedProtocol) {
            return rawRoutes.filter(r =>
                r.name.toLowerCase().includes(requestedProtocol.toLowerCase().replace(/\s+/g, ''))
            );
        }
        return rawRoutes;
    }

    // ─── LIQUID UNSTAKE: LSD token → ETH ───
    if (action === 'liquid_unstake') {
        const targetKeys = resolveTargetKeys(tokenSymbol);
        const rawRoutes: any[] = [];

        for (const key of targetKeys) {
            const meta = PROTOCOL_META[key];

            // LSD token bakiyesini oku
            const tokenBalance = await publicClient.readContract({
                address: meta.tokenAddress,
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [safeUser],
            });

            // Token decimal bilgisini oku
            const decimals = await publicClient.readContract({
                address: meta.tokenAddress,
                abi: erc20Abi,
                functionName: 'decimals',
            });

            // Miktar belirtilmişse parse et, yoksa tüm bakiyeyi kullan
            let amountInWei: bigint;
            if (amountStr && amountStr !== '0') {
                amountInWei = parseUnits(amountStr, decimals);
            } else {
                amountInWei = tokenBalance;
            }

            if (amountInWei <= 0n || tokenBalance < amountInWei) {
                // Bakiye yoksa bu protokol için rota ekleme, diğerlerine devam et
                continue;
            }

            const formattedAmount = formatUnits(amountInWei, decimals);

            rawRoutes.push({
                name: meta.name,
                amount: amountInWei,
                expectedOutput: `${formattedAmount} ${meta.symbol} ➝ ETH (DEX swap ile)`,
                routePath: `${meta.symbol} ➝ [DEX Swap] ➝ ETH`,
                router: meta.tokenAddress,              // Kaynak LSD token adresi
                calldata: '0x0' as `0x${string}`,       // Gerçek calldata DEX modülünden gelir
                primaryTokenAddress: meta.tokenAddress,  // Kaynak token
                primaryAmountInWei: amountInWei,
                value: 0n,                               // Token swap, native ETH gönderilmez
            });
        }

        // Protokol filtresi varsa uygula
        if (requestedProtocol) {
            return rawRoutes.filter(r =>
                r.name.toLowerCase().includes(requestedProtocol.toLowerCase().replace(/\s+/g, ''))
            );
        }
        return rawRoutes;
    }

    throw new Error(`🚨 Geçersiz aksiyon: ${action}. 'liquid_stake' or 'liquid_unstake' olmalı.`);
}

/**
 * Kullanıcının LSD pozisyonlarını getirir.
 * wstETH, cbETH ve rETH bakiyelerini okur.
 *
 * @param userAddress - Cüzdan adresi
 * @returns Pozisyon dizisi: { protocol, symbol, balance, formatted, tokenAddress }
 */
export async function getLiquidStakingPositions(userAddress: string) {
    const safeUser = getAddress(userAddress) as `0x${string}`;

    const positions: {
        protocol: string;
        symbol: string;
        balance: bigint;
        formatted: string;
        tokenAddress: `0x${string}`;
    }[] = [];

    // Tüm LSD tokenları için bakiye sorgula (multicall ile hızlı)
    for (const [key, meta] of Object.entries(PROTOCOL_META)) {
        try {
            const [balance, decimals] = await Promise.all([
                publicClient.readContract({
                    address: meta.tokenAddress,
                    abi: erc20Abi,
                    functionName: 'balanceOf',
                    args: [safeUser],
                }),
                publicClient.readContract({
                    address: meta.tokenAddress,
                    abi: erc20Abi,
                    functionName: 'decimals',
                }),
            ]);

            positions.push({
                protocol: meta.name,
                symbol: meta.symbol,
                balance,
                formatted: formatUnits(balance, decimals),
                tokenAddress: meta.tokenAddress,
            });
        } catch (e: any) {
            // Token okunamazsa atla, hata fırlatma
            console.warn(`⚠️ ${meta.symbol} bakiyesi okunamadı: ${e.message}`);
        }
    }

    return positions;
}

// ─── Yardımcı: Hedef token key'lerini çöz ───
function resolveTargetKeys(tokenSymbol: string): string[] {
    const upper = tokenSymbol.toUpperCase();

    // 'all' or boş ise tüm protokolleri döndür
    if (!tokenSymbol || upper === 'ALL' || upper === 'ETH') {
        return Object.keys(PROTOCOL_META);
    }

    // Spesifik sembol eşleştirme
    const match = Object.keys(PROTOCOL_META).find(
        k => k.toUpperCase() === upper || PROTOCOL_META[k].symbol.toUpperCase() === upper
    );

    if (!match) {
        throw new Error(`🚨 Desteklenmeyen LSD token: ${tokenSymbol}. Desteklenen: wstETH, cbETH, rETH`);
    }

    return [match];
}
