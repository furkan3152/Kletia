/**
 * Sign-only for native Solana orders: Jupiter relays the signed transaction
 * itself, so the wallet must sign without sending. Pulls in @solana/kit
 * codecs: load it with a dynamic `import()` only.
 *
 * Before the prompt: legacy or v0 message, fee payer and sole signer are the
 * connected account. After it: the wallet returned exactly the prepared
 * message (Kletia's API refuses anything else too).
 */
import { getBase64Decoder, getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import type { SolanaSignTransactionFeature } from "@solana/wallet-standard-features";
import { CHAINS, type NetworkKey } from "@kletia/core";

import { SOLANA_SIGN_TRANSACTION } from "./discovery";

type SignFeature = SolanaSignTransactionFeature[typeof SOLANA_SIGN_TRANSACTION];

const MAX_TRANSACTION_BYTES = 1_232;

function messageOf(bytes: Uint8Array, feePayer: string): Uint8Array {
  if (bytes.length === 0 || bytes.length > MAX_TRANSACTION_BYTES) throw new Error("The order transaction has an invalid size.");
  const transaction = getTransactionDecoder().decode(bytes);
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  if (message.version !== 0 && message.version !== "legacy") throw new Error("Kletia signs legacy or version 0 order transactions only.");
  if (String(message.staticAccounts[0]) !== feePayer || message.header.numSignerAccounts !== 1) {
    throw new Error("The order transaction is not paid and signed by the connected Solana account alone.");
  }
  return Uint8Array.from(transaction.messageBytes as unknown as ArrayLike<number>);
}

function same(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** Returns the signed wire transaction (base64), for POST /v1/orders/submit. */
export async function signSolanaOrderTransaction(wallet: Wallet, account: WalletAccount, network: NetworkKey, transaction: string): Promise<string> {
  const walletChain = CHAINS[network].walletChain;
  if (!walletChain) throw new Error(`${CHAINS[network].name} has no Wallet Standard chain identifier.`);
  const signer = wallet.features[SOLANA_SIGN_TRANSACTION] as SignFeature | undefined;
  if (!signer || typeof signer.signTransaction !== "function") {
    throw new Error(`${wallet.name} can only sign and send at once; Jupiter orders need a wallet that signs without sending.`);
  }
  const unsigned = Uint8Array.from(getBase64Encoder().encode(transaction) as unknown as ArrayLike<number>);
  const prepared = messageOf(unsigned, account.address);
  const [output] = await signer.signTransaction({ account, chain: walletChain as `${string}:${string}`, transaction: unsigned });
  if (!output || !(output.signedTransaction instanceof Uint8Array)) throw new Error("The wallet returned no signed transaction.");
  if (!same(messageOf(output.signedTransaction, account.address), prepared)) {
    throw new Error("The wallet changed the order transaction before signing; Kletia does not submit changed orders.");
  }
  return getBase64Decoder().decode(output.signedTransaction);
}
