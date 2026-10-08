/**
 * `IntentStep.quoteRef` encoding. The planner records what it needs to
 * re-prepare a step later (provider quote id, applied slippage, the share of
 * the previous step's output the step consumes, liquid-staking provider, the
 * planned price floor) and every prepare appends its payload's guaranteed
 * minimum.
 */
import { isBaseUnitAmount } from "@kletia/core";
import { base64UrlDecode, base64UrlEncode, canonicalJson, isRecord } from "./util.js";

/** Guaranteed minimum output of one prepared payload. */
export interface PreparedFloor {
  /** Unix seconds when the payload was prepared. */
  readonly at: number;
  /** Base units of the step output the payload guarantees. */
  readonly min: string;
}

/** Most recent prepares whose floors are kept (older payloads have long expired). */
export const MAX_PREPARED_FLOORS = 12;

export interface StepRef {
  readonly v: 1;
  readonly slippageBps: number;
  readonly quote?: string;
  /** Share (bps) of the funding step's output consumed by this step. */
  readonly portionBps?: number;
  readonly provider?: string;
  /** Planned input and guaranteed minimum output (base units): the price floor every prepare is held to. */
  readonly plannedInput?: string;
  readonly plannedMinimum?: string;
  /** Floors of the most recent prepared payloads, oldest first. */
  readonly floors?: readonly PreparedFloor[];
}

const PREFIX = "kq1.";
const MAX_AMOUNT_DIGITS = 78;

function amount(value: unknown): value is string {
  return isBaseUnitAmount(value) && value.length <= MAX_AMOUNT_DIGITS;
}

export function encodeStepRef(ref: StepRef): string {
  return `${PREFIX}${base64UrlEncode(canonicalJson(ref))}`;
}

/** Malformed entries are dropped rather than invalidating the whole ref (slippage, plan). */
function decodeFloors(value: unknown): PreparedFloor[] {
  if (!Array.isArray(value)) return [];
  const floors: PreparedFloor[] = [];
  for (const entry of value.slice(-MAX_PREPARED_FLOORS)) {
    if (isRecord(entry) && typeof entry.at === "number" && Number.isSafeInteger(entry.at) && entry.at > 0 && amount(entry.min)) {
      floors.push({ at: entry.at, min: entry.min });
    }
  }
  return floors;
}

export function decodeStepRef(value: string | undefined): StepRef | null {
  if (!value || !value.startsWith(PREFIX)) return null;
  const json = base64UrlDecode(value.slice(PREFIX.length));
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.v !== 1) return null;
  const slippageBps = parsed.slippageBps;
  if (typeof slippageBps !== "number" || !Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 1_000) return null;
  const portion = parsed.portionBps;
  if (portion !== undefined && (typeof portion !== "number" || !Number.isInteger(portion) || portion < 1 || portion > 10_000)) {
    return null;
  }
  // The planned floor is used only as a complete, usable pair (otherwise callers fall back to the step amounts).
  const { plannedInput, plannedMinimum } = parsed;
  const planned = amount(plannedInput) && plannedInput !== "0" && amount(plannedMinimum) ? { plannedInput, plannedMinimum } : {};
  const floors = decodeFloors(parsed.floors);
  return {
    v: 1,
    slippageBps,
    ...(typeof parsed.quote === "string" && parsed.quote.length <= 200 ? { quote: parsed.quote } : {}),
    ...(typeof portion === "number" ? { portionBps: portion } : {}),
    ...(typeof parsed.provider === "string" && parsed.provider.length <= 32 ? { provider: parsed.provider } : {}),
    ...planned,
    ...(floors.length > 0 ? { floors } : {}),
  };
}
