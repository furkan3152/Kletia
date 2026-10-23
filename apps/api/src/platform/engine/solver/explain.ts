/**
 * Chip and question copy of the goal solver: short labels for APY, fees,
 * time and risk tier, and the reason codes the solver's assumed slots keep
 * (`why.code`).
 *
 * Every figure here is advisory: the static cost tables order candidates,
 * and the planner's auction prices the chosen route for real. Labels say
 * "about" for estimates and never print a value that was not read (an
 * unknown APY is "APY unavailable", an unpriced amount has no dollar figure).
 * English, no emoji, no em dashes.
 */
import { CHAINS, getProtocol, type AssumptionSource, type NetworkKey, type ProtocolId } from "@kletia/core";
import type { RiskTier } from "./risk.js";

/**
 * The solver's assumption codes and the template code an assumed slot stores
 * (`why.code` must be lower-case: core WHY_CODE_PATTERN).
 */
export const SOLVER_CODES = Object.freeze({
  SOLVER_SOURCE: "solver.source",
  SOLVER_VENUE_APY: "solver.venue-apy",
  SOLVER_BRIDGE: "solver.bridge",
  SOLVER_SCOPE: "solver.scope",
  SOLVER_TARGET_AMOUNT: "solver.target-amount",
  PRICE_USD: "price.usd",
} as const);
export type SolverCodeName = keyof typeof SOLVER_CODES;
export type SolverCode = (typeof SOLVER_CODES)[SolverCodeName];

/** The assumption source each code is shown under (core ASSUMPTION_SOURCES). */
export const SOLVER_CODE_SOURCES: Readonly<Record<SolverCode, AssumptionSource>> = Object.freeze({
  "solver.source": "balance",
  "solver.venue-apy": "default",
  "solver.bridge": "default",
  "solver.scope": "balance",
  "solver.target-amount": "price",
  "price.usd": "price",
});

/** The `why` an assumed slot of the solver keeps. */
export function solverWhy(code: SolverCode): { source: AssumptionSource; code: SolverCode } {
  return { source: SOLVER_CODE_SOURCES[code], code };
}

export const networkLabel = (network: NetworkKey): string => CHAINS[network].name;

export function protocolName(protocol: ProtocolId | string): string {
  return getProtocol(protocol as ProtocolId)?.name ?? protocol;
}

/** "4.1% APY" (a fraction in), or "APY unavailable". */
/** "4.1% APY (7-day)" for a venue the earn ranking compared; "rate not compared" otherwise. */
export function smoothedApyLabel(entry: { readonly compared: boolean; readonly smoothedApy: number | null }): string {
  return entry.compared && entry.smoothedApy !== null ? `${apyLabel(entry.smoothedApy)} (7-day)` : "rate not compared";
}

export function apyLabel(apy: number | null | undefined): string {
  if (apy === null || apy === undefined || !Number.isFinite(apy) || apy < 0) return "APY unavailable";
  const percent = apy * 100;
  const digits = percent >= 10 ? 1 : 2;
  return `${Number(percent.toFixed(digits))}% APY`;
}

/** "$0.12", "$1,204.50", "under $0.01". */
export function usdLabel(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) return "an unknown amount";
  if (usd > 0 && usd < 0.01) return "under $0.01";
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "about 2 min", "about 30 s", "about 2 days". */
export function secondsLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "time unknown";
  if (seconds < 90) return `about ${Math.max(1, Math.round(seconds))} s`;
  if (seconds < 90 * 60) return `about ${Math.round(seconds / 60)} min`;
  if (seconds < 36 * 3600) return `about ${Math.round(seconds / 3600)} h`;
  return `about ${Math.round(seconds / 86_400)} days`;
}

const RISK_LABELS: Readonly<Record<RiskTier, string>> = Object.freeze({
  core: "core venue",
  curated: "curated venue",
  extended: "extended venue",
  testnet: "testnet",
});

export function riskLabel(tier: RiskTier): string {
  return RISK_LABELS[tier];
}

/** "about $0.12 in fees, about 30 s" for a route summary. */
export function costLabel(feesUsd: number | null, seconds: number): string {
  const fees = feesUsd === null ? "fees unknown" : feesUsd < 0.01 ? "under $0.01 in fees" : `about ${usdLabel(feesUsd)} in fees`;
  return `${fees}, ${secondsLabel(seconds)}`;
}

/** A decimal amount trimmed for display (at most 6 decimals, no trailing zeros). */
export function amountLabel(value: string): string {
  const [whole = "0", fraction = ""] = value.split(".");
  const trimmed = fraction.slice(0, 6).replace(/0+$/u, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

/** "12:04" (UTC) for a price reading time. */
export function clockLabel(at: number): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "time unknown";
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")} UTC`;
}

/** "Jupiter", "Chainlink", "stablecoin par" for a price source (core JOURNEY_VALUE_SOURCES). */
export function priceSourceLabel(source: string): string {
  switch (source) {
    case "usd-par":
      return "stablecoin par";
    case "chainlink":
      return "Chainlink";
    case "jupiter":
      return "Jupiter";
    case "pyth":
      return "Pyth";
    case "venue-rate":
      return "the venue's rate";
    default:
      return source;
  }
}
