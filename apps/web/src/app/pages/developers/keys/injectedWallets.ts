/**
 * Browser wallets for developer portal sign-in, found and used through their
 * injected interfaces only, so the portal loads no wallet runtime (the route
 * chunk rule keeps wagmi, RainbowKit, WalletConnect and Wallet Standard
 * packages out of the developer pages):
 *
 * - EVM: EIP-6963 announcements (and `window.ethereum` as a fallback), then
 *   `eth_requestAccounts`, `eth_chainId` and `personal_sign`.
 * - Solana: the Wallet Standard registration events
 *   (`wallet-standard:app-ready` / `wallet-standard:register-wallet`), then
 *   `standard:connect` and `solana:signMessage`.
 *
 * Only signing a plain-text message is ever asked for: never a transaction.
 */

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface EvmWalletOption {
  readonly kind: "evm";
  readonly id: string;
  readonly name: string;
  readonly provider: Eip1193Provider;
}

export interface StandardAccount {
  readonly address: string;
  readonly chains?: readonly string[];
}

interface StandardWallet {
  readonly name: string;
  readonly chains?: readonly string[];
  readonly accounts?: readonly StandardAccount[];
  readonly features: Readonly<Record<string, unknown>>;
}

export interface SolanaWalletOption {
  readonly kind: "solana";
  readonly id: string;
  readonly name: string;
  readonly wallet: StandardWallet;
}

export type WalletOption = EvmWalletOption | SolanaWalletOption;

function isProvider(value: unknown): value is Eip1193Provider {
  return typeof value === "object" && value !== null && typeof (value as { request?: unknown }).request === "function";
}

/** EVM wallets that announce themselves (EIP-6963) within `waitMs`, or the injected `window.ethereum`. */
export async function discoverEvmWallets(waitMs = 200): Promise<EvmWalletOption[]> {
  if (typeof window === "undefined") return [];
  const found = new Map<string, EvmWalletOption>();
  const onAnnounce = (event: Event) => {
    const detail = (event as CustomEvent<{ info?: { uuid?: unknown; name?: unknown }; provider?: unknown }>).detail;
    const uuid = typeof detail?.info?.uuid === "string" ? detail.info.uuid : null;
    const name = typeof detail?.info?.name === "string" ? detail.info.name.slice(0, 40) : null;
    if (uuid && name && isProvider(detail.provider)) found.set(uuid, { kind: "evm", id: uuid, name, provider: detail.provider });
  };
  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  await new Promise((resolve) => window.setTimeout(resolve, waitMs));
  window.removeEventListener("eip6963:announceProvider", onAnnounce);
  const injected = (window as unknown as { ethereum?: unknown }).ethereum;
  if (found.size === 0 && isProvider(injected)) found.set("injected", { kind: "evm", id: "injected", name: "Browser wallet", provider: injected });
  return [...found.values()];
}

const SOLANA_SIGN_MESSAGE = "solana:signMessage";
const STANDARD_CONNECT = "standard:connect";

function canSignSolanaMessages(wallet: StandardWallet): boolean {
  const chains = wallet.chains ?? [];
  return chains.some((chain) => chain.startsWith("solana:")) && SOLANA_SIGN_MESSAGE in wallet.features && STANDARD_CONNECT in wallet.features;
}

/** Solana wallets registered through the Wallet Standard events that can sign messages. */
export function discoverSolanaWallets(): SolanaWalletOption[] {
  if (typeof window === "undefined") return [];
  const wallets: StandardWallet[] = [];
  const api = Object.freeze({
    register: (...registered: StandardWallet[]) => {
      wallets.push(...registered);
      return () => undefined;
    },
  });
  const onRegister = (event: Event) => {
    const callback = (event as CustomEvent<unknown>).detail;
    if (typeof callback === "function") {
      try {
        (callback as (app: typeof api) => void)(api);
      } catch {
        // A wallet that fails to register is left out.
      }
    }
  };
  window.addEventListener("wallet-standard:register-wallet", onRegister);
  try {
    window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
  } finally {
    window.removeEventListener("wallet-standard:register-wallet", onRegister);
  }
  const seen = new Set<string>();
  return wallets.filter(canSignSolanaMessages).flatMap((wallet) => {
    const name = wallet.name.slice(0, 40);
    if (seen.has(name)) return [];
    seen.add(name);
    return [{ kind: "solana" as const, id: name, name, wallet }];
  });
}

export interface ConnectedWallet {
  readonly address: string;
  /** EVM: the chain the wallet is on. */
  readonly chainId?: number;
  /** Solana: the Wallet Standard account that signs. */
  readonly account?: StandardAccount;
}

/** Connects and returns the wallet's address (and EVM chain id, or the Solana account). */
export async function connectWallet(option: WalletOption): Promise<ConnectedWallet> {
  if (option.kind === "evm") {
    const accounts = await option.provider.request({ method: "eth_requestAccounts" });
    const address = Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : null;
    if (!address) throw new Error("The wallet shared no account.");
    const chainHex = await option.provider.request({ method: "eth_chainId" }).catch(() => null);
    const chainId = typeof chainHex === "string" ? Number.parseInt(chainHex, 16) : Number.NaN;
    return Number.isSafeInteger(chainId) ? { address, chainId } : { address };
  }
  const connect = option.wallet.features[STANDARD_CONNECT] as { connect?: () => Promise<{ accounts?: readonly StandardAccount[] }> } | undefined;
  if (typeof connect?.connect !== "function") throw new Error("This Solana wallet cannot connect here.");
  const result = await connect.connect();
  const account = (result.accounts ?? option.wallet.accounts ?? []).find((entry) => typeof entry.address === "string");
  if (!account) throw new Error("The wallet shared no account.");
  return { address: account.address, account };
}

function utf8Hex(text: string): string {
  return `0x${[...new TextEncoder().encode(text)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Signs `message` as plain text: EVM `personal_sign` (0x hex signature),
 * Solana `signMessage` (base58 of the 64-byte signature via `base58`).
 */
export async function signWithWallet(option: WalletOption, connected: ConnectedWallet, message: string, base58: (bytes: Uint8Array) => string): Promise<string> {
  if (option.kind === "evm") {
    const signature = await option.provider.request({ method: "personal_sign", params: [utf8Hex(message), connected.address] });
    if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/u.test(signature)) throw new Error("The wallet returned no signature.");
    return signature;
  }
  const feature = option.wallet.features[SOLANA_SIGN_MESSAGE] as
    | { signMessage?: (...inputs: { account: StandardAccount; message: Uint8Array }[]) => Promise<readonly { signature?: Uint8Array }[]> }
    | undefined;
  const account = connected.account ?? (option.wallet.accounts ?? []).find((entry) => entry.address === connected.address);
  if (typeof feature?.signMessage !== "function" || !account) throw new Error("This Solana wallet cannot sign messages. Connect a wallet that supports message signing.");
  const [output] = await feature.signMessage({ account, message: new TextEncoder().encode(message) });
  if (!output?.signature || output.signature.length !== 64) throw new Error("The Solana wallet returned no signature.");
  return base58(output.signature);
}
