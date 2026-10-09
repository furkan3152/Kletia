import type { EvmSigner, IntentSigners, SolanaSigner } from "@kletia/sdk";

export interface SignerLease {
  /** Signers that reach the wallet only while the lease is active. */
  readonly signers: IntentSigners;
  /** Start accepting wallet requests; the returned function ends the lease for good. */
  activate(): () => void;
}

function revoked(): Error {
  const message = "This execution was stopped before signing. Nothing was sent.";
  return typeof DOMException === "function" ? new DOMException(message, "AbortError") : Object.assign(new Error(message), { name: "AbortError" });
}

/**
 * Wraps wallet signers so a request that arrives after the owner stopped
 * (unmounted, reset, planned again) fails with an AbortError instead of
 * opening a wallet prompt. `executeIntent` already checks its signal before
 * each prompt; the lease also covers a prompt that a slow API response
 * would otherwise open late.
 */
export function leaseSigners(signers: IntentSigners): SignerLease {
  let active = false;
  let ended = false;
  const guard = () => {
    if (!active) throw revoked();
  };
  const leased: { evm?: EvmSigner; solana?: SolanaSigner } = {};
  if (signers.evm) {
    const evm = signers.evm;
    leased.evm = {
      address: evm.address,
      async sendTransaction(request) {
        guard();
        return evm.sendTransaction(request);
      },
      // Waiting for a receipt opens no prompt.
      waitForTransaction: (hash, chainId) => evm.waitForTransaction(hash, chainId),
    };
  }
  if (signers.solana) {
    const solana = signers.solana;
    leased.solana = {
      address: solana.address,
      async signAndSendTransaction(request) {
        guard();
        return solana.signAndSendTransaction(request);
      },
    };
  }
  return {
    signers: leased,
    activate: () => {
      if (!ended) active = true;
      return () => {
        active = false;
        ended = true;
      };
    },
  };
}
