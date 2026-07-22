import { parseUnits, erc20Abi, encodeFunctionData, getAddress } from 'viem';
import type { ParsedIntent } from '../ai/parser.js'; 
import { publicClient } from '../config/client.js';
import { getPortfolio } from '../portfolio/viewer.js';
import { io } from '../index.js';
import { dispatchArcAction } from './arc_handlers.js';
import KletiaSmartRouterABI from './KletiaSmartRouter.abi.json' with { type: 'json' };



const KLETIA_ROUTER_ADDRESS = getAddress("0x8214b00F49Da60684ce4B2C0b16dDB8a29d777cf"); 
const KLETIA_ROUTER_ABI = KletiaSmartRouterABI;


export function emitAgentLog(userAddress: string, msgId: string, log: string) {
    console.log(`[AGENT LOG] ${userAddress}: ${log}`);
    io.emit('agentLog', { userAddress, msgId, log });
}


export async function executeKletiaEngine(intent: ParsedIntent, userAddress: string, originalPrompt: string = "", msgId: string = "") {
    try {
        if (intent.action === 'portfolio') return await getPortfolio(userAddress);
        
        if (intent.action === 'chat') {
            return { status: "question", message: intent.message };
        }
        
        if (intent.action === 'agent_action') {
            return {
                status: "success",
                action: 'agent_action',
                winnerMessage: intent.message || `Forwarding this request to the Kletia autonomous engine.`
            };
        }
        
        if (intent.action === 'open_widget') {
            return {
                status: "success",
                action: "open_widget",
                widgetTarget: intent.tokenIn,
                winnerMessage: intent.message || "İlgili modülü açıyorum..."
            };
        }

        // ✨ ARC NETWORK İŞLEMLERİ
        emitAgentLog(userAddress, msgId, `🛡️ ARC Engine devrede. İşlem hazırlanıyor: ${intent.action}`);
        try {
            const arcResult = await dispatchArcAction(intent, userAddress);
            return { ...arcResult, actionType: intent.action };
        } catch (err: any) {
            console.error("❌ ARC ENGINE GİZLİ HATA:", err);
            if (err.message && err.message.includes("Arc X-Ray")) {
                throw err; // Simülasyon hatasını fırlat ki frontend görebilsin
            }
            // Eğer Arc handler bulamazsa default olarak widget a yönlendir
            let arcSubTarget = "vault"; // default
            if (intent.action.includes("stake")) arcSubTarget = "staking";
            else if (intent.action.includes("swap")) arcSubTarget = "swap";
            else if (intent.action.includes("lending") || intent.action.includes("borrow")) arcSubTarget = "lending";

            return {
                status: "success",
                action: "open_widget",
                arcAction: intent.action,
                amount: intent.amount,
                tokenIn: intent.tokenIn,
                tokenOut: intent.tokenOut,
                name: intent.name,
                widgetTarget: "arc",
                subTarget: arcSubTarget,
                winnerMessage: err.message || intent.message || "Arc ağında işlemi widget üzerinden yapabilirsiniz..."
            };
        }
    } catch (error: any) { throw new Error(error.message); }
}
