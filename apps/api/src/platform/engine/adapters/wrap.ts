/**
 * Wrap venue (design B.3, red-team D10): the network's gas asset to its
 * canonical wrapped token and back, 1:1, on the wrapped-native contract
 * pinned in the registry (`VENUE_CONTRACTS`, role `wrapped-native`: WETH9 on
 * Ethereum, Base, Arbitrum One, OP Mainnet and Arbitrum Sepolia, WPOL on
 * Polygon PoS). One transaction, no approval, no slippage:
 *
 * - wrap: `deposit()` with `value` = amount; the contract mints exactly the
 *   amount (event Deposit(account, amount));
 * - unwrap: `withdraw(amount)`; the contract burns the amount and sends the
 *   same amount of the gas asset (event Withdrawal(account, amount)).
 *
 * The swap auction never auctions this pair: when this venue supports a
 * route it serves it alone (auction.ts). Polygon's bridged WETH is not the
 * wrapped gas asset (POL is) and is never served here. Solana's wSOL is not
 * a listed asset, so no route reaches a SOL <-> wSOL wrap.
 *
 * Verify: the bound receipt carries the Deposit / Withdrawal event of the
 * pinned contract for the account and exactly the amount.
 */
import { encodeFunctionData, getAddress, type Hex } from "viem";
import {
  CHAINS,
  formatAmount,
  fromBaseUnits,
  isVenueContract,
  venueContracts,
  type EvmTransactionRequest,
  type StepEvidence,
} from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { assetAmount, type ResolvedAsset } from "../assets.js";
import { estimateEvmFeeUsd, evmChainId, isEvmNetwork, type EvmNetworkKey } from "../chains/evm.js";
import { assertEvmBalance, estimateGas } from "./evmTransfer.js";
import { WETH_ABI } from "./lending/common.js";
import type { AdapterAction, AdapterRoute, PlannedStep, PreparedPayload, ProtocolAdapter, VerificationResult } from "./types.js";
import { evmEvents, stepOwner, verifyEvmReceipts } from "./verification.js";

/** Gas limit of a deposit() / withdraw(amount) (the journey's `wrap` figure; WETH9 needs ~30-45k). */
export const WRAP_GAS = 60_000n;
/** Plan-time transactions are deterministic; they stay previewable for the plan's lifetime. */
const PREVIEW_TTL_SECONDS = 30 * 60;

/** The pinned wrapped gas asset of `network`, or null. */
export function wrappedNativeOf(network: AdapterRoute["network"]): string | null {
  const pins = venueContracts("wrap", network, "wrapped-native");
  return pins.length === 1 ? (pins[0] as string) : null;
}

function isWrapped(asset: ResolvedAsset, network: AdapterRoute["network"]): boolean {
  const pinned = wrappedNativeOf(network);
  return pinned !== null && !asset.isNative && asset.address !== null && asset.network === network && asset.address.toLowerCase() === pinned.toLowerCase();
}

/** "wrap" when the route turns the gas asset into its wrapped token, "unwrap" for the reverse, else null. */
export function wrapDirection(route: Pick<AdapterRoute, "kind" | "network" | "destinationNetwork" | "input" | "output">): "wrap" | "unwrap" | null {
  if (route.kind !== "swap" || route.network !== route.destinationNetwork || !isEvmNetwork(route.network)) return null;
  if (route.input.isNative && route.input.network === route.network && isWrapped(route.output, route.network)) return "wrap";
  if (route.output.isNative && route.output.network === route.network && isWrapped(route.input, route.network)) return "unwrap";
  return null;
}

function network(action: AdapterAction): EvmNetworkKey {
  if (!isEvmNetwork(action.network)) throw new PlatformError("NETWORK_UNSUPPORTED", "Wrapping runs on an EVM network.", 422);
  return action.network;
}

function title(action: AdapterAction, direction: "wrap" | "unwrap"): string {
  const amount = `${formatAmount(fromBaseUnits(action.amount, action.input.decimals))} ${action.input.symbol}`;
  return `${direction === "wrap" ? "Wrap" : "Unwrap"} ${amount} into ${action.output.symbol} on ${CHAINS[action.network].name}`;
}

/** Checks the action and returns its direction and the pinned contract. */
function checked(action: AdapterAction): { readonly direction: "wrap" | "unwrap"; readonly contract: string; readonly network: EvmNetworkKey } {
  const direction = wrapDirection(action);
  const contract = wrappedNativeOf(action.network);
  if (!direction || !contract) {
    throw new PlatformError("ROUTE_UNSUPPORTED", `${action.input.symbol} -> ${action.output.symbol} is not a wrap of the gas asset on ${CHAINS[action.network].name}.`, 422);
  }
  if (action.recipient.address.toLowerCase() !== action.account.address.toLowerCase()) {
    throw new PlatformError("INTENT_UNSUPPORTED", "A wrap pays the acting account; send the result with a separate \"send\" step.", 422);
  }
  if (action.input.decimals !== action.output.decimals) {
    throw new PlatformError("VENUE_INVALID", "The wrapped token's decimals differ from the gas asset's.", 500);
  }
  if (!(BigInt(action.amount) > 0n)) throw new PlatformError("AMOUNT_TOO_SMALL", "Nothing to wrap.", 422);
  return { direction, contract, network: network(action) };
}

