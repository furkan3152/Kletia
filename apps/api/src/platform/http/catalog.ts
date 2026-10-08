/**
 * Registries served by GET /v1/networks, /v1/protocols and /v1/assets.
 *
 * Per-network capabilities are derived, not hand-maintained: every engine
 * adapter's `supports()` is probed with every canonical asset pair and
 * action kind on that network (and every destination in the same capital
 * lane). What the registry lists is therefore exactly what the planner can
 * route today.
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
import { ADAPTERS, EXECUTABLE_PROTOCOLS, type ProtocolAdapter } from "../index.js";
import { invalidRequest } from "./context.js";

type AdapterRoute = Parameters<ProtocolAdapter["supports"]>[0];
type RouteAsset = AdapterRoute["input"];

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

function effectiveProtocol(adapter: ProtocolAdapter, kind: IntentActionKind, input: RouteAsset): ProtocolId {
  if (kind === "transfer" && adapter.protocols.includes("system-transfer")) {
    return input.isNative ? "system-transfer" : adapter.id;
  }
  return adapter.id;
}

function supports(adapter: ProtocolAdapter, route: AdapterRoute): boolean {
  try {
    return adapter.supports(route);
  } catch {
    return false;
  }
}

function deriveRoutes(network: NetworkKey): NetworkRoute[] {
  const inputs = ASSETS.filter((asset) => asset.network === network).map(routeAsset);
  const found = new Map<string, { kind: IntentActionKind; protocol: ProtocolId; toNetworks: Set<NetworkKey> }>();
  for (const kind of ACTION_KINDS) {
    for (const destination of NETWORK_KEYS) {
      if (!sameCapitalLane(network, destination)) continue;
      const outputs = ASSETS.filter((asset) => asset.network === destination).map(routeAsset);
      for (const adapter of ADAPTERS) {
        for (const input of inputs) {
          for (const output of outputs) {
            if (!supports(adapter, { kind, network, destinationNetwork: destination, input, output })) continue;
            const protocol = effectiveProtocol(adapter, kind, input);
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

let networks: readonly NetworkCapabilities[] | null = null;

export function networkCapabilities(): readonly NetworkCapabilities[] {
  if (networks) return networks;
  networks = Object.freeze(
    NETWORK_KEYS.map((key): NetworkCapabilities => {
      const routes = deriveRoutes(key);
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
  return networks;
}

let protocols: readonly ProtocolView[] | null = null;

export function protocolRegistry(): readonly ProtocolView[] {
  protocols ??= Object.freeze(
    PROTOCOLS.map((protocol) => ({ ...protocol, executable: EXECUTABLE_PROTOCOLS.includes(protocol.id) })),
  );
  return protocols;
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
