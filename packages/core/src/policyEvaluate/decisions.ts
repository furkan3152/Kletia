/**
 * Policy decision records and their hash chain.
 */
import { canonicalJson } from "../contracts.js";
import { sha256Hex } from "../hash.js";
import type { PolicyChainLink } from "../intent.js";
import type { PolicyViolation } from "./rules.js";

/* ============================================================ decision log */

export type PolicyDecisionStage = "plan" | "prepare" | "submit" | "evaluate" | "approval" | "amendment" | "key";
export type PolicyDecisionOutcome = "allow" | "confirm" | "deny" | "approved" | "rejected" | "observed";

export interface PolicyDecision {
  /** pdc_… */
  readonly id: string;
  /** Per project, gapless under the project lock. */
  readonly seq: number;
  /** chainHash of seq − 1 (POLICY_DECISION_GENESIS for the first). */
  readonly prevHash: string;
  /** "0x" + sha256(prevHash ‖ "\n" ‖ canonicalJson(record without seq, prevHash, chainHash)). */
  readonly chainHash: string;
  readonly at: string;
  readonly stage: PolicyDecisionStage;
  readonly outcome: PolicyDecisionOutcome;
  readonly projectId: string;
  readonly keyId: string | null;
  readonly actorKeyId: string | null;
  readonly intentId?: string;
  readonly stepId?: string;
  readonly dryRun: boolean;
  readonly chain: readonly PolicyChainLink[];
  readonly notionalUsd?: string;
  readonly usage?: readonly { readonly scope: string; readonly window: "24h" | "7d"; readonly usedUsd: string; readonly capUsd: string }[];
  readonly violations: readonly PolicyViolation[];
  readonly triggers: readonly PolicyViolation[];
  readonly warnings: readonly string[];
  /** sha256 of the canonical request (the request itself is not stored). */
  readonly requestDigest: string;
  readonly title?: string;
  readonly exposureId?: string;
  readonly approvalId?: string;
}

export const POLICY_DECISION_GENESIS = `0x${"0".repeat(64)}`;

/** The chain hash of one decision record given the previous hash. */
export function policyDecisionChainHash(prevHash: string, record: Omit<PolicyDecision, "seq" | "prevHash" | "chainHash"> | PolicyDecision): string {
  const { seq: _seq, prevHash: _prev, chainHash: _chain, ...rest } = record as PolicyDecision;
  return `0x${sha256Hex(`${prevHash}\n${canonicalJson(rest)}`)}`;
}

export interface DecisionChainVerification {
  readonly valid: boolean;
  /** Newest verified record. */
  readonly head: { readonly seq: number; readonly chainHash: string } | null;
  readonly problems: readonly string[];
}

/**
 * Recomputes the hash chain of a page of decisions (any order). A stored
 * `knownHead` must reappear unchanged when its seq is inside the page, and
 * must not be newer than the page's head.
 */
export function verifyDecisionChain(decisions: readonly PolicyDecision[], knownHead?: { readonly seq: number; readonly chainHash: string }): DecisionChainVerification {
  const problems: string[] = [];
  const sorted = [...decisions].sort((a, b) => a.seq - b.seq);
  for (let index = 0; index < sorted.length; index += 1) {
    const decision = sorted[index] as PolicyDecision;
    const previous = sorted[index - 1];
    if (previous) {
      if (decision.seq !== previous.seq + 1) problems.push(`gap between seq ${previous.seq} and ${decision.seq}`);
      else if (decision.prevHash !== previous.chainHash) problems.push(`seq ${decision.seq} does not link to seq ${previous.seq}`);
    } else if (decision.seq === 1 && decision.prevHash !== POLICY_DECISION_GENESIS) {
      problems.push("seq 1 must link to the genesis hash");
    }
    if (policyDecisionChainHash(decision.prevHash, decision) !== decision.chainHash) problems.push(`seq ${decision.seq} chainHash does not match its record`);
  }
  const last = sorted[sorted.length - 1];
  if (knownHead) {
    const match = sorted.find((decision) => decision.seq === knownHead.seq);
    if (match && match.chainHash !== knownHead.chainHash) problems.push(`seq ${knownHead.seq} differs from the stored head: history was rewritten`);
    if (last && knownHead.seq > last.seq) problems.push(`the stored head (seq ${knownHead.seq}) is newer than this page`);
  }
  return { valid: problems.length === 0, head: last ? { seq: last.seq, chainHash: last.chainHash } : null, problems };
}

/** Deterministic exposure id: "px_" + sha256(intentId|stepId|quoteBinding)[0:24] (retries are idempotent). */
export function policyExposureId(intentId: string, stepId: string, quoteBinding: string): string {
  return `px_${sha256Hex(`${intentId}|${stepId}|${quoteBinding}`).slice(0, 24)}`;
}
