/**
 * The ERC-4626 vault families Kletia executes, by venue kind: Morpho
 * (erc4626), Spark Savings (spark-vault), Fluid (fluid-ftoken) and Yearn V3
 * (yearn-vault), and Sky and Ethena (savings-vault). Read paths that start from a registry venue (metrics,
 * positions, capacity) find the family here; the adapters are built from
 * the same family objects, so both always run the same provenance checks.
 */
import type { YieldVenue } from "@kletia/core";
import type { LendingMetrics } from "./common.js";
import { morphoFamily, vaultMetrics, type VaultFamily, type VaultVenue } from "./erc4626.js";
import { fluidFamily } from "./fluid.js";
import { ethenaFamily, skyFamily } from "./savings.js";
import { sparkSavingsFamily } from "./sparkSavings.js";
import { yearnFamily } from "./yearn.js";

export const VAULT_FAMILIES: readonly VaultFamily[] = Object.freeze([morphoFamily, sparkSavingsFamily, fluidFamily, yearnFamily, skyFamily, ethenaFamily] as unknown as VaultFamily[]);

/** The family that executes `venue` (kind and protocol must both match), or null. */
export function vaultFamilyFor(venue: Pick<YieldVenue, "kind" | "protocol">): VaultFamily | null {
  return VAULT_FAMILIES.find((family) => family.kind === venue.kind && family.protocol === venue.protocol) ?? null;
}

/** Metrics of any vault venue through its family. */
export function vaultFamilyMetrics(venue: VaultVenue): Promise<LendingMetrics> {
  const family = vaultFamilyFor(venue);
  if (!family) return Promise.reject(new Error(`No vault family executes ${venue.id}.`));
  return vaultMetrics(family, venue);
}
