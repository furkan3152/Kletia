/**
 * Classifies a raw wallet transaction (chain/types.ts): its net legs (per
 * token: received minus sent by the wallet), the protocol it touched (the
 * called contract first, then the programs invoked, then the transfers'
 * counterparties; labels.ts) and its kind:
 *
 * - failed transactions are `failed`; approvals that move nothing `approve`;
 * - a labelled protocol decides by its family: bridges (`bridge-out` /
 *   `bridge-in`, or `swap` when a different token comes back on the same
 *   network), DEXes and aggregators (`swap`), lending and savings venues
 *   (`deposit` / `withdraw` by the receipt token's direction, `borrow` /
 *   `repay` by the method), liquid staking (`stake` / `unstake`), perps,
 *   native orders and prediction markets;
 * - otherwise the provider's label (Helius `type`) when it names one, then
 *   the transfers: one token out and another in is a `swap`, only out a
 *   `send` (a plain or token transfer), only in a `receive`; anything else
 *   that called a contract is a `contract-call`, the rest `unknown`.
 */
import type { DataTxKind, NetworkKey } from "@kletia/core";
import type { RawTransfer, RawTx } from "./chain/types.js";
import { contractLabel, type ContractLabel } from "./labels.js";

export interface NetLeg {
  readonly token: RawTransfer["token"];
  /** Decimal magnitude; null when a transfer amount was unknown. */
  readonly amount: string | null;
  readonly direction: "in" | "out";
}

export interface Classified {
  readonly kind: DataTxKind;
  readonly legs: readonly NetLeg[];
  readonly protocol: ContractLabel | null;
  /** Address of the labelled contract, or the plain transfer's other side. */
  readonly counterparty: string | null;
}

/* ------------------------------------------------------- decimal sums */

function scaleOf(amount: string): number {
  return amount.includes(".") ? amount.length - amount.indexOf(".") - 1 : 0;
}

function toScaled(amount: string, scale: number): bigint {
  const [whole = "0", fraction = ""] = amount.split(".");
  return BigInt(whole + fraction.padEnd(scale, "0").slice(0, scale));
}

function fromScaled(value: bigint, scale: number): string {
  if (scale === 0) return value.toString();
  const digits = value.toString().padStart(scale + 1, "0");
  const fraction = digits.slice(-scale).replace(/0+$/u, "");
  return fraction ? `${digits.slice(0, -scale)}.${fraction}` : digits.slice(0, -scale);
}

const tokenKey = (transfer: RawTransfer) => transfer.token.address ?? "native";

/** Net legs of `owner`: per token, what came in minus what went out (tokens that net to zero are left out). */
export function netLegs(transfers: readonly RawTransfer[], owner: string, sameAddress: (a: string, b: string) => boolean): NetLeg[] {
  const groups = new Map<string, RawTransfer[]>();
  for (const transfer of transfers) {
    const list = groups.get(tokenKey(transfer)) ?? [];
    list.push(transfer);
    groups.set(tokenKey(transfer), list);
  }
  const legs: NetLeg[] = [];
  for (const list of groups.values()) {
    const token = list[0]!.token;
    const ins = list.filter((transfer) => transfer.to !== null && sameAddress(transfer.to, owner));
    const outs = list.filter((transfer) => transfer.from !== null && sameAddress(transfer.from, owner));
    const self = (transfer: RawTransfer) => ins.includes(transfer) && outs.includes(transfer);
    if (list.some((transfer) => transfer.amount === null)) {
      const direction = ins.some((transfer) => !self(transfer)) ? "in" : "out";
      if (ins.length + outs.length > 0) legs.push({ token, amount: null, direction });
      continue;
    }
    const scale = Math.max(0, ...list.map((transfer) => scaleOf(transfer.amount!)));
    let net = 0n;
    for (const transfer of ins) net += toScaled(transfer.amount!, scale);
    for (const transfer of outs) net -= toScaled(transfer.amount!, scale);
    if (net === 0n) continue;
    legs.push({ token, amount: fromScaled(net < 0n ? -net : net, scale), direction: net > 0n ? "in" : "out" });
  }
  return legs;
}

/* ------------------------------------------------------------ labels */

