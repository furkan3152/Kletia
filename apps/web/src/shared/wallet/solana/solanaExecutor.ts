/**
 * Solana transaction signing. This module pulls in @solana/kit codecs, so it
 * is only ever loaded through a dynamic `import()` (see
 * executeSolanaTransaction.ts) and never ships in the entry bundle.
 */
import {
  getBase64Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import type {
  SolanaSignAndSendTransactionFeature,
  SolanaSignTransactionFeature,
} from "@solana/wallet-standard-features";
import {
  CHAINS,
  encodeBase58,
  isSolanaSignature,
  type NetworkKey,
  type SolanaTransactionRequest,
} from "@kletia/core";

import { SOLANA_SIGN_AND_SEND, SOLANA_SIGN_TRANSACTION } from "./discovery";

type SignAndSendFeature = SolanaSignAndSendTransactionFeature[typeof SOLANA_SIGN_AND_SEND];
type SignFeature = SolanaSignTransactionFeature[typeof SOLANA_SIGN_TRANSACTION];

export interface SolanaExecutionContext {
  readonly wallet: Wallet;
  readonly account: WalletAccount;
  readonly network: NetworkKey;
  readonly onLog?: (line: string) => void;
}

export interface SolanaSubmission {
  readonly signature: string;
}

/** Largest serialized transaction the Solana network accepts. */
const MAX_TRANSACTION_BYTES = 1_232;

const DEFAULT_RPC: Partial<Record<NetworkKey, string>> = {
  solana: "https://api.mainnet-beta.solana.com",
  "solana-devnet": "https://api.devnet.solana.com",
};

function rpcUrlFor(network: NetworkKey): string {
  const configured =
    network === "solana-devnet"
      ? (import.meta.env.VITE_SOLANA_DEVNET_RPC_URL as string | undefined)
      : (import.meta.env.VITE_SOLANA_RPC_URL as string | undefined);
  const candidate = configured?.trim() || DEFAULT_RPC[network];
  if (!candidate) throw new Error(`No RPC endpoint is configured for ${network}.`);
  const url = new URL(candidate);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("Solana RPC endpoints must use HTTPS.");
  }
  return url.toString();
}

interface InspectedTransaction {
  readonly bytes: Uint8Array;
  readonly messageBytes: Uint8Array;
  readonly signatures: Readonly<Record<string, Uint8Array | null>>;
}

/**
 * Decode a wire transaction and enforce Kletia's signing policy: a v0 message
 * whose fee payer is the connected account and whose only required signer is
 * that same account.
 */
/**
 * Copy codec output (read-only byte views) into a plain Uint8Array. The
 * codec's ReadonlyUint8Array type relies on generic typed arrays from a newer
 * TypeScript lib, so the value is accepted as unknown and copied by index.
 */
function toBytes(value: unknown): Uint8Array {
  return Uint8Array.from(value as ArrayLike<number>);
}

function inspectTransaction(bytes: Uint8Array, feePayer: string): InspectedTransaction {
  if (bytes.length === 0 || bytes.length > MAX_TRANSACTION_BYTES) {
    throw new Error("Prepared transaction has an invalid size.");
  }
  const transaction = getTransactionDecoder().decode(bytes);
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  if (message.version !== 0) {
    throw new Error("Only version 0 Solana transactions are signed by Kletia.");
  }
  if (message.staticAccounts[0] !== feePayer) {
    throw new Error("Transaction fee payer does not match the connected Solana account.");
  }
  if (message.header.numSignerAccounts !== 1) {
    throw new Error("Transaction requires a signer other than the connected Solana account.");
  }
  const signatures = transaction.signatures as Readonly<Record<string, Uint8Array | null>>;
  const signers = Object.keys(signatures);
  if (signers.length !== 1 || signers[0] !== feePayer) {
    throw new Error("Transaction signer set does not match the connected Solana account.");
  }
  return {
    bytes,
    messageBytes: toBytes(transaction.messageBytes),
    signatures,
  };
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function broadcast(network: NetworkKey, signedTransaction: Uint8Array): Promise<string> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(rpcUrlFor(network), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendTransaction",
        params: [
          getBase64Decoder().decode(signedTransaction),
          { encoding: "base64", preflightCommitment: "confirmed", skipPreflight: false },
        ],
      }),
    });
    const body = (await response.json().catch(() => null)) as
      | { result?: unknown; error?: { message?: unknown } }
      | null;
    if (body?.error) {
      const detail = typeof body.error.message === "string" ? body.error.message : "rejected";
      throw new Error(`Solana RPC rejected the transaction: ${detail.slice(0, 200)}`);
    }
    if (!response.ok || typeof body?.result !== "string" || !isSolanaSignature(body.result)) {
      throw new Error(`Solana RPC did not accept the transaction (HTTP ${response.status}).`);
    }
    return body.result;
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * Validate a prepared Solana transaction against the connected wallet, ask the
 * wallet to sign it and broadcast it. Prefers `solana:signAndSendTransaction`;
 * falls back to `solana:signTransaction` plus a JSON-RPC `sendTransaction`.
 * Returns the base58 signature. Never retries a submission.
 */
