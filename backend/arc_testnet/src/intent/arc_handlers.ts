import { encodeFunctionData, parseEther } from 'viem';
import { ethers } from 'ethers';
import type { ParsedIntent } from './../ai/parser.js';
import { 
    ARC_CONTRACTS, 
    ARC_SWAP_ABI, 
    ARC_STAKING_ABI, 
    ARC_VAULT_ABI,
    ARC_MEMOTRANSFER_ABI,
    ARC_AGENTREGISTRY_ABI,
    ARC_BATCHPAY_ABI,
    ARC_LENDING_ABI
} from '../config/arcConfig.js';

const ARC_RPC_URL = "https://rpc.drpc.testnet.arc.io";

export async function handleArcSwap(intent: ParsedIntent, userAddress: string) {
    const amountIn = intent.amount || "0";
    const amountWei = parseEther(amountIn);
    const isUsdcToToken = (intent.tokenIn?.toUpperCase() === 'USDC' || intent.tokenIn === undefined);
    
    let calldata, value;
    if (isUsdcToToken) {
        calldata = encodeFunctionData({ abi: ARC_SWAP_ABI, functionName: 'swapUSDCForToken' });
        value = amountWei.toString();
    } else {
        calldata = encodeFunctionData({ abi: ARC_SWAP_ABI, functionName: 'swapTokenForUSDC', args: [amountWei] });
        value = "0";
    }

    let expectedOutStr = isUsdcToToken ? "Confirming KLET Purchase" : "Confirming KLET Sale";
    try {
        const provider = new ethers.JsonRpcProvider(ARC_RPC_URL);
        const swapContract = new ethers.Contract(ARC_CONTRACTS.Swap, ARC_SWAP_ABI, provider);
        if (isUsdcToToken) {
            const outTokens = await swapContract.previewSwapUSDCForToken(amountWei.toString());
            expectedOutStr = `Estimated Output: ${ethers.formatEther(outTokens)} KLET`;
        } else {
            const outUSDC = await swapContract.previewSwapTokenForUSDC(amountWei.toString());
            expectedOutStr = `Estimated Output: ${ethers.formatEther(outUSDC)} USDC`;
        }
    } catch (e) {
        console.log("Simulation failed:", e);
    }

    return {
        status: "success",
        action: "swap",
        amountInWei: amountWei.toString(),
        targetContract: ARC_CONTRACTS.Swap,
        calldata,
        value,
        winner: "Kletia Swap",
        expectedOutput: expectedOutStr,
        allRoutes: [{ name: "Kletia Swap", router: ARC_CONTRACTS.Swap, calldata, expectedOutput: expectedOutStr, primaryTokenAddress: isUsdcToToken ? null : ARC_CONTRACTS.Token, primaryAmountInWei: isUsdcToToken ? null : amountWei.toString() }],
        isNativeIn: isUsdcToToken,
        tokenInAddress: isUsdcToToken ? null : ARC_CONTRACTS.Token
    };
}

export async function handleArcStaking(intent: ParsedIntent, userAddress: string) {
    const amountIn = intent.amount || "0";
    const amountWei = parseEther(amountIn);
    const calldata = encodeFunctionData({ abi: ARC_STAKING_ABI, functionName: 'stake' });

    return {
        status: "success",
        action: "stake",
        amountInWei: amountWei.toString(),
        targetContract: ARC_CONTRACTS.Staking,
        calldata,
        value: amountWei.toString(),
        winner: "Kletia Staking",
        expectedOutput: "Batch Payment Complete",
        allRoutes: [{ name: "Kletia Staking", router: ARC_CONTRACTS.Staking, calldata, expectedOutput: "Stake KLET" }],
        isNativeIn: true
    };
}

export async function handleArcVault(intent: ParsedIntent, userAddress: string, isWithdraw: boolean) {
    const amountIn = intent.amount || "0";
    const amountWei = parseEther(amountIn);
    
    const calldata = encodeFunctionData({ 
        abi: ARC_VAULT_ABI, 
        functionName: isWithdraw ? 'withdraw' : 'deposit'
    });

    return {
        status: "success",
        action: isWithdraw ? "arc_vault_withdraw" : "arc_vault_deposit",
        amountInWei: isWithdraw ? "0" : amountWei.toString(),
        targetContract: ARC_CONTRACTS.Vault,
        calldata,
        value: isWithdraw ? "0" : amountWei.toString(),
        winner: "Kletia Vault",
        expectedOutput: isWithdraw ? "USDC + Yield" : "Vault Deposit",
        allRoutes: [{ name: "Kletia Vault", router: ARC_CONTRACTS.Vault, calldata, expectedOutput: isWithdraw ? "Withdraw from Vault" : "Deposit to Vault" }],
        isNativeIn: !isWithdraw
    };
}

