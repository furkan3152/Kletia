import { formatUnits, erc20Abi, getAddress } from "viem";
import { publicClient } from "../../../config/client.js";

const LSD_TOKENS = {
  wstETH: getAddress("0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452"),
  cbETH: getAddress("0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22"),
  rETH: getAddress("0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c"),
  weETH: getAddress("0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A"),
  ezETH: getAddress("0x2416092f143378750bb29b79eD961ab195CcEea5"),
  wrsETH: getAddress("0xEDfa23602D0EC14714057867A78d01e94176BEA0"),
} as const;

const PROTOCOL_META: Record<
  string,
  { name: string; symbol: string; tokenAddress: `0x${string}` }
> = {
  wstETH: {
    name: "Lido (wstETH)",
    symbol: "wstETH",
    tokenAddress: LSD_TOKENS.wstETH,
  },
  cbETH: {
    name: "Coinbase (cbETH)",
    symbol: "cbETH",
    tokenAddress: LSD_TOKENS.cbETH,
  },
  rETH: {
    name: "Rocket Pool (rETH)",
    symbol: "rETH",
    tokenAddress: LSD_TOKENS.rETH,
  },
  weETH: {
    name: "ether.fi (weETH)",
    symbol: "weETH",
    tokenAddress: LSD_TOKENS.weETH,
  },
  ezETH: {
    name: "Renzo (ezETH)",
    symbol: "ezETH",
    tokenAddress: LSD_TOKENS.ezETH,
  },
  wrsETH: {
    name: "Kelp (wrsETH)",
    symbol: "wrsETH",
    tokenAddress: LSD_TOKENS.wrsETH,
  },
};

export async function getLiquidStakingRoutes(
  _action: "liquid_stake" | "liquid_unstake",
  _tokenSymbol: string,
  _amountStr: string,
  _userAddress: string,
  _requestedProtocol?: string,
) {
  throw new Error(
    "Legacy liquid-staking route builder is disabled; use the live Base swap engine.",
  );
}

export async function getLiquidStakingPositions(userAddress: string) {
  const safeUser = getAddress(userAddress) as `0x${string}`;

  const positions: {
    protocol: string;
    symbol: string;
    balance: bigint;
    formatted: string;
    tokenAddress: `0x${string}`;
  }[] = [];

  for (const [key, meta] of Object.entries(PROTOCOL_META)) {
    try {
      const [balance, decimals] = await Promise.all([
        publicClient.readContract({
          address: meta.tokenAddress,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [safeUser],
        }),
        publicClient.readContract({
          address: meta.tokenAddress,
          abi: erc20Abi,
          functionName: "decimals",
        }),
      ]);

      positions.push({
        protocol: meta.name,
        symbol: meta.symbol,
        balance,
        formatted: formatUnits(balance, decimals),
        tokenAddress: meta.tokenAddress,
      });
    } catch (error: unknown) {
      console.warn(`[Liquid staking] Unable to read ${meta.symbol} balance.`, {
        name: error instanceof Error ? error.name : "UnknownError",
        code:
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : undefined,
      });
    }
  }

  return positions;
}
