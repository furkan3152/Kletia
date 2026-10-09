/**
 * Recipient name resolution hook.
 *
 * The planner resolves recipients that look like names (`*.eth`,
 * `*.base.eth`, `*.sns`, `*.sol`) through the resolvers registered here,
 * records the resolution as step evidence plus `IntentStep.recipientName`,
 * and the service resolves the name again before every prepare, refusing
 * (RECIPIENT_NAME_CHANGED) when the address moved. Resolution fails closed:
 * no resolver, no address or an unreadable resolver is an error, never a
 * guess.
 *
 * This module registers no resolver. Name-service modules (ENS, Basenames,
 * SNS) call `registerNameResolver` once at startup.
 */
import { CHAINS, type NetworkKey, type ProtocolId } from "@kletia/core";
import { isPlatformError, PlatformError } from "../errors.js";

export interface NameResolution {
  /** Normalised name that was resolved (e.g. ENSIP-15 normalised). */
  readonly name: string;
  /** Address the name points to for `network` (0x address or base58 public key). */
  readonly address: string;
  /** Name service that produced the address. */
  readonly protocol: ProtocolId;
  /** Human-readable proof: resolver contract or registry account, coin type, block or slot. */
  readonly detail: string;
  /** Block number or slot the record was read at, when known. */
  readonly reference?: string;
  readonly warnings?: readonly string[];
}

export interface NameResolver {
  /** Stable id, e.g. "ens", "basenames", "sns". */
  readonly id: string;
  readonly protocol: ProtocolId;
  /**
   * Lower-case suffixes this resolver owns, e.g. [".eth"] or [".base.eth"].
   * The resolver with the longest matching suffix wins; ties go to the first
   * registered.
   */
  readonly suffixes: readonly string[];
  /** Networks whose recipients this resolver can resolve. */
  readonly networks: readonly NetworkKey[];
  /**
   * Resolves `name` (already lower-cased and trimmed) for a recipient on
   * `network`. Returns null when the name has no address for that network;
   * throws when the records cannot be read.
   */
  resolve(name: string, network: NetworkKey): Promise<NameResolution | null>;
}

/** Labels of 1-63 [a-z0-9-] (no leading/trailing hyphen), 3-253 characters, ending in a supported TLD. */
const NAME_PATTERN = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:eth|sns|sol)$/u;
const RESOLVE_TIMEOUT_MS = 8_000;

const resolvers: NameResolver[] = [];

/** True when a recipient string is a name to resolve rather than an address. */
export function looksLikeName(value: string): boolean {
  return NAME_PATTERN.test(value.trim().toLowerCase());
}

/** Lower-cases and trims; resolvers apply their own normalisation (ENSIP-15) on top. */
export function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

/** Registers a resolver; returns a function that removes it again. */
export function registerNameResolver(resolver: NameResolver): () => void {
  if (resolver.suffixes.length === 0 || resolver.suffixes.some((suffix) => !/^\.[a-z0-9.-]+$/u.test(suffix))) {
    throw new PlatformError("NAME_RESOLVER_INVALID", `Resolver ${resolver.id} declares invalid suffixes.`, 500);
  }
  if (resolvers.some((entry) => entry.id === resolver.id)) {
    throw new PlatformError("NAME_RESOLVER_INVALID", `A resolver with id ${resolver.id} is already registered.`, 500);
  }
  resolvers.push(resolver);
  return () => {
    const index = resolvers.indexOf(resolver);
    if (index !== -1) resolvers.splice(index, 1);
  };
}

export function nameResolvers(): readonly NameResolver[] {
  return [...resolvers];
}

/** Removes every resolver (tests). */
export function resetNameResolvers(): void {
  resolvers.length = 0;
}

function suffixLength(resolver: NameResolver, name: string): number {
  return Math.max(0, ...resolver.suffixes.filter((suffix) => name.endsWith(suffix)).map((suffix) => suffix.length));
}

/** The resolver responsible for `name` on `network`, or null. */
export function resolverFor(name: string, network: NetworkKey): NameResolver | null {
  const normalized = normalizeName(name);
  let best: NameResolver | null = null;
  let bestLength = 0;
  for (const resolver of resolvers) {
    if (!resolver.networks.includes(network)) continue;
    const length = suffixLength(resolver, normalized);
    if (length > bestLength) {
      best = resolver;
      bestLength = length;
    }
  }
  return best;
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), RESOLVE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Resolves a recipient name for `network`. Throws RECIPIENT_NAME_UNSUPPORTED
 * (no resolver), RECIPIENT_NAME_UNRESOLVED (no address for that network) or
 * NAME_RESOLUTION_UNAVAILABLE (records could not be read).
 */
export async function resolveRecipientName(name: string, network: NetworkKey): Promise<NameResolution> {
  const normalized = normalizeName(name);
  const chain = CHAINS[network];
  if (!looksLikeName(normalized)) {
    throw new PlatformError("RECIPIENT_INVALID", `"${name.slice(0, 64)}" is not a supported name.`, 422);
  }
  const resolver = resolverFor(normalized, network);
  if (!resolver) {
    throw new PlatformError(
      "RECIPIENT_NAME_UNSUPPORTED",
      `Kletia cannot resolve "${normalized.slice(0, 64)}" for ${chain.name} on this deployment. Use the recipient's address.`,
      422,
      [{ path: "recipient", message: "No name resolver for this name and network." }],
    );
  }
  let resolution: NameResolution | null;
  try {
    resolution = await withTimeout(resolver.resolve(normalized, network));
  } catch (error) {
    // A resolver may refuse a name deliberately (e.g. a paused TLD): keep its 4xx. Anything else is unavailability.
    if (isPlatformError(error) && error.status >= 400 && error.status < 500) throw error;
    throw new PlatformError(
      "NAME_RESOLUTION_UNAVAILABLE",
      `The ${resolver.id} records for "${normalized.slice(0, 64)}" could not be read. Try again shortly or use an address.`,
      503,
    );
  }
  if (!resolution || !resolution.address) {
    throw new PlatformError(
      "RECIPIENT_NAME_UNRESOLVED",
      `"${normalized.slice(0, 64)}" has no ${chain.name} address.`,
      422,
      [{ path: "recipient", message: "The name does not resolve for this network." }],
    );
  }
  return resolution;
}
