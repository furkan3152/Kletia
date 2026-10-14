/**
 * The accounts the desk plans with (console design 3.4): the connected EVM
 * and Solana wallets, homed on the departure's lane (and on the departure's
 * EVM chain when it has one), never on the chain the EVM wallet happens to be
 * on. Holdings read every network of the lane for the same addresses.
 */
import { useMemo } from "react";
import { CHAINS, NETWORK_KEYS, formatAccountId, type AccountId } from "@kletia/core";

import { useWallets } from "../../../shared/wallet/useWallets";
import type { ConnectedAccount } from "../../../shared/wallet/types";
import { accountsForLane, type Departure, type Lane } from "../state/deskModel";

export interface DeskAccounts {
  readonly evm: ConnectedAccount | null;
  readonly solana: ConnectedAccount | null;
  /** Planner accounts for the lane: one per connected namespace. */
  readonly planner: readonly AccountId[];
  /** Every network account of the lane for the connected addresses (what Holdings reads). */
  readonly holdings: readonly AccountId[];
  readonly connected: { readonly evm: boolean; readonly solana: boolean };
}

/** Accounts for every network of `lane` the connected wallets can hold. */
export function laneHoldingAccounts(lane: Lane, evm: string | null, solana: string | null): AccountId[] {
  const accounts: AccountId[] = [];
  for (const key of NETWORK_KEYS) {
    const chain = CHAINS[key];
    if ((chain.lane === "testnet" ? "testnet" : "production") !== lane) continue;
    const address = chain.namespace === "solana" ? solana : evm;
    if (!address) continue;
    try {
      accounts.push(formatAccountId(chain, address));
    } catch {
      // An address that does not fit the namespace is never read.
    }
  }
  return accounts;
}

export function useDeskAccounts(lane: Lane, departure: Departure): DeskAccounts {
  const { evm, solana } = useWallets();
  const evmAddress = evm?.address ?? null;
  const solanaAddress = solana?.address ?? null;
  return useMemo(
    () => ({
      evm,
      solana,
      planner: accountsForLane({ evm: evmAddress, solana: solanaAddress }, lane, departure),
      holdings: laneHoldingAccounts(lane, evmAddress, solanaAddress),
      connected: { evm: Boolean(evmAddress), solana: Boolean(solanaAddress) },
    }),
    [departure, evm, evmAddress, lane, solana, solanaAddress],
  );
}
