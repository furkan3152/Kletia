import type { AccountId } from "@kletia/core";

/** Namespaces the console can hold a connected account for. */
export type WalletNamespace = "eip155" | "solana";

/**
 * A wallet account the user connected, independent of the wallet SDK that
 * produced it. `accountId` is the CAIP-10 identity on the account's active
 * network (the wallet's EVM chain, or Solana mainnet).
 */
export interface ConnectedAccount {
  readonly namespace: WalletNamespace;
  readonly address: string;
  readonly accountId: AccountId;
  readonly walletName: string;
  readonly walletIcon?: string;
}

/** `0x1234…abcd` / `9WzD…AWWM`. */
export function shortenAddress(address: string, lead = 4, tail = 4): string {
  if (address.length <= lead + tail + 1) return address;
  const head = address.startsWith("0x") ? address.slice(0, lead + 2) : address.slice(0, lead);
  return `${head}…${address.slice(-tail)}`;
}

/** Only image data URIs supplied by Wallet Standard wallets are rendered. */
export function safeWalletIcon(icon: unknown): string | undefined {
  return typeof icon === "string" && /^data:image\/(?:svg\+xml|webp|png|gif|jpeg);base64,/u.test(icon)
    ? icon
    : undefined;
}
