/**
 * The provider-neutral shape of one wallet transaction, before
 * classification (classify.ts): every history provider maps its response
 * into `RawTx`, newest first.
 */
import type { AccountId, DataTxProvider, NetworkKey } from "@kletia/core";

export interface RawToken {
  /** Provider symbol (unlisted tokens: as reported, may be spam). */
  readonly symbol: string;
  /** Contract (EVM) or mint (Solana); null for the gas asset. */
  readonly address: string | null;
  readonly decimals: number | null;
}

export interface RawTransfer {
  readonly token: RawToken;
  /** Null when the transfer's side is unknown (a balance delta). */
  readonly from: string | null;
  readonly to: string | null;
  /** Decimal amount; null when the decimals are unknown. */
  readonly amount: string | null;
}

export interface RawTx {
  readonly network: NetworkKey;
  readonly account: AccountId;
  /** The wallet address of `account`. */
  readonly owner: string;
  readonly hash: string;
  /** Unix milliseconds. */
  readonly time: number;
  /** Block (EVM) or slot (Solana). */
  readonly block: number | null;
  readonly status: "success" | "failed";
  /** EVM: the sender and the called contract; Solana: the fee payer and null. */
  readonly from: string | null;
  readonly to: string | null;
  /** EVM function name or selector; Solana: the provider's transaction type, when reported. */
  readonly method: string | null;
  /** Transfers in or out of `owner` (others are left out by the providers). */
  readonly transfers: readonly RawTransfer[];
  /** Decimal gas-asset fee when `owner` paid it, else null; `feeKnown` false when the provider does not report fees. */
  readonly fee: string | null;
  readonly feeKnown: boolean;
  /** Contracts called (EVM: `to` and internal call targets) or programs invoked (Solana, inner included). */
  readonly programs: readonly string[];
  /** The provider's own label of the transaction (Helius `type`), a classification hint only. */
  readonly hint: string | null;
  readonly source: DataTxProvider;
}

/**
 * Where the next page of one account starts: EVM providers query blocks up to
 * `block` (inclusive) and drop the hashes in `skip` (already listed); Solana
 * providers list signatures before `before`.
 */
export interface AccountCursor {
  readonly block?: number;
  readonly skip?: readonly string[];
  readonly before?: string;
}

export interface ProviderPage {
  /** Complete transactions, newest first. */
  readonly txs: readonly RawTx[];
  /** False when the account has no older transactions. */
  readonly more: boolean;
}

export interface HistoryProvider {
  readonly id: DataTxProvider;
  /** One page of `account` from `cursor` (undefined: the newest), at most `size` transactions. */
  page(account: { readonly id: AccountId; readonly network: NetworkKey; readonly address: string }, cursor: AccountCursor | undefined, size: number): Promise<ProviderPage>;
}
