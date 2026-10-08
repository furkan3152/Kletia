/**
 * `IntentStep.quoteRef` encoding. The planner records what it needs to
 * re-prepare a step later (provider quote id, applied slippage, the share of
 * the previous step's output the step consumes, liquid-staking provider).
 */
import { base64UrlDecode, base64UrlEncode, canonicalJson, isRecord } from "./util.js";

export interface StepRef {
  readonly v: 1;
  readonly slippageBps: number;
  readonly quote?: string;
  /** Share (bps) of the funding step's output consumed by this step. */
  readonly portionBps?: number;
  readonly provider?: string;
}

const PREFIX = "kq1.";

export function encodeStepRef(ref: StepRef): string {
  return `${PREFIX}${base64UrlEncode(canonicalJson(ref))}`;
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
  return {
    v: 1,
    slippageBps,
    ...(typeof parsed.quote === "string" && parsed.quote.length <= 200 ? { quote: parsed.quote } : {}),
    ...(typeof portion === "number" ? { portionBps: portion } : {}),
    ...(typeof parsed.provider === "string" && parsed.provider.length <= 32 ? { provider: parsed.provider } : {}),
  };
}
