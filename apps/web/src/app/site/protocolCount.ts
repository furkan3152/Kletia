/**
 * One way to count protocols everywhere the site prints a number.
 *
 * The registry also lists two "custom" entries (EVM contract calls and Solana
 * Actions): they are the doors for bring-your-own-contract, not protocols.
 * Counts therefore include only entries whose category is not "custom", and
 * your own contracts are named separately ("29 protocols + your own
 * contracts"). Pure, dependency-free and safe for the entry bundle.
 */

/** The registry category of bring-your-own-contract entries. */
export const OWN_CONTRACT_CATEGORY = "custom";

interface Categorized {
  readonly category?: unknown;
}

/** True for the bring-your-own-contract entries (`custom-call`, `solana-actions`). */
export function isOwnContractEntry(entry: Categorized): boolean {
  return entry.category === OWN_CONTRACT_CATEGORY;
}

/** Registry entries that are real protocols (every category except "custom"). */
export function realProtocols<T extends Categorized>(entries: readonly T[]): T[] {
  return entries.filter((entry) => !isOwnContractEntry(entry));
}

export interface ProtocolCount {
  /** Real protocols (category is not "custom"). */
  readonly protocols: number;
  /** Whether the list offers bring-your-own-contract entries. */
  readonly ownContracts: boolean;
}

export function countProtocols(entries: readonly Categorized[]): ProtocolCount {
  let protocols = 0;
  let ownContracts = false;
  for (const entry of entries) {
    if (isOwnContractEntry(entry)) ownContracts = true;
    else protocols += 1;
  }
  return { protocols, ownContracts };
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
