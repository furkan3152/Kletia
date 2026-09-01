import {
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  maxUint256,
  parseUnits,
  type Address,
} from "viem";

import type { ParsedIntent } from "../../shared/ai/parser.js";
import { arbitrumPublicClient } from "../../shared/config/networks.js";
import { ARBITRUM_TOKENS } from "./contracts.js";

export const ARBITRUM_COMPOUND_V3 = {
  cometUsdc: "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf" as Address,
  rewards: "0x88730d254A2f7e6AC8388c3198aFd694bA9f7fae" as Address,
  bulker: "0xbdE8F31D2DdDA895264e27DD990faB3DC87b372d" as Address,
  officialSource:
    "https://github.com/compound-finance/comet/blob/main/deployments/arbitrum/usdc/roots.json",
} as const;

const COMET_ABI = [
  {
    type: "function",
    name: "baseToken",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "borrowBalanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getUtilization",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getSupplyRate",
    stateMutability: "view",
    inputs: [{ name: "utilization", type: "uint256" }],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    type: "function",
    name: "getBorrowRate",
    stateMutability: "view",
    inputs: [{ name: "utilization", type: "uint256" }],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    type: "function",
    name: "isSupplyPaused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "isWithdrawPaused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "supply",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const SECONDS_PER_YEAR = 31_536_000n;
const RATE_SCALE = 10n ** 18n;
const QUOTE_TTL_MS = 2 * 60 * 1_000;

function controlled(code: string, message: string, statusCode = 400): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

function apyBps(perSecondRate: bigint): number {
  const simpleAnnualBps = (perSecondRate * SECONDS_PER_YEAR * 10_000n) / RATE_SCALE;
  return Number(simpleAnnualBps > 1_000_000n ? 1_000_000n : simpleAnnualBps);
}

function parseAmount(value: unknown): bigint {
  const raw = String(value ?? "").trim();
  if (!/^(?:\d+\.?\d*|\.\d+)$/u.test(raw)) {
    throw controlled("AMOUNT_REQUIRED", "Enter a positive Compound III USDC amount.");
  }
  let amount: bigint;
  try {
    amount = parseUnits(raw, ARBITRUM_TOKENS.USDC.decimals);
  } catch {
    throw controlled("AMOUNT_INVALID", "Arbitrum native USDC supports at most six decimals.");
  }
  if (amount <= 0n) throw controlled("AMOUNT_REQUIRED", "Enter a positive Compound III USDC amount.");
  return amount;
}

async function assertCompoundMarket() {
  const [code, baseToken] = await Promise.all([
    arbitrumPublicClient.getCode({ address: ARBITRUM_COMPOUND_V3.cometUsdc }),
    arbitrumPublicClient.readContract({
      address: ARBITRUM_COMPOUND_V3.cometUsdc,
      abi: COMET_ABI,
      functionName: "baseToken",
    }),
  ]);
  if (!code || code === "0x" || baseToken.toLowerCase() !== ARBITRUM_TOKENS.USDC.address.toLowerCase()) {
    throw controlled(
      "COMPOUND_MARKET_ATTESTATION_FAILED",
      "The live Compound III Comet or its native-USDC base token did not match the official deployment binding.",
      503,
    );
  }
}

export async function readCompoundV3Snapshot(owner: Address) {
  await assertCompoundMarket();
  const [utilization, supplied, borrowed, supplyPaused, withdrawPaused, blockNumber] =
    await Promise.all([
      arbitrumPublicClient.readContract({
        address: ARBITRUM_COMPOUND_V3.cometUsdc,
        abi: COMET_ABI,
        functionName: "getUtilization",
      }),
      arbitrumPublicClient.readContract({
        address: ARBITRUM_COMPOUND_V3.cometUsdc,
        abi: COMET_ABI,
        functionName: "balanceOf",
        args: [owner],
      }),
      arbitrumPublicClient.readContract({
        address: ARBITRUM_COMPOUND_V3.cometUsdc,
        abi: COMET_ABI,
        functionName: "borrowBalanceOf",
        args: [owner],
      }),
      arbitrumPublicClient.readContract({
        address: ARBITRUM_COMPOUND_V3.cometUsdc,
        abi: COMET_ABI,
        functionName: "isSupplyPaused",
      }),
      arbitrumPublicClient.readContract({
        address: ARBITRUM_COMPOUND_V3.cometUsdc,
        abi: COMET_ABI,
        functionName: "isWithdrawPaused",
      }),
      arbitrumPublicClient.getBlockNumber(),
    ]);
  const [supplyRate, borrowRate] = await Promise.all([
    arbitrumPublicClient.readContract({
      address: ARBITRUM_COMPOUND_V3.cometUsdc,
      abi: COMET_ABI,
      functionName: "getSupplyRate",
      args: [utilization],
    }),
    arbitrumPublicClient.readContract({
      address: ARBITRUM_COMPOUND_V3.cometUsdc,
      abi: COMET_ABI,
      functionName: "getBorrowRate",
      args: [utilization],
    }),
  ]);
  return {
    schemaVersion: "kletia_arbitrum_compound_v3_snapshot_v1" as const,
    protocolId: "compound-v3" as const,
    market: ARBITRUM_COMPOUND_V3.cometUsdc,
    baseToken: ARBITRUM_TOKENS.USDC.address,
    suppliedAtomic: supplied.toString(),
    borrowedAtomic: borrowed.toString(),
    utilization: formatUnits(utilization, 18),
    supplyApyBps: apyBps(supplyRate),
    borrowApyBps: apyBps(borrowRate),
    supplyPaused,
    withdrawPaused,
    observedAtBlock: blockNumber.toString(),
    officialSource: ARBITRUM_COMPOUND_V3.officialSource,
    mockData: false as const,
  };
}

export async function prepareCompoundV3Intent(intent: ParsedIntent, owner: Address) {
  const action = intent.action as
    | "lend"
    | "withdraw"
    | "borrow"
    | "borrow_capacity"
    | "repay"
    | "yield_compare";
  const symbol = String(intent.tokenIn || "USDC").trim().toUpperCase();
  if (symbol !== "USDC") {
    throw controlled(
      "COMPOUND_ASSET_UNSUPPORTED",
      "The reviewed Arbitrum Compound III adapter is bound only to the native-USDC Comet market.",
      409,
    );
  }
  const snapshot = await readCompoundV3Snapshot(owner);
  if (action === "yield_compare") {
    return {
      status: "success",
      action,
      readOnly: true,
      winnerMessage: `Compound III live USDC supply APY is approximately ${(snapshot.supplyApyBps / 100).toFixed(2)}%; borrow APY is ${(snapshot.borrowApyBps / 100).toFixed(2)}%.`,
      yieldComparison: snapshot,
    };
  }
  if (action === "borrow" || action === "borrow_capacity") {
    throw controlled(
      "COMPOUND_BORROW_POLICY_UNAVAILABLE",
      "Compound III borrowing remains read-only unavailable until the Kletia risk engine verifies every collateral factor, price feed and projected liquidity constraint for this Comet market.",
      409,
    );
  }
  const walletBalance = await arbitrumPublicClient.readContract({
    address: ARBITRUM_TOKENS.USDC.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  });
  const all = ["MAX", "ALL"].includes(String(intent.amount ?? "").trim().toUpperCase());
  let amount: bigint;
  let method: "supply" | "withdraw";
  if (action === "lend") {
    if (snapshot.supplyPaused) {
      throw controlled("COMPOUND_SUPPLY_PAUSED", "Compound III supply is paused.", 503);
    }
    amount = all ? walletBalance : parseAmount(intent.amount);
    method = "supply";
  } else if (action === "repay") {
    if (snapshot.supplyPaused) {
      throw controlled("COMPOUND_REPAY_PAUSED", "Compound III repayment is paused.", 503);
    }
    const debt = BigInt(snapshot.borrowedAtomic);
    if (debt === 0n) throw controlled("COMPOUND_DEBT_EMPTY", "No Compound III USDC debt is available to repay.", 409);
    amount = all ? (walletBalance < debt ? walletBalance : debt) : parseAmount(intent.amount);
    if (amount > debt) amount = debt;
    method = "supply";
  } else {
    if (snapshot.withdrawPaused) {
      throw controlled("COMPOUND_WITHDRAW_PAUSED", "Compound III withdrawal is paused.", 503);
    }
    const supplied = BigInt(snapshot.suppliedAtomic);
    if (supplied === 0n) throw controlled("COMPOUND_POSITION_EMPTY", "No supplied Compound III USDC position is available.", 409);
    amount = all ? supplied : parseAmount(intent.amount);
    if (amount > supplied) {
      throw controlled("COMPOUND_WITHDRAW_EXCEEDS_POSITION", "Requested withdrawal exceeds the live Compound III supplied balance.", 409);
    }
    method = "withdraw";
  }
  if (amount <= 0n || (method === "supply" && amount > walletBalance)) {
    throw controlled("INSUFFICIENT_USDC", "The wallet has insufficient native USDC for this Compound III call.", 409);
  }
  const calldata = encodeFunctionData({
    abi: COMET_ABI,
    functionName: method,
    args: [ARBITRUM_TOKENS.USDC.address, amount === maxUint256 ? maxUint256 : amount],
  });
  const approvals = method === "supply"
    ? [{
        token: ARBITRUM_TOKENS.USDC.address,
        spender: ARBITRUM_COMPOUND_V3.cometUsdc,
        amount: amount.toString(),
        symbol: "USDC",
        required: true as const,
      }]
    : [];
  const quoteExpiresAt = Date.now() + QUOTE_TTL_MS;
  const expectedOutput = `${formatUnits(amount, 6)} USDC ${action === "lend" ? "supplied" : action === "repay" ? "repaid" : "withdrawn"}`;
  const route = {
    name: `Compound III ${action}`,
    protocolId: "compound-v3",
    expectedOutput,
    routePath: `USDC → Compound III ${action}`,
    router: ARBITRUM_COMPOUND_V3.cometUsdc,
    calldata,
    value: "0",
    approvals,
    approvalPolicy: "explicit" as const,
    primaryTokenAddress: ARBITRUM_TOKENS.USDC.address,
    primaryAmountInWei: amount.toString(),
    simulationStatus: approvals.length > 0 ? "deferred_until_approval" as const : "passed" as const,
    quoteExpiresAt,
    economics: snapshot,
  };
  return {
    status: "success",
    action,
    actionType: action,
    winner: route.name,
    winnerMessage: `Live Compound III ${action} route is ready for explicit wallet review.`,
    expectedOutput,
    routePath: route.routePath,
    targetContract: route.router,
    calldata,
    value: "0",
    amountInWei: amount.toString(),
    tokenInAddress: ARBITRUM_TOKENS.USDC.address,
    isNativeIn: false,
    approvals,
    allRoutes: [route],
    quoteExpiresAt,
    yieldRankingEvidence: {
      policyVersion: "arbitrum_compound_v3_live_market_v1",
      officialDeployment: ARBITRUM_COMPOUND_V3.officialSource,
      eligibleRouteCount: 1,
      mockData: false,
    },
  };
}
