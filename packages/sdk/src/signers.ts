import {
  encodeBase58,
  type EvmTransactionRequest,
  type SolanaTransactionRequest,
} from "@kletia/core";

/** Anything that can sign and broadcast EVM transactions for one address. */
export interface EvmSigner {
  readonly address: string;
  sendTransaction(request: EvmTransactionRequest): Promise<string>;
  /** Resolves once the transaction is mined; rejects if it reverted. */
  waitForTransaction(hash: string, chainId: number): Promise<void>;
}

/** Anything that can sign and broadcast Solana transactions for one public key. */
export interface SolanaSigner {
  readonly address: string;
  signAndSendTransaction(request: SolanaTransactionRequest): Promise<string>;
}

/** Minimal EIP-1193 provider surface (MetaMask, Coinbase Wallet, wagmi connectors, viem). */
export interface Eip1193Provider {
  request(args: { method: string; params?: readonly unknown[] | object }): Promise<unknown>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function toHexQuantity(decimal: string): string {
  return `0x${BigInt(decimal).toString(16)}`;
}

/**
 * Wrap an EIP-1193 provider. Switches the wallet to the request's chain when
 * needed and polls for receipts through the same provider.
 */
export function eip1193Signer(
  provider: Eip1193Provider,
  address: string,
  options: { receiptTimeoutMs?: number; pollIntervalMs?: number } = {},
): EvmSigner {
  const receiptTimeoutMs = options.receiptTimeoutMs ?? 180_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  async function ensureChain(chainId: number) {
    const current = Number.parseInt(String(await provider.request({ method: "eth_chainId" })), 16);
    if (current === chainId) return;
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: `0x${chainId.toString(16)}` }],
    });
    const switched = Number.parseInt(String(await provider.request({ method: "eth_chainId" })), 16);
    if (switched !== chainId) throw new Error(`Wallet did not switch to chain ${chainId}.`);
  }
  return {
    address,
    async sendTransaction(request) {
      if (request.from.toLowerCase() !== address.toLowerCase()) {
        throw new Error("Transaction sender does not match the connected EVM account.");
      }
      await ensureChain(request.chainId);
      const hash = await provider.request({
        method: "eth_sendTransaction",
        params: [
          {
            from: request.from,
            to: request.to,
            data: request.data,
            value: toHexQuantity(request.value),
            ...(request.gas ? { gas: toHexQuantity(request.gas) } : {}),
          },
        ],
      });
      if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/u.test(hash)) {
        throw new Error("Wallet returned an invalid transaction hash.");
      }
      return hash;
    },
    async waitForTransaction(hash) {
      const deadline = Date.now() + receiptTimeoutMs;
      while (Date.now() < deadline) {
        const receipt = (await provider.request({ method: "eth_getTransactionReceipt", params: [hash] })) as
          | { status?: string }
          | null;
        if (receipt && typeof receipt.status === "string") {
          if (receipt.status !== "0x1") throw new Error(`Transaction ${hash} reverted.`);
          return;
        }
        await sleep(pollIntervalMs);
      }
      throw new Error(`Transaction ${hash} was not mined within ${Math.round(receiptTimeoutMs / 1000)}s.`);
    },
  };
}

/** Minimal Wallet Standard shapes (Phantom, Solflare, Backpack, …) used by the signer. */
export interface WalletStandardAccount {
  readonly address: string;
  readonly chains: readonly string[];
}

export interface WalletStandardWallet {
  readonly name: string;
  readonly features: Readonly<Record<string, unknown>>;
}

interface SignAndSendFeature {
  signAndSendTransaction(
    ...inputs: {
      account: WalletStandardAccount;
      chain: string;
      transaction: Uint8Array;
      options?: { preflightCommitment?: string; commitment?: string };
    }[]
  ): Promise<readonly { signature: Uint8Array }[]>;
}

function decodeBase64(value: string): Uint8Array {
  const atobImpl = (globalThis as { atob?: (data: string) => string }).atob;
  if (atobImpl) {
    const binary = atobImpl(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  const BufferImpl = (globalThis as { Buffer?: { from(data: string, encoding: string): Uint8Array } }).Buffer;
  if (!BufferImpl) throw new Error("No base64 decoder available.");
  return new Uint8Array(BufferImpl.from(value, "base64"));
}

/**
 * Wrap a Wallet Standard wallet account. `chain` is the Wallet Standard chain
 * (`solana:mainnet` or `solana:devnet`, see `CHAINS[network].walletChain`).
 */
export function walletStandardSolanaSigner(
  wallet: WalletStandardWallet,
  account: WalletStandardAccount,
  chain: string,
): SolanaSigner {
  const feature = wallet.features["solana:signAndSendTransaction"] as SignAndSendFeature | undefined;
  if (!feature || typeof feature.signAndSendTransaction !== "function") {
    throw new Error(`${wallet.name} does not support solana:signAndSendTransaction.`);
  }
  if (!account.chains.includes(chain)) {
    throw new Error(`${wallet.name} account is not available on ${chain}.`);
  }
  return {
    address: account.address,
    async signAndSendTransaction(request) {
      if (request.feePayer !== account.address) {
        throw new Error("Transaction fee payer does not match the connected Solana account.");
      }
      const [output] = await feature.signAndSendTransaction({
        account,
        chain,
        transaction: decodeBase64(request.transaction),
        options: { preflightCommitment: "confirmed" },
      });
      if (!output || !(output.signature instanceof Uint8Array) || output.signature.length !== 64) {
        throw new Error("Wallet returned an invalid Solana signature.");
      }
      return encodeBase58(output.signature);
    },
  };
}
