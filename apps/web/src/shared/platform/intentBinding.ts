/**
 * Pure account and transaction binding rules for intent execution, and the
 * signer wrapper that applies them before any wallet prompt.
 *
 * Wallet-free and config-free (only @kletia/core): the execution hook, the
 * marketing-safe embed page and the Node verification script all share it.
 *
 * Address comparison follows each namespace's rules: EVM addresses are
 * compared case-insensitively, Solana public keys exactly.
 */
import {
  CHAINS,
  parseAccountId,
  type AccountId,
  type IntentGraph,
  type IntentStep,
  type TransactionRequest,
} from "@kletia/core";
import type { EvmSigner, IntentSigners, SolanaSigner } from "@kletia/sdk";

import { PREVIEW_ACCOUNTS } from "./previewAccounts";

export { PREVIEW_ACCOUNTS };

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

export function shortAccountId(accountId: string): string {
  const address = accountId.slice(accountId.lastIndexOf(":") + 1);
  return address.length <= 14 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
}

const UNSIGNED_STATUSES = new Set<IntentStep["status"]>(["pending", "ready", "awaiting_signature"]);

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
    if (!connected.some((account) => !isPreviewAccount(account) && sameOwner(account, step.account))) {
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

/**
 * Checks a prepared transaction against the step it is about to be signed
 * for, before any wallet sees it: same VM and network (and EVM chain id), and
 * the step's own account pays and signs. Returns why it must not be signed.
 */
export function transactionBindingProblem(step: IntentStep, request: TransactionRequest): string | null {
  const chain = CHAINS[step.network];
  const account = parseAccountId(step.account);
  const label = `step ${step.index + 1}`;
  if (!chain || !account) return `Kletia refused to sign ${label}: its network or account is not recognised.`;
  if (step.mode !== "wallet") return `Kletia refused to sign ${label}: it does not need a wallet signature.`;
  if (isPreviewAccount(step.account)) return `Kletia refused to sign ${label}: it is bound to a demo preview account.`;
  if (account.chain.namespace !== chain.namespace) {
    return `Kletia refused to sign ${label}: its account belongs to another network family.`;
  }
  if (request.vm !== chain.vm || request.network !== step.network) {
    return `Kletia refused to sign ${label}: the prepared transaction targets ${
      CHAINS[request.network]?.name ?? "another network"
    }, but the step runs on ${chain.name}.`;
  }
  if (request.vm === "evm") {
    if (chain.evmChainId === undefined || request.chainId !== chain.evmChainId) {
      return `Kletia refused to sign ${label}: the prepared transaction uses chain ${request.chainId}, not ${chain.name}.`;
    }
    if (typeof request.from !== "string" || request.from.toLowerCase() !== account.address.toLowerCase()) {
      return `Kletia refused to sign ${label}: the prepared transaction is sent from another EVM account.`;
    }
    return null;
  }
  if (request.feePayer !== account.address) {
    return `Kletia refused to sign ${label}: the prepared transaction is paid by another Solana account.`;
  }
  return null;
}

/** EIP-1193 / wallet error codes that guarantee nothing was broadcast. */
const NOTHING_SENT_CODES = new Set<number | string>([
  4001, // user rejected the request
  4100, // unauthorized account
  4200, // unsupported method
  4900, // disconnected
  4901, // chain disconnected
  4902, // unrecognised chain (switch failed)
  -32002, // a request is already pending in the wallet
  "ACTION_REJECTED",
]);

const NOTHING_SENT_MESSAGES = [
  // Wallet prompts the user declined.
  /user rejected|rejected the request|user denied|denied (?:the )?(?:transaction|request)|request (?:was )?(?:rejected|declined|cancell?ed)|user (?:declined|cancell?ed|aborted)|cancell?ed by (?:the )?user/iu,
  // Checks Kletia runs before the wallet is asked (signers and pre-sign policy).
  /^Kletia refused to sign/u,
  /^Transaction sender does not match the connected EVM account/u,
  /^Wallet did not switch to chain/u,
  /^This is not a Solana transaction request/u,
  /^Transaction was prepared for /u,
  /^Prepared transaction (?:must be base64 encoded|has an invalid size)/u,
  /^Transaction fee payer does not match/u,
  /^Only version 0 Solana transactions/u,
  /^Transaction requires a signer other than/u,
  /^Transaction signer set does not match/u,
  /does not offer this account on |has no Wallet Standard chain identifier|cannot sign Solana transactions/u,
  /^No RPC endpoint is configured|^Solana RPC endpoints must use HTTPS/u,
  // The signing code itself failed to load, so no wallet was reached.
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/u,
];

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

/**
 * True when a signing failure guarantees the wallet broadcast nothing (the
 * user declined, or a check refused the request before the wallet saw it).
 * Any other failure (timeouts, malformed wallet answers, broadcast errors)
 * leaves the outcome unknown: the step must not be signed again silently.
 */
export function isNothingSentError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return true;
  for (const item of errorChain(error)) {
    const { code, name, message } = item as { code?: unknown; name?: unknown; message?: unknown };
    if ((typeof code === "number" || typeof code === "string") && NOTHING_SENT_CODES.has(code)) return true;
    if (name === "UserRejectedRequestError") return true;
    if (typeof message === "string" && NOTHING_SENT_MESSAGES.some((pattern) => pattern.test(message))) return true;
  }
  return false;
}

export interface ExternalRecipient {
  readonly stepId: string;
  readonly stepIndex: number;
  readonly recipient: AccountId;
  readonly network: string;
}

/**
 * Steps that deliver funds to an account outside `owned` (e.g. a transfer to
 * a third party). Bridges to the user's own account on another network are
 * not external.
 */
export function externalRecipients(intent: IntentGraph, owned: readonly string[]): ExternalRecipient[] {
  const result: ExternalRecipient[] = [];
  for (const step of [...intent.steps].sort((a, b) => a.index - b.index)) {
    if (!step.recipient || sameOwner(step.recipient, step.account)) continue;
    if (owned.some((account) => sameOwner(account, step.recipient as string))) continue;
    const parsed = parseAccountId(step.recipient);
    result.push({
      stepId: step.id,
      stepIndex: step.index,
      recipient: step.recipient,
      network: parsed?.chain.name ?? CHAINS[step.network]?.name ?? step.network,
    });
  }
  return result;
}

export interface SignerObserver {
  /**
   * Runs before the wallet is asked to sign `request`. Throwing refuses the
   * request: nothing reaches the wallet and `onRequest` is not called.
   */
  readonly beforeRequest?: (request: TransactionRequest) => void;
  /** The wallet is about to be asked for a signature. */
  readonly onRequest?: () => void;
  /** The wallet returned a transaction hash / signature (already broadcast). */
  readonly onReference?: (reference: string) => void;
  /** Signing failed after `onRequest` (declined, refused by a check, or an unknown outcome). */
  readonly onReject?: (error: unknown) => void;
}

/** Wrap signers so the caller can vet and follow each signature request. */
export function observeSigners(signers: IntentSigners, observer: SignerObserver): IntentSigners {
  const observed: { evm?: EvmSigner; solana?: SolanaSigner } = {};
  if (signers.evm) {
    const evm = signers.evm;
    observed.evm = {
      address: evm.address,
      async sendTransaction(request) {
        observer.beforeRequest?.(request);
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
        observer.beforeRequest?.(request);
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
