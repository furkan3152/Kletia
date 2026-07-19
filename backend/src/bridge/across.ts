import { formatUnits, encodeFunctionData, getAddress } from 'viem';
import { TOKENS } from '../config/constants.js';

const CHAIN_IDS: Record<string, number> = {
    "ethereum": 1,
    "optimism": 10,
    "arbitrum": 42161,
    "polygon": 137,
    "base": 8453
};

const DEST_TOKENS: Record<number, Record<string, string>> = {
    1: {
        "USDC": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        "WETH": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        "ETH": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" // ETH wraps to WETH on output or unwraps
    },
    42161: {
        "USDC": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        "WETH": "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
        "ETH": "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"
    },
    10: {
        "USDC": "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
        "WETH": "0x4200000000000000000000000000000000000006",
        "ETH": "0x4200000000000000000000000000000000000006"
    }
};

const DEPOSIT_V3_ABI = [
    {
        "inputs": [
            { "internalType": "address", "name": "depositor", "type": "address" },
            { "internalType": "address", "name": "recipient", "type": "address" },
            { "internalType": "address", "name": "inputToken", "type": "address" },
            { "internalType": "address", "name": "outputToken", "type": "address" },
            { "internalType": "uint256", "name": "inputAmount", "type": "uint256" },
            { "internalType": "uint256", "name": "outputAmount", "type": "uint256" },
            { "internalType": "uint256", "name": "destinationChainId", "type": "uint256" },
            { "internalType": "address", "name": "exclusiveRelayer", "type": "address" },
            { "internalType": "uint32", "name": "quoteTimestamp", "type": "uint32" },
            { "internalType": "uint32", "name": "fillDeadline", "type": "uint32" },
            { "internalType": "uint32", "name": "exclusivityDeadline", "type": "uint32" },
            { "internalType": "bytes", "name": "message", "type": "bytes" }
        ],
        "name": "depositV3",
        "outputs": [],
        "stateMutability": "payable",
        "type": "function"
    }
];

export async function getAcrossBridgeRoutes(
    tokenAddress: `0x${string}`, 
    tokenSymbol: string, 
    amountInWei: bigint, 
    destinationChainStr: string,
    userAddress: string,
    decimals: number,
    isNative: boolean
) {
    const destId = CHAIN_IDS[destinationChainStr.toLowerCase()];
    if (!destId) throw new Error(`Desteklenmeyen Hedef Ağ: ${destinationChainStr}. Lütfen Ethereum, Arbitrum or Optimism seçin.`);

    let outTokenAddress = DEST_TOKENS[destId]?.[tokenSymbol.toUpperCase()];
    if (!outTokenAddress) {
        // Fallback to same address if it's a standard token
        outTokenAddress = tokenAddress;
    }

    const originId = 8453; // Base
    const url = `https://across.to/api/suggested-fees?originChainId=${originId}&destinationChainId=${destId}&token=${tokenAddress}&amount=${amountInWei.toString()}`;
    
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Across Protocol API hatası: ${res.statusText}`);
    }
    const data = await res.json();
    
    const spokePoolAddress = data.spokePoolAddress;
    const totalRelayFee = BigInt(data.totalRelayFee.total);
    const outputAmount = amountInWei - totalRelayFee;
    const quoteTimestamp = Number(data.timestamp);

    if (outputAmount <= 0n) throw new Error(`Miktar, köprüleme ücretlerini (${formatUnits(totalRelayFee, decimals)}) karşılamak için çok küçük.`);

    const fillDeadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour
    const exclusiveRelayer = data.exclusiveRelayer || "0x0000000000000000000000000000000000000000";
    const exclusivityDeadline = data.exclusivityDeadline || 0;

    const calldata = encodeFunctionData({
        abi: DEPOSIT_V3_ABI,
        functionName: 'depositV3',
        args: [
            userAddress as `0x${string}`, // depositor
            userAddress as `0x${string}`, // recipient
            tokenAddress,                 // inputToken
            getAddress(outTokenAddress),  // outputToken
            amountInWei,
            outputAmount,
            BigInt(destId),
            exclusiveRelayer as `0x${string}`,
            quoteTimestamp,
            fillDeadline,
            exclusivityDeadline,
            "0x" // message
        ]
    });

    const routeName = `Across V3 Bridge`;
    const expectedOutput = `${formatUnits(outputAmount, decimals)} ${tokenSymbol.toUpperCase()} (${destinationChainStr.toUpperCase()} ağında)`;
    const routePath = `Base -> ${destinationChainStr.toUpperCase()}`;

    return [{
        name: routeName,
        expectedOutput,
        routePath,
        router: getAddress(spokePoolAddress),
        calldata,
        value: isNative ? amountInWei.toString() : "0"
    }];
}
