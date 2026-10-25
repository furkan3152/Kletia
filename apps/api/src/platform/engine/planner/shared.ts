/**
 * Planner constants and the small helpers every stage uses.
 */
import {
  CHAINS,
  getProtocol,
  toBaseUnits,
  type IntentActionKind,
  type NetworkKey,
  type ProtocolId,
} from "@kletia/core";
import { PlatformError } from "../../errors.js";
import type { ResolvedAsset } from "../assets.js";
import {
  EVM_STAKING_NETWORK,
  EVM_STAKING_TOKENS,
  NATIVE_STAKE_PROTOCOL,
} from "../grammar.js";

export const DEFAULT_SLIPPAGE_BPS = 50;
export const INTENT_TTL_MS = 30 * 60 * 1000;

export const SUPPORTED_KINDS: readonly IntentActionKind[] = ["swap", "transfer", "bridge", "stake", "deposit", "withdraw", "call", "action"];
/** Kinds bound to an integrator contract registration (`contract` + `entry`). */
export const CONTRACT_KINDS: readonly IntentActionKind[] = ["call", "action"];
/** Lending protocols in the order a deposit / withdraw without a named protocol tries them. */
export const LENDING_PROTOCOLS: readonly ProtocolId[] = [
  "aave-v3", "compound-v3", "morpho", "moonwell", "jupiter-lend", "kamino",
  // appended, so unnamed deposits keep their defaults
  "spark-savings", "fluid", "sparklend", "yearn-v3",
];
/** Solana liquid staking: protocol id -> LIQUID_STAKING_TOKENS key (routes run through Jupiter). */
export const STAKE_PROTOCOLS: Readonly<Partial<Record<ProtocolId, string>>> = {
  jito: "jito",
  marinade: "marinade",
  sanctum: "jupiter",
  jupiter: "jito",
};
/** EVM liquid staking on Ethereum: protocol id -> the token it mints and the provider label. */
export const EVM_STAKE_PROTOCOLS: Readonly<Partial<Record<ProtocolId, { readonly symbol: string; readonly provider: string }>>> = Object.fromEntries(
  Object.values(EVM_STAKING_TOKENS).map((entry) => [entry.protocol, { symbol: entry.symbol, provider: entry.provider }]),
);
/** Networks liquid staking may plan on (the adapters decide what is live). */
export const STAKE_NETWORKS: readonly NetworkKey[] = ["solana", EVM_STAKING_NETWORK];
/** Networks native SOL staking (a stake account delegated to a validator) may plan on. */
export const NATIVE_STAKE_NETWORKS: readonly NetworkKey[] = (getProtocol(NATIVE_STAKE_PROTOCOL)?.networks ?? []).filter((network) => CHAINS[network].vm === "svm");

/** Longest lifetime an intent can be given (a held intent waiting for approval). */
export const MAX_INTENT_TTL_MS = 24 * 60 * 60 * 1000;

export function intentTtl(ttlMs: number | undefined): number {
  if (ttlMs === undefined || !Number.isFinite(ttlMs)) return INTENT_TTL_MS;
  return Math.min(MAX_INTENT_TTL_MS, Math.max(INTENT_TTL_MS, Math.floor(ttlMs)));
}

export function issue(path: string, message: string) {
  return [{ path, message }];
}

/** "a", "a and b", "a, b and c". */
export function joinList(items: readonly string[], last = "and"): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ${last} ${items[items.length - 1]}`;
}

/** Refusals of the strict grammar itself (not of planning): what the strict Goal-reader fallback may read instead. */
export const GRAMMAR_REFUSALS = new WeakSet<object>();

/** True when `error` is the strict grammar's own INTENT_UNSUPPORTED for the request text. */
export function isGrammarRefusal(error: unknown): boolean {
  return typeof error === "object" && error !== null && GRAMMAR_REFUSALS.has(error);
}

export function baseUnits(value: string, asset: ResolvedAsset, index: number): string {
  let units: string;
  try {
    units = toBaseUnits(value, asset.decimals);
  } catch {
    throw new PlatformError(
      "AMOUNT_INVALID",
      `${value} ${asset.symbol} has more than ${asset.decimals} decimal places.`,
      422,
      issue(`actions[${index}].amount`, "Too precise."),
    );
  }
  if (units === "0") throw new PlatformError("AMOUNT_INVALID", "Amount must be positive.", 422, issue(`actions[${index}].amount`, "Zero."));
  return units;
}

/** A later step whose venue is not chosen yet: fees.ts then counts the kind's costliest typical transactions. */
export const UNKNOWN_PROTOCOL = "" as ProtocolId;
