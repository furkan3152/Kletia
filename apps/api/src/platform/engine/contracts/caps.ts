/**
 * Amount limits of call / action steps, checked at plan and again at
 * prepare: the entry's own `minAmount` / `maxAmount` (input units) and the
 * per-step USD cap (`KLETIA_CONTRACT_STEP_MAX_USD`, default 10,000; lower,
 * `KLETIA_CONTRACT_UNVERIFIED_STEP_MAX_USD` default 1,000, while the
 * integrator's domain is unverified). An unpriced input is bounded by the
 * entry's `maxAmount` only (required on mainnet for spending entries).
 */
import {
  CHAINS,
  CONTRACT_LIMITS,
  fromBaseUnits,
  toBaseUnits,
  type ContractActionLimits,
} from "@kletia/core";
import { PlatformError, type PlatformIssue } from "../../errors.js";
import { isUsdStablecoin, type ResolvedAsset } from "../assets.js";
import { nativeUsdPrice, solanaMintUsdPrice } from "../prices.js";

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function contractStepMaxUsd(domainVerified: boolean): number {
  return domainVerified
    ? envNumber("KLETIA_CONTRACT_STEP_MAX_USD", CONTRACT_LIMITS.defaultStepMaxUsd)
    : envNumber("KLETIA_CONTRACT_UNVERIFIED_STEP_MAX_USD", CONTRACT_LIMITS.defaultUnverifiedStepMaxUsd);
}

/** USD value of `units` of `asset`, or null when Kletia has no price for it. */
export async function inputUsd(asset: ResolvedAsset, units: bigint): Promise<number | null> {
  const amount = Number(fromBaseUnits(units, asset.decimals));
  if (!Number.isFinite(amount)) return null;
  if (isUsdStablecoin(asset)) return amount;
  let price: number | null = null;
  if (asset.isNative) price = await nativeUsdPrice(asset.network);
  else if (CHAINS[asset.network].vm === "svm" && asset.address) price = await solanaMintUsdPrice(asset.address);
  else if (asset.canonical && asset.category === "wrapped" && asset.group === "ETH" && CHAINS[asset.network].nativeAsset.symbol === "ETH") price = await nativeUsdPrice(asset.network);
  return price === null ? null : amount * price;
}

/**
 * Enforces the entry limits and the USD cap on a step amount (base units).
 * Returns the step's USD value when priced (recorded against the key's daily
 * cap at prepare).
 */
export async function assertContractAmount(
  limits: ContractActionLimits | undefined,
  input: ResolvedAsset,
  units: bigint,
  domainVerified: boolean,
  label: string,
  path?: string,
): Promise<number | null> {
  const issues = (message: string): PlatformIssue[] | undefined => (path ? [{ path, message }] : undefined);
  const bound = (value: string | undefined) => (value === undefined ? null : BigInt(toBaseUnits(value, input.decimals)));
  const min = bound(limits?.minAmount);
  const max = bound(limits?.maxAmount);
  if (min !== null && units < min) {
    throw new PlatformError("CONTRACT_AMOUNT_LIMIT", `${label} takes at least ${limits?.minAmount} ${input.symbol}.`, 422, issues("Below the action's minAmount."));
  }
  if (max !== null && units > max) {
    throw new PlatformError("CONTRACT_AMOUNT_LIMIT", `${label} takes at most ${limits?.maxAmount} ${input.symbol}.`, 422, issues("Above the action's maxAmount."));
  }
  const usd = await inputUsd(input, units).catch(() => null);
  const cap = contractStepMaxUsd(domainVerified);
  if (usd !== null && usd > cap) {
    throw new PlatformError(
      "CONTRACT_AMOUNT_LIMIT",
      `${label} would move about $${usd.toFixed(2)}, above the $${cap} cap per custom contract step${domainVerified ? "" : " for integrators whose domain is not verified"}.`,
      422,
      issues("Above the per-step USD cap."),
    );
  }
  return usd;
}
