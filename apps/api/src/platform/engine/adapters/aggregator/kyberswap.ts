/**
 * Optional EVM aggregator venue: KyberSwap MetaAggregationRouterV2 for
 * same-network swaps. Off unless the server sets KLETIA_EVM_AGGREGATOR=kyberswap:
 * the adapter is then listed in ADAPTERS and competes in the same-network
 * swap auction like every other venue.
 *
 * The API is untrusted. At plan and at prepare Kletia:
 * - requires the router the API names to be the pinned router (also the
 *   exact-approval spender);
 * - decodes the router call and checks source token, destination token, the
 *   exact amount, the receiver (the step account itself), no fee receivers or
 *   permit, and an on-chain minimum (`minReturnAmount`, the router reverts
 *   below it) of at least the quoted output minus the step's slippage;
 * - holds the quoted output to the oracle band every DEX venue uses (5 %).
 * The minimum is enforced on-chain ("onchain" floor). Verification needs the
 * prepared payload to land and the account to be credited at least the
 * lowest prepared floor.
 */
import { encodeFunctionData, erc20Abi, getAddress } from "viem";
import { applySlippage, CHAINS, formatAmount, fromBaseUnits, venueContracts, type NetworkKey, type TransactionRequest } from "@kletia/core";
import { PlatformError } from "../../../errors.js";
import { assetAmount, type ResolvedAsset } from "../../assets.js";
import { estimateEvmFeeUsd, evmChainId, isEvmNetwork, readAllowance, type EvmNetworkKey } from "../../chains/evm.js";
import { decodeStepRef } from "../../stepRef.js";
import { oracleGuard } from "../dex/oracleGuard.js";
import { assertEvmBalance } from "../evmTransfer.js";
import { proveSameNetworkSwap } from "../relay.js";
import type { AdapterAction, AdapterRoute, PlannedStep, PreparedPayload, ProtocolAdapter, VerificationResult } from "../types.js";
import { verifyEvmReceipts } from "../verification.js";
import { checkKyberSwap, KYBER_NATIVE } from "./kyberCalldata.js";
import { buildKyberRoute, fetchKyberRoute, kyberChain } from "./kyberClient.js";

/** True when the server enables the optional aggregator venue. */
export function aggregatorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KLETIA_EVM_AGGREGATOR?.trim().toLowerCase() === "kyberswap";
}

/** Slippage cap of an aggregator swap (bps), like the DEX venues. */
const MAX_SLIPPAGE_BPS = 300;
const APPROVE_GAS = "70000";
/** Gas assumed for the swap when the API gives no estimate (aggregated routes touch several pools). */
const DEFAULT_SWAP_GAS = 400_000n;
const PREVIEW_TTL_SECONDS = 30;

/** The pinned router on `network`, or null when none (or several) is pinned. */
export function kyberRouter(network: NetworkKey): string | null {
  const pins = venueContracts("kyberswap", network, "aggregator-router");
  return pins.length === 1 ? (pins[0] as string) : null;
}

function kyberToken(asset: ResolvedAsset): string {
  return asset.isNative ? KYBER_NATIVE : (asset.address as string);
}

function title(action: Pick<AdapterAction, "network" | "input" | "output" | "amount">): string {
  return `Swap ${formatAmount(fromBaseUnits(action.amount, action.input.decimals))} ${action.input.symbol} to ${action.output.symbol} on ${CHAINS[action.network].name} via KyberSwap`;
}

interface CheckedSwap {
  readonly router: string;
  readonly data: string;
  readonly expected: bigint;
  readonly minimum: bigint;
  readonly gas: bigint;
  readonly allowance: bigint;
  readonly warnings: readonly string[];
}

