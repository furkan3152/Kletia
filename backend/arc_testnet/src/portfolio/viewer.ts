// backend/src/portfolio/viewer.ts
// ✨ KLETIA OMNI-PORTFOLIO: Kapsamlı DeFi Portföy Tarayıcısı
// Base ağındaki tüm varlıkları, DeFi pozisyonlarını, LST'leri, BNS isimlerini ve geçmiş işlemleri tarar.
import { formatUnits, erc20Abi, getAddress } from 'viem';
import { publicClient } from '../config/client.js';
import { TOKENS } from '../config/constants.js';

// ===================== RESMİ KONTRAT ADRESLERİ =====================

// AAVE V3 Pool (Base Mainnet)
const AAVE_POOL = getAddress("0xA238Dd80C259a72e81d7e4664a9801593F98d1c5");
// Aerodrome veAERO (Oylama Kilidi)
const VE_AERO = getAddress("0xeBf418Fe2512e7E6bd9b87a8F0f294aCDC67e6B4");
// Moonwell mToken'ları (Compound V2 fork)
const MOONWELL_MUSDC = getAddress("0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22");
const MOONWELL_MWETH = getAddress("0x628fF693d22751d3691740560FcFec11E03A3a95");
// Likit Staking Token'ları (LST)
const WSTETH = getAddress("0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452");
const CBETH  = getAddress("0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22");
const RETH   = getAddress("0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c");
// Base Name Service (BNS) ERC-721 (Basenames)
const BNS_NFT = getAddress("0x03c4738Ee98aE44591e1A4A4F3CaB6641d95DD9a");
// Compound V3 Comet (USDC Market)
const COMPOUND_COMET = getAddress("0x9c4ec768c28520B5086047a155f44376213a9f58");

// ===================== ABI TANIMLAMALARI =====================

const AAVE_ACCOUNT_ABI = [{ "inputs": [{ "internalType": "address", "name": "user", "type": "address" }], "name": "getUserAccountData", "outputs": [{ "internalType": "uint256", "name": "totalCollateralBase", "type": "uint256" }, { "internalType": "uint256", "name": "totalDebtBase", "type": "uint256" }, { "internalType": "uint256", "name": "availableBorrowsBase", "type": "uint256" }, { "internalType": "uint256", "name": "currentLiquidationThreshold", "type": "uint256" }, { "internalType": "uint256", "name": "ltv", "type": "uint256" }, { "internalType": "uint256", "name": "healthFactor", "type": "uint256" }], "stateMutability": "view", "type": "function" }] as const;

