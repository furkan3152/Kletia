/**
 * Quote binding: sha256 over the canonical JSON of the security-relevant
 * fields of every transaction in a payload. For EVM steps the same view is
 * rebuilt from the chain on submit, so a submitted hash only verifies when
 * the landed transactions are byte-for-byte what Kletia prepared.
 */
import type { TransactionRequest } from "@kletia/core";
import { canonicalJson, sha256Hex } from "./util.js";

export type BindingView =
  | {
      readonly vm: "evm";
      readonly chainId: number;
      readonly from: string;
      readonly to: string;
      readonly data: string;
      readonly value: string;
    }
  | { readonly vm: "svm"; readonly network: string; readonly feePayer: string; readonly transaction: string };

export function bindingView(transaction: TransactionRequest): BindingView {
  if (transaction.vm === "evm") {
    return {
      vm: "evm",
      chainId: transaction.chainId,
      from: transaction.from.toLowerCase(),
      to: transaction.to.toLowerCase(),
      data: transaction.data.toLowerCase(),
      value: BigInt(transaction.value).toString(),
    };
  }
  return {
    vm: "svm",
    network: transaction.network,
    feePayer: transaction.feePayer,
    transaction: transaction.transaction,
  };
}

export function quoteBindingForViews(views: readonly BindingView[]): string {
  return sha256Hex(canonicalJson(views));
}

export function quoteBindingFor(transactions: readonly TransactionRequest[]): string {
  return quoteBindingForViews(transactions.map(bindingView));
}
