/**
 * Gas on every network that signs later (intent design C.1 rule 8, C.3,
 * A.4.12): the decision layer's static check, before planning. For each
 * network where one of the person's own steps must be signed after a step on
 * another network (the funds or the plan arrive there), the native gas asset
 * there must be held, or arrive with an earlier leg of the person's own (a
 * bridge of the gas asset, or a gas top-up on an arriving bridge). The
 * network the plan starts on is the person's own starting point (the preview
 * shows its fee). When it is short,
 * the decision layer asks GAS_ON_ARRIVAL: a top-up on the arriving leg (EVM
 * networks a bridge of the person's own arrives on: Relay serves them), or
 * plan anyway after adding gas, or cancel.
 *
 * Static on purpose: a known balance below a floor (a tenth of the network's
 * fee reserve) is short; an unknown balance is never short (unknown is never
 * zero; the preview warns again with live gas prices). The planner's own gas
 * plan (P3, `routing/gasPlan.ts`) checks again with live prices.
 *
 * Pure: every function reads only its arguments.
 */
import { CHAINS, NATIVE_FEE_RESERVE, type NetworkKey } from "@kletia/core";
import { cmp, parseDecimal, formatDecimal } from "../clarify/decimal.js";
import type { ResolvedAction } from "../clarify/types.js";

/** USD of gas a top-up delivers with an arriving leg (within GAS_ON_ARRIVAL_USD). */
export const GAS_TOPUP_USD = "0.50";

/** The floor below which a known gas balance cannot sign a step: a tenth of the network's fee reserve. */
export function gasFloor(network: NetworkKey): string {
  return formatDecimal(parseDecimal(NATIVE_FEE_RESERVE[network]) / 10n);
}

export interface GasShortfall {
  /** Where a step must be signed without gas. */
  readonly network: NetworkKey;
  /** The first action signed there. */
  readonly action: number;
  /** The gas balance read there (decimal). */
  readonly held: string;
  /** An earlier bridge of the person's own arrives there (a top-up can ride on it), or null. */
  readonly arriving: number | null;
}

/**
 * Networks where an own step must be signed after a step on another
 * network and the known gas balance is below the floor, with no gas arriving
 * before it. `balance` answers the
 * native balance (undefined: unknown, never short). `topups` are the
 * networks the plan already carries a gas top-up for.
 */
export function gasShortfalls(
  actions: readonly ResolvedAction[],
  balance: (network: NetworkKey, symbol: string) => string | undefined,
  topups: ReadonlySet<NetworkKey> = new Set(),
): GasShortfall[] {
  const out: GasShortfall[] = [];
  const seen = new Set<NetworkKey>();
  actions.forEach((action, index) => {
    const network = action.network;
    if (seen.has(network)) return;
    seen.add(network);
    // Where the plan starts (every step so far ran there): signed first, nothing arrives before it.
    if (actions.slice(0, index).every((earlier) => earlier.network === network)) return;
    const native = CHAINS[network].nativeAsset.symbol;
    const held = balance(network, native);
    if (held === undefined || cmp(held, gasFloor(network)) >= 0) return;
    if (topups.has(network)) return;
    // Gas that arrives first: an earlier bridge of the person's own that delivers the gas asset.
    let arriving: number | null = null;
    for (let earlier = index - 1; earlier >= 0; earlier -= 1) {
      const leg = actions[earlier] as ResolvedAction;
      if (leg.kind !== "bridge" || leg.toNetwork !== network || leg.recipient) continue;
      const delivers = (leg.to ?? leg.from).toUpperCase();
      if (delivers === native.toUpperCase()) return;
      arriving ??= earlier;
    }
    out.push({ network, action: index, held, arriving });
  });
  return out;
}
