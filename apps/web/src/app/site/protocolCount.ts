/**
 * One way to count protocols everywhere the site prints a number.
 *
 * The registry also lists two "custom" entries (EVM contract calls and Solana
 * Actions): they are the doors for bring-your-own-contract, not protocols.
 * Counts therefore include only entries whose category is not "custom", and
 * your own contracts are named separately ("42 protocols + your own
 * contracts"). Pure, dependency-free and safe for the entry bundle.
 *
 * "Executable through the API" is computed from GET /v1/protocols, never
 * typed: a real protocol whose `executable` is true (the deployment has a
 * live adapter for it) and whose `surface` is "platform" (planned and run by
 * Platform API v1, not only by the console or a separate service). The
 * registry compiled into @kletia/core cannot know which adapters a
 * deployment runs, so without a live answer that count is unknown (null),
 * never guessed.
 */

/** The registry category of bring-your-own-contract entries. */
export const OWN_CONTRACT_CATEGORY = "custom";

export type ProtocolSurfaceName = "platform" | "console" | "service";

interface Categorized {
  readonly category?: unknown;
}

interface Countable extends Categorized {
  readonly executable?: unknown;
  readonly surface?: unknown;
  readonly execution?: unknown;
}

/** True for the bring-your-own-contract entries (`custom-call`, `solana-actions`). */
export function isOwnContractEntry(entry: Categorized): boolean {
  return entry.category === OWN_CONTRACT_CATEGORY;
}

/** Registry entries that are real protocols (every category except "custom"). */
export function realProtocols<T extends Categorized>(entries: readonly T[]): T[] {
  return entries.filter((entry) => !isOwnContractEntry(entry));
}

/**
 * Where an entry executes: the live API's `surface`, else the registry's
 * `execution` ("console" or "service"), else "platform". An unknown value
 * from a newer API is never read as "platform".
 */
export function surfaceOf(entry: Countable): ProtocolSurfaceName | "unknown" {
  const value = entry.surface ?? entry.execution ?? "platform";
  return value === "platform" || value === "console" || value === "service" ? value : "unknown";
}

/** A real protocol this deployment executes through Platform API v1 (live data only). */
export function isExecutableThroughApi(entry: Countable): boolean {
  return !isOwnContractEntry(entry) && entry.executable === true && surfaceOf(entry) === "platform";
}

export interface ProtocolCount {
  /** Real protocols (category is not "custom"). */
  readonly protocols: number;
  /** Whether the list offers bring-your-own-contract entries. */
  readonly ownContracts: boolean;
  /**
   * Real protocols executable through the API, or null when the list carries
   * no live `executable` flags (the registry view).
   */
  readonly executable: number | null;
}

export function countProtocols(entries: readonly Countable[]): ProtocolCount {
  let protocols = 0;
  let ownContracts = false;
  let executable = 0;
  let live = false;
  for (const entry of entries) {
    if (isOwnContractEntry(entry)) {
      ownContracts = true;
      continue;
    }
    protocols += 1;
    if (typeof entry.executable === "boolean") live = true;
    if (isExecutableThroughApi(entry)) executable += 1;
  }
  return { protocols, ownContracts, executable: live ? executable : null };
}

/** "29 protocols" / "1 protocol". */
export function protocolNoun(count: number): string {
  return `${count} ${count === 1 ? "protocol" : "protocols"}`;
}

/** "29 protocols + your own contracts" (or just "29 protocols" when the list has no custom entries). */
export function protocolCountLabel(entries: readonly Categorized[]): string {
  const { protocols, ownContracts } = countProtocols(entries);
  return ownContracts ? `${protocolNoun(protocols)} + your own contracts` : protocolNoun(protocols);
}

/**
 * The Protocols page header: "42 protocols, 28 executable through the API,
 * + your own contracts". Without live flags the middle part is left out
 * ("42 protocols + your own contracts"), never estimated.
 */
export function protocolHeadline(entries: readonly Countable[]): string {
  const { protocols, ownContracts, executable } = countProtocols(entries);
  const parts = [protocolNoun(protocols)];
  if (executable !== null) parts.push(`${executable} executable through the API`);
  if (!ownContracts) return parts.join(", ");
  return executable !== null ? `${parts.join(", ")}, + your own contracts` : `${parts[0]} + your own contracts`;
}

/* ------------------------------------------------- the capability index */

/** One row of @kletia/core `capabilityIndex()`: a protocol the registry pins as executing a kind on a network. */
export interface CapabilityRowLike {
  readonly network: string;
  readonly kind: string;
  readonly protocol: string;
}

export interface RouteCount {
  /** Distinct protocols with at least one pinned route (what GET /v1/protocols reports executable when every adapter runs). */
  readonly protocols: number;
  /** Distinct protocols per network. */
  readonly byNetwork: Readonly<Record<string, number>>;
}

/**
 * Counts from the capability index (registry data, no deployment knowledge):
 * the number the README and the site print as "executable through the API"
 * when no live answer is at hand is this one, never typed.
 */
export function countRoutes(rows: readonly CapabilityRowLike[]): RouteCount {
  const all = new Set<string>();
  const byNetwork = new Map<string, Set<string>>();
  for (const row of rows) {
    all.add(row.protocol);
    const set = byNetwork.get(row.network) ?? new Set<string>();
    set.add(row.protocol);
    byNetwork.set(row.network, set);
  }
  return { protocols: all.size, byNetwork: Object.fromEntries([...byNetwork].map(([network, set]) => [network, set.size])) };
}

/** "53 protocols, 42 of them executable through the API" (registry entries and capability index). */
export function registryHeadline(entries: readonly Categorized[], rows: readonly CapabilityRowLike[]): string {
  const { protocols } = countProtocols(entries as readonly Countable[]);
  return `${protocolNoun(protocols)}, ${countRoutes(rows).protocols} of them executable through the API`;
}
