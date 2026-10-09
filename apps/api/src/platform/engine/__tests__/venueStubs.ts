/**
 * Offline stubs for the engine-core hooks: lending adapters that read their
 * venue from the registry (deposit / withdraw, close-position) and bridge
 * venues with scripted quotes (minimum, seconds, extra costs, failures,
 * hangs) for the cross-network auction. Used with the shared STUB_ADAPTERS.
 */
import {
  applySlippage,
  CHAINS,
  formatAssetId,
  fromBaseUnits,
  getYieldVenue,
  nativeAssetId,
  venueContracts,
  YIELD_VENUES,
  type AssetAmount,
  type NetworkKey,
  type ProtocolId,
  type TransactionRequest,
} from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { configurePlatform } from "../service.js";
import { MemoryIntentStore } from "../store.js";
import { assetAmount, type ResolvedAsset } from "../assets.js";
import type { AdapterAction, PlannedStep, PreparedPayload, ProtocolAdapter } from "../adapters/types.js";
import { resetEngine, STUB_ADAPTERS, unsignedSolanaTransaction } from "./helpers.js";

/* ---------------------------------------------------------------- lending */

export const lending = {
  /** Underlying base units the stub reports as the open position (close-position withdraws). */
  position: "123450000",
  /** Every action the lending stubs planned or prepared, in order. */
  calls: [] as AdapterAction[],
};

function receiptAsset(action: AdapterAction): ResolvedAsset {
  const venue = getYieldVenue(action.venue ?? "");
  if (!venue || !("receipt" in venue)) return action.input;
  const solana = CHAINS[action.network].vm === "svm";
  return {
    ...action.input,
    id: formatAssetId(action.network, solana ? "token" : "erc20", venue.receipt.address),
    symbol: `r${action.input.symbol}`,
    decimals: venue.receipt.decimals,
    address: venue.receipt.address,
    canonical: false,
  };
}

function lendingPlan(protocol: ProtocolId, action: AdapterAction): PlannedStep {
  lending.calls.push(action);
  const venue = getYieldVenue(action.venue ?? "");
  if (!venue || venue.protocol !== protocol || venue.network !== action.network) {
    throw new PlatformError("VENUE_MISSING", `Stub ${protocol} got venue ${String(action.venue)}.`, 500);
  }
  const withdraw = action.kind === "withdraw";
  const units = withdraw && action.closePosition ? lending.position : action.amount;
  const output = withdraw ? action.input : receiptAsset(action);
  const outUnits = withdraw ? units : (BigInt(units) * 10n ** BigInt(output.decimals) / 10n ** BigInt(action.input.decimals)).toString();
  return {
    protocol,
    title: `${withdraw ? "Withdraw" : "Deposit"} ${fromBaseUnits(units, action.input.decimals)} ${action.input.symbol} ${withdraw ? "from" : "into"} ${venue.name}`,
    mode: "wallet",
    input: assetAmount(action.input, units),
    expectedOutput: assetAmount(output, outUnits),
    minimumOutput: assetAmount(output, outUnits),
    estimatedSeconds: 10,
    settlement: { kind: "same-network" },
    warnings: [],
    transactionCount: 1,
    slippageBps: action.slippageBps,
  };
}

function lendingTransaction(action: AdapterAction, target: string): TransactionRequest {
  if (CHAINS[action.network].vm === "svm") {
    return {
      vm: "svm",
      network: action.network,
      feePayer: action.account.address,
      transaction: unsignedSolanaTransaction(action.account.address, target),
      encoding: "base64",
      description: `stub ${action.kind}`,
    };
  }
  return {
    vm: "evm",
    network: action.network,
    chainId: CHAINS[action.network].evmChainId as number,
    from: action.account.address,
    to: target,
    data: action.closePosition ? "0xffff" : "0x1234",
    value: "0",
    description: `stub ${action.kind}`,
  };
}

export function stubLending(protocol: ProtocolId): ProtocolAdapter {
  const adapter: ProtocolAdapter = {
    id: protocol,
    protocols: [protocol],
    label: `Stub ${protocol}`,
    supports: (route) => (route.kind === "deposit" || route.kind === "withdraw") && route.network === route.destinationNetwork &&
      YIELD_VENUES.some((venue) => venue.protocol === protocol && venue.network === route.network),
    plan: async (action) => lendingPlan(protocol, action),
    prepare: async ({ action }): Promise<PreparedPayload> => {
      const plan = lendingPlan(protocol, action);
      const venue = getYieldVenue(action.venue ?? "");
      const transaction = lendingTransaction(action, venue?.target as string);
      return {
        transactions: [transaction],
        records: [transaction.vm === "evm"
          ? { vm: "evm", network: action.network, to: transaction.to, description: transaction.description }
          : { vm: "svm", network: action.network, feePayer: transaction.feePayer, to: venue?.target as string, description: transaction.description }],
        input: plan.input,
        expectedOutput: plan.expectedOutput,
        minimumOutput: plan.minimumOutput,
        warnings: [],
      };
    },
    verify: async () => ({ status: "confirmed", evidence: [] }),
  };
  return adapter;
}

export const LENDING_STUBS: readonly ProtocolAdapter[] = (["compound-v3", "morpho", "moonwell", "jupiter-lend", "kamino"] as const).map(stubLending);

/* ------------------------------------------------------------- bridges */

