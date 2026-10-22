/**
 * Demo accounts on a dry-run preview (GAPS polish): before a wallet is
 * connected the desk plans with the registry's preview accounts, which the
 * API describes like the user's own ("Your Base wallet 0x9B58…6590", "you
 * have 0 USDC"). These helpers label them as demo accounts, so nobody reads a
 * demo balance as their own. Pure: node --test loads it.
 */
import { PREVIEW_ACCOUNT_IDS, parseAccountId, type Journey } from "@kletia/core";

const DEMO_ADDRESSES = new Set(
  PREVIEW_ACCOUNT_IDS.map((id) => parseAccountId(id)?.address.toLowerCase()).filter((address): address is string => Boolean(address)),
);

/** True for a CAIP-10 account (or bare address) of the registry's demo accounts, on any chain. */
export function isDemoAccount(account: string | null | undefined): boolean {
  if (!account) return false;
  const parsed = parseAccountId(account);
  const address = parsed ? parsed.address : account.slice(account.lastIndexOf(":") + 1);
  return DEMO_ADDRESSES.has(address.toLowerCase());
}

/** "Your Base wallet" -> "Demo Base wallet (not yours)"; a venue or recipient label stays as it is. */
export function demoHolderLabel(label: string): string {
  return /^your\s+/iu.test(label) ? `Demo ${label.replace(/^your\s+/iu, "")} (not yours)` : label;
}

/** The journey with every demo account's stop labelled as a demo account. Unchanged when it has none. */
export function labelDemoJourney(journey: Journey): Journey {
  if (!journey.stops.some((stop) => isDemoAccount(stop.holder.account))) return journey;
  return {
    ...journey,
    stops: journey.stops.map((stop) =>
      isDemoAccount(stop.holder.account) ? { ...stop, holder: { ...stop.holder, label: demoHolderLabel(stop.holder.label) } } : stop,
    ),
  };
}
