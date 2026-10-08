/**
 * Registries served by GET /v1/networks, /v1/protocols and /v1/assets.
 *
 * Per-network capabilities are derived, not hand-maintained: every adapter the
 * engine currently executes with (`activeProtocolAdapters()`, which embedders
 * may replace through `configurePlatform`) is probed with every canonical
 * asset pair and action kind on that network (and every destination in the
 * same capital lane). What the registry lists is therefore exactly what the
 * planner can route today. Results are cached per adapter set.
 */
import {
  ASSETS,
  CHAINS,
  NETWORK_KEYS,
  PROTOCOLS,
  resolveChain,
  sameCapitalLane,
  type AssetDescriptor,
  type ChainDescriptor,
  type IntentActionKind,
  type NetworkKey,
  type ProtocolDescriptor,
  type ProtocolId,
} from "@kletia/core";
import { activeProtocolAdapters, effectiveProtocol, type AdapterRoute, type ProtocolAdapter, type ResolvedAsset } from "../index.js";
import { invalidRequest } from "./context.js";

type RouteAsset = ResolvedAsset;

export const ACTION_KINDS = [
  "swap",
  "transfer",
  "bridge",
  "stake",
  "unstake",
  "deposit",
  "withdraw",
  "borrow",
  "repay",
  "approve",
  "claim",
  "read",
] as const satisfies readonly IntentActionKind[];

export interface NetworkRoute {
  readonly kind: IntentActionKind;
  readonly protocol: ProtocolId;
  /** Destination networks this route can deliver to (the network itself for same-network actions). */
  readonly toNetworks: readonly NetworkKey[];
}

export interface NetworkCapabilities extends ChainDescriptor {
  /** Action kinds the planner can execute with this network as the source. */
  readonly actions: readonly IntentActionKind[];
  /** Registry protocols present on this network (any capability). */
  readonly protocols: readonly ProtocolId[];
  /** Protocols with a live execution adapter on this network. */
  readonly executableProtocols: readonly ProtocolId[];
  readonly routes: readonly NetworkRoute[];
  readonly assetCount: number;
}

export interface ProtocolView extends ProtocolDescriptor {
  /** True when the engine has an execution adapter for this protocol id. */
  readonly executable: boolean;
}

function routeAsset(asset: AssetDescriptor): RouteAsset {
  return {
    network: asset.network,
    id: asset.id,
    symbol: asset.symbol,
    name: asset.name,
    decimals: asset.decimals,
    address: asset.address,
    isNative: asset.address === null,
    canonical: true,
    verified: true,
    category: asset.category,
    ...(asset.group ? { group: asset.group } : {}),
  };
}

function supports(adapter: ProtocolAdapter, route: AdapterRoute): boolean {
  try {
    return adapter.supports(route);
  } catch {
    return false;
  }
}

function deriveRoutes(adapters: readonly ProtocolAdapter[], network: NetworkKey): NetworkRoute[] {
  const inputs = ASSETS.filter((asset) => asset.network === network).map(routeAsset);
  const found = new Map<string, { kind: IntentActionKind; protocol: ProtocolId; toNetworks: Set<NetworkKey> }>();
  for (const kind of ACTION_KINDS) {
    for (const destination of NETWORK_KEYS) {
      if (!sameCapitalLane(network, destination)) continue;
      const outputs = ASSETS.filter((asset) => asset.network === destination).map(routeAsset);
      for (const adapter of adapters) {
        for (const input of inputs) {
          for (const output of outputs) {
            const route: AdapterRoute = { kind, network, destinationNetwork: destination, input, output };
            if (!supports(adapter, route)) continue;
            const protocol = effectiveProtocol(adapter, route);
            const key = `${kind}:${protocol}`;
            const entry = found.get(key) ?? { kind, protocol, toNetworks: new Set<NetworkKey>() };
            entry.toNetworks.add(destination);
            found.set(key, entry);
          }
        }
      }
    }
  }
  return [...found.values()].map((entry) => ({
    kind: entry.kind,
    protocol: entry.protocol,
    toNetworks: NETWORK_KEYS.filter((key) => entry.toNetworks.has(key)),
  }));
}

let networks: { readonly adapters: readonly ProtocolAdapter[]; readonly value: readonly NetworkCapabilities[] } | null = null;

export function networkCapabilities(): readonly NetworkCapabilities[] {
  const adapters = activeProtocolAdapters();
  if (networks?.adapters === adapters) return networks.value;
  const value = Object.freeze(
    NETWORK_KEYS.map((key): NetworkCapabilities => {
      const routes = deriveRoutes(adapters, key);
      return {
        ...CHAINS[key],
        actions: ACTION_KINDS.filter((kind) => routes.some((route) => route.kind === kind)),
        protocols: PROTOCOLS.filter((protocol) => protocol.networks.includes(key)).map((protocol) => protocol.id),
        executableProtocols: [...new Set(routes.map((route) => route.protocol))],
        routes,
        assetCount: ASSETS.filter((asset) => asset.network === key).length,
      };
    }),
  );
  networks = { adapters, value };
  return value;
}

let protocols: { readonly adapters: readonly ProtocolAdapter[]; readonly value: readonly ProtocolView[] } | null = null;

export function protocolRegistry(): readonly ProtocolView[] {
  const adapters = activeProtocolAdapters();
  if (protocols?.adapters === adapters) return protocols.value;
  const executable = new Set<ProtocolId>(adapters.flatMap((adapter) => adapter.protocols));
  const value = Object.freeze(PROTOCOLS.map((protocol) => ({ ...protocol, executable: executable.has(protocol.id) })));
  protocols = { adapters, value };
  return value;
}

/** Canonical assets, optionally for one network (key, CAIP-2 id or EVM chain id). */
export function assetRegistry(network: string | undefined): readonly AssetDescriptor[] {
  if (network === undefined || network === "") return ASSETS;
  const chain = resolveChain(network);
  if (!chain) {
    throw invalidRequest(`Unknown network "${network.slice(0, 40)}". Use a key such as ${NETWORK_KEYS.join(", ")} or a CAIP-2 id.`, [
      { path: "network", message: "Unknown network." },
    ]);
  }
  return ASSETS.filter((asset) => asset.network === chain.key);
}
