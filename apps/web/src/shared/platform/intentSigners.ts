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
import {
  eip1193Signer,
  type Eip1193Provider,
  type EvmSigner,
  type IntentSigners,
  type SolanaSigner,
} from "@kletia/sdk";
import { parseAccountId, type AccountId, type IntentGraph } from "@kletia/core";
import type { Wallet, WalletAccount } from "@wallet-standard/base";

import { signAndSendSolanaTransaction } from "../wallet/solana/executeSolanaTransaction";
import { PREVIEW_ACCOUNTS } from "./kletiaClient";

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

export interface SignerObserver {
  /** The wallet is about to be asked for a signature. */
  readonly onRequest?: () => void;
  /** The wallet returned a transaction hash / signature (already broadcast). */
  readonly onReference?: (reference: string) => void;
  /** The wallet (or a pre-sign check) refused before anything was sent. */
  readonly onReject?: (error: unknown) => void;
}

/** Wrap signers so the caller can follow each signature request. */
export function observeSigners(signers: IntentSigners, observer: SignerObserver): IntentSigners {
  const observed: { evm?: EvmSigner; solana?: SolanaSigner } = {};
  if (signers.evm) {
    const evm = signers.evm;
    observed.evm = {
      address: evm.address,
      async sendTransaction(request) {
        observer.onRequest?.();
        let hash: string;
        try {
          hash = await evm.sendTransaction(request);
        } catch (error) {
          observer.onReject?.(error);
          throw error;
        }
        observer.onReference?.(hash);
        return hash;
      },
      waitForTransaction: (hash, chainId) => evm.waitForTransaction(hash, chainId),
    };
  }
  if (signers.solana) {
    const solana = signers.solana;
    observed.solana = {
      address: solana.address,
      async signAndSendTransaction(request) {
        observer.onRequest?.();
        let signature: string;
        try {
          signature = await solana.signAndSendTransaction(request);
        } catch (error) {
          observer.onReject?.(error);
          throw error;
        }
        observer.onReference?.(signature);
        return signature;
      },
    };
  }
  return observed;
}

const PREVIEW_ADDRESSES = new Set(
  [PREVIEW_ACCOUNTS.evm, PREVIEW_ACCOUNTS.solana].map((id) =>
    id.slice(id.lastIndexOf(":") + 1).toLowerCase(),
  ),
);

/** True for the demo accounts used by read-only previews, on any network. */
export function isPreviewAccount(accountId: string): boolean {
  const parsed = parseAccountId(accountId);
  const address = parsed ? parsed.address : accountId.slice(accountId.lastIndexOf(":") + 1);
  return PREVIEW_ADDRESSES.has(address.toLowerCase());
}

/** Same address in the same namespace (EVM accounts may be re-homed across eip155 chains). */
export function sameOwner(left: string, right: string): boolean {
  const a = parseAccountId(left);
  const b = parseAccountId(right);
  if (!a || !b || a.chain.namespace !== b.chain.namespace) return false;
  return a.chain.namespace === "eip155"
    ? a.address.toLowerCase() === b.address.toLowerCase()
    : a.address === b.address;
}

const UNSIGNED_STATUSES = new Set<IntentGraph["steps"][number]["status"]>([
  "pending",
  "ready",
  "awaiting_signature",
]);

export interface BindingProblem {
  readonly stepId: string;
  readonly account: AccountId;
  readonly message: string;
}

/**
 * Checks that every wallet step of `intent` is bound to one of the connected
 * accounts (never a preview account). Returns the first problem, if any.
 */
export function findBindingProblem(
  intent: IntentGraph,
  connected: readonly AccountId[],
): BindingProblem | null {
  for (const step of [...intent.steps].sort((a, b) => a.index - b.index)) {
    if (isPreviewAccount(step.account)) {
      return {
        stepId: step.id,
        account: step.account,
        message: `Step ${step.index + 1} is bound to a demo preview account. Plan again with your connected wallets.`,
      };
    }
    // Only steps that still need a signature must match a connected wallet.
    if (step.mode !== "wallet" || !UNSIGNED_STATUSES.has(step.status)) continue;
    if (!connected.some((account) => sameOwner(account, step.account))) {
      const namespace = parseAccountId(step.account)?.chain.namespace;
      return {
        stepId: step.id,
        account: step.account,
        message: `Step ${step.index + 1} must be signed by ${shortAccountId(step.account)}. Connect that ${
          namespace === "solana" ? "Solana" : "EVM"
        } wallet to continue.`,
      };
    }
  }
  return null;
}

export function shortAccountId(accountId: string): string {
  const address = accountId.slice(accountId.lastIndexOf(":") + 1);
  return address.length <= 14 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
}