export interface VenueScript {
  /** Guaranteed output as bps of the input (same-group assets, decimals rescaled). */
  minimumBps: number;
  seconds: number;
  transactions?: number;
  /** Extra costs reported by plan (and by prepare unless `preparedCosts` is set). */
  extraCosts?: (action: AdapterAction) => AssetAmount[];
  preparedCosts?: (action: AdapterAction) => AssetAmount[];
  /** Plan throws this code. */
  fail?: string;
  /** Plan never settles. */
  hang?: boolean;
  quoteId?: string;
}

export const venueScripts: Record<string, VenueScript> = {};
/** Every action the bridge stubs planned or prepared, in order. */
export const bridgeCalls: AdapterAction[] = [];
export const BRIDGE_NETWORKS: readonly NetworkKey[] = ["base", "arbitrum", "ethereum", "optimism", "polygon", "solana"];

function scaled(action: AdapterAction, bps: number): string {
  const units = BigInt(action.amount) * 10n ** BigInt(action.output.decimals) / 10n ** BigInt(action.input.decimals);
  return (units * BigInt(bps) / 10_000n).toString();
}

function venuePlan(protocol: ProtocolId, action: AdapterAction, prepare: boolean): PlannedStep {
  const script = venueScripts[protocol] ?? { minimumBps: 9_900, seconds: 30 };
  const minimum = scaled(action, script.minimumBps);
  const expected = scaled(action, Math.min(10_000, script.minimumBps + 50));
  const costs = (prepare ? script.preparedCosts ?? script.extraCosts : script.extraCosts)?.(action) ?? [];
  return {
    protocol,
    title: `${protocol} bridge ${action.input.symbol}`,
    mode: "wallet",
    input: assetAmount(action.input, action.amount),
    expectedOutput: assetAmount(action.output, expected),
    minimumOutput: assetAmount(action.output, applySlippage(minimum, 0)),
    ...(costs.length > 0 ? { extraCosts: costs } : {}),
    estimatedSeconds: script.seconds,
    settlement: { kind: "cross-network", destinationNetwork: action.destinationNetwork, expectedSeconds: script.seconds },
    warnings: [],
    ...(script.quoteId ? { quoteId: script.quoteId } : {}),
    transactionCount: script.transactions ?? 1,
    slippageBps: action.slippageBps,
  };
}

export function stubBridge(protocol: ProtocolId, label: string): ProtocolAdapter {
  return {
    id: protocol,
    protocols: [protocol],
    label,
    supports: (route) => route.kind === "bridge" && route.network !== route.destinationNetwork &&
      BRIDGE_NETWORKS.includes(route.network) && BRIDGE_NETWORKS.includes(route.destinationNetwork),
    plan: async (action) => {
      bridgeCalls.push(action);
      const script = venueScripts[protocol];
      if (script?.hang) await new Promise<never>(() => undefined);
      if (script?.fail) throw new PlatformError(script.fail, `${label} refused the route.`, 422);
      return venuePlan(protocol, action, false);
    },
    prepare: async ({ action }): Promise<PreparedPayload> => {
      bridgeCalls.push(action);
      const plan = venuePlan(protocol, action, true);
      const target = venueContracts(protocol, action.network)[0] ?? "0x000000000000000000000000000000000000bEEF";
      const value = (plan.extraCosts ?? []).filter((cost) => cost.asset.endsWith("/slip44:60")).reduce((sum, cost) => sum + BigInt(cost.amount), 0n);
      const transaction: TransactionRequest = {
        vm: "evm",
        network: action.network,
        chainId: CHAINS[action.network].evmChainId as number,
        from: action.account.address,
        to: target,
        data: "0xabcdef",
        value: value.toString(),
        description: `${label} deposit`,
      };
      return {
        transactions: [transaction],
        records: [{ vm: "evm", network: action.network, to: target, description: transaction.description }],
        input: plan.input,
        expectedOutput: plan.expectedOutput,
        minimumOutput: plan.minimumOutput,
        ...(plan.extraCosts ? { extraCosts: plan.extraCosts } : {}),
        warnings: [],
      };
    },
    verify: async () => ({ status: "confirmed", evidence: [] }),
    poll: async () => ({ status: "settling", evidence: [] }),
  };
}

export const BRIDGE_STUBS: readonly ProtocolAdapter[] = [
  stubBridge("relay", "Relay venue"),
  stubBridge("lifi", "LI.FI venue"),
  stubBridge("debridge-dln", "DLN venue"),
];

/** resetEngine() plus the lending stubs (and, optionally, scripted bridge venues instead of the shared Relay stub). */
export function resetVenueEngine(options: { bridges?: boolean } = {}): MemoryIntentStore {
  resetEngine();
  lending.position = "123450000";
  lending.calls.length = 0;
  bridgeCalls.length = 0;
  for (const key of Object.keys(venueScripts)) delete venueScripts[key];
  const store = new MemoryIntentStore();
  const base = options.bridges ? STUB_ADAPTERS.filter((adapter) => adapter.id !== "relay") : STUB_ADAPTERS;
  configurePlatform({ store, adapters: [...base, ...LENDING_STUBS, ...(options.bridges ? BRIDGE_STUBS : [])] });
  return store;
}

/** An extra cost in the network's native asset, priced in USD. */
export function nativeCost(network: NetworkKey, units: string, usd?: number): AssetAmount {
  const chain = CHAINS[network];
  return {
    asset: nativeAssetId(network),
    symbol: chain.nativeAsset.symbol,
    decimals: chain.nativeAsset.decimals,
    amount: units,
    formatted: fromBaseUnits(units, chain.nativeAsset.decimals),
    ...(usd !== undefined ? { usd } : {}),
  };
}
