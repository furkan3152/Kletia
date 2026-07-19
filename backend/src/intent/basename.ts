import { parseAbi, encodeFunctionData } from 'viem';
import { ParsedIntent } from '../ai/parser.js';
import { publicClient } from '../config/client.js';

export const BASENAMES_REGISTRAR = "0xa7d2607c6BD39Ae9521e514026CBB078405Ab322";
export const L2_RESOLVER_ADDRESS = "0x426fA03fB86E510d0Dd9F70335Cf102a98b10875";

const registrarAbi = parseAbi([
    "function registerPrice(string name, uint256 duration) view returns (uint256)",
    "function available(string name) view returns (bool)",
    "function register((string name, address owner, uint256 duration, address resolver, bytes[] data, bool reverseRecord) request) payable",
    "function renew(string name, uint256 duration) payable"
]);

export async function handleBaseName(intent: ParsedIntent, userAddress: string) {
    if (!intent.tokenIn) throw new Error("🚨 Base Name belirtilmedi.");
    let name = intent.tokenIn.replace(".base.eth", "").toLowerCase();
    const durationSeconds = BigInt(intent.durationInDays || 365) * 86400n;

    // Müsaitlik kontrolü yap
    const isAvailable = await publicClient.readContract({
        address: BASENAMES_REGISTRAR,
        abi: registrarAbi,
        functionName: "available",
        args: [name]
    });

    if (intent.action === 'basename_register' && !isAvailable) {
        throw new Error(`🚨 Sorry, the name **${name}.base.eth** is already taken by someone else.`);
    }
    
    if (intent.action === 'basename_renew' && isAvailable) {
        throw new Error(`🚨 **${name}.base.eth** ismi henüz alınmamış ki süresini uzatayım! Önce satın alman gerekiyor.`);
    }

    // Fiyatı al (hem register hem renew aynı fiyat tarifesini kullanır)
    const price = await publicClient.readContract({
        address: BASENAMES_REGISTRAR,
        abi: registrarAbi,
        functionName: "registerPrice",
        args: [name, durationSeconds]
    });

    let calldata: `0x${string}`;
    let expectedOutput = "";

    if (intent.action === 'basename_register') {
        calldata = encodeFunctionData({
            abi: registrarAbi,
            functionName: "register",
            args: [{
                name,
                owner: userAddress as `0x${string}`,
                duration: durationSeconds,
                resolver: L2_RESOLVER_ADDRESS as `0x${string}`,
                data: [], // Basit kurulum için boş data
                reverseRecord: false // Şimdilik reverse record kurmuyoruz
            }]
        });
        const valInEth = Number(price) / 1e18;
        expectedOutput = `✅ ${name}.base.eth ismini ${intent.durationInDays} günlüğüne ${valInEth.toFixed(4)} ETH ödeyerek satın alacaksın.`;
    } else {
        calldata = encodeFunctionData({
            abi: registrarAbi,
            functionName: "renew",
            args: [name, durationSeconds]
        });
        const valInEth = Number(price) / 1e18;
        expectedOutput = `⏳ ${name}.base.eth isminin süresini ${intent.durationInDays} günlüğüne ${valInEth.toFixed(4)} ETH ödeyerek uzatacaksın.`;
    }

    return {
        status: "success",
        winner: "Base Name Registrar",
        expectedOutput,
        routePath: [intent.action === 'basename_register' ? "Register Base Name" : "Renew Base Name"],
        targetContract: BASENAMES_REGISTRAR,
        calldata,
        tokenInAddress: "Native ETH",
        amountInWei: price.toString(),
        isNativeIn: true,
        value: price.toString(),
        allRoutes: [{
            protocol: 'Base Name Registrar',
            router: BASENAMES_REGISTRAR,
            calldata: calldata
        }],
        winnerMessage: `🏆 **Kletia BNS Modülü Hazır!**\n✨ **Sonuç:** ${expectedOutput}\n\n> İşlemi senin için hazırladım, aşağıdaki konsoldan imzalayabilirsin.`
    };
}
