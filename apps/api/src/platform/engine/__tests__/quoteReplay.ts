/**
 * Recorded-quote replay of the U3 route matrix (design E.4 "route
 * regression"): every case of `fixtures/routes/u3-matrix.json` carries the
 * routes that were quoted independently on 2026-10-23 (each venue, each
 * composite via a carrier, with gas, extra costs and provider seconds). The
 * replay ranks the routes Kletia supports with the engine's own B.1 score
 * (`scoreLeg`) and selection rule (`selectRoute`: eligibility, the
 * multi-signature margin, ties), and measures the pick against the best
 * supported route by what arrives (expected output at the recorded price,
 * minus gas and extra costs). No network: venue statistics are the priors.
 *
 * The replay scores each recorded route as one candidate (a composite's
 * chained output, its legs as signatures, a claimed floor when any leg is
 * solver-filled), which is what the composer compares after chaining.
 */
import { readFileSync } from "node:fs";
import type { IntentActionKind, NetworkKey, ProtocolId, RoutePreference } from "@kletia/core";
import { floorWithinSlippage, isSolverFilled, scoreLeg, selectRoute, wholeUnits, type RankEntry } from "../routing/score.js";

export interface RecordedRoute {
  readonly name: string;
  readonly shape: string;
  readonly supported: boolean;
  readonly venues: readonly string[];
  readonly out: string;
  readonly min: string;
  readonly gasUsd: number;
  readonly extraUsd: number;
  readonly seconds: number;
  readonly legs: number;
}

export interface RecordedCase {
  readonly id: string;
  readonly type: "swap" | "bridge" | "xswap";
  readonly network: NetworkKey;
  readonly toNetwork: NetworkKey;
  readonly from: string;
  readonly to: string;
  readonly usd: number;
  readonly priceOut: number;
  readonly decimalsOut: number;
  readonly kletia: string | null;
  /** The sentence the U3 audit sent (live audits re-send it). */
  readonly text: string;
  readonly alts: readonly RecordedRoute[];
}

export function loadRouteMatrix(): readonly RecordedCase[] {
  const body = JSON.parse(readFileSync(new URL("./fixtures/routes/u3-matrix.json", import.meta.url), "utf8")) as { cases: RecordedCase[] };
  return body.cases;
}

/** Venues whose floor is enforced on-chain (the transaction reverts below it, or the deposit binds an exact output). */
const ONCHAIN_FLOOR = new Set(["uniswap-v3", "pancakeswap-v3", "aerodrome", "velodrome", "camelot", "curve", "jupiter", "across", "cctp-v2", "kyberswap"]);

/**
 * The quoted-minimum gap of a solver-filled leg inside a composite (its own
 * floor is not recorded separately): what the single-venue quotes of the same
 * matrix show, 50 bps for Relay and 5 bps for a DLN order (exact take).
 */
const SOLVER_LEG_GAP: Readonly<Record<string, number>> = { relay: 0.005, "debridge-dln": 0.0005, lifi: 0.005 };

function protocolOf(venue: string): ProtocolId {
  return venue as ProtocolId;
}

/** Realised value of a recorded route in USD: what arrives at the recorded price, minus gas and extra costs. */
export function realisedUsd(entry: RecordedCase, route: RecordedRoute): number {
  return wholeUnits(route.out, entry.decimalsOut) * entry.priceOut - route.gasUsd - route.extraUsd;
}

export interface ReplayResult {
  readonly pick: RecordedRoute | null;
  readonly best: RecordedRoute | null;
  /** (best - pick) / input USD, in bps (0 when the pick is the best). */
  readonly lossBps: number;
  readonly ordered: readonly RecordedRoute[];
}

/** Ranks the supported routes of one case with the B.1 score and selection rule. */
export function replayCase(entry: RecordedCase, options: { readonly slippageBps?: number; readonly preference?: RoutePreference; readonly maxSeconds?: number } = {}): ReplayResult {
  const slippageBps = options.slippageBps ?? 50;
  const maxSeconds = options.maxSeconds ?? 600;
  const preference = options.preference ?? "value";
  const supported = entry.alts.filter((route) => route.supported && BigInt(route.out) > 0n);
  const kind: IntentActionKind = entry.type === "swap" ? "swap" : "bridge";
  const entries: RankEntry<RecordedRoute>[] = supported.map((route, order) => {
    const composite = route.legs > 1;
    const venue = protocolOf(route.venues.find((name) => isSolverFilled(protocolOf(name), entry.network, entry.toNetwork)) ?? route.venues[0] ?? "relay");
    const solver = route.venues.some((name) => isSolverFilled(protocolOf(name), entry.network, entry.toNetwork));
    const floor = route.venues.every((name) => ONCHAIN_FLOOR.has(name)) ? "onchain" as const : "claimed" as const;
    // A composite's chained floor sums every leg's slippage; only its solver legs' quoted minimum is discounted (D1).
    const expectedUnits = wholeUnits(route.out, entry.decimalsOut);
    const solverGap = route.venues.reduce((gap, name) => gap + (SOLVER_LEG_GAP[name] ?? 0), 0);
    const minimumUnits = composite ? expectedUnits * (1 - solverGap) : wholeUnits(route.min, entry.decimalsOut);
    const scored = scoreLeg({
      venue,
      kind: composite ? "bridge" : kind,
      network: entry.network,
      destination: entry.toNetwork,
      expectedUnits,
      minimumUnits,
      floor,
      priceOut: entry.priceOut,
      inputUsd: entry.usd,
      extraCostsUsd: route.extraUsd,
      extraCostsOutUnits: 0,
      gasUsd: route.gasUsd,
      seconds: route.seconds,
      signatures: route.legs,
      sameAssetGroup: entry.from === entry.to,
      preference,
      nonFillCostUsd: solver ? route.gasUsd : 0,
      strandCostUsd: 0,
    });
    // A single leg's floor must sit within the slippage; a composite's legs each did (its chained floor is shown).
    const eligible = (composite || floorWithinSlippage(BigInt(route.out), BigInt(route.min), slippageBps)) && route.seconds <= maxSeconds;
    return {
      item: route,
      value: scored.value,
      mode: scored.mode,
      eligible,
      preferred: false,
      signatures: route.legs,
      legs: route.legs,
      seconds: route.seconds,
      onchainFloor: floor === "onchain",
      order,
    };
  });
  const { winner, ordered } = selectRoute(entries, { inputUsd: entry.usd, preference });
  const best = supported.reduce<RecordedRoute | null>((top, route) => (top === null || realisedUsd(entry, route) > realisedUsd(entry, top) ? route : top), null);
  const pick = winner?.item ?? null;
  const lossBps = pick && best ? Math.max(0, ((realisedUsd(entry, best) - realisedUsd(entry, pick)) / entry.usd) * 10_000) : 0;
  return { pick, best, lossBps, ordered: ordered.map((item) => item.item) };
}
