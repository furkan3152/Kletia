import {
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  parseUnits,
  type Address,
} from "viem";
import { basePublicClient } from "../../../config/client.js";
import {
  BASE_STAKING_CONTRACTS,
  getBaseTokenDefinition,
  normalizeBaseProtocolId,
} from "../protocols.js";

const VE_AERO_ABI = [
  {
    inputs: [
      { name: "_value", type: "uint256" },
      { name: "_lock_duration", type: "uint256" },
    ],
    name: "createLock",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

const STK_WELL_ABI = [
  {
    inputs: [
      { name: "onBehalfOf", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "stake",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

const STK_SEAM_ABI = [
  {
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "receiver", type: "address" },
    ],
    name: "deposit",
    outputs: [{ name: "shares", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

interface BaseStakingRoute {
  readonly name: string;
  readonly protocolId:
    "aerodrome" | "moonwell-safety-module" | "seamless-staking";
  readonly amount: bigint;
  readonly expectedOutput: string;
  readonly routePath: string;
  readonly router: Address;
  readonly calldata: `0x${string}`;
  readonly primaryTokenAddress: Address;
  readonly primaryAmountInWei: string;
  readonly approvals: readonly {
    readonly token: Address;
    readonly spender: Address;
    readonly amount: string;
    readonly symbol: string;
    readonly required: true;
  }[];
  readonly value: "0";
  readonly executionMode: "direct";
  readonly callerSemantics:
    "msg_sender_owns_position" | "on_behalf_of" | "explicit_recipient";
  readonly feeRouterCompatible: false;
  readonly riskDisclosure: string;
  readonly exitPolicy: {
    readonly lockDays?: number;
    readonly cooldownDays?: number;
    readonly unstakeWindowDays?: number;
  };
}

function normalizeDuration(durationInDays: number): {
  seconds: number;
  days: number;
} {
  const week = 604_800;
  const maxTime = 126_144_000;
  const requestedSeconds = Math.max(0, durationInDays) * 86_400;
  let seconds = Math.floor(requestedSeconds / week) * week;
  if (seconds < week) seconds = week;
  if (seconds > maxTime - week) seconds = maxTime - week;
  return { seconds, days: Math.floor(seconds / 86_400) };
}

export async function getStakingRoutes(
  tokenInSymbol: string,
  amountStr: string,
  durationInDays: number,
  userAddress: string,
  requestedProtocol?: string,
): Promise<BaseStakingRoute[]> {
  const safeSymbol =
    tokenInSymbol.toUpperCase() === "ETH"
      ? "WETH"
      : tokenInSymbol.toUpperCase();
  const token = getBaseTokenDefinition(safeSymbol);
  if (!token || !["AERO", "WELL", "SEAM"].includes(safeSymbol)) {
    throw Object.assign(
      new Error(
        `Verified Base staking supports AERO, WELL and SEAM; ${safeSymbol} is not a staking input.`,
      ),
      { code: "STAKING_ASSET_UNSUPPORTED", statusCode: 400 },
    );
  }

  const user = userAddress as Address;
  const userBalance = await basePublicClient.readContract({
    address: token.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [user],
  });
  const amount =
    amountStr.trim().toUpperCase() === "MAX"
      ? userBalance
      : parseUnits(amountStr || "0", token.decimals);
  if (amount <= 0n || userBalance < amount) {
    throw Object.assign(
      new Error(`Insufficient ${token.symbol} balance for staking.`),
      { code: "INSUFFICIENT_FUNDS", statusCode: 400 },
    );
  }

  const formattedAmount = formatUnits(amount, token.decimals);
  const requestedProtocolId = normalizeBaseProtocolId(requestedProtocol);
  const routes: BaseStakingRoute[] = [];

  if (safeSymbol === "AERO") {
    const duration = normalizeDuration(durationInDays || 30);
    const votingPowerMultiplier = duration.seconds / 126_144_000;
    const expectedVotingPower = (
      Number(formattedAmount) * votingPowerMultiplier
    ).toFixed(4);
    routes.push({
      name: "Aerodrome Finance (New veAERO Lock)",
      protocolId: "aerodrome",
      amount,
      expectedOutput:
        `Lock ${formattedAmount} AERO for about ${duration.days} days; ` +
        `estimated initial voting power ${expectedVotingPower} veAERO`,
      routePath: "AERO ➝ [veAERO time lock] ➝ voting NFT",
      router: BASE_STAKING_CONTRACTS.veAero,
      calldata: encodeFunctionData({
        abi: VE_AERO_ABI,
        functionName: "createLock",
        args: [amount, BigInt(duration.seconds)],
      }),
      primaryTokenAddress: token.address,
      primaryAmountInWei: amount.toString(),
      approvals: [
        {
          token: token.address,
          spender: BASE_STAKING_CONTRACTS.veAero,
          amount: amount.toString(),
          symbol: token.symbol,
          required: true,
        },
      ],
      value: "0",
      executionMode: "direct",
      callerSemantics: "msg_sender_owns_position",
      feeRouterCompatible: false,
      riskDisclosure:
        "A veAERO lock is illiquid until expiry and creates a user-owned NFT. No reward APY is assumed.",
      exitPolicy: { lockDays: duration.days },
    });
  }

  if (safeSymbol === "WELL") {
    routes.push({
      name: "Moonwell Safety Module (stkWELL)",
      protocolId: "moonwell-safety-module",
      amount,
      expectedOutput: `Stake ${formattedAmount} WELL for stkWELL; live rewards are not projected`,
      routePath: "WELL ➝ [Moonwell Safety Module] ➝ stkWELL",
      router: BASE_STAKING_CONTRACTS.stkWell,
      calldata: encodeFunctionData({
        abi: STK_WELL_ABI,
        functionName: "stake",
        args: [user, amount],
      }),
      primaryTokenAddress: token.address,
      primaryAmountInWei: amount.toString(),
      approvals: [
        {
          token: token.address,
          spender: BASE_STAKING_CONTRACTS.stkWell,
          amount: amount.toString(),
          symbol: token.symbol,
          required: true,
        },
      ],
      value: "0",
      executionMode: "direct",
      callerSemantics: "on_behalf_of",
      feeRouterCompatible: false,
      riskDisclosure:
        "stkWELL secures the protocol and may be slashed for a shortfall; staking is not principal-guaranteed.",
      exitPolicy: {
        cooldownDays: 7,
        unstakeWindowDays: 2,
      },
    });
  }

  if (safeSymbol === "SEAM") {
    routes.push({
      name: "Seamless Staking (stkSEAM)",
      protocolId: "seamless-staking",
      amount,
      expectedOutput: `Deposit ${formattedAmount} SEAM for stkSEAM; live rewards are not projected`,
      routePath: "SEAM ➝ [Seamless staking vault] ➝ stkSEAM",
      router: BASE_STAKING_CONTRACTS.stkSeam,
      calldata: encodeFunctionData({
        abi: STK_SEAM_ABI,
        functionName: "deposit",
        args: [amount, user],
      }),
      primaryTokenAddress: token.address,
      primaryAmountInWei: amount.toString(),
      approvals: [
        {
          token: token.address,
          spender: BASE_STAKING_CONTRACTS.stkSeam,
          amount: amount.toString(),
          symbol: token.symbol,
          required: true,
        },
      ],
      value: "0",
      executionMode: "direct",
      callerSemantics: "explicit_recipient",
      feeRouterCompatible: false,
      riskDisclosure:
        "stkSEAM has cooldown-based exit constraints; no reward APY or principal guarantee is assumed.",
      exitPolicy: {
        cooldownDays: 7,
        unstakeWindowDays: 1,
      },
    });
  }

  const filtered = requestedProtocolId
    ? routes.filter(({ protocolId }) => protocolId === requestedProtocolId)
    : routes;
  if (filtered.length === 0) {
    throw Object.assign(
      new Error(
        `${requestedProtocol} is not a verified staking route for ${token.symbol}.`,
      ),
      { code: "STAKING_PROTOCOL_UNSUPPORTED", statusCode: 400 },
    );
  }
  return filtered;
}
