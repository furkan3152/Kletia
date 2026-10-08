/**
 * EVM transfers: native gas asset or ERC-20 on Base, Arbitrum One, Arc
 * Testnet and Arbitrum Sepolia.
 */
import { encodeFunctionData, erc20Abi, getAddress, type Hex } from "viem";
import { CHAINS, formatAmount, fromBaseUnits, type EvmTransactionRequest } from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { assetAmount, sameAsset } from "../assets.js";
import { estimateEvmFeeUsd, evmChainId, evmClient, isEvmNetwork, readEvmBalance, type EvmNetworkKey } from "../chains/evm.js";
import { shortAddress } from "../util.js";
import type { AdapterAction, PlannedStep, PreparedPayload, ProtocolAdapter } from "./types.js";
import { verifyEvmReferences } from "./verification.js";

function title(action: Pick<AdapterAction, "amount" | "input" | "recipient" | "network">): string {
  return `Send ${formatAmount(fromBaseUnits(action.amount, action.input.decimals))} ${action.input.symbol} to ${shortAddress(action.recipient.address)} on ${CHAINS[action.network].name}`;
}

function evmNetwork(action: Pick<AdapterAction, "network">): EvmNetworkKey {
  if (!isEvmNetwork(action.network)) throw new PlatformError("NETWORK_UNSUPPORTED", "Not an EVM network.", 422);
  return action.network;
}

/** Throws INSUFFICIENT_BALANCE when `owner` holds less than `amount` of the asset. */
export async function assertEvmBalance(
  network: EvmNetworkKey,
  owner: string,
  token: string | null,
  amount: bigint,
  symbol: string,
  decimals: number,
): Promise<void> {
  const balance = await readEvmBalance(network, owner, token);
  if (balance < amount) {
    throw new PlatformError(
      "INSUFFICIENT_BALANCE",
      `The account holds ${fromBaseUnits(balance, decimals)} ${symbol} on ${CHAINS[network].name}; ${fromBaseUnits(amount, decimals)} is needed.`,
      422,
    );
  }
}

/** Best-effort gas estimate with a 20% buffer. */
export async function estimateGas(network: EvmNetworkKey, request: { from: string; to: string; data: string; value: string }): Promise<string | undefined> {
  try {
    const gas = await evmClient(network).estimateGas({
      account: getAddress(request.from),
      to: getAddress(request.to),
      data: request.data as Hex,
      value: BigInt(request.value),
    });
    return ((gas * 12n) / 10n).toString();
  } catch {
    return undefined;
  }
}

export const evmTransferAdapter: ProtocolAdapter = {
  id: "erc20-transfer",
  protocols: ["erc20-transfer", "system-transfer"],
  label: "EVM transfer",

  supports(route) {
    return (
      route.kind === "transfer" &&
      isEvmNetwork(route.network) &&
      route.destinationNetwork === route.network &&
      sameAsset(route.input, route.output)
    );
  },

  async plan(action): Promise<PlannedStep> {
    const network = evmNetwork(action);
    const amount = assetAmount(action.input, action.amount);
    const fees = await estimateEvmFeeUsd(network, action.input.isNative ? 21_000n : 65_000n);
    return {
      protocol: action.input.isNative ? "system-transfer" : "erc20-transfer",
      title: title(action),
      mode: "wallet",
      input: amount,
      expectedOutput: amount,
      minimumOutput: amount,
      ...(fees !== undefined ? { feesUsd: fees } : {}),
      estimatedSeconds: 10,
      settlement: { kind: "same-network" },
      warnings: action.input.verified ? [] : [`${action.input.symbol} is not in Kletia's canonical registry.`],
      transactionCount: 1,
      slippageBps: action.slippageBps,
    };
  },

  async prepare({ action }): Promise<PreparedPayload> {
    const network = evmNetwork(action);
    const from = getAddress(action.account.address);
    const recipient = getAddress(action.recipient.address);
    const value = BigInt(action.amount);
    await assertEvmBalance(network, from, action.input.address, value, action.input.symbol, action.input.decimals);
    const call = action.input.isNative
      ? { to: recipient as string, data: "0x", value: value.toString() }
      : {
          to: getAddress(action.input.address as string) as string,
          data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipient, value] }),
          value: "0",
        };
    const gas = await estimateGas(network, { from, ...call });
    const description = title(action);
    const transaction: EvmTransactionRequest = {
      vm: "evm",
      network,
      chainId: evmChainId(network),
      from,
      to: call.to,
      data: call.data,
      value: call.value,
      ...(gas ? { gas } : {}),
      description,
    };
    const amount = assetAmount(action.input, action.amount);
    const fees = await estimateEvmFeeUsd(network, gas ? BigInt(gas) : action.input.isNative ? 21_000n : 65_000n);
    return {
      transactions: [transaction],
      records: [{ vm: "evm", network, to: call.to, description }],
      input: amount,
      expectedOutput: amount,
      minimumOutput: amount,
      ...(fees !== undefined ? { feesUsd: fees } : {}),
      warnings: [],
    };
  },

  async verify(context) {
    const result = await verifyEvmReferences(context);
    return result.status === "confirmed" && context.step.input ? { ...result, actualOutput: context.step.input } : result;
  },
};
