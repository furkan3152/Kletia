/**
 * Builders for @kletia/sdk signers backed by the web app's wallet layer.
 *
 * - EVM: an EIP-1193 provider from the active wagmi connector, wrapped with
 *   the SDK's `eip1193Signer` (chain switching and receipt polling).
 * - Solana: a `SolanaSigner` whose `signAndSendTransaction` goes through
 *   `signAndSendSolanaTransaction`, so the app's pre-sign checks (v0 message,
 *   fee payer and sole signer are the connected account, size, network) run
 *   before any wallet prompt.
 *
 * No wallet SDK is imported here; callers pass the connector and the Wallet
 * Standard wallet they already hold.
 */
import { eip1193Signer, type Eip1193Provider, type EvmSigner, type SolanaSigner } from "@kletia/sdk";
import type { Wallet, WalletAccount } from "@wallet-standard/base";

import { signAndSendSolanaTransaction } from "../wallet/solana/executeSolanaTransaction";

export {
  findBindingProblem,
  isNothingSentError,
  isPreviewAccount,
  observeSigners,
  sameOwner,
  shortAccountId,
  transactionBindingProblem,
  type BindingProblem,
  type SignerObserver,
} from "./intentBinding";

function isEip1193Provider(value: unknown): value is Eip1193Provider {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { request?: unknown }).request === "function"
  );
}

/**
 * EVM signer whose provider is resolved on first use. wagmi connectors expose
 * their provider asynchronously (`connector.getProvider()`), so building the
 * signer never blocks rendering and a failed lookup is retried next time.
 */
export function lazyEip1193Signer(
  address: string,
  getProvider: () => Promise<unknown>,
): EvmSigner {
  let pending: Promise<EvmSigner> | null = null;
  const resolve = () => {
    pending ??= getProvider()
      .then((provider) => {
        if (!isEip1193Provider(provider)) {
          throw new Error("The connected EVM wallet does not expose an EIP-1193 provider.");
        }
        return eip1193Signer(provider, address);
      })
      .catch((error: unknown) => {
        pending = null;
        throw error;
      });
    return pending;
  };
  return {
    address,
    async sendTransaction(request) {
      return (await resolve()).sendTransaction(request);
    },
    async waitForTransaction(hash, chainId) {
      return (await resolve()).waitForTransaction(hash, chainId);
    },
  };
}

/** Solana signer that keeps the app's pre-sign policy checks in front of the wallet. */
export function walletStandardIntentSigner(
  wallet: Wallet,
  account: WalletAccount,
  onLog?: (line: string) => void,
): SolanaSigner {
  return {
    address: account.address,
    async signAndSendTransaction(request) {
      const { signature } = await signAndSendSolanaTransaction(request, {
        wallet,
        account,
        network: request.network,
        ...(onLog ? { onLog } : {}),
      });
      return signature;
    },
  };
}

