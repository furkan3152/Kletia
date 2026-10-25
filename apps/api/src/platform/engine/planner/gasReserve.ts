/**
 * Gas reserves (F6): the reader seam, reserve sizing and the warnings
 * for gas top-ups and DLN cancellation costs.
 */
import {
  CHAINS,
  getProtocol,
  nativeAssetId,
  gasReserveUnits,
  type AccountId,
  type AssetAmount,
  type IntentActionKind,
  type IntentRequest,
  type NetworkKey,
  type ParsedAccountId,
  type ProtocolId,
} from "@kletia/core";
import { PlatformError } from "../../errors.js";
import { ownAccountOn, sameAddress } from "../accounts.js";
import { effectiveProtocol } from "../adapters/registry.js";
import type { AdapterRoute, ProtocolAdapter } from "../adapters/types.js";
import { assetFromRef, type ResolvedAsset } from "../assets.js";
import { knownAmount, readFacts } from "../holdings.js";
import {
  estimateStepFee,
  gasPriceFrom,
  rentFrom,
  SOLANA_WALLET_RENT_FALLBACK,
} from "../journey/fees.js";
import { CONTRACT_KINDS, issue, UNKNOWN_PROTOCOL } from "./shared.js";
import type { DraftContext, NormalizedAction } from "./types.js";

/* --------------------------------------------------- gas reserve (F6) */

/** What the F6 gas reserve reads for one network: the account's gas balance and fee facts (null: unknown). */
export interface GasReserveFacts {
  readonly balance: bigint | null;
  readonly gasPriceWei: bigint | null;
  readonly walletRentLamports: bigint | null;
  readonly tokenAccountRentLamports: bigint | null;
}

export type GasReserveReader = (network: NetworkKey, account: ParsedAccountId, accounts: readonly AccountId[]) => Promise<GasReserveFacts>;

/** Deadline of the reserve's reads; a late or failed read counts as zero gas (fail closed: the reserve is kept). */
const GAS_RESERVE_DEADLINE_MS = 2_500;

/**
 * Wei per gas used when `eth_gasPrice` cannot be read: upper bounds of
 * recent prices (an estimate that is too high keeps a few cents more; one
 * that is too low leaves the user without gas).
 */
const FALLBACK_GAS_PRICE_WEI: Readonly<Partial<Record<NetworkKey, bigint>>> = Object.freeze({
  ethereum: 20_000_000_000n,
  base: 100_000_000n,
  optimism: 100_000_000n,
  arbitrum: 500_000_000n,
  polygon: 800_000_000_000n,
  arc: 300_000_000_000n,
  "arbitrum-sepolia": 500_000_000n,
});
const FALLBACK_GAS_PRICE_DEFAULT_WEI = 20_000_000_000n;

/** The default reader: holdings.readFacts (cached there), within GAS_RESERVE_DEADLINE_MS. */
const defaultGasReserveReader: GasReserveReader = async (network, account, accounts) => {
  const evm = CHAINS[network].vm === "evm";
  const facts = await readFacts(accounts, [
    { kind: "balance", network, asset: CHAINS[network].nativeAsset.symbol, owner: account.address },
    evm ? { kind: "gasPrice", network } : { kind: "solanaRent", network },
  ], { deadlineMs: GAS_RESERVE_DEADLINE_MS, balances: 1 });
  const rent = rentFrom(facts, network);
  return {
    balance: knownAmount(facts.balances[0]),
    gasPriceWei: evm ? gasPriceFrom(facts, network) : null,
    walletRentLamports: rent.wallet,
    tokenAccountRentLamports: rent.tokenAccount,
  };
};

export let gasReserveReader: GasReserveReader = defaultGasReserveReader;

/** Replaces the F6 reserve's reads (tests); `null` restores the holdings reader. */
export function configureGasReserveReader(reader: GasReserveReader | null): void {
  gasReserveReader = reader ?? defaultGasReserveReader;
}

/**
 * F6 gas reserve of a funded step whose input is the network's gas asset:
 * zero when the account already holds enough gas there for this step and
 * the later steps on the same network (fees from journey/fees.ts, the
 * costliest candidate venue counted), else gasReserveUnits(fees, Solana
 * wallet rent when the wallet is empty). An unreadable balance counts as zero.
 */
