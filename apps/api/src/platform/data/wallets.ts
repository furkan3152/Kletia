/**
 * The wallet set of a data request (`?evm=&solana=&lane=`): at most two EVM
 * and two Solana addresses, expanded to one CAIP-10 account per network of
 * the lane their VM runs (two EVM addresses on five production networks plus
 * two Solana addresses is 12 accounts, the portfolio batch limit).
 */
import {
  CHAINS,
  formatAccountId,
  isEvmAddress,
  isSolanaAddress,
  NETWORK_KEYS,
  type AccountId,
  type DataLane,
  type DataWalletSet,
} from "@kletia/core";
import { PlatformError } from "../errors.js";

export const WALLET_LIMITS = Object.freeze({ evm: 2, solana: 2 });

function invalid(path: string, message: string): PlatformError {
  return new PlatformError("INVALID_REQUEST", message, 400, [{ path, message }]);
}

function addresses(raw: string | undefined, path: "evm" | "solana", valid: (value: string) => boolean): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const out: string[] = [];
  const seen = new Set<string>();
  raw.split(",").forEach((part, index) => {
    const value = part.trim();
    if (!valid(value)) throw invalid(`${path}[${index}]`, `${path}[${index}] is not ${path === "evm" ? "an EVM (0x…)" : "a Solana"} address.`);
    // EVM addresses are case-insensitive: the first spelling is kept.
    const key = path === "evm" ? value.toLowerCase() : value;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(value);
  });
  if (out.length > WALLET_LIMITS[path]) throw invalid(path, `At most ${WALLET_LIMITS[path]} ${path} addresses per request.`);
  return out;
}

/** Every account of `lane` for the addresses, in network order (EVM before Solana within a network list). */
export function laneAccounts(evm: readonly string[], solana: readonly string[], lane: DataLane): AccountId[] {
  const accounts: AccountId[] = [];
  for (const key of NETWORK_KEYS) {
    const chain = CHAINS[key];
    if (chain.lane !== lane) continue;
    for (const address of chain.namespace === "solana" ? solana : evm) accounts.push(formatAccountId(chain, address));
  }
  return accounts;
}

/** Parses `evm`, `solana` and `lane` query values. Throws 400 INVALID_REQUEST. */
export function parseWalletSet(query: { readonly evm?: string; readonly solana?: string; readonly lane?: string }): DataWalletSet {
  const lane = query.lane === undefined || query.lane === "" ? "production" : query.lane;
  if (lane !== "production" && lane !== "testnet") throw invalid("lane", "lane must be production or testnet.");
  const evm = addresses(query.evm, "evm", (value) => isEvmAddress(value));
  const solana = addresses(query.solana, "solana", (value) => isSolanaAddress(value));
  if (evm.length === 0 && solana.length === 0) throw invalid("evm", "Name at least one wallet: evm=0x… and/or solana=<address>.");
  return { evm, solana, lane, accounts: laneAccounts(evm, solana, lane) };
}

/** True when `address` (EVM: any case) is one of the set's addresses. */
export function inWalletSet(set: Pick<DataWalletSet, "evm" | "solana">, address: string): boolean {
  return set.solana.includes(address) || set.evm.some((evm) => evm.toLowerCase() === address.toLowerCase());
}
