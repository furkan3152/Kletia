/**
 * A minimal EIP-1193 connection (`window.ethereum`): the accounts the widget
 * plans for and the signer it executes with. Your app likely has wagmi or
 * another wallet library already; hand its provider to `eip1193Signer` the
 * same way. Without a wallet the widget plans previews for demo accounts.
 */
import { PREVIEW_ACCOUNT_IDS } from "@kletia/core";
import { eip1193Signer, formatAccountId } from "@kletia/sdk";

/** Demo accounts for plan-only previews: dry runs, nothing is stored and nothing can be signed. */
export const PREVIEW_ACCOUNTS = PREVIEW_ACCOUNT_IDS;

export function hasInjectedWallet() {
  return typeof window !== "undefined" && typeof window.ethereum?.request === "function";
}

/**
 * Asks the injected wallet for its account. Returns the CAIP-10 accounts on
 * the EVM networks this page uses and a signer that switches chains as each
 * step needs.
 */
export async function connectInjectedWallet(networks) {
  if (!hasInjectedWallet()) throw new Error("No browser wallet found. Install one, or keep planning previews.");
  const provider = window.ethereum;
  const [address] = await provider.request({ method: "eth_requestAccounts" });
  if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/u.test(address)) throw new Error("The wallet returned no account.");
  const evmNetworks = networks.filter((network) => network !== "solana" && network !== "solana-devnet");
  return {
    accounts: evmNetworks.map((network) => formatAccountId(network, address)),
    signers: { evm: eip1193Signer(provider, address) },
  };
}