export async function plannedGasReserve(
  action: NormalizedAction,
  input: ResolvedAsset,
  protocols: readonly ProtocolId[],
  later: readonly NormalizedAction[],
  account: ParsedAccountId,
  request: IntentRequest,
): Promise<bigint> {
  const network = action.network;
  const svm = CHAINS[network].vm === "svm";
  const facts = await gasReserveReader(network, account, request.accounts).catch((): GasReserveFacts => ({
    balance: null, gasPriceWei: null, walletRentLamports: null, tokenAccountRentLamports: null,
  }));
  const gasPriceWei = facts.gasPriceWei ?? FALLBACK_GAS_PRICE_WEI[network] ?? FALLBACK_GAS_PRICE_DEFAULT_WEI;
  const fee = (kind: IntentActionKind, protocol: ProtocolId, spends: { readonly asset: string } | undefined): bigint => {
    const estimate = estimateStepFee({ kind, network, protocol, ...(spends ? { input: spends } : {}) }, {
      gasPriceWei,
      tokenAccountRentLamports: facts.tokenAccountRentLamports,
      // A swap, stake or deposit may create the output's token account (unknown counts as missing).
      ...(svm && kind !== "transfer" ? { tokenAccounts: [null] } : {}),
    });
    return estimate.amount === null ? 0n : BigInt(estimate.amount);
  };
  const own = (protocols.length > 0 ? protocols : [action.protocol ?? "relay"]).map((protocol) => fee(action.kind, protocol, { asset: input.id }));
  let fees = own.reduce((max, value) => (value > max ? value : max), 0n);
  for (const next of later) {
    if (next.network !== network) continue;
    const protocol: ProtocolId = next.protocol ?? (CONTRACT_KINDS.includes(next.kind) ? "custom-call" : UNKNOWN_PROTOCOL);
    fees += fee(next.kind, protocol, undefined);
  }
  if (facts.balance !== null && facts.balance >= fees) return 0n;
  const emptyWallet = facts.balance === null || facts.balance === 0n;
  const rent = svm && emptyWallet ? facts.walletRentLamports ?? SOLANA_WALLET_RENT_FALLBACK : 0n;
  return gasReserveUnits(fees, rent);
}

/** Committed warning line of a gas reserve (in the step and the plan record). */
export function reserveWarning(reserve: AssetAmount, network: NetworkKey): string {
  return `Keeps ${reserve.formatted} ${reserve.symbol} of what arrives for network fees on ${CHAINS[network].name}.`;
}

/** Committed warning line of a gas top-up. */
export function topupWarning(topup: AssetAmount, network: NetworkKey, adapter: ProtocolAdapter): string {
  const usd = topup.usd !== undefined ? ` (about $${topup.usd.toFixed(2)})` : "";
  return `Includes a gas top-up of ${topup.formatted} ${topup.symbol}${usd} on ${CHAINS[network].name}, delivered with the ${getProtocol(adapter.id)?.name ?? adapter.label} fill.`;
}

/** A cross-network leg can carry gas on arrival when it pays the user's own account and does not deliver the gas asset itself. */
export function gasTopupEligible(route: AdapterRoute, recipient: ParsedAccountId, accounts: readonly ParsedAccountId[]): boolean {
  return route.kind === "bridge" && route.network !== route.destinationNetwork && !route.output.isNative &&
    accounts.some((own) => sameAddress(own, recipient));
}

export function gasTopupUnavailable(network: NetworkKey, request: IntentRequest): PlatformError {
  const avoided = (request.constraints?.avoidProtocols ?? []).includes("relay") ? " (constraints.avoidProtocols excludes Relay)" : "";
  return new PlatformError(
    "GAS_TOPUP_UNAVAILABLE",
    `No venue can deliver gas on ${CHAINS[network].name} with this leg${avoided}. Relay serves EVM destinations when the output is not the gas asset; remove constraints.gasOnArrival.${network}, or bring gas yourself.`,
    422,
    issue(`constraints.gasOnArrival.${network}`, "No venue delivers gas with this leg."),
  );
}