const VE_AERO_ABI = [
    { "inputs": [{ "internalType": "address", "name": "owner", "type": "address" }], "name": "balanceOf", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" },
    { "inputs": [{ "internalType": "address", "name": "owner", "type": "address" }, { "internalType": "uint256", "name": "index", "type": "uint256" }], "name": "tokenOfOwnerByIndex", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" },
    { "inputs": [{ "internalType": "uint256", "name": "_tokenId", "type": "uint256" }], "name": "locked", "outputs": [{ "internalType": "int128", "name": "amount", "type": "int128" }, { "internalType": "uint256", "name": "end", "type": "uint256" }], "stateMutability": "view", "type": "function" },
    { "inputs": [{ "internalType": "uint256", "name": "_tokenId", "type": "uint256" }], "name": "balanceOfNFT", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" }
] as const;

// Compound V3 Comet: borrowBalanceOf ve collateralBalanceOf
const COMET_ABI = [
    { "inputs": [{ "internalType": "address", "name": "account", "type": "address" }], "name": "borrowBalanceOf", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" },
    { "inputs": [{ "internalType": "address", "name": "account", "type": "address" }, { "internalType": "address", "name": "asset", "type": "address" }], "name": "collateralBalanceOf", "outputs": [{ "internalType": "uint128", "name": "", "type": "uint128" }], "stateMutability": "view", "type": "function" },
    { "inputs": [{ "internalType": "address", "name": "account", "type": "address" }], "name": "balanceOf", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" }
] as const;

// Moonwell mToken borç okuma
const MOONWELL_DEBT_ABI = [
    { "inputs": [{ "internalType": "address", "name": "account", "type": "address" }], "name": "borrowBalanceStored", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" },
    { "inputs": [{ "internalType": "address", "name": "account", "type": "address" }], "name": "balanceOfUnderlying", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" }
] as const;

// BNS (ERC-721) ABI
const BNS_ABI = [
    { "inputs": [{ "internalType": "address", "name": "owner", "type": "address" }], "name": "balanceOf", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" },
    { "inputs": [{ "internalType": "address", "name": "owner", "type": "address" }, { "internalType": "uint256", "name": "index", "type": "uint256" }], "name": "tokenOfOwnerByIndex", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "stateMutability": "view", "type": "function" }
] as const;

// ===================== YARDIMCI FONKSİYONLAR =====================

const WETH_ADDRESS = "0x4200000000000000000000000000000000000006";

async function fetchPrices(addresses: string[]): Promise<Record<string, number>> {
    const priceMap: Record<string, number> = {};
    for (let i = 0; i < addresses.length; i += 30) {
        const chunk = addresses.slice(i, i + 30).join(',');
        try {
            const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${chunk}`);
            const json = await res.json();
            if (json?.pairs) {
                for (const pair of json.pairs) {
                    const addr = pair.baseToken.address.toLowerCase();
                    if (!priceMap[addr]) priceMap[addr] = parseFloat(pair.priceUsd || "0");
                }
            }
        } catch (e) {}
    }
    return priceMap;
}

async function safeReadContract<T>(params: any, fallback: T): Promise<T> {
    try { return await publicClient.readContract(params) as T; } catch { return fallback; }
}

// ===================== ANA PORTFÖY FONKSİYONU =====================

export async function getPortfolio(userAddress: string) {
    console.log(`\n══════════════════════════════════════════════`);
    console.log(`💼 [KLETIA OMNI-PORTFOLIO] Deep scan başlatılıyor...`);
    console.log(`   Cüzdan: ${userAddress}`);
    console.log(`══════════════════════════════════════════════`);

    const user = userAddress as `0x${string}`;
    const tokenAddressesToPrice = new Set<string>();

    // ═══════════════════════════════════════════
    // 1. CÜZDAN BAKİYELERİ (Wallet Assets)
    // ═══════════════════════════════════════════
    console.log(`\n📦 [1/8] Cüzdan tokenleri taranıyor...`);
    const wallet: { symbol: string; name?: string; balance: string; formatted: string; usdValue?: number; usdFormatted?: string; address?: string }[] = [];

    const ethBalance = await publicClient.getBalance({ address: user });
    if (ethBalance > 0n) {
        wallet.push({ symbol: "ETH", name: "Ethereum", balance: ethBalance.toString(), formatted: parseFloat(formatUnits(ethBalance, 18)).toFixed(6) });
        tokenAddressesToPrice.add(WETH_ADDRESS.toLowerCase());
    }

    // Alchemy ile tüm ERC-20 bakiyeleri
    try {
        const alchemyUrl = `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
        const response = await fetch(alchemyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "alchemy_getTokenBalances", params: [userAddress, "erc20"] })
        });
        const json = await response.json();
        if (json.result?.tokenBalances) {
            const balances = json.result.tokenBalances.filter((t: any) => BigInt(t.tokenBalance) > 0n);
            await Promise.all(balances.map(async (t: any) => {
                const addr = t.contractAddress.toLowerCase();
                const balWei = BigInt(t.tokenBalance);
                tokenAddressesToPrice.add(addr);
                try {
                    const [symbol, name, decimals] = await Promise.all([
                        publicClient.readContract({ address: t.contractAddress as `0x${string}`, abi: erc20Abi, functionName: 'symbol' }),
                        publicClient.readContract({ address: t.contractAddress as `0x${string}`, abi: erc20Abi, functionName: 'name' }),
                        publicClient.readContract({ address: t.contractAddress as `0x${string}`, abi: erc20Abi, functionName: 'decimals' })
                    ]);
                    wallet.push({ symbol: symbol || "?", name: name || "Unknown", balance: balWei.toString(), formatted: parseFloat(formatUnits(balWei, decimals)).toFixed(6), address: addr });
                } catch {}
            }));
        }
    } catch (e) { console.error("Alchemy hata:", e); }
    console.log(`   ✅ ${wallet.length} token bulundu.`);

    // ═══════════════════════════════════════════
    // 2. LİKİT STAKİNG POZİSYONLARI (LST)
    // ═══════════════════════════════════════════
    console.log(`\n🥩 [2/8] Likit Staking pozisyonları taranıyor...`);
    const liquidStaking: { protocol: string; symbol: string; balance: string; formatted: string; tokenAddress: string; usdValue?: number; usdFormatted?: string }[] = [];

    const lstTokens = [
        { protocol: "Lido", symbol: "wstETH", address: WSTETH, decimals: 18 },
        { protocol: "Coinbase", symbol: "cbETH", address: CBETH, decimals: 18 },
        { protocol: "Rocket Pool", symbol: "rETH", address: RETH, decimals: 18 }
    ];

    for (const lst of lstTokens) {
        const bal = await safeReadContract<bigint>({ address: lst.address, abi: erc20Abi, functionName: 'balanceOf', args: [user] }, 0n);
        if (bal > 0n) {
            tokenAddressesToPrice.add(lst.address.toLowerCase());
            liquidStaking.push({
                protocol: lst.protocol, symbol: lst.symbol,
                balance: bal.toString(), formatted: parseFloat(formatUnits(bal, lst.decimals)).toFixed(6),
                tokenAddress: lst.address
            });
        }
    }
    console.log(`   ✅ ${liquidStaking.length} LST pozisyonu bulundu.`);

    // ═══════════════════════════════════════════
    // 3. BASE NAME SERVİCE (BNS) İSİMLERİ
    // ═══════════════════════════════════════════
    console.log(`\n🏷️ [3/8] Base Name Service (BNS) isimleri taranıyor...`);
    const baseNames: { tokenId: string; name?: string; index: number }[] = [];
    try {
        const alchemyNftUrl = `https://base-mainnet.g.alchemy.com/nft/v3/${process.env.ALCHEMY_API_KEY}/getNFTsForOwner?owner=${user}&contractAddresses[]=${BNS_NFT}&withMetadata=true`;
        const res = await fetch(alchemyNftUrl);
        const json = await res.json();
        if (json.ownedNfts) {
            for (let i = 0; i < json.ownedNfts.length; i++) {
                const nft = json.ownedNfts[i];
                baseNames.push({
                    tokenId: BigInt(nft.tokenId).toString(),
                    name: nft.name || nft.contract.name,
                    index: i
                });
            }
        }
    } catch (e) {
        console.log("BNS Error:", e);
    }
    console.log(`   ✅ ${baseNames.length} Base Name bulundu.`);

    // ═══════════════════════════════════════════
    // 4. AAVE V3 POZİSYONLARI
    // ═══════════════════════════════════════════
    console.log(`\n🏦 [4/8] Aave V3 pozisyonları taranıyor...`);
    const defiPositions: any = {};
    try {
        const aaveData = await publicClient.readContract({ address: AAVE_POOL, abi: AAVE_ACCOUNT_ABI, functionName: 'getUserAccountData', args: [user] }) as unknown as any[];
        const collateral = parseFloat(formatUnits(aaveData[0], 8));
        const debt = parseFloat(formatUnits(aaveData[1], 8));
        const availableBorrow = parseFloat(formatUnits(aaveData[2], 8));
        const hf = Number(aaveData[5]);

        if (collateral > 0 || debt > 0) {
            defiPositions.aave = {
                suppliedCollateralUSD: `$${collateral.toFixed(2)}`,
                totalDebtUSD: `$${debt.toFixed(2)}`,
                availableBorrowPowerUSD: `$${availableBorrow.toFixed(2)}`,
                healthFactor: hf > 1e15 ? "∞ (Borçsuz)" : parseFloat(formatUnits(BigInt(hf), 18)).toFixed(2),
                status: hf > 1e15 ? "SAFE" : (parseFloat(formatUnits(BigInt(hf), 18)) > 1.5 ? "HEALTHY" : "WARNING")
            };
            console.log(`   ✅ Aave: Teminat $${collateral.toFixed(2)}, Borç $${debt.toFixed(2)}`);
        } else {
            console.log(`   ℹ️  Aave: Aktif pozisyon yok.`);
        }
    } catch {}

    // ═══════════════════════════════════════════
    // 5. MOONWELL POZİSYONLARI
    // ═══════════════════════════════════════════
    console.log(`\n🌙 [5/8] Moonwell pozisyonları taranıyor...`);
    try {
        const moonwellMarkets = [
            { name: "USDC", mToken: MOONWELL_MUSDC, decimals: 6 },
            { name: "WETH", mToken: MOONWELL_MWETH, decimals: 18 }
        ];
        const moonwellData: any = {};
        for (const market of moonwellMarkets) {
            const debt = await safeReadContract<bigint>({ address: market.mToken, abi: MOONWELL_DEBT_ABI, functionName: 'borrowBalanceStored', args: [user] }, 0n);
            const supplied = await safeReadContract<bigint>({ address: market.mToken, abi: erc20Abi, functionName: 'balanceOf', args: [user] }, 0n);
            if (debt > 0n || supplied > 0n) {
                moonwellData[market.name] = {
                    supplied: supplied > 0n ? parseFloat(formatUnits(supplied, market.decimals)).toFixed(4) + ` m${market.name}` : "0",
                    debt: debt > 0n ? parseFloat(formatUnits(debt, market.decimals)).toFixed(4) + ` ${market.name}` : "0"
                };
            }
        }
        if (Object.keys(moonwellData).length > 0) {
            defiPositions.moonwell = moonwellData;
            console.log(`   ✅ Moonwell: ${Object.keys(moonwellData).length} aktif market.`);
        } else {
            console.log(`   ℹ️  Moonwell: Aktif pozisyon yok.`);
        }
    } catch {}

    // ═══════════════════════════════════════════
    // 6. COMPOUND V3 POZİSYONLARI
    // ═══════════════════════════════════════════
    console.log(`\n🏛️ [6/8] Compound V3 pozisyonları taranıyor...`);
    try {
        const compBorrow = await safeReadContract<bigint>({ address: COMPOUND_COMET, abi: COMET_ABI, functionName: 'borrowBalanceOf', args: [user] }, 0n);
        const compSupplied = await safeReadContract<bigint>({ address: COMPOUND_COMET, abi: COMET_ABI, functionName: 'balanceOf', args: [user] }, 0n);
        if (compBorrow > 0n || compSupplied > 0n) {
            defiPositions.compound = {
                suppliedUSDC: compSupplied > 0n ? parseFloat(formatUnits(compSupplied, 6)).toFixed(2) + " USDC" : "0",
                borrowedUSDC: compBorrow > 0n ? parseFloat(formatUnits(compBorrow, 6)).toFixed(2) + " USDC" : "0"
            };
            console.log(`   ✅ Compound: Supply ${formatUnits(compSupplied, 6)}, Borrow ${formatUnits(compBorrow, 6)}`);
        } else {
            console.log(`   ℹ️  Compound: Aktif pozisyon yok.`);
        }
    } catch {}

    // ═══════════════════════════════════════════
    // 7. AERODROME veAERO KİLİT POZİSYONLARI
    // ═══════════════════════════════════════════
    console.log(`\n🔒 [7/8] Aerodrome veAERO kilitleri taranıyor...`);
    try {
        const nftBalance = await publicClient.readContract({ address: VE_AERO, abi: VE_AERO_ABI, functionName: 'balanceOf', args: [user] });
        if (nftBalance > 0n) {
            const tokenId = await publicClient.readContract({ address: VE_AERO, abi: VE_AERO_ABI, functionName: 'tokenOfOwnerByIndex', args: [user, 0n] });
            const lockedData = await publicClient.readContract({ address: VE_AERO, abi: VE_AERO_ABI, functionName: 'locked', args: [tokenId] }) as unknown as any[];
            const votingPower = await publicClient.readContract({ address: VE_AERO, abi: VE_AERO_ABI, functionName: 'balanceOfNFT', args: [tokenId] });

            const lockedAmount = formatUnits(lockedData[0], 18);
            const formattedPower = formatUnits(votingPower, 18);
            const unlockDate = new Date(Number(lockedData[1]) * 1000).toLocaleDateString('tr-TR');

            if (Number(lockedAmount) > 0) {
                defiPositions.aerodrome = {
                    lockId: tokenId.toString(),
                    lockedAmount: parseFloat(lockedAmount).toFixed(2) + " AERO",
                    votingPower: parseFloat(formattedPower).toFixed(2) + " veAERO",
                    unlockDate
                };
                console.log(`   ✅ veAERO: ${parseFloat(lockedAmount).toFixed(2)} AERO kilitli.`);
            }
        } else {
            console.log(`   ℹ️  Aerodrome: Aktif kilit yok.`);
        }
    } catch {}

    // ═══════════════════════════════════════════
    // 8. GEÇMİŞ İŞLEM GEÇMİŞİ (Son 20 TX)
    // ═══════════════════════════════════════════
    console.log(`\n📜 [8/8] Son işlem geçmişi taranıyor...`);
    const recentTransactions: { hash: string; from: string; to: string; value: string; type: string; timestamp?: string }[] = [];
    try {
        const alchemyUrl = `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;
        const txRes = await fetch(alchemyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "alchemy_getAssetTransfers", params: [{ fromBlock: "0x0", toBlock: "latest", fromAddress: userAddress, category: ["external", "erc20"], maxCount: "0x14", order: "desc" }] })
        });
        const txJson = await txRes.json();
        if (txJson.result?.transfers) {
            for (const tx of txJson.result.transfers) {
                recentTransactions.push({
                    hash: tx.hash,
                    from: tx.from,
                    to: tx.to || "Contract Creation",
                    value: `${tx.value ? parseFloat(tx.value).toFixed(6) : "0"} ${tx.asset || "ETH"}`,
                    type: tx.category === "erc20" ? "Token Transfer" : "ETH Transfer"
                });
            }
        }
    } catch {}
    console.log(`   ✅ ${recentTransactions.length} işlem bulundu.`);

    // ═══════════════════════════════════════════
    // FİYATLANDIRMA (DexScreener)
    // ═══════════════════════════════════════════
    console.log(`\n💰 Fiyatlar getiriliyor...`);
    const priceMap = await fetchPrices(Array.from(tokenAddressesToPrice));
    const ethPrice = priceMap[WETH_ADDRESS.toLowerCase()] || 0;

    // Cüzdan tokenlerine fiyat ekle
    for (const w of wallet) {
        if (w.symbol === "ETH") {
            w.usdValue = parseFloat(w.formatted) * ethPrice;
        } else {
            const price = priceMap[w.address || ""] || 0;
            w.usdValue = parseFloat(w.formatted) * price;
        }
        w.usdFormatted = w.usdValue ? `$${w.usdValue.toFixed(2)}` : "$0.00";
    }

    // LST'lere fiyat ekle
    for (const lst of liquidStaking) {
        const price = priceMap[lst.tokenAddress.toLowerCase()] || ethPrice; // LST ≈ ETH fiyatı
        lst.usdValue = parseFloat(lst.formatted) * price;
        lst.usdFormatted = lst.usdValue ? `$${lst.usdValue.toFixed(2)}` : "$0.00";
    }

    // ═══════════════════════════════════════════
    // KATEGORİZASYON (DeFi tokenleri ayır)
    // ═══════════════════════════════════════════
    const defiKeywords = /lp|vault|morpho|moonwell|staked|aave|pool|veaero|usdbc|receipt|v3|compound|comet/i;
    const finalWallet: typeof wallet = [];
    const defiTokens: typeof wallet = [];

    for (const w of wallet) {
        if (defiKeywords.test(w.name || "") || defiKeywords.test(w.symbol || "")) {
            defiTokens.push(w);
        } else {
            finalWallet.push(w);
        }
    }
    finalWallet.sort((a, b) => (b.usdValue || 0) - (a.usdValue || 0));
    defiTokens.sort((a, b) => (b.usdValue || 0) - (a.usdValue || 0));

    // ═══════════════════════════════════════════
    // TOPLAM DEĞER HESAPLAMASI
    // ═══════════════════════════════════════════
    const walletTotal = finalWallet.reduce((sum, t) => sum + (t.usdValue || 0), 0);
    const defiTokenTotal = defiTokens.reduce((sum, t) => sum + (t.usdValue || 0), 0);
    const lstTotal = liquidStaking.reduce((sum, t) => sum + (t.usdValue || 0), 0);
    const totalNetWorth = walletTotal + defiTokenTotal + lstTotal;

    // Adresleri temizle (frontend'e gönderirken gereksiz)
    for (const w of [...finalWallet, ...defiTokens]) { delete w.address; }

    console.log(`\n══════════════════════════════════════════════`);
    console.log(`🟢 [KLETIA OMNI-PORTFOLIO] Tarama tamamlandı!`);
    console.log(`   💵 Toplam Tahmini Değer: $${totalNetWorth.toFixed(2)}`);
    console.log(`══════════════════════════════════════════════`);

    return {
        status: "success",
        action: "portfolio",
        data: {
            summary: {
                totalNetWorthUSD: `$${totalNetWorth.toFixed(2)}`,
                walletValueUSD: `$${walletTotal.toFixed(2)}`,
                defiTokenValueUSD: `$${defiTokenTotal.toFixed(2)}`,
                liquidStakingValueUSD: `$${lstTotal.toFixed(2)}`
            },
            wallet: finalWallet,
            defiTokens,
            liquidStaking,
            baseNames,
            defiPositions,
            recentTransactions
        },
        expectedOutput: "Kletia Omni-Portfolio Overview",
        message: `**💼 Kletia DeFi Portföyü Tarandı.**\n` +
            `💵 Toplam Tahmini Değer: **$${totalNetWorth.toFixed(2)}**\n` +
            `📦 Cüzdan: ${finalWallet.length} token ($${walletTotal.toFixed(2)})\n` +
            `🥩 Likit Staking: ${liquidStaking.length} pozisyon ($${lstTotal.toFixed(2)})\n` +
            `🏷️ Base Names: ${baseNames.length} isim\n` +
            `🏦 DeFi Pozisyonları: ${Object.keys(defiPositions).length} protokol\n` +
            `📜 Son İşlemler: ${recentTransactions.length} tx`
    };
}