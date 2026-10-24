/**
 * Which history provider reads each network: EVM networks through Etherscan
 * V2 (ETHERSCAN_API_KEY), else Alchemy (ALCHEMY_API_KEY); Solana through
 * Helius (HELIUS_API_KEY), else plain RPC (keyless, slow, capped). A network
 * no configured provider serves fails closed with the variables that would
 * enable it.
 */
import { CHAINS, type DataTxCoverage, type NetworkKey } from "@kletia/core";
import { alchemyKey, alchemyProvider, alchemyServes } from "./alchemy.js";
import { etherscanKey, etherscanProvider, etherscanServes } from "./etherscan.js";
import { heliusKey, heliusProvider, heliusServes } from "./helius.js";
import { solanaRpcProvider } from "./solanaRpc.js";
import type { HistoryProvider } from "./types.js";

export type ProviderChoice =
  | { readonly provider: HistoryProvider; readonly note?: string }
  | { readonly provider: null; readonly status: Extract<DataTxCoverage["status"], "not-configured" | "unsupported">; readonly reason: string; readonly env?: readonly string[] };

export const EVM_HISTORY_ENV = Object.freeze(["ETHERSCAN_API_KEY", "ALCHEMY_API_KEY"]);
export const SOLANA_HISTORY_ENV = Object.freeze(["HELIUS_API_KEY"]);

export function historyProviderFor(network: NetworkKey): ProviderChoice {
  if (CHAINS[network].vm === "svm") {
    if (heliusKey() && heliusServes(network)) return { provider: heliusProvider };
    return { provider: solanaRpcProvider, note: "Read through plain Solana RPC (slow, 15 transactions a page); set HELIUS_API_KEY for parsed, faster history." };
  }
  if (etherscanKey() && etherscanServes(network)) return { provider: etherscanProvider };
  if (alchemyKey() && alchemyServes(network)) return { provider: alchemyProvider, note: "Read through Alchemy transfers: fees and failed transactions are not reported; set ETHERSCAN_API_KEY for both." };
  if (!etherscanServes(network) && !alchemyServes(network)) {
    return { provider: null, status: "unsupported", reason: `No history provider Kletia uses covers ${CHAINS[network].name}.` };
  }
  return { provider: null, status: "not-configured", reason: `EVM history needs ETHERSCAN_API_KEY (or ALCHEMY_API_KEY) on this API; it is not set.`, env: EVM_HISTORY_ENV };
}