export async function signAndSendSolanaTransaction(
  request: SolanaTransactionRequest,
  context: SolanaExecutionContext,
): Promise<SolanaSubmission> {
  const { wallet, account, network, onLog } = context;
  const chain = CHAINS[network];
  if (request.vm !== "svm" || chain.vm !== "svm") {
    throw new Error("This is not a Solana transaction request.");
  }
  if (request.network !== network) {
    throw new Error(`Transaction was prepared for ${request.network}, not ${network}.`);
  }
  if (request.encoding !== "base64" || typeof request.transaction !== "string") {
    throw new Error("Prepared transaction must be base64 encoded.");
  }
  if (request.feePayer !== account.address) {
    throw new Error("Transaction fee payer does not match the connected Solana account.");
  }
  const walletChain = chain.walletChain;
  if (!walletChain) throw new Error(`${chain.name} has no Wallet Standard chain identifier.`);
  if (account.chains.length > 0 && !account.chains.includes(walletChain as `${string}:${string}`)) {
    throw new Error(`${wallet.name} does not offer this account on ${chain.name}.`);
  }

  const unsigned = inspectTransaction(
    toBytes(getBase64Encoder().encode(request.transaction)),
    account.address,
  );
  onLog?.("Transaction decoded: v0 message, fee payer and sole signer match the connected account.");

  const signAndSend = wallet.features[SOLANA_SIGN_AND_SEND] as SignAndSendFeature | undefined;
  if (signAndSend && typeof signAndSend.signAndSendTransaction === "function") {
    onLog?.(`Waiting for ${wallet.name} to sign and send.`);
    const [output] = await signAndSend.signAndSendTransaction({
      account,
      chain: walletChain as `${string}:${string}`,
      transaction: unsigned.bytes,
      options: { preflightCommitment: "confirmed" },
    });
    if (!output || !(output.signature instanceof Uint8Array) || output.signature.length !== 64) {
      throw new Error("Wallet returned an invalid Solana signature.");
    }
    const signature = encodeBase58(output.signature);
    onLog?.("Wallet signed and broadcast the transaction.");
    return { signature };
  }

  const signOnly = wallet.features[SOLANA_SIGN_TRANSACTION] as SignFeature | undefined;
  if (!signOnly || typeof signOnly.signTransaction !== "function") {
    throw new Error(`${wallet.name} cannot sign Solana transactions.`);
  }
  onLog?.(`Waiting for ${wallet.name} to sign.`);
  const [signedOutput] = await signOnly.signTransaction({
    account,
    chain: walletChain as `${string}:${string}`,
    transaction: unsigned.bytes,
    options: { preflightCommitment: "confirmed" },
  });
  if (!signedOutput || !(signedOutput.signedTransaction instanceof Uint8Array)) {
    throw new Error("Wallet returned no signed transaction.");
  }
  const signed = inspectTransaction(toBytes(signedOutput.signedTransaction), account.address);
  if (!sameBytes(signed.messageBytes, unsigned.messageBytes)) {
    onLog?.("Wallet modified the message before signing; fee payer and signer policy re-verified.");
  }
  const signatureBytes = signed.signatures[account.address];
  if (!signatureBytes || signatureBytes.length !== 64) {
    throw new Error("Wallet did not sign with the connected account.");
  }
  const signature = encodeBase58(toBytes(signatureBytes));
  onLog?.("Broadcasting the signed transaction over Solana JSON-RPC.");
  const broadcastSignature = await broadcast(network, signed.bytes);
  if (broadcastSignature !== signature) {
    throw new Error("Solana RPC returned a signature that does not match the signed transaction.");
  }
  return { signature };
}
