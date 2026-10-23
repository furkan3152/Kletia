/**
 * Route regression over the recorded U3 matrix (design E.4): the B.1 score
 * and selection rule replayed on 164 recorded route choices (swaps, bridges,
 * cross-network swaps; fixtures/routes/u3-matrix.json, quoteReplay.ts).
 *
 * Gates:
 * - loss-weighted (USD) <= 2 bps against the best supported route;
 * - every case above 10 bps is explained by a reviewed B.1 rule: the
 *   multi-signature margin (a composite must beat the best one-signature
 *   route by max($0.50, 3 bps), owner decision O3) or the claimed-floor
 *   discount (a solver's quoted minimum counts half its gap, D1); any other
 *   loss fails;
 * - a pick wherever a supported route exists (no refusals);
 * - deterministic picks (two replays agree);
 * - the expected picks of the design (Across for EVM USDC and, since P3-M3,
 *   ETH bridges; a USDC-carrier composite for token-changing crossings at
 *   $5,000 and more; DLN for Arbitrum ETH -> OP at $100k; the USDC composite
 *   for Base 100k USDC -> BONK; the USDT two-hop for Polygon USDC -> WETH).
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { MULTI_SIGNATURE_MARGIN, LAMBDA_S_USD, LAMBDA_T_USD_PER_SECOND } from "../routing/score.js";
import { resetEngine } from "./helpers.js";
import { loadRouteMatrix, realisedUsd, replayCase, type RecordedCase, type RecordedRoute } from "./quoteReplay.js";

const MATRIX = loadRouteMatrix();

/** Why a pick loses more than 10 bps to the best supported route, or null when no reviewed rule explains it. */
function explained(entry: RecordedCase, pick: RecordedRoute, best: RecordedRoute): string | null {
  const gap = realisedUsd(entry, best) - realisedUsd(entry, pick);
  const extraLegs = best.legs - pick.legs;
  if (extraLegs > 0) {
    const margin = Math.max(MULTI_SIGNATURE_MARGIN.minUsd, (entry.usd * MULTI_SIGNATURE_MARGIN.bps) / 10_000);
    const costs = margin + LAMBDA_S_USD * extraLegs + LAMBDA_T_USD_PER_SECOND * Math.max(0, best.seconds - pick.seconds);
    if (gap <= costs + 1e-9) return "multi-signature margin (O3)";
  }
  const claimed = best.venues.some((venue) => venue === "relay" || venue === "debridge-dln" || venue === "lifi");
  if (claimed && BigInt(best.min) < BigInt(best.out)) {
    const discount = 0.5 * (Number(BigInt(best.out) - BigInt(best.min)) / 10 ** entry.decimalsOut) * entry.priceOut;
    if (gap <= discount + 1e-9) return "claimed-floor discount (D1)";
  }
  return null;
}

describe("route regression over the recorded U3 matrix (E.4)", () => {
  beforeEach(() => {
    resetEngine();
  });

  it("loses at most 2 bps loss-weighted, and every case above 10 bps is a reviewed B.1 rule", () => {
    let weighted = 0;
    let total = 0;
    const unexplained: string[] = [];
    const reviewed = new Map<string, number>();
    for (const entry of MATRIX) {
      const result = replayCase(entry);
      if (!result.pick || !result.best) continue;
      weighted += result.lossBps * entry.usd;
      total += entry.usd;
      if (result.lossBps > 10) {
        const why = explained(entry, result.pick, result.best);
        if (why) reviewed.set(why, (reviewed.get(why) ?? 0) + 1);
        else unexplained.push(`${entry.id}: ${result.lossBps.toFixed(1)} bps (${result.pick.name} instead of ${result.best.name})`);
      }
    }
    const lossWeighted = weighted / total;
    assert.ok(lossWeighted <= 2, `loss-weighted ${lossWeighted.toFixed(3)} bps`);
    assert.deepEqual(unexplained, [], "every loss above 10 bps is a reviewed rule");
    assert.ok((reviewed.get("claimed-floor discount (D1)") ?? 0) + (reviewed.get("multi-signature margin (O3)") ?? 0) > 0, "the reviewed trade-offs are exercised");
  });

  it("picks a route wherever a supported one exists, deterministically", () => {
    for (const entry of MATRIX) {
      const first = replayCase(entry);
      const again = replayCase(entry);
      const supported = entry.alts.some((route) => route.supported && BigInt(route.out) > 0n);
      if (supported) assert.ok(first.pick, `${entry.id}: no pick`);
      assert.equal(first.pick?.name, again.pick?.name, `${entry.id}: same pick on replay`);
    }
  });

  it("makes the design's expected picks", () => {
    const pick = (id: string) => {
      const entry = MATRIX.find((candidate) => candidate.id === id);
      assert.ok(entry, id);
      return replayCase(entry).pick?.name ?? "none";
    };
    for (const entry of MATRIX.filter((candidate) => candidate.type === "bridge" && candidate.from === "USDC" && candidate.network !== "solana" && candidate.toNetwork !== "solana" && candidate.usd >= 5_000)) {
      assert.match(pick(entry.id), /^(across|cctp-v2 fast)/u, `${entry.id}: Across (or CCTP Fast at equal value) for EVM USDC`);
    }
    for (const entry of MATRIX.filter((candidate) => candidate.type === "bridge" && candidate.from === "ETH" && candidate.usd >= 5_000)) {
      assert.match(pick(entry.id), /^across/u, `${entry.id}: Across ETH (P3-M3), the best on every lane in U3`);
    }
    const tokenChanging = MATRIX.filter((candidate) => candidate.type === "xswap" && candidate.usd >= 5_000);
    const composites = tokenChanging.filter((entry) => /^composite/u.test(pick(entry.id))).length;
    assert.ok(composites >= 12, `${composites} of ${tokenChanging.length} token-changing crossings use a carrier composite`);
    assert.equal(pick("xswap:arbitrum:ETH>optimism:OP:100000"), "debridge-dln");
    assert.match(pick("xswap:base:USDC>solana:BONK:100000"), /^composite via USDC/u);
    assert.match(pick("swap:polygon:USDC>WETH:5000"), /via USDT/u);
  });
});
