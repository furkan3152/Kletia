// Node side of the "Kletia Test Wallet". The keys are generated here at run
// time, kept in this process's memory only and never written or logged. Every
// read, signature and broadcast goes to a local fork RPC; the wallet refuses
// to exist when a signing RPC is not on 127.0.0.1.
import { generateKeyPairSync, randomUUID, sign as edSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createPublicClient, createWalletClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export const CHAIN_NAMES = { 8453: "Base (local fork)", 42161: "Arbitrum (local fork)", 137: "Polygon (local fork)" };

/** Throws unless every URL is http(s)://127.0.0.1:<port>. */
export function assertLocalRpcs(urls) {
  for (const [name, url] of Object.entries(urls)) {
    const parsed = new URL(url);
    if (parsed.hostname !== "127.0.0.1") throw new Error(`Refusing to start: the ${name} signing RPC ${url} is not 127.0.0.1.`);
  }
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(bytes) {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let out = "";
  while (value > 0n) {
    out = B58[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = "1" + out;
  }
  return out;
}

function compactU16(bytes, offset) {
  let value = 0;
  let size = 0;
  for (;;) {
    const byte = bytes[offset + size];
    value |= (byte & 0x7f) << (7 * size);
    size += 1;
    if ((byte & 0x80) === 0) return { value, size };
  }
}

/** Signs a wire-format Solana transaction for `publicKey` (one of its required signers). */
export function signSolanaWire(wire, publicKey, signer) {
  const bytes = Uint8Array.from(wire);
  const sigs = compactU16(bytes, 0);
  const messageStart = sigs.size + sigs.value * 64;
  const message = bytes.subarray(messageStart);
  const headerAt = message[0] & 0x80 ? 1 : 0;
  const required = message[headerAt];
  const keys = compactU16(message, headerAt + 3);
  const keysAt = headerAt + 3 + keys.size;
  let index = -1;
  for (let i = 0; i < Math.min(required, keys.value); i += 1) {
    const key = message.subarray(keysAt + i * 32, keysAt + (i + 1) * 32);
    if (Buffer.from(key).equals(Buffer.from(publicKey))) index = i;
  }
  if (index < 0 || index >= sigs.value) throw new Error("The test wallet is not a required signer of this transaction.");
  const signature = edSign(null, Buffer.from(message), signer);
  bytes.set(signature, sigs.size + index * 64);
  return bytes;
}

/** A fresh random Solana address (a recipient that nobody holds a key for after this call). */
export function randomSolanaAddress() {
  const { publicKey } = generateKeyPairSync("ed25519");
  return base58(Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url"));
}

const SIGNING_KINDS = new Set(["personal_sign", "typed", "send", "sol_sign_tx", "sol_sign_message"]);

/**
 * Creates the throwaway wallet: an EVM account and (when the Solana fork runs)
 * an ed25519 key, plus the binding handler and the init script for the page.
 * `readOnly` (a run against a deployed API): it connects but refuses every signature.
 */
export async function createTestWallet({ forks, solanaRpc, onEvent, readOnly = false }) {
  assertLocalRpcs({ ...Object.fromEntries(Object.entries(forks).map(([id, url]) => [`chain ${id}`, url])), ...(solanaRpc ? { solana: solanaRpc } : {}) });
  const account = privateKeyToAccount(generatePrivateKey());
  let solana = null;
  if (solanaRpc) {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
    solana = { address: base58(raw), publicKey: [...raw], signer: privateKey };
  }
  const clients = new Map();
  const clientsFor = (chainId) => {
    const url = forks[chainId];
    if (!url) throw Object.assign(new Error(`No local fork for chain ${chainId}.`), { code: 4901 });
    if (!clients.has(chainId)) {
      const transport = http(url);
      const chain = { id: Number(chainId), name: CHAIN_NAMES[chainId], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [url] } } };
      clients.set(chainId, {
        pub: createPublicClient({ chain, transport }),
        wallet: createWalletClient({ account, chain, transport }),
      });
    }
    return clients.get(chainId);
  };

  // Site permissions survive reloads, like an extension's connected-sites list.
  const permissions = { evm: false, solana: false };
  async function handle(payload) {
    if (readOnly && SIGNING_KINDS.has(payload.kind)) {
      throw Object.assign(new Error("This is a read-only run: the test wallet signs nothing."), { code: 4100 });
    }
    switch (payload.kind) {
      case "permission":
        if (payload.set) permissions[payload.set] = Boolean(payload.value);
        return permissions[payload.get ?? payload.set];
      case "rpc": {
        const { pub } = clientsFor(payload.chainId);
        return pub.request({ method: payload.method, params: payload.params });
      }
      case "personal_sign": {
        const signature = await account.signMessage({ message: { raw: payload.message } });
        onEvent?.({ kind: "personal_sign" });
        return signature;
      }
      case "typed": {
        const { domain, types, primaryType, message } = payload.typed;
        const { EIP712Domain: _domain, ...rest } = types;
        const signature = await account.signTypedData({ domain, types: rest, primaryType, message });
        onEvent?.({ kind: "typed", primaryType, domain: domain?.name, chainId: payload.chainId });
        return signature;
      }
      case "send": {
        const { wallet, pub } = clientsFor(payload.chainId);
        const tx = payload.tx;
        // Fees as a wallet on these L2s sets them: no tip, twice the base fee as the cap (unless the app sent its own).
        // A fork's base fee decays on empty blocks, so a default 1 gwei tip would dwarf it and fail fee checks such as GMX's.
        const block = await pub.getBlock();
        const hash = await wallet.sendTransaction({
          to: tx.to ?? undefined,
          data: tx.data ?? tx.input ?? undefined,
          value: tx.value ? BigInt(tx.value) : 0n,
          gas: (tx.gas ?? tx.gasLimit) ? BigInt(tx.gas ?? tx.gasLimit) : undefined,
          maxPriorityFeePerGas: tx.maxPriorityFeePerGas ? BigInt(tx.maxPriorityFeePerGas) : 0n,
          maxFeePerGas: tx.maxFeePerGas ? BigInt(tx.maxFeePerGas) : (block.baseFeePerGas ?? 1n) * 2n + 1n,
        });
        onEvent?.({ kind: "send", chainId: payload.chainId, hash, to: tx.to, selector: tx.data?.slice(0, 10) });
        // anvil mines on submission; the receipt is read back from the fork for the log.
        pub.waitForTransactionReceipt({ hash }).then(
          (receipt) => onEvent?.({ kind: "receipt", chainId: payload.chainId, hash, status: receipt.status, gasUsed: String(receipt.gasUsed) }),
          () => undefined,
        );
        return hash;
      }
      case "sol_sign_tx": {
        if (!solana) throw new Error("The Solana test wallet is off.");
        const signed = signSolanaWire(Buffer.from(payload.transaction, "base64"), solana.publicKey, solana.signer);
        onEvent?.({ kind: "sol_sign_tx" });
        return Buffer.from(signed).toString("base64");
      }
      case "sol_sign_message": {
        if (!solana) throw new Error("The Solana test wallet is off.");
        const signature = edSign(null, Buffer.from(payload.message, "base64"), solana.signer);
        onEvent?.({ kind: "sol_sign_message" });
        return Buffer.from(signature).toString("base64");
      }
      default:
        throw new Error(`Unknown wallet request ${payload.kind}.`);
    }
  }

  const source = await readFile(new URL("./walletPage.js", import.meta.url), "utf8");
  const config = {
    uuid: randomUUID(),
    evmAddress: account.address,
    defaultChainId: 8453,
    forkChains: Object.keys(forks).map(Number),
    chainNames: CHAIN_NAMES,
    solana: solana ? { address: solana.address, publicKey: solana.publicKey } : null,
  };
  return {
    evmAddress: account.address,
    solanaAddress: solana?.address ?? null,
    initScript: source.replace("__KL_WALLET_CONFIG__", JSON.stringify(config)),
    /** Playwright binding: errors keep their EIP-1193 code. */
    async binding(_source, payload) {
      try {
        return await handle(payload);
      } catch (error) {
        throw new Error(JSON.stringify({ code: error.code ?? -32603, message: String(error.shortMessage ?? error.message ?? error) }));
      }
    },
  };
}
