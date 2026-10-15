/**
 * Safe proposals in the panel (admin design D.4 "Via Safe"): the SafeTx
 * typed data a co-owner signs, signatures sorted by signer and concatenated
 * for `execTransaction`, the Safe{Wallet} link and the Transaction Builder
 * JSON a co-signer can import there. The `safeTxHash` itself always comes
 * from the chain through the API, never from this file. Pure.
 */
import { getAddress, type Hex } from "viem";

import type { AdminEvmNetwork, AdminSafeProposal } from "./types.ts";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const SAFE_TX_TYPES = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

export interface SafeTxInput {
  readonly to: string;
  readonly value: string;
  readonly data: string;
  readonly nonce: string;
}

/** EIP-712 typed data of a SafeTx (operation CALL only; no gas refund). */
export function safeTxTypedData(chainId: number, safe: string, tx: SafeTxInput) {
  return {
    domain: { chainId, verifyingContract: getAddress(safe) },
    types: SAFE_TX_TYPES,
    primaryType: "SafeTx" as const,
    message: {
      to: getAddress(tx.to),
      value: BigInt(tx.value),
      data: tx.data as Hex,
      operation: 0,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: ZERO_ADDRESS,
      refundReceiver: ZERO_ADDRESS,
      nonce: BigInt(tx.nonce),
    },
  };
}

/** Signatures sorted by signer address ascending (the order `checkSignatures` requires). */
export function sortSignatures<T extends { readonly signer: string }>(signatures: readonly T[]): T[] {
  return [...signatures].sort((a, b) => {
    const left = BigInt(getAddress(a.signer));
    const right = BigInt(getAddress(b.signer));
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/** The `signatures` bytes of `execTransaction`: 65-byte signatures, sorted, concatenated. */
export function packSignatures(signatures: readonly { readonly signer: string; readonly signature: string }[]): Hex {
  const sorted = sortSignatures(signatures);
  for (const item of sorted) {
    if (!/^0x[0-9a-fA-F]{130}$/u.test(item.signature)) throw new Error(`The signature of ${item.signer} is not 65 bytes.`);
  }
  return `0x${sorted.map((item) => item.signature.slice(2)).join("")}` as Hex;
}

/** Progress line: "1 of 2 signatures". */
export function signatureProgress(proposal: Pick<AdminSafeProposal, "signatures" | "threshold">): string {
  return `${proposal.signatures.length} of ${proposal.threshold} signature${proposal.threshold === 1 ? "" : "s"}`;
}

/** Owners who have not signed yet. */
export function missingSigners(proposal: Pick<AdminSafeProposal, "signatures" | "owners">): string[] {
  const signed = new Set(proposal.signatures.map((item) => item.signer.toLowerCase()));
  return proposal.owners.filter((owner) => !signed.has(owner.toLowerCase()));
}

export function hasSigned(proposal: Pick<AdminSafeProposal, "signatures">, signer: string | null): boolean {
  if (!signer) return false;
  return proposal.signatures.some((item) => item.signer.toLowerCase() === signer.toLowerCase());
}

/** Safe{Wallet} network short names (EIP-3770) for the panel's networks; Arc has no Safe{Wallet} app. */
export const SAFE_SHORT_NAMES: Readonly<Partial<Record<AdminEvmNetwork, string>>> = {
  base: "base",
  arbitrum: "arb1",
  ethereum: "eth",
  optimism: "oeth",
  polygon: "matic",
  "arbitrum-sepolia": "arb-sep",
};

export function safeAppUrl(network: AdminEvmNetwork, safe: string): string | null {
  const short = SAFE_SHORT_NAMES[network];
  return short ? `https://app.safe.global/home?safe=${short}:${getAddress(safe)}` : null;
}

/** Transaction Builder batch file for one call (the co-signer imports it in Safe{Wallet}). */
export function transactionBuilderJson(
  proposal: Pick<AdminSafeProposal, "safe" | "to" | "value" | "data" | "description" | "createdAt">,
  chainId: number,
) {
  return {
    version: "1.0",
    chainId: String(chainId),
    createdAt: Date.parse(proposal.createdAt) || 0,
    meta: {
      name: "Kletia admin proposal",
      description: proposal.description,
      txBuilderVersion: "1.16.5",
      createdFromSafeAddress: getAddress(proposal.safe),
      createdFromOwnerAddress: "",
    },
    transactions: [{ to: getAddress(proposal.to), value: proposal.value, data: proposal.data, contractMethod: null, contractInputsValues: null }],
  };
}
