/**
 * Aave V3 supply on Base (USDC, WETH, cbBTC) and Arbitrum One (USDC, WETH).
 * Approves only when the current allowance is insufficient, then calls
 * Pool.supply(asset, amount, onBehalfOf = step account, referralCode = 0).
 */
import { encodeFunctionData, erc20Abi, getAddress, parseAbi, type Address } from "viem";
import {
  CHAINS,
  findAssetBySymbol,
  formatAmount,
  formatAssetId,
  fromBaseUnits,
  type EvmTransactionRequest,
  type NetworkKey,
} from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { assetAmount, type ResolvedAsset } from "../assets.js";
import { estimateEvmFeeUsd, evmChainId, evmClient, isEvmNetwork, readAllowance, type EvmNetworkKey } from "../chains/evm.js";
import { assertEvmBalance, estimateGas } from "./evm-transfer.js";
import type { AdapterAction, PlannedStep, PreparedPayload, ProtocolAdapter } from "./types.js";
import { verifyEvmReferences } from "./verification.js";

const POOL_ABI = parseAbi(["function supply(address asset,uint256 amount,address onBehalfOf,uint16 referralCode)"]);
const DATA_PROVIDER_ABI = parseAbi([
  "function getReserveTokensAddresses(address asset) view returns (address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress)",
  "function getReserveConfigurationData(address asset) view returns (uint256 decimals,uint256 ltv,uint256 liquidationThreshold,uint256 liquidationBonus,uint256 reserveFactor,bool usageAsCollateralEnabled,bool borrowingEnabled,bool stableBorrowRateEnabled,bool isActive,bool isFrozen)",
  "function getPaused(address asset) view returns (bool)",
]);

interface AaveMarket {
  readonly pool: Address;
  readonly dataProvider: Address;
  readonly assets: readonly string[];
}

/** Aave V3 core markets (pool and protocol data provider). */
export const AAVE_V3_MARKETS: Readonly<Partial<Record<NetworkKey, AaveMarket>>> = Object.freeze({
  base: {
    pool: getAddress("0xA238Dd80C259a72e81d7e4664a9801593F98d1c5"),
    dataProvider: getAddress("0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A"),
    assets: ["USDC", "WETH", "cbBTC"],
  },
  arbitrum: {
    pool: getAddress("0x794a61358D6845594F94dc1DB02A252b5b4814aD"),
    dataProvider: getAddress("0x243Aa95cAC2a25651eda86e80bEe66114413c43b"),
    assets: ["USDC", "WETH"],
  },
});

const SUPPLY_GAS = 260_000n;
const APPROVE_GAS = 60_000n;

function market(network: NetworkKey): { network: EvmNetworkKey; market: AaveMarket } {
  const entry = AAVE_V3_MARKETS[network];
  if (!entry || !isEvmNetwork(network)) {
    throw new PlatformError("INTENT_UNSUPPORTED", `Aave V3 deposits are available on Base and Arbitrum, not ${CHAINS[network].name}.`, 422);
  }
  return { network, market: entry };
}

function assertSupported(network: NetworkKey, asset: ResolvedAsset, entry: AaveMarket): void {
  if (asset.isNative) {
    throw new PlatformError("INTENT_UNSUPPORTED", "Aave supplies ERC-20 tokens; deposit WETH instead of native ETH (swap ETH to WETH first).", 422);
  }
  const allowed = entry.assets.some((symbol) => findAssetBySymbol(network, symbol)?.id.toLowerCase() === asset.id.toLowerCase());
  if (!allowed) {
    throw new PlatformError(
      "INTENT_UNSUPPORTED",
      `Kletia supplies ${entry.assets.join(", ")} to Aave V3 on ${CHAINS[network].name}; ${asset.symbol} is not supported.`,
      422,
    );
  }
}

interface ReserveInfo {
  readonly aToken: Address;
  readonly aTokenSymbol: string;
}

async function readReserve(network: EvmNetworkKey, entry: AaveMarket, asset: Address): Promise<ReserveInfo> {
  const client = evmClient(network);
  const [tokens, config, paused] = await Promise.all([
    client.readContract({ address: entry.dataProvider, abi: DATA_PROVIDER_ABI, functionName: "getReserveTokensAddresses", args: [asset] }),
    client.readContract({ address: entry.dataProvider, abi: DATA_PROVIDER_ABI, functionName: "getReserveConfigurationData", args: [asset] }),
    client.readContract({ address: entry.dataProvider, abi: DATA_PROVIDER_ABI, functionName: "getPaused", args: [asset] }).catch(() => false),
  ]);
  const aToken = tokens[0];
  const isActive = config[8];
  const isFrozen = config[9];
  if (!aToken || /^0x0{40}$/iu.test(aToken) || !isActive || isFrozen || paused) {
    throw new PlatformError("RESERVE_UNAVAILABLE", "This Aave V3 reserve is not accepting supply right now.", 422);
  }
  const symbol = await client
    .readContract({ address: aToken, abi: erc20Abi, functionName: "symbol" })
    .then((value) => String(value).replace(/[^\w$.-]/gu, "").slice(0, 16))
    .catch(() => "aToken");
  return { aToken: getAddress(aToken), aTokenSymbol: symbol || "aToken" };
}

