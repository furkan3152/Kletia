/**
 * Account binding. Every step is owned by exactly one CAIP-10 account on the
 * step network. An EVM account may be re-homed to any eip155 network with the
 * same address; a Solana account may act on either Solana cluster.
 */
import {
  CHAINS,
  detectAddressNamespace,
  formatAccountId,
  normalizeAddress,
  parseAccountId,
  type AccountId,
  type NetworkKey,
  type ParsedAccountId,
} from "@kletia/core";
import { PlatformError } from "../errors.js";

export function parseAccounts(accounts: readonly AccountId[]): ParsedAccountId[] {
  return accounts.map((account, index) => {
    const parsed = parseAccountId(account);
    if (!parsed) throw new PlatformError("ACCOUNT_INVALID", `accounts[${index}] is not a valid CAIP-10 id.`, 400);
    return parsed;
  });
}

/** Picks (and if needed re-homes) the user's account for `network`. */
export function accountForNetwork(accounts: readonly ParsedAccountId[], network: NetworkKey): ParsedAccountId {
  const chain = CHAINS[network];
  const exact = accounts.find((account) => account.chain.id === chain.id);
  if (exact) return exact;
  const sameNamespace = accounts.filter((account) => account.chain.namespace === chain.namespace);
  if (sameNamespace.length === 0) {
    const example = chain.namespace === "solana" ? `${chain.id}:<base58 address>` : `${chain.id}:0x…`;
    throw new PlatformError(
      "ACCOUNT_REQUIRED",
      `This intent needs a ${chain.namespace === "solana" ? "Solana" : "EVM"} account for ${chain.name}. Add one to accounts (e.g. ${example}).`,
      422,
      [{ path: "accounts", message: `Missing ${chain.namespace} account.` }],
    );
  }
  const addresses = new Set(sameNamespace.map((account) => normalizeAddress(chain.namespace, account.address)));
  if (addresses.size > 1) {
    throw new PlatformError(
      "ACCOUNT_AMBIGUOUS",
      `Several ${chain.namespace} accounts were given and none is on ${chain.name}. Add the account to use as ${chain.id}:<address>.`,
      422,
      [{ path: "accounts", message: `Ambiguous ${chain.namespace} account for ${network}.` }],
    );
  }
  const source = sameNamespace[0] as ParsedAccountId;
  const id = formatAccountId(chain, source.address);
  return { chain, address: source.address, id };
}

/**
 * Parses a recipient (raw address or CAIP-10) for a step on `network`. A
 * CAIP-10 recipient on another network of the same namespace is refused: that
 * would be a bridge, not a transfer.
 */
export function recipientForNetwork(recipient: string, network: NetworkKey): ParsedAccountId {
  const chain = CHAINS[network];
  const trimmed = recipient.trim();
  if (trimmed.includes(":")) {
    const parsed = parseAccountId(trimmed);
    if (!parsed) throw new PlatformError("RECIPIENT_INVALID", "Recipient is not a valid CAIP-10 account.", 422);
    if (parsed.chain.id !== chain.id) {
      throw new PlatformError(
        "RECIPIENT_NETWORK_MISMATCH",
        `Recipient is on ${parsed.chain.name} but the transfer runs on ${chain.name}. Use a bridge to move funds across networks.`,
        422,
      );
    }
    return parsed;
  }
  const namespace = detectAddressNamespace(trimmed);
  if (namespace !== chain.namespace) {
    throw new PlatformError(
      "RECIPIENT_INVALID",
      `Recipient is not a valid ${chain.namespace === "solana" ? "Solana" : "EVM"} address for ${chain.name}.`,
      422,
    );
  }
  return { chain, address: trimmed, id: formatAccountId(chain, trimmed) };
}

export function sameAddress(a: ParsedAccountId, b: ParsedAccountId): boolean {
  return a.chain.namespace === b.chain.namespace &&
    normalizeAddress(a.chain.namespace, a.address) === normalizeAddress(b.chain.namespace, b.address);
}
