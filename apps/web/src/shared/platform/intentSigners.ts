/**
 * Builders for @kletia/sdk signers backed by the web app's wallet layer.
 *
 * - EVM: an EIP-1193 provider from the active wagmi connector, wrapped with
 *   the SDK's `eip1193Signer` (chain switching and receipt polling). Chain
 *   switches go through the connector, so a network the wallet lacks is added.
 * - Solana: a `SolanaSigner` whose `signAndSendTransaction` goes through
 *   `signAndSendSolanaTransaction`, so the app's pre-sign checks (v0 message,
 *   fee payer and sole signer are the connected account, size, network) run
 *   before any wallet prompt.
 *
 * No wallet SDK or runtime config is imported here (so Node checks can load
 * it); callers pass the connector, the Wallet Standard wallet they already
 * hold and the checked Solana sender.
 */
import type { SolanaTransactionRequest } from "@kletia/core";
import { eip1193Signer, type Eip1193Provider, type EvmSigner, type SolanaSigner } from "@kletia/sdk";
import type { Wallet, WalletAccount } from "@wallet-standard/base";

import type { SolanaExecutionContext, SolanaSubmission } from "../wallet/solana/executeSolanaTransaction";

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

/** Switches the wallet to `chainId` (adding the network when the wallet does not know it). */
export type WalletChainSwitch = (chainId: number) => Promise<unknown>;

function requestedChainId(params: unknown): number | null {
  const first = Array.isArray(params) ? (params[0] as { chainId?: unknown } | undefined) : undefined;
  const raw = first?.chainId;
  if (typeof raw !== "string" || !/^0x[0-9a-f]{1,13}$/iu.test(raw)) return null;
  return Number.parseInt(raw, 16);
}

/**
 * Routes the SDK signer's `wallet_switchEthereumChain` through the wallet
 * connector. A plain switch fails with 4902 when the wallet has never seen
 * the network (OP Mainnet or Polygon in a fresh wallet); the connector then
 * offers the network with `wallet_addEthereumChain` from the app's wallet
 * config, and refuses any chain that config does not list. Every other
 * request reaches the provider unchanged.
 */
export function withWalletChainSwitch(provider: Eip1193Provider, switchChain: WalletChainSwitch): Eip1193Provider {
  return {
    async request(args) {
      if (args.method !== "wallet_switchEthereumChain") return provider.request(args);
      const chainId = requestedChainId(args.params);
      if (chainId === null) {
        throw Object.assign(new Error("Kletia refused to switch the wallet: the chain id is malformed."), { code: 4902 });
      }
      await switchChain(chainId);
      return null;
    },
  };
}

/**
 * EVM signer whose provider is resolved on first use. wagmi connectors expose
 * their provider asynchronously (`connector.getProvider()`), so building the
 * signer never blocks rendering and a failed lookup is retried next time.
 * With `switchChain` (the connector's own), chain switches can also add a
 * network the wallet does not know yet.
 */
export function lazyEip1193Signer(
  address: string,
  getProvider: () => Promise<unknown>,
  switchChain?: WalletChainSwitch,
): EvmSigner {
  let pending: Promise<EvmSigner> | null = null;
  const resolve = () => {
    pending ??= getProvider()
      .then((provider) => {
        if (!isEip1193Provider(provider)) {
          throw new Error("The connected EVM wallet does not expose an EIP-1193 provider.");
        }
        return eip1193Signer(switchChain ? withWalletChainSwitch(provider, switchChain) : provider, address);
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

/**
 * The app's checked Solana sender: `signAndSendSolanaTransaction` from
 * `shared/wallet/solana/executeSolanaTransaction`, which runs the pre-sign
 * policy checks before the wallet is asked.
 */
export type CheckedSolanaSend = (
  request: SolanaTransactionRequest,
  context: SolanaExecutionContext,
) => Promise<SolanaSubmission>;

/** Solana signer that keeps the app's pre-sign policy checks in front of the wallet. */
export function walletStandardIntentSigner(
  wallet: Wallet,
  account: WalletAccount,
  send: CheckedSolanaSend,
  onLog?: (line: string) => void,
): SolanaSigner {
  return {
    address: account.address,
    async signAndSendTransaction(request) {
      const { signature } = await send(request, {
        wallet,
        account,
        network: request.network,
        ...(onLog ? { onLog } : {}),
      });
      return signature;
    },
  };
}