/** Quotes, builds and verifies one router call for `action` (plan and prepare). */
async function checkedSwap(action: AdapterAction, stage: "plan" | "prepare"): Promise<CheckedSwap> {
  if (!kyberswapAdapter.supports(action) || !isEvmNetwork(action.network)) {
    throw new PlatformError("ROUTE_UNSUPPORTED", "KyberSwap serves same-network swaps of listed tokens on the EVM production networks only.", 422);
  }
  const router = kyberRouter(action.network);
  if (!router) throw new PlatformError("NETWORK_UNSUPPORTED", "KyberSwap has no pinned router on this network.", 422);
  if (action.recipient.address.toLowerCase() !== action.account.address.toLowerCase()) {
    throw new PlatformError("ROUTE_UNSUPPORTED", "An aggregator swap pays the acting account; send the result with a separate step.", 422);
  }
  const slippageBps = Math.min(action.slippageBps, MAX_SLIPPAGE_BPS);
  const route = await fetchKyberRoute({ network: action.network, tokenIn: kyberToken(action.input), tokenOut: kyberToken(action.output), amountIn: action.amount });
  if (route.routerAddress.toLowerCase() !== router.toLowerCase()) {
    throw new PlatformError("PROVIDER_TRANSACTION_INVALID", `KyberSwap route refused: the router ${route.routerAddress} is not the pinned ${router}.`, 502);
  }
  const built = await buildKyberRoute(action.network, route, action.account.address, action.account.address, slippageBps);
  if (built.routerAddress.toLowerCase() !== router.toLowerCase()) {
    throw new PlatformError("PROVIDER_TRANSACTION_INVALID", `KyberSwap route refused: the build targets ${built.routerAddress}, not the pinned router.`, 502);
  }
  if (built.amountIn !== action.amount) throw new PlatformError("PROVIDER_TRANSACTION_INVALID", "KyberSwap route refused: the build sells another amount.", 502);
  const expected = BigInt(built.amountOut);
  const floor = BigInt(applySlippage(built.amountOut, slippageBps));
  const decoded = checkKyberSwap(built.data, {
    srcToken: action.input.isNative ? null : (action.input.address as string),
    dstToken: action.output.isNative ? null : (action.output.address as string),
    amount: BigInt(action.amount),
    recipient: action.account.address,
    minReturn: floor,
  });
  if (decoded.minReturnAmount > expected) {
    throw new PlatformError("PROVIDER_TRANSACTION_INVALID", "KyberSwap route refused: the on-chain minimum is above the quoted output.", 502);
  }
  // The same oracle band as every DEX venue: a quote far below the oracle is refused (5 %), warned above 1 %.
  const oracle = await oracleGuard(action.network, action.input, BigInt(action.amount), action.output, expected);
  let allowance = BigInt(action.amount);
  if (!action.input.isNative) {
    const read = readAllowance(action.network, action.input.address as string, action.account.address, router);
    allowance = stage === "plan" ? await read.catch(() => 0n) : await read;
  }
  return {
    router,
    data: built.data,
    expected,
    minimum: decoded.minReturnAmount,
    gas: built.gas !== null ? BigInt(built.gas) : DEFAULT_SWAP_GAS,
    allowance,
    warnings: [
      `Route: KyberSwap aggregator router ${router}; the router reverts below ${fromBaseUnits(decoded.minReturnAmount, action.output.decimals)} ${action.output.symbol}.`,
      ...oracle.warnings,
    ],
  };
}

function swapTransactions(action: AdapterAction, network: EvmNetworkKey, swap: CheckedSwap): TransactionRequest[] {
  const amount = BigInt(action.amount);
  const chainId = evmChainId(network);
  const from = getAddress(action.account.address);
  const transactions: TransactionRequest[] = [];
  if (!action.input.isNative && swap.allowance < amount) {
    transactions.push({
      vm: "evm",
      network,
      chainId,
      from,
      to: getAddress(action.input.address as string),
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [getAddress(swap.router), amount] }),
      value: "0",
      gas: APPROVE_GAS,
      description: `Approve ${formatAmount(fromBaseUnits(action.amount, action.input.decimals))} ${action.input.symbol} for KyberSwap`,
    });
  }
  transactions.push({
    vm: "evm",
    network,
    chainId,
    from,
    to: getAddress(swap.router),
    data: swap.data,
    value: action.input.isNative ? amount.toString() : "0",
    gas: ((swap.gas * 13n) / 10n).toString(),
    description: title(action),
  });
  return transactions;
}