export async function handleArcMemo(intent: ParsedIntent, userAddress: string) {
    const amountIn = intent.amount || "0";
    const amountWei = parseEther(amountIn);
    
    // AI Parser sets recipient to 'tokenOut' and memo to 'name'
    const to = intent.tokenOut || "0x0000000000000000000000000000000000000000"; 
    const memoText = intent.name || "Kletia Omni-Engine Transfer";
    
    const calldata = encodeFunctionData({ 
        abi: ARC_MEMOTRANSFER_ABI, 
        functionName: 'transferWithMemo',
        args: [to as `0x${string}`, memoText]
    });

    return {
        status: "success",
        action: "arc_memo_send",
        amountInWei: amountWei.toString(),
        targetContract: ARC_CONTRACTS.MemoTransfer,
        calldata,
        value: amountWei.toString(),
        winner: "Kletia Memo Transfer",
        expectedOutput: "Transfer Complete",
        allRoutes: [{ name: "Kletia Memo Transfer", router: ARC_CONTRACTS.MemoTransfer, calldata, expectedOutput: "Message Transfer" }],
        isNativeIn: true
    };
}



export async function handleArcAgentRegistry(intent: ParsedIntent, userAddress: string) {
    // AI Parser sets agent name to 'name' and description to 'tokenIn'
    const agentName = intent.name || "Kletia AI Agent";
    const agentDescription = intent.tokenIn || "Omni-Engine Powered Autonomous Agent";
    
    const calldata = encodeFunctionData({
        abi: ARC_AGENTREGISTRY_ABI,
        functionName: 'registerAgent',
        args: [agentName, agentDescription, ["DeFi", "AI"], "https://agent.kletia.com"]
    });

    return {
        status: "success",
        action: "arc_register_agent",
        amountInWei: "0",
        targetContract: ARC_CONTRACTS.AgentRegistry,
        calldata,
        value: "0",
        winner: "Kletia Agent Registry",
        expectedOutput: "Agent Registered",
        allRoutes: [{ name: "Kletia Agent Registry", router: ARC_CONTRACTS.AgentRegistry, calldata, expectedOutput: "AI Registry" }],
        isNativeIn: false
    };
}

export async function handleArcLiquidity(intent: ParsedIntent, userAddress: string) {
    const amountIn = intent.amount || "0";
    const amountWei = parseEther(amountIn);
    
    let requiredKlet = amountWei; // fallback
    try {
        const provider = new ethers.JsonRpcProvider(ARC_RPC_URL);
        const swapContract = new ethers.Contract(ARC_CONTRACTS.Swap, ARC_SWAP_ABI, provider);
        const usdcRes: bigint = await swapContract.usdcReserve();
        const tokenRes: bigint = await swapContract.tokenReserve();
        if (usdcRes > 0n) {
            requiredKlet = (amountWei * tokenRes) / usdcRes;
        }
    } catch (e) {
        console.log("Failed to fetch reserves for liquidity calculation:", e);
    }
    
    // 5% slippage on maxTokenAmount to prevent failures
    const maxTokenAmount = (requiredKlet * 105n) / 100n;

    const calldata = encodeFunctionData({
        abi: ARC_SWAP_ABI,
        functionName: 'addLiquidity',
        args: [maxTokenAmount] // maxTokenAmount
    });

    return {
        status: "success",
        action: "arc_add_liquidity",
        amountInWei: amountWei.toString(),
        targetContract: ARC_CONTRACTS.Swap,
        calldata,
        value: amountWei.toString(), // usdc amount
        winner: "Kletia Liquidity Pool",
        expectedOutput: "Liquidity Provided",
        allRoutes: [{ 
            name: "Kletia Liquidity", 
            router: ARC_CONTRACTS.Swap, 
            calldata, 
            expectedOutput: "Pool Liquidity",
            secondaryTokenAddress: ARC_CONTRACTS.Token,
            secondaryAmountInWei: maxTokenAmount.toString() // Request approval for maxTokenAmount to cover slippage
        }],
        isNativeIn: true
    };
}


export async function dispatchArcAction(intent: ParsedIntent, userAddress: string) {
    const action = intent.action.toLowerCase();
    
    let result;
    if (action === 'swap' || action === 'arc_swap') result = await handleArcSwap(intent, userAddress);
    else if (action === 'stake' || action === 'arc_stake') result = await handleArcStaking(intent, userAddress);
    else if (action === 'arc_vault_deposit') result = await handleArcVault(intent, userAddress, false);
    else if (action === 'arc_vault_withdraw') result = await handleArcVault(intent, userAddress, true);
    else if (action === 'arc_memo_send' || action === 'memo') result = await handleArcMemo(intent, userAddress);

    else if (action === 'arc_register_agent') result = await handleArcAgentRegistry(intent, userAddress);
    else if (action === 'arc_add_liquidity' || action === 'add_liquidity') result = await handleArcLiquidity(intent, userAddress);
    else if (action === 'arc_lending_deposit' || action === 'lend') result = await handleArcLendingDeposit(intent, userAddress);
    else if (action === 'arc_lending_borrow' || action === 'borrow') result = await handleArcLendingBorrow(intent, userAddress);
    else if (action === 'arc_lending_repay' || action === 'repay') result = await handleArcLendingRepay(intent, userAddress);
    else {
        throw new Error(`Action '${action}' is not currently supported on the Arc network via the AI assistant. Please use the dashboard widgets.`);
    }

    const sim = await arcXRaySimulate(result.targetContract, result.calldata, userAddress, result.value);
    
    if (!sim.success) {
        if (!result.isNativeIn) {
            console.log(`[ARC X-RAY] Revert caught due to ERC20 operation (missing Approve). Skipping simulation. Error: ${sim.error}`);
            sim.gasEstimate = "150000";
        } else {
            throw new Error(`Network Rule Violation (Arc X-Ray): Transaction rejected. Detail: ${sim.error}`);
        }
    }

    result.expectedOutput = `${result.expectedOutput} | ⛽ Est. Gas: ${sim.gasEstimate}`;
    if (result.allRoutes && result.allRoutes.length > 0) {
        result.allRoutes[0].expectedOutput = result.expectedOutput;
    }

    return result;
}