function positionAsset(network: NetworkKey, input: ResolvedAsset, reserve: ReserveInfo): ResolvedAsset {
  return {
    network,
    id: formatAssetId(network, "erc20", reserve.aToken),
    symbol: reserve.aTokenSymbol,
    name: `Aave ${input.symbol}`,
    decimals: input.decimals,
    address: reserve.aToken,
    isNative: false,
    canonical: false,
    verified: true,
    ...(input.category === "stablecoin" ? { category: "stablecoin" as const } : {}),
  };
}

function title(action: Pick<AdapterAction, "amount" | "input" | "network">): string {
  return `Supply ${formatAmount(fromBaseUnits(action.amount, action.input.decimals))} ${action.input.symbol} to Aave V3 on ${CHAINS[action.network].name}`;
}

export const aaveV3Adapter: ProtocolAdapter = {
  id: "aave-v3",
  protocols: ["aave-v3"],
  label: "Aave V3",

  supports(route) {
    return route.kind === "deposit" && route.network === route.destinationNetwork && AAVE_V3_MARKETS[route.network] !== undefined;
  },

  async plan(action): Promise<PlannedStep> {
    const { network, market: entry } = market(action.network);
    assertSupported(network, action.input, entry);
    const token = getAddress(action.input.address as string);
    const reserve = await readReserve(network, entry, token);
    const allowance = await readAllowance(network, token, action.account.address, entry.pool).catch(() => 0n);
    const needsApproval = allowance < BigInt(action.amount);
    const fees = await estimateEvmFeeUsd(network, SUPPLY_GAS + (needsApproval ? APPROVE_GAS : 0n));
    const position = assetAmount(positionAsset(network, action.input, reserve), action.amount);
    return {
      protocol: "aave-v3",
      title: title(action),
      mode: "wallet",
      input: assetAmount(action.input, action.amount),
      expectedOutput: position,
      minimumOutput: position,
      ...(fees !== undefined ? { feesUsd: fees } : {}),
      estimatedSeconds: needsApproval ? 20 : 10,
      settlement: { kind: "same-network" },
      warnings: [],
      transactionCount: needsApproval ? 2 : 1,
      slippageBps: action.slippageBps,
    };
  },

  async prepare({ action }): Promise<PreparedPayload> {
    const { network, market: entry } = market(action.network);
    assertSupported(network, action.input, entry);
    const token = getAddress(action.input.address as string);
    const owner = getAddress(action.account.address);
    const amount = BigInt(action.amount);
    await assertEvmBalance(network, owner, token, amount, action.input.symbol, action.input.decimals);
    const reserve = await readReserve(network, entry, token);
    const allowance = await readAllowance(network, token, owner, entry.pool);
    const chainId = evmChainId(network);
    const description = title(action);
    const transactions: EvmTransactionRequest[] = [];
    if (allowance < amount) {
      transactions.push({
        vm: "evm",
        network,
        chainId,
        from: owner,
        to: token,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [entry.pool, amount] }),
        value: "0",
        gas: APPROVE_GAS.toString(),
        description: `Approve ${formatAmount(fromBaseUnits(action.amount, action.input.decimals))} ${action.input.symbol} for Aave V3`,
      });
    }
    const supplyData = encodeFunctionData({ abi: POOL_ABI, functionName: "supply", args: [token, amount, owner, 0] });
    const gas = transactions.length === 0
      ? await estimateGas(network, { from: owner, to: entry.pool, data: supplyData, value: "0" })
      : undefined;
    transactions.push({
      vm: "evm",
      network,
      chainId,
      from: owner,
      to: entry.pool,
      data: supplyData,
      value: "0",
      gas: gas ?? SUPPLY_GAS.toString(),
      description,
    });
    const position = assetAmount(positionAsset(network, action.input, reserve), action.amount);
    const fees = await estimateEvmFeeUsd(network, SUPPLY_GAS + (transactions.length > 1 ? APPROVE_GAS : 0n));
    return {
      transactions,
      records: transactions.map((transaction) => ({ vm: "evm" as const, network, to: transaction.to, description: transaction.description })),
      input: assetAmount(action.input, action.amount),
      expectedOutput: position,
      minimumOutput: position,
      ...(fees !== undefined ? { feesUsd: fees } : {}),
      warnings: [],
    };
  },

  async verify(context) {
    const result = await verifyEvmReferences(context);
    return result.status === "confirmed" && context.step.expectedOutput
      ? { ...result, actualOutput: context.step.expectedOutput }
      : result;
  },
};
