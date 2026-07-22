import { parseUnits, erc20Abi, encodeFunctionData, getAddress } from 'viem';
import type { ParsedIntent } from '../ai/parser.js'; 
import { publicClient } from '../config/client.js';
import { getPortfolio } from '../portfolio/viewer.js';
import { handleBaseName } from './basename.js';
import { handleTokenDeployment } from '../creator/token.js';
import { handleNftMint } from '../creator/nft.js';

import { resolveBasename } from './utils.js';
import { applyKletiaFee } from './fee_manager.js';
import { xRaySimulate } from './security.js';
import { 
    handleSmartSwap, 
    handleDeFiBanking, 
    handleStaking, 
    handleLiquidStaking, 
    handleLiquidity, 
    handleBridge 
} from './handlers.js';

import KletiaSmartRouterABI from './KletiaSmartRouter.abi.json' with { type: 'json' };
import { io } from '../index.js';



const KLETIA_ROUTER_ADDRESS = getAddress("0x8214b00F49Da60684ce4B2C0b16dDB8a29d777cf"); 
const KLETIA_ROUTER_ABI = KletiaSmartRouterABI;


export function emitAgentLog(userAddress: string, msgId: string, log: string) {
    console.log(`[AGENT LOG] ${userAddress}: ${log}`);
    io.emit('agentLog', { userAddress, msgId, log });
}


export async function handleAlloraPrediction(asset: string, userAddress: string) {
    const apiKey = process.env.ALLORA_API_KEY;
    if (!apiKey) throw new Error("Allora API Key is missing.");
    
    emitAgentLog(userAddress, "sys", `Fetching 5-minute prediction for ${asset} from Allora...`);
    
    const response = await fetch(`https://api.allora.network/v2/allora/consumer/price/ethereum-11155111/${asset}/5m`, {
        method: 'GET',
        headers: { 'accept': 'application/json', 'x-api-key': apiKey }
    });
    
    const data = await response.json();
    if (!response.ok) throw new Error("Failed to connect to Allora Network.");
    
    const predictedPrice = data?.data?.inference_data?.network_inference_normalized || data?.inference_data?.network_inference_normalized;
    const priceFloat = parseFloat(predictedPrice);
    
    let advice = "";
    if (priceFloat > 0) {
        advice = `🔮 Allora Network's 5-minute prediction for **${asset}**: **$${priceFloat.toFixed(2)}**\n\n💡 **Agent Recommendation:** If you think this price is higher than the current one, you can take immediate action by typing something like **"buy ${asset} with 0.1 USDC"** in the console below. If you think it will drop, you can say **"Swap my ${asset} to USDC"**.`;
    } else {
        advice = `🔮 Allora Network didn't return data for **${asset}** at the moment.`;
    }
    
    return {
        status: "success",
        action: "allora_prediction",
        winnerMessage: advice
    };
}