async function arcXRaySimulate(to: string, data: string, from: string, value: string): Promise<{success: boolean, error?: string, gasEstimate?: string}> {
    const provider = new ethers.JsonRpcProvider(ARC_RPC_URL);
    const tx = { to, data, from, value: value || "0" };
    
    console.log(`[ARC X-RAY] Simulating: ${to} - Value: ${value}`);
    
    let attempts = 0;
    while (attempts < 10) {
        try {
            const gasEstimate = await provider.estimateGas(tx);
            return { success: true, gasEstimate: gasEstimate.toString() };
        } catch (e: any) {
            let errorMsg = e.shortMessage || e.message || "Unknown Revert";
            const errStr = errorMsg.toLowerCase();
            if (errStr.includes("limit") || errStr.includes("timeout") || errStr.includes("429") || errStr.includes("network") || errStr.includes("fetch")) {
                attempts++;
                console.log(`   [Arc X-Ray Retry] Rate limit hit, retrying in 2s... (${attempts}/10)`);
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }
            if (errorMsg.includes("allowance") || errorMsg.includes("transfer amount exceeds balance")) {
                 return { success: false, error: "Insufficient balance or missing Token Approval." };
            }
            return { success: false, error: errorMsg };
        }
    }
    return { success: false, error: "Arc RPC Rate Limit exceeded (10 failed attempts)." };
}

export async function handleArcLendingDeposit(intent: ParsedIntent, userAddress: string) {
    const amountIn = intent.amount || "0";
    const amountWei = parseEther(amountIn);
    const calldata = encodeFunctionData({ 
        abi: ARC_LENDING_ABI, 
        functionName: 'depositCollateral',
        args: [amountWei]
    });

    return {
        status: "success",
        action: "arc_lending_deposit",
        amountInWei: amountWei.toString(),
        targetContract: ARC_CONTRACTS.Lending,
        calldata,
        value: "0",
        winner: "Kletia Lending",
        expectedOutput: "Collateral Added",
        allRoutes: [{ 
            name: "Kletia Lending", 
            router: ARC_CONTRACTS.Lending, 
            calldata, 
            expectedOutput: "Add Collateral",
            primaryTokenAddress: ARC_CONTRACTS.Token,
            primaryAmountInWei: amountWei.toString()
        }],
        isNativeIn: false,
        tokenInAddress: ARC_CONTRACTS.Token
    };
}

export async function handleArcLendingBorrow(intent: ParsedIntent, userAddress: string) {
    const amountIn = intent.amount || "0";
    const amountWei = parseEther(amountIn);
    const calldata = encodeFunctionData({ 
        abi: ARC_LENDING_ABI, 
        functionName: 'borrow',
        args: [amountWei]
    });

    return {
        status: "success",
        action: "arc_lending_borrow",
        amountInWei: "0",
        targetContract: ARC_CONTRACTS.Lending,
        calldata,
        value: "0",
        winner: "Kletia Lending",
        expectedOutput: "USDC Debt",
        allRoutes: [{ name: "Kletia Lending", router: ARC_CONTRACTS.Lending, calldata, expectedOutput: "Borrow USDC" }],
        isNativeIn: false
    };
}

export async function handleArcLendingRepay(intent: ParsedIntent, userAddress: string) {
    const amountIn = intent.amount || "0";
    const amountWei = parseEther(amountIn);
    const calldata = encodeFunctionData({ 
        abi: ARC_LENDING_ABI, 
        functionName: 'repay'
    });

    return {
        status: "success",
        action: "arc_lending_repay",
        amountInWei: "0",
        targetContract: ARC_CONTRACTS.Lending,
        calldata,
        value: amountWei.toString(), // Native ETH (Native token) value for repaying in some cases if it's native asset
        winner: "Kletia Lending",
        expectedOutput: "Repay USDC Debt",
        allRoutes: [{ name: "Kletia Lending", router: ARC_CONTRACTS.Lending, calldata, expectedOutput: "Repay Debt" }],
        isNativeIn: true
    };
}
