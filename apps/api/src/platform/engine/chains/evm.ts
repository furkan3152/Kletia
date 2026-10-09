/**
 * EVM reads used by the engine: clients, ERC-20 metadata/balances/allowances,
 * fee estimates and on-chain evidence for submitted transaction hashes.
 */
import {
  erc20Abi,
  getAddress,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from "viem";
import { CHAINS, type NetworkKey } from "@kletia/core";
import { NETWORK_CLIENTS, PLATFORM_NETWORK_CLIENTS } from "../../../shared/config/networks.js";
import { arbitrumSepoliaPublicClient } from "../../../networks/arbitrum-sepolia/config.js";
import { PlatformError } from "../../errors.js";
import { nativeUsdPrice } from "../prices.js";

export type EvmNetworkKey = Extract<NetworkKey, "base" | "arbitrum" | "ethereum" | "optimism" | "polygon" | "arc" | "arbitrum-sepolia">;

export const EVM_NETWORK_KEYS: readonly EvmNetworkKey[] = ["base", "arbitrum", "ethereum", "optimism", "polygon", "arc", "arbitrum-sepolia"];

export function isEvmNetwork(network: NetworkKey): network is EvmNetworkKey {
  return (EVM_NETWORK_KEYS as readonly string[]).includes(network);
}

export function evmClient(network: EvmNetworkKey): PublicClient {
  switch (network) {
    case "base":
      return NETWORK_CLIENTS.base;
    case "arbitrum":
      return NETWORK_CLIENTS.arbitrum;
    case "ethereum":
      return PLATFORM_NETWORK_CLIENTS.ethereum;
    case "optimism":
      return PLATFORM_NETWORK_CLIENTS.optimism;
    case "polygon":
      return PLATFORM_NETWORK_CLIENTS.polygon;
    case "arc":
      return NETWORK_CLIENTS.arc;
    case "arbitrum-sepolia":
      return arbitrumSepoliaPublicClient;
  }
}

export function evmChainId(network: EvmNetworkKey): number {
  const id = CHAINS[network].evmChainId;
  if (id === undefined) throw new PlatformError("NETWORK_UNSUPPORTED", `${network} has no EVM chain id.`, 500);
  return id;
}

const RPC_TIMEOUT_MS = 10_000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs = RPC_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new PlatformError("RPC_TIMEOUT", "An EVM RPC read timed out. Try again shortly.", 504)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface Erc20Metadata {
  readonly address: Address;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
}

export async function readErc20Metadata(network: EvmNetworkKey, token: string): Promise<Erc20Metadata> {
  const address = getAddress(token);
  const client = evmClient(network);
  const [symbol, name, decimals] = await withTimeout(
    Promise.all([
      client.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
      client.readContract({ address, abi: erc20Abi, functionName: "name" }).catch(() => ""),
      client.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
    ]),
  ).catch(() => {
    throw new PlatformError("TOKEN_UNKNOWN", `No ERC-20 token was found at ${address} on ${CHAINS[network].name}.`, 422);
  });
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new PlatformError("TOKEN_UNKNOWN", "The token reports invalid decimals.", 422);
  }
  return {
    address,
    symbol: String(symbol).replace(/[^\w$.-]/gu, "").slice(0, 16) || "TOKEN",
    name: String(name).slice(0, 64),
    decimals,
  };
}

export async function readEvmBalance(network: EvmNetworkKey, owner: string, token: string | null): Promise<bigint> {
  const client = evmClient(network);
  const account = getAddress(owner);
  if (token === null) return withTimeout(client.getBalance({ address: account }));
  return withTimeout(
    client.readContract({ address: getAddress(token), abi: erc20Abi, functionName: "balanceOf", args: [account] }),
  );
}

export async function readAllowance(
  network: EvmNetworkKey,
  token: string,
  owner: string,
  spender: string,
): Promise<bigint> {
  return withTimeout(
    evmClient(network).readContract({
      address: getAddress(token),
      abi: erc20Abi,
      functionName: "allowance",
      args: [getAddress(owner), getAddress(spender)],
    }),
  );
}

