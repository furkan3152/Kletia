/**
 * Pure helpers for protocol and network data shown on /protocols, /networks
 * and the home page. Everything here tolerates live API data that is newer
 * than this bundle: unknown categories, unknown network keys, missing arrays.
 */
import { CHAINS, isNetworkKey, type ProtocolCapability, type ProtocolDescriptor } from "@kletia/core";

/** A protocol as returned by GET /v1/protocols (the live API adds `executable`). */
export type ProtocolEntry = ProtocolDescriptor & { readonly executable?: boolean };

export const CAPABILITIES: readonly ProtocolCapability[] = ["execute", "quote", "discover"];

export const CAPABILITY_LABEL: Readonly<Record<ProtocolCapability, string>> = {
  execute: "Execute",
  quote: "Quote",
  discover: "Discover",
};

/** Tooltip text: what each capability means (also used in the legend). */
export const CAPABILITY_HELP: Readonly<Record<ProtocolCapability, string>> = {
  execute: "Kletia builds wallet-ready, unsigned transactions for this venue.",
  quote: "Kletia returns live quotes and routes; execution happens elsewhere.",
  discover: "Read-only market, yield or name data. Nothing is executed.",
};

/** Top stripe colour by strongest capability. */
export const CAPABILITY_STRIPE: Readonly<Record<ProtocolCapability, string>> = {
  execute: "#0052FF",
  quote: "#FFD60A",
  discover: "#94A3B8",
};

export function capabilitiesOf(protocol: { readonly capabilities?: readonly string[] }): ProtocolCapability[] {
  const list = Array.isArray(protocol.capabilities) ? protocol.capabilities : [];
  return CAPABILITIES.filter((capability) => list.includes(capability));
}

export function networksOf(protocol: { readonly networks?: readonly string[] }): string[] {
  return Array.isArray(protocol.networks) ? [...protocol.networks] : [];
}

/** Intent kinds on a network (live `/v1/networks` may be newer than the registry; never assume the array). */
export function actionsOf(network: { readonly actions?: readonly string[] }): string[] {
  return Array.isArray(network.actions) ? [...network.actions] : [];
}

export function strongestCapability(protocol: ProtocolEntry): ProtocolCapability {
  return capabilitiesOf(protocol)[0] ?? "discover";
}

/** "dex-aggregator" -> "Dex aggregator"; unknown values are humanized the same way. */
export function humanizeCategory(category: string): string {
  const text = String(category || "other").replace(/[-_]+/gu, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Other";
}

export interface NetworkLabel {
  readonly key: string;
  readonly name: string;
  readonly shortName: string;
  /** Network colour, or null for keys this bundle does not know. */
  readonly color: string | null;
  readonly known: boolean;
}

export function networkLabel(key: string): NetworkLabel {
  if (isNetworkKey(key)) {
    const chain = CHAINS[key];
    return { key, name: chain.name, shortName: chain.shortName || chain.name, color: chain.color, known: true };
  }
  return { key, name: key, shortName: key, color: null, known: false };
}

export interface ProtocolTotals {
  readonly protocols: number;
  readonly execute: number;
  readonly crossChain: number;
  readonly networks: number;
}

export function protocolTotals(protocols: readonly ProtocolEntry[]): ProtocolTotals {
  const networks = new Set<string>();
  let execute = 0;
  let crossChain = 0;
  for (const protocol of protocols) {
    if (capabilitiesOf(protocol).includes("execute")) execute += 1;
    if (protocol.crossChain) crossChain += 1;
    for (const key of networksOf(protocol)) networks.add(key);
  }
  return { protocols: protocols.length, execute, crossChain, networks: networks.size };
}

export type CapabilityCounts = Readonly<Record<ProtocolCapability, number>>;

export function capabilityCounts(protocols: readonly ProtocolEntry[]): CapabilityCounts {
  const counts: Record<ProtocolCapability, number> = { execute: 0, quote: 0, discover: 0 };
  for (const protocol of protocols) {
    for (const capability of capabilitiesOf(protocol)) counts[capability] += 1;
  }
  return counts;
}

export function protocolsOnNetwork(protocols: readonly ProtocolEntry[], key: string): ProtocolEntry[] {
  return protocols.filter((protocol) => networksOf(protocol).includes(key));
}

/** Union of intent kinds across networks (deduplicated). */
export function intentKinds(networks: readonly { readonly actions?: readonly string[] }[]): string[] {
  const kinds = new Set<string>();
  for (const network of networks) for (const action of actionsOf(network)) kinds.add(action);
  return [...kinds];
}

/** A View Transition name safe for any id: `proto-` + `[a-z0-9-]`. */
export function protocolTransitionName(id: string): string {
  const safe = String(id)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return `proto-${safe || "x"}`;
}

/** Only https links leave the site. */
export function safeWebsite(url: unknown): string | null {
  return typeof url === "string" && /^https:\/\//u.test(url) ? url : null;
}
