/**
 * Wallet decisions on Rule Book approvals (policy design §7.4).
 *
 * The approver's wallet signs exactly what `@kletia/core` builds: EIP-712
 * typed data "Kletia Approvals" v1 on the signer's chain (EVM, EOAs and
 * smart accounts through ERC-1271 / ERC-6492 on the API), or the canonical
 * `approvalMessageText` (Solana `signMessage`). Before anything is signed the
 * approval's digest is recomputed from the intent it names, so a wallet never
 * signs a digest for steps it was not shown.
 */
import {
  approvalDigest,
  approvalMessageText,
  approvalTypedData,
  encodeBase58,
  parseAccountId,
  type AccountId,
} from "@kletia/core";
import type { KletiaClient } from "./client.js";
import { KletiaApiError } from "./errors.js";
import type { PolicyApprovalView, RequestOptions } from "./types.js";

/** EIP-712 typed data of an approval decision (core `approvalTypedData`; `uint256` / `uint64` as bigint). */
export type ApprovalTypedData = ReturnType<typeof approvalTypedData>;

/**
 * A wallet that can decide approvals. `account` is its CAIP-10 id (the EVM
 * chain in it is the EIP-712 domain chain). EVM wallets implement
 * `signTypedData` (hex signature), Solana wallets `signMessage` (64 bytes, or
 * base58 / base64 text).
 */
export interface ApprovalWalletSigner {
  readonly account: AccountId | string;
  signTypedData?(typedData: ApprovalTypedData): Promise<string>;
  signMessage?(message: Uint8Array): Promise<Uint8Array | string>;
}

export interface WalletDecisionOptions extends RequestOptions {
  /** How long the signature stays valid (default 600 s; never past the approval's expiry). */
  readonly validForSeconds?: number;
  /**
   * Shown the approval (title, steps, recipients, ceiling) right before the
   * wallet prompt; anything but `true` stops without signing.
   */
  readonly confirm?: (approval: PolicyApprovalView) => boolean | Promise<boolean>;
  /** Clock (tests). */
  readonly now?: () => number;
}

function refused(code: string, message: string): KletiaApiError {
  return new KletiaApiError({ code, message: `${message} (checked locally; nothing was signed or sent).`, status: 0 });
}

function solanaSignature(value: Uint8Array | string): string {
  if (typeof value === "string") {
    const text = value.trim();
    if (!/^[0-9A-Za-z+/=_-]{64,128}$/u.test(text)) throw new Error("The wallet returned an invalid Solana signature.");
    return text;
  }
  if (!(value instanceof Uint8Array) || value.length !== 64) throw new Error("The wallet returned an invalid Solana signature.");
  return encodeBase58(value);
}

/** Reads, checks, signs and sends one wallet decision. */
export async function decideWithWallet(
  client: KletiaClient,
  id: string,
  decision: "approve" | "reject",
  signer: ApprovalWalletSigner,
  options: WalletDecisionOptions = {},
): Promise<PolicyApprovalView> {
  const { validForSeconds = 600, confirm, now = Date.now, ...request } = options;
  if (!Number.isInteger(validForSeconds) || validForSeconds < 30 || validForSeconds > 86_400) {
    throw new RangeError("validForSeconds must be a whole number between 30 and 86400.");
  }
  const account = parseAccountId(signer.account);
  if (!account) throw new TypeError("signer.account must be the wallet's CAIP-10 account.");
  const approval = await client.approvals.get(id, request);
  if (approval.status === "expired") throw refused("POLICY_APPROVAL_EXPIRED", "Nobody decided this approval in time");
  if (approval.status !== "pending") throw refused("APPROVAL_DECIDED", `This approval was already ${approval.status}`);
  const signing = approval.signing;
  if (signing.approvalId !== approval.id || signing.digest !== approval.digest || !/^0x[0-9a-f]{64}$/u.test(signing.digest)) {
    throw refused("APPROVAL_SIGNATURE_INVALID", "The approval's signing fields do not match the approval");
  }
  if (!/^\d{1,18}$/u.test(signing.ceilingUsdCents)) throw refused("APPROVAL_SIGNATURE_INVALID", "The approval carries no usable ceiling");
  // The digest binds the steps the approver sees: recompute it from the intent it names.
  const intent = await client.intents.get(approval.intentId, request);
  if (intent.id !== approval.intentId || approvalDigest(intent, approval.keyId) !== approval.digest) {
    throw refused("APPROVAL_SIGNATURE_INVALID", "The approval's digest is not the digest of the intent it names");
  }
  const nowSeconds = Math.floor(now() / 1000);
  const expiresAt = Math.min(nowSeconds + validForSeconds, signing.maxExpiresAt);
  if (expiresAt <= nowSeconds) throw refused("POLICY_APPROVAL_EXPIRED", "The approval expires before a signature could be used");
  if (confirm && (await confirm(approval)) !== true) throw refused("REQUEST_ABORTED", "The approver did not confirm");
  const input = {
    approvalId: approval.id,
    intentId: approval.intentId,
    digest: approval.digest,
    ceilingUsdCents: signing.ceilingUsdCents,
    decision,
    expiresAt,
  };
  let signature: string;
  if (account.chain.vm === "evm") {
    if (!signer.signTypedData) throw new TypeError("EVM approver wallets need signTypedData (EIP-712).");
    signature = await signer.signTypedData(approvalTypedData({ ...input, signer: account.id }));
    if (!/^0x[0-9a-fA-F]{130,}$/u.test(signature)) throw new Error("The wallet returned an invalid EIP-712 signature.");
  } else {
    if (!signer.signMessage) throw new TypeError("Solana approver wallets need signMessage.");
    signature = solanaSignature(await signer.signMessage(new TextEncoder().encode(approvalMessageText(input))));
  }
  const body = await client.request<{ approval: PolicyApprovalView }>(
    "POST",
    `/policy/approvals/${id}/${decision}`,
    { account: account.id, signature, expiresAt },
    request,
  );
  return body.approval;
}