/** Rough USD cost of `gasUnits` at the current gas price; undefined when unknown. */
export async function estimateEvmFeeUsd(network: EvmNetworkKey, gasUnits: bigint): Promise<number | undefined> {
  if (CHAINS[network].environment === "testnet" && network !== "arc") return 0;
  try {
    const [gasPrice, nativeUsd] = await Promise.all([
      withTimeout(evmClient(network).getGasPrice(), 5_000),
      nativeUsdPrice(network),
    ]);
    if (nativeUsd === null) return undefined;
    const decimals = CHAINS[network].nativeAsset.decimals;
    const fee = Number(gasUnits * gasPrice) / 10 ** decimals;
    return Number.isFinite(fee) ? fee * nativeUsd : undefined;
  } catch {
    return undefined;
  }
}

export type EvmTransactionObservation =
  | { readonly state: "not_found" }
  | { readonly state: "pending" }
  | {
      readonly state: "landed";
      readonly status: "success" | "reverted";
      readonly from: string;
      readonly to: string | null;
      readonly input: string;
      readonly value: bigint;
      readonly chainId: number | null;
      readonly blockNumber: bigint;
      readonly blockTimestamp: number | null;
      readonly logs: readonly Log[];
    };

/** Reads a transaction and its receipt. Never throws for "not yet visible". */
export async function observeEvmTransaction(network: EvmNetworkKey, hash: string): Promise<EvmTransactionObservation> {
  const client = evmClient(network);
  const txHash = hash as Hex;
  let transaction;
  try {
    transaction = await withTimeout(client.getTransaction({ hash: txHash }));
  } catch (error) {
    if (error instanceof TransactionNotFoundError) return { state: "not_found" };
    throw error;
  }
  let receipt;
  try {
    receipt = await withTimeout(client.getTransactionReceipt({ hash: txHash }));
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError) return { state: "pending" };
    throw error;
  }
  const block = await withTimeout(client.getBlock({ blockNumber: receipt.blockNumber })).catch(() => null);
  return {
    state: "landed",
    status: receipt.status,
    from: receipt.from,
    to: receipt.to,
    input: transaction.input,
    value: transaction.value,
    chainId: typeof transaction.chainId === "number" ? transaction.chainId : null,
    blockNumber: receipt.blockNumber,
    blockTimestamp: block ? Number(block.timestamp) : null,
    logs: receipt.logs,
  };
}

/** Destination-side check for solver fills: receipt exists and succeeded. */
export async function readEvmReceiptStatus(
  network: EvmNetworkKey,
  hash: string,
): Promise<{ status: "success" | "reverted" | "not_found"; logs: readonly Log[] }> {
  try {
    const receipt = await withTimeout(evmClient(network).getTransactionReceipt({ hash: hash as Hex }));
    return { status: receipt.status, logs: receipt.logs };
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError) return { status: "not_found", logs: [] };
    throw error;
  }
}

/**
 * Change of `account`'s native balance across `blockNumber` (balance after the
 * block minus balance after the previous one): what a contract-forwarded
 * native fill credited, net of anything else the account did in that block.
 */
export async function nativeBalanceDelta(network: EvmNetworkKey, account: string, blockNumber: bigint): Promise<bigint> {
  const client = evmClient(network);
  const address: Address = getAddress(account);
  // eth_getBalance directly: a batching client would read it through Multicall3 at that block instead.
  const balanceAt = async (block: bigint) => BigInt(await client.request({ method: "eth_getBalance", params: [address, `0x${block.toString(16)}`] }));
  const [after, before] = await withTimeout(Promise.all([balanceAt(blockNumber), balanceAt(blockNumber - 1n)]));
  return after - before;
}

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** Sum of ERC-20 Transfer logs of `token` credited to `recipient` in a receipt. */
export function erc20CreditFromLogs(logs: readonly Log[], token: string, recipient: string): bigint {
  const tokenLower = token.toLowerCase();
  const recipientTopic = `0x${recipient.toLowerCase().replace(/^0x/u, "").padStart(64, "0")}`;
  let total = 0n;
  for (const log of logs) {
    if (log.address.toLowerCase() !== tokenLower) continue;
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC || log.topics[2]?.toLowerCase() !== recipientTopic) continue;
    if (!/^0x[0-9a-fA-F]{1,64}$/u.test(log.data)) continue;
    total += BigInt(log.data);
  }
  return total;
}
