/**
 * Registries served by GET /v1/networks, /v1/protocols and /v1/assets.
 *
 * Per-network capabilities are derived, not hand-maintained: every adapter the
 * engine currently executes with (`activeProtocolAdapters()`, which embedders
 * may replace through `configurePlatform`) is probed with every canonical
 * asset pair and action kind on that network (and every destination in the
 * same capital lane). What the registry lists is therefore exactly what the
 * planner can route today. Results are cached per adapter set.
 *
 * Custom contract kinds (`call` on EVM networks, `action` on Solana) are not
 * routes: they need a registration (POST /v1/contracts). A network lists them
 * under `customContracts`, and in `actions` while the custom contract adapter
 * is active and the deployment has not disabled custom contracts.
 */
import {
  ASSETS,
  CHAINS,
  CONTRACT_ACTION_KINDS,
  INTENT_ACTION_KINDS,
  NETWORK_KEYS,
  PROTOCOLS,
  contractProtocol,
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
import { contractsEnabled } from "./contractChecks.js";
import { invalidRequest } from "./context.js";

type RouteAsset = ResolvedAsset;

/** Every intent action kind (OpenAPI enum), from @kletia/core. */
export const ACTION_KINDS: readonly IntentActionKind[] = INTENT_ACTION_KINDS;

/** Kinds the route search probes adapters with (custom contract kinds are bound to registrations, never routed). */
const ROUTED_ACTION_KINDS: readonly IntentActionKind[] = INTENT_ACTION_KINDS.filter((kind) => !CONTRACT_ACTION_KINDS.includes(kind));

/** How a network takes integrator contracts: EVM networks `call` (custom-call), Solana `action` (solana-actions). */
export interface CustomContractCapability {
  readonly kind: "call" | "action";
  readonly protocol: ProtocolId;
  /** False while the deployment disables custom contracts or no adapter executes them. */
  readonly enabled: boolean;
}

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
  readonly customContracts: CustomContractCapability;
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
  for (const kind of ROUTED_ACTION_KINDS) {
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

let networks: { readonly adapters: readonly ProtocolAdapter[]; readonly enabled: boolean; readonly value: readonly NetworkCapabilities[] } | null = null;

export function networkCapabilities(): readonly NetworkCapabilities[] {
  const adapters = activeProtocolAdapters();
  const enabled = contractsEnabled();
  if (networks?.adapters === adapters && networks.enabled === enabled) return networks.value;
  const executable = new Set<ProtocolId>(adapters.flatMap((adapter) => adapter.protocols));
  const value = Object.freeze(
    NETWORK_KEYS.map((key): NetworkCapabilities => {
      const routes = deriveRoutes(adapters, key);
      const vm = CHAINS[key].vm;
      const protocol = contractProtocol(vm);
      const custom: CustomContractCapability = {
        kind: vm === "evm" ? "call" : "action",
        protocol,
        enabled: enabled && executable.has(protocol) && PROTOCOLS.some((entry) => entry.id === protocol && entry.networks.includes(key)),
      };
      return {
        ...CHAINS[key],
        actions: ACTION_KINDS.filter((kind) => routes.some((route) => route.kind === kind) || (custom.enabled && kind === custom.kind)),
        protocols: PROTOCOLS.filter((entry) => entry.networks.includes(key)).map((entry) => entry.id),
        executableProtocols: [...new Set([...routes.map((route) => route.protocol), ...(custom.enabled ? [protocol] : [])])],
        routes,
        assetCount: ASSETS.filter((asset) => asset.network === key).length,
        customContracts: custom,
      };
    }),
  );
  networks = { adapters, enabled, value };
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
/** Filter of GET /v1/venues: a known network (key, CAIP-2 id or EVM chain id) and a lending protocol id. */
export function venueFilter(network: string | undefined, protocol: string | undefined): { network?: NetworkKey; protocol?: ProtocolId } {
  const filter: { network?: NetworkKey; protocol?: ProtocolId } = {};
  if (network !== undefined && network !== "") {
    const chain = resolveChain(network);
    if (!chain) {
      throw invalidRequest(`Unknown network "${network.slice(0, 40)}". Use a key such as ${NETWORK_KEYS.join(", ")} or a CAIP-2 id.`, [
        { path: "network", message: "Unknown network." },
      ]);
    }
    filter.network = chain.key;
  }
  if (protocol !== undefined && protocol !== "") {
    const lending = PROTOCOLS.filter((entry) => entry.kinds?.includes("deposit")).map((entry) => entry.id);
    if (!lending.includes(protocol as ProtocolId)) {
      throw invalidRequest(`Unknown lending protocol "${protocol.slice(0, 40)}". Use one of ${lending.join(", ")}.`, [
        { path: "protocol", message: "Unknown lending protocol." },
      ]);
    }
    filter.protocol = protocol as ProtocolId;
  }
  return filter;
}

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
