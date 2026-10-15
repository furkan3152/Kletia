/**
 * Chain read helpers for admin verification: reverts are answers (a failed
 * check), transport failures are 502 ADMIN_RPC_UNAVAILABLE (never a pass).
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  getAddress,
  keccak256,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { AdminHttpError, rpcUnavailable } from "../http/errors.js";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const EMPTY_CODEHASH = keccak256("0x");

export const SAFE_ABI = [
  { type: "function", name: "getThreshold", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getOwners", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
  { type: "function", name: "nonce", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function", name: "getTransactionHash", stateMutability: "view",
    inputs: [
      { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" }, { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" }, { name: "gasToken", type: "address" }, { name: "refundReceiver", type: "address" },
      { name: "_nonce", type: "uint256" },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "event", name: "ExecutionSuccess", anonymous: false,
    inputs: [{ name: "txHash", type: "bytes32", indexed: false }, { name: "payment", type: "uint256", indexed: false }],
  },
  {
    type: "event", name: "ExecutionFailure", anonymous: false,
    inputs: [{ name: "txHash", type: "bytes32", indexed: false }, { name: "payment", type: "uint256", indexed: false }],
  },
] as const satisfies Abi;

export function isRevert(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  return Boolean(error.walk((cause) => cause instanceof ContractFunctionRevertedError || cause instanceof ContractFunctionZeroDataError));
}

/** Runs an RPC call; transport errors become 502 for `network`. */
export async function rpc<T>(network: string, task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    if (error instanceof AdminHttpError) throw error;
    throw rpcUnavailable(network);
  }
}

export type ReadResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

/** readContract where a revert is `{ ok: false }` and a transport failure is 502. */
export async function tryRead(
  client: PublicClient, network: string, address: string, abi: Abi, functionName: string, args: readonly unknown[] = [], blockNumber?: bigint,
): Promise<ReadResult> {
  try {
    const value = await client.readContract({
      address: address as Address, abi, functionName, args: args as unknown[], ...(blockNumber === undefined ? {} : { blockNumber }),
    });
    return { ok: true, value };
  } catch (error) {
    if (isRevert(error)) return { ok: false };
    throw rpcUnavailable(network);
  }
}

export function hasFunction(abi: Abi, name: string, inputs = 0): boolean {
  return abi.some((item) => item.type === "function" && item.name === name && item.inputs.length === inputs);
}

export async function receiptOrPending(client: PublicClient, network: string, hash: Hex) {
  try {
    return await client.getTransactionReceipt({ hash });
  } catch (error) {
    if (error instanceof BaseError && error.walk((cause) => cause instanceof TransactionReceiptNotFoundError)) {
      throw new AdminHttpError(409, "ADMIN_TX_PENDING", "The transaction is not mined yet. Retry in a moment.", { txHash: hash });
    }
    throw rpcUnavailable(network);
  }
}

export async function transactionOrPending(client: PublicClient, network: string, hash: Hex) {
  try {
    return await client.getTransaction({ hash });
  } catch (error) {
    if (error instanceof BaseError && error.walk((cause) => cause instanceof TransactionNotFoundError)) {
      throw new AdminHttpError(409, "ADMIN_TX_PENDING", "The transaction is not visible yet. Retry in a moment.", { txHash: hash });
    }
    throw rpcUnavailable(network);
  }
}

export type OwnerKind = "eoa" | "safe" | "contract" | "none";

/** eoa (no code), safe (getThreshold and getOwners answer), else contract. */
export async function ownerKindOf(client: PublicClient, network: string, owner: string | null): Promise<{ kind: OwnerKind; safe?: { threshold: number; owners: string[] } }> {
  if (!owner || owner.toLowerCase() === ZERO_ADDRESS) return { kind: "none" };
  const code = await rpc(network, () => client.getCode({ address: owner as Address }));
  if (!code || code === "0x") return { kind: "eoa" };
  const threshold = await tryRead(client, network, owner, SAFE_ABI, "getThreshold");
  const owners = await tryRead(client, network, owner, SAFE_ABI, "getOwners");
  if (threshold.ok && owners.ok && Array.isArray(owners.value)) {
    return { kind: "safe", safe: { threshold: Number(threshold.value), owners: (owners.value as string[]).map((entry) => getAddress(entry)) } };
  }
  return { kind: "contract" };
}

/** Stable string form of a read value (addresses checksummed, integers decimal). */
export function stringifyValue(value: unknown): string | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint" || typeof value === "number") return value.toString();
  if (typeof value === "string") return /^0x[0-9a-fA-F]{40}$/u.test(value) ? getAddress(value) : value;
  if (Array.isArray(value)) return JSON.stringify(value.map((entry) => stringifyValue(entry)));
  return JSON.stringify(value, (_key, inner: unknown) => (typeof inner === "bigint" ? inner.toString() : inner));
}