/** Gas of a deBridge DLN cancel on the destination (typical, x1.5 headroom). */
const DLN_CANCEL_GAS_UNITS = 225_000n;
/** Lamports of a DLN cancel on Solana (signature plus priority fee). */
const DLN_CANCEL_LAMPORTS = 105_000n;

/**
 * deBridge DLN eligibility. An unfilled DLN order is cancelled only by its
 * destination authority, with a transaction on the destination network:
 * - across VMs without the person's own account on the destination, the
 *   authority would be the recipient: DLN is not eligible;
 * - a DLN leg needs gas on the destination for a possible cancel, or a gas
 *   top-up on the leg: a balance known to be short excludes DLN.
 * When DLN was the only venue, the step is refused (fail closed).
 */
export async function dlnEligible(
  candidates: ProtocolAdapter[],
  route: AdapterRoute,
  accounts: readonly ParsedAccountId[],
  request: IntentRequest,
  context: DraftContext,
): Promise<ProtocolAdapter[]> {
  if (route.kind !== "bridge" || route.network === route.destinationNetwork) return candidates;
  const isDln = (adapter: ProtocolAdapter) => effectiveProtocol(adapter, route) === "debridge-dln";
  if (!candidates.some(isDln)) return candidates;
  const own = ownAccountOn(accounts, route.destinationNetwork);
  const crossVm = CHAINS[route.network].namespace !== CHAINS[route.destinationNetwork].namespace;
  let reason: string | null = null;
  let gasShort: { needUnits: bigint; haveUnits: bigint } | null = null;
  if (crossVm && !own) {
    reason = `deBridge DLN needs your own account on ${CHAINS[route.destinationNetwork].name} to cancel an order no solver fills; add it to accounts.`;
  } else if (own && context.gasTopupUsd === undefined) {
    const facts = await gasReserveReader(route.destinationNetwork, own, request.accounts).catch(() => null);
    if (facts && facts.balance !== null) {
      const evm = CHAINS[route.destinationNetwork].vm === "evm";
      const price = facts.gasPriceWei ?? FALLBACK_GAS_PRICE_WEI[route.destinationNetwork] ?? FALLBACK_GAS_PRICE_DEFAULT_WEI;
      const need = evm ? DLN_CANCEL_GAS_UNITS * price : DLN_CANCEL_LAMPORTS;
      if (facts.balance < need) {
        gasShort = { needUnits: need, haveUnits: facts.balance };
        reason = `deBridge DLN needs ${CHAINS[route.destinationNetwork].nativeAsset.symbol} on ${CHAINS[route.destinationNetwork].name} to cancel an order no solver fills, and your account holds too little there.`;
      }
    }
  }
  if (!reason) return candidates;
  const kept = candidates.filter((adapter) => !isDln(adapter));
  if (kept.length > 0) return kept;
  if (gasShort) {
    throw new PlatformError("GAS_TOPUP_UNAVAILABLE", `${reason} Bring gas there first, or set constraints.gasOnArrival.${route.destinationNetwork}.`, 422,
      issue(`constraints.gasOnArrival.${route.destinationNetwork}`, "No gas for a possible cancel."), [],
      { network: route.destinationNetwork, needUnits: gasShort.needUnits.toString(), haveUnits: gasShort.haveUnits.toString() });
  }
  throw new PlatformError("ROUTE_UNSUPPORTED", reason, 422);
}

/** The network's native asset as a placeholder input of non-spending call / action steps. */
export function nativePlaceholder(network: NetworkKey): ResolvedAsset {
  const native = CHAINS[network].nativeAsset;
  return assetFromRef({ asset: nativeAssetId(network), symbol: native.symbol, decimals: native.decimals });
}

/** True when an argument binding (or a tuple member) reads `$previous.*`. */
export function usesPrevious(binding: unknown): boolean {
  if (typeof binding === "string") return binding.startsWith("$previous.");
  if (typeof binding === "object" && binding !== null && "tuple" in binding) return (binding as { tuple: unknown[] }).tuple.some(usesPrevious);
  return false;
}