/** The wrap / unwrap call (deterministic: no reads), shared by plan (preview) and prepare. */
export function wrapCall(direction: "wrap" | "unwrap", contract: string, amount: bigint): { readonly to: string; readonly data: Hex; readonly value: string } {
  return direction === "wrap"
    ? { to: getAddress(contract), data: encodeFunctionData({ abi: WETH_ABI, functionName: "deposit" }), value: amount.toString() }
    : { to: getAddress(contract), data: encodeFunctionData({ abi: WETH_ABI, functionName: "withdraw", args: [amount] }), value: "0" };
}

function transaction(action: AdapterAction, direction: "wrap" | "unwrap", contract: string, chain: EvmNetworkKey, gas?: string): EvmTransactionRequest {
  return {
    vm: "evm",
    network: chain,
    chainId: evmChainId(chain),
    from: getAddress(action.account.address),
    ...wrapCall(direction, contract, BigInt(action.amount)),
    gas: gas ?? WRAP_GAS.toString(),
    description: title(action, direction),
  };
}

export const wrapAdapter: ProtocolAdapter = {
  id: "wrap",
  protocols: ["wrap"],
  label: "Wrapped native token",

  supports(route) {
    return wrapDirection(route) !== null;
  },

  async plan(action): Promise<PlannedStep> {
    const { direction, contract, network: chain } = checked(action);
    const amount = assetAmount(action.input, action.amount);
    const output = assetAmount(action.output, action.amount);
    const fees = await estimateEvmFeeUsd(chain, WRAP_GAS);
    return {
      protocol: "wrap",
      title: title(action, direction),
      mode: "wallet",
      input: amount,
      expectedOutput: output,
      minimumOutput: output,
      ...(fees !== undefined ? { feesUsd: fees } : {}),
      estimatedSeconds: 10,
      settlement: { kind: "same-network" },
      warnings: [],
      transactionCount: 1,
      // 1:1 by the contract: no slippage.
      slippageBps: 0,
      floor: "onchain",
      preview: {
        transactions: [transaction(action, direction, contract, chain)],
        expiresAt: Math.floor(Date.now() / 1000) + PREVIEW_TTL_SECONDS,
      },
    };
  },

  async prepare({ action }): Promise<PreparedPayload> {
    const { direction, contract, network: chain } = checked(action);
    const value = BigInt(action.amount);
    await assertEvmBalance(chain, action.account.address, action.input.address, value, action.input.symbol, action.input.decimals);
    const call = wrapCall(direction, contract, value);
    const gas = await estimateGas(chain, { from: action.account.address, ...call });
    const prepared = transaction(action, direction, contract, chain, gas);
    const fees = await estimateEvmFeeUsd(chain, gas ? BigInt(gas) : WRAP_GAS);
    return {
      transactions: [prepared],
      records: [{ vm: "evm", network: chain, to: prepared.to, description: prepared.description }],
      input: assetAmount(action.input, action.amount),
      expectedOutput: assetAmount(action.output, action.amount),
      minimumOutput: assetAmount(action.output, action.amount),
      ...(fees !== undefined ? { feesUsd: fees } : {}),
      warnings: [],
    };
  },

  async verify(context): Promise<VerificationResult> {
    const { step } = context;
    const { result } = await verifyEvmReceipts(context, (receipts) => {
      const output = step.minimumOutput;
      const input = step.input;
      if (!output || !input || !isEvmNetwork(step.network)) {
        return { failure: { code: "OUTCOME_NOT_PROVEN", message: "The wrap step lacks its amounts." } };
      }
      const owner = stepOwner(step).toLowerCase();
      const amount = BigInt(input.amount);
      const unwrap = output.asset.includes("/slip44:");
      const contract = wrappedNativeOf(step.network);
      if (!contract || !isVenueContract("wrap", step.network, contract, "wrapped-native")) {
        return { failure: { code: "OUTCOME_NOT_PROVEN", message: "No pinned wrapped-native contract on this network." } };
      }
      const events = unwrap
        ? evmEvents(receipts, { address: contract, abi: WETH_ABI, eventName: "Withdrawal" }).filter((log) => log.args.src.toLowerCase() === owner && log.args.wad === amount)
        : evmEvents(receipts, { address: contract, abi: WETH_ABI, eventName: "Deposit" }).filter((log) => log.args.dst.toLowerCase() === owner && log.args.wad === amount);
      if (events.length === 0) {
        return { failure: { code: "OUTCOME_NOT_PROVEN", message: `The pinned wrapped-native contract did not emit ${unwrap ? "Withdrawal" : "Deposit"} for this account and amount.` } };
      }
      const evidence: StepEvidence = {
        kind: "note",
        network: step.network,
        observedAt: new Date(context.now).toISOString(),
        detail: `${unwrap ? "Unwrapped" : "Wrapped"} ${fromBaseUnits(amount, input.decimals)} ${input.symbol} 1:1 into ${output.symbol}.`,
      };
      return { evidence: [evidence], actualOutput: { ...output, amount: amount.toString(), formatted: fromBaseUnits(amount, output.decimals) } };
    });
    return result;
  },
};