function amounts(action: AdapterAction, swap: CheckedSwap) {
  return {
    input: assetAmount(action.input, action.amount),
    expectedOutput: assetAmount(action.output, swap.expected.toString()),
    minimumOutput: assetAmount(action.output, swap.minimum.toString()),
  };
}

export const kyberswapAdapter: ProtocolAdapter = {
  id: "kyberswap",
  protocols: ["kyberswap"],
  label: "KyberSwap",

  supports(route: AdapterRoute) {
    if (!aggregatorEnabled()) return false;
    if (route.kind !== "swap" || route.network !== route.destinationNetwork) return false;
    if (!isEvmNetwork(route.network) || kyberChain(route.network) === null || kyberRouter(route.network) === null) return false;
    if (CHAINS[route.network].environment !== "mainnet") return false;
    if (route.input.id === route.output.id) return false;
    // Listed tokens only (the calldata check compares exact addresses); wrap and unwrap stay with the wrap venue.
    const listed = (asset: ResolvedAsset) => asset.canonical && asset.transferOnly !== true && (asset.isNative || asset.address !== null);
    if (!listed(route.input) || !listed(route.output)) return false;
    const wrapPair = (route.input.isNative && route.output.category === "wrapped" && route.output.group === route.input.group) ||
      (route.output.isNative && route.input.category === "wrapped" && route.input.group === route.output.group);
    return !wrapPair;
  },

  async plan(action): Promise<PlannedStep> {
    const swap = await checkedSwap(action, "plan");
    const network = action.network as EvmNetworkKey;
    const transactions = swapTransactions(action, network, swap);
    const fees = await estimateEvmFeeUsd(network, swap.gas + (transactions.length > 1 ? 70_000n : 0n)).catch(() => undefined);
    return {
      protocol: "kyberswap",
      title: title(action),
      mode: "wallet",
      ...amounts(action, swap),
      ...(fees !== undefined ? { feesUsd: fees } : {}),
      estimatedSeconds: action.network === "ethereum" ? 15 : 5,
      settlement: { kind: "same-network" },
      warnings: swap.warnings,
      transactionCount: transactions.length,
      slippageBps: Math.min(action.slippageBps, MAX_SLIPPAGE_BPS),
      floor: "onchain",
      preview: {
        transactions,
        approvalSpender: swap.router.toLowerCase(),
        expiresAt: Math.floor(Date.now() / 1000) + PREVIEW_TTL_SECONDS,
      },
    };
  },

  async prepare({ step, action }): Promise<PreparedPayload> {
    const slippageBps = decodeStepRef(step.quoteRef)?.slippageBps ?? action.slippageBps;
    const sized = { ...action, slippageBps };
    if (!isEvmNetwork(action.network)) throw new PlatformError("NETWORK_UNSUPPORTED", "KyberSwap swaps run on an EVM network.", 422);
    const network: EvmNetworkKey = action.network;
    await assertEvmBalance(network, action.account.address, action.input.isNative ? null : action.input.address, BigInt(action.amount), action.input.symbol, action.input.decimals);
    const swap = await checkedSwap(sized, "prepare");
    const transactions = swapTransactions(sized, network, swap);
    const fees = await estimateEvmFeeUsd(network, swap.gas).catch(() => undefined);
    return {
      transactions,
      records: transactions.map((transaction) => ({ vm: "evm" as const, network, to: transaction.vm === "evm" ? transaction.to : "", description: transaction.description })),
      ...amounts(sized, swap),
      ...(fees !== undefined ? { feesUsd: fees } : {}),
      warnings: swap.warnings,
    };
  },

  async verify(context): Promise<VerificationResult> {
    const observedAt = new Date(context.now).toISOString();
    return (await verifyEvmReceipts(context, (receipts) => proveSameNetworkSwap(context.step, receipts, observedAt, "KyberSwap"))).result;
  },
};
