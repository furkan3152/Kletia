/**
 * The user's asset movements in a simulated block or in landed receipts, and
 * the refusal rules of custom contract calls:
 *
 * 1. every call succeeds (the caller checks statuses);
 * 2. the input debit equals the step amount exactly (native: the call value);
 * 3. no other token, NFT or native debit from the user;
 * 4. no Approval / ApprovalForAll by the user other than the prepared exact
 *    approval (and allowance decrements of it), and, in simulation, the
 *    allowance read after the call is 0;
 * 5. the declared output reaches the recipient (> 0);
 * 6. undeclared credits are allowed and listed in the review.
 *
 * ERC-20 `Transfer` has 3 topics, ERC-721 `Transfer` 4; ERC-1155
 * `TransferSingle` / `TransferBatch` carry `from` in topic 2. traceTransfers
 * reports native value moves as Transfer logs from 0xEeee…; Polygon's
 * `0x…1010` system logs (POL's native token contract) are ignored.
 */
import { getAddress, keccak256, toHex } from "viem";
import {
  CHAINS,
  findAssetByAddress,
  formatAssetId,
  fromBaseUnits,
  nativeAssetId,
  type AssetChange,
} from "@kletia/core";
import { readErc20Metadata, type EvmNetworkKey } from "../chains/evm.js";
import { NATIVE_TRANSFER_EMITTER } from "./simulationRpc.js";

const topic = (signature: string) => keccak256(toHex(signature)).toLowerCase();

export const EVENT_TOPICS = Object.freeze({
  transfer: topic("Transfer(address,address,uint256)"),
  approval: topic("Approval(address,address,uint256)"),
  approvalForAll: topic("ApprovalForAll(address,address,bool)"),
  transferSingle: topic("TransferSingle(address,address,address,uint256,uint256)"),
  transferBatch: topic("TransferBatch(address,address,address,uint256[],uint256[])"),
});

const POLYGON_SYSTEM_LOG = "0x0000000000000000000000000000000000001010";

export interface FlowLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
}

export interface UserFlows {
  /** Gross ERC-20 debits of the user per token (lower-case address). */
  readonly debits: Map<string, bigint>;
  /** Gross ERC-20 credits per token. */
  readonly credits: Map<string, bigint>;
  readonly nativeOut: bigint;
  readonly nativeIn: bigint;
  /** ERC-721 / ERC-1155 tokens moved out of the user. */
  readonly nftOut: readonly string[];
  /** Approval logs whose owner is the user. */
  readonly approvals: readonly { readonly token: string; readonly spender: string; readonly value: bigint | null }[];
  /** ApprovalForAll logs whose owner is the user. */
  readonly approvalsForAll: readonly { readonly token: string; readonly operator: string; readonly approved: boolean }[];
}

function topicAddress(value: string | undefined): string | null {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/u.test(value)) return null;
  return `0x${value.slice(26)}`;
}

function word(data: string, index = 0): bigint | null {
  const body = data.slice(2);
  const chunk = body.slice(index * 64, index * 64 + 64);
  return chunk.length === 64 && /^[0-9a-fA-F]+$/u.test(chunk) ? BigInt(`0x${chunk}`) : null;
}

function add(map: Map<string, bigint>, key: string, value: bigint): void {
  map.set(key, (map.get(key) ?? 0n) + value);
}

/** Collects the movements of `owner`'s assets (and of `recipient`'s credits) from logs. */
export function userFlows(logs: readonly FlowLog[], owner: string): UserFlows {
  const user = owner.toLowerCase();
  const flows = {
    debits: new Map<string, bigint>(),
    credits: new Map<string, bigint>(),
    nativeOut: 0n,
    nativeIn: 0n,
    nftOut: [] as string[],
    approvals: [] as { token: string; spender: string; value: bigint | null }[],
    approvalsForAll: [] as { token: string; operator: string; approved: boolean }[],
  };
  for (const log of logs) {
    const address = log.address.toLowerCase();
    if (address === POLYGON_SYSTEM_LOG) continue;
    const topics = log.topics.map((entry) => entry.toLowerCase());
    const kind = topics[0];
    if (kind === EVENT_TOPICS.transfer) {
      const from = topicAddress(topics[1]);
      const to = topicAddress(topics[2]);
      if (topics.length === 4) {
        if (from === user) flows.nftOut.push(address);
        continue;
      }
      if (topics.length !== 3) continue;
      const value = word(log.data);
      if (value === null) continue;
      if (address === NATIVE_TRANSFER_EMITTER) {
        if (from === user) flows.nativeOut += value;
        if (to === user) flows.nativeIn += value;
        continue;
      }
      if (from === user) add(flows.debits, address, value);
      if (to === user) add(flows.credits, address, value);
    } else if (kind === EVENT_TOPICS.approval && topicAddress(topics[1]) === user) {
      const spender = topicAddress(topics[2]) ?? "";
      flows.approvals.push({ token: address, spender, value: topics.length === 3 ? word(log.data) : null });
    } else if (kind === EVENT_TOPICS.approvalForAll && topicAddress(topics[1]) === user) {
      flows.approvalsForAll.push({ token: address, operator: topicAddress(topics[2]) ?? "", approved: word(log.data) !== 0n });
    } else if ((kind === EVENT_TOPICS.transferSingle || kind === EVENT_TOPICS.transferBatch) && topicAddress(topics[2]) === user) {
      flows.nftOut.push(address);
    }
  }
  return flows;
}

