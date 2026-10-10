/**
 * Account inputs in the portal: a bare address on the chosen network, a
 * CAIP-10 id or the `<network>:<address>` shorthand. Pure; core only.
 */
import { CHAINS, formatAccountId, isAddressForNamespace, parseAccountId, type AccountId, type NetworkKey } from "@kletia/core";

/** The CAIP-10 account on `network` the text names, or null when it does not name one there. */
export function accountOn(network: NetworkKey, text: string): AccountId | null {
  const value = text.trim();
  if (!value) return null;
  const chain = CHAINS[network];
  if (!chain) return null;
  if (isAddressForNamespace(chain.namespace, value)) return formatAccountId(network, value);
  const parsed = parseAccountId(value);
  return parsed && parsed.chain.id === chain.id ? parsed.id : null;
}

/** Any CAIP-10 account (or `<network>:<address>` shorthand), normalised; null otherwise. */
export function anyAccount(text: string): AccountId | null {
  return parseAccountId(text.trim())?.id ?? null;
}