export async function executeKletiaEngine(intent: ParsedIntent, userAddress: string, originalPrompt: string = "", msgId: string = "") {
    try {
        if (intent.action === 'portfolio') return await getPortfolio(userAddress);
        
        if (intent.action === 'chat') {
            return { status: "question", message: intent.message };
        }
        
        if (intent.action === 'agent_action') {
            const bnsMatch = originalPrompt.match(/([a-zA-Z0-9-]+\.base(\.eth)?)/);
            if (bnsMatch) {
                const bnsName = bnsMatch[1];
                const resolvedAddr = await resolveBasename(bnsName);
                if (resolvedAddr) {
                    console.log(`🔍 [BNS Resolved]: ${bnsName} -> ${resolvedAddr}`);
                    return {
                        status: "success",
                        action: 'bns_resolve',
                        winnerMessage: `Resolved BNS query from Base network! **${bnsName}** matches the wallet address **${resolvedAddr}**.`
                    };
                }
            }
            return {
                status: "success",
                action: 'agent_action',
                winnerMessage: intent.message || `Forwarding this request to the Kletia autonomous engine.`
            };
        }
        
        
        if (intent.action === 'allora_prediction') {
            return await handleAlloraPrediction(intent.tokenIn || "ETH", userAddress);
        }

        if (intent.action === 'open_widget') {
            return {
                status: "success",
                action: "open_widget",
                widgetTarget: intent.tokenIn,
                winnerMessage: intent.message || "İlgili modülü açıyorum..."
            };
        }


        let action = intent.action.toLowerCase();
        if (action === 'addliquidity') action = 'add_liquidity';
        if (action === 'removeliquidity') action = 'remove_liquidity';
        if (action === 'liquidstake') action = 'liquid_stake';
        if (action === 'liquidunstake') action = 'liquid_unstake';

        const originalGrossAmountStr = intent.amount || "0";

        const { netAmountStr, feeData } = await applyKletiaFee(intent.tokenIn || "ETH", originalGrossAmountStr, userAddress, action);
        intent.amount = netAmountStr;
        emitAgentLog(userAddress, msgId, `🛡️ Kletia Engine başlatıldı. Action: ${action}`);

        let result: any;
        switch (action) {
            case 'swap': result = await handleSmartSwap(intent, userAddress); break;
            case 'lend': 
            case 'borrow':
            case 'repay':
            case 'withdraw': result = await handleDeFiBanking(intent, userAddress); break;
            case 'stake': result = await handleStaking(intent, userAddress); break;
            case 'liquid_stake':
            case 'liquid_unstake': result = await handleLiquidStaking(intent, userAddress); break;
            case 'add_liquidity':
            case 'remove_liquidity': result = await handleLiquidity(intent, userAddress); break;
            case 'bridge': result = await handleBridge(intent, userAddress); break;
            case 'basename_register':
            case 'basename_renew': 
                result = await handleBaseName(intent, userAddress); 
                const sim = await xRaySimulate(result.targetContract as `0x${string}`, result.calldata as `0x${string}`, userAddress, result.amountInWei, result.winner);
                if (!sim.success) {
                    throw new Error(`Ağ Kuralları İhlali: Bu işlem ağ tarafından reddediliyor. Detay: ${sim.error?.shortMessage || "Reverted"}`);
                }
                break;
            case 'deploy_token':
                emitAgentLog(userAddress, msgId, `🛠️ Token fabrikası hazırlanıyor...`);
                const tokenResult = await handleTokenDeployment(userAddress, intent.name, intent.symbol, originalGrossAmountStr);
                result = { ...tokenResult, targetContract: tokenResult.target, amountInWei: tokenResult.value.toString(), winner: "Kletia Token Factory" };
                break;
            case 'mint_nft':
                const nftResult = await handleNftMint(userAddress, intent.tokenIn, originalGrossAmountStr);
                const simNft = await xRaySimulate(nftResult.target as `0x${string}`, nftResult.calldata as `0x${string}`, userAddress, nftResult.value.toString(), "Zora NFT Mint");
                if (!simNft.success) throw new Error(`Geçersiz NFT kontratı or işlem ağ tarafından reddedildi.`);
                result = { ...nftResult, targetContract: nftResult.target, amountInWei: nftResult.value.toString(), winner: "Zora NFT Mint" };
                break;
            default: throw new Error(`Desteklenmeyen İşlem: ${intent.action}`);
        }

        emitAgentLog(userAddress, msgId, `✅ Motor işlemi tamamladı. X-Ray onayı bekleniyor...`);
        result.actionType = action;

        if (feeData && result.status === 'success' && !(result.winner && result.winner.includes('WETH Contract'))) {
            const isNative = feeData.isNative;
            const decimals = isNative ? 18 : await publicClient.readContract({ address: feeData.tokenAddress as `0x${string}`, abi: erc20Abi, functionName: 'decimals' });
            
            let grossAmountWei = 0n;
            if (originalGrossAmountStr === "0" || originalGrossAmountStr.toUpperCase() === "MAX") {
                grossAmountWei = BigInt(result.amountInWei) + BigInt(feeData.amountWei);
            } else {
                grossAmountWei = parseUnits(originalGrossAmountStr, decimals);
            }

            const targetProtocol = result.targetContract;
            const targetCalldata = result.calldata;

            let wrappedCalldata;
            if (isNative) {
                 wrappedCalldata = encodeFunctionData({
                     abi: KLETIA_ROUTER_ABI,
                     functionName: 'executeETH',
                     args: [targetProtocol as `0x${string}`, targetCalldata as `0x${string}`]
                 });
            } else {
                 wrappedCalldata = encodeFunctionData({
                     abi: KLETIA_ROUTER_ABI,
                     functionName: 'executeERC20',
                     args: [feeData.tokenAddress as `0x${string}`, grossAmountWei, targetProtocol as `0x${string}`, targetCalldata as `0x${string}`]
                 });
            }

            result.targetContract = KLETIA_ROUTER_ADDRESS;
            result.calldata = wrappedCalldata;
            result.value = isNative ? grossAmountWei.toString() : "0";
            result.amountInWei = grossAmountWei.toString(); 
            result.expectedOutput += ` (Includes %0.1 Kletia Fee)`;
        }

        return result;
    } catch (error: any) { throw new Error(error.message); }
}