function evmSame(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function sameFor(network: NetworkKey): (a: string, b: string) => boolean {
  return network.startsWith("solana") ? (a, b) => a === b : evmSame;
}

/** The protocol touched: called contract, then programs, then transfer counterparties (tokens never count). */
function protocolOf(tx: RawTx): { label: ContractLabel; address: string } | null {
  const candidates = [tx.to, ...tx.programs, ...tx.transfers.flatMap((transfer) => [transfer.to, transfer.from])];
  for (const address of candidates) {
    if (!address) continue;
    const label = contractLabel(tx.network, address);
    if (label && label.family !== "token" && label.family !== "other") return { label, address };
  }
  return null;
}

/* ------------------------------------------------------------- kinds */

/** Helius transaction types that name a kind outright (docs.helius.dev, TransactionType). */
const HINTS: Readonly<Record<string, DataTxKind>> = Object.freeze({
  SWAP: "swap",
  STAKE_SOL: "stake",
  UNSTAKE_SOL: "unstake",
  DEPOSIT: "deposit",
  WITHDRAW: "withdraw",
  LOAN: "borrow",
  REPAY_LOAN: "repay",
});

function methodKind(method: string): DataTxKind | null {
  const lower = method.toLowerCase();
  if (/borrow/u.test(lower)) return "borrow";
  if (/repay/u.test(lower)) return "repay";
  if (/withdraw|redeem/u.test(lower)) return "withdraw";
  if (/supply|deposit/u.test(lower)) return "deposit";
  return null;
}

function lendingKind(tx: RawTx, legs: readonly NetLeg[]): DataTxKind {
  const byMethod = tx.method ? methodKind(tx.method) : null;
  if (byMethod) return byMethod;
  const receipt = (leg: NetLeg) => leg.token.address !== null && contractLabel(tx.network, leg.token.address)?.role === "receipt";
  if (legs.some((leg) => leg.direction === "in" && receipt(leg)) || (legs.length > 0 && legs.every((leg) => leg.direction === "out"))) return "deposit";
  if (legs.some((leg) => leg.direction === "out" && receipt(leg))) return "withdraw";
  return "contract-call";
}

function stakingKind(tx: RawTx, legs: readonly NetLeg[]): DataTxKind {
  const stakeToken = (leg: NetLeg) => {
    const label = leg.token.address ? contractLabel(tx.network, leg.token.address) : null;
    return label !== null && (label.role === "lst-token" || label.role === "pool-mint");
  };
  if (legs.some((leg) => leg.direction === "out" && stakeToken(leg))) return "unstake";
  if (legs.some((leg) => leg.direction === "out")) return "stake";
  return legs.length > 0 ? "unstake" : "contract-call";
}

function familyKind(tx: RawTx, label: ContractLabel, legs: readonly NetLeg[]): DataTxKind {
  const ins = legs.filter((leg) => leg.direction === "in");
  const outs = legs.filter((leg) => leg.direction === "out");
  switch (label.family) {
    case "bridge":
      if (ins.length > 0 && outs.length > 0) return "swap";
      if (outs.length > 0) return "bridge-out";
      return ins.length > 0 ? "bridge-in" : "contract-call";
    case "dex":
      return legs.length > 0 ? "swap" : "contract-call";
    case "lending":
      return lendingKind(tx, legs);
    case "staking":
      return stakingKind(tx, legs);
    case "perp":
      return "perp";
    case "order":
      return "order";
    case "prediction":
      return "prediction";
    default:
      return "contract-call";
  }
}

function transferKind(tx: RawTx, legs: readonly NetLeg[]): DataTxKind {
  const ins = legs.filter((leg) => leg.direction === "in");
  const outs = legs.filter((leg) => leg.direction === "out");
  const plain = tx.method === null || /^transfer/iu.test(tx.method);
  if (ins.length === 1 && outs.length === 1) return "swap";
  if (outs.length > 0 && ins.length === 0) return plain ? "send" : "contract-call";
  if (ins.length > 0 && outs.length === 0) return tx.from !== null && sameFor(tx.network)(tx.from, tx.owner) && !plain ? "contract-call" : "receive";
  if (legs.length > 0 || tx.method !== null || tx.to !== null || tx.programs.length > 0) return "contract-call";
  return "unknown";
}

/** The other side of a send or receive, when exactly one address is on it. */
function transferCounterparty(tx: RawTx, kind: DataTxKind): string | null {
  const same = sameFor(tx.network);
  const sides = new Set(
    tx.transfers.flatMap((transfer) => (kind === "send" ? [transfer.to] : kind === "receive" ? [transfer.from] : [])).filter((address): address is string => address !== null && !same(address, tx.owner)),
  );
  if (sides.size === 1) return [...sides][0]!;
  return tx.to;
}

export function classifyTransaction(tx: RawTx): Classified {
  const legs = netLegs(tx.transfers, tx.owner, sameFor(tx.network));
  const touched = protocolOf(tx);
  if (tx.status === "failed") return { kind: "failed", legs: [], protocol: touched?.label ?? null, counterparty: touched?.address ?? tx.to };
  if (legs.length === 0 && tx.method !== null && /^(approve|increaseallowance|setapprovalforall|permit)/iu.test(tx.method)) {
    return { kind: "approve", legs, protocol: contractLabel(tx.network, tx.to) ?? null, counterparty: tx.to };
  }
  if (touched) return { kind: familyKind(tx, touched.label, legs), legs, protocol: touched.label, counterparty: touched.address };
  const hinted = tx.hint ? HINTS[tx.hint] : undefined;
  if (hinted) return { kind: hinted, legs, protocol: null, counterparty: tx.to };
  const kind = transferKind(tx, legs);
  return { kind, legs, protocol: null, counterparty: kind === "send" || kind === "receive" ? transferCounterparty(tx, kind) : tx.to };
}