/** ERC-20 credits of `token` to `recipient` in logs. */
export function creditsTo(logs: readonly FlowLog[], token: string, recipient: string): bigint {
  const wanted = token.toLowerCase();
  const to = recipient.toLowerCase();
  let total = 0n;
  for (const log of logs) {
    const topics = log.topics.map((entry) => entry.toLowerCase());
    if (log.address.toLowerCase() !== wanted || topics[0] !== EVENT_TOPICS.transfer || topics.length !== 3) continue;
    if (topicAddress(topics[2]) !== to) continue;
    total += word(log.data) ?? 0n;
  }
  return total;
}

export interface FlowRules {
  /** The step input: ERC-20 token (lower-case) or null for native; null overall for non-spending entries. */
  readonly input: { readonly token: string | null; readonly amount: bigint } | null;
  /** `msg.value` of the call. */
  readonly value: bigint;
  /** The prepared exact approval, or the pinned spender of a pre-existing allowance. */
  readonly approval: { readonly token: string; readonly spender: string; readonly amount: bigint | null } | null;
  /** Simulation: native debits are traced (receipts carry none, the value is bound by the payload). */
  readonly traced: boolean;
}

/** The first rule the user's flows break, or null. */
export function flowRefusal(flows: UserFlows, rules: FlowRules): string | null {
  const input = rules.input;
  if (input && input.token !== null) {
    const debit = flows.debits.get(input.token) ?? 0n;
    if (debit !== input.amount) return `The input debit is ${debit} base units, not exactly the step amount ${input.amount}.`;
  }
  for (const [token, debit] of flows.debits) {
    if (debit > 0n && token !== input?.token) return `The call also debits another token from the user (${token}).`;
  }
  if (flows.nftOut.length > 0) return `The call moves an NFT or multi-token out of the user (${flows.nftOut[0]}).`;
  if (rules.traced) {
    if (flows.nativeOut !== rules.value) return `The user sends ${flows.nativeOut} wei of native value, not exactly the declared ${rules.value}.`;
  }
  for (const approval of flows.approvals) {
    const allowed = rules.approval &&
      approval.token === rules.approval.token.toLowerCase() &&
      approval.spender === rules.approval.spender.toLowerCase() &&
      approval.value !== null &&
      (rules.approval.amount === null || approval.value <= rules.approval.amount);
    if (!allowed) return `The call approves ${approval.spender || "a spender"} on ${approval.token} from the user, beyond the prepared exact approval.`;
  }
  if (flows.approvalsForAll.length > 0) return `The call grants an operator approval for all tokens of ${flows.approvalsForAll[0]?.token}.`;
  return null;
}

/* ------------------------------------------------------------- review rows */

interface TokenMeta {
  readonly symbol: string;
  readonly decimals: number;
  readonly listed: boolean;
}

const metaCache = new Map<string, TokenMeta>();

async function tokenMeta(network: EvmNetworkKey, token: string): Promise<TokenMeta> {
  const listed = findAssetByAddress(network, token);
  if (listed) return { symbol: listed.symbol, decimals: listed.decimals, listed: true };
  const key = `${network}:${token.toLowerCase()}`;
  const cached = metaCache.get(key);
  if (cached) return cached;
  try {
    const metadata = await readErc20Metadata(network, token);
    const meta = { symbol: metadata.symbol, decimals: metadata.decimals, listed: false };
    metaCache.set(key, meta);
    return meta;
  } catch {
    return { symbol: `${token.slice(0, 6)}…${token.slice(-4)}`, decimals: 0, listed: false };
  }
}

function signed(delta: bigint, decimals: number): string {
  const magnitude = delta < 0n ? -delta : delta;
  return `${delta < 0n ? "-" : "+"}${fromBaseUnits(magnitude, decimals)}`;
}

/** The user's net asset changes as review rows (native first, then tokens). */
export async function assetChangeRows(network: EvmNetworkKey, flows: UserFlows, traced: boolean): Promise<AssetChange[]> {
  const rows: AssetChange[] = [];
  const chain = CHAINS[network];
  const native = flows.nativeIn - flows.nativeOut;
  if (traced && native !== 0n) {
    rows.push({
      asset: nativeAssetId(chain),
      symbol: chain.nativeAsset.symbol,
      decimals: chain.nativeAsset.decimals,
      listed: true,
      delta: native.toString(),
      formatted: signed(native, chain.nativeAsset.decimals),
    });
  }
  const tokens = [...new Set([...flows.debits.keys(), ...flows.credits.keys()])].sort();
  for (const token of tokens) {
    const delta = (flows.credits.get(token) ?? 0n) - (flows.debits.get(token) ?? 0n);
    if (delta === 0n) continue;
    const meta = await tokenMeta(network, token);
    rows.push({
      asset: formatAssetId(network, "erc20", getAddress(token)),
      symbol: meta.symbol,
      decimals: meta.decimals,
      listed: meta.listed,
      delta: delta.toString(),
      formatted: signed(delta, meta.decimals),
    });
  }
  return rows;
}
